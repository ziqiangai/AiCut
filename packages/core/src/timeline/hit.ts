import type { Project } from "../types.js";
import {
  HANDLE_PX,
  HEADER_WIDTH,
  RULER_HEIGHT,
  SCROLLBAR_INSET,
  SCROLLBAR_MIN_THUMB,
  SCROLLBAR_THICKNESS,
  TRACK_HEIGHT,
  contentHeight,
  contentLeftX,
  contentWidth,
  trackIndexAt,
  trackY,
  xToMs,
} from "./layout.js";

export type HitTarget =
  | { kind: "ruler" }
  | { kind: "header"; trackIndex: number }
  | { kind: "header-delete"; trackIndex: number }
  | { kind: "track-empty"; trackIndex: number }
  | { kind: "clip"; trackIndex: number; clipId: string }
  | { kind: "clip-handle-left"; trackIndex: number; clipId: string }
  | { kind: "clip-handle-right"; trackIndex: number; clipId: string }
  | { kind: "keyframe"; trackIndex: number; clipId: string; keyframeId: string }
  | { kind: "phantom-new-track" }
  /** Drag the thumb itself — caller stores pointerStart + scrollStart. */
  | { kind: "scrollbar-thumb-v"; thumbY: number; thumbLen: number }
  | { kind: "scrollbar-thumb-h"; thumbX: number; thumbLen: number }
  /** Click the gutter (anywhere on the bar that isn't the thumb) →
   *  page-jump by one viewport in the direction of the click. */
  | { kind: "scrollbar-track-v"; before: boolean }
  | { kind: "scrollbar-track-h"; before: boolean }
  | { kind: "outside" };

export interface HitContext {
  project: Project;
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  showHeader: boolean;
  viewportWidth: number;
  viewportHeight: number;
  isDragging: boolean;
  /** When true, hit-test keyframe diamonds before the broad clip body. */
  keyframesEnabled: boolean;
}

/** Pixel half-width of the keyframe diamond hit zone — generous so a
 *  small target is easy to grab even at low zoom. */
/**
 * Hit radius for keyframe diamonds. Visual diamond is 10×10 px, so a
 * 12 px radius makes the kf reliably grabbable even when the cursor
 * lands a few px off-center — without it, a near-miss click slips
 * through to clip-drag and the user thinks "the diamond vanished
 * when I tried to drag it" (the dim source clip used to skip drawing
 * its keyframes, compounding the perception). Compromise: trim
 * handles get crowded out a little further, but trim is its own
 * dedicated edge with bigger hit zones.
 */
const KEYFRAME_HIT_RADIUS = 12;

/**
 * Pixel → semantic target. Branches in roughly this order:
 *   1. Ruler band (top RULER_HEIGHT px) → scrub
 *   2. Header column (left HEADER_WIDTH px, when visible) → track header
 *   3. Track row contents → clip body / edge handle / empty space
 *
 * The handle-edge check is generous (HANDLE_PX) so users can grab a
 * trim handle even on a clip that's only a few px wide at low zoom.
 */
export function hitTest(x: number, y: number, ctx: HitContext): HitTarget {
  if (y < 0 || x < 0) return { kind: "outside" };

  // ---- Scrollbars first ----------------------------------------------
  // The bars overlay everything else, so a click on the thumb must NEVER
  // fall through to "select clip" / "seek". Check them before any other
  // region resolves.
  const baseX = contentLeftX(ctx.showHeader);
  const visibleH = ctx.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS;
  const contentH = contentHeight(ctx.project.tracks, ctx.isDragging);
  // Vertical bar
  if (
    contentH > visibleH &&
    x >= ctx.viewportWidth - SCROLLBAR_THICKNESS &&
    x < ctx.viewportWidth &&
    y >= RULER_HEIGHT &&
    y < ctx.viewportHeight - SCROLLBAR_THICKNESS
  ) {
    const trackLen = visibleH - SCROLLBAR_INSET * 2;
    const thumbLen = Math.max(
      SCROLLBAR_MIN_THUMB,
      trackLen * (visibleH / contentH),
    );
    const maxScroll = contentH - visibleH;
    const thumbY =
      RULER_HEIGHT +
      SCROLLBAR_INSET +
      (maxScroll > 0 ? (ctx.scrollTop / maxScroll) * (trackLen - thumbLen) : 0);
    if (y >= thumbY && y <= thumbY + thumbLen) {
      return { kind: "scrollbar-thumb-v", thumbY, thumbLen };
    }
    return { kind: "scrollbar-track-v", before: y < thumbY };
  }
  // Horizontal bar
  const visibleW = ctx.viewportWidth - baseX - SCROLLBAR_THICKNESS;
  const contentW = contentWidth(ctx.project, ctx.pxPerSec);
  if (
    contentW > visibleW &&
    y >= ctx.viewportHeight - SCROLLBAR_THICKNESS &&
    y < ctx.viewportHeight &&
    x >= baseX &&
    x < ctx.viewportWidth - SCROLLBAR_THICKNESS
  ) {
    const trackLen = visibleW - SCROLLBAR_INSET * 2;
    const thumbLen = Math.max(
      SCROLLBAR_MIN_THUMB,
      trackLen * (visibleW / contentW),
    );
    const maxScroll = contentW - visibleW;
    const thumbX =
      baseX +
      SCROLLBAR_INSET +
      (maxScroll > 0
        ? (ctx.scrollLeft / maxScroll) * (trackLen - thumbLen)
        : 0);
    if (x >= thumbX && x <= thumbX + thumbLen) {
      return { kind: "scrollbar-thumb-h", thumbX, thumbLen };
    }
    return { kind: "scrollbar-track-h", before: x < thumbX };
  }

  if (ctx.showHeader && x < HEADER_WIDTH && y >= RULER_HEIGHT) {
    const ti = trackIndexAt(y, ctx.project.tracks.length, ctx.scrollTop);
    if (ti >= 0) {
      const track = ctx.project.tracks[ti]!;
      if (track.clips.length === 0) {
        const btnSize = 18;
        const btnLeft = HEADER_WIDTH - btnSize - 6;
        // Header rows are translated by -scrollTop when painted, so
        // their visible top in viewport coords is `trackY(i) - scrollTop`.
        const btnTop =
          RULER_HEIGHT +
          ti * TRACK_HEIGHT +
          (TRACK_HEIGHT - btnSize) / 2 -
          ctx.scrollTop;
        if (
          x >= btnLeft &&
          x <= btnLeft + btnSize &&
          y >= btnTop &&
          y <= btnTop + btnSize
        ) {
          return { kind: "header-delete", trackIndex: ti };
        }
      }
      return { kind: "header", trackIndex: ti };
    }
    return { kind: "outside" };
  }

  if (y < RULER_HEIGHT) return { kind: "ruler" };

  const ti = trackIndexAt(y, ctx.project.tracks.length, ctx.scrollTop);
  if (ti < 0) return { kind: "outside" };
  const track = ctx.project.tracks[ti]!;
  const ms = xToMs(x, ctx.pxPerSec, ctx.scrollLeft, ctx.showHeader);

  // Pass 1 — when keyframes mode is on, scan every clip on the row
  // for a diamond within KEYFRAME_HIT_RADIUS. Done BEFORE the per-
  // clip handle / body pass because:
  //   - A keyframe at the clip's start (clip-local time = 0) sits
  //     exactly on top of the trim handle's hit zone. Without
  //     priority here, the handle wins and the keyframe becomes
  //     unclickable. Common case: user pins the opening pose with
  //     keyframe at t=0 — exactly what the toolbar button creates.
  //   - The hit radius (8 px) can also extend slightly outside the
  //     clip body (e.g. into a small inter-clip gap), so checking
  //     before the "ms inside clip" branch keeps the kf clickable
  //     near edges.
  // Trade-off: while keyframes mode is enabled, dragging the trim
  // handle of a clip with a kf at t=0 needs you to grab a kf-free
  // spot first. Acceptable since keyframe editing is the active mode.
  if (ctx.keyframesEnabled) {
    for (const clip of track.clips) {
      if (!clip.keyframes || clip.keyframes.length === 0) continue;
      const startX = msToXLocal(clip.start, ctx);
      for (const kf of clip.keyframes) {
        const kfX = startX + (kf.time / 1000) * ctx.pxPerSec;
        if (Math.abs(x - kfX) <= KEYFRAME_HIT_RADIUS) {
          return {
            kind: "keyframe",
            trackIndex: ti,
            clipId: clip.id,
            keyframeId: kf.id,
          };
        }
      }
    }
  }

  // Pass 2 — clip handles + body. Same logic as before.
  for (const clip of track.clips) {
    const start = clip.start;
    const end = clip.start + (clip.out - clip.in);
    const startX = msToXLocal(start, ctx);
    const endX = msToXLocal(end, ctx);

    if (x >= startX - HANDLE_PX && x <= startX + HANDLE_PX) {
      return { kind: "clip-handle-left", trackIndex: ti, clipId: clip.id };
    }
    if (x >= endX - HANDLE_PX && x <= endX + HANDLE_PX) {
      return { kind: "clip-handle-right", trackIndex: ti, clipId: clip.id };
    }
    if (ms >= start && ms < end) {
      return { kind: "clip", trackIndex: ti, clipId: clip.id };
    }
  }
  return { kind: "track-empty", trackIndex: ti };
}

function msToXLocal(ms: number, ctx: HitContext): number {
  return contentLeftX(ctx.showHeader) + (ms / 1000) * ctx.pxPerSec - ctx.scrollLeft;
}
