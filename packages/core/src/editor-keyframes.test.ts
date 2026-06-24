import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "./editor.js";
import type { PlaybackEngine } from "./playback/index.js";
import type { Project } from "./types.js";

function makeStubEngine(): PlaybackEngine {
  let time = 0;
  let playing = false;
  return {
    setProject() {},
    play() {
      playing = true;
    },
    pause() {
      playing = false;
    },
    isPlaying: () => playing,
    getTime: () => time,
    seek(ms) {
      time = ms;
    },
    destroy() {},
  };
}

function tinyProject(): Project {
  return {
    version: 1,
    sources: [{ id: "s1", url: "blob:x", kind: "video" }],
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: [{ id: "c1", sourceId: "s1", in: 0, out: 5000, start: 0 }],
      },
    ],
  };
}

describe("Editor.keyframes — per-property mutators + history + selection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("isKeyframesEnabled defaults to false; setKeyframesEnabled emits + flips", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    expect(editor.isKeyframesEnabled()).toBe(false);
    let seen = false;
    editor.on("keyframesEnabledChange", ({ enabled }) => {
      seen = enabled;
    });
    editor.setKeyframesEnabled(true);
    expect(editor.isKeyframesEnabled()).toBe(true);
    expect(seen).toBe(true);
    editor.destroy();
  });

  it("addKeyframe(prop) at playhead uses currently interpolated value", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    stub.seek(1000);
    const id = editor.addKeyframe("c1", "scale");
    expect(id).not.toBeNull();
    const clip = editor.getProject().tracks[0]?.clips[0];
    expect(clip?.keyframes).toHaveLength(1);
    expect(clip?.keyframes?.[0]).toMatchObject({
      prop: "scale",
      time: 1000,
      value: 1,
    });
    editor.destroy();
  });

  it("addKeyframe respects explicit value override", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 500, value: 2 });
    expect(id).not.toBeNull();
    const kf = editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0];
    expect(kf).toMatchObject({ prop: "scale", time: 500, value: 2 });
    editor.destroy();
  });

  it("addKeyframe at the same time on the same prop UPSERTS the value", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 });
    editor.addKeyframe("c1", "scale", { time: 1000, value: 2 });
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    expect(kfs).toHaveLength(1);
    expect(kfs[0]?.value).toBe(2);
    editor.destroy();
  });

  it("different props at the same time are independent keyframes", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "panX", { time: 1000, value: 50 });
    editor.addKeyframe("c1", "scale", { time: 1000, value: 2 });
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    expect(kfs).toHaveLength(2);
    expect(kfs.some((k) => k.prop === "panX" && k.value === 50)).toBe(true);
    expect(kfs.some((k) => k.prop === "scale" && k.value === 2)).toBe(true);
    editor.destroy();
  });

  it("removeKeyframe drops one entry; sets keyframes to undefined when last", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 2 });
    expect(editor.removeKeyframe("c1", id!)).toBe(true);
    expect(editor.getProject().tracks[0]?.clips[0]?.keyframes).toBeUndefined();
    editor.destroy();
  });

  it("moveKeyframe clamps + rejects collision on the SAME prop", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const a = editor.addKeyframe("c1", "scale", { time: 1000, value: 1 });
    const b = editor.addKeyframe("c1", "scale", { time: 3000, value: 2 });
    // Move b before a — they're on the same prop, so re-sort.
    expect(editor.moveKeyframe("c1", b!, 500)).toBe(true);
    // Try to collide a with b (now at 500).
    expect(editor.moveKeyframe("c1", a!, 500)).toBe(false);
    // Move a to a free slot.
    expect(editor.moveKeyframe("c1", a!, 2500)).toBe(true);
    editor.destroy();
  });

  it("setKeyframeValue updates the single value of one kf", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1 });
    expect(editor.setKeyframeValue("c1", id!, 1.75)).toBe(true);
    const kf = editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0];
    expect(kf?.value).toBeCloseTo(1.75);
    expect(editor.setKeyframeValue("c1", id!, 1.75)).toBe(false); // no-op
    editor.destroy();
  });

  it("setValueAtPlayhead writes static base when no keyframes exist", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    stub.seek(1500);
    expect(editor.setValueAtPlayhead("c1", "scale", 1.5)).toBe(true);
    const clip = editor.getProject().tracks[0]?.clips[0];
    expect(clip?.scale).toBe(1.5);
    expect(clip?.keyframes).toBeUndefined();
    editor.destroy();
  });

  it("setValueAtPlayhead upserts a keyframe once the prop is animated", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    stub.seek(0);
    editor.addKeyframe("c1", "scale", { time: 0, value: 1 });
    stub.seek(2000);
    editor.setValueAtPlayhead("c1", "scale", 2);
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    expect(kfs).toHaveLength(2);
    expect(kfs.find((k) => k.time === 2000)?.value).toBe(2);
    editor.destroy();
  });

  it("undo restores state before add / move / value-change", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 });
    editor.moveKeyframe("c1", id!, 2500);
    editor.setKeyframeValue("c1", id!, 2);
    editor.undo(); // value back to 1.5
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.value,
    ).toBe(1.5);
    editor.undo(); // time back to 1000
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.time,
    ).toBe(1000);
    editor.undo(); // keyframe removed
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes,
    ).toBeUndefined();
    editor.destroy();
  });

  it("selecting a keyframe also selects its parent clip", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 });
    editor.setSelectedKeyframe({ clipId: "c1", keyframeId: id! });
    expect(editor.getSelection()).toBe("c1");
    editor.destroy();
  });

  it("toggleKeyframeAtPlayhead adds 3 keyframes (panX/panY/scale) when none exist", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    editor.setSelection("c1");
    stub.seek(1000);
    expect(editor.toggleKeyframeAtPlayhead()).toBe(true);
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    expect(kfs).toHaveLength(3);
    const props = new Set(kfs.map((k) => k.prop));
    expect(props).toEqual(new Set(["panX", "panY", "scale"]));
    // Toggle again at the same time → removes them.
    expect(editor.toggleKeyframeAtPlayhead()).toBe(true);
    expect(editor.getProject().tracks[0]?.clips[0]?.keyframes).toBeUndefined();
    editor.destroy();
  });

  it("projects without keyframes round-trip identically through setProject", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const beforeJson = JSON.stringify(editor.getProject());
    editor.setProject(JSON.parse(beforeJson));
    expect(JSON.stringify(editor.getProject())).toBe(beforeJson);
    editor.destroy();
  });

  it("splitClipAt inserts interpolated boundary keyframes per property at the seam", () => {
    // Cut at 2000 lands BETWEEN scale@500 (v=1) and scale@3000 (v=2).
    // Expected boundary scale = 1 + (1500/2500)*(2-1) = 1.6.
    // panX has a single kf at 3000 (v=100) → before-first rule means
    // value at cut is held at first kf's value = 100.
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "scale", { time: 500, value: 1 });
    editor.addKeyframe("c1", "scale", { time: 3000, value: 2 });
    editor.addKeyframe("c1", "panX", { time: 3000, value: 100 });
    editor.split(2000);
    const clips = editor.getProject().tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(2);

    const leftScale = (clips[0]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    expect(leftScale).toHaveLength(2);
    expect(leftScale.find((k) => k.time === 500)?.value).toBe(1);
    expect(leftScale.find((k) => k.time === 2000)?.value).toBeCloseTo(1.6, 6);

    const leftPanX = (clips[0]?.keyframes ?? []).filter(
      (k) => k.prop === "panX",
    );
    expect(leftPanX).toHaveLength(1);
    expect(leftPanX[0]).toMatchObject({ time: 2000, value: 100 });

    const rightScale = (clips[1]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    expect(rightScale).toHaveLength(2);
    expect(rightScale.find((k) => k.time === 0)?.value).toBeCloseTo(1.6, 6);
    expect(rightScale.find((k) => k.time === 1000)?.value).toBe(2);

    const rightPanX = (clips[1]?.keyframes ?? []).filter(
      (k) => k.prop === "panX",
    );
    expect(rightPanX).toHaveLength(2);
    expect(rightPanX.find((k) => k.time === 0)?.value).toBe(100);
    expect(rightPanX.find((k) => k.time === 1000)?.value).toBe(100);
    editor.destroy();
  });

  it("splitClipAt — cut exactly on a keyframe shares it across the seam, no duplicate", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "scale", { time: 1000, value: 1 });
    editor.addKeyframe("c1", "scale", { time: 2000, value: 2 });
    editor.addKeyframe("c1", "scale", { time: 3000, value: 3 });
    editor.split(2000); // cut sits exactly on scale@2000
    const clips = editor.getProject().tracks[0]?.clips ?? [];
    const leftScale = (clips[0]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    const rightScale = (clips[1]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    // Left: kf@1000 (v=1) + the seam kf@2000 (v=2). No synthetic
    // duplicate at t=2000 because the seam keyframe already pins it.
    expect(leftScale.map((k) => ({ time: k.time, value: k.value }))).toEqual([
      { time: 1000, value: 1 },
      { time: 2000, value: 2 },
    ]);
    // Right: cloned seam at t=0 + the shifted kf@3000 → t=1000.
    expect(
      rightScale.map((k) => ({ time: k.time, value: k.value })).sort((a, b) =>
        a.time - b.time,
      ),
    ).toEqual([
      { time: 0, value: 2 },
      { time: 1000, value: 3 },
    ]);
    editor.destroy();
  });

  it("splitClipAt — cut before the first keyframe still gives both halves a pinned value", () => {
    // Original clip: only kf@3000 (scale=2). Effective value
    // anywhere before t=3000 is held at 2. Cutting at 1000 should
    // produce two halves that BOTH evaluate to 2 at the seam.
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "scale", { time: 3000, value: 2 });
    editor.split(1000);
    const clips = editor.getProject().tracks[0]?.clips ?? [];
    const leftScale = (clips[0]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    const rightScale = (clips[1]?.keyframes ?? []).filter(
      (k) => k.prop === "scale",
    );
    // Left: only the synthesised seam kf — value 2 (held from
    // first-kf rule). A single kf means constant scale=2 across the
    // whole left half, matching the original.
    expect(leftScale).toEqual([
      expect.objectContaining({ prop: "scale", time: 1000, value: 2 }),
    ]);
    // Right: seam kf@0 (v=2) + original kf shifted to t=2000 (v=2).
    expect(
      rightScale.map((k) => ({ time: k.time, value: k.value })).sort((a, b) =>
        a.time - b.time,
      ),
    ).toEqual([
      { time: 0, value: 2 },
      { time: 2000, value: 2 },
    ]);
    editor.destroy();
  });

  it("migrates legacy {time, x, y, scale} tuple keyframes on setProject", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.setProject({
      version: 1,
      sources: [{ id: "s1", url: "blob:x", kind: "video" }],
      tracks: [
        {
          id: "t1",
          kind: "video",
          clips: [
            {
              id: "c1",
              sourceId: "s1",
              in: 0,
              out: 5000,
              start: 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              keyframes: [
                { id: "old1", time: 1000, x: 50, y: 0, scale: 1.5 },
                { id: "old2", time: 3000, x: 100, y: 0, scale: 2 },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ] as any,
            },
          ],
        },
      ],
    });
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    // 2 tuples × 3 props = 6 per-property entries.
    expect(kfs).toHaveLength(6);
    const props = new Set(kfs.map((k) => k.prop));
    expect(props).toEqual(new Set(["panX", "panY", "scale"]));
    editor.destroy();
  });

  it("setKeyframeEasing — round-trip, default strip, no-op when unchanged", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1 })!;
    // Default is "linear" — implied by missing field.
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.easing,
    ).toBeUndefined();
    // Set to easeIn.
    expect(editor.setKeyframeEasing("c1", id, "easeIn")).toBe(true);
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.easing,
    ).toBe("easeIn");
    // Setting the same value again is a no-op (no history bump).
    expect(editor.setKeyframeEasing("c1", id, "easeIn")).toBe(false);
    // Going back to linear STRIPS the field — keeps serialized
    // project minimal (no `easing: "linear"` everywhere).
    expect(editor.setKeyframeEasing("c1", id, "linear")).toBe(true);
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.easing,
    ).toBeUndefined();
    editor.destroy();
  });

  it("setKeyframesEasingAtTime — batch on all 3 props at a moment in one history entry", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    // Toolbar-style add: 3 kfs at the playhead.
    editor.setSelection("c1");
    editor.seek(1000);
    editor.toggleKeyframeAtPlayhead();
    expect(editor.getProject().tracks[0]?.clips[0]?.keyframes).toHaveLength(3);
    expect(editor.setKeyframesEasingAtTime("c1", 1000, "easeOut")).toBe(true);
    const after = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    for (const k of after) expect(k.easing).toBe("easeOut");
    // ONE undo reverts all three.
    editor.undo();
    const reverted = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    for (const k of reverted) expect(k.easing).toBeUndefined();
    // No-op when nothing changes.
    expect(editor.setKeyframesEasingAtTime("c1", 1000, "linear")).toBe(false);
    // No matching kfs at that time → returns false.
    expect(editor.setKeyframesEasingAtTime("c1", 4500, "easeIn")).toBe(false);
    editor.destroy();
  });

  it("seekToClipEdge — start lands on clip.start; end lands 1ms inside so kf-toggle still finds the clip", () => {
    const editor = Editor.create({
      container,
      project: {
        version: 1,
        sources: [{ id: "s1", url: "blob:x", kind: "video" }],
        tracks: [
          {
            id: "t1",
            kind: "video",
            clips: [
              {
                id: "c1",
                sourceId: "s1",
                in: 0,
                out: 4000,
                // Clip starts at 1000ms on the timeline so we can tell
                // a "playhead = clip.start" seek apart from "playhead = 0".
                start: 1000,
              },
            ],
          },
        ],
      },
      playbackEngine: () => makeStubEngine(),
    });
    expect(editor.seekToClipEdge("c1", "start")).toBe(true);
    expect(editor.getTime()).toBe(1000); // clip.start
    expect(editor.seekToClipEdge("c1", "end")).toBe(true);
    // clip.start + (out - in) = 1000 + 4000 = 5000 → seek lands at 4999
    // (one ms shy of the seam so the playhead stays inside the clip).
    expect(editor.getTime()).toBe(4999);
    // No selection → selected-edge convenience returns false.
    editor.setSelection(null);
    expect(editor.seekToSelectedClipEdge("end")).toBe(false);
    // With selection set, end-seek + toggle should drop kfs into c1
    // — proves the -1ms backoff keeps toggleKeyframeAtPlayhead pointed
    // at the right clip even at the very end. Note the second
    // seek-to-end returns FALSE (already there from the explicit call
    // above), which is the documented "no-op when playhead == target"
    // contract. The toggle still runs against the same playhead.
    editor.setSelection("c1");
    expect(editor.seekToSelectedClipEdge("end")).toBe(false);
    expect(editor.getTime()).toBe(4999);
    expect(editor.toggleKeyframeAtPlayhead()).toBe(true);
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes ?? [];
    expect(kfs).toHaveLength(3); // panX/panY/scale at the end
    expect(kfs.every((k) => k.time === 3999)).toBe(true);
    editor.destroy();
  });
});
