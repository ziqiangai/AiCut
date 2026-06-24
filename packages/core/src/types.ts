/**
 * Milliseconds. All timing in the project is expressed as integer ms to
 * keep JSON serialization unambiguous (no frame-rate coupling in the
 * data model — the renderer can present time as frames if it wants).
 */
export type Ms = number;

export interface MediaSource {
  id: string;
  url: string;
  kind: "video" | "audio";
  /** Optional — probed lazily from the <video> element if absent. */
  duration?: Ms;
  name?: string;
}

export interface Clip {
  id: string;
  sourceId: string;
  /** Window into the source — `in` inclusive, `out` exclusive. */
  in: Ms;
  out: Ms;
  /** Position on the timeline. */
  start: Ms;
  /**
   * Playback rate. 1 = normal, 2 = 2× speed. Default 1.
   * Persisted in the project JSON so a host can restore exactly.
   */
  speed?: number;
  /**
   * Static base values for the content transform, used when the clip
   * has no keyframes for that property. Pan slides the video inside
   * the FIXED output frame (the dashed border the user sees); scale
   * grows / shrinks the content around the frame center. Anything
   * pushed outside the output frame is clipped — that's how
   * picture-in-picture, pan, and zoom work.
   *
   * `panX`, `panY` are CSS pixels relative to the output frame center.
   * Defaults: panX = 0, panY = 0, scale = 1 (content fills frame).
   */
  panX?: number;
  panY?: number;
  scale?: number;
  /**
   * Per-property keyframe animation. Each keyframe targets one prop
   * (`panX`, `panY`, or `scale`) so the user can animate one axis
   * independently of the others (the standard NLE / CapCut model).
   *
   * Times are clip-local (0 = clip's `in`), so trim and move ops
   * carry keyframes with the clip. Empty array / undefined = use the
   * static base values above. `normalizeProject` keeps it sorted by
   * (prop, time).
   */
  keyframes?: Keyframe[];
}

/** Properties on a Clip that can be animated by keyframes. */
export type KeyframeProp = "panX" | "panY" | "scale";

/**
 * Easing curve that shapes the segment LEAVING this keyframe — i.e.
 * the curve from this keyframe to the next one in time. Matches the
 * "outgoing" easing model in After Effects / Premiere / CapCut so a
 * single dropdown per keyframe is enough.
 *
 *   - `linear`     — constant rate (default)
 *   - `easeIn`     — start slow, finish fast (cubic)
 *   - `easeOut`    — start fast, finish slow (cubic)
 *   - `easeInOut`  — slow on both ends, fast in the middle (cubic)
 */
export type EasingKind = "linear" | "easeIn" | "easeOut" | "easeInOut";

/**
 * One pinned value for one property at one moment in clip-local time.
 * Properties without keyframes fall back to the clip's static base
 * value (`Clip.panX` / `panY` / `scale`).
 */
export interface Keyframe {
  id: string;
  /** Which property this keyframe controls. */
  prop: KeyframeProp;
  /** Clip-local time in ms. 0 = clip's `in`. Bounds: [0, clip.out - clip.in]. */
  time: Ms;
  /** The value the property holds at this moment. Same units as the
   *  matching static field (CSS px for pan, multiplier for scale). */
  value: number;
  /** Easing curve for the segment leaving THIS keyframe toward the
   *  next one. Optional — omitted / undefined = "linear" (back-compat
   *  with projects authored before the easing field existed). */
  easing?: EasingKind;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  /** Clips on this track. Must be kept sorted by `start` and non-overlapping. */
  clips: Clip[];
}

export interface Project {
  /** Schema version — bump when breaking the JSON shape. */
  version: 1;
  sources: MediaSource[];
  tracks: Track[];
  /**
   * Project frame rate. Drives keyboard frame-stepping (← / →), the
   * future timecode display, and ffmpeg compilation of keyframe
   * animations. Optional for back-compat — projects without `fps`
   * default to 30, matching consumer NLE convention (CapCut /
   * Premiere project defaults). `normalizeProject` does NOT fill
   * this in, so a missing field stays missing through round-trips.
   */
  fps?: number;
}

/**
 * Subset of CSS variables the editor honors. Pass any custom values
 * via `Editor` options; everything is forwarded as `--aicut-*` on the
 * editor's root container, so a host can also override via plain CSS.
 */
export interface Theme {
  brand?: string;
  secondary?: string;
  surface?: string;
  dark?: string;
  muted?: string;
  card?: string;
  success?: string;
  warning?: string;
  info?: string;
  error?: string;
  /** Toolbar / ruler chrome. Background of the editor frame. */
  controlsBg?: string;
  controlsBorder?: string;
  controlsText?: string;
  controlsHover?: string;
  controlsActive?: string;
  /** Letterbox color around the preview video. Defaults to black. */
  previewBg?: string;
  radiusSm?: string;
  radiusMd?: string;
  radiusLg?: string;
}

/** Range on the timeline, used for visible-range / selection math. */
export interface TimeRange {
  start: Ms;
  end: Ms;
}
