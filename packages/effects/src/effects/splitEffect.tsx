/**
 * Default `splitClip` effect — silky bear-driven choreography.
 *
 * Design rationale
 * ────────────────
 *
 * The old StickFigure-based effect had two structural problems:
 *
 *   1. Pose swaps between frames read as stop-motion — SVG paths
 *      snapping between "walking" and "cutting" postures with no
 *      interpolation.
 *
 *   2. Causal timing was off — the timeline data mutated at t=0 but
 *      the visual "cut" landed 200-600ms later, so the split appeared
 *      *before* the character did the cutting motion.
 *
 * This rewrite solves both by:
 *
 *   • Using a single high-fidelity bear image (arms-up "chop" pose)
 *     and animating it purely via CSS transforms — no pose swaps,
 *     so no snap-frame perception.
 *
 *   • Landing a bright vertical light beam at the cut point *at t=0*
 *     via a CSS animation with an aggressive early keyframe. The
 *     beam is the causal cue: it appears in lock-step with the data
 *     mutation. The bear's chop swing peaks around 45% of the beam's
 *     lifetime so the two read as connected.
 *
 * Choreography (~600ms total, all driven by CSS keyframes so the
 * browser handles frame timing — zero React re-renders after mount):
 *
 *   0ms      beam appears (opacity 0→1 in ~50ms)
 *   0ms      bear pops in above cut, arms cocked (scale + rotate spring)
 *   ~170ms   bear reaches peak windup
 *   ~270ms   bear swings arms down (rotate -16° → +18°) — the "chop"
 *   ~240ms   radial glow blooms at strike point, two sparks fly out
 *   ~450ms   bear starts floating up and fading
 *   600ms    everything cleaned up, onComplete fires
 */
import { useEffect, useRef, type ReactElement } from "react";
import type { EffectHandler } from "../types.js";
import { Bear } from "../characters/Bear.js";

// Deliberately slow for the testing phase — halve back once we're happy
// with the choreography shape.
const TOTAL_MS = 1400;
const BEAR_SIZE = 108;

export const defaultSplitEffect: EffectHandler = (op, ctx, onComplete) => {
  if (op.kind !== "splitClip" || !op.result.ok) return null;
  const args = op.args as { clipId: string; timeMs: number };
  const cutX = ctx.timelineToScreenX(args.timeMs);
  const clipRect = ctx.clipToScreenRect(args.clipId);
  if (cutX == null) return null;
  const rowTop = clipRect?.top ?? ctx.timelineRect?.top ?? 0;
  const rowHeight = clipRect?.height ?? 56;
  return (
    <SplitAnimation
      key={op.timestamp}
      x={cutX}
      rowTop={rowTop}
      rowHeight={rowHeight}
      onDone={onComplete}
    />
  );
};

function SplitAnimation({
  x,
  rowTop,
  rowHeight,
  onDone,
}: {
  x: number;
  rowTop: number;
  rowHeight: number;
  onDone: () => void;
}): ReactElement {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => doneRef.current(), TOTAL_MS);
    return () => clearTimeout(t);
  }, []);

  const rowCenterY = rowTop + rowHeight / 2;
  // Bear sits above the timeline row with feet roughly at the row's
  // top edge. `translate(-50%, -100%)` on the bear pins its bottom-
  // center to the cut point coordinate, so `top` is set to the row
  // top and the transform lifts the whole sprite upward.
  const bearAnchorY = rowTop;

  return (
    <>
      {/* Vertical light beam at the cut point. Fixed-positioned at
       *  (x, rowCenterY). `translate(-50%, -50%)` centers it. Height
       *  set to the row height so the beam spans the clip. */}
      <div
        style={{
          position: "fixed",
          left: x,
          top: rowCenterY,
          width: 6,
          height: rowHeight * 2.2,
          background:
            "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(200,240,255,1) 22%, rgba(255,255,255,1) 50%, rgba(200,240,255,1) 78%, rgba(255,255,255,0) 100%)",
          boxShadow:
            "0 0 16px 3px rgba(180,230,255,0.95), 0 0 40px 8px rgba(120,190,255,0.65)",
          borderRadius: 2,
          animation: `aicut-effect-split-beam ${TOTAL_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1) forwards`,
          animationFillMode: "forwards",
          pointerEvents: "none",
          willChange: "transform, opacity",
        }}
      />
      {/* Radial glow burst — delayed to bloom at the chop moment. */}
      <div
        style={{
          position: "fixed",
          left: x,
          top: rowCenterY,
          width: rowHeight * 1.6,
          height: rowHeight * 1.6,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(200,235,255,0.55) 0%, rgba(140,200,255,0.35) 40%, rgba(80,140,255,0) 70%)",
          animation: `aicut-effect-split-glow ${TOTAL_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1) forwards`,
          pointerEvents: "none",
          willChange: "transform, opacity",
        }}
      />
      {/* Two sparks that fly out post-chop. Absolute-positioned
       *  relative to the cut point; their keyframes translate them
       *  diagonally away. */}
      <Spark direction="left" x={x} y={rowCenterY} />
      <Spark direction="right" x={x} y={rowCenterY} />
      {/* Bear character. Anchored to the row-top so translate(-50%,
       *  -100%) puts feet on the timeline. */}
      <div
        style={{
          position: "fixed",
          left: x,
          top: bearAnchorY,
          animation: `aicut-effect-split-bear ${TOTAL_MS}ms cubic-bezier(0.3, 0.9, 0.4, 1) forwards`,
          transformOrigin: "50% 100%",
          pointerEvents: "none",
          willChange: "transform, opacity",
        }}
      >
        <Bear pose="chop" size={BEAR_SIZE} />
      </div>
    </>
  );
}

function Spark({
  direction,
  x,
  y,
}: {
  direction: "left" | "right";
  x: number;
  y: number;
}): ReactElement {
  return (
    <div
      style={{
        position: "fixed",
        left: x - 4,
        top: y - 4,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background:
          "radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(220,240,255,0.9) 50%, rgba(180,210,255,0) 100%)",
        boxShadow: "0 0 8px 2px rgba(200,230,255,0.85)",
        animation: `aicut-effect-split-spark-${direction} ${TOTAL_MS}ms cubic-bezier(0.3, 0.7, 0.4, 1) forwards`,
        pointerEvents: "none",
        willChange: "transform, opacity",
      }}
    />
  );
}
