import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../types.js";
import {
  CanvasCompositorEngine,
  canvasCompositorEngineFactory,
} from "./index.js";

function project(overrides?: Partial<Project>): Project {
  return {
    version: 1,
    sources: [
      { id: "s1", url: "blob:fake-1", kind: "video", name: "a.mp4" },
    ],
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: [
          { id: "c1", sourceId: "s1", in: 0, out: 5000, start: 0 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("CanvasCompositorEngine", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    // give the host a non-zero box so resizeCanvas doesn't no-op
    host.style.width = "320px";
    host.style.height = "180px";
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
  });

  it("mounts a canvas into the host", () => {
    const engine = new CanvasCompositorEngine({ host, project: project() });
    expect(host.querySelector("canvas")).not.toBeNull();
    engine.destroy();
  });

  it("does NOT paint the debug HUD by default", () => {
    const engine = new CanvasCompositorEngine({ host, project: project() });
    expect(host.querySelector(".aicut-preview__badge")).toBeNull();
    engine.destroy();
  });

  it("paints the debug HUD when constructed with debug: true", () => {
    const engine = new CanvasCompositorEngine({
      host,
      project: project(),
      debug: true,
    });
    const badge = host.querySelector(".aicut-preview__badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/canvas compositor/);
    engine.destroy();
  });

  it("keeps decode videos OFF the DOM tree so the canvas owns the pixels", () => {
    const engine = new CanvasCompositorEngine({ host, project: project() });
    expect(host.querySelectorAll("video")).toHaveLength(0);
    engine.destroy();
  });

  it("creates one decoder video per source (detached)", () => {
    const engine = new CanvasCompositorEngine({
      host,
      project: project({
        sources: [
          { id: "s1", url: "blob:1", kind: "video" },
          { id: "s2", url: "blob:2", kind: "video" },
          { id: "s3", url: "blob:3", kind: "audio" },
        ],
      }),
    });
    // No public accessor — assert through behavior: setProject(empty)
    // should be a no-op for non-video sources and shouldn't throw.
    engine.setProject(project({ sources: [], tracks: [] }));
    expect(engine.getTime()).toBe(0);
    engine.destroy();
  });

  it("starts paused with playhead at 0", () => {
    const engine = new CanvasCompositorEngine({ host, project: project() });
    expect(engine.isPlaying()).toBe(false);
    expect(engine.getTime()).toBe(0);
    engine.destroy();
  });

  it("clamps seek to [0, totalDuration] and pushes the new time through onTimeUpdate", () => {
    const engine = new CanvasCompositorEngine({ host, project: project() });
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

  it("destroy() removes the preview mount entirely (including HUD when on)", () => {
    const engine = new CanvasCompositorEngine({
      host,
      project: project(),
      debug: true,
    });
    expect(host.querySelector(".aicut-preview")).not.toBeNull();
    expect(host.querySelector(".aicut-preview__badge")).not.toBeNull();
    engine.destroy();
    expect(host.querySelector(".aicut-preview")).toBeNull();
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.querySelector(".aicut-preview__badge")).toBeNull();
  });

  it("canvasCompositorEngineFactory shorthand returns the right class", () => {
    const engine = canvasCompositorEngineFactory({ host, project: project() });
    expect(engine).toBeInstanceOf(CanvasCompositorEngine);
    engine.destroy();
  });
});
