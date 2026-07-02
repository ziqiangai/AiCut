export { Editor } from "./editor.js";
export type {
  EditResult,
  EditErrorReason,
  OperationEvent,
} from "./editor.js";
// Standalone metadata probe — same helper `Editor.addClip({ sourceUrl })`
// uses internally. Hosts can call it directly to pre-fetch duration
// + dimensions before deciding whether to insert.
export { probeMediaSource } from "./media-probe.js";
export type { ProbedMedia } from "./media-probe.js";
// Icon library — SVG strings the editor's toolbar renders. Exported so
// framework wrappers can share the same visual language in host-built
// toolbars without re-inventing icons.
export { ICONS } from "./ui/icons.js";
export type { IconName } from "./ui/icons.js";
export type {
  EditorOptions,
  HeadlessEditorOptions,
  EditorApi,
  EditorEventMap,
  EditorEventName,
  PreviewLayout,
} from "./editor.js";
export type {
  Project,
  ProjectOutput,
  MediaSource,
  Track,
  Clip,
  Keyframe,
  KeyframeProp,
  EasingKind,
  Ms,
  Theme,
  AspectRatio,
} from "./types.js";
export { DEFAULT_OUTPUT_DIMS, defaultOutputForAspect } from "./model.js";

// Keyframe interpolation — hosts can read the effective transform of a
// clip at any time (e.g. for thumbnail previews) without touching the
// playback engine. Pure math, zero deps.
export {
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  getEffectiveTransform,
  getTransformAtTimelineTime,
  type EffectiveTransform,
} from "./keyframes/index.js";
export {
  createEmptyProject,
  normalizeProject,
  findClipContaining,
  findTrackOfClip,
  findClipAt,
  getClipsInRange,
  getClipsOnTrack,
  clipDuration,
  clipEnd,
  // Time conversion — clip.start/clip.in do the math, but these
  // helpers save AI callers from re-deriving it every tool call.
  timelineToSourceMs,
  sourceToTimelineMs,
} from "./model.js";
export { createId } from "./ids.js";

// Standalone canvas Timeline. Reuse this without the rest of the editor
// for use cases like a video frame-picker.
export { Timeline } from "./timeline/index.js";
export type { TimelineOptions } from "./timeline/index.js";
export {
  TRACK_HEIGHT,
  RULER_HEIGHT,
  HEADER_WIDTH,
  setTimelineMetrics,
} from "./timeline/layout.js";

// i18n — pass to `Editor.create({ locale })` to switch the editor's
// built-in tooltips and canvas labels. Defaults to English.
export { localeEn, localeZh, mergeLocale, formatLabel } from "./i18n.js";
export type { Locale } from "./i18n.js";

// Playback engine contract — hosts can ship a custom implementation
// (WebCodecs, WebGL compositor, IPC-bridged native engine) and inject
// it later via `Editor.create({ playbackEngine: factory })`. The
// built-in `HtmlVideoEngine` is exposed for consumers that want to
// extend or wrap the default behavior.
export type {
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
  CanvasCompositorEngineOptions,
} from "./playback/index.js";
export {
  HtmlVideoEngine,
  htmlVideoEngineFactory,
  CanvasCompositorEngine,
  canvasCompositorEngineFactory,
} from "./playback/index.js";
