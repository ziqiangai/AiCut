export { VideoEditor } from "./VideoEditor.js";
export type { VideoEditorProps, VideoEditorApi } from "./VideoEditor.js";
export { Timeline } from "./Timeline.js";
export type { TimelineProps, TimelineApi } from "./Timeline.js";
// Primitives — compose your own editor layout instead of using the
// pre-built <VideoEditor> shell. See "Preview layout" in the README.
export {
  EditorProvider,
  useEditor,
  useEditorState,
  useLocale,
  Preview,
  Timeline as TimelinePrimitive,
  PlayButton,
  TimeLabel,
  DurationLabel,
  FullscreenButton,
  UndoButton,
  RedoButton,
  SplitButton,
  TrimLeftButton,
  TrimRightButton,
  SnapToggle,
  formatClock,
} from "./primitives.js";
export type {
  EditorProviderProps,
  PreviewProps,
  TimelinePrimitiveProps,
  ButtonProps,
  TimeLabelProps,
} from "./primitives.js";
export type {
  Project,
  ProjectOutput,
  MediaSource,
  Track,
  Clip,
  Keyframe,
  Ms,
  Theme,
  AspectRatio,
  PreviewLayout,
  EditorApi,
  Locale,
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
  CanvasCompositorEngineOptions,
  EffectiveTransform,
} from "@aicut/core";
export {
  createEmptyProject,
  createId,
  DEFAULT_OUTPUT_DIMS,
  defaultOutputForAspect,
  localeEn,
  localeZh,
  HtmlVideoEngine,
  htmlVideoEngineFactory,
  CanvasCompositorEngine,
  canvasCompositorEngineFactory,
  // Live bindings — re-reading them after `setTimelineMetrics` (which
  // EditorOptions.trackHeight / .rulerHeight calls under the hood)
  // returns the updated values.
  TRACK_HEIGHT,
  RULER_HEIGHT,
  HEADER_WIDTH,
  setTimelineMetrics,
  // Pure-math keyframe helpers — hosts can read effective transforms
  // for previews / thumbnails without touching the playback engine.
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  getEffectiveTransform,
  getTransformAtTimelineTime,
} from "@aicut/core";
