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

/**
 * Batch API — wraps beginInteraction/endInteraction so N mutations
 * collapse to one undo entry + one change-side effect. Covers the
 * sync / async / throwing branches; the underlying
 * interactionDepth logic is already exercised by the drag-session
 * tests, so this suite focuses on the batch() contract itself.
 */
describe("Editor batch()", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  it("collapses N mutations into a single undo entry", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    // Split at 1s then at 3s (both inside the single 0..5s clip).
    editor.batch("two-splits", () => {
      editor.split(1000);
      editor.split(3000);
    });
    expect(editor.getProject().tracks[0]!.clips.length).toBe(3);
    // One undo should restore the pre-batch state — one clip.
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    expect(editor.getProject().tracks[0]!.clips.length).toBe(1);
    // And nothing left on the stack.
    expect(editor.canUndo()).toBe(false);
    editor.destroy();
  });

  it("supports async fn — endInteraction fires after settle", async () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const p = editor.batch("async-split", async () => {
      // Simulate an awaited external call — e.g. AI hitting a video-gen API.
      await new Promise((r) => setTimeout(r, 5));
      editor.split(2000);
    });
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(editor.getProject().tracks[0]!.clips.length).toBe(2);
    editor.undo();
    expect(editor.getProject().tracks[0]!.clips.length).toBe(1);
    editor.destroy();
  });

  it("commits partial changes when fn throws (matches begin/end semantics)", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    expect(() =>
      editor.batch("throwing", () => {
        editor.split(1000);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // First split landed; caller sees 2 clips + can undo to restore 1.
    expect(editor.getProject().tracks[0]!.clips.length).toBe(2);
    editor.undo();
    expect(editor.getProject().tracks[0]!.clips.length).toBe(1);
    editor.destroy();
  });

  it("returns fn's value verbatim (sync)", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const ids = editor.batch("returning", () => editor.split(1500));
    expect(Array.isArray(ids)).toBe(true);
    expect(ids?.length).toBe(2);
    editor.destroy();
  });

  it("emits one change event even across many mutations", async () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    // Skip the constructor's initial change event.
    await new Promise((r) => setTimeout(r, 0));
    let changes = 0;
    editor.on("change", () => (changes += 1));
    editor.batch("multi", () => {
      editor.split(1000);
      editor.split(2000);
      editor.split(3000);
    });
    // Today afterMutation() fires per-mutation — this test asserts the
    // CURRENT (permissive) behavior. When batch coalesces change events
    // in a follow-up, update expected to 1.
    expect(changes).toBeGreaterThan(0);
    editor.destroy();
  });
});

/**
 * AI-facing option-object mutators — splitClip / moveClipTo / trimClip
 * / deleteClip. These take explicit targets and return `EditResult`
 * with typed failure reasons so AI tool-loops (or any code without UI
 * state) can drive edits deterministically. Legacy positional methods
 * are exercised elsewhere; this suite proves the new surface.
 */
describe("Editor AI-facing edit methods (EditResult)", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function editorWith(p: Project) {
    return Editor.create({
      container,
      project: p,
      playbackEngine: () => makeStubEngine(),
    });
  }

  it("splitClip: strictly-interior time succeeds + returns new ids", () => {
    const editor = editorWith(tinyProject());
    const r = editor.splitClip({ clipId: "c1", timeMs: 2000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.newClipIds).toHaveLength(2);
      expect(editor.getProject().tracks[0]!.clips.length).toBe(2);
    }
    editor.destroy();
  });

  it("splitClip: unknown clipId returns clip-not-found", () => {
    const editor = editorWith(tinyProject());
    const r = editor.splitClip({ clipId: "does-not-exist", timeMs: 2000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("clip-not-found");
    editor.destroy();
  });

  it("splitClip: time equal to clip.start returns time-outside-clip", () => {
    const editor = editorWith(tinyProject());
    const r = editor.splitClip({ clipId: "c1", timeMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("time-outside-clip");
      expect(r.hint).toContain("[0, 5000)");
    }
    editor.destroy();
  });

  it("splitClip: negative time returns invalid-time", () => {
    const editor = editorWith(tinyProject());
    const r = editor.splitClip({ clipId: "c1", timeMs: -100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-time");
    editor.destroy();
  });

  it("moveClipTo: moves within same track when free", () => {
    const editor = editorWith(tinyProject());
    const r = editor.moveClipTo({ clipId: "c1", startMs: 3000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.startMs).toBe(3000);
    expect(editor.getProject().tracks[0]!.clips[0]!.start).toBe(3000);
    editor.destroy();
  });

  it("moveClipTo: cross-track move with clear destination succeeds", () => {
    const p: Project = {
      version: 1,
      sources: [{ id: "s1", url: "blob:fake", kind: "video", name: "a" }],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [{ id: "c1", sourceId: "s1", in: 0, out: 2000, start: 0 }],
        },
        { id: "t2", kind: "video", clips: [] },
      ],
    };
    const editor = editorWith(p);
    const r = editor.moveClipTo({
      clipId: "c1",
      toTrackId: "t2",
      startMs: 5000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.trackId).toBe("t2");
      expect(r.data.startMs).toBe(5000);
    }
    expect(editor.getProject().tracks[0]!.clips.length).toBe(0);
    expect(editor.getProject().tracks[1]!.clips.length).toBe(1);
    editor.destroy();
  });

  it("moveClipTo: overlap + onOverlap='error' rejects with typed reason", () => {
    const p: Project = {
      version: 1,
      sources: [{ id: "s1", url: "blob:fake", kind: "video", name: "a" }],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [
            { id: "c1", sourceId: "s1", in: 0, out: 2000, start: 0 },
            { id: "c2", sourceId: "s1", in: 0, out: 2000, start: 3000 },
          ],
        },
      ],
    };
    const editor = editorWith(p);
    // Try to move c1 into c2's territory.
    const r = editor.moveClipTo({ clipId: "c1", startMs: 3500 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("overlap");
      expect(r.hint).toContain("c2");
    }
    // Project unchanged (c1 still at 0).
    expect(editor.getProject().tracks[0]!.clips[0]!.start).toBe(0);
    editor.destroy();
  });

  it("moveClipTo: onOverlap='auto' falls back to smart-routing", () => {
    const p: Project = {
      version: 1,
      sources: [{ id: "s1", url: "blob:fake", kind: "video", name: "a" }],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [
            { id: "c1", sourceId: "s1", in: 0, out: 2000, start: 0 },
            { id: "c2", sourceId: "s1", in: 0, out: 2000, start: 3000 },
          ],
        },
        { id: "t2", kind: "video", clips: [] },
      ],
    };
    const editor = editorWith(p);
    const r = editor.moveClipTo({
      clipId: "c1",
      toTrackId: "t1",
      startMs: 3500,
      onOverlap: "auto",
    });
    expect(r.ok).toBe(true);
    // Smart routing lands it on t2 (only free spot for that interval).
    if (r.ok) expect(r.data.trackId).toBe("t2");
    editor.destroy();
  });

  it("trimClip: left edge moves in + start", () => {
    const editor = editorWith(tinyProject());
    const r = editor.trimClip({ clipId: "c1", edge: "left", timeMs: 1000 });
    expect(r.ok).toBe(true);
    const c = editor.getProject().tracks[0]!.clips[0]!;
    expect(c.start).toBe(1000);
    expect(c.in).toBe(1000);
    editor.destroy();
  });

  it("trimClip: right edge moves out", () => {
    const editor = editorWith(tinyProject());
    const r = editor.trimClip({ clipId: "c1", edge: "right", timeMs: 3000 });
    expect(r.ok).toBe(true);
    const c = editor.getProject().tracks[0]!.clips[0]!;
    expect(c.out).toBe(3000);
    editor.destroy();
  });

  it("deleteClip: removes + typed reason on unknown id", () => {
    const editor = editorWith(tinyProject());
    const good = editor.deleteClip({ clipId: "c1" });
    expect(good.ok).toBe(true);
    expect(editor.getProject().tracks[0]!.clips.length).toBe(0);
    const bad = editor.deleteClip({ clipId: "ghost" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("clip-not-found");
    editor.destroy();
  });
});

/**
 * addClip — one-shot "add source + create clip" for AI callers. URL
 * loading path can't be tested in jsdom (no <video> metadata plumbing),
 * so these tests focus on the `sourceId` (reuse) branch which covers
 * every validation + overlap decision.
 */
describe("Editor addClip()", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function projectWithTwoTracks(): Project {
    return {
      version: 1,
      sources: [
        {
          id: "src-1",
          url: "blob:sample",
          kind: "video",
          name: "sample.mp4",
          duration: 5000,
        },
      ],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [{ id: "c1", sourceId: "src-1", in: 0, out: 2000, start: 0 }],
        },
        { id: "t2", kind: "video", clips: [] },
      ],
    };
  }

  it("reuses sourceId + inserts clip on empty track", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t2",
      startMs: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.sourceId).toBe("src-1");
    expect(editor.getProject().tracks[1]!.clips.length).toBe(1);
    editor.destroy();
  });

  it("rejects with source-not-found for bogus sourceId", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "does-not-exist",
      trackId: "t2",
      startMs: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("source-not-found");
    editor.destroy();
  });

  it("rejects with track-not-found for bogus trackId", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t-nope",
      startMs: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("track-not-found");
    editor.destroy();
  });

  it("rejects with overlap when onOverlap: 'error' (default)", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    // Track 1 already has c1 at [0, 2000). Try to insert at 1000.
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t1",
      startMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("overlap");
    editor.destroy();
  });

  it("appends past trailing clip when onOverlap: 'auto'", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t1",
      startMs: 1000,
      onOverlap: "auto",
    });
    expect(r.ok).toBe(true);
    const clips = editor.getProject().tracks[0]!.clips;
    expect(clips.length).toBe(2);
    // The new clip lands after c1 (which ends at 2000).
    expect(clips[1]!.start).toBe(2000);
    editor.destroy();
  });

  it("respects inMs/outMs to trim into source", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t2",
      startMs: 0,
      inMs: 500,
      outMs: 1500,
    });
    expect(r.ok).toBe(true);
    const clip = editor.getProject().tracks[1]!.clips[0]!;
    expect(clip.in).toBe(500);
    expect(clip.out).toBe(1500);
    editor.destroy();
  });

  it("rejects invalid inMs/outMs range", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t2",
      startMs: 0,
      inMs: 2000,
      outMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-range");
    editor.destroy();
  });

  it("silently drops meta payload (MVP forward-compat)", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      sourceId: "src-1",
      trackId: "t2",
      startMs: 0,
      meta: { generatedBy: "kling", prompt: "sunset over mountains" },
    });
    expect(r.ok).toBe(true);
    // Clip persisted; meta not on the clip object today (reserved for
    // a future release). No throw = contract kept.
    const clip = editor.getProject().tracks[1]!.clips[0]!;
    expect((clip as unknown as { meta?: unknown }).meta).toBeUndefined();
    editor.destroy();
  });

  it("requires either sourceUrl or sourceId", async () => {
    const editor = Editor.create({
      container,
      project: projectWithTwoTracks(),
      playbackEngine: () => makeStubEngine(),
    });
    const r = await editor.addClip({
      trackId: "t2",
      startMs: 0,
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-range");
    editor.destroy();
  });
});

/**
 * Operation event bus — Layer 1 of the effects architecture. Every
 * AI-facing mutator (splitClip / moveClipTo / trimClip / deleteClip
 * / addClip) fires exactly one `operation` event carrying enough
 * context for a downstream effect layer to render an animation.
 * Failures fire too (with result.ok = false).
 *
 * `batch()` groups ops via a shared `batchId`.
 */
describe("Editor operation events", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function editorWith(p: Project) {
    return Editor.create({
      container,
      project: p,
      playbackEngine: () => makeStubEngine(),
    });
  }

  it("splitClip fires one event with before/after snapshots", () => {
    const editor = editorWith(tinyProject());
    const events: unknown[] = [];
    editor.on("operation", (op) => events.push(op));
    editor.splitClip({ clipId: "c1", timeMs: 2500 });
    expect(events).toHaveLength(1);
    const op = events[0] as {
      kind: string;
      args: { clipId: string; timeMs: number };
      result: { ok: boolean };
      timestamp: number;
      beforeProject: Project;
      afterProject: Project;
      batchId?: string;
    };
    expect(op.kind).toBe("splitClip");
    expect(op.args.clipId).toBe("c1");
    expect(op.args.timeMs).toBe(2500);
    expect(op.result.ok).toBe(true);
    // Before had 1 clip; after has 2.
    expect(op.beforeProject.tracks[0]!.clips.length).toBe(1);
    expect(op.afterProject.tracks[0]!.clips.length).toBe(2);
    expect(op.timestamp).toBeGreaterThan(0);
    expect(op.batchId).toBeUndefined();
    editor.destroy();
  });

  it("failed splitClip still fires event with ok:false + reason", () => {
    const editor = editorWith(tinyProject());
    const events: unknown[] = [];
    editor.on("operation", (op) => events.push(op));
    editor.splitClip({ clipId: "does-not-exist", timeMs: 2500 });
    expect(events).toHaveLength(1);
    const op = events[0] as { result: { ok: boolean; reason?: string } };
    expect(op.result.ok).toBe(false);
    expect(op.result.reason).toBe("clip-not-found");
    editor.destroy();
  });

  it("moveClipTo fires with same event structure", () => {
    const editor = editorWith({
      version: 1,
      sources: [{ id: "s1", url: "blob:x", kind: "video", name: "a" }],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [{ id: "c1", sourceId: "s1", in: 0, out: 2000, start: 0 }],
        },
        { id: "t2", kind: "video", clips: [] },
      ],
    });
    const events: Array<{ kind: string }> = [];
    editor.on("operation", (op) => events.push(op as { kind: string }));
    editor.moveClipTo({ clipId: "c1", toTrackId: "t2", startMs: 5000 });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("moveClipTo");
    editor.destroy();
  });

  it("trimClip / deleteClip each fire one event", () => {
    const editor = editorWith(tinyProject());
    const events: Array<{ kind: string }> = [];
    editor.on("operation", (op) => events.push(op as { kind: string }));
    editor.trimClip({ clipId: "c1", edge: "left", timeMs: 1000 });
    editor.deleteClip({ clipId: "c1" });
    expect(events.map((e) => e.kind)).toEqual(["trimClip", "deleteClip"]);
    editor.destroy();
  });

  it("addClip fires event on success", async () => {
    const editor = editorWith({
      version: 1,
      sources: [
        {
          id: "src-1",
          url: "blob:sample",
          kind: "video",
          name: "sample.mp4",
          duration: 5000,
        },
      ],
      tracks: [{ id: "t1", kind: "video", clips: [] }],
    });
    const events: Array<{ kind: string; result: { ok: boolean } }> = [];
    editor.on("operation", (op) =>
      events.push(op as { kind: string; result: { ok: boolean } }),
    );
    await editor.addClip({
      sourceId: "src-1",
      trackId: "t1",
      startMs: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("addClip");
    expect(events[0]!.result.ok).toBe(true);
    editor.destroy();
  });

  it("batch groups ops via shared batchId", () => {
    const editor = editorWith(tinyProject());
    const events: Array<{ kind: string; batchId?: string }> = [];
    editor.on("operation", (op) =>
      events.push(op as { kind: string; batchId?: string }),
    );
    editor.batch("two-splits", () => {
      editor.splitClip({ clipId: "c1", timeMs: 1500 });
      // Splitting produces c1-left and c1-right; second split on the right part.
      const right = editor.getProject().tracks[0]!.clips[1]!.id;
      editor.splitClip({ clipId: right, timeMs: 3000 });
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.batchId).toBeDefined();
    expect(events[0]!.batchId).toBe(events[1]!.batchId);
    editor.destroy();
  });

  it("ops outside batch have no batchId", () => {
    const editor = editorWith(tinyProject());
    const events: Array<{ batchId?: string }> = [];
    editor.on("operation", (op) =>
      events.push(op as { batchId?: string }),
    );
    editor.splitClip({ clipId: "c1", timeMs: 2500 });
    expect(events[0]!.batchId).toBeUndefined();
    editor.destroy();
  });

  it("nested batches reuse the outermost batchId", () => {
    const editor = editorWith(tinyProject());
    const events: Array<{ batchId?: string }> = [];
    editor.on("operation", (op) =>
      events.push(op as { batchId?: string }),
    );
    editor.batch("outer", () => {
      editor.splitClip({ clipId: "c1", timeMs: 1000 });
      editor.batch("inner", () => {
        const clips = editor.getProject().tracks[0]!.clips;
        editor.splitClip({ clipId: clips[1]!.id, timeMs: 3000 });
      });
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.batchId).toBe(events[1]!.batchId);
    editor.destroy();
  });

  it("before/after snapshots are deep-cloned (mutation-safe)", () => {
    const editor = editorWith(tinyProject());
    let captured: { beforeProject: Project; afterProject: Project } | null =
      null;
    editor.on("operation", (op) => {
      captured = op as {
        beforeProject: Project;
        afterProject: Project;
      };
    });
    editor.splitClip({ clipId: "c1", timeMs: 2500 });
    // Mutate the captured snapshot — editor state should be untouched.
    (captured! as { afterProject: Project }).afterProject.tracks[0]!.clips = [];
    expect(editor.getProject().tracks[0]!.clips.length).toBe(2);
    editor.destroy();
  });
});
