import type { Clip, Ms, Project } from "../types.js";
import type {
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
} from "./types.js";

/**
 * Reference second engine — demonstrates that the `PlaybackEngine`
 * surface really is engine-agnostic. Same `<video>`-based decode as
 * `HtmlVideoEngine` (so it works in every browser, no WebCodecs gate),
 * but rendering happens via `ctx.drawImage(video, …)` on a single
 * canvas instead of the browser painting the video element itself.
 *
 * Why ship it: it's tangible proof that a host can swap the rendering
 * surface for compositing / shaders / overlays / capture-to-canvas
 * without touching Editor internals. It's also the natural stepping
 * stone toward a WebGL or WebCodecs path (those replace the decoder
 * but keep the canvas-blit pattern).
 *
 * Limits: same as `HtmlVideoEngine` (one source visible at a time,
 * seek snaps to the browser's keyframe pipeline). The point is the
 * surface, not new capability.
 */
export class CanvasCompositorEngine implements PlaybackEngine {
  private host: HTMLElement;
  private mount: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private badge: HTMLDivElement;
  private videos = new Map<string, HTMLVideoElement>();
  private project: Project;
  private currentClipId: string | null = null;
  private playing = false;
  private timeMs: Ms = 0;
  private rafHandle: number | null = null;
  private lastFrameTs = 0;
  private paintedFrames = 0;

  onTimeUpdate?: (ms: Ms) => void;
  onEnded?: () => void;
  onError?: (err: Error) => void;
  onReady?: () => void;
  onSourceMetadata?: (sourceId: string, durationMs: Ms) => void;

  constructor(opts: PlaybackEngineOptions) {
    this.host = opts.host;
    this.project = opts.project;

    this.mount = document.createElement("div");
    this.mount.className = "aicut-preview aicut-preview--canvas";
    Object.assign(this.mount.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    } satisfies Partial<CSSStyleDeclaration>);

    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      // Stretch with letterboxing handled by the draw loop.
      objectFit: "contain",
      // Black until the first frame is drawn so the swap from the
      // previous engine doesn't flash the host background.
      background: "#000",
    } satisfies Partial<CSSStyleDeclaration>);
    this.mount.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasCompositorEngine: 2d context unavailable");
    this.ctx = ctx;

    this.badge = document.createElement("div");
    this.badge.className = "aicut-preview__badge";
    Object.assign(this.badge.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      padding: "4px 8px",
      borderRadius: "6px",
      background: "rgba(0, 0, 0, 0.55)",
      color: "rgba(255, 255, 255, 0.92)",
      font: "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
      pointerEvents: "none",
      zIndex: "2",
      letterSpacing: "0.02em",
    } satisfies Partial<CSSStyleDeclaration>);
    this.badge.textContent = "engine: canvas compositor";
    this.mount.appendChild(this.badge);

    this.host.appendChild(this.mount);
    this.syncSources();
    this.resizeCanvas();
    this.startTickLoop(); // always painting so HUD reflects state when paused
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
    const clip =
      this.clipAtTime(this.timeMs) ?? this.nextClipAfterTime(this.timeMs);
    if (!clip) return;
    if (this.timeMs < clip.start) this.timeMs = clip.start;
    this.activate(clip);
    this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
    const v = this.videos.get(clip.sourceId);
    if (!v) return;
    void v.play().catch((err) => this.onError?.(err as Error));
    this.playing = true;
    this.lastFrameTs = performance.now();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.currentClipId) {
      const clip = this.clipById(this.currentClipId);
      if (clip) this.videos.get(clip.sourceId)?.pause();
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

  destroy(): void {
    this.stopTickLoop();
    for (const v of this.videos.values()) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.videos.clear();
    this.mount.remove();
  }

  // --- internals -------------------------------------------------------

  private syncSources(): void {
    const wanted = new Set(this.project.sources.map((s) => s.id));
    for (const [id, v] of this.videos) {
      if (!wanted.has(id)) {
        v.pause();
        this.videos.delete(id);
      }
    }
    for (const src of this.project.sources) {
      if (src.kind !== "video") continue;
      if (this.videos.has(src.id)) continue;
      const v = document.createElement("video");
      v.preload = "auto";
      v.playsInline = true;
      v.muted = false;
      v.src = src.url;
      // Detached from the DOM — videos decode fine when not mounted,
      // they just need a current `src` and `play()` called on them.
      // Keeping them off-tree avoids any chance of the raw <video>
      // showing through the canvas (which would defeat the demo).
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
      this.videos.set(src.id, v);
    }
  }

  private activate(clip: Clip | null): void {
    if (clip?.id === this.currentClipId) return;
    if (this.currentClipId) {
      const prev = this.clipById(this.currentClipId);
      if (prev) this.videos.get(prev.sourceId)?.pause();
    }
    this.currentClipId = clip ? clip.id : null;
  }

  private seekVideoToClipOffset(clip: Clip, offsetMs: Ms): void {
    const v = this.videos.get(clip.sourceId);
    if (!v) return;
    const target = (clip.in + Math.max(0, offsetMs)) / 1000;
    if (Math.abs(v.currentTime - target) > 0.05) {
      v.currentTime = target;
    }
  }

  private clipById(id: string): Clip | null {
    for (const t of this.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c;
    }
    return null;
  }

  private clipAtTime(timeMs: Ms): Clip | null {
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (timeMs >= c.start && timeMs < c.start + (c.out - c.in)) return c;
      }
    }
    return null;
  }

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

  private resizeCanvas(): void {
    const rect = this.mount.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private startTickLoop(): void {
    this.lastFrameTs = performance.now();
    const tick = (now: number): void => {
      this.resizeCanvas();
      if (this.playing) {
        const dtMs = now - this.lastFrameTs;
        this.lastFrameTs = now;
        this.advance(dtMs);
      }
      this.paint();
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
        const v = this.videos.get(next.sourceId);
        if (v) void v.play().catch((err) => this.onError?.(err as Error));
      } else {
        this.pause();
        this.onEnded?.();
        return;
      }
    } else if (clip.id !== this.currentClipId) {
      this.activate(clip);
      this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
      const v = this.videos.get(clip.sourceId);
      if (v) void v.play().catch((err) => this.onError?.(err as Error));
    }
    this.onTimeUpdate?.(this.timeMs);
  }

  /**
   * One paint per rAF — clears the canvas, draws the current active
   * video frame letterboxed to fit, then refreshes the HUD. Done
   * unconditionally (not just on `playing`) so the HUD frame counter
   * and the seek preview both update when paused.
   */
  private paint(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.clearRect(0, 0, cw, ch);
    const clip = this.currentClipId ? this.clipById(this.currentClipId) : null;
    const v = clip ? this.videos.get(clip.sourceId) : null;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      this.ctx.drawImage(v, dx, dy, dw, dh);
      this.paintedFrames += 1;
    }
    this.updateBadge();
  }

  private updateBadge(): void {
    const sec = (this.timeMs / 1000).toFixed(2);
    this.badge.textContent =
      `engine: canvas compositor • t=${sec}s • frames painted: ${this.paintedFrames}`;
  }
}

/** Factory shorthand for `Editor.create({ playbackEngine })`. */
export const canvasCompositorEngineFactory: PlaybackEngineFactory = (opts) =>
  new CanvasCompositorEngine(opts);
