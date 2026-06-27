import type { EasingKind, Keyframe, KeyframeProp } from "@aicut/core";

/**
 * Compile a per-property keyframe array into an ffmpeg filter
 * expression. The result is suitable to drop into
 * `scale=w='...':h='...':eval=frame` or `overlay=x='...':eval=frame`
 * — both filters expose `t` as the current OUTPUT timestamp.
 *
 * Math: each segment between kf[i] and kf[i+1] contributes
 *
 *   gte(T, A) * lt(T, B) * ( a.value + easedT * (b.value - a.value) )
 *
 * where `T` is the time-variable expression (default `t`) and
 * easedT applies the LEAVING keyframe's outgoing curve to the
 * normalized progress `(T - A)/(B - A)`. Before-first holds the
 * first value; after-last holds the last value. Boundaries use a
 * half-open `[A, B)` mask so the same T never gets counted twice.
 *
 * For props with NO keyframes the function returns the static
 * fallback as a literal so the caller can drop the result straight
 * into the filter without conditionals.
 *
 * `tVar` lets the caller substitute a CLIP-LOCAL expression when the
 * filter sees global timeline `t` — e.g. when compositing multiple
 * tracks in a single filter_complex pass, callers pass
 * `tVar: "(t-${clip.start/1000})"` so keyframe times stay anchored
 * to clip start.
 */
export interface CompileOpts {
  /** Expression that evaluates to clip-local seconds. Defaults to `"t"`. */
  tVar?: string;
}

export function compileKeyframeExpression(
  keyframes: Keyframe[] | undefined,
  prop: KeyframeProp,
  fallback: number,
  opts: CompileOpts = {},
): string {
  const T = opts.tVar ?? "t";
  if (!keyframes || keyframes.length === 0) return formatNumber(fallback);
  const propKfs = keyframes
    .filter((k) => k.prop === prop)
    .sort((a, b) => a.time - b.time);
  if (propKfs.length === 0) return formatNumber(fallback);
  if (propKfs.length === 1) return formatNumber(propKfs[0]!.value);

  const parts: string[] = [];
  const first = propKfs[0]!;
  const last = propKfs[propKfs.length - 1]!;

  // Before first kf — held at first.value.
  parts.push(`lt(${T},${formatTime(first.time)})*${formatNumber(first.value)}`);

  // Segments.
  for (let i = 0; i < propKfs.length - 1; i += 1) {
    const a = propKfs[i]!;
    const b = propKfs[i + 1]!;
    const aSec = formatTime(a.time);
    const bSec = formatTime(b.time);
    const dur = (b.time - a.time) / 1000;
    if (dur <= 0) continue; // zero-length segment — skip to avoid div/0
    const rawT = `(${T}-${aSec})/${formatNumber(dur)}`;
    const easedT = easingExpression(rawT, a.easing ?? "linear");
    const delta = b.value - a.value;
    const lerpedExpr =
      delta === 0
        ? formatNumber(a.value) // value held — constant segment
        : `(${formatNumber(a.value)}+(${easedT})*(${formatNumber(delta)}))`;
    parts.push(`gte(${T},${aSec})*lt(${T},${bSec})*${lerpedExpr}`);
  }

  // After last kf — held at last.value.
  parts.push(`gte(${T},${formatTime(last.time)})*${formatNumber(last.value)}`);

  return parts.join("+");
}

/**
 * Wrap a `t∈[0,1]` ffmpeg expression in the easing curve from our
 * frontend. Matches `applyEasing` in `keyframes/interpolate.ts` line
 * for line — same cubic formulas. Endpoints (rawT=0 and rawT=1)
 * always evaluate to 0 and 1 so the kf values stay exact.
 *
 * `rawT` MUST be a parenthesized expression — callers feed
 * `(t-A)/D` style, never a single variable. The output is also
 * safe to nest inside other expressions because the body wraps
 * with explicit parens.
 */
export function easingExpression(rawT: string, easing: EasingKind): string {
  switch (easing) {
    case "linear":
      return rawT;
    case "easeIn":
      return `pow(${rawT},3)`;
    case "easeOut":
      return `(1-pow(1-(${rawT}),3))`;
    case "easeInOut":
      // Same cubic split as the frontend: t<0.5 → 4t³, else 1-(-2t+2)³/2.
      return `if(lt(${rawT},0.5),4*pow(${rawT},3),1-pow(-2*(${rawT})+2,3)/2)`;
  }
}

/** ffmpeg-friendly number — 6 sig figs of decimals, no exponential. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Avoid scientific notation entirely; ffmpeg's parser doesn't grok it.
  const s = n.toFixed(6);
  // Trim trailing zeros (and a stranded `.`) so the expression
  // stays compact and grep-friendly.
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Convert clip-local ms to seconds at ffmpeg-expression precision. */
function formatTime(ms: number): string {
  return formatNumber(ms / 1000);
}
