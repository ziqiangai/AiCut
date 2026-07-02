/**
 * `<Bear>` — the default character for the shipped effects. Two poses:
 *
 *   chop  — arms raised overhead, ready to swing down. Used by
 *           `defaultSplitEffect` (the swing IS the cut).
 *   carry — arms outstretched forward, ready to hold or hug the ghost
 *           clip. Used by `defaultMoveEffect`.
 *
 * The bear is a raster sticker (WebP data URL) rather than SVG paths
 * so its expression stays high-fidelity at small sizes without hand-
 * drawing every curve. Motion is the effect handler's job — the bear
 * itself is a single crisp image that gets translated / scaled /
 * rotated by the parent. This is deliberate: pose-flipping between
 * frames is what made the previous StickFigure-based defaults read
 * as choppy stop-motion.
 */
import { type ReactElement } from "react";
import { BEAR_CHOP, BEAR_CARRY } from "../assets/bears.js";

export type BearPose = "chop" | "carry";

export interface BearProps {
  pose: BearPose;
  /** Rendered edge length in CSS px. Default 72. Source is 384px so
   *  it stays crisp up to ~4× DPR. */
  size?: number;
}

const SRC: Record<BearPose, string> = {
  chop: BEAR_CHOP,
  carry: BEAR_CARRY,
};

export function Bear({ pose, size = 72 }: BearProps): ReactElement {
  return (
    <img
      src={SRC[pose]}
      alt=""
      draggable={false}
      style={{
        width: size,
        height: size,
        display: "block",
        userSelect: "none",
        pointerEvents: "none",
        // Sticker JPEGs already have transparent-friendly borders,
        // but a small drop-shadow lifts the bear off dark preview
        // areas and gives it depth.
        filter:
          "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.55)) drop-shadow(0 0 3px rgba(255, 255, 255, 0.4))",
      }}
    />
  );
}
