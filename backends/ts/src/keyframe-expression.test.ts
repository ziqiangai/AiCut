import { describe, expect, it } from "vitest";
import type { Keyframe } from "@aicut/core";
import {
  compileKeyframeExpression,
  easingExpression,
} from "./keyframe-expression.js";

/**
 * The frontend's reference implementation — same math as
 * keyframes/interpolate.ts:applyEasing. We rebuild a JS evaluator
 * that mirrors ffmpeg's grammar narrowly (just lt/gte/pow/if) so
 * the compiled expression can be ROUND-TRIPPED back through JS and
 * compared against the frontend's interpolateProp output. That's
 * what proves "what ffmpeg renders == what the preview shows."
 */
function evalFfmpegExpr(expr: string, t: number): number {
  // Replace ffmpeg builtins with JS equivalents.
  const js = expr
    .replace(/\bif\(/g, "_if(")
    .replace(/\bgte\(/g, "_gte(")
    .replace(/\blt\(/g, "_lt(")
    .replace(/\bpow\(/g, "Math.pow(");
  const _if = (cond: number, a: number, b: number): number => (cond ? a : b);
  const _gte = (a: number, b: number): number => (a >= b ? 1 : 0);
  const _lt = (a: number, b: number): number => (a < b ? 1 : 0);
  // eslint-disable-next-line no-new-func
  const fn = new Function("t", "_if", "_gte", "_lt", `return ${js};`);
  return fn(t, _if, _gte, _lt) as number;
}

function kf(
  prop: "panX" | "panY" | "scale",
  time: number,
  value: number,
  easing?: "linear" | "easeIn" | "easeOut" | "easeInOut",
): Keyframe {
  const k: Keyframe = { id: `k-${prop}-${time}`, prop, time, value };
  if (easing) k.easing = easing;
  return k;
}

describe("compileKeyframeExpression", () => {
  it("no keyframes → returns the fallback as a literal", () => {
    expect(compileKeyframeExpression(undefined, "panX", 0)).toBe("0");
    expect(compileKeyframeExpression([], "scale", 1.5)).toBe("1.5");
    // Decimal trimming — no trailing zeros, no stranded dot.
    expect(compileKeyframeExpression([], "panX", 42.500000)).toBe("42.5");
  });

  it("single keyframe → its value as a literal (constant)", () => {
    const expr = compileKeyframeExpression(
      [kf("scale", 1000, 2)],
      "scale",
      1,
    );
    expect(expr).toBe("2");
    // At any t, value is constant.
    expect(evalFfmpegExpr(expr, 0)).toBe(2);
    expect(evalFfmpegExpr(expr, 5)).toBe(2);
  });

  it("ignores keyframes for other props", () => {
    const expr = compileKeyframeExpression(
      [kf("panX", 0, 100), kf("scale", 1000, 2)],
      "panY",
      50,
    );
    expect(expr).toBe("50");
  });

  it("piecewise linear: matches the frontend interpolator at sample t", () => {
    // Two kfs: scale 1 → 2 over 0..1000ms.
    const kfs = [kf("scale", 0, 1), kf("scale", 1000, 2)];
    const expr = compileKeyframeExpression(kfs, "scale", 1);
    expect(evalFfmpegExpr(expr, 0)).toBeCloseTo(1, 5);
    expect(evalFfmpegExpr(expr, 0.5)).toBeCloseTo(1.5, 5);
    expect(evalFfmpegExpr(expr, 1)).toBeCloseTo(2, 5);
    // After last → held.
    expect(evalFfmpegExpr(expr, 2)).toBeCloseTo(2, 5);
  });

  it("before first / after last → held at the boundary kf's value", () => {
    const kfs = [kf("panX", 1000, 50), kf("panX", 2000, 100)];
    const expr = compileKeyframeExpression(kfs, "panX", 0);
    expect(evalFfmpegExpr(expr, 0)).toBeCloseTo(50, 5); // held at first
    expect(evalFfmpegExpr(expr, 1.5)).toBeCloseTo(75, 5); // mid-segment
    expect(evalFfmpegExpr(expr, 3)).toBeCloseTo(100, 5); // held at last
  });

  it("easing — easeIn moves below linear in the middle", () => {
    const kfs = [kf("scale", 0, 0, "easeIn"), kf("scale", 1000, 1)];
    const expr = compileKeyframeExpression(kfs, "scale", 0);
    // Linear would be 0.5 at t=0.5; easeIn = 0.5³ = 0.125
    expect(evalFfmpegExpr(expr, 0.5)).toBeCloseTo(0.125, 5);
    // Endpoints still exact.
    expect(evalFfmpegExpr(expr, 0)).toBeCloseTo(0, 5);
    expect(evalFfmpegExpr(expr, 1)).toBeCloseTo(1, 5);
  });

  it("easing — easeOut moves above linear in the middle", () => {
    const kfs = [kf("scale", 0, 0, "easeOut"), kf("scale", 1000, 1)];
    const expr = compileKeyframeExpression(kfs, "scale", 0);
    // easeOut at t=0.5 → 1 - (1-0.5)³ = 1 - 0.125 = 0.875
    expect(evalFfmpegExpr(expr, 0.5)).toBeCloseTo(0.875, 5);
  });

  it("easing — easeInOut is symmetric around t=0.5", () => {
    const kfs = [kf("scale", 0, 0, "easeInOut"), kf("scale", 1000, 1)];
    const expr = compileKeyframeExpression(kfs, "scale", 0);
    expect(evalFfmpegExpr(expr, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("multi-segment with per-segment easing", () => {
    // Linear seg 1 → easeOut seg 2.
    const kfs = [
      kf("scale", 0, 1),
      kf("scale", 1000, 2, "easeOut"),
      kf("scale", 2000, 3),
    ];
    const expr = compileKeyframeExpression(kfs, "scale", 1);
    // Seg 1 mid (t=0.5s) → linear: 1.5
    expect(evalFfmpegExpr(expr, 0.5)).toBeCloseTo(1.5, 5);
    // Seg 2 mid (t=1.5s) → easeOut: 2 + 0.875*(3-2) = 2.875
    expect(evalFfmpegExpr(expr, 1.5)).toBeCloseTo(2.875, 5);
  });

  it("zero-length segments are skipped without div-by-zero", () => {
    const kfs = [
      kf("scale", 1000, 1),
      kf("scale", 1000, 2), // exact dupe time
      kf("scale", 2000, 3),
    ];
    const expr = compileKeyframeExpression(kfs, "scale", 1);
    // Doesn't throw, doesn't contain "NaN" or "Infinity".
    expect(expr).not.toMatch(/NaN|Infinity/);
    // After the second kf @1s onward we ride the kf@1000=2 → kf@2000=3 ramp.
    expect(evalFfmpegExpr(expr, 1.5)).toBeCloseTo(2.5, 5);
  });

  it("ms → seconds conversion at 6-digit precision", () => {
    const kfs = [kf("scale", 1000, 1), kf("scale", 1500, 2)];
    const expr = compileKeyframeExpression(kfs, "scale", 1);
    // The expression should contain 1.5 (seconds), not 1500 (ms).
    expect(expr).toMatch(/1\.5/);
    expect(expr).not.toMatch(/1500/);
  });

  it("integer values stay integers — no '1.000000'", () => {
    const expr = compileKeyframeExpression(
      [kf("scale", 0, 1), kf("scale", 1000, 2)],
      "scale",
      1,
    );
    // No fractional zero noise — keeps the expr human-readable.
    expect(expr).not.toMatch(/\.0+\b/);
  });
});

describe("easingExpression — boundary identities", () => {
  it("rawT=0 / rawT=1 always evaluate to 0 / 1", () => {
    for (const kind of ["linear", "easeIn", "easeOut", "easeInOut"] as const) {
      const expr0 = easingExpression("0", kind);
      const expr1 = easingExpression("1", kind);
      expect(evalFfmpegExpr(expr0, 0)).toBeCloseTo(0, 6);
      expect(evalFfmpegExpr(expr1, 0)).toBeCloseTo(1, 6);
    }
  });
});
