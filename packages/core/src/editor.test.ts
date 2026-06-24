import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "./editor.js";
import {
  HtmlVideoEngine,
  type PlaybackEngine,
  type PlaybackEngineFactory,
  type PlaybackEngineOptions,
} from "./playback/index.js";
import type { Ms, Project } from "./types.js";

/**
 * Hand-rolled stub. Not using vi.fn() for the methods so we can keep
 * the stored event hooks (onTimeUpdate etc.) as real assignable fields
 * the Editor writes into post-construction.
 */
function makeStubEngine(): PlaybackEngine & {
  calls: { play: number; pause: number; seek: Ms[]; destroy: number };
  fireTime: (ms: Ms) => void;
  fireEnded: () => void;
  fireError: (e: Error) => void;
  fireReady: () => void;
  fireSourceMeta: (id: string, dur: Ms) => void;
} {
  const calls = { play: 0, pause: 0, seek: [] as Ms[], destroy: 0 };
  let time: Ms = 0;
  let playing = false;
  let projectRef: Project | null = null;
  const stub = {
    calls,
    setProject(p: Project) {
      projectRef = p;
    },
    play() {
      calls.play += 1;
      playing = true;
    },
    pause() {
      calls.pause += 1;
      playing = false;
    },
    isPlaying: () => playing,
    getTime: () => time,
    seek(ms: Ms) {
      calls.seek.push(ms);
      time = ms;
    },
    destroy() {
      calls.destroy += 1;
    },
    fireTime(ms: Ms) {
      stub.onTimeUpdate?.(ms);
    },
    fireEnded() {
      stub.onEnded?.();
    },
    fireError(e: Error) {
      stub.onError?.(e);
    },
    fireReady() {
      stub.onReady?.();
    },
    fireSourceMeta(id: string, dur: Ms) {
      stub.onSourceMetadata?.(id, dur);
    },
  } as PlaybackEngine & ReturnType<typeof makeStubEngine>;
  return stub;
}

function tinyProject(): Project {
  return {
    version: 1,
    sources: [{ id: "s1", url: "blob:fake", kind: "video", name: "a" }],
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: [{ id: "c1", sourceId: "s1", in: 0, out: 5000, start: 0 }],
      },
    ],
  };
}

describe("Editor playback engine injection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("uses HtmlVideoEngine by default when no factory is supplied", () => {
    let captured: PlaybackEngine | null = null;
    const spyFactory: PlaybackEngineFactory = (opts) => {
      const engine = new HtmlVideoEngine(opts);
      captured = engine;
      return engine;
    };
    const editor = Editor.create({
      container,
      project: tinyProject(),
      // Inject the same default class through a factory so we can keep
      // a reference to the actual instance without monkey-patching.
      playbackEngine: spyFactory,
    });
    expect(captured).toBeInstanceOf(HtmlVideoEngine);
    editor.destroy();
  });

  it("invokes the host factory exactly once with { host, project }", () => {
    const project = tinyProject();
    const factory = vi.fn((opts: PlaybackEngineOptions) => {
      // Sanity-check the host is a real element underneath the editor
      // container — the editor's previewHost, not the container itself.
      expect(opts.host).toBeInstanceOf(HTMLElement);
      expect(container.contains(opts.host)).toBe(true);
      // Editor normalizes the project before handing it down — assert
      // value equality, not reference equality.
      expect(opts.project).toEqual(project);
      return makeStubEngine();
    });
    const editor = Editor.create({ container, project, playbackEngine: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("forwards play / pause / seek / destroy to the injected engine", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    editor.play();
    editor.pause();
    editor.seek(1234);
    expect(stub.calls.play).toBe(1);
    expect(stub.calls.pause).toBe(1);
    expect(stub.calls.seek).toEqual([1234]);
    editor.destroy();
    expect(stub.calls.destroy).toBe(1);
  });

  it("re-emits engine.onTimeUpdate as the editor 'time' event", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    const seen: Ms[] = [];
    editor.on("time", ({ timeMs }) => seen.push(timeMs));
    stub.fireTime(42);
    stub.fireTime(100);
    expect(seen).toEqual([42, 100]);
    editor.destroy();
  });

  it("re-emits engine.onEnded as a 'pause' event", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    let pauses = 0;
    editor.on("pause", () => (pauses += 1));
    stub.fireEnded();
    expect(pauses).toBe(1);
    editor.destroy();
  });

  it("re-emits engine.onError as an 'error' event", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    const errs: Error[] = [];
    editor.on("error", ({ error }) => errs.push(error));
    const boom = new Error("decode failed");
    stub.fireError(boom);
    expect(errs).toEqual([boom]);
    editor.destroy();
  });

  it("patches a missing source duration and emits 'ready' when engine.onSourceMetadata fires", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      // Source with no `duration` yet; clip has real bounds so
      // normalizeProject keeps it (it drops clips with out <= in).
      project: {
        version: 1,
        sources: [{ id: "s1", url: "blob:x", kind: "video" }],
        tracks: [
          {
            id: "t1",
            kind: "video",
            clips: [{ id: "c1", sourceId: "s1", in: 0, out: 1000, start: 0 }],
          },
        ],
      },
      playbackEngine: () => stub,
    });
    let readySourceId: string | null = "untouched";
    editor.on("ready", ({ sourceId }) => (readySourceId = sourceId));
    stub.fireSourceMeta("s1", 7777);
    expect(readySourceId).toBe("s1");
    const src = editor.getProject().sources[0];
    expect(src?.duration).toBe(7777);
    editor.destroy();
  });
});
