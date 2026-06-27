import type { Ms, Project } from "../types.js";

/**
 * Construction context the Editor hands to a playback engine. The
 * engine mounts itself into `host` (typically the editor's preview
 * element) and owns whatever DOM / canvas / video elements it needs.
 */
export interface PlaybackEngineOptions {
  /** Mount point. Engine appends its preview surface here. */
  host: HTMLElement;
  /** Initial project — engine pre-warms sources, etc. */
  project: Project;
}

/**
 * The contract every preview engine satisfies. Editor talks ONLY
 * through this surface — implementations are interchangeable.
 *
 * Built-in implementations:
 *   - `HtmlVideoEngine`  default; one HTMLVideoElement per source,
 *                        swap on clip boundaries. Zero deps,
 *                        GPU-accelerated decode by the browser, but
 *                        seek snaps to keyframes (browser controls
 *                        the decode pipeline).
 *   - `WebCodecsEngine`  opt-in (v0.6+); manual VideoDecoder loop +
 *                        canvas blit. Frame-accurate seek; will
 *                        underpin multi-track compositing, transitions,
 *                        and shaders in later versions.
 *
 * Hosts can ship their own implementation (e.g., a WebGL compositor,
 * a WebRTC stream consumer, a desktop-wrapper IPC bridge) and inject
 * it via `Editor.create({ playbackEngine: myFactory })`.
 */
export interface PlaybackEngine {
  /** Replace the project. Engine re-warms sources + re-resolves the
   *  active clip for the current playhead. Idempotent. */
  setProject(next: Project): void;

  play(): void;
  pause(): void;
  isPlaying(): boolean;

  /** Current playhead (ms from project start). */
  getTime(): Ms;
  /** Move the playhead. Engine clamps to [0, totalDuration]. */
  seek(timeMs: Ms): void;

  /** Free all resources (DOM nodes, decoders, AudioContexts, rAF). */
  destroy(): void;

  /**
   * Optional. The **output frame rect** — the fixed bounds anything
   * the engine renders is clipped to. The user's keyframe X / Y /
   * scale move the content WITHIN this frame (think picture-in-
   * picture, pan, zoom); anything outside is hidden by the engine.
   *
   * This rect does NOT change with the active transform — it's
   * the stage. The overlay's dashed border is drawn here. Coords
   * relative to `opts.host`. Returns null when no clip is active.
   *
   * `clipId` (optional, PiP-aware engines): identify a specific
   * active clip. Lower-track PiP clips share the same canvas as
   * the primary, so this still returns the canvas rect — but the
   * argument keeps the API symmetric with `getFrameRect` and makes
   * intent explicit at call sites.
   */
  getOutputFrameRect?(clipId?: string): { x: number; y: number; w: number; h: number } | null;

  /**
   * Optional. Return the screen-space CSS-pixel rectangle of the
   * actually-rendered content (the video frame after the active
   * keyframe transform is applied). May extend outside the output
   * frame — the engine clips to the output frame at paint time, but
   * the overlay still wants the geometric rect to position scale
   * handles on the visible content corners.
   *
   * Returns null when no clip is active. Engines that don't expose
   * this leave keyframe handles attached to the output frame instead.
   *
   * `clipId` (optional): with PiP / multi-track, the overlay needs
   * the rect of the SELECTED clip rather than the primary track's
   * — that's how the dashed frame + corner handles latch onto a
   * picture-in-picture overlay when the user selects it. Engines
   * that don't support PiP can ignore the argument and always
   * return the single active clip's rect.
   */
  getFrameRect?(clipId?: string): { x: number; y: number; w: number; h: number } | null;

  /**
   * Optional. Return the intrinsic dimensions in CANVAS PIXELS of the
   * authoring canvas — the reference frame keyframe pan/scale values
   * are stored in. When `Project.output` is set this returns those
   * dims; otherwise engines fall back to "anchor" semantics (first
   * clip on the bottom track) so legacy projects without `output`
   * still resolve to a stable canvas across clip boundaries.
   *
   * Tuple form is `[width, height]`. Returns null when no source has
   * decoded enough to know the anchor dims yet.
   */
  getCanvasReferenceDims?(): [number, number] | null;

  /**
   * Optional. Toggle multi-track compositing. When `true`, the engine
   * paints every video track's currently-active clip at the playhead
   * with track `0` on top (matching the timeline's visual top-to-
   * bottom = top-to-bottom z-order). When `false` (default), only
   * track `0`'s active clip paints — today's single-clip behaviour.
   *
   * Engines that don't implement this are documented as PiP-incapable
   * in the README; the Editor falls back to single-track regardless
   * of the flag. Same opt-in pattern as keyframes — data is preserved
   * (extra-track clips remain in the project), only the painted
   * preview changes.
   */
  setPictureInPictureEnabled?(enabled: boolean): void;

  // ---- Event hooks — set by the Editor after construction. Engines
  // call these when state changes. All optional; engines that can't
  // emit a particular event (e.g. no audio metadata) just never call
  // the corresponding hook. ----

  /** Fired on each rAF / decoded frame with the current playhead. */
  onTimeUpdate?: (ms: Ms) => void;
  /** Fired once when the project's end is reached during playback. */
  onEnded?: () => void;
  /** Decode / network / capability failures. */
  onError?: (err: Error) => void;
  /**
   * Fired the first time a fresh playback target is "ready to play"
   * — analogue of HTMLMediaElement's `loadedmetadata`. Editor uses
   * it to gate scaling / auto-fit work.
   */
  onReady?: () => void;
  /**
   * Fired when an individual source's duration becomes known. Editor
   * folds this into the project model so the timeline can size clips
   * correctly even when the host didn't ship a `duration` upfront.
   */
  onSourceMetadata?: (sourceId: string, durationMs: Ms) => void;
}

/**
 * A factory that builds an engine for a given mount/project. Hosts
 * pass one of these to `Editor.create({ playbackEngine })` to swap
 * implementations. The factory shape — rather than a class reference
 * — keeps Editor decoupled from constructor signatures and lets
 * factories close over host-side configuration (auth tokens, render
 * backend URL, custom shaders, etc.) without polluting the interface.
 */
export type PlaybackEngineFactory = (
  opts: PlaybackEngineOptions,
) => PlaybackEngine;
