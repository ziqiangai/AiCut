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
   * Output canvas dimensions in pixels. THIS is the reference frame
   * for every spatial value in the project — `keyframes[i].value` for
   * `panX`/`panY`, the clip-level static `panX/panY` fallbacks, and
   * the editor's canvas-guide rectangle all live in this coordinate
   * system. The preview is just a scaled view of this canvas; the
   * export renders at exactly these dimensions (or a 2× internal pass
   * downsampled to them).
   *
   * Picking a fixed canvas is a CapCut / Premiere / FCP convention —
   * decoupling authoring units from preview-area pixels means a
   * project moves between machines / DPIs / preview sizes without
   * "drifting". Optional for back-compat: `normalizeProject` fills
   * this in from `aspect` (via DEFAULT_OUTPUT_DIMS) or the first
   * clip's source dims when missing, so legacy projects round-trip
   * cleanly.
   */
  output?: ProjectOutput;
  /**
   * Project frame rate. Drives keyboard frame-stepping (← / →), the
   * future timecode display, and ffmpeg compilation of keyframe
   * animations. Optional for back-compat — projects without `fps`
   * default to 30, matching consumer NLE convention (CapCut /
   * Premiere project defaults). `normalizeProject` does NOT fill
   * this in, so a missing field stays missing through round-trips.
   *
   * Deprecated in favor of `output.fps`; still honored for legacy
   * projects, but newly authored projects should set `output.fps`.
   */
  fps?: number;
  /**
   * Output aspect ratio. Drives the editor's built-in aspect picker
   * (when enabled via `EditorOptions.aspect.enabled`) and is exposed
   * to hosts via the `aspectChange` event so they can wire it into
   * their own export defaults / preview letterboxing. Optional for
   * back-compat — projects without an aspect are treated as "source"
   * (the host decides; usually means follow the first clip's
   * intrinsic aspect). `normalizeProject` does NOT fill this in.
   *
   * Authoring aspect is a UI affordance for picking common ratios;
   * the authoritative dimensions live in `output`. Setting an aspect
   * updates `output` to a sensible tier in that ratio.
   */
  aspect?: AspectRatio;
}

export interface ProjectOutput {
  /** Output canvas width in pixels. Must be even (H.264 requirement). */
  width: number;
  /** Output canvas height in pixels. Must be even (H.264 requirement). */
  height: number;
  /** Output frame rate. Falls back to `Project.fps` or 30 when unset. */
  fps?: number;
}

/**
 * Common output aspect ratios — the menu the user picks from when
 * the built-in aspect picker is enabled. Mirrors the CapCut roster:
 * landscape, portrait, square, classic 4:3, classic portrait 3:4,
 * IG portrait 4:5, and cinematic 21:9. New values are an additive
 * change, so future ratios can be appended without breaking projects.
 */
export type AspectRatio =
  | "16:9"
  | "9:16"
  | "1:1"
  | "4:3"
  | "3:4"
  | "4:5"
  | "21:9";

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
