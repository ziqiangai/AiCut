import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types.js";
import { WebCodecsEngine } from "./engine.js";

function project(): Project {
  return {
    version: 1,
    sources: [{ id: "s1", url: "blob:fake", kind: "video" }],
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: [{ id: "c1", sourceId: "s1", in: 0, out: 5000, start: 0 }],
      },
    ],
  };
}

describe("WebCodecsEngine — feature gate", () => {
  it("throws a helpful error when VideoDecoder is missing", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    expect(
      () => new WebCodecsEngine({ host, project: project() }),
    ).toThrow(/VideoDecoder/);
    host.remove();
  });
});

describe("WebCodecsEngine — basic surface (with WebCodecs stubbed)", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    host.style.width = "320px";
    host.style.height = "180px";
    document.body.appendChild(host);

    // Stub just enough of the WebCodecs surface to let the engine
    // construct. We're not actually decoding anything here — the
    // mp4box fetch will fail on a fake URL, but that path is async
    // and goes through onError; the engine still constructs cleanly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.VideoDecoder = vi.fn().mockImplementation(() => ({
      state: "unconfigured",
      decodeQueueSize: 0,
      configure: vi.fn(),
      decode: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    }));
    g.VideoFrame = vi.fn();
    g.EncodedVideoChunk = vi.fn();
    // fetch will be called by Mp4Demuxer; stub it so the construct
    // doesn't actually try to hit network.
    g.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 599,
      body: null,
    });
  });
  afterEach(() => {
    host.remove();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    delete g.VideoDecoder;
    delete g.VideoFrame;
    delete g.EncodedVideoChunk;
    delete g.fetch;
  });

  it("mounts a canvas into the host", () => {
    const engine = new WebCodecsEngine({ host, project: project() });
    expect(host.querySelector("canvas")).not.toBeNull();
    engine.destroy();
  });

  it("does NOT paint the debug HUD by default", () => {
    const engine = new WebCodecsEngine({ host, project: project() });
    expect(host.querySelector(".aicut-preview__badge")).toBeNull();
    engine.destroy();
  });

  it("paints the debug HUD when constructed with debug: true", () => {
    const engine = new WebCodecsEngine({
      host,
      project: project(),
      debug: true,
    });
    const badge = host.querySelector(".aicut-preview__badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/webcodecs/);
    engine.destroy();
  });

  it("starts paused with playhead at 0", () => {
    const engine = new WebCodecsEngine({ host, project: project() });
    expect(engine.isPlaying()).toBe(false);
    expect(engine.getTime()).toBe(0);
    engine.destroy();
  });

  it("clamps seek to [0, totalDuration]", () => {
    const engine = new WebCodecsEngine({ host, project: project() });
    const seen: number[] = [];
    engine.onTimeUpdate = (ms) => seen.push(ms);

    engine.seek(2500);
    expect(engine.getTime()).toBe(2500);

    engine.seek(-50);
    expect(engine.getTime()).toBe(0);

    engine.seek(999_999);
    expect(engine.getTime()).toBe(5000);

    expect(seen).toEqual([2500, 0, 5000]);
    engine.destroy();
  });

  it("destroy() removes the preview mount entirely", () => {
    const engine = new WebCodecsEngine({
      host,
      project: project(),
      debug: true,
    });
    expect(host.querySelector(".aicut-preview")).not.toBeNull();
    engine.destroy();
    expect(host.querySelector(".aicut-preview")).toBeNull();
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.querySelector(".aicut-preview__badge")).toBeNull();
  });
});
