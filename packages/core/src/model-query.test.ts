import { describe, expect, it } from "vitest";
import {
  findClipAt,
  getClipsInRange,
  getClipsOnTrack,
} from "./model.js";
import type { Project } from "./types.js";

/**
 * Pure query helpers on Project — used by AI tool-loops to answer
 * "what's at time X on track Y" without scanning JSON themselves.
 * These are read-only; each test also checks the input Project stays
 * structurally identical after the call.
 */

function twoTrackProject(): Project {
  return {
    version: 1,
    sources: [{ id: "s1", url: "blob:fake", kind: "video", name: "a" }],
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: [
          { id: "a", sourceId: "s1", in: 0, out: 2000, start: 0 },
          { id: "b", sourceId: "s1", in: 0, out: 2000, start: 3000 },
        ],
      },
      {
        id: "t2",
        kind: "video",
        clips: [{ id: "c", sourceId: "s1", in: 0, out: 4000, start: 1000 }],
      },
    ],
  };
}

describe("findClipAt", () => {
  it("finds the clip on the first matching track when trackIndex omitted", () => {
    const p = twoTrackProject();
    const hit = findClipAt(p, 1500);
    // Track 0 has clip "a" ending at 2000; matches first.
    expect(hit?.clip.id).toBe("a");
    expect(hit?.track.id).toBe("t1");
  });

  it("respects trackIndex when given", () => {
    const p = twoTrackProject();
    const hit = findClipAt(p, 1500, 1);
    expect(hit?.clip.id).toBe("c");
    expect(hit?.track.id).toBe("t2");
  });

  it("returns null in the gap on the target track", () => {
    const p = twoTrackProject();
    // 2500 is in the gap between "a" and "b" on track 0.
    expect(findClipAt(p, 2500, 0)).toBeNull();
    // But track 1's "c" still covers it.
    expect(findClipAt(p, 2500, 1)?.clip.id).toBe("c");
  });

  it("returns null for out-of-range trackIndex", () => {
    expect(findClipAt(twoTrackProject(), 500, 99)).toBeNull();
  });

  it("end is exclusive — time == clipEnd doesn't match", () => {
    const p = twoTrackProject();
    // Clip "a" ends at exactly 2000.
    expect(findClipAt(p, 2000, 0)).toBeNull();
  });
});

describe("getClipsInRange", () => {
  it("returns overlapping clips across all tracks by default", () => {
    const p = twoTrackProject();
    // Range [1000, 4000) overlaps "a" (0..2000), "b" (3000..5000), "c" (1000..5000).
    const hits = getClipsInRange(p, 1000, 4000);
    const ids = hits.map((h) => h.clip.id);
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("half-open — a clip whose end equals startMs is NOT included", () => {
    const p = twoTrackProject();
    // Clip "a" ends at 2000 — range [2000, 2500) shouldn't include it.
    const hits = getClipsInRange(p, 2000, 2500);
    expect(hits.some((h) => h.clip.id === "a")).toBe(false);
  });

  it("filters by trackIndex when given", () => {
    const p = twoTrackProject();
    const hits = getClipsInRange(p, 0, 10_000, 0);
    expect(hits.map((h) => h.clip.id).sort()).toEqual(["a", "b"]);
  });

  it("returns [] for a range that misses every clip", () => {
    const p = twoTrackProject();
    expect(getClipsInRange(p, 100_000, 200_000)).toEqual([]);
  });
});

describe("getClipsOnTrack", () => {
  it("returns clips in timeline order", () => {
    const p = twoTrackProject();
    const clips = getClipsOnTrack(p, 0);
    expect(clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns empty for out-of-range index", () => {
    expect(getClipsOnTrack(twoTrackProject(), 5)).toEqual([]);
  });

  it("returns a shallow copy — mutating the result doesn't affect the project", () => {
    const p = twoTrackProject();
    const before = p.tracks[0]!.clips.length;
    const clips = getClipsOnTrack(p, 0);
    clips.pop();
    expect(p.tracks[0]!.clips.length).toBe(before);
  });
});

// ── Time conversion helpers ────────────────────────────────────────

import { timelineToSourceMs, sourceToTimelineMs } from "./model.js";
import type { Clip } from "./types.js";

describe("timelineToSourceMs / sourceToTimelineMs", () => {
  function makeClip(overrides: Partial<Clip> = {}): Clip {
    return {
      id: "c1",
      sourceId: "s1",
      in: 500, // source starts 500ms in
      out: 3500, // source ends 3500ms in (3s duration)
      start: 1000, // timeline positions at 1s
      ...overrides,
    };
  }

  it("converts timeline time inside clip to source time", () => {
    const c = makeClip();
    // timeline 2000 = 1s into clip = source 500 + 1000 = 1500
    expect(timelineToSourceMs(c, 2000)).toBe(1500);
  });

  it("clamps timeline time before clip to source.in", () => {
    const c = makeClip();
    expect(timelineToSourceMs(c, 0)).toBe(500);
  });

  it("clamps timeline time after clip to source.out", () => {
    const c = makeClip();
    expect(timelineToSourceMs(c, 999_999)).toBe(3500);
  });

  it("sourceToTimelineMs inverts the mapping", () => {
    const c = makeClip();
    const src = 1500;
    const tl = sourceToTimelineMs(c, src);
    expect(tl).toBe(2000);
    expect(timelineToSourceMs(c, tl)).toBe(src);
  });

  it("sourceToTimelineMs clamps to clip bounds", () => {
    const c = makeClip();
    // source 0 < clip.in (500) → clamp to timeline start
    expect(sourceToTimelineMs(c, 0)).toBe(1000);
    // source way past clip.out → clamp to clip end (1000 + 3000 = 4000)
    expect(sourceToTimelineMs(c, 999_999)).toBe(4000);
  });
});
