import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWebCodecsSupported } from "./feature.js";

describe("isWebCodecsSupported", () => {
  // happy-dom doesn't ship WebCodecs globals — this is the realistic
  // pre-detection baseline. The next block flips them on to assert the
  // positive path.
  it("returns false when VideoDecoder is absent", () => {
    expect(isWebCodecsSupported()).toBe(false);
  });

  describe("with WebCodecs globals stubbed", () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      g.VideoDecoder = class {};
      g.VideoFrame = class {};
      g.EncodedVideoChunk = class {};
    });
    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      delete g.VideoDecoder;
      delete g.VideoFrame;
      delete g.EncodedVideoChunk;
    });
    it("returns true when all three globals exist", () => {
      expect(isWebCodecsSupported()).toBe(true);
    });
  });
});
