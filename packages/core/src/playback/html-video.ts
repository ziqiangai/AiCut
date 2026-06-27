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
 * Multi-track / PiP: when `setPictureInPictureEnabled(true)` flips
 * on, every video track's currently-active clip stays visible, with
 * track `0` on top (highest z-index). Audio policy: only the top
 * track stays unmuted so stacked playbacks don't double-pitch. When
 * the flag is off (default) behaviour matches the historical single-
 * clip preview — only track `0`'s active clip paints.
 *
 * Strengths: zero deps, browser-native decode (GPU when available),
 * works in every browser today.
 *
 * Limits: a clip dropped on two tracks that share the same
 * `MediaSource.id` will only one currentTime at a time (one decoder
 * per source) — the second one wins. Workaround: upload the file
 * twice for separate ids. Seek snaps to keyframes (browser controls
 * the decode pipeline), no transitions / shaders / filters. See
 * `WebCodecsEngine` for the frame-accurate path.
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
  /** trackId → currently-active clipId on that track. PiP off keeps
   *  only the first entry; PiP on holds one per video track. */
  private activeByTrack = new Map<string, string>();
  private playing = false;
  private timeMs: Ms = 0;
  private rafHandle: number | null = null;
  private lastFrameTs = 0;
  /** Permanent rAF that positions the active wrappers at the output
   *  rect + pushes keyframe transforms onto the inner videos via CSS. */
  private transformRaf: number | null = null;
  private pictureInPictureEnabled = false;

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
    this.refreshActive();
  }

  setPictureInPictureEnabled(enabled: boolean): void {
    if (this.pictureInPictureEnabled === enabled) return;
    this.pictureInPictureEnabled = enabled;
    // Re-resolve active clips with the new policy. Wrappers that
    // were visible for non-primary tracks get hidden; new tracks may
    // come online.
    this.refreshActive();
  }

  play(): void {
    if (this.playing) return;
    if (this.totalDuration() <= 0) return;
    // If no clip currently overlaps the playhead, snap forward to the
    // next clip's start so the user gets immediate playback.
    if (this.activeByTrack.size === 0) {
      const next = this.nextClipAfterTime(this.timeMs);
      if (!next) return;
      this.timeMs = next.start;
      this.refreshActive();
    }
    this.playAllActive();
    this.playing = true;
    this.startTickLoop();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stopTickLoop();
    this.pauseAllActive();
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
    this.refreshActive();
    this.onTimeUpdate?.(clamped);
  }

  /**
   * The OUTPUT frame — the fixed stage the rendered video is clipped
   * to. Independent of the keyframe transform. Used by the overlay to
   * draw the dashed border at a stable position.
   */
  getOutputFrameRect(
    _clipId?: string,
  ): { x: number; y: number; w: number; h: number } | null {
    // Output canvas is shared across all clips on the same paint —
    // `_clipId` is for API symmetry with `getFrameRect`.
    return this.baseFrameRect();
  }

  /**
   * The CONTENT frame — where the transformed video pixels actually
   * land. Equal to the output frame when transform is identity; may
   * extend outside (zoom in) or fit inside (zoom out) when not.
   *
   * `clipId` (PiP): the overlay passes the selected clip so the
   * dashed border + corner handles latch onto a picture-in-picture
   * overlay instead of always tracking the primary. When omitted,
   * defaults to the primary (= bottom track) clip.
   */
  getFrameRect(
    clipId?: string,
  ): { x: number; y: number; w: number; h: number } | null {
    const base = this.baseFrameRect();
    if (!base) return null;
    let clip: Clip | null = null;
    if (clipId) {
      // Only honor the request when the clip is currently active
      // (selecting a non-active clip falls back to the primary so
      // the overlay doesn't ghost over an empty wrapper).
      for (const cId of this.activeByTrack.values()) {
        if (cId === clipId) {
          clip = this.clipById(cId);
          break;
        }
      }
    }
    if (!clip) clip = this.primaryActiveClip();
    if (!clip) return base;
    const t = getEffectiveTransform(clip, this.timeMs - clip.start);
    // panX/panY are CANVAS pixels — convert to CSS px via the same
    // canvas-to-CSS ratio that sized `base.w`/`base.h`.
    const ref = this.canvasReferenceDims();
    const cssPerCanvasX = ref ? base.w / ref[0] : 1;
    const cssPerCanvasY = ref ? base.h / ref[1] : 1;
    const cx = base.x + base.w / 2 + t.panX * cssPerCanvasX;
    const cy = base.y + base.h / 2 + t.panY * cssPerCanvasY;
    const w = base.w * t.scale;
    const h = base.h * t.scale;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /**
   * Untransformed output-canvas rect.
   *
   * Source of truth: `Project.aspect` when the user picked a ratio
   * via the built-in picker. When it's null we fall back to a
   * STABLE reference — the first clip in the first video track,
   * regardless of playhead — so the canvas stays anchored as
   * playback crosses clip boundaries. Picks up the active primary
   * clip's dims as a last resort when the reference video hasn't
   * loaded metadata yet.
   *
   * Mirrors CapCut: "Original" means "lock to the first clip's
   * aspect", not "follow whatever's playing right now". Without
   * this, the canvas would visibly jump every time the playhead
   * crossed from track-0's clip 1 to clip 2.
   */
  private baseFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null {
    const hostRect = this.host.getBoundingClientRect();
    const cw = hostRect.width;
    const ch = hostRect.height;
    if (cw === 0 || ch === 0) return null;

    let aw: number | null = null;
    let ah: number | null = null;
    const aspect = parseAspect(this.project.aspect);
    if (aspect) {
      [aw, ah] = aspect;
    } else {
      const ref = this.canvasReferenceDims();
      if (ref) [aw, ah] = ref;
    }
    if (aw == null || ah == null) {
      // Last resort — use whatever clip is currently primary so we
      // still produce a rect during the brief window before any
      // metadata has resolved.
      const clip = this.primaryActiveClip();
      if (!clip) return null;
      const v = this.sources.get(clip.sourceId)?.video;
      if (!v || v.videoWidth === 0 || v.videoHeight === 0) return null;
      aw = v.videoWidth;
      ah = v.videoHeight;
    }
    const scale = Math.min(cw / aw, ch / ah);
    const w = aw * scale;
    const h = ah * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  /**
   * Dims of the canvas-anchor clip — the first clip (by start time)
   * on the first video track. Stable across playback so the canvas
   * doesn't resize at clip boundaries. Returns null when nothing's
   * decoded yet.
   */
  getCanvasReferenceDims(): [number, number] | null {
    const out = this.project.output;
    if (out && out.width > 0 && out.height > 0) return [out.width, out.height];
    for (const track of this.project.tracks) {
      if (track.kind !== "video") continue;
      let earliest: { c: { sourceId: string; start: number } } | null = null;
      for (const c of track.clips) {
        if (!earliest || c.start < earliest.c.start) earliest = { c };
      }
      if (!earliest) continue;
      const v = this.sources.get(earliest.c.sourceId)?.video;
      if (!v || v.videoWidth === 0 || v.videoHeight === 0) continue;
      return [v.videoWidth, v.videoHeight];
    }
    return null;
  }
  private canvasReferenceDims(): [number, number] | null {
    return this.getCanvasReferenceDims();
  }

  /**
   * Permanent rAF that (a) sizes + positions every active wrapper to
   * the output frame, and (b) writes the keyframe transform onto each
   * inner video. Negligible cost — a handful of style writes per
   * frame even with PiP on.
   */
  private startTransformLoop(): void {
    const tick = (): void => {
      this.applyTransforms();
      this.transformRaf = requestAnimationFrame(tick);
    };
    this.transformRaf = requestAnimationFrame(tick);
  }

  private applyTransforms(): void {
    const outRect = this.baseFrameRect();
    if (!outRect) {
      // No primary clip → no positioning to do; visibility was already
      // toggled in `refreshActive`.
      return;
    }
    // Build a sourceId → (trackIndex, clip) map for the active set so
    // we know which wrapper to z-order and animate.
    const activeBySource = new Map<
      string,
      { trackIndex: number; clip: Clip }
    >();
    let i = 0;
    for (const track of this.project.tracks) {
      if (track.kind !== "video") {
        i++;
        continue;
      }
      const clipId = this.activeByTrack.get(track.id);
      if (clipId) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) activeBySource.set(clip.sourceId, { trackIndex: i, clip });
      }
      i++;
    }

    for (const [sourceId, src] of this.sources) {
      const entry = activeBySource.get(sourceId);
      if (entry) {
        const { trackIndex, clip } = entry;
        // Wrapper covers the full output canvas; overflow: hidden
        // clips any transform-overflow at the output bounds.
        // Z-order convention: higher track index = higher z. That's
        // the Premiere / After Effects model and what users expect
        // when they upload PiP overlays onto track 1 / 2 / etc.
        Object.assign(src.wrapper.style, {
          left: `${outRect.x}px`,
          top: `${outRect.y}px`,
          width: `${outRect.w}px`,
          height: `${outRect.h}px`,
          zIndex: String(trackIndex + 1),
        });
        const t = getEffectiveTransform(clip, this.timeMs - clip.start);
        // panX/panY are CANVAS pixels — convert to CSS px via the
        // wrapper's `outRect.w/h` vs the canvas reference dims so a
        // 1 px pan in canvas-units shows the same relative motion as
        // the canvas-compositor + the backend export.
        const ref = this.canvasReferenceDims();
        const cssPerCanvasX = ref ? outRect.w / ref[0] : 1;
        const cssPerCanvasY = ref ? outRect.h / ref[1] : 1;
        const cssPanX = t.panX * cssPerCanvasX;
        const cssPanY = t.panY * cssPerCanvasY;
        src.video.style.transform = `translate(${cssPanX.toFixed(2)}px, ${cssPanY.toFixed(2)}px) scale(${t.scale.toFixed(4)})`;
      } else if (src.video.style.transform) {
        // Inactive — reset transform so stale state doesn't ghost when
        // we swap back.
        src.video.style.transform = "";
      }
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
        // contain (not fill) so the video letterboxes inside the
        // output canvas when the canvas aspect (driven by
        // `Project.aspect`) differs from the video's intrinsic aspect.
        // When they match (Original / matching ratio), contain
        // produces the same pixel-perfect result as fill.
        objectFit: "contain",
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

  /**
   * Resolve the active clip per track for the current playhead and
   * reconcile wrapper visibility, audio policy, and per-source
   * playback state. Called on `seek` / `setProject` / `setPiP` and
   * whenever a tick advances past a clip boundary.
   */
  private refreshActive(): void {
    const next = this.computeActiveClips();
    const prev = this.activeByTrack;
    this.activeByTrack = next;

    // Figure out which sources need to be visible after the swap and
    // which need to be hidden / paused.
    const visibleSources = new Set<string>();
    for (const clipId of next.values()) {
      const clip = this.clipById(clipId);
      if (clip) visibleSources.add(clip.sourceId);
    }

    // Hide + pause sources that lost activation.
    for (const [sourceId, src] of this.sources) {
      if (visibleSources.has(sourceId)) continue;
      if (src.wrapper.style.visibility !== "hidden") {
        src.wrapper.style.visibility = "hidden";
      }
      if (!src.video.paused) src.video.pause();
    }

    // For each newly-active clip, seek the underlying video and play
    // (if the engine is in playing state). Iterate in track order so
    // the primary (track 0) clip is the LAST one seeked — same-source
    // tie-break: primary wins the currentTime.
    const orderedEntries: Array<[string, string]> = [];
    for (let i = this.project.tracks.length - 1; i >= 0; i--) {
      const tid = this.project.tracks[i]!.id;
      const cid = next.get(tid);
      if (cid) orderedEntries.push([tid, cid]);
    }
    // Track 0 last so its seek/play wins for same-source ties.
    for (const [, clipId] of orderedEntries) {
      const clip = this.clipById(clipId);
      if (!clip) continue;
      const src = this.sources.get(clip.sourceId);
      if (!src) continue;
      src.wrapper.style.visibility = "visible";
      this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
      if (this.playing) {
        void src.video.play().catch((err) => this.onError?.(err as Error));
      }
    }

    // Audio policy: only the FIRST (top, track 0) active video stays
    // unmuted; lower-track sources mute to avoid stacking playback.
    // When PiP is off there's only one active source anyway, so this
    // is a no-op there.
    const primaryClip = this.primaryActiveClip();
    const primarySourceId = primaryClip?.sourceId ?? null;
    for (const [sourceId, src] of this.sources) {
      src.video.muted = sourceId !== primarySourceId;
    }

    // Surface a "selection-equivalent" ready event (Editor wires this
    // into UI updates) so anything keying off `activeClipChanged`
    // gets a chance to re-render. The old code only fired this when
    // the SINGLE current clip swapped; we fire it whenever the primary
    // changes.
    void prev; // reserved if we ever need a diff
  }

  private computeActiveClips(): Map<string, string> {
    const result = new Map<string, string>();
    for (const track of this.project.tracks) {
      if (track.kind !== "video") continue;
      for (const c of track.clips) {
        if (
          this.timeMs >= c.start &&
          this.timeMs < c.start + (c.out - c.in)
        ) {
          result.set(track.id, c.id);
          break;
        }
      }
      // PiP off: stop AFTER we've found one active clip — but keep
      // walking if the first track was empty so the user still sees
      // a lower-track clip even with PiP disabled.
      if (!this.pictureInPictureEnabled && result.size > 0) break;
    }
    return result;
  }

  /** First track-in-order with an active clip — the "primary" =
   *  canvas reference + audio source. Track `0` wins when it has
   *  content; otherwise the next video track with a clip. */
  private primaryActiveClip(): Clip | null {
    for (const track of this.project.tracks) {
      if (track.kind !== "video") continue;
      const cid = this.activeByTrack.get(track.id);
      if (cid) return this.clipById(cid);
    }
    return null;
  }

  private playAllActive(): void {
    for (const clipId of this.activeByTrack.values()) {
      const clip = this.clipById(clipId);
      if (!clip) continue;
      const src = this.sources.get(clip.sourceId);
      if (!src) continue;
      void src.video.play().catch((err) => this.onError?.(err as Error));
    }
  }

  private pauseAllActive(): void {
    for (const clipId of this.activeByTrack.values()) {
      const clip = this.clipById(clipId);
      if (!clip) continue;
      const src = this.sources.get(clip.sourceId);
      if (src && !src.video.paused) src.video.pause();
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
    // Detect whether the active clip set changed across this tick —
    // if so, re-resolve + seek/play any new entrants. We compare by
    // length AND by entries since a track could swap clips mid-tick.
    const next = this.computeActiveClips();
    let changed = next.size !== this.activeByTrack.size;
    if (!changed) {
      for (const [tid, cid] of next) {
        if (this.activeByTrack.get(tid) !== cid) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.refreshActive();
    }
    // If there's no primary clip after re-resolution, the project has
    // run out of footage — bail.
    if (this.activeByTrack.size === 0) {
      const nextStart = this.nextClipAfterTime(this.timeMs);
      if (nextStart) {
        this.timeMs = nextStart.start;
        this.refreshActive();
      } else {
        this.pause();
        this.onEnded?.();
        return;
      }
    }
    this.onTimeUpdate?.(this.timeMs);
  }
}

/** Factory shorthand for `Editor.create({ playbackEngine })`. */
export const htmlVideoEngineFactory: PlaybackEngineFactory = (opts) =>
  new HtmlVideoEngine(opts);

/**
 * Parse a `Project.aspect` string like "16:9" into a `[w, h]` tuple.
 * Returns null for missing / malformed input so callers can fall
 * back to the source video's intrinsic aspect (today's behaviour).
 */
function parseAspect(value: string | undefined | null): [number, number] | null {
  if (!value) return null;
  const m = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return [w, h];
}
