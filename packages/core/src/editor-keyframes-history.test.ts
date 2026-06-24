import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "./editor.js";
import type { PlaybackEngine } from "./playback/index.js";
import type { Project } from "./types.js";

/**
 * Focused undo / redo coverage for the keyframe mutators + the
 * boundary-keyframe-on-split logic. Architecturally undo is "free"
 * (HistoryStack snapshots full Project JSON, every mutator calls
 * pushHistory), so these tests target the cases that ACTUALLY break:
 *   - redo paths (only undo was covered before)
 *   - split → undo → synthetic seam keyframes vanish
 *   - atomicity of resetKeyframesAtTime (1 undo restores 3 props)
 *   - selectedKeyframe state when its target disappears under undo
 *   - mixed sequences across multiple mutator kinds
 *   - history-stack cap of 50 entries
 */

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

function seedProject(): Project {
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

function kfs(editor: Editor, clipId = "c1") {
  return (
    editor.getProject().tracks[0]?.clips.find((c) => c.id === clipId)
      ?.keyframes ?? []
  );
}

describe("keyframe undo / redo", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("redo replays each kf mutator in order", () => {
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 })!;
    editor.moveKeyframe("c1", id, 2500);
    editor.setKeyframeValue("c1", id, 2);
    // Undo all the way back to "no keyframes".
    editor.undo();
    editor.undo();
    editor.undo();
    expect(kfs(editor)).toHaveLength(0);
    // Now redo back forward — each step must restore one mutation.
    editor.redo();
    expect(kfs(editor)).toHaveLength(1);
    expect(kfs(editor)[0]?.time).toBe(1000);
    expect(kfs(editor)[0]?.value).toBe(1.5);
    editor.redo();
    expect(kfs(editor)[0]?.time).toBe(2500);
    expect(kfs(editor)[0]?.value).toBe(1.5);
    editor.redo();
    expect(kfs(editor)[0]?.value).toBe(2);
    editor.destroy();
  });

  it("undo a split drops synthetic seam keyframes AND restores the merged clip", () => {
    // Repro of the regression we'd hit if splitClipAt's per-prop
    // boundary insertion weren't snapshot before mutation: undo
    // would leave the seam kfs orphaned on the wrong clip.
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "scale", { time: 500, value: 1 });
    editor.addKeyframe("c1", "scale", { time: 3000, value: 2 });
    expect(kfs(editor)).toHaveLength(2);
    editor.split(2000); // boundary insertion mid-ramp
    let clips = editor.getProject().tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(2);
    // Left half: kf@500 + synthesized seam @2000; right half: seam@0 + kf@1000.
    const totalAfterSplit =
      (clips[0]?.keyframes?.length ?? 0) + (clips[1]?.keyframes?.length ?? 0);
    expect(totalAfterSplit).toBe(4);
    editor.undo();
    clips = editor.getProject().tracks[0]?.clips ?? [];
    // Back to one clip with EXACTLY the two original kfs — no
    // synthetic seam left over.
    expect(clips).toHaveLength(1);
    expect(clips[0]?.id).toBe("c1");
    expect(kfs(editor)).toHaveLength(2);
    expect(kfs(editor).map((k) => k.time).sort((a, b) => a - b)).toEqual([
      500, 3000,
    ]);
    // Redo the split — same boundaries reappear.
    editor.redo();
    clips = editor.getProject().tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(2);
  });

  it("toggleKeyframeAtPlayhead's REMOVE path undoes back to 3 kfs", () => {
    const stub = makeStubEngine();
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => stub,
    });
    editor.setSelection("c1");
    editor.seek(1500);
    expect(editor.toggleKeyframeAtPlayhead()).toBe(true); // 3 kfs added
    expect(kfs(editor)).toHaveLength(3);
    expect(editor.toggleKeyframeAtPlayhead()).toBe(true); // 3 kfs removed
    expect(kfs(editor)).toHaveLength(0);
    editor.undo(); // remove undone → 3 kfs back
    expect(kfs(editor)).toHaveLength(3);
    editor.undo(); // add undone → 0 again
    expect(kfs(editor)).toHaveLength(0);
    editor.destroy();
  });

  it("resetKeyframesAtTime is atomic — one undo restores all three prop values", () => {
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    editor.addKeyframe("c1", "panX", { time: 1000, value: 100 });
    editor.addKeyframe("c1", "panY", { time: 1000, value: 50 });
    editor.addKeyframe("c1", "scale", { time: 1000, value: 2 });
    expect(kfs(editor)).toHaveLength(3);
    expect(editor.resetKeyframesAtTime("c1", 1000)).toBe(true);
    // All three pinned to identity.
    const reset = kfs(editor);
    expect(reset.find((k) => k.prop === "panX")?.value).toBe(0);
    expect(reset.find((k) => k.prop === "panY")?.value).toBe(0);
    expect(reset.find((k) => k.prop === "scale")?.value).toBe(1);
    // ONE undo brings all three back.
    expect(editor.undo()).toBe(true);
    const restored = kfs(editor);
    expect(restored.find((k) => k.prop === "panX")?.value).toBe(100);
    expect(restored.find((k) => k.prop === "panY")?.value).toBe(50);
    expect(restored.find((k) => k.prop === "scale")?.value).toBe(2);
    editor.destroy();
  });

  it("undo that removes a selected keyframe also clears the selection", () => {
    // Selection is editor-state (NOT in Project JSON snapshot). Undo
    // restoring an old project can leave selectedKeyframe pointing at
    // a kf id that no longer exists — the editor must defend against
    // dangling refs by clearing.
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 })!;
    editor.setSelectedKeyframe({ clipId: "c1", keyframeId: id });
    expect(editor.getSelectedKeyframe()?.keyframeId).toBe(id);
    editor.undo(); // kf removed
    expect(kfs(editor)).toHaveLength(0);
    expect(editor.getSelectedKeyframe()).toBeNull();
    editor.destroy();
  });

  it("mixed sequence: kf add → clip move → kf value change — undo each in reverse", () => {
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1.5 })!;
    editor.moveClip("c1", { start: 500 });
    editor.setKeyframeValue("c1", id, 2);
    expect(kfs(editor)[0]?.value).toBe(2);
    expect(editor.getProject().tracks[0]?.clips[0]?.start).toBe(500);
    // Undo the value change.
    editor.undo();
    expect(kfs(editor)[0]?.value).toBe(1.5);
    expect(editor.getProject().tracks[0]?.clips[0]?.start).toBe(500);
    // Undo the move.
    editor.undo();
    expect(editor.getProject().tracks[0]?.clips[0]?.start).toBe(0);
    expect(kfs(editor)).toHaveLength(1);
    // Undo the kf add.
    editor.undo();
    expect(kfs(editor)).toHaveLength(0);
    editor.destroy();
  });

  it("history is capped — beyond 50 mutations the oldest are forgotten cleanly", () => {
    // We don't expose the cap as a constant; just push lots of
    // mutations and verify (a) the editor stays responsive, (b)
    // undo stops at some bounded depth, (c) the state after that
    // bound is the OLDEST kept snapshot — not corrupt.
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1 })!;
    // 60 value changes → 50 should be kept, 10 lost.
    for (let i = 0; i < 60; i += 1) {
      editor.setKeyframeValue("c1", id, 2 + i);
    }
    // Undo as many times as possible.
    let undoCount = 0;
    while (editor.undo()) undoCount += 1;
    // Cap is 50 history entries — exactly that many undos are
    // expected. Once we run out, canUndo flips false.
    expect(undoCount).toBe(50);
    expect(editor.canUndo()).toBe(false);
    // State should be a coherent project, not corrupt. The kf is
    // still present (we don't unwind ALL the way to "no kf" because
    // the original add fell off the bottom of the 50-entry window).
    expect(kfs(editor)).toHaveLength(1);
    editor.destroy();
  });

  it("redo stack is cleared when a new mutation lands after an undo", () => {
    const editor = Editor.create({
      container,
      project: seedProject(),
      playbackEngine: () => makeStubEngine(),
    });
    const id = editor.addKeyframe("c1", "scale", { time: 1000, value: 1 })!;
    editor.setKeyframeValue("c1", id, 2);
    editor.undo(); // value back to 1, redo available
    expect(editor.canRedo()).toBe(true);
    // A NEW mutation must invalidate the redo stack.
    editor.setKeyframeValue("c1", id, 3);
    expect(editor.canRedo()).toBe(false);
    expect(kfs(editor)[0]?.value).toBe(3);
    editor.destroy();
  });
});
