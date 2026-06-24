import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "./editor.js";
import type { PlaybackEngine } from "./playback/index.js";
import type { Project } from "./types.js";

/** Minimal engine that does nothing — same pattern as editor.test.ts.
 *  All methods present so the Editor doesn't blow up on its own checks. */
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

describe("Editor.keyframes — mutators + history + selection", () => {
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

  it("addKeyframe creates one at the playhead with current interpolated values", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => stub,
    });
    stub.seek(1000);
    const id = editor.addKeyframe("c1");
    expect(id).not.toBeNull();
    const clip = editor.getProject().tracks[0]?.clips[0];
    expect(clip?.keyframes).toHaveLength(1);
    expect(clip?.keyframes?.[0]).toMatchObject({
      time: 1000,
      x: 0,
      y: 0,
      scale: 1,
    });
    editor.destroy();
  });

  it("addKeyframe with partial values fills missing axes with interpolated values", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 500, scale: 2 });
    expect(id).not.toBeNull();
    const kf = editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0];
    expect(kf).toMatchObject({ time: 500, x: 0, y: 0, scale: 2 });
    editor.destroy();
  });

  it("addKeyframe at duplicate time is a no-op (returns null)", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    expect(editor.addKeyframe("c1", { time: 1000 })).not.toBeNull();
    expect(editor.addKeyframe("c1", { time: 1000 })).toBeNull();
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes,
    ).toHaveLength(1);
    editor.destroy();
  });

  it("removeKeyframe drops the entry and clears the array when empty", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 1000 });
    expect(editor.removeKeyframe("c1", id!)).toBe(true);
    // Array drops to undefined (not empty []) to keep serialized
    // output the same as it was before any keyframes ever existed.
    expect(editor.getProject().tracks[0]?.clips[0]?.keyframes).toBeUndefined();
    editor.destroy();
  });

  it("moveKeyframe clamps to [0, clipDuration] and re-sorts", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const a = editor.addKeyframe("c1", { time: 1000 });
    const b = editor.addKeyframe("c1", { time: 3000 });
    // Move b before a → array should re-sort by time.
    editor.moveKeyframe("c1", b!, 500);
    const kfs = editor.getProject().tracks[0]?.clips[0]?.keyframes;
    expect(kfs?.[0]?.id).toBe(b);
    expect(kfs?.[1]?.id).toBe(a);
    // Negative clamps to 0; out-of-range clamps to duration (5000).
    editor.moveKeyframe("c1", a!, -1000);
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.find(
        (k) => k.id === a,
      )?.time,
    ).toBe(0);
    editor.moveKeyframe("c1", b!, 99999);
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.find(
        (k) => k.id === b,
      )?.time,
    ).toBe(5000);
    editor.destroy();
  });

  it("setKeyframeValues partially overwrites and ignores no-ops", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 1000, x: 10, y: 20, scale: 1 });
    expect(editor.setKeyframeValues("c1", id!, { scale: 1.5 })).toBe(true);
    const kf = editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0];
    expect(kf).toMatchObject({ x: 10, y: 20, scale: 1.5 });
    // Same value again — no-op.
    expect(editor.setKeyframeValues("c1", id!, { scale: 1.5 })).toBe(false);
    editor.destroy();
  });

  it("undo restores the state before an add", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    expect(editor.canUndo()).toBe(false);
    editor.addKeyframe("c1", { time: 1000 });
    expect(editor.canUndo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes,
    ).toBeUndefined();
    editor.destroy();
  });

  it("undo restores the state before a move", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 1000 });
    editor.moveKeyframe("c1", id!, 2500);
    editor.undo(); // undo the move
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.time,
    ).toBe(1000);
    editor.destroy();
  });

  it("undo restores the state before a value change", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", {
      time: 1000,
      x: 0,
      y: 0,
      scale: 1,
    });
    editor.setKeyframeValues("c1", id!, { scale: 2 });
    editor.undo();
    expect(
      editor.getProject().tracks[0]?.clips[0]?.keyframes?.[0]?.scale,
    ).toBe(1);
    editor.destroy();
  });

  it("selecting a keyframe also selects its parent clip", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 1000 });
    expect(editor.getSelection()).toBeNull();
    let clipSel: string | null = null;
    let kfSel: { clipId: string; keyframeId: string } | null = null;
    editor.on("selectionChange", ({ clipId }) => (clipSel = clipId));
    editor.on("keyframeSelectionChange", ({ target }) => (kfSel = target));
    editor.setSelectedKeyframe({ clipId: "c1", keyframeId: id! });
    expect(editor.getSelection()).toBe("c1");
    expect(clipSel).toBe("c1");
    expect(kfSel).toEqual({ clipId: "c1", keyframeId: id });
    editor.destroy();
  });

  it("clearing the clip selection clears any keyframe selection", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", { time: 1000 });
    editor.setSelectedKeyframe({ clipId: "c1", keyframeId: id! });
    editor.setSelection(null);
    expect(editor.getSelectedKeyframe()).toBeNull();
    editor.destroy();
  });

  it("projects without keyframes round-trip through setProject identically", () => {
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

  it("splitClipAt partitions keyframes across the cut (verified via api.split)", () => {
    const editor = Editor.create({
      container,
      project: tinyProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", { time: 500 });
    editor.addKeyframe("c1", { time: 3000 });
    // Split at timeline t=2000 (clip is at start=0, so local=2000).
    editor.split(2000);
    const proj = editor.getProject();
    const clips = proj.tracks[0]?.clips;
    expect(clips).toHaveLength(2);
    const left = clips?.[0];
    const right = clips?.[1];
    // Left keeps the 500-time keyframe (< 2000).
    expect(left?.keyframes).toHaveLength(1);
    expect(left?.keyframes?.[0]?.time).toBe(500);
    // Right gets the 3000-time keyframe, shifted by -2000.
    expect(right?.keyframes).toHaveLength(1);
    expect(right?.keyframes?.[0]?.time).toBe(1000);
    editor.destroy();
  });
});
