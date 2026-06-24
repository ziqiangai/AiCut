/**
 * Feature detection — every API the engine needs must be present.
 * Used both by the engine constructor (hard gate) and by hosts that
 * want to conditionally render an engine selector.
 */
export function isWebCodecsSupported(): boolean {
  return (
    typeof globalThis.VideoDecoder !== "undefined" &&
    typeof globalThis.VideoFrame !== "undefined" &&
    typeof globalThis.EncodedVideoChunk !== "undefined"
  );
}
