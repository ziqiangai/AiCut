import { EventBus } from "./events.js";
import { HistoryStack } from "./history.js";
import { createId } from "./ids.js";
import {
  clipDuration,
  clipEnd,
  createEmptyProject,
  defaultOutputForAspect,
  findClipContaining,
  findTrackOfClip,
  normalizeProject,
  projectDuration,
  splitClipAt,
  timelineToSourceMs,
  trackEnd,
} from "./model.js";
import {
  SCALE_MAX,
  SCALE_MIN,
  setTimelineMetrics,
  wouldOverlap,
} from "./timeline/layout.js";
import {
  HtmlVideoEngine,
  type PlaybackEngine,
  type PlaybackEngineFactory,
} from "./playback/index.js";
import { applyTheme } from "./theme.js";
import { type Locale, mergeLocale } from "./i18n.js";
import type {
  AspectRatio,
  Clip,
  EasingKind,
  Keyframe,
  KeyframeProp,
  MediaSource,
  Ms,
  Project,
  Theme,
  Track,
} from "./types.js";
import {
  getEffectiveTransform,
  interpolateProp,
  upsertKeyframe,
} from "./keyframes/index.js";
import { EditorUI } from "./ui/index.js";
import { probeMediaSource } from "./media-probe.js";
import { captureRawFrame, encodeCanvas } from "./frame-capture.js";

/**
 * State-only knobs that ALL editor entry points accept — used by the
 * headless (`createHeadless`) path AND the mounted `create` path.
 * Split from `EditorOptions` so React's `<EditorProvider>` and Vue's
 * `useAicutEditor()` can spin up an Editor without a mount container
 * and each primitive component (`<Preview>`, `<Timeline>`, buttons,
 * …) mounts its own DOM independently.
 */
export interface HeadlessEditorOptions {
  /** Initial project state. Falls back to an empty single-track project. */
  project?: Project;
  /** CSS variable overrides — applied by `editor.applyThemeTo(el)`. */
  theme?: Theme;
  /** Initial playhead position (ms). */
  initialTime?: Ms;
  /** Initial timeline zoom (pixels per second). Defaults to 80. */
  initialScale?: number;
  /** Initial snap toggle. Defaults to true. */
  initialSnap?: boolean;
  /**
   * UI string overrides. Falls back to English (`localeEn`) for any
   * keys not provided. Use `localeZh` as the value for full Chinese.
   */
  locale?: Partial<Locale>;
  /**
   * Optional factory for a custom playback engine. Receives the
   * preview host element + the initial project, returns anything
   * satisfying `PlaybackEngine`. Defaults to the built-in
   * `HtmlVideoEngine`. The engine is created LAZILY on
   * `editor.attachPreview(host)` — headless editors have no engine
   * until a Preview primitive mounts.
   */
  playbackEngine?: PlaybackEngineFactory;
  /** See `EditorOptions`. */
  trackHeight?: number;
  rulerHeight?: number;
  timelineHeight?: number;
  rulerMinTickPx?: number;
  keyframes?: { enabled?: boolean };
  clipEdgeNav?: { enabled?: boolean };
  previewFrame?: { enabled?: boolean };
  pictureInPicture?: { enabled?: boolean; toolbarAdd?: boolean };
  aspect?: { enabled?: boolean };
  previewLayout?: PreviewLayout;
}

export interface EditorOptions extends HeadlessEditorOptions {
  /** Host element to mount the editor into. Will be wiped on init. */
  container: HTMLElement;
  /** Initial project state. Falls back to an empty single-track project. */
  project?: Project;
  /** CSS variable overrides. */
  theme?: Theme;
  /** Initial playhead position (ms). */
  initialTime?: Ms;
  /** Initial timeline zoom (pixels per second). Defaults to 80. */
  initialScale?: number;
  /** Initial snap toggle. Defaults to true. */
  initialSnap?: boolean;
  /**
   * UI string overrides. Falls back to English (`localeEn`) for any
   * keys not provided. Use `localeZh` as the value for full Chinese.
   * Call `editor.setLocale(...)` to switch at runtime.
   */
  locale?: Partial<Locale>;
  /**
   * Optional factory for a custom playback engine. Receives the
   * editor's preview host element + the initial project, returns
   * anything satisfying `PlaybackEngine`. Defaults to the built-in
   * `HtmlVideoEngine` (one hidden `<video>` per source, swap on
   * boundaries). Hosts that need frame-accurate editing, multi-track
   * compositing, transitions, etc. pass a `WebCodecsEngine` factory
   * (v0.6+) or their own.
   */
  playbackEngine?: PlaybackEngineFactory;
  /**
   * Pixel height of each track row in the timeline (default 56). Lower
   * values (~32–40) shrink the timeline footprint for small viewports
   * where the default crowds out the preview. Reasonable range:
   * [28, 96]. Applied process-wide via `setTimelineMetrics` — multi-
   * editor mounts share the value.
   */
  trackHeight?: number;
  /**
   * Pixel height of the timeline ruler / time-label strip (default 24).
   * Pair with `trackHeight` to compact the whole timeline. Reasonable
   * range: [18, 36].
   */
  rulerHeight?: number;
  /**
   * Pixel height of the whole bottom timeline area (default 240). The
   * canvas inside fills 100% of this and shows a vertical scrollbar
   * when there are more tracks than fit. Lower this (~120–180) on
   * small viewports so the preview takes more of the editor's height.
   * Reasonable range: [120, 480].
   */
  timelineHeight?: number;
  /**
   * Minimum pixel gap between ruler major ticks. The library picks the
   * "nicest" interval (1s, 0.5s, 0.2s, …) that keeps majors at least
   * this far apart for the current zoom. Default 80; lower (~50) packs
   * labels denser, higher (~140) spaces them out. Reactive via
   * `editor.setRulerMinTickPx(...)`.
   */
  rulerMinTickPx?: number;
  /**
   * Per-clip keyframe animation (X / Y / Scale). Off by default; flip
   * `enabled: true` to surface keyframe markers on the timeline and
   * route the canvas / WebCodecs engines through `getEffectiveTransform`
   * when painting. Data is preserved either way — disabling just hides
   * the editing UI and renders identity transforms.
   *
   * HtmlVideoEngine cannot apply per-frame transforms (it shows a raw
   * `<video>`), so keyframes are silently ignored on that engine
   * regardless of this flag. Swap to `CanvasCompositorEngine` or
   * `WebCodecsEngine` for live preview.
   */
  keyframes?: { enabled?: boolean };
  /**
   * Show the |◀ / ▶| "jump to clip start / end" toolbar buttons and
   * bind the I / O keyboard shortcuts. Off by default — hosts opt in
   * the same way they do for keyframes. When off the buttons are
   * completely hidden (display: none) so they don't take up toolbar
   * space, and the I / O keys fall through to the page.
   */
  clipEdgeNav?: { enabled?: boolean };
  /**
   * Dashed output-frame outline on top of the preview. Independent
   * of keyframes mode — the frame is purely visual (it shows the
   * fixed output canvas where the video lands after transforms), so
   * it's useful even when keyframe editing is off (e.g. to visualize
   * the current aspect-ratio choice). On by default; pass
   * `{ enabled: false }` to hide it entirely. When keyframes mode is
   * also on, the frame body becomes draggable (pan) and grows corner
   * scale handles — both are gated by `keyframes.enabled` regardless
   * of this flag.
   */
  previewFrame?: { enabled?: boolean };
  /**
   * Built-in aspect-ratio picker (CapCut-style "比例" dropdown).
   * Off by default — hosts who want to provide their own picker keep
   * today's behaviour by leaving this off and rendering a control
   * into `editor.toolbarLeft`. When `enabled: true`, the editor
   * renders the picker before the left-hand button cluster and emits
   * `aspectChange` whenever the user picks. The selected value is
   * persisted on `Project.aspect`.
   *
   * Hosts wire `onAspectChange` to update their preview letterbox /
   * export defaults — the library does not letterbox the preview by
   * itself (different engines have different paint pipelines).
   */
  aspect?: { enabled?: boolean };
  /**
   * Multi-track picture-in-picture compositing in the preview. Off by
   * default so today's single-clip behaviour is unchanged. When on,
   * every video track's currently-active clip paints at the playhead
   * with track `0` on top — matching the timeline's visual order.
   *
   * Audio policy: only the top track's clip stays unmuted; lower
   * tracks mute to avoid stacking audio playback. Hosts wanting
   * per-track audio control should disable PiP and roll their own
   * mixer.
   *
   * Same-source caveat: a single `<video>` / decoder can only be at
   * one `currentTime`, so a clip dropped on two tracks at different
   * timeline positions visually appears in both, but plays from
   * whichever position was activated last. The fix is to upload the
   * source twice (separate `MediaSource.id`s).
   *
   * `HtmlVideoEngine`, `CanvasCompositorEngine` both implement PiP
   * via `PlaybackEngine.setPictureInPictureEnabled`. Other engines
   * fall back to single-clip.
   *
   * `toolbarAdd: true` surfaces a built-in "+ PiP overlay" icon
   * button in the toolbar (next to the keyframe button). Clicking
   * it emits the `requestPictureInPictureAdd` event — the LIBRARY
   * doesn't run an upload itself. Hosts wire this to their existing
   * file-picker / upload pipeline and then create the new clip
   * wherever makes sense for their data model. Defaults to false
   * so the chrome stays unchanged for hosts that roll their own UI.
   *
   * `enabled` controls whether multi-track composition actually
   * happens. It's intentionally orthogonal to the toolbar button:
   * the toolbar is "add a PiP", the enable flag is "show the
   * compositor". Hosts typically wire a sidebar checkbox or
   * settings menu to it.
   */
  pictureInPicture?: {
    enabled?: boolean;
    toolbarAdd?: boolean;
  };
  /**
   * High-level editor layout.
   *
   * - `"centered"` (default): three-column grid — host content on
   *   the left, preview locked to the centre 1/3, host content on
   *   the right. CapCut-desktop convention.
   * - `"fullWidth"`: preview spans the editor's full width with no
   *   side columns — useful for embeds where the host doesn't want
   *   to render any panels.
   *   The preview's aspect frame sizes its height from that 1/3
   *   width and the video letterboxes inside. Playback chrome
   *   (time / play / duration / fullscreen) renders as an overlay
   *   inside the preview, CapCut-desktop style, so the top toolbar
   *   collapses to edit + viewport clusters only.
   *
   * Hosts wire `panelLeft` / `panelRight` slots via the React /
   * Vue wrappers to fill the side columns. Reactive — flip via
   * `editor.setPreviewLayout(...)`.
   */
  previewLayout?: PreviewLayout;
}

export type PreviewLayout = "fullWidth" | "centered";

/**
 * Discriminated result for mutating operations. Replaces the mix of
 * `boolean` / `string[] | null` / `void` returns the earlier API
 * shipped with, so callers (especially AI tool-loops) get a machine-
 * readable reason on failure without having to guess from a `false`.
 *
 * The `data` field is method-specific — see each `Editor` method's
 * signature for its exact shape.
 *
 * Old signatures are preserved as overloads for now; passing the new
 * option-object form triggers the `EditResult` branch, positional-arg
 * calls keep returning `boolean` / `string[] | null` for compat.
 */
export type EditResult<T = Record<string, never>> =
  | { ok: true; data: T }
  | { ok: false; reason: EditErrorReason; hint?: string };

/**
 * Every AI-facing mutator (`splitClip`, `moveClipTo`, `trimClip`,
 * `deleteClip`, `addClip`) fires one `operation` event on the bus
 * after committing. The event carries enough context for a visual
 * effect layer (e.g. `@aicut/effects`) to render an animation over
 * the top — before / after project snapshots so a UI can diff, plus
 * a monotonically increasing `timestamp` for ordering.
 *
 * `batchId` groups ops fired inside a single `editor.batch(...)` call
 * so effects can play a single "worker does 3 things in sequence"
 * animation instead of stacking 3 independent ones.
 *
 * Fires on both success AND failure — a failed op is worth animating
 * (a puzzled character shrugs?), and downstream telemetry might want
 * to log rejected attempts. Check `result.ok` to branch.
 */
export interface OperationEvent {
  kind:
    | "splitClip"
    | "moveClipTo"
    | "trimClip"
    | "deleteClip"
    | "addClip";
  /** Original method args, forwarded verbatim. Effect handlers use
   *  this to look up the affected clip / track / time. */
  args: unknown;
  /** The `EditResult` returned by the mutator. `ok: true` means the
   *  project was actually mutated. */
  result: EditResult<unknown>;
  /** Wall-clock ms at the emit moment. Effect handlers use this to
   *  dedupe / order concurrent ops. */
  timestamp: number;
  /** Deep-cloned project snapshot BEFORE the mutation. Empty object
   *  when the mutation failed at the guard layer before touching
   *  state — check `result.ok` first. */
  beforeProject: Project;
  /** Deep-cloned project snapshot AFTER the mutation. Same as
   *  `editor.getProject()` at emit time. */
  afterProject: Project;
  /** Present when the op fired inside `editor.batch(label, fn)`.
   *  All ops in one batch share the same id. */
  batchId?: string;
}

export type EditErrorReason =
  /** Referenced clipId doesn't exist in the current project. */
  | "clip-not-found"
  /** Referenced trackId doesn't exist. */
  | "track-not-found"
  /** Referenced sourceId doesn't exist. */
  | "source-not-found"
  /** `timeMs` fell outside the target clip's [start, end). Split needs
   *  a strictly-interior time. */
  | "time-outside-clip"
  /** `timeMs` was negative or NaN / Infinity. */
  | "invalid-time"
  /** For moveClip with `onOverlap: "error"` — the destination
   *  interval overlaps another clip on the target track. */
  | "overlap"
  /** Values passed would produce an invalid clip (in >= out, negative
   *  duration, etc.). */
  | "invalid-range"
  /** URL probe failed (couldn't load metadata; likely CORS or 404). */
  | "source-load-failed"
  /** Generic fallback for internal invariant violations. */
  | "internal-error";

export interface EditorEventMap {
  /** Emitted whenever the project mutates. */
  change: { project: Project };
  /** Playhead position update — driven by the playback tick loop. */
  time: { timeMs: Ms };
  play: void;
  pause: void;
  /** A source's metadata finished loading (duration etc). */
  ready: { sourceId: string | null };
  /** User clicked the Export button. Host decides what to do with the JSON. */
  export: { project: Project };
  error: { error: Error };
  /** Currently selected clip id, or null. */
  selectionChange: { clipId: string | null };
  /** Currently selected keyframe (parent clip + keyframe id), or null.
   *  Selecting a keyframe also selects its parent clip — listeners
   *  watching `selectionChange` get notified independently. */
  keyframeSelectionChange: {
    target: { clipId: string; keyframeId: string } | null;
  };
  /** Keyframe-mode toggle changed (Editor.setKeyframesEnabled). */
  keyframesEnabledChange: { enabled: boolean };
  /** Jump-to-clip-edge nav toggle changed (Editor.setClipEdgeNavEnabled). */
  clipEdgeNavEnabledChange: { enabled: boolean };
  /** Output-frame outline visibility flipped (Editor.setPreviewFrameEnabled). */
  previewFrameEnabledChange: { enabled: boolean };
  /** Multi-track preview compositing toggle changed
   *  (Editor.setPictureInPictureEnabled). */
  pictureInPictureEnabledChange: { enabled: boolean };
  /** Layout flipped between fullWidth and centered. */
  previewLayoutChange: { layout: PreviewLayout };
  /**
   * User clicked the built-in "+ PiP overlay" toolbar button. Host
   * is expected to surface its own file-picker / upload affordance
   * and append the resulting clip somewhere appropriate (typically
   * a new video track). The library doesn't ship an upload UI on
   * purpose — different hosts have very different upload pipelines.
   */
  requestPictureInPictureAdd: void;
  /**
   * Aspect-ratio picker toggle changed (Editor.setAspectEnabled). Only
   * fires when the host-facing visibility flips — picking a new ratio
   * fires `aspectChange` instead.
   */
  aspectEnabledChange: { enabled: boolean };
  /**
   * User (or programmatic call) chose a different output aspect ratio.
   * `aspect` is null when cleared back to "Original" (use the source
   * clip's intrinsic aspect). Persisted on `Project.aspect`.
   */
  aspectChange: { aspect: AspectRatio | null };
  /** Zoom (px/sec) changed. */
  scaleChange: { pxPerSec: number };
  /** Snap toggle changed. */
  snapChange: { snap: boolean };
  /** Undo/redo stack states changed (button enablement). */
  historyChange: { canUndo: boolean; canRedo: boolean };
  /** Theme tokens changed via `editor.setTheme(...)`. Subscribers (e.g.
   *  the standalone `<TimelinePrimitive>`) use this to force a canvas
   *  re-paint since CSS custom properties don't invalidate the canvas
   *  on their own. */
  themeChange: { theme: Theme };
  /** Locale tokens changed via `editor.setLocale(...)`. */
  localeChange: { locale: Locale };
  /** An AI-facing mutator (`splitClip`, `moveClipTo`, `trimClip`,
   *  `deleteClip`, `addClip`) just fired. Payload carries kind, args,
   *  the returned `EditResult`, and before/after project snapshots
   *  so downstream visual-effect layers can play an animation on top
   *  of the timeline / preview without recomputing state. See
   *  `OperationEvent` for the full contract. */
  operation: OperationEvent;
}

export type EditorEventName = keyof EditorEventMap;

export interface EditorApi {
  // playback
  play(): void;
  pause(): void;
  togglePlay(): void;
  seek(timeMs: Ms): void;
  getTime(): Ms;
  getDuration(): Ms;
  isPlaying(): boolean;
  enterFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;

  // editing
  split(timeMs?: Ms): string[] | null;
  /** Alias of split, kept for back-compat. */
  cut(timeMs?: Ms): string[] | null;
  /** Trim the selected clip's left edge to the given time (or playhead). */
  trimLeft(timeMs?: Ms): boolean;
  /** Trim the selected clip's right edge to the given time (or playhead). */
  trimRight(timeMs?: Ms): boolean;
  removeClip(clipId: string): boolean;
  setClipSpeed(clipId: string, speed: number): boolean;

  // ── AI-facing editing surface ────────────────────────────────────
  // The methods above operate against "selection + playhead" implicit
  // state and return boolean / string[] | null on failure. The methods
  // below take explicit targets and return `EditResult`, so an AI tool-
  // loop (or any code without UI state) can drive the editor
  // deterministically and read a typed reason on failure.
  //
  // Legacy signatures above are preserved unchanged. New code /
  // hosted-by-AI code should prefer these.

  /**
   * Split a specific clip at a timeline-absolute time. Fails cleanly
   * if the time falls outside the clip's [start, end) — no more
   * silent first-match-wins across other tracks.
   */
  splitClip(args: {
    clipId: string;
    /** Timeline-absolute Ms. Must be strictly inside the target clip. */
    timeMs: Ms;
  }): EditResult<{ newClipIds: [string, string] }>;

  /**
   * Move an existing clip to an explicit destination. Unlike `moveClip`
   * — which does UI-friendly smart-routing (drops the clip on any
   * non-overlapping track it can find) — this method commits to the
   * caller's target and reports `reason: "overlap"` when the slot is
   * taken. Pass `onOverlap: "auto"` to opt back into smart-routing.
   */
  moveClipTo(args: {
    clipId: string;
    /** Destination track. Omit to keep clip on its current track. */
    toTrackId?: string;
    /** Timeline-absolute start Ms. Omit to keep current start. */
    startMs?: Ms;
    /**
     * - `"error"` (default) — refuse the move; return `overlap` reason.
     * - `"auto"` — today's `moveClip` smart-routing (fall back to any
     *   free track of the same kind, else append a fresh one).
     */
    onOverlap?: "error" | "auto";
  }): EditResult<{ clipId: string; trackId: string; startMs: Ms }>;

  /**
   * Trim one edge of a clip. `edge: "left"` moves `in` (and `start`)
   * to the given timeline time; `edge: "right"` moves the effective
   * end. Time must land inside the clip's original playable range.
   */
  trimClip(args: {
    clipId: string;
    edge: "left" | "right";
    /** Timeline-absolute Ms of the new edge. */
    timeMs: Ms;
  }): EditResult<{ clipId: string }>;

  /** Delete a clip by id. Same as `removeClip` but typed. */
  deleteClip(args: { clipId: string }): EditResult<{ clipId: string }>;

  /**
   * One-shot: load a URL as a `MediaSource` (probing duration +
   * dimensions), create a clip referencing it on the target track at
   * the target time, and return typed IDs. Async because URL loading
   * involves an `<video>` metadata probe.
   *
   * Skip the probe by passing `sourceId` for an already-added source;
   * `inMs`/`outMs` still apply against that source's duration.
   *
   * `meta` is accepted for forward-compat with generated-content
   * workflows (recording `generatedBy`, `prompt`, etc.). MVP silently
   * ignores it — a future release will land the `Clip.meta` field and
   * start persisting.
   */
  addClip(args: {
    /** Source URL to probe + register. Mutually exclusive with `sourceId`. */
    sourceUrl?: string;
    /** Reuse an already-added source. Mutually exclusive with `sourceUrl`. */
    sourceId?: string;
    trackId: string;
    startMs: Ms;
    /** Trim into source. Defaults to 0. */
    inMs?: Ms;
    /** Trim out of source. Defaults to source.duration. */
    outMs?: Ms;
    onOverlap?: "error" | "auto";
    /** Forward-compat only in MVP; silently dropped. */
    meta?: Record<string, unknown>;
  }): Promise<EditResult<{ clipId: string; sourceId: string }>>;

  /**
   * Capture a still frame as a JPEG/PNG blob. Two source modes:
   *
   * - `"composite"` (default) — the pixels the user currently sees:
   *   the compositor canvas after seeking to `timeMs` and waiting one
   *   frame. Applies keyframe transforms, PiP layering, letterbox.
   *   Requires an engine that paints to a `<canvas>` (
   *   `CanvasCompositorEngine` or `WebCodecsEngine`). With
   *   `HtmlVideoEngine` the returned blob is empty and the reason is
   *   `internal-error` — fall back to `"raw"`.
   *
   * - `"raw"` — the raw source frame at the equivalent source-local
   *   time of `clipId`. Independent of engine; spawns a hidden
   *   `<video>` on demand. Pass `clipId` — required. `timeMs` is
   *   timeline-absolute; the method converts via `timelineToSourceMs`.
   *
   * Purpose: give AI tool-loops something to feed a vision model
   * without setting up the compositor pipeline themselves.
   */
  captureFrame(args: {
    /** Timeline-absolute Ms. */
    timeMs: Ms;
    source?: "composite" | "raw";
    /** Required for `"raw"` mode — which clip's source to read. */
    clipId?: string;
    /** `"image/jpeg"` (default; smaller, faster for AI vision) or
     *  `"image/png"` (larger, lossless). */
    format?: "image/jpeg" | "image/png";
    /** JPEG quality [0, 1]. Ignored for PNG. */
    quality?: number;
    /** Downscale on the way out — big frames are wasted vision tokens.
     *  Preserves aspect ratio. */
    maxWidth?: number;
  }): Promise<EditResult<{ blob: Blob; width: number; height: number }>>;
  previewMoveTarget(
    clipId: string,
    start: Ms,
    intendedTrackId?: string,
  ): { trackIndex: number; trackId: string; wouldCreateNew: boolean } | null;

  // tracks
  addTrack(kind: Track["kind"]): Track;
  removeTrack(trackId: string): boolean;
  moveClip(
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ): boolean;
  resizeClip(clipId: string, edits: Partial<Pick<Clip, "in" | "out" | "start">>): boolean;

  // sources & state
  addSource(source: MediaSource, opts?: { appendClip?: boolean }): MediaSource;
  setProject(project: Project): void;
  getProject(): Project;
  /** Replace the project with a brand-new empty one. */
  reset(): void;
  setTheme(theme: Theme): void;
  /**
   * Swap the UI locale at runtime. Partial overrides merge with the
   * English default. Triggers a re-render so the toolbar tooltips
   * and timeline canvas labels pick up the new strings immediately.
   */
  setLocale(locale: Partial<Locale>): void;
  /** Currently resolved `Locale` object (merged with `localeEn` for
   *  any keys the host didn't override). Emits `localeChange` on
   *  update — used by the React `useLocale()` hook. */
  getLocale(): Locale;
  /**
   * Fire the `export` event with the current project JSON. Hosts call
   * this from their own export button (built into their toolbarRight
   * slot, a keyboard shortcut, a menu item, etc.) to surface project
   * data to whatever pipeline they own. The library never invokes
   * this on its own — it has no UI for export.
   */
  requestExport(): void;

  // viewport
  getScale(): number;
  setScale(pxPerSec: number): void;
  getSnap(): boolean;
  setSnap(snap: boolean): void;

  /** Read current ruler tick min-pixel-gap (see `rulerMinTickPx` option). */
  getRulerMinTickPx(): number;
  /** Update the ruler tick density at runtime. */
  setRulerMinTickPx(px: number): void;

  // selection
  getSelection(): string | null;
  setSelection(clipId: string | null): void;

  // keyframes
  isKeyframesEnabled(): boolean;
  setKeyframesEnabled(enabled: boolean): void;
  isClipEdgeNavEnabled(): boolean;
  setClipEdgeNavEnabled(enabled: boolean): void;
  /** Dashed output-frame outline visibility. Defaults to true. */
  isPreviewFrameEnabled(): boolean;
  setPreviewFrameEnabled(enabled: boolean): void;
  /** Multi-track preview compositing (picture-in-picture). Defaults
   *  to false. Flipping triggers an engine-side re-composite. */
  isPictureInPictureEnabled(): boolean;
  setPictureInPictureEnabled(enabled: boolean): void;
  /** Current high-level editor layout. Defaults to "centered". */
  getPreviewLayout(): PreviewLayout;
  setPreviewLayout(layout: PreviewLayout): void;
  /** Built-in aspect picker visibility (CapCut-style 比例 dropdown). */
  isAspectEnabled(): boolean;
  setAspectEnabled(enabled: boolean): void;
  /** Current output aspect ratio, or null when "Original" (follow source). */
  getAspect(): AspectRatio | null;
  /**
   * Set the output aspect ratio. Pass `null` to clear back to
   * "Original". Persists on `Project.aspect`, also writes the matching
   * 1080p-tier dims into `Project.output`, emits `aspectChange`, and
   * pushes a history entry so the change participates in undo. No-op
   * when the value didn't change.
   */
  setAspect(aspect: AspectRatio | null): void;
  /**
   * Output canvas dims in pixels. THIS is the reference coordinate
   * system every spatial value in the project lives in — keyframe
   * panX/panY, the canvas guide rect, the export resolution. Falls
   * back to `aspect`-derived dims, then to the first clip's intrinsic
   * source size, when nothing's been set on the project explicitly.
   */
  getOutput(): { width: number; height: number; fps?: number };
  /**
   * Write output canvas dims into `Project.output`. Even-snaps both
   * axes (H.264 requirement) and pushes history. Pan / scale already
   * stored against the previous canvas are NOT rescaled — same as
   * how Premiere handles a sequence-settings change. Hosts who want
   * value preservation should normalize keyframes themselves.
   */
  setOutput(output: { width: number; height: number; fps?: number }): void;
  /** Screen-space CSS-pixel rect of the active rendered frame, post
   *  transform, relative to the editor preview. Null when none. */
  getActiveFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null;
  /** Same as `getActiveFrameRect` but for an arbitrary clipId. Used
   *  by the overlay's hit-testing to figure out which PiP clip a
   *  click in the preview lands on. Null when the clip isn't
   *  currently being painted. */
  getClipFrameRect(
    clipId: string,
  ): { x: number; y: number; w: number; h: number } | null;
  /** Output frame rect (fixed bounds, no transform). The overlay
   *  draws the dashed border here. */
  getActiveOutputFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null;
  /**
   * Upsert a per-property keyframe at the given clip-local time. If a
   * keyframe for the same `prop` already exists within ~1 frame of
   * `time` it gets its value updated; else a new one is appended.
   * Returns the keyframe's id, or null when the clip can't be found.
   *
   * Defaults: `time` = playhead in clip-local coords; `value` = the
   * currently interpolated value for that prop (so adding doesn't
   * cause a visible jump).
   */
  addKeyframe(
    clipId: string,
    prop: KeyframeProp,
    opts?: { time?: Ms; value?: number },
  ): string | null;
  removeKeyframe(clipId: string, keyframeId: string): boolean;
  moveKeyframe(clipId: string, keyframeId: string, timeMs: Ms): boolean;
  /** Change one keyframe's value (single number, since each kf is
   *  per-property). */
  setKeyframeValue(
    clipId: string,
    keyframeId: string,
    value: number,
  ): boolean;
  /**
   * Change one keyframe's outgoing easing curve. Shapes only the
   * segment from this kf to the NEXT kf in time on the same prop.
   * The kf's value is untouched.
   */
  setKeyframeEasing(
    clipId: string,
    keyframeId: string,
    easing: EasingKind,
  ): boolean;
  /**
   * Batch-set the outgoing easing on every kf at one moment in time
   * (within the 16ms tolerance that the rest of the API uses) on a
   * single clip. Mirrors the panel's "one dropdown for the moment"
   * UX so all three props (panX / panY / scale) at the selected
   * moment animate with the same curve. Single history entry.
   */
  setKeyframesEasingAtTime(
    clipId: string,
    timeMs: Ms,
    easing: EasingKind,
  ): boolean;
  /**
   * CapCut-style auto-record: write `value` for `prop` at the playhead.
   * - If the prop already has keyframes → upsert a keyframe at the
   *   playhead with this value.
   * - If the prop has no keyframes → just update the static base
   *   (panX / panY / scale on the clip) so the visual changes
   *   without committing the user to an animation track yet.
   * Returns true if the project changed.
   */
  setValueAtPlayhead(
    clipId: string,
    prop: KeyframeProp,
    value: number,
  ): boolean;
  getSelectedKeyframe(): { clipId: string; keyframeId: string } | null;
  setSelectedKeyframe(
    target: { clipId: string; keyframeId: string } | null,
  ): void;
  /**
   * Toolbar-style toggle. If ANY keyframe exists at the playhead time
   * on the selected clip, remove every keyframe at that time (all
   * props). Otherwise, capture one keyframe per prop (panX, panY,
   * scale) at the playhead with the currently interpolated values.
   * Returns true when the project changed.
   */
  toggleKeyframeAtPlayhead(): boolean;
  /**
   * Clear every keyframe AND every static transform value on a clip,
   * restoring the identity pose (panX=0, panY=0, scale=1). Single
   * history entry. */
  resetClipTransform(clipId: string): boolean;
  /**
   * Pin all three transform props (panX, panY, scale) to identity
   * (0, 0, 1) at one specific clip-local time. Upserts on each prop —
   * keyframes that already exist at that time get their values
   * overwritten; props with no kf there get one added. Single history
   * entry. Used by the panel's Reset button when a keyframe is selected.
   */
  resetKeyframesAtTime(clipId: string, timeMs: Ms): boolean;
  /**
   * Move the playhead to a clip edge. "end" intentionally lands 1ms
   * INSIDE the clip (clipEnd - 1) so the playhead remains inside the
   * clip — that lets the user immediately press the keyframe button
   * (or the I/O shortcut) and have it find the right clip + drop a
   * keyframe at clip-local time `duration - 1ms`. Without the -1ms
   * offset the playhead lands on the seam and `toggleKeyframeAtPlayhead`
   * picks the next clip (or none at all).
   * Returns true when the seek actually moved.
   */
  seekToClipEdge(clipId: string, edge: "start" | "end"): boolean;
  /** Convenience for the toolbar: act on the currently-selected clip. */
  seekToSelectedClipEdge(edge: "start" | "end"): boolean;

  // history
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
  /**
   * Open a "drag session". While open, every internal `pushHistory`
   * call captures the pre-session snapshot ONCE — subsequent calls
   * during the same session are no-ops. The session commits a single
   * history entry on `endInteraction()` (or is dropped entirely if
   * the project ended up unchanged). Nestable: nested begin/end pairs
   * count by depth and only the outermost commits.
   *
   * Hosts call this around continuous gestures (drag the preview
   * overlay, scrub a numeric slider, wheel-zoom) so a single user
   * gesture becomes ONE undo entry instead of 30-100. Without this,
   * each pointermove of an overlay drag pushes its own history entry
   * and the user has to mash Cmd+Z that many times to fully undo.
   */
  beginInteraction(): void;
  endInteraction(): void;
  /**
   * Group multiple mutations into a single undo entry + one coalesced
   * change event. Same underlying mechanism as
   * `beginInteraction / endInteraction` (this is a friendlier wrapper
   * with try/finally safety and async support).
   *
   * The `label` is currently unused but reserved for future "labeled
   * history" UI (e.g. surfacing "AI: auto-cut silences" in an
   * undo-history panel).
   *
   * Sync:
   * ```ts
   * const result = editor.batch("swap-clips", () => {
   *   editor.moveClip({ clipId: "a", startMs: 5000 });
   *   editor.moveClip({ clipId: "b", startMs: 0 });
   *   return "done";
   * });
   * ```
   *
   * Async (for AI tool-loops that await external calls):
   * ```ts
   * await editor.batch("ai-fill-gap", async () => {
   *   const { videoUrl } = await klingApi.generate(prompt);
   *   await editor.addClip({ sourceUrl: videoUrl, trackId, startMs });
   * });
   * ```
   *
   * If `fn` throws, the interaction still commits its partial changes
   * (matching how `beginInteraction / endInteraction` behave when
   * pointerup fires after an exception) — call `editor.undo()` from
   * the catch block if that's not what you want.
   */
  batch<T>(label: string, fn: () => T): T;
  batch<T>(label: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Bookend slot at the very left of the top toolbar — host appends
   * its own controls (e.g. an aspect-ratio dropdown). Empty by default
   * and renders no separator until populated.
   */
  /**
   * Preview host element the playback engine paints into. React /
   * Vue `<Preview>` primitives teleport this into their own slots via
   * `appendChild`. Available in both mounted mode (returns the built-in
   * UI's preview host) and headless mode (returns the detached
   * `.aicut-preview-host` div created in the constructor).
   */
  readonly previewHost: HTMLElement;
  readonly toolbarLeft: HTMLElement;
  /** Right-side bookend slot — conventionally export / save / share. */
  readonly toolbarRight: HTMLElement;
  /**
   * Optional editor header above the preview. Host appends branding,
   * project name, file menu, etc. on the left and Share / Export /
   * profile / settings on the right. Layout is identical to today's
   * editor when both slots are empty — CSS collapses the bar.
   */
  readonly headerLeft: HTMLElement;
  /** Right-side header slot — conventionally Share / Export / etc. */
  readonly headerRight: HTMLElement;
  /**
   * Side panel slot, rendered only when `previewLayout === "centered"`.
   * Sits to the LEFT of the preview at 1/3 of the editor's width.
   * Conventionally a media library / asset browser. Empty when the
   * layout is `"fullWidth"` — the editor's overall grid still
   * reserves the slot but CSS collapses it.
   */
  readonly panelLeft: HTMLElement;
  /** Right side panel slot — conventionally an inspector / clip
   *  properties panel. See `panelLeft`. */
  readonly panelRight: HTMLElement;

  // events
  on<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): () => void;
  off<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): void;
  destroy(): void;
}

const DEFAULT_PX_PER_SEC = 80;
const MIN_PX_PER_SEC = SCALE_MIN;
const MAX_PX_PER_SEC = SCALE_MAX;
/** Snap distance in pixels at the current zoom. Converted to ms per call. */
const SNAP_PX = 8;

/**
 * Top-level editor instance — the only stateful object a host app
 * interacts with. Owns the project, the playback engine, the vanilla
 * DOM UI, plus viewport (zoom/snap), selection, and history state.
 *
 * Framework wrappers (`@aicut/react`, `@aicut/vue`) should mount a
 * container, instantiate this once, mirror prop changes (`theme`)
 * into it, and forward events as framework-native callbacks.
 */
export class Editor implements EditorApi {
  private container: HTMLElement | null;
  /** Only populated in headless mode — the offscreen `.aicut-preview-host`
   *  the engine paints into until a `<Preview>` primitive teleports it
   *  into the visible tree. */
  private detachedPreviewHost: HTMLElement | null = null;
  private project: Project;
  private engine: PlaybackEngine;
  private ui: EditorUI | null;
  private bus = new EventBus<EditorEventMap>();
  private history = new HistoryStack();

  private selectedClipId: string | null = null;
  private selectedKeyframe: { clipId: string; keyframeId: string } | null =
    null;
  private keyframesEnabled: boolean;
  private clipEdgeNavEnabled: boolean;
  private aspectEnabled: boolean;
  private previewFrameEnabled: boolean;
  private pictureInPictureEnabled: boolean;
  private previewLayout: PreviewLayout;
  private pictureInPictureToolbarAddEnabled: boolean;
  /** Drag-session bookkeeping for ripple-merge undo. See
   *  beginInteraction / endInteraction docs on EditorApi. */
  private interactionDepth = 0;
  private interactionStartSnapshot: string | null = null;
  /** Non-null while `batch(label, fn)` is running. Every operation
   *  event emitted inside gets this id, so effect layers can group
   *  animations (e.g. one worker performs all three ops in sequence
   *  rather than three separate workers overlapping). */
  private currentBatchId: string | null = null;
  private pxPerSec: number;
  private snap: boolean;
  private locale: Locale;
  private rulerMinTickPx: number;
  private destroyed = false;

  constructor(opts: EditorOptions | (HeadlessEditorOptions & { container?: undefined | null })) {
    this.container = opts.container ?? null;
    this.project = normalizeProject(opts.project ?? createEmptyProject());
    this.pxPerSec = clampScale(opts.initialScale ?? DEFAULT_PX_PER_SEC);
    this.snap = opts.initialSnap !== false;
    this.locale = mergeLocale(opts.locale);
    this.rulerMinTickPx = Math.max(20, Math.round(opts.rulerMinTickPx ?? 80));
    this.keyframesEnabled = opts.keyframes?.enabled === true;
    this.clipEdgeNavEnabled = opts.clipEdgeNav?.enabled === true;
    this.aspectEnabled = opts.aspect?.enabled === true;
    // Default true — the dashed frame is purely visual and harmless
    // even when keyframe editing is off; hosts who want a clean
    // preview pass `previewFrame: { enabled: false }` to opt out.
    this.previewFrameEnabled = opts.previewFrame?.enabled !== false;
    this.pictureInPictureEnabled = opts.pictureInPicture?.enabled === true;
    this.previewLayout = opts.previewLayout ?? "centered";
    this.pictureInPictureToolbarAddEnabled =
      opts.pictureInPicture?.toolbarAdd === true;

    // Must run before EditorUI builds the Timeline — those layout
    // values are read at canvas init time.
    if (opts.trackHeight != null || opts.rulerHeight != null) {
      setTimelineMetrics({
        ...(opts.trackHeight != null ? { trackHeight: opts.trackHeight } : {}),
        ...(opts.rulerHeight != null ? { rulerHeight: opts.rulerHeight } : {}),
      });
    }

    if (this.container) {
      applyTheme(this.container, opts.theme);
      if (opts.timelineHeight != null && opts.timelineHeight > 0) {
        // CSS custom property — `.aicut-timeline` reads it via var() so
        // every editor instance can have its own height even though we
        // share the class. Falls back to 240px when unset.
        this.container.style.setProperty(
          "--aicut-timeline-height",
          `${Math.round(opts.timelineHeight)}px`,
        );
      }
      this.ui = new EditorUI(this.container, this, {
        onPlayToggle: () => this.togglePlay(),
        onSplit: () => this.split(),
        onTrimLeft: () => this.trimLeft(),
        onTrimRight: () => this.trimRight(),
        onUndo: () => this.undo(),
        onRedo: () => this.redo(),
        onReset: () => this.reset(),
        onFullscreen: () => this.ui?.toggleFullscreen(),
        onSnapToggle: () => this.setSnap(!this.snap),
        onScaleChange: (s) => this.setScale(s),
        onSeek: (t) => this.seek(t),
        onSelectClip: (id) => this.setSelection(id),
        onDeleteClip: (id) => this.removeClip(id),
        onMoveClip: (id, opts) => this.moveClip(id, opts),
        onResizeClip: (id, edits) => this.resizeClip(id, edits),
        onSelectKeyframe: (target) => this.setSelectedKeyframe(target),
        onMoveKeyframe: (clipId, keyframeId, timeMs) =>
          this.moveKeyframe(clipId, keyframeId, timeMs),
        onKeyframeToggle: () => this.toggleKeyframeAtPlayhead(),
        onSeekClipStart: () => this.seekToSelectedClipEdge("start"),
        onSeekClipEnd: () => this.seekToSelectedClipEdge("end"),
        onAspectChange: (a) => this.setAspect(a),
        onPictureInPictureAdd: () =>
          this.bus.emit("requestPictureInPictureAdd", undefined),
      });
    } else {
      // Headless: no container, no built-in UI. Primitives mount their
      // own DOM and drive the engine via the editor API. Theme is
      // applied per-container by the host via `editor.applyThemeTo(el)`.
      this.ui = null;
    }

    // Engine host: use the built-in UI's preview-host when mounted, or
    // a detached div in headless. The detached div isn't attached to
    // document — canvas / <video> still render into it just fine; the
    // React `<Preview>` primitive appendChild's it into the visible
    // tree when it mounts.
    const engineHost =
      this.ui?.previewHost ??
      (this.detachedPreviewHost = this.createDetachedPreviewHost());

    const engineFactory: PlaybackEngineFactory =
      opts.playbackEngine ?? ((o) => new HtmlVideoEngine(o));
    this.engine = engineFactory({
      host: engineHost,
      project: this.project,
    });
    // Push initial PiP state to the engine. Engines that don't
    // implement the flag just ignore it.
    this.engine.setPictureInPictureEnabled?.(this.pictureInPictureEnabled);
    this.engine.onTimeUpdate = (ms) => {
      this.bus.emit("time", { timeMs: ms });
      this.ui?.onTimeTick(ms);
    };
    this.engine.onEnded = () => this.bus.emit("pause", undefined);
    this.engine.onError = (err) => this.bus.emit("error", { error: err });
    this.engine.onReady = () => this.bus.emit("ready", { sourceId: null });
    this.engine.onSourceMetadata = (sourceId, durMs) =>
      this.handleSourceMetadata(sourceId, durMs);

    if (opts.initialTime) this.engine.seek(opts.initialTime);
    this.ui?.render();
  }

  private createDetachedPreviewHost(): HTMLElement {
    // Mirrors the DOM the built-in EditorUI creates for the preview
    // slot. Kept detached from document — a React `<Preview>` primitive
    // will teleport this into the user's slot at mount time.
    const div = document.createElement("div");
    div.className = "aicut-preview-host";
    div.setAttribute("data-testid", "aicut-preview");
    div.style.position = "relative";
    div.style.width = "100%";
    div.style.height = "100%";
    return div;
  }

  /**
   * Preview host element the engine paints into. React / Vue primitives
   * grab this to teleport it into their own slots via `appendChild`.
   * In built-in mode this is the EditorUI's preview-host div; in
   * headless mode it's the detached div created at construction.
   */
  get previewHost(): HTMLElement {
    return this.ui?.previewHost ?? this.detachedPreviewHost!;
  }

  /**
   * Apply the editor's theme tokens to any host container. Primitives
   * use this on their root divs so custom compositions inherit the
   * same CSS variable set as the built-in shell.
   */
  applyThemeTo(el: HTMLElement, theme?: Theme): void {
    applyTheme(el, theme);
  }

  /**
   * Headless entry point — creates an Editor with state + engine but
   * no built-in DOM. React `<EditorProvider>` and Vue `useAicutEditor`
   * use this so hosts can compose their own layout out of the exposed
   * primitives (`<Preview>`, `<Timeline>`, `<PlayButton>`, …).
   */
  static createHeadless(opts: HeadlessEditorOptions = {}): Editor {
    // Cast: the constructor accepts an optional container — passing
    // `container: undefined` triggers the headless branch.
    return new Editor(opts as HeadlessEditorOptions & { container?: undefined });
  }

  static create(opts: EditorOptions): Editor {
    return new Editor(opts);
  }

  get toolbarLeft(): HTMLElement {
    return this.requireUi("toolbarLeft").toolbarLeft;
  }

  get toolbarRight(): HTMLElement {
    return this.requireUi("toolbarRight").toolbarRight;
  }

  get headerLeft(): HTMLElement {
    return this.requireUi("headerLeft").headerLeft;
  }

  get headerRight(): HTMLElement {
    return this.requireUi("headerRight").headerRight;
  }

  get panelLeft(): HTMLElement {
    return this.requireUi("panelLeft").panelLeft;
  }

  get panelRight(): HTMLElement {
    return this.requireUi("panelRight").panelRight;
  }

  /** Slot-getter guard — the built-in slots only exist when EditorUI
   *  was mounted. Headless callers should compose their own layout via
   *  primitives instead of reaching for these DOM handles. */
  private requireUi(slot: string): EditorUI {
    if (!this.ui) {
      throw new Error(
        `Editor.${slot} is only available in mounted mode. Use React / Vue primitives (<Preview>, <Timeline>, buttons) to compose a headless editor instead.`,
      );
    }
    return this.ui;
  }

  // ---- playback -------------------------------------------------------

  play(): void {
    this.engine.play();
    this.bus.emit("play", undefined);
    this.ui?.render();
  }

  pause(): void {
    this.engine.pause();
    this.bus.emit("pause", undefined);
    this.ui?.render();
  }

  togglePlay(): void {
    if (this.engine.isPlaying()) this.pause();
    else this.play();
  }

  seek(timeMs: Ms): void {
    this.engine.seek(timeMs);
    this.ui?.render();
  }

  getTime(): Ms {
    // Engine may not exist yet during UI construction (we build UI
    // first to get its previewHost). Treat as 0 in that case.
    return this.engine?.getTime() ?? 0;
  }

  getDuration(): Ms {
    return projectDuration(this.project);
  }

  isPlaying(): boolean {
    return this.engine?.isPlaying() ?? false;
  }

  /**
   * In-tab "fullscreen" — covers the browser viewport via fixed
   * positioning, NOT the OS Fullscreen API. This is what the reference
   * UI calls "全屏预览": the user stays in their tab, no browser
   * permission prompt, ESC exits. Browser fullscreen would also work
   * but is heavier UX and gets blocked in iframes.
   */
  async enterFullscreen(): Promise<void> {
    this.ui?.setFullscreen(true);
  }

  async exitFullscreen(): Promise<void> {
    this.ui?.setFullscreen(false);
  }

  isFullscreen(): boolean {
    return this.ui?.isFullscreen() ?? false;
  }

  // ---- editing --------------------------------------------------------

  /**
   * Split the clip at `timeMs` (or playhead). Returns the two new clip ids
   * or null if there's no clip to split at that time.
   */
  split(timeMs?: Ms): string[] | null {
    const t = timeMs ?? this.engine.getTime();
    // Pick the track of the currently selected clip, else the first
    // video track that has a clip at this time.
    let target: { track: Track; clip: Clip } | null = null;
    if (this.selectedClipId) {
      const trk = findTrackOfClip(this.project, this.selectedClipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedClipId) ?? null;
      if (trk && cl && t > cl.start && t < clipEnd(cl)) target = { track: trk, clip: cl };
    }
    if (!target) {
      for (const trk of this.project.tracks) {
        const cl = findClipContaining(trk, t);
        if (cl && t > cl.start && t < clipEnd(cl)) {
          target = { track: trk, clip: cl };
          break;
        }
      }
    }
    if (!target) return null;
    const split = splitClipAt(target.clip, t - target.clip.start);
    if (!split) return null;
    this.pushHistory();
    const [left, right] = split;
    target.track.clips = target.track.clips
      .filter((c) => c.id !== target!.clip.id)
      .concat(left, right)
      .sort((a, b) => a.start - b.start);
    this.afterMutation();
    return [left.id, right.id];
  }

  cut(timeMs?: Ms): string[] | null {
    return this.split(timeMs);
  }

  trimLeft(timeMs?: Ms): boolean {
    const t = timeMs ?? this.engine.getTime();
    const target = this.resolveTrimTarget(t);
    if (!target) return false;
    const { clip } = target;
    const delta = t - clip.start;
    if (delta <= 0 || delta >= clipDuration(clip)) return false;
    this.pushHistory();
    const oldStart = clip.start;
    clip.in += delta;
    clip.start += delta;

    // Ripple-close the gap [oldStart, oldStart + delta] when it isn't
    // covered by any clip on any other track. The user's mental model:
    // "trim away the lead-in and tighten the timeline" — but only if
    // we're not stranding material on a parallel track that was lining
    // up with the trimmed region.
    const gapStart = oldStart;
    const gapEnd = clip.start;
    let covered = false;
    outer: for (const trk of this.project.tracks) {
      for (const c of trk.clips) {
        if (c.id === clip.id) continue;
        const cEnd = c.start + clipDuration(c);
        if (c.start < gapEnd && cEnd > gapStart) {
          covered = true;
          break outer;
        }
      }
    }
    if (!covered) {
      clip.start = gapStart;
      for (const trk of this.project.tracks) {
        for (const c of trk.clips) {
          if (c.id === clip.id) continue;
          if (c.start >= gapEnd) c.start -= delta;
        }
        trk.clips.sort((a, b) => a.start - b.start);
      }
    }

    this.afterMutation();
    return true;
  }

  trimRight(timeMs?: Ms): boolean {
    const t = timeMs ?? this.engine.getTime();
    const target = this.resolveTrimTarget(t);
    if (!target) return false;
    const { clip } = target;
    const delta = clipEnd(clip) - t;
    if (delta <= 0 || delta >= clipDuration(clip)) return false;
    this.pushHistory();
    clip.out -= delta;
    this.afterMutation();
    return true;
  }

  removeClip(clipId: string): boolean {
    let removed = false;
    const before = JSON.stringify(this.project);
    for (const t of this.project.tracks) {
      const len = t.clips.length;
      t.clips = t.clips.filter((c) => c.id !== clipId);
      if (t.clips.length !== len) removed = true;
    }
    if (!removed) return false;
    // Restore previous state in `history` keyed off the pre-mutation
    // snapshot for accurate undo.
    this.history.push(JSON.parse(before) as Project);
    if (this.selectedClipId === clipId) {
      this.selectedClipId = null;
      this.bus.emit("selectionChange", { clipId: null });
    }
    this.afterMutation();
    return true;
  }

  setClipSpeed(clipId: string, speed: number): boolean {
    if (!Number.isFinite(speed) || speed <= 0) return false;
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    this.pushHistory();
    cl.speed = speed === 1 ? undefined : speed;
    this.afterMutation();
    return true;
  }

  // ── AI-facing methods (option-object + EditResult) ───────────────

  splitClip(args: {
    clipId: string;
    timeMs: Ms;
  }): EditResult<{ newClipIds: [string, string] }> {
    const before = JSON.stringify(this.project);
    const result = this.splitClipInternal(args);
    this.emitOperation("splitClip", args, result, before);
    return result;
  }
  private splitClipInternal(args: {
    clipId: string;
    timeMs: Ms;
  }): EditResult<{ newClipIds: [string, string] }> {
    if (!Number.isFinite(args.timeMs) || args.timeMs < 0) {
      return { ok: false, reason: "invalid-time" };
    }
    const trk = findTrackOfClip(this.project, args.clipId);
    const cl = trk?.clips.find((c) => c.id === args.clipId);
    if (!trk || !cl) return { ok: false, reason: "clip-not-found" };
    if (args.timeMs <= cl.start || args.timeMs >= clipEnd(cl)) {
      return {
        ok: false,
        reason: "time-outside-clip",
        hint: `Clip range is [${cl.start}, ${clipEnd(cl)}); need strictly interior time.`,
      };
    }
    const split = splitClipAt(cl, args.timeMs - cl.start);
    if (!split) return { ok: false, reason: "invalid-range" };
    this.pushHistory();
    const [left, right] = split;
    trk.clips = trk.clips
      .filter((c) => c.id !== args.clipId)
      .concat(left, right)
      .sort((a, b) => a.start - b.start);
    this.afterMutation();
    return { ok: true, data: { newClipIds: [left.id, right.id] } };
  }

  moveClipTo(args: {
    clipId: string;
    toTrackId?: string;
    startMs?: Ms;
    onOverlap?: "error" | "auto";
  }): EditResult<{ clipId: string; trackId: string; startMs: Ms }> {
    const before = JSON.stringify(this.project);
    const result = this.moveClipToInternal(args);
    this.emitOperation("moveClipTo", args, result, before);
    return result;
  }
  private moveClipToInternal(args: {
    clipId: string;
    toTrackId?: string;
    startMs?: Ms;
    onOverlap?: "error" | "auto";
  }): EditResult<{ clipId: string; trackId: string; startMs: Ms }> {
    const fromTrack = findTrackOfClip(this.project, args.clipId);
    const clip = fromTrack?.clips.find((c) => c.id === args.clipId);
    if (!fromTrack || !clip) return { ok: false, reason: "clip-not-found" };

    const nextStart =
      args.startMs != null ? Math.max(0, args.startMs) : clip.start;
    if (!Number.isFinite(nextStart)) {
      return { ok: false, reason: "invalid-time" };
    }
    const dur = clipDuration(clip);
    const nextEnd = nextStart + dur;

    const targetTrack = args.toTrackId
      ? this.project.tracks.find((t) => t.id === args.toTrackId)
      : fromTrack;
    if (!targetTrack) return { ok: false, reason: "track-not-found" };

    // Overlap = any OTHER clip on target track whose interval intersects
    // [nextStart, nextEnd).
    const conflict = targetTrack.clips.find((c) => {
      if (c.id === args.clipId) return false;
      const cEnd = clipEnd(c);
      return !(nextEnd <= c.start || nextStart >= cEnd);
    });

    const onOverlap = args.onOverlap ?? "error";
    if (conflict && onOverlap === "error") {
      return {
        ok: false,
        reason: "overlap",
        hint: `Destination [${nextStart}, ${nextEnd}) on track ${targetTrack.id} overlaps clip ${conflict.id}. Pass onOverlap: "auto" to fall back to another track.`,
      };
    }

    if (conflict && onOverlap === "auto") {
      // Delegate to legacy smart-routing — it lands the clip wherever
      // there's room. Then report where it actually ended up.
      const ok = this.moveClip(args.clipId, {
        start: nextStart,
        ...(args.toTrackId ? { trackId: args.toTrackId } : {}),
      });
      if (!ok) return { ok: false, reason: "internal-error" };
      const landedTrack = findTrackOfClip(this.project, args.clipId);
      const landedClip = landedTrack?.clips.find((c) => c.id === args.clipId);
      if (!landedTrack || !landedClip) {
        return { ok: false, reason: "internal-error" };
      }
      return {
        ok: true,
        data: {
          clipId: args.clipId,
          trackId: landedTrack.id,
          startMs: landedClip.start,
        },
      };
    }

    // No conflict — commit the exact placement.
    this.pushHistory();
    clip.start = nextStart;
    if (targetTrack.id !== fromTrack.id) {
      fromTrack.clips = fromTrack.clips.filter((c) => c.id !== args.clipId);
      targetTrack.clips.push(clip);
    }
    targetTrack.clips.sort((a, b) => a.start - b.start);
    this.afterMutation();
    return {
      ok: true,
      data: { clipId: args.clipId, trackId: targetTrack.id, startMs: nextStart },
    };
  }

  trimClip(args: {
    clipId: string;
    edge: "left" | "right";
    timeMs: Ms;
  }): EditResult<{ clipId: string }> {
    const before = JSON.stringify(this.project);
    const result = this.trimClipInternal(args);
    this.emitOperation("trimClip", args, result, before);
    return result;
  }
  private trimClipInternal(args: {
    clipId: string;
    edge: "left" | "right";
    timeMs: Ms;
  }): EditResult<{ clipId: string }> {
    if (!Number.isFinite(args.timeMs) || args.timeMs < 0) {
      return { ok: false, reason: "invalid-time" };
    }
    const trk = findTrackOfClip(this.project, args.clipId);
    const cl = trk?.clips.find((c) => c.id === args.clipId);
    if (!trk || !cl) return { ok: false, reason: "clip-not-found" };

    if (args.edge === "left") {
      const delta = args.timeMs - cl.start;
      if (delta <= 0 || delta >= clipDuration(cl)) {
        return {
          ok: false,
          reason: "time-outside-clip",
          hint: `Trim-left needs time strictly inside (${cl.start}, ${clipEnd(cl)}).`,
        };
      }
      this.pushHistory();
      cl.in += delta;
      cl.start += delta;
      this.afterMutation();
      return { ok: true, data: { clipId: args.clipId } };
    }

    // right edge
    const delta = clipEnd(cl) - args.timeMs;
    if (delta <= 0 || delta >= clipDuration(cl)) {
      return {
        ok: false,
        reason: "time-outside-clip",
        hint: `Trim-right needs time strictly inside (${cl.start}, ${clipEnd(cl)}).`,
      };
    }
    this.pushHistory();
    cl.out -= delta;
    this.afterMutation();
    return { ok: true, data: { clipId: args.clipId } };
  }

  deleteClip(args: { clipId: string }): EditResult<{ clipId: string }> {
    const before = JSON.stringify(this.project);
    const result = this.deleteClipInternal(args);
    this.emitOperation("deleteClip", args, result, before);
    return result;
  }
  private deleteClipInternal(args: {
    clipId: string;
  }): EditResult<{ clipId: string }> {
    const trk = findTrackOfClip(this.project, args.clipId);
    if (!trk) return { ok: false, reason: "clip-not-found" };
    const ok = this.removeClip(args.clipId);
    if (!ok) return { ok: false, reason: "internal-error" };
    return { ok: true, data: { clipId: args.clipId } };
  }

  async addClip(args: {
    sourceUrl?: string;
    sourceId?: string;
    trackId: string;
    startMs: Ms;
    inMs?: Ms;
    outMs?: Ms;
    onOverlap?: "error" | "auto";
    meta?: Record<string, unknown>;
  }): Promise<EditResult<{ clipId: string; sourceId: string }>> {
    const before = JSON.stringify(this.project);
    const result = await this.addClipInternal(args);
    this.emitOperation("addClip", args, result, before);
    return result;
  }
  private async addClipInternal(args: {
    sourceUrl?: string;
    sourceId?: string;
    trackId: string;
    startMs: Ms;
    inMs?: Ms;
    outMs?: Ms;
    onOverlap?: "error" | "auto";
    meta?: Record<string, unknown>;
  }): Promise<EditResult<{ clipId: string; sourceId: string }>> {
    // `meta` reserved for forward-compat — dropped in MVP.
    void args.meta;

    if (!args.sourceUrl && !args.sourceId) {
      return {
        ok: false,
        reason: "invalid-range",
        hint: "Pass either sourceUrl (to load) or sourceId (to reuse).",
      };
    }
    if (!Number.isFinite(args.startMs) || args.startMs < 0) {
      return { ok: false, reason: "invalid-time" };
    }

    const target = this.project.tracks.find((t) => t.id === args.trackId);
    if (!target) return { ok: false, reason: "track-not-found" };

    // Resolve source — reuse existing or load fresh.
    let source: MediaSource | null = null;
    let sourceCreated = false;
    if (args.sourceId) {
      source =
        this.project.sources.find((s) => s.id === args.sourceId) ?? null;
      if (!source) return { ok: false, reason: "source-not-found" };
    } else if (args.sourceUrl) {
      let probed: { durationMs: number; width: number; height: number };
      try {
        probed = await probeMediaSource(args.sourceUrl);
      } catch (e) {
        return {
          ok: false,
          reason: "source-load-failed",
          hint: e instanceof Error ? e.message : String(e),
        };
      }
      source = {
        id: createId("src"),
        url: args.sourceUrl,
        kind: "video",
        name: args.sourceUrl.split("/").pop() ?? "media",
        duration: probed.durationMs,
      };
      sourceCreated = true;
    }
    if (!source) return { ok: false, reason: "internal-error" };

    const inMs = args.inMs ?? 0;
    const outMs = args.outMs ?? source.duration ?? 0;
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || inMs < 0 || outMs <= inMs) {
      return {
        ok: false,
        reason: "invalid-range",
        hint: `inMs (${inMs}) must be >= 0 and < outMs (${outMs}).`,
      };
    }

    const clipDur = outMs - inMs;
    const clipStart = args.startMs;
    const clipEndT = clipStart + clipDur;

    // Overlap check on the destination track.
    const conflict = target.clips.find((c) => {
      const cEnd = clipEnd(c);
      return !(clipEndT <= c.start || clipStart >= cEnd);
    });

    const onOverlap = args.onOverlap ?? "error";
    if (conflict && onOverlap === "error") {
      return {
        ok: false,
        reason: "overlap",
        hint: `Insertion at [${clipStart}, ${clipEndT}) overlaps clip ${conflict.id}. Pass onOverlap: "auto" to append after existing clips.`,
      };
    }

    // Fall-back placement for "auto" — append after the last conflicting
    // clip on the same track. Simple predictable rule; smart routing
    // across tracks is intentionally NOT applied here (moveClipTo is
    // where that lives).
    let finalStart = clipStart;
    if (conflict && onOverlap === "auto") {
      const trailingEnd = target.clips.reduce(
        (acc, c) => Math.max(acc, clipEnd(c)),
        0,
      );
      finalStart = trailingEnd;
    }

    this.pushHistory();
    if (sourceCreated) this.project.sources.push(source);
    const clipId = createId("clip");
    target.clips.push({
      id: clipId,
      sourceId: source.id,
      in: inMs,
      out: outMs,
      start: finalStart,
    });
    target.clips.sort((a, b) => a.start - b.start);
    this.afterMutation();

    return {
      ok: true,
      data: { clipId, sourceId: source.id },
    };
  }

  async captureFrame(args: {
    timeMs: Ms;
    source?: "composite" | "raw";
    clipId?: string;
    format?: "image/jpeg" | "image/png";
    quality?: number;
    maxWidth?: number;
  }): Promise<EditResult<{ blob: Blob; width: number; height: number }>> {
    if (!Number.isFinite(args.timeMs) || args.timeMs < 0) {
      return { ok: false, reason: "invalid-time" };
    }
    const format = args.format ?? "image/jpeg";
    const quality = args.quality ?? 0.85;
    const mode = args.source ?? "composite";

    if (mode === "raw") {
      if (!args.clipId) {
        return {
          ok: false,
          reason: "invalid-range",
          hint: "raw mode requires clipId to know which source to read.",
        };
      }
      const trk = findTrackOfClip(this.project, args.clipId);
      const cl = trk?.clips.find((c) => c.id === args.clipId);
      if (!trk || !cl) return { ok: false, reason: "clip-not-found" };
      const src = this.project.sources.find((s) => s.id === cl.sourceId);
      if (!src) return { ok: false, reason: "source-not-found" };
      const sourceMs = timelineToSourceMs(cl, args.timeMs);
      try {
        const out = await captureRawFrame(
          src.url,
          sourceMs,
          args.maxWidth,
          format,
          quality,
        );
        return { ok: true, data: out };
      } catch (e) {
        return {
          ok: false,
          reason: "source-load-failed",
          hint: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // composite
    const host = this.detachedPreviewHost ?? this.ui?.previewHost;
    const canvas = host?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      return {
        ok: false,
        reason: "internal-error",
        hint: "No compositor canvas — composite mode needs CanvasCompositorEngine or WebCodecsEngine. Fall back to source: 'raw'.",
      };
    }
    // Seek then wait 2 rAFs so the engine has a chance to paint the
    // new frame. Falls back to setTimeout in non-DOM harnesses so this
    // still resolves.
    this.engine.seek(args.timeMs);
    await new Promise<void>((r) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } else {
        setTimeout(r, 16);
      }
    });
    try {
      const out = await encodeCanvas(canvas, args.maxWidth, format, quality);
      return { ok: true, data: out };
    } catch (e) {
      return {
        ok: false,
        reason: "internal-error",
        hint: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ---- tracks ---------------------------------------------------------

  addTrack(kind: Track["kind"]): Track {
    this.pushHistory();
    const t: Track = { id: createId("track"), kind, clips: [] };
    this.project.tracks.push(t);
    this.afterMutation();
    return t;
  }

  removeTrack(trackId: string): boolean {
    const idx = this.project.tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return false;
    this.pushHistory();
    this.project.tracks.splice(idx, 1);
    this.afterMutation();
    return true;
  }

  /**
   * Pure prediction of where a `moveClip(...)` would land — same smart
   * routing as the real move (intended → source → other → new track),
   * just no mutation, no history. Lets the Timeline preview the
   * ACTUAL outcome of a drop so the ghost stops lying about new
   * tracks that won't get created.
   */
  previewMoveTarget(
    clipId: string,
    start: Ms,
    intendedTrackId?: string,
  ): { trackIndex: number; trackId: string; wouldCreateNew: boolean } | null {
    const fromTrack = findTrackOfClip(this.project, clipId);
    const clip = fromTrack?.clips.find((c) => c.id === clipId);
    if (!fromTrack || !clip) return null;
    const nextStart = Math.max(0, start);
    const nextEnd = nextStart + clipDuration(clip);
    const intended = intendedTrackId
      ? this.project.tracks.find((t) => t.id === intendedTrackId)
      : fromTrack;
    const candidates: Track[] = [];
    const seen = new Set<string>();
    const push = (t: Track | undefined) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      candidates.push(t);
    };
    push(intended);
    push(fromTrack);
    for (const t of this.project.tracks) {
      if (t.kind === fromTrack.kind) push(t);
    }
    for (const c of candidates) {
      if (!wouldOverlap(c, clipId, nextStart, nextEnd)) {
        const idx = this.project.tracks.indexOf(c);
        return { trackIndex: idx, trackId: c.id, wouldCreateNew: false };
      }
    }
    // No fit → preview a brand-new track appended at the end.
    return {
      trackIndex: this.project.tracks.length,
      trackId: "",
      wouldCreateNew: true,
    };
  }

  moveClip(
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ): boolean {
    const fromTrack = findTrackOfClip(this.project, clipId);
    const clip = fromTrack?.clips.find((c) => c.id === clipId);
    if (!fromTrack || !clip) return false;
    const nextStart = Math.max(0, opts.start ?? clip.start);
    const nextEnd = nextStart + clipDuration(clip);

    // Explicit "new track" intent from the UI's phantom-row drop —
    // bypass smart routing entirely, append a fresh track, move there.
    if (opts.newTrack) {
      this.pushHistory();
      const created = this.appendTrack({ kind: fromTrack.kind });
      clip.start = nextStart;
      fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
      created.clips.push(clip);
      if (
        fromTrack.clips.length === 0 &&
        this.project.tracks.filter((t) => t.kind === fromTrack.kind).length > 1
      ) {
        this.project.tracks = this.project.tracks.filter(
          (t) => t.id !== fromTrack.id,
        );
      }
      this.afterMutation();
      return true;
    }

    const intended = opts.trackId
      ? this.project.tracks.find((t) => t.id === opts.trackId)
      : fromTrack;
    if (!intended) return false;

    this.pushHistory();

    // Smart routing — prefer in priority:
    //   1. intended track (user's hover target)
    //   2. the source track (because vacating it for a brand-new track
    //      would be wasteful when there's room on the original row)
    //   3. any other existing track of the same kind
    //   4. as a last resort, a freshly-appended track
    //
    // `wouldOverlap` excludes the dragged clip itself, so the source
    // track always has room for it back where it started (the user
    // can effectively cancel a cross-track drag by hovering somewhere
    // crowded — we drop back onto source).
    const candidates: Track[] = [];
    const seen = new Set<string>();
    const push = (t: Track | undefined) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      candidates.push(t);
    };
    push(intended);
    push(fromTrack);
    for (const t of this.project.tracks) {
      if (t.kind === fromTrack.kind) push(t);
    }

    let targetTrack: Track | null = null;
    for (const c of candidates) {
      if (!wouldOverlap(c, clipId, nextStart, nextEnd)) {
        targetTrack = c;
        break;
      }
    }
    if (!targetTrack) {
      targetTrack = this.appendTrack({ kind: fromTrack.kind });
    }

    // Apply the move.
    clip.start = nextStart;
    if (targetTrack !== fromTrack) {
      fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
      targetTrack.clips.push(clip);
    }
    targetTrack.clips.sort((a, b) => a.start - b.start);

    // Auto-prune: if the source track is now empty AND it isn't the
    // only track of its kind, drop it. Keeps the UI compact when the
    // user is shuffling clips around — without this the track count
    // monotonically grows.
    if (
      fromTrack !== targetTrack &&
      fromTrack.clips.length === 0 &&
      this.project.tracks.filter((t) => t.kind === fromTrack.kind).length > 1
    ) {
      this.project.tracks = this.project.tracks.filter(
        (t) => t.id !== fromTrack.id,
      );
    }

    this.afterMutation();
    return true;
  }

  resizeClip(
    clipId: string,
    edits: Partial<Pick<Clip, "in" | "out" | "start">>,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const next: Clip = { ...cl, ...edits };
    if (next.out <= next.in) return false;
    if (next.start < 0) return false;
    this.pushHistory();
    Object.assign(cl, next);
    trk.clips.sort((a, b) => a.start - b.start);
    this.afterMutation();
    return true;
  }

  addSource(
    source: MediaSource,
    opts: { appendClip?: boolean } = {},
  ): MediaSource {
    const src: MediaSource = { ...source, id: source.id || createId("src") };
    this.pushHistory();
    this.project.sources.push(src);
    const append = opts.appendClip !== false;
    if (append && src.kind === "video") {
      const track =
        this.project.tracks.find((t) => t.kind === "video") ??
        this.appendTrack({ kind: "video" });
      const start = trackEnd(track);
      track.clips.push({
        id: createId("clip"),
        sourceId: src.id,
        in: 0,
        out: src.duration ?? 0,
        start,
      });
    }
    this.afterMutation();
    return src;
  }

  // ---- project --------------------------------------------------------

  setProject(project: Project): void {
    this.pushHistory();
    this.project = normalizeProject(project);
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    // Re-fit on project swap — the new project's duration is likely
    // different so the previous scale is meaningless.
    this.ui?.resetAutoFit();
    this.ui?.setAspect(this.getAspect());
    this.ui?.render();
  }

  getProject(): Project {
    return JSON.parse(JSON.stringify(this.project)) as Project;
  }

  /**
   * Restore the "fresh import" state: same media library, single
   * default video track, one full-length clip per video source laid
   * end-to-end. This mirrors the initial layout a host would get
   * after dropping their videos in, so "reset" feels like "start
   * over without re-importing" rather than "wipe everything".
   *
   * Goes through the regular history stack — ⌘Z brings the previous
   * edit back. Sources without a known duration are skipped (they'd
   * render as zero-width clips, which is worse than absent).
   */
  reset(): void {
    const sources = this.project.sources.map((s) => ({ ...s }));
    const trackId = createId("track");
    const clips: Clip[] = [];
    let start = 0;
    for (const src of sources) {
      if (src.kind !== "video") continue;
      const dur = src.duration;
      if (!dur || dur <= 0) continue;
      clips.push({
        id: createId("clip"),
        sourceId: src.id,
        in: 0,
        out: dur,
        start,
      });
      start += dur;
    }
    this.setProject({
      version: 1,
      sources,
      tracks: [{ id: trackId, kind: "video", clips }],
    });
  }

  setTheme(theme: Theme): void {
    if (this.container) applyTheme(this.container, theme);
    // The timeline canvas reads CSS vars at paint time and bakes them
    // into pixels — it has no way to know the vars just changed.
    // Without this re-render, the chrome (toolbar/headers) flips
    // immediately via CSS but the canvas keeps its last colours until
    // the next interaction (wheel, click, etc.). Force a repaint now.
    this.ui?.render();
    // Fanout to headless subscribers (e.g. the standalone
    // `<TimelinePrimitive>` spun up under `<EditorProvider>`) — they
    // need the signal because there's no built-in UI to call
    // `timeline.setTheme` for them.
    this.bus.emit("themeChange", { theme });
  }

  setLocale(locale: Partial<Locale>): void {
    this.locale = mergeLocale(locale);
    this.ui?.setLocale(this.locale);
    this.bus.emit("localeChange", { locale: this.locale });
  }

  /** Internal — UI reads the resolved locale here on each render. */
  getLocale(): Locale {
    return this.locale;
  }

  requestExport(): void {
    this.bus.emit("export", { project: this.getProject() });
  }

  // ---- viewport -------------------------------------------------------

  getScale(): number {
    return this.pxPerSec;
  }

  setScale(pxPerSec: number): void {
    const next = clampScale(pxPerSec);
    if (next === this.pxPerSec) return;
    this.pxPerSec = next;
    this.bus.emit("scaleChange", { pxPerSec: next });
    this.ui?.render();
  }

  getSnap(): boolean {
    return this.snap;
  }

  setSnap(snap: boolean): void {
    if (snap === this.snap) return;
    this.snap = snap;
    this.bus.emit("snapChange", { snap });
    this.ui?.render();
  }

  getRulerMinTickPx(): number {
    return this.rulerMinTickPx;
  }

  setRulerMinTickPx(px: number): void {
    const next = Math.max(20, Math.round(px));
    if (next === this.rulerMinTickPx) return;
    this.rulerMinTickPx = next;
    this.ui?.setRulerMinTickPx(next);
  }

  /** Snap a candidate ms to the nearest snappable surface within SNAP_PX. */
  snapMs(timeMs: Ms, ignoreClipId?: string | null): Ms {
    if (!this.snap) return timeMs;
    const snapTol = Math.max(20, (SNAP_PX / this.pxPerSec) * 1000);
    const targets: Ms[] = [0, this.engine.getTime()];
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.id === ignoreClipId) continue;
        targets.push(c.start, clipEnd(c));
        if (c.keyframes) {
          for (const kf of c.keyframes) targets.push(c.start + kf.time);
        }
      }
    }
    let best: Ms = timeMs;
    let bestDist = snapTol;
    for (const t of targets) {
      const d = Math.abs(t - timeMs);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  // ---- selection ------------------------------------------------------

  getSelection(): string | null {
    return this.selectedClipId;
  }

  setSelection(clipId: string | null): void {
    if (clipId === this.selectedClipId) return;
    this.selectedClipId = clipId;
    this.bus.emit("selectionChange", { clipId });
    // Clearing the clip selection or moving to a different clip
    // clears any orphan keyframe selection — selecting a keyframe
    // outside the current clip would be confusing UX.
    if (
      this.selectedKeyframe &&
      this.selectedKeyframe.clipId !== clipId
    ) {
      this.selectedKeyframe = null;
      this.bus.emit("keyframeSelectionChange", { target: null });
    }
    this.ui?.render();
  }

  // ---- keyframes ------------------------------------------------------

  isKeyframesEnabled(): boolean {
    return this.keyframesEnabled;
  }

  /**
   * Screen-space CSS-pixel rect of the actively painted frame
   * (post-transform), relative to the editor's preview element.
   * Null when no clip is active, the engine doesn't expose
   * `getFrameRect`, or the rect isn't computed yet. Used by the
   * library's keyframe-editing overlay.
   *
   * When PiP is on and a non-primary clip is selected, returns
   * THAT clip's rect — that's how the overlay's dashed border +
   * corner handles latch onto a picture-in-picture overlay. With
   * PiP off (or nothing selected) falls back to the primary clip.
   */
  getActiveFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null {
    const selected = this.pictureInPictureEnabled
      ? (this.selectedClipId ?? undefined)
      : undefined;
    return this.engine.getFrameRect?.(selected) ?? null;
  }

  getClipFrameRect(
    clipId: string,
  ): { x: number; y: number; w: number; h: number } | null {
    return this.engine.getFrameRect?.(clipId) ?? null;
  }

  /**
   * Screen-space CSS-pixel rect of the OUTPUT FRAME (the fixed
   * stage that clips the rendered video). Different from
   * `getActiveFrameRect` which includes the keyframe transform —
   * this one stays put as the user drags / scales the content.
   * Used by the overlay to anchor the dashed border + drag body.
   */
  getActiveOutputFrameRect():
    | { x: number; y: number; w: number; h: number }
    | null {
    const selected = this.pictureInPictureEnabled
      ? (this.selectedClipId ?? undefined)
      : undefined;
    return this.engine.getOutputFrameRect?.(selected) ?? null;
  }

  setKeyframesEnabled(enabled: boolean): void {
    if (enabled === this.keyframesEnabled) return;
    this.keyframesEnabled = enabled;
    // Disabling clears any active keyframe selection (the UI for it
    // is about to disappear).
    if (!enabled && this.selectedKeyframe) {
      this.selectedKeyframe = null;
      this.bus.emit("keyframeSelectionChange", { target: null });
    }
    this.bus.emit("keyframesEnabledChange", { enabled });
    this.ui?.render();
  }

  isClipEdgeNavEnabled(): boolean {
    return this.clipEdgeNavEnabled;
  }

  setClipEdgeNavEnabled(enabled: boolean): void {
    if (enabled === this.clipEdgeNavEnabled) return;
    this.clipEdgeNavEnabled = enabled;
    this.bus.emit("clipEdgeNavEnabledChange", { enabled });
    this.ui?.render();
  }

  isPreviewFrameEnabled(): boolean {
    return this.previewFrameEnabled;
  }

  setPreviewFrameEnabled(enabled: boolean): void {
    if (enabled === this.previewFrameEnabled) return;
    this.previewFrameEnabled = enabled;
    this.bus.emit("previewFrameEnabledChange", { enabled });
    this.ui?.render();
  }

  isPictureInPictureEnabled(): boolean {
    return this.pictureInPictureEnabled;
  }

  /** Whether the built-in "+ PiP overlay" toolbar button is rendered. */
  isPictureInPictureToolbarAddEnabled(): boolean {
    return this.pictureInPictureToolbarAddEnabled;
  }

  setPictureInPictureEnabled(enabled: boolean): void {
    if (enabled === this.pictureInPictureEnabled) return;
    this.pictureInPictureEnabled = enabled;
    // Push to the engine — engines that implement it re-composite on
    // the next paint tick. Engines that don't ignore the call.
    this.engine.setPictureInPictureEnabled?.(enabled);
    this.bus.emit("pictureInPictureEnabledChange", { enabled });
    this.ui?.render();
  }

  getPreviewLayout(): PreviewLayout {
    return this.previewLayout;
  }

  setPreviewLayout(layout: PreviewLayout): void {
    if (layout === this.previewLayout) return;
    this.previewLayout = layout;
    this.ui?.setPreviewLayout(layout);
    this.bus.emit("previewLayoutChange", { layout });
    this.ui?.render();
  }

  isAspectEnabled(): boolean {
    return this.aspectEnabled;
  }

  setAspectEnabled(enabled: boolean): void {
    if (enabled === this.aspectEnabled) return;
    this.aspectEnabled = enabled;
    this.bus.emit("aspectEnabledChange", { enabled });
    this.ui?.render();
  }

  getAspect(): AspectRatio | null {
    return this.project.aspect ?? null;
  }

  setAspect(aspect: AspectRatio | null): void {
    const current = this.project.aspect ?? null;
    if (aspect === current) return;
    this.pushHistory();
    if (aspect == null) {
      delete this.project.aspect;
    } else {
      this.project.aspect = aspect;
      // Mirror the chosen aspect into the authoritative `output`
      // dims — picking 9:16 should immediately give the canvas a
      // 9:16 reference frame in EVERY consumer (preview, overlay,
      // backend export), without each having to derive the size
      // from the aspect string separately.
      const dims = defaultOutputForAspect(aspect);
      const prevFps = this.project.output?.fps;
      this.project.output = {
        width: dims.width,
        height: dims.height,
        ...(prevFps != null ? { fps: prevFps } : {}),
      };
    }
    this.afterMutation();
    this.ui?.setAspect(aspect);
    this.bus.emit("aspectChange", { aspect });
  }

  getOutput(): { width: number; height: number; fps?: number } {
    const out = this.project.output;
    if (out) {
      return out.fps != null
        ? { width: out.width, height: out.height, fps: out.fps }
        : { width: out.width, height: out.height };
    }
    // No `output` field yet — derive a reasonable canvas size for
    // hosts that need to query before the user picks anything. Order
    // mirrors normalizeProject: aspect → first-clip source dims →
    // 1080p fallback.
    if (this.project.aspect) {
      const dims = defaultOutputForAspect(this.project.aspect);
      return { width: dims.width, height: dims.height };
    }
    const ref = this.engine.getCanvasReferenceDims?.();
    if (ref) return { width: ref[0], height: ref[1] };
    return { width: 1920, height: 1080 };
  }

  setOutput(output: { width: number; height: number; fps?: number }): void {
    const w = evenPx(output.width);
    const h = evenPx(output.height);
    if (w <= 0 || h <= 0) return;
    const current = this.project.output;
    if (
      current &&
      current.width === w &&
      current.height === h &&
      (current.fps ?? null) === (output.fps ?? null)
    ) {
      return;
    }
    this.pushHistory();
    this.project.output = {
      width: w,
      height: h,
      ...(output.fps != null && output.fps > 0 ? { fps: output.fps } : {}),
    };
    this.afterMutation();
    this.ui?.render();
  }

  addKeyframe(
    clipId: string,
    prop: KeyframeProp,
    opts: { time?: Ms; value?: number } = {},
  ): string | null {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return null;
    const duration = clipDuration(cl);
    const playheadLocal = this.engine.getTime() - cl.start;
    const rawTime = opts.time ?? playheadLocal;
    const time = Math.max(0, Math.min(duration, Math.round(rawTime)));
    const value = opts.value ?? interpolateProp(cl, prop, time);
    this.pushHistory();
    cl.keyframes = upsertKeyframe(cl.keyframes, prop, time, value, () =>
      createId("kf"),
    );
    cl.keyframes.sort((a, b) => {
      if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
      return a.time - b.time;
    });
    this.afterMutation();
    const created = cl.keyframes.find(
      (k) => k.prop === prop && Math.abs(k.time - time) < 16,
    );
    return created?.id ?? null;
  }

  removeKeyframe(clipId: string, keyframeId: string): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl || !cl.keyframes) return false;
    const idx = cl.keyframes.findIndex((k) => k.id === keyframeId);
    if (idx < 0) return false;
    this.pushHistory();
    const next = cl.keyframes.slice();
    next.splice(idx, 1);
    cl.keyframes = next.length > 0 ? next : undefined;
    if (
      this.selectedKeyframe &&
      this.selectedKeyframe.clipId === clipId &&
      this.selectedKeyframe.keyframeId === keyframeId
    ) {
      this.selectedKeyframe = null;
      this.bus.emit("keyframeSelectionChange", { target: null });
    }
    this.afterMutation();
    return true;
  }

  moveKeyframe(clipId: string, keyframeId: string, timeMs: Ms): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    const kf = cl?.keyframes?.find((k) => k.id === keyframeId);
    if (!trk || !cl || !kf || !cl.keyframes) return false;
    const duration = clipDuration(cl);
    const clamped = Math.max(0, Math.min(duration, Math.round(timeMs)));
    // Identify every kf in the same "moment" as the grabbed one (same
    // clip-local time, within the 16 ms tolerance the timeline uses for
    // visual grouping). When the user pins via the toolbar "+ kf"
    // button all three props (panX / panY / scale) land at the same
    // time; dragging one without the others would visually fracture
    // the moment so move them all as a unit.
    const MOMENT_TOL = 16;
    const groupOriginalTime = kf.time;
    const group = cl.keyframes.filter(
      (k) => Math.abs(k.time - groupOriginalTime) <= MOMENT_TOL,
    );
    const groupIds = new Set(group.map((k) => k.id));
    const delta = clamped - groupOriginalTime;
    if (delta === 0) return false;
    // Reject collisions: any kf that's NOT part of the moving group
    // at the same prop+time would land on top.
    for (const g of group) {
      const newTime = g.time + delta;
      const collision = cl.keyframes.some(
        (k) =>
          !groupIds.has(k.id) &&
          k.prop === g.prop &&
          Math.abs(k.time - newTime) < 1,
      );
      if (collision) return false;
    }
    this.pushHistory();
    for (const g of group) g.time += delta;
    cl.keyframes.sort((a, b) => {
      if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
      return a.time - b.time;
    });
    this.afterMutation();
    return true;
  }

  setKeyframeValue(
    clipId: string,
    keyframeId: string,
    value: number,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    const kf = cl?.keyframes?.find((k) => k.id === keyframeId);
    if (!trk || !cl || !kf) return false;
    if (Math.abs(kf.value - value) < 1e-9) return false;
    this.pushHistory();
    kf.value = value;
    this.afterMutation();
    return true;
  }

  setKeyframeEasing(
    clipId: string,
    keyframeId: string,
    easing: EasingKind,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    const kf = cl?.keyframes?.find((k) => k.id === keyframeId);
    if (!trk || !cl || !kf) return false;
    const current = kf.easing ?? "linear";
    if (current === easing) return false;
    this.pushHistory();
    if (easing === "linear") {
      // Strip the field rather than store the default — keeps the
      // serialized project minimal for hosts that diff JSON.
      delete kf.easing;
    } else {
      kf.easing = easing;
    }
    this.afterMutation();
    return true;
  }

  setKeyframesEasingAtTime(
    clipId: string,
    timeMs: Ms,
    easing: EasingKind,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl || !cl.keyframes) return false;
    const t = Math.round(timeMs);
    const matches = cl.keyframes.filter((k) => Math.abs(k.time - t) < 16);
    if (matches.length === 0) return false;
    const anyChange = matches.some((k) => (k.easing ?? "linear") !== easing);
    if (!anyChange) return false;
    this.pushHistory();
    for (const kf of matches) {
      if (easing === "linear") delete kf.easing;
      else kf.easing = easing;
    }
    this.afterMutation();
    return true;
  }

  setValueAtPlayhead(
    clipId: string,
    prop: KeyframeProp,
    value: number,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const duration = clipDuration(cl);
    const playheadLocal = this.engine.getTime() - cl.start;
    const time = Math.max(0, Math.min(duration, Math.round(playheadLocal)));
    const hasKf = cl.keyframes?.some((k) => k.prop === prop) ?? false;
    if (hasKf) {
      // Upsert at playhead → animation gets another anchor.
      this.pushHistory();
      cl.keyframes = upsertKeyframe(cl.keyframes, prop, time, value, () =>
        createId("kf"),
      );
      cl.keyframes.sort((a, b) => {
        if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
        return a.time - b.time;
      });
      this.afterMutation();
      return true;
    }
    // No keyframes for this prop yet → update the static base. The
    // user can promote it to an animated property later by clicking
    // the toolbar keyframe button.
    if ((cl[prop] ?? (prop === "scale" ? 1 : 0)) === value) return false;
    this.pushHistory();
    cl[prop] = value;
    this.afterMutation();
    return true;
  }

  getSelectedKeyframe(): { clipId: string; keyframeId: string } | null {
    return this.selectedKeyframe;
  }

  resetClipTransform(clipId: string): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const dirty =
      (cl.keyframes && cl.keyframes.length > 0) ||
      cl.panX !== undefined ||
      cl.panY !== undefined ||
      cl.scale !== undefined;
    if (!dirty) return false;
    this.pushHistory();
    delete cl.panX;
    delete cl.panY;
    delete cl.scale;
    cl.keyframes = undefined;
    if (
      this.selectedKeyframe &&
      this.selectedKeyframe.clipId === clipId
    ) {
      this.selectedKeyframe = null;
      this.bus.emit("keyframeSelectionChange", { target: null });
    }
    this.afterMutation();
    return true;
  }

  resetKeyframesAtTime(clipId: string, timeMs: Ms): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const duration = clipDuration(cl);
    const t = Math.max(0, Math.min(duration, Math.round(timeMs)));
    // Identity values for each prop. Upsert in one batch so the
    // history stack records a single "reset" entry, not three.
    this.pushHistory();
    let kfs = cl.keyframes ?? [];
    kfs = upsertKeyframe(kfs, "panX", t, 0, () => createId("kf"));
    kfs = upsertKeyframe(kfs, "panY", t, 0, () => createId("kf"));
    kfs = upsertKeyframe(kfs, "scale", t, 1, () => createId("kf"));
    kfs.sort((a, b) => {
      if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
      return a.time - b.time;
    });
    cl.keyframes = kfs;
    this.afterMutation();
    return true;
  }

  seekToClipEdge(clipId: string, edge: "start" | "end"): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    // "end" lands 1ms inside the clip so the playhead stays inside —
    // toggleKeyframeAtPlayhead and friends look up the clip via the
    // playhead time, and a playhead landing exactly on the clip-end
    // seam picks up the *next* clip (or nothing). The 1ms backoff
    // costs nothing perceptually and keeps the keyframe-add workflow
    // single-click. See seekToClipEdge doc in the API surface.
    const target =
      edge === "start" ? cl.start : Math.max(cl.start, clipEnd(cl) - 1);
    if (this.engine.getTime() === target) return false;
    this.seek(target);
    return true;
  }

  seekToSelectedClipEdge(edge: "start" | "end"): boolean {
    if (!this.selectedClipId) return false;
    return this.seekToClipEdge(this.selectedClipId, edge);
  }

  toggleKeyframeAtPlayhead(): boolean {
    const clipId = this.selectedClipId;
    if (!clipId) return false;
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const localMs = this.engine.getTime() - cl.start;
    const duration = clipDuration(cl);
    if (localMs < 0 || localMs > duration) return false;
    const t = Math.round(localMs);
    const existing = cl.keyframes?.filter((k) => Math.abs(k.time - t) < 16);
    if (existing && existing.length > 0) {
      this.pushHistory();
      const ids = new Set(existing.map((k) => k.id));
      const next = cl.keyframes!.filter((k) => !ids.has(k.id));
      cl.keyframes = next.length > 0 ? next : undefined;
      if (
        this.selectedKeyframe &&
        ids.has(this.selectedKeyframe.keyframeId)
      ) {
        this.selectedKeyframe = null;
        this.bus.emit("keyframeSelectionChange", { target: null });
      }
      this.afterMutation();
      return true;
    }
    // Capture one keyframe per prop at the playhead. Use the currently
    // interpolated values so the preview doesn't jump.
    const current = getEffectiveTransform(cl, t);
    this.pushHistory();
    let kfs = cl.keyframes ?? [];
    kfs = upsertKeyframe(kfs, "panX", t, current.panX, () => createId("kf"));
    kfs = upsertKeyframe(kfs, "panY", t, current.panY, () => createId("kf"));
    kfs = upsertKeyframe(kfs, "scale", t, current.scale, () => createId("kf"));
    kfs.sort((a, b) => {
      if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
      return a.time - b.time;
    });
    cl.keyframes = kfs;
    // Auto-select the new moment so the left panel pops up
    // immediately — saves the user a second click. Pick the panX kf
    // as the deterministic anchor (the moment's grouping logic
    // doesn't care which sibling is the anchor).
    const anchor = kfs.find(
      (k) => k.prop === "panX" && Math.abs(k.time - t) < 16,
    );
    if (anchor) {
      this.selectedKeyframe = { clipId, keyframeId: anchor.id };
      this.bus.emit("keyframeSelectionChange", {
        target: this.selectedKeyframe,
      });
    }
    this.afterMutation();
    return true;
  }

  setSelectedKeyframe(
    target: { clipId: string; keyframeId: string } | null,
  ): void {
    if (
      target?.clipId === this.selectedKeyframe?.clipId &&
      target?.keyframeId === this.selectedKeyframe?.keyframeId
    ) {
      return;
    }
    this.selectedKeyframe = target;
    // Couple selection to the parent clip — clicking a keyframe makes
    // the host's clip-level UI light up too.
    if (target && target.clipId !== this.selectedClipId) {
      this.selectedClipId = target.clipId;
      this.bus.emit("selectionChange", { clipId: target.clipId });
    }
    this.bus.emit("keyframeSelectionChange", { target });
    this.ui?.render();
  }

  // ---- history --------------------------------------------------------

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  undo(): boolean {
    const prev = this.history.undo(this.project);
    if (!prev) return false;
    this.project = prev;
    this.reconcileSelectionsWithProject();
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    this.ui?.render();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.project);
    if (!next) return false;
    this.project = next;
    this.reconcileSelectionsWithProject();
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    this.ui?.render();
    return true;
  }

  beginInteraction(): void {
    this.interactionDepth += 1;
  }

  endInteraction(): void {
    if (this.interactionDepth === 0) return;
    this.interactionDepth -= 1;
    if (this.interactionDepth > 0) return; // still nested
    const snapshot = this.interactionStartSnapshot;
    this.interactionStartSnapshot = null;
    if (snapshot == null) return; // no mutation happened inside
    // Drop no-op sessions — if the project ended up identical to its
    // pre-session state (e.g. user pressed mouse, made no real move,
    // released), don't pollute history with an empty entry.
    const now = JSON.stringify(this.project);
    if (now === snapshot) return;
    this.history.push(JSON.parse(snapshot) as Project);
    this.emitHistory();
  }

  batch<T>(_label: string, fn: () => T | Promise<T>): T | Promise<T> {
    // Every op fired inside gets tagged with this id so an effects
    // layer can render a single grouped animation. Nested batch()
    // calls REUSE the outermost id — same undo entry, same visual.
    const outerBatchId = this.currentBatchId;
    if (outerBatchId == null) {
      this.currentBatchId = createId("batch");
    }
    const clearBatch = (): void => {
      if (outerBatchId == null) this.currentBatchId = null;
    };
    this.beginInteraction();
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(() => {
          this.endInteraction();
          clearBatch();
        });
      }
      this.endInteraction();
      clearBatch();
      return result;
    } catch (e) {
      this.endInteraction();
      clearBatch();
      throw e;
    }
  }

  /**
   * Emit an `operation` event. Called by every AI-facing mutator
   * right after it commits (or right after it decided to reject).
   * Keeps deep clones so subscribers can mutate freely without
   * corrupting editor state — same policy as `getProject()`.
   */
  private emitOperation(
    kind: OperationEvent["kind"],
    args: unknown,
    result: EditResult<unknown>,
    beforeSnapshotJson: string,
  ): void {
    const payload: OperationEvent = {
      kind,
      args,
      result,
      timestamp: Date.now(),
      beforeProject: JSON.parse(beforeSnapshotJson) as Project,
      afterProject: this.getProject(),
      ...(this.currentBatchId ? { batchId: this.currentBatchId } : {}),
    };
    this.bus.emit("operation", payload);
  }

  /**
   * Selections (clipId + selectedKeyframe) live OUTSIDE the project
   * snapshot, so undo / redo can leave them pointing at ids that no
   * longer exist. Defend against dangling refs by clearing anything
   * the restored project doesn't actually contain — and emit the
   * paired change events so panels / overlays hide cleanly instead
   * of holding zombie references.
   */
  private reconcileSelectionsWithProject(): void {
    if (this.selectedKeyframe) {
      const trk = findTrackOfClip(this.project, this.selectedKeyframe.clipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedKeyframe!.clipId);
      const kf = cl?.keyframes?.find(
        (k) => k.id === this.selectedKeyframe!.keyframeId,
      );
      if (!kf) {
        this.selectedKeyframe = null;
        this.bus.emit("keyframeSelectionChange", { target: null });
      }
    }
    if (this.selectedClipId) {
      const trk = findTrackOfClip(this.project, this.selectedClipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedClipId);
      if (!cl) {
        this.selectedClipId = null;
        this.bus.emit("selectionChange", { clipId: null });
      }
    }
  }

  // ---- events ---------------------------------------------------------

  on<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): () => void {
    return this.bus.on(event, handler);
  }

  off<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): void {
    this.bus.off(event, handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.destroy();
    this.ui?.destroy();
    this.bus.clear();
    this.history.clear();
  }

  // ---- internals ------------------------------------------------------

  private appendTrack(opts: { kind: Track["kind"] }): Track {
    const t: Track = { id: createId("track"), kind: opts.kind, clips: [] };
    this.project.tracks.push(t);
    return t;
  }

  private resolveTrimTarget(
    timeMs: Ms,
  ): { track: Track; clip: Clip } | null {
    if (this.selectedClipId) {
      const trk = findTrackOfClip(this.project, this.selectedClipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedClipId);
      if (trk && cl && timeMs >= cl.start && timeMs <= clipEnd(cl)) {
        return { track: trk, clip: cl };
      }
    }
    for (const trk of this.project.tracks) {
      const cl = findClipContaining(trk, timeMs);
      if (cl) return { track: trk, clip: cl };
    }
    return null;
  }

  private pushHistory(): void {
    // Inside a drag session, only the FIRST pushHistory captures —
    // subsequent calls during the same session coalesce. endInteraction
    // is the one that actually pushes the captured snapshot onto the
    // stack. See beginInteraction / endInteraction docs.
    if (this.interactionDepth > 0) {
      if (this.interactionStartSnapshot == null) {
        this.interactionStartSnapshot = JSON.stringify(this.project);
      }
      return;
    }
    this.history.push(this.project);
    this.emitHistory();
  }

  private emitHistory(): void {
    this.bus.emit("historyChange", {
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    });
  }

  private afterMutation(): void {
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.ui?.render();
  }

  private handleSourceMetadata(sourceId: string, durMs: Ms): void {
    const src = this.project.sources.find((s) => s.id === sourceId);
    let mutated = false;
    if (src && !src.duration) {
      src.duration = durMs;
      mutated = true;
    }
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.sourceId === sourceId && c.out === 0) {
          c.out = durMs;
          mutated = true;
        }
      }
    }
    this.bus.emit("ready", { sourceId });
    if (mutated) {
      // Source metadata patching is not a user action — don't pollute
      // the undo stack with it.
      this.engine.setProject(this.project);
      this.bus.emit("change", { project: this.getProject() });
      this.ui?.render();
    }
  }
}

function clampScale(s: number): number {
  return Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, s));
}

/** H.264 requires even output dims — snap to the nearest even pixel,
 *  trimming rather than expanding so the canvas never exceeds the
 *  requested size. */
function evenPx(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r - 1;
}
