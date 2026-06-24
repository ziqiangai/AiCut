/**
 * @aicut/react/webcodecs — separate entry that pulls mp4box.js for
 * frame-accurate WebCodecs playback. Users who never import this
 * path don't pay the mp4box bundle cost.
 *
 * Pass the factory directly to `<VideoEditor playbackEngine={…} />`,
 * or wrap it in a closure to flip `debug: true`.
 */
export {
  WebCodecsEngine,
  webCodecsEngineFactory,
  isWebCodecsSupported,
  type WebCodecsEngineOptions,
  type DemuxedTrack,
} from "@aicut/core/webcodecs";
