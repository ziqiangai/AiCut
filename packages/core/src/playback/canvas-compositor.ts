import { getEffectiveTransform } from "../keyframes/index.js";
import type { Clip, Ms, Project } from "../types.js";
import type {
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
} from "./types.js";

export interface CanvasCompositorEngineOptions extends PlaybackEngineOptions {
  /**
   * Show the corner HUD ("engine: canvas compositor • t=… • frames
   * painted: …"). Off by default — production hosts get a clean canvas
   * with no chrome painted on top. Turn on in development / demos to
   * see who's drawing and what the current state is.
   */
  debug?: boolean;
}

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
 * Multi-track / PiP: `setPictureInPictureEnabled(true)` flips the
 * paint loop into multi-clip composite mode — every video track's
 * currently-active clip draws in reverse track order so track 0 ends
 * up on top. Audio: track 0 stays unmuted, lower tracks mute.
 *
 * Limits: same-source same-time tie still goes to a single decoder
 * (one `<video>` per source). Seek snaps to the browser's keyframe
 * pipeline. No transitions / shaders / filters — the canvas blit
 * pattern is the foundation those would build on, not the feature.
 */
export class CanvasCompositorEngine implements PlaybackEngine {
  private host: HTMLElement;
  private mount: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Only created when constructed with `debug: true`. */
  private badge: HTMLDivElement | null = null;
  private videos = new Map<string, HTMLVideoElement>();
  private project: Project;
  /** trackId → active clipId on that track. Top track's clip is the
   *  "primary" — drives output canvas + audio + overlay rects. */
  private activeByTrack = new Map<string, string>();
  private playing = false;
  private timeMs: Ms = 0;
  private rafHandle: number | null = null;
  private lastFrameTs = 0;
  private paintedFrames = 0;
  private pictureInPictureEnabled = false;
  /** Output canvas rect (no transform) — same for every clip on
   *  the same paint pass. */
  private lastOutputRect: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  /** Post-transform content rect, keyed by clipId. With PiP on a
   *  paint pass records one entry per painted clip; the overlay can
   *  ask for any specific one (the SELECTED clip when PiP is on,
   *  the primary clip otherwise). */
  private frameRectsByClip = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  /** Primary (top-track) clip id from the last paint — used as the
   *  fallback for `getFrameRect()` when no clipId is passed. */
  private primaryClipIdLastPaint: string | null = null;

  onTimeUpdate?: (ms: Ms) => void;
  onEnded?: () => void;
  onError?: (err: Error) => void;
  onReady?: () => void;
  onSourceMetadata?: (sourceId: string, durationMs: Ms) => void;

  constructor(opts: CanvasCompositorEngineOptions) {
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
      // Same var the preview-host + demo slots use, so a light-theme
      // host doesn't end up with a hard black plate around a
      // letterboxed frame while the surrounding chrome is off-white.
      // Falls back to black to preserve today's default when no theme
      // sets the var.
      background: "var(--aicut-preview-bg, #000)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.mount.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasCompositorEngine: 2d context unavailable");
    this.ctx = ctx;

    if (opts.debug) {
      const badge = document.createElement("div");
      badge.className = "aicut-preview__badge";
      Object.assign(badge.style, {
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
      badge.textContent = "engine: canvas compositor";
      this.mount.appendChild(badge);
      this.badge = badge;
    }

    this.host.appendChild(this.mount);
    this.syncSources();
    this.resizeCanvas();
    this.startTickLoop(); // always painting so HUD reflects state when paused
  }

  setProject(next: Project): void {
    this.project = next;
    this.syncSources();
    this.refreshActive();
  }

  setPictureInPictureEnabled(enabled: boolean): void {
    if (this.pictureInPictureEnabled === enabled) return;
    this.pictureInPictureEnabled = enabled;
    this.refreshActive();
  }

  play(): void {
    if (this.playing) return;
    if (this.totalDuration() <= 0) return;
    if (this.activeByTrack.size === 0) {
      const next = this.nextClipAfterTime(this.timeMs);
      if (!next) return;
      this.timeMs = next.start;
      this.refreshActive();
    }
    this.playAllActive();
    this.playing = true;
    this.lastFrameTs = performance.now();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
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

  /**
   * Resolve the active clip per track for the current playhead and
   * reconcile per-source playback / audio policy. PiP off = only the
   * top track contributes; PiP on = every video track.
   */
  private refreshActive(): void {
    const next = this.computeActiveClips();
    this.activeByTrack = next;

    const visibleSources = new Set<string>();
    for (const clipId of next.values()) {
      const clip = this.clipById(clipId);
      if (clip) visibleSources.add(clip.sourceId);
    }

    // Pause sources that lost activation.
    for (const [sourceId, v] of this.videos) {
      if (visibleSources.has(sourceId)) continue;
      if (!v.paused) v.pause();
    }

    // Seek (+ play if running) every newly-active source. Iterate
    // bottom-up so track 0 ends up last — same-source tie wins for
    // the primary clip's currentTime.
    for (let i = this.project.tracks.length - 1; i >= 0; i--) {
      const tid = this.project.tracks[i]!.id;
      const cid = next.get(tid);
      if (!cid) continue;
      const clip = this.clipById(cid);
      if (!clip) continue;
      this.seekVideoToClipOffset(clip, this.timeMs - clip.start);
      if (this.playing) {
        const v = this.videos.get(clip.sourceId);
        if (v) void v.play().catch((err) => this.onError?.(err as Error));
      }
    }

    // Audio policy: only the top track's source unmuted.
    const primaryClip = this.primaryActiveClip();
    const primarySourceId = primaryClip?.sourceId ?? null;
    for (const [sourceId, v] of this.videos) {
      v.muted = sourceId !== primarySourceId;
    }
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
      // a lower-track clip even with PiP disabled. Without this, a
      // gap on track 0 would black the preview while track 1 had
      // content.
      if (!this.pictureInPictureEnabled && result.size > 0) break;
    }
    return result;
  }

  /**
   * The "primary" clip = the bottom-most active clip = the main
   * canvas reference + audio source. It's track `0` when track `0`
   * has content; if that track is empty at the playhead, fall
   * through to the next video track with a clip. (Without that
   * fall-through, dragging the only track-0 clip out of the
   * playhead range blanked the preview even though a lower-track
   * clip was still active.)
   */
  /**
   * Dims of the canvas-anchor clip — the first clip (by start time)
   * on the first video track. Stable across playback so the canvas
   * doesn't resize at clip boundaries. Returns null when nothing's
   * decoded yet.
   */
  getCanvasReferenceDims(): [number, number] | null {
    // `Project.output` is the authoritative reference frame when set.
    // Falls through to the anchor-clip dims so legacy projects with
    // neither aspect nor output still resolve to a stable canvas.
    const out = this.project.output;
    if (out && out.width > 0 && out.height > 0) return [out.width, out.height];
    for (const track of this.project.tracks) {
      if (track.kind !== "video") continue;
      let earliest: { c: { sourceId: string; start: number } } | null = null;
      for (const c of track.clips) {
        if (!earliest || c.start < earliest.c.start) earliest = { c };
      }
      if (!earliest) continue;
      const v = this.videos.get(earliest.c.sourceId);
      if (!v || v.videoWidth === 0 || v.videoHeight === 0) continue;
      return [v.videoWidth, v.videoHeight];
    }
    return null;
  }
  private canvasReferenceDims(): [number, number] | null {
    return this.getCanvasReferenceDims();
  }

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
      const v = this.videos.get(clip.sourceId);
      if (v) void v.play().catch((err) => this.onError?.(err as Error));
    }
  }

  private pauseAllActive(): void {
    for (const clipId of this.activeByTrack.values()) {
      const clip = this.clipById(clipId);
      if (!clip) continue;
      const v = this.videos.get(clip.sourceId);
      if (v && !v.paused) v.pause();
    }
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
    // Detect clip-set changes across this tick.
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
    if (changed) this.refreshActive();
    // Out of footage on every track? Skip ahead to the next clip
    // start or end playback.
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

  /**
   * One paint per rAF — clears the canvas, composites every active
   * track's clip in reverse track order (so track 0 ends up on top),
   * then refreshes the HUD. Done unconditionally (not just on
   * `playing`) so the HUD frame counter and the seek preview both
   * update when paused.
   *
   * Canvas dims (`dw, dh`) are computed once from the PRIMARY clip's
   * source video — every lower-track clip then letterboxes inside
   * the same canvas via its own contain-fit math. The output rect +
   * content rect for the overlay both reflect the primary clip too
   * (keyframe handles on PiP-overlaid clips are a v2 concern).
   */
  private paint(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.clearRect(0, 0, cw, ch);

    const primaryClip = this.primaryActiveClip();
    const primaryVideo = primaryClip
      ? this.videos.get(primaryClip.sourceId)
      : null;
    if (
      !primaryClip ||
      !primaryVideo ||
      primaryVideo.videoWidth === 0 ||
      primaryVideo.videoHeight === 0
    ) {
      this.frameRectsByClip.clear();
      this.lastOutputRect = null;
      this.primaryClipIdLastPaint = null;
      this.updateBadge();
      return;
    }

    // Canvas dims come from `getCanvasReferenceDims` — which prefers
    // `project.output` (the authoritative authoring canvas, e.g.
    // 1080×1920 for a 9:16 project) and falls back to the first clip
    // on track 0 for legacy projects without `output`. NEVER use
    // `parseAspect(project.aspect)` here — that returns the bare
    // ratio numbers (9, 16) which would make `canvasScale = cw/9`
    // huge, and any pan multiplied by that scale flings the content
    // out of frame on the first cursor wiggle.
    let aw: number;
    let ah: number;
    const ref = this.canvasReferenceDims();
    if (ref) {
      [aw, ah] = ref;
    } else {
      aw = primaryVideo.videoWidth;
      ah = primaryVideo.videoHeight;
    }
    const canvasScale = Math.min(cw / aw, ch / ah);
    const dw = aw * canvasScale;
    const dh = ah * canvasScale;
    const dpr = window.devicePixelRatio || 1;
    const outX = (cw - dw) / 2;
    const outY = (ch - dh) / 2;
    const ccx = cw / 2;
    const ccy = ch / 2;

    // Z-order convention: tracks[0] paints FIRST (bottom) and the
    // last track paints LAST (top). This matches Premiere / After
    // Effects — uploads land on the first empty track, so the second
    // upload (track 1) naturally becomes the PiP overlay sitting on
    // top of the track-0 background. While painting, also cache each
    // clip's post-transform content rect so the overlay can latch
    // onto whichever clip the user selects.
    this.frameRectsByClip.clear();
    for (let i = 0; i < this.project.tracks.length; i++) {
      const track = this.project.tracks[i]!;
      if (track.kind !== "video") continue;
      const clipId = this.activeByTrack.get(track.id);
      if (!clipId) continue;
      const clip = track.clips.find((c) => c.id === clipId);
      if (!clip) continue;
      const v = this.videos.get(clip.sourceId);
      if (!v || v.videoWidth === 0 || v.videoHeight === 0) continue;

      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const vidContain = Math.min(dw / vw, dh / vh);
      const vidW = vw * vidContain;
      const vidH = vh * vidContain;
      const t = getEffectiveTransform(clip, this.timeMs - clip.start);

      // pan values are in CANVAS pixels (= units of `aw`/`ah`).
      // Convert into preview-canvas backbuffer pixels by multiplying
      // by `canvasScale` — that's the ratio of preview-canvas space
      // per project-canvas unit.
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(outX, outY, dw, dh);
      this.ctx.clip();
      this.ctx.translate(
        ccx + t.panX * canvasScale,
        ccy + t.panY * canvasScale,
      );
      this.ctx.scale(t.scale, t.scale);
      this.ctx.drawImage(v, -vidW / 2, -vidH / 2, vidW, vidH);
      this.ctx.restore();

      // Cache this clip's content rect in CSS px for the overlay.
      // CSS-px conversion: backbuffer / dpr; pan in canvas-px → CSS
      // px = panX * canvasScale / dpr.
      const cssCx = cw / (2 * dpr) + (t.panX * canvasScale) / dpr;
      const cssCy = ch / (2 * dpr) + (t.panY * canvasScale) / dpr;
      const cssW = (vidW * t.scale) / dpr;
      const cssH = (vidH * t.scale) / dpr;
      this.frameRectsByClip.set(clip.id, {
        x: cssCx - cssW / 2,
        y: cssCy - cssH / 2,
        w: cssW,
        h: cssH,
      });
    }
    this.paintedFrames += 1;
    this.primaryClipIdLastPaint = primaryClip.id;

    this.lastOutputRect = {
      x: outX / dpr,
      y: outY / dpr,
      w: dw / dpr,
      h: dh / dpr,
    };
    this.updateBadge();
  }

  getOutputFrameRect(
    _clipId?: string,
  ): { x: number; y: number; w: number; h: number } | null {
    // The output canvas is the same for every clip on the same paint
    // pass, so `_clipId` is just for API symmetry.
    return this.lastOutputRect;
  }

  getFrameRect(
    clipId?: string,
  ): { x: number; y: number; w: number; h: number } | null {
    const id = clipId ?? this.primaryClipIdLastPaint;
    if (id == null) return null;
    // Compute on demand from the LIVE project state instead of
    // returning the paint-cache value. Paint runs in its own rAF
    // tick, so the overlay was reading a frame rect that lagged the
    // actual project by one tick — which manifested as a brief
    // "jump" of the dashed selection border when a drag updated
    // scale + panX in the same tick. Recomputing here keeps the
    // overlay in lockstep with the keyframe model.
    const live = this.computeFrameRect(id);
    return live ?? this.frameRectsByClip.get(id) ?? null;
  }

  /**
   * Compute a clip's content rect (CSS px in host coords) from the
   * LIVE project state — no paint cache involvement. Mirrors the
   * math in `paint()` so visible canvas pixels and overlay handles
   * agree to within float precision.
   */
  private computeFrameRect(
    clipId: string,
  ): { x: number; y: number; w: number; h: number } | null {
    let clip: Clip | null = null;
    for (const track of this.project.tracks) {
      const c = track.clips.find((cc) => cc.id === clipId);
      if (c) {
        clip = c;
        break;
      }
    }
    if (!clip) return null;
    const v = this.videos.get(clip.sourceId);
    if (!v || v.videoWidth === 0 || v.videoHeight === 0) return null;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return null;
    // Same canonical canvas dims as paint() — see the note there.
    let aw: number;
    let ah: number;
    const ref = this.canvasReferenceDims();
    if (ref) {
      [aw, ah] = ref;
    } else {
      aw = v.videoWidth;
      ah = v.videoHeight;
    }
    const canvasScale = Math.min(cw / aw, ch / ah);
    const dw = aw * canvasScale;
    const dh = ah * canvasScale;
    const dpr = window.devicePixelRatio || 1;
    const vidContain = Math.min(dw / v.videoWidth, dh / v.videoHeight);
    const vidW = v.videoWidth * vidContain;
    const vidH = v.videoHeight * vidContain;
    const t = getEffectiveTransform(clip, this.timeMs - clip.start);
    // panX/panY are in CANVAS pixels — convert to CSS px via
    // `canvasScale / dpr` to match the paint() math.
    const cssCx = cw / (2 * dpr) + (t.panX * canvasScale) / dpr;
    const cssCy = ch / (2 * dpr) + (t.panY * canvasScale) / dpr;
    const cssW = (vidW * t.scale) / dpr;
    const cssH = (vidH * t.scale) / dpr;
    return {
      x: cssCx - cssW / 2,
      y: cssCy - cssH / 2,
      w: cssW,
      h: cssH,
    };
  }

  private updateBadge(): void {
    if (!this.badge) return;
    const sec = (this.timeMs / 1000).toFixed(2);
    this.badge.textContent =
      `engine: canvas compositor • t=${sec}s • frames painted: ${this.paintedFrames}`;
  }
}

/** Factory shorthand for `Editor.create({ playbackEngine })`. */
export const canvasCompositorEngineFactory: PlaybackEngineFactory = (opts) =>
  new CanvasCompositorEngine(opts);

/**
 * Parse a `Project.aspect` string like "16:9" into a `[w, h]` tuple.
 * Returns null for missing / malformed input so callers can fall
 * back to the source video's intrinsic aspect.
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
