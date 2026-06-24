import { describe, expect, it } from "vitest";
import type { Clip } from "../types.js";
import { applyEasing, getEffectiveTransform } from "./interpolate.js";
import { IDENTITY_TRANSFORM } from "./types.js";

function clip(overrides?: Partial<Clip>): Clip {
  return {
    id: "c1",
    sourceId: "s1",
    in: 0,
    out: 5000,
    start: 0,
    ...overrides,
  };
}

describe("getEffectiveTransform — per-property keyframes", () => {
  it("returns identity when no keyframes and no static base", () => {
    expect(getEffectiveTransform(clip(), 1000)).toEqual(IDENTITY_TRANSFORM);
  });

  it("falls back to the static base for a prop without keyframes", () => {
    const c = clip({ panX: 50, scale: 1.5 });
    expect(getEffectiveTransform(c, 1000)).toEqual({
      panX: 50,
      panY: 0,
      scale: 1.5,
    });
  });

  it("with a single keyframe for a prop, holds that value constantly", () => {
    const c = clip({
      keyframes: [{ id: "kf1", prop: "scale", time: 2000, value: 1.5 }],
    });
    expect(getEffectiveTransform(c, 0)).toEqual({ panX: 0, panY: 0, scale: 1.5 });
    expect(getEffectiveTransform(c, 4999)).toEqual({
      panX: 0,
      panY: 0,
      scale: 1.5,
    });
  });

  it("before the first keyframe of a prop, holds the first's value", () => {
    const c = clip({
      keyframes: [
        { id: "k1", prop: "panX", time: 1000, value: 50 },
        { id: "k2", prop: "panX", time: 3000, value: 200 },
      ],
    });
    expect(getEffectiveTransform(c, 0).panX).toBe(50);
    expect(getEffectiveTransform(c, 999).panX).toBe(50);
  });

  it("after the last keyframe of a prop, holds the last's value", () => {
    const c = clip({
      keyframes: [
        { id: "k1", prop: "panX", time: 1000, value: 50 },
        { id: "k2", prop: "panX", time: 3000, value: 200 },
      ],
    });
    expect(getEffectiveTransform(c, 3000).panX).toBe(200);
    expect(getEffectiveTransform(c, 4999).panX).toBe(200);
  });

  it("interpolates linearly between two keyframes (midpoint)", () => {
    const c = clip({
      keyframes: [
        { id: "k1", prop: "panX", time: 1000, value: 0 },
        { id: "k2", prop: "panX", time: 3000, value: 200 },
        { id: "k3", prop: "scale", time: 1000, value: 1 },
        { id: "k4", prop: "scale", time: 3000, value: 2 },
      ],
    });
    expect(getEffectiveTransform(c, 2000)).toEqual({
      panX: 100,
      panY: 0,
      scale: 1.5,
    });
  });

  it("each prop animates independently", () => {
    // panX animates 0→100 between t=0..1000; scale stays at static 1.5
    // because it has no keyframes; panY stays at default 0.
    const c = clip({
      scale: 1.5,
      keyframes: [
        { id: "k1", prop: "panX", time: 0, value: 0 },
        { id: "k2", prop: "panX", time: 1000, value: 100 },
      ],
    });
    expect(getEffectiveTransform(c, 500)).toEqual({
      panX: 50,
      panY: 0,
      scale: 1.5,
    });
  });

  it("at an exact keyframe time, returns that keyframe's value", () => {
    const c = clip({
      keyframes: [
        { id: "k1", prop: "scale", time: 1000, value: 1 },
        { id: "k2", prop: "scale", time: 3000, value: 2 },
        { id: "k3", prop: "scale", time: 5000, value: 3 },
      ],
    });
    expect(getEffectiveTransform(c, 3000).scale).toBe(2);
  });

  it("three keyframes pick the right bracketing pair", () => {
    const c = clip({
      keyframes: [
        { id: "k1", prop: "scale", time: 0, value: 1 },
        { id: "k2", prop: "scale", time: 1000, value: 2 },
        { id: "k3", prop: "scale", time: 2000, value: 1 },
      ],
    });
    expect(getEffectiveTransform(c, 500).scale).toBeCloseTo(1.5);
    expect(getEffectiveTransform(c, 1500).scale).toBeCloseTo(1.5);
    expect(getEffectiveTransform(c, 1000).scale).toBe(2);
  });

  it("static + keyframes coexist for different props", () => {
    // panX has static base 80, panY animates 0→100, scale stays 1.
    const c = clip({
      panX: 80,
      keyframes: [
        { id: "k1", prop: "panY", time: 0, value: 0 },
        { id: "k2", prop: "panY", time: 1000, value: 100 },
      ],
    });
    expect(getEffectiveTransform(c, 500)).toEqual({
      panX: 80,
      panY: 50,
      scale: 1,
    });
  });

  it("missing easing field on a kf is treated as linear (back-compat)", () => {
    // Pre-easing projects have no `easing` field at all. Must not
    // throw, must lerp linearly.
    const c = clip({
      keyframes: [
        { id: "k1", prop: "scale", time: 0, value: 1 },
        { id: "k2", prop: "scale", time: 1000, value: 2 },
      ],
    });
    expect(getEffectiveTransform(c, 500).scale).toBeCloseTo(1.5);
  });

  it("easing is taken from the LEAVING kf (a→b is shaped by a.easing)", () => {
    // panX: kf@0 (v=0, easeIn) → kf@1000 (v=100). At t=500, eased
    // value follows easeIn (t³): 0.5³ = 0.125 → value 12.5.
    const c = clip({
      keyframes: [
        { id: "k1", prop: "panX", time: 0, value: 0, easing: "easeIn" },
        { id: "k2", prop: "panX", time: 1000, value: 100 },
      ],
    });
    expect(getEffectiveTransform(c, 500).panX).toBeCloseTo(12.5, 5);
    // Endpoints stay on the value regardless of curve.
    expect(getEffectiveTransform(c, 0).panX).toBe(0);
    expect(getEffectiveTransform(c, 1000).panX).toBe(100);
  });

  it("applyEasing — endpoint identities + monotonicity sanity", () => {
    for (const kind of ["linear", "easeIn", "easeOut", "easeInOut"] as const) {
      expect(applyEasing(0, kind)).toBeCloseTo(0, 6);
      expect(applyEasing(1, kind)).toBeCloseTo(1, 6);
    }
    // easeIn pulls the value below linear at t=0.5; easeOut pushes
    // above it. Cubic gives a big gap so this is robust.
    expect(applyEasing(0.5, "easeIn")).toBeLessThan(0.5);
    expect(applyEasing(0.5, "easeOut")).toBeGreaterThan(0.5);
    // easeInOut crosses 0.5 at t=0.5 (symmetric).
    expect(applyEasing(0.5, "easeInOut")).toBeCloseTo(0.5, 6);
  });

  it("each segment can have its own easing", () => {
    // Segment 1: linear (default). Segment 2: easeOut.
    const c = clip({
      keyframes: [
        { id: "k1", prop: "scale", time: 0, value: 1 },
        { id: "k2", prop: "scale", time: 1000, value: 2, easing: "easeOut" },
        { id: "k3", prop: "scale", time: 2000, value: 3 },
      ],
    });
    // Segment 1 mid: linear.
    expect(getEffectiveTransform(c, 500).scale).toBeCloseTo(1.5);
    // Segment 2 mid: easeOut → t=0.5, 1-(1-0.5)³ = 0.875. So
    // value = 2 + 0.875*(3-2) = 2.875.
    expect(getEffectiveTransform(c, 1500).scale).toBeCloseTo(2.875, 5);
  });
});
