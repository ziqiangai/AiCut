import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../types.js";
import { HtmlVideoEngine, htmlVideoEngineFactory } from "./index.js";

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

describe("HtmlVideoEngine", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
  });

  it("mounts a preview element into the host on construction", () => {
    const engine = new HtmlVideoEngine({ host, project: project() });
    const preview = host.querySelector(".aicut-preview");
    expect(preview).not.toBeNull();
    engine.destroy();
  });

  it("creates one <video> per video source", () => {
    const engine = new HtmlVideoEngine({
      host,
      project: project({
        sources: [
          { id: "s1", url: "blob:1", kind: "video" },
          { id: "s2", url: "blob:2", kind: "video" },
          { id: "s3", url: "blob:3", kind: "audio" },
        ],
      }),
    });
    expect(host.querySelectorAll("video")).toHaveLength(2);
    engine.destroy();
  });

  it("removes <video> elements when sources disappear via setProject", () => {
    const engine = new HtmlVideoEngine({ host, project: project() });
    expect(host.querySelectorAll("video")).toHaveLength(1);
    engine.setProject(project({ sources: [], tracks: [] }));
    expect(host.querySelectorAll("video")).toHaveLength(0);
    engine.destroy();
  });

  it("starts paused with playhead at 0", () => {
    const engine = new HtmlVideoEngine({ host, project: project() });
    expect(engine.isPlaying()).toBe(false);
    expect(engine.getTime()).toBe(0);
    engine.destroy();
  });

  it("clamps seek to [0, totalDuration] and pushes the new time through onTimeUpdate", () => {
    const engine = new HtmlVideoEngine({ host, project: project() });
    const seen: number[] = [];
    engine.onTimeUpdate = (ms) => seen.push(ms);

    engine.seek(2500);
    expect(engine.getTime()).toBe(2500);

    engine.seek(-100); // below 0
    expect(engine.getTime()).toBe(0);

    engine.seek(999_999); // beyond totalDuration (5000)
    expect(engine.getTime()).toBe(5000);

    expect(seen).toEqual([2500, 0, 5000]);
    engine.destroy();
  });

  it("destroy() removes its preview mount and inner videos", () => {
    const engine = new HtmlVideoEngine({ host, project: project() });
    expect(host.querySelector(".aicut-preview")).not.toBeNull();
    engine.destroy();
    expect(host.querySelector(".aicut-preview")).toBeNull();
    expect(host.querySelectorAll("video")).toHaveLength(0);
  });

  it("htmlVideoEngineFactory shorthand returns an HtmlVideoEngine", () => {
    const engine = htmlVideoEngineFactory({ host, project: project() });
    expect(engine).toBeInstanceOf(HtmlVideoEngine);
    engine.destroy();
  });
});
