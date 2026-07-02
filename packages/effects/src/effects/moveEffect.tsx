/**
 * Default `moveClipTo` effect. Rebuilt from the naive "walk in →
 * lift → straight glide → drop → walk out" pattern to an
 * anticipation-driven arc pattern with a walk cycle during transit:
 *
 *   spawn    (150ms) — figure fades in at the source clip position
 *                      with a slight squash. Anticipation.
 *   lift     (200ms) — ghost clip pops UP out of the source rect as
 *                      figure raises arms overhead (overshoots, then
 *                      settles — spring easing).
 *   carry    (700ms) — figure + ghost traverse a **parabolic arc**
 *                      from source to destination. Figure alternates
 *                      walking pose every 140ms to read as legs
 *                      taking steps (not a slide).
 *   drop     (200ms) — ghost lands into destination rect with a
 *                      small squash; figure follows through with a
 *                      little bow.
 *   exit     (200ms) — figure fades out, tiny puff of motion.
 *
 * Total ~1.45s. The arc height scales with horizontal distance so
 * a short move stays flat while a long cross-timeline move arcs
 * high — matches physical intuition for "carrying weight".
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { EffectContext, EffectHandler } from "../types.js";
import { StickFigure } from "../characters/StickFigure.js";

const SPAWN_MS = 150;
const LIFT_MS = 200;
const CARRY_MS = 700;
const DROP_MS = 200;
const EXIT_MS = 200;
const TOTAL_MS = SPAWN_MS + LIFT_MS + CARRY_MS + DROP_MS + EXIT_MS;
const FIGURE_HALF = 24;
/** How many ms per walk-cycle pose swap during the carry phase. Two
 *  swaps at 140ms feels like "one step per 140ms" — brisk but not
 *  frantic. */
const STEP_MS = 140;
/** Peak arc height as a fraction of horizontal distance. Capped by
 *  MAX_ARC_HEIGHT so very-long moves don't parabola off the screen. */
const ARC_FACTOR = 0.35;
const MIN_ARC_HEIGHT = 30;
const MAX_ARC_HEIGHT = 140;

export const defaultMoveEffect: EffectHandler = (op, ctx, onComplete) => {
  if (op.kind !== "moveClipTo" || !op.result.ok) return null;
  const args = op.args as { clipId: string };

  const destRect = ctx.clipToScreenRect(args.clipId);
  const srcRect = clipRectFromProject(op.beforeProject, args.clipId, ctx);
  if (!destRect || !srcRect) return null;

  return (
    <MoveAnimation
      key={op.timestamp}
      srcRect={srcRect}
      destRect={destRect}
      onDone={onComplete}
    />
  );
};

function clipRectFromProject(
  project: import("@aicut/core").Project,
  clipId: string,
  ctx: EffectContext,
): DOMRect | null {
  let found: { trackIndex: number; start: number; end: number } | null = null;
  project.tracks.forEach((t, ti) => {
    const c = t.clips.find((cc) => cc.id === clipId);
    if (c)
      found = {
        trackIndex: ti,
        start: c.start,
        end: c.start + (c.out - c.in),
      };
  });
  if (!found) return null;
  const timelineRect = ctx.timelineRect;
  if (!timelineRect) return null;
  const foundRow: { trackIndex: number; start: number; end: number } = found;
  const x0 = ctx.timelineToScreenX(foundRow.start) ?? timelineRect.left;
  const x1 = ctx.timelineToScreenX(foundRow.end) ?? timelineRect.left;
  const rulerH = 24;
  const trackH = 56;
  const y0 = timelineRect.top + rulerH + foundRow.trackIndex * trackH;
  return new DOMRect(x0, y0, x1 - x0, trackH);
}

type Phase = "spawn" | "lift" | "carry" | "drop" | "exit";

function MoveAnimation({
  srcRect,
  destRect,
  onDone,
}: {
  srcRect: DOMRect;
  destRect: DOMRect;
  onDone: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<Phase>("spawn");
  const [step, setStep] = useState(0); // 0 or 1 — walk cycle toggle
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("lift"), SPAWN_MS);
    const t2 = setTimeout(() => setPhase("carry"), SPAWN_MS + LIFT_MS);
    const t3 = setTimeout(
      () => setPhase("drop"),
      SPAWN_MS + LIFT_MS + CARRY_MS,
    );
    const t4 = setTimeout(
      () => setPhase("exit"),
      SPAWN_MS + LIFT_MS + CARRY_MS + DROP_MS,
    );
    const t5 = setTimeout(() => doneRef.current(), TOTAL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
    };
  }, []);

  // Walk cycle — swap pose every STEP_MS during carry. Interval
  // only lives during carry to avoid pointless re-renders in other
  // phases.
  useEffect(() => {
    if (phase !== "carry") return;
    const id = setInterval(() => setStep((s) => (s === 0 ? 1 : 0)), STEP_MS);
    return () => clearInterval(id);
  }, [phase]);

  const srcCenterX = srcRect.left + srcRect.width / 2;
  const destCenterX = destRect.left + destRect.width / 2;
  const distance = Math.abs(destCenterX - srcCenterX);
  const arcHeight = Math.min(
    MAX_ARC_HEIGHT,
    Math.max(MIN_ARC_HEIGHT, distance * ARC_FACTOR),
  );

  // Figure vertical anchor (top of the figure svg). During carry we
  // stack the figure ABOVE its walking baseline so the ghost clip
  // sits between figure hands and clip row.
  const walkBaseY = (row: DOMRect): number => row.top - 56;

  const figureX = useMemo(() => {
    switch (phase) {
      case "spawn":
      case "lift":
        return srcCenterX;
      case "carry":
        // Interpolated horizontally by CSS transition — start x is
        // srcCenter and target is destCenter.
        return destCenterX;
      case "drop":
      case "exit":
        return destCenterX;
    }
  }, [phase, srcCenterX, destCenterX]);

  const figureY = useMemo(() => {
    switch (phase) {
      case "spawn":
        return walkBaseY(srcRect) + 8; // squash — sits slightly low
      case "lift":
        return walkBaseY(srcRect) - 12; // arms overhead, figure lifts
      case "carry":
        // Handled by the arc transform below; anchor at destination
        // top for the CSS `top` transition.
        return walkBaseY(destRect) - 8;
      case "drop":
        return walkBaseY(destRect) + 4; // follow-through squash on drop
      case "exit":
        return walkBaseY(destRect);
    }
  }, [phase, srcRect, destRect]);

  const transition = useMemo(() => {
    switch (phase) {
      case "spawn":
        return `opacity ${SPAWN_MS}ms ease-out, top ${SPAWN_MS}ms cubic-bezier(0.4, 1.6, 0.6, 1)`;
      case "lift":
        // Spring — small overshoot on the lift feels weighted.
        return `top ${LIFT_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
      case "carry":
        // Long smooth glide on the horizontal; the arc-y comes from
        // the transform (not top) so both animate independently.
        return `left ${CARRY_MS}ms cubic-bezier(0.4, 0, 0.2, 1), top ${CARRY_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
      case "drop":
        return `top ${DROP_MS}ms cubic-bezier(0.34, 1.4, 0.64, 1)`;
      case "exit":
        return `opacity ${EXIT_MS}ms ease-out, top ${EXIT_MS}ms ease-out`;
    }
  }, [phase]);

  // CSS animation on the transform gives us a mid-flight arc without
  // needing a per-frame RAF loop. `translateY(-Arch)` at 50% peaks
  // higher than start/end, forming a parabola.
  const carryAnimation =
    phase === "carry"
      ? `aicut-effect-carry-arc-${Math.round(arcHeight)} ${CARRY_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
      : "none";

  const opacity = phase === "exit" ? 0 : phase === "spawn" ? 0.2 : 1;

  // Ghost clip visible from lift onward through drop; invisible on
  // exit (already merged into the real clip row underneath).
  const ghostVisible = phase !== "spawn" && phase !== "exit";
  const ghostX = figureX - srcRect.width / 2;
  const ghostY = useMemo(() => {
    switch (phase) {
      case "lift":
        return srcRect.top - 20;
      case "carry":
        return destRect.top - 20; // baseline height above track
      case "drop":
        return destRect.top + 2;
      default:
        return srcRect.top;
    }
  }, [phase, srcRect, destRect]);

  const ghostTransition = transition; // same choreography as figure

  // Pose selection — during carry, alternate between walking-forward
  // and walking-back on step timer for the "walk cycle" look.
  const pose = useMemo(() => {
    switch (phase) {
      case "spawn":
        return "idle" as const;
      case "lift":
        return "lifting" as const;
      case "carry":
        // Two variants of "carrying" — the SVG uses the same base
        // pose but we flip legs via a subtle transform on the whole
        // figure below (see wobble). Pose stays "carrying".
        return "carrying" as const;
      case "drop":
        return "dropping" as const;
      case "exit":
        return "waving" as const;
    }
  }, [phase]);

  // Vertical bob during carry — 4px sine using the step toggle. Not
  // super realistic but reads as "walking" better than a straight
  // glide.
  const bobY = phase === "carry" && step === 1 ? -3 : 0;

  return (
    <>
      {/* Ghost clip rectangle following the arc. */}
      {ghostVisible ? (
        <div
          style={{
            position: "fixed",
            left: ghostX,
            top: ghostY,
            width: srcRect.width,
            height: srcRect.height * 0.55,
            background: "rgba(154, 49, 244, 0.35)",
            border: "1.5px dashed rgba(255, 255, 255, 0.75)",
            borderRadius: 4,
            transition: ghostTransition,
            animation:
              phase === "carry"
                ? `aicut-effect-carry-arc-${Math.round(arcHeight)} ${CARRY_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
                : "none",
            pointerEvents: "none",
            boxShadow:
              phase === "drop"
                ? "0 4px 12px rgba(154, 49, 244, 0.4)"
                : "none",
          }}
        />
      ) : null}
      {/* Stick figure — bobs during carry via transform, glides via
       *  top/left, follows the parabolic arc alongside the ghost. */}
      <div
        style={{
          position: "fixed",
          left: figureX - FIGURE_HALF,
          top: figureY,
          transform: `translateY(${bobY}px)`,
          transition,
          animation: carryAnimation,
          opacity,
          pointerEvents: "none",
          color: "rgba(180, 140, 255, 0.95)",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.4))",
        }}
      >
        <StickFigure
          pose={pose}
          facing={destCenterX > srcCenterX ? "right" : "left"}
        />
      </div>
      {/* Register the arc keyframe once per arc height. Because the
       *  peak is data-driven (parametric per move distance) we can't
       *  put a single fixed keyframe in effects.css — inject a
       *  <style> tag with the exact height. Small footprint since the
       *  keyframe name includes the height, browsers dedupe. */}
      {phase === "carry" ? (
        <style>{`
          @keyframes aicut-effect-carry-arc-${Math.round(arcHeight)} {
            0%   { transform: translateY(0); }
            50%  { transform: translateY(-${Math.round(arcHeight)}px); }
            100% { transform: translateY(0); }
          }
        `}</style>
      ) : null}
    </>
  );
}
