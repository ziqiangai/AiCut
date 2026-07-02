/**
 * Default `moveClipTo` effect — silky bear-driven choreography.
 *
 * Choreography (~1800ms total — deliberately slowed for the testing
 * phase so the choreography reads clearly. Halve the constants once
 * we're happy with the shape):
 *
 *   0ms      bear pops in at source with a spring, arms open
 *   0ms      full-size ghost clip (looks like a real timeline clip
 *            bar — solid purple fill, label) appears at the source
 *            position and lifts up into the bear's arms. A fading
 *            "outline" stays at the source spot to soften the fact
 *            that the underlying timeline data has already teleported.
 *   0ms      source-position ring pulses outward (signals "grab")
 *   ~320ms   bear + ghost hold for a beat (settled after spring)
 *   320→1440 bear + ghost translate to destination via a smooth
 *            ease-in-out cubic. Bear wobbles a few degrees during
 *            transit — reads as "carrying weight" without pose flips.
 *   ~1440ms  destination-position ring pulses outward (signals "drop")
 *   ~1500ms  ghost drops into the destination row with a slight
 *            squash bounce
 *   ~1600ms  bear floats up and fades
 *   1800ms   everything cleaned up
 *
 * All motion runs on the compositor thread (transform / opacity only,
 * with `will-change` hints) so it stays 60fps under load.
 */
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { EffectContext, EffectHandler } from "../types.js";
import { Bear } from "../characters/Bear.js";

const TOTAL_MS = 1800;
const CARRY_START_MS = 320;
const CARRY_MS = 1120;
const BEAR_SIZE = 108;
const GHOST_LIFT = 44; // px the ghost floats above the row baseline

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
      clipId={args.clipId}
      onDone={onComplete}
    />
  );
};

/** Reconstruct the source clip's on-screen rect from the pre-mutation
 *  project snapshot. `clipToScreenRect` reads live DOM, which is
 *  post-mutation — we need the *before* position to spawn the bear
 *  where the clip used to live. */
function clipRectFromProject(
  project: import("@aicut/core").Project,
  clipId: string,
  ctx: EffectContext,
): DOMRect | null {
  let found: { trackIndex: number; start: number; end: number } | null = null;
  project.tracks.forEach((t, ti) => {
    const c = t.clips.find((cc) => cc.id === clipId);
    if (c) found = { trackIndex: ti, start: c.start, end: c.start + (c.out - c.in) };
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

function MoveAnimation({
  srcRect,
  destRect,
  clipId,
  onDone,
}: {
  srcRect: DOMRect;
  destRect: DOMRect;
  clipId: string;
  onDone: () => void;
}): ReactElement {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  // `carryStarted` toggles the transform on the position-wrapper, which
  // owns the source→dest translation. Kept as state instead of a
  // setTimeout-driven className because React needs a re-render for
  // the transition to fire (initial `transform: translate3d(0,0,0)`,
  // then after mount `transform: translate3d(dx, dy, 0)`).
  const [carryStarted, setCarryStarted] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setCarryStarted(true), CARRY_START_MS);
    const t2 = setTimeout(() => doneRef.current(), TOTAL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const srcCenterX = srcRect.left + srcRect.width / 2;
  const destCenterX = destRect.left + destRect.width / 2;
  const dx = destCenterX - srcCenterX;
  const dy = destRect.top - srcRect.top;

  const anchorX = srcCenterX;
  const anchorY = srcRect.top;

  const carryTranslate = carryStarted
    ? `translate3d(${dx}px, ${dy}px, 0)`
    : "translate3d(0, 0, 0)";
  const carryTransition = carryStarted
    ? `transform ${CARRY_MS}ms cubic-bezier(0.35, 0.05, 0.25, 1)`
    : "none";

  // Ghost = full source-clip footprint. Same width AND height as the
  // real clip bar it represents. This is what makes it read as "the
  // video strip being lifted" instead of "a dashed drag hint".
  const ghostWidth = srcRect.width;
  const ghostHeight = srcRect.height;

  return (
    <>
      {/* Source-spot "outline" — where the clip used to sit before the
       *  data teleported. Fades out over the first ~360ms as the bear
       *  picks it up, so the user's eye reads the whole sequence as
       *  "clip was here → bear lifted it → carried it → put it down"
       *  rather than "clip teleported and bear caught up". */}
      <div
        style={{
          position: "fixed",
          left: srcRect.left,
          top: srcRect.top,
          width: srcRect.width,
          height: srcRect.height,
          background:
            "linear-gradient(135deg, rgba(140,90,240,0.18) 0%, rgba(180,140,255,0.14) 100%)",
          border: "1.5px dashed rgba(220, 200, 255, 0.7)",
          borderRadius: 4,
          animation: `aicut-effect-move-source-hint ${TOTAL_MS}ms ease-out forwards`,
          pointerEvents: "none",
          willChange: "opacity",
        }}
      />
      {/* Source-position ring pulse — signals "grab". */}
      <Ring x={srcCenterX} y={srcRect.top + srcRect.height / 2} delay={0} />
      {/* Destination-position ring pulse — signals "drop". */}
      <Ring
        x={destCenterX}
        y={destRect.top + destRect.height / 2}
        delay={CARRY_START_MS + CARRY_MS - 120}
      />
      {/* Position wrapper — owns the translation from source to
       *  destination. Everything inside inherits the translation. */}
      <div
        style={{
          position: "fixed",
          left: anchorX,
          top: anchorY,
          transform: carryTranslate,
          transition: carryTransition,
          pointerEvents: "none",
          willChange: "transform",
        }}
      >
        {/* Ghost clip — full-height solid-purple bar styled to look
         *  like a real timeline clip (not a drag preview). Sits at
         *  GHOST_LIFT px above the row so it appears "held up" by the
         *  bear rather than resting on the timeline. */}
        <div
          style={{
            position: "absolute",
            left: -ghostWidth / 2,
            top: -GHOST_LIFT - ghostHeight,
            width: ghostWidth,
            height: ghostHeight,
            background:
              "linear-gradient(180deg, rgba(180,120,255,0.95) 0%, rgba(140,80,230,0.95) 55%, rgba(120,60,220,0.95) 100%)",
            border: "1.5px solid rgba(240, 220, 255, 0.9)",
            borderRadius: 4,
            boxShadow:
              "0 10px 24px rgba(90, 40, 200, 0.5), 0 2px 6px rgba(60, 20, 160, 0.35), inset 0 1px 0 rgba(255,255,255,0.4)",
            animation: `aicut-effect-move-ghost ${TOTAL_MS}ms cubic-bezier(0.35, 0.05, 0.25, 1) forwards`,
            willChange: "transform, opacity",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            paddingLeft: 8,
            color: "rgba(255, 255, 255, 0.92)",
            fontSize: 11,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontWeight: 600,
            letterSpacing: 0.2,
            textShadow: "0 1px 2px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
          }}
        >
          {clipId}
        </div>
        {/* Bear character — anchored to the wrapper's origin (source
         *  clip top), keyframe pulls it up so feet touch the row. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            animation: `aicut-effect-move-bear ${TOTAL_MS}ms cubic-bezier(0.3, 0.9, 0.4, 1) forwards`,
            transformOrigin: "50% 100%",
            willChange: "transform, opacity",
          }}
        >
          <Bear pose="carry" size={BEAR_SIZE} />
        </div>
      </div>
    </>
  );
}

function Ring({
  x,
  y,
  delay,
}: {
  x: number;
  y: number;
  delay: number;
}): ReactElement {
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        width: 70,
        height: 70,
        borderRadius: "50%",
        border: "3px solid rgba(200, 170, 255, 0.9)",
        boxShadow: "0 0 20px rgba(160, 110, 255, 0.6)",
        animation: `aicut-effect-move-ring 900ms cubic-bezier(0.25, 0.8, 0.35, 1) ${delay}ms forwards`,
        opacity: 0,
        pointerEvents: "none",
        willChange: "transform, opacity",
      }}
    />
  );
}
