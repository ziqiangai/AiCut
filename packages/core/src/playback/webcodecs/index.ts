/**
 * `@aicut/core/webcodecs` — opt-in playback engine that decodes via
 * WebCodecs (frame-accurate seek, foundation for compositing /
 * transitions / shaders). Bundles mp4box.js for MP4/MOV demuxing.
 *
 * Re-exporting the interface and base options from the main entry's
 * playback module so consumers can write `Engine implements PlaybackEngine`
 * without a second import from `@aicut/core`.
 */
export {
  WebCodecsEngine,
  webCodecsEngineFactory,
  type WebCodecsEngineOptions,
} from "./engine.js";
export { isWebCodecsSupported } from "./feature.js";
export type { DemuxedTrack } from "./demuxer.js";
