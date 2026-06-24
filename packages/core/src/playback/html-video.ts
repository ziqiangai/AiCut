import { getEffectiveTransform } from "../keyframes/index.js";
import type { Clip, Ms, Project } from "../types.js";
import type {
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
} from "./types.js";

/**
 * Default preview engine — one wrapper + `<video>` pair per
 * `MediaSource`. The wrapper is sized to the OUTPUT frame (the base
 * contain-letterbox rect) with `overflow: hidden` so any keyframe
 * transform applied to the inner video gets clipped to the output
 * bounds. That's what makes pan / zoom / picture-in-picture work:
 * translating the video reveals the wrapper's letterbox color, not
 * the rest of the editor chrome.
 *
 * Strengths: zero deps, browser-native decode (GPU when available),
 * works in every browser today.
 *
 * Limits: no multi-track compositing (one video visible at a time),
 * seek snaps to keyframes (browser controls the decode pipeline), no
 * transitions / shaders / filters. See `WebCodecsEngine` for the
 * frame-accurate path.
 */
interface SourceState {
  /** Clipping container — positioned + sized to the OUTPUT frame each
   *  frame so any video transform clips against the output bounds. */
  wrapper: HTMLDivElement;
  video: HTMLVideoElement;
}

export class HtmlVideoEngine implements PlaybackEngine {
  private host: HTMLElement;
  private mount: HTMLDivElement;
  private sources = new Map<string, SourceState>();
  private project: Project;
  private currentClipId: string | null = null;
  private playing = false;
  private timeMs: Ms = 0;
  private rafHandle: number | null = null;
  private lastFrameTs = 0;
  /** Permanent rAF that positions the active wrapper at the output
   *  rect + pushes keyframe transform onto the inner video via CSS. */
  private transformRaf: number | null = null;

  /** Public event hooks — set by Editor. */
  onTimeUpdate?: (ms: Ms) => void;
  onEnded?: () => void;
  onError?: (err: Error) => void;
  onReady?: () => void;
  onSourceMetadata?: (sourceId: string, durationMs: Ms) => void;

  constructor(opts: PlaybackEngineOptions) {
    this.host = opts.host;
    this.project = opts.project;
    this.mount = document.createElement("div");
    this.mount.className = "aicut-preview";
    Object.assign(this.mount.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    } satisfies Partial<CSSStyleDeclaration>);
    this.host.appendChild(this.mount);
    this.syncSources();
    this.startTransformLoop();
  }

  setProject(next: Project): void {
    this.project = next;
    this.syncSources();
    const clip = this.clipAtTime(this.timeMs);
    if (!clip) {
      this.timeMs = 0;
      this.activate(null);
      this.onTimeUpdate?.(0);
    } else {
      this.activate(clip);
      this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
    }
  }

  play(): void {
    if (this.playing) return;
    if (this.totalDuration() <= 0) return;
    let clip = this.clipAtTime(this.timeMs) ?? this.nextClipAfterTime(this.timeMs);
    if (!clip) return;
    if (this.timeMs < clip.start) this.timeMs = clip.start;
    this.activate(clip);
    this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
    const s = this.sources.get(clip.sourceId);
    if (!s) return;
    void s.video.play().catch((err) => this.onError?.(err as Error));
    this.playing = true;
    this.startTickLoop();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stopTickLoop();
    if (this.currentClipId) {
      const clip = this.clipById(this.currentClipId);
      if (clip) {
        this.sources.get(clip.sourceId)?.video.pause();
      }
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getTime(): Ms {
    return this.timeMs;
  }

  seek(timeMs: Ms): void {
    const total = this.totalDuration();
    if (total <= 0) {
      this.timeMs = 0;
      return;
    }
    const clamped = Math.max(0, Math.min(timeMs, total));
    this.timeMs = clamped;
    const clip = this.clipAtTime(clamped);
    if (clip) {
      this.activate(clip);
      this.seekVideoToClipOffset(clip, clamped - clip.start);
    } else {
      this.activate(null);
    }
    this.onTimeUpdate?.(clamped);
  }

  /**
   * The OUTPUT frame — the fixed stage the rendered video is clipped
   * to. Independent of the keyframe transform. Used by the overlay to
   * draw the dashed border at a stable position.
   */
  getOutputFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null {
    return this.baseFrameRect();
  }

  /**
   * The CONTENT frame — where the transformed video pixels actually
   * land. Equal to the output frame when transform is identity; may
   * extend outside (zoom in) or fit inside (zoom out) when not.
   */
  getFrameRect(): { x: number; y: number; w: number; h: number } | null {
    const base = this.baseFrameRect();
    if (!base) return null;
    const clip = this.clipById(this.currentClipId!);
    if (!clip) return base;
    const t = getEffectiveTransform(clip, this.timeMs - clip.start);
    const cx = base.x + base.w / 2 + t.x;
    const cy = base.y + base.h / 2 + t.y;
    const w = base.w * t.scale;
    const h = base.h * t.scale;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** Untransformed contain-letterbox rect — the OUTPUT frame. */
  private baseFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null {
    if (!this.currentClipId) return null;
    const clip = this.clipById(this.currentClipId);
    if (!clip) return null;
    const s = this.sources.get(clip.sourceId);
    if (!s) return null;
    const v = s.video;
    if (v.videoWidth === 0 || v.videoHeight === 0) return null;
    const hostRect = this.host.getBoundingClientRect();
    const cw = hostRect.width;
    const ch = hostRect.height;
    if (cw === 0 || ch === 0) return null;
    const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  /**
   * Permanent rAF that (a) sizes + positions the active wrapper to
   * the output frame, and (b) writes the keyframe transform onto the
   * inner video. Negligible cost — three style writes per frame max.
   */
  private startTransformLoop(): void {
    const tick = (): void => {
      this.applyTransforms();
      this.transformRaf = requestAnimationFrame(tick);
    };
    this.transformRaf = requestAnimationFrame(tick);
  }

  private applyTransforms(): void {
    const clip = this.currentClipId
      ? this.clipById(this.currentClipId)
      : null;
    const outRect = this.baseFrameRect();
    if (clip && outRect) {
      const s = this.sources.get(clip.sourceId);
      if (s) {
        // Wrapper = output frame; overflow: hidden clips any
        // transform-overflow at the output bounds.
        Object.assign(s.wrapper.style, {
          left: `${outRect.x}px`,
          top: `${outRect.y}px`,
          width: `${outRect.w}px`,
          height: `${outRect.h}px`,
        });
        const t = getEffectiveTransform(clip, this.timeMs - clip.start);
        // Identity = video fills wrapper exactly. Translate + scale
        // move it within the wrapper; overflow clips.
        s.video.style.transform = `translate(${t.x.toFixed(2)}px, ${t.y.toFixed(2)}px) scale(${t.scale.toFixed(4)})`;
      }
    }
    // Inactive sources: reset transforms so stale state doesn't ghost
    // when we swap back to them.
    for (const [id, s] of this.sources) {
      if (clip && id === clip.sourceId) continue;
      if (s.video.style.transform) s.video.style.transform = "";
    }
  }

  destroy(): void {
    this.stopTickLoop();
    if (this.transformRaf != null) {
      cancelAnimationFrame(this.transformRaf);
      this.transformRaf = null;
    }
    for (const s of this.sources.values()) {
      s.video.pause();
      s.video.removeAttribute("src");
      s.video.load();
      s.wrapper.remove();
    }
    this.sources.clear();
    this.mount.remove();
  }

  // --- internals -------------------------------------------------------

  private syncSources(): void {
    const wanted = new Set(this.project.sources.map((s) => s.id));
    for (const [id, s] of this.sources) {
      if (!wanted.has(id)) {
        s.video.pause();
        s.wrapper.remove();
        this.sources.delete(id);
      }
    }
    for (const src of this.project.sources) {
      if (src.kind !== "video") continue;
      if (this.sources.has(src.id)) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "aicut-preview-clip";
      Object.assign(wrapper.style, {
        position: "absolute",
        overflow: "hidden",
        visibility: "hidden",
        // Initial bounds — applyTransforms overrides each frame.
        left: "0",
        top: "0",
        width: "0",
        height: "0",
      } satisfies Partial<CSSStyleDeclaration>);

      const v = document.createElement("video");
      v.preload = "auto";
      // No `crossOrigin` — would force CORS preflight that most CDNs
      // don't serve. Pure <video> playback works cross-origin without.
      v.playsInline = true;
      v.muted = false;
      v.src = src.url;
      Object.assign(v.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        objectFit: "fill",
        // Transform origin at center so scale() scales around the
        // video's centroid, not its top-left corner.
        transformOrigin: "50% 50%",
      } satisfies Partial<CSSStyleDeclaration>);
      const sourceId = src.id;
      v.addEventListener("error", () =>
        this.onError?.(new Error(`Failed to load ${src.url}`)),
      );
      v.addEventListener("loadedmetadata", () => {
        this.onReady?.();
        const durMs = Math.round(v.duration * 1000);
        if (Number.isFinite(durMs) && durMs > 0) {
          this.onSourceMetadata?.(sourceId, durMs);
        }
      });
      wrapper.appendChild(v);
      this.mount.appendChild(wrapper);
      this.sources.set(src.id, { wrapper, video: v });
    }
  }

  private activate(clip: Clip | null): void {
    if (clip?.id === this.currentClipId) return;
    if (this.currentClipId) {
      const prev = this.clipById(this.currentClipId);
      if (prev) {
        const s = this.sources.get(prev.sourceId);
        if (s) {
          s.video.pause();
          s.wrapper.style.visibility = "hidden";
        }
      }
    }
    this.currentClipId = clip ? clip.id : null;
    if (clip) {
      const s = this.sources.get(clip.sourceId);
      if (s) s.wrapper.style.visibility = "visible";
    }
  }

  private seekVideoToClipOffset(clip: Clip, offsetMs: Ms): void {
    const s = this.sources.get(clip.sourceId);
    if (!s) return;
    const target = (clip.in + Math.max(0, offsetMs)) / 1000;
    if (Math.abs(s.video.currentTime - target) > 0.05) {
      s.video.currentTime = target;
    }
  }

  private clipById(id: string): Clip | null {
    for (const t of this.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c;
    }
    return null;
  }

  /**
   * Find the clip whose timeline range contains `timeMs`, searching
   * across ALL video tracks. If multiple tracks have a clip at this
   * moment, the lowest-index track wins.
   */
  private clipAtTime(timeMs: Ms): Clip | null {
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (timeMs >= c.start && timeMs < c.start + (c.out - c.in)) return c;
      }
    }
    return null;
  }

  /** Earliest clip starting at-or-after `timeMs` across all video tracks. */
  private nextClipAfterTime(timeMs: Ms): Clip | null {
    let best: Clip | null = null;
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (c.start >= timeMs && (!best || c.start < best.start)) best = c;
      }
    }
    return best;
  }

  /** Max clip end across all video tracks. */
  private totalDuration(): Ms {
    let max = 0;
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        const e = c.start + (c.out - c.in);
        if (e > max) max = e;
      }
    }
    return max;
  }

  private startTickLoop(): void {
    this.lastFrameTs = performance.now();
    const tick = (now: number) => {
      if (!this.playing) return;
      const dtMs = now - this.lastFrameTs;
      this.lastFrameTs = now;
      this.advance(dtMs);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopTickLoop(): void {
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private advance(dtMs: number): void {
    if (this.project.tracks.length === 0) return;
    this.timeMs += dtMs;
    const totalDur = this.totalDuration();
    if (this.timeMs >= totalDur) {
      this.timeMs = totalDur;
      this.onTimeUpdate?.(this.timeMs);
      this.pause();
      this.onEnded?.();
      return;
    }
    const clip = this.clipAtTime(this.timeMs);
    if (!clip) {
      const next = this.nextClipAfterTime(this.timeMs);
      if (next) {
        this.timeMs = next.start;
        this.activate(next);
        this.seekVideoToClipOffset(next, 0);
        const s = this.sources.get(next.sourceId);
        if (s) void s.video.play().catch((err) => this.onError?.(err as Error));
      } else {
        this.pause();
        this.onEnded?.();
        return;
      }
    } else if (clip.id !== this.currentClipId) {
      this.activate(clip);
      this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
      const s = this.sources.get(clip.sourceId);
      if (s) void s.video.play().catch((err) => this.onError?.(err as Error));
    }
    this.onTimeUpdate?.(this.timeMs);
  }
}

/** Factory shorthand for `Editor.create({ playbackEngine })`. */
export const htmlVideoEngineFactory: PlaybackEngineFactory = (opts) =>
  new HtmlVideoEngine(opts);
