/**
 * Default `splitClip` effect. Rebuilt from the "walk in and saw"
 * original to a **drop → strike → recoil** three-beat pattern that
 * aligns the visual peak (the strike + flash) with the actual API
 * commit moment. The old effect fired the flash ~600ms AFTER the
 * timeline had already visibly split, breaking the cause-effect
 * feel. The new effect fires the flash ~200ms after mount, when the
 * user's eye is still catching up to the data change — the split
 * reads as caused by the strike.
 *
 * Phases:
 *   drop     (200ms) — figure falls from above the cut point, saw
 *                      raised. Anticipation.
 *   strike   (150ms) — figure at rest position, saw slashes down,
 *                      bright vertical flash line spans the row.
 *   recoil   (450ms) — figure bounces up + fades, flash line
 *                      contracts to nothing.
 *
 * Total ~800ms. All motion runs on cubic-bezier curves that
 * approximate real anticipation / snap / follow-through — no linear
 * easing (which was what made the old version read as "sliding
 * around").
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { EffectHandler } from "../types.js";
import { StickFigure } from "../characters/StickFigure.js";

const DROP_MS = 200;
const STRIKE_MS = 150;
const RECOIL_MS = 450;
const TOTAL_MS = DROP_MS + STRIKE_MS + RECOIL_MS;
const FIGURE_HALF = 24;
const DROP_HEIGHT = 40; // pixels above the strike position where the figure starts

export const defaultSplitEffect: EffectHandler = (op, ctx, onComplete) => {
  if (op.kind !== "splitClip" || !op.result.ok) return null;
  const args = op.args as { clipId: string; timeMs: number };
  const cutX = ctx.timelineToScreenX(args.timeMs);
  const clipRect = ctx.clipToScreenRect(args.clipId);
  const timelineTop = clipRect?.top ?? ctx.timelineRect?.top ?? 0;
  const rowHeight = clipRect?.height ?? 56;
  if (cutX == null) return null;
  return (
    <SplitAnimation
      key={op.timestamp}
      x={cutX}
      top={timelineTop}
      height={rowHeight}
      onDone={onComplete}
    />
  );
};

function SplitAnimation({
  x,
  top,
  height,
  onDone,
}: {
  x: number;
  top: number;
  height: number;
  onDone: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<"drop" | "strike" | "recoil">("drop");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("strike"), DROP_MS);
    const t2 = setTimeout(() => setPhase("recoil"), DROP_MS + STRIKE_MS);
    const t3 = setTimeout(() => doneRef.current(), TOTAL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  // Figure position — the strike position (top - 56) is where the saw
  // meets the clip. Drop starts DROP_HEIGHT above; recoil ends 40px
  // above with fade.
  const strikeY = top - 56;
  const figureY = useMemo(() => {
    switch (phase) {
      case "drop":
        return strikeY - DROP_HEIGHT;
      case "strike":
        return strikeY;
      case "recoil":
        return strikeY - 24;
    }
  }, [phase, strikeY]);

  // Anticipation → snap → follow-through easing per phase.
  //  drop:   cubic-bezier accelerates into strike (weight of the fall)
  //  strike: linear (instant, no easing to feel)
  //  recoil: cubic-bezier decelerates as figure lifts + fades
  const transition = useMemo(() => {
    switch (phase) {
      case "drop":
        return `top ${DROP_MS}ms cubic-bezier(0.55, 0, 1, 0.45)`;
      case "strike":
        return "none";
      case "recoil":
        return `top ${RECOIL_MS}ms cubic-bezier(0.2, 0.8, 0.4, 1), opacity ${RECOIL_MS}ms ease-out`;
    }
  }, [phase]);

  // Flash line — grows during strike, contracts during recoil.
  const flashOpacity =
    phase === "drop" ? 0 : phase === "strike" ? 1 : 0;
  const flashHeight =
    phase === "drop" ? 0 : phase === "strike" ? height : height * 0.3;

  return (
    <>
      {/* Vertical flash line across the clip row — the "cut". */}
      <div
        style={{
          position: "fixed",
          left: x - 1.5,
          top: top + (height - flashHeight) / 2,
          width: 3,
          height: flashHeight,
          background:
            "linear-gradient(to bottom, rgba(255,240,180,0), rgba(255,235,120,1) 30%, rgba(255,235,120,1) 70%, rgba(255,240,180,0))",
          boxShadow:
            phase === "strike"
              ? "0 0 18px 4px rgba(255,230,120,0.75)"
              : "none",
          opacity: flashOpacity,
          transition:
            phase === "strike"
              ? "opacity 60ms ease-out, height 100ms cubic-bezier(0.4, 0, 0.2, 1), top 100ms cubic-bezier(0.4, 0, 0.2, 1)"
              : "opacity 250ms ease-out, height 250ms ease-out, top 250ms ease-out",
          pointerEvents: "none",
        }}
      />
      {/* Impact ring at strike — bright at strike moment, expanding + fading during recoil. */}
      {phase !== "drop" ? (
        <div
          style={{
            position: "fixed",
            left: x - 20,
            top: top + height / 2 - 20,
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: "2px solid rgba(255,230,120,0.8)",
            opacity: phase === "strike" ? 0.9 : 0,
            transform:
              phase === "strike" ? "scale(0.6)" : "scale(1.6)",
            transition:
              phase === "recoil"
                ? "opacity 300ms ease-out, transform 300ms ease-out"
                : "none",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {/* Stick figure — falls into strike position, bounces on recoil */}
      <div
        style={{
          position: "fixed",
          left: x - FIGURE_HALF,
          top: figureY,
          transition,
          opacity: phase === "recoil" ? 0 : 1,
          pointerEvents: "none",
          color: "rgba(255, 220, 100, 0.95)",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.4))",
        }}
      >
        <StickFigure
          pose={phase === "strike" ? "cutting" : "cutting"}
          facing="right"
        />
      </div>
    </>
  );
}
