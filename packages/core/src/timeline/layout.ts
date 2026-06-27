import type { Clip, Ms, Project, Track } from "../types.js";

/** Visual constants — kept here so draw + hit-test share one source of truth.
 *  The two row-height values are `let` rather than `const` so hosts can
 *  shrink the timeline footprint for small screens via
 *  `setTimelineMetrics(...)`. ES module live bindings mean every importer
 *  sees the updated value automatically. */
export let TRACK_HEIGHT = 56;
export let RULER_HEIGHT = 24;
export const HEADER_WIDTH = 96;
export const HANDLE_PX = 8;
export const CLIP_INSET = 6;
export const SCALE_MIN = 10;
/** Tuned so the user can zoom down to "1 frame per major tick" at
 *  30 fps with the default `rulerMinTickPx` (80px). 80px × 30 fps =
 *  2400 px/sec. Higher fps projects can still hit 1-frame granularity
 *  visually by lowering `rulerMinTickPx`. */
export const SCALE_MAX = 2400;

/**
 * Left / right padding inside the timeline canvas, between the header
 * column (or canvas edge when the header is hidden) and where actual
 * content (clips + ruler ticks + playhead) is drawn. Without this the
 * t=0 playhead has its left half clipped, the first clip touches the
 * canvas edge, and the visual rhythm with the rest of the editor
 * chrome is off.
 */
export const TIMELINE_PAD_LEFT = 12;
export const TIMELINE_PAD_RIGHT = 12;

/**
 * Where on the canvas does the timeline CONTENT area start (in CSS
 * pixels)? Combines the optional header column with the left padding.
 * Use this instead of `showHeader ? HEADER_WIDTH : 0` everywhere —
 * one place to change if the padding ever becomes configurable.
 */
export function contentLeftX(showHeader: boolean): number {
  return (showHeader ? HEADER_WIDTH : 0) + TIMELINE_PAD_LEFT;
}

/**
 * Override the default timeline row + ruler heights. Process-wide — call
 * before / during editor construction. Useful when the editor is mounted
 * in a small viewport (e.g. side-by-side panel on a laptop) and the
 * default 56px tracks crowd out the preview.
 *
 * Reasonable ranges: trackHeight ∈ [28, 96], rulerHeight ∈ [18, 36].
 * Anything smaller leaves no room for the clip label or the time ticks.
 *
 * Multi-editor mounts share these values. If you have two editors with
 * different needs, agree on the smaller one or remount on switch.
 */
export function setTimelineMetrics(opts: {
  trackHeight?: number;
  rulerHeight?: number;
}): void {
  if (opts.trackHeight != null && opts.trackHeight > 0) {
    TRACK_HEIGHT = Math.round(opts.trackHeight);
  }
  if (opts.rulerHeight != null && opts.rulerHeight > 0) {
    RULER_HEIGHT = Math.round(opts.rulerHeight);
  }
}

/** Scrollbar geometry. */
export const SCROLLBAR_THICKNESS = 10;
/** Minimum thumb length so it stays grabbable at large content sizes. */
export const SCROLLBAR_MIN_THUMB = 24;
/** Gutter inset from the canvas edges so the bar doesn't clip. */
export const SCROLLBAR_INSET = 2;

/** Total height = ruler + sum of tracks. Caller decides if it wants more. */
export function totalHeight(tracks: Track[]): number {
  return RULER_HEIGHT + tracks.length * TRACK_HEIGHT;
}

/**
 * Track-stack content height — what the scrollbars compare against
 * the visible track region. Includes one extra TRACK_HEIGHT when a
 * drag is in flight so the "+ 新轨道" phantom row is reachable.
 */
export function contentHeight(tracks: Track[], isDragging: boolean): number {
  return tracks.length * TRACK_HEIGHT + (isDragging ? TRACK_HEIGHT : 0);
}

/** Pixels of timeline content along the X axis at the given zoom. */
export function contentWidth(project: Project, pxPerSec: number): number {
  let max = 0;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      const end = c.start + (c.out - c.in);
      if (end > max) max = end;
    }
  }
  return (max / 1000) * pxPerSec;
}

/** Top-edge y for a track at `index`. */
export function trackY(index: number): number {
  return RULER_HEIGHT + index * TRACK_HEIGHT;
}

/** Inverse of trackY — which track index (or -1) does a given y fall in.
 *  `scrollTop` shifts the visible window down; pass 0 if not scrolling. */
export function trackIndexAt(
  y: number,
  trackCount: number,
  scrollTop = 0,
): number {
  if (y < RULER_HEIGHT) return -1;
  const contentY = y - RULER_HEIGHT + scrollTop;
  const idx = Math.floor(contentY / TRACK_HEIGHT);
  if (idx < 0 || idx >= trackCount) return -1;
  return idx;
}

/** Convert timeline ms → x pixel coordinate, accounting for header,
 *  the left padding, and scroll. */
export function msToX(
  timeMs: Ms,
  pxPerSec: number,
  scrollLeft: number,
  showHeader: boolean,
): number {
  return contentLeftX(showHeader) + (timeMs / 1000) * pxPerSec - scrollLeft;
}

/** Convert x pixel coordinate back → timeline ms. */
export function xToMs(
  x: number,
  pxPerSec: number,
  scrollLeft: number,
  showHeader: boolean,
): Ms {
  return Math.max(
    0,
    ((x - contentLeftX(showHeader) + scrollLeft) / pxPerSec) * 1000,
  );
}

/**
 * Choose a "nice" major-tick interval covering at least `targetSec`.
 * Drives the ruler so it never shows ugly intervals like every 3.7s.
 */
export function niceTickSeconds(targetSec: number): number {
  if (targetSec <= 0) return 1;
  const exp = Math.floor(Math.log10(targetSec));
  const base = targetSec / Math.pow(10, exp);
  let nice: number;
  if (base < 1.5) nice = 1;
  else if (base < 3) nice = 2;
  else if (base < 7) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

/**
 * Pick the ruler's major + sub tick interval for the given zoom + fps.
 *
 * Behavior matches CapCut-desktop: major ticks ALWAYS land on whole
 * seconds (1s, 2s, 5s, …) so the labels stay readable at every zoom.
 * Sub-ticks switch to frame-aligned spacing (1 per frame) once the
 * zoom is high enough to render a frame as ≥ `FRAME_SUB_MIN_PX` —
 * that's how seconds + 30 frames-per-second both stay visible at the
 * same time. At lower zoom we keep the classic 5-subs-per-major.
 */
const FRAME_SUB_MIN_PX = 10;

export interface RulerTicks {
  /** Major (labeled) tick interval in seconds. Always ≥ 1s. */
  majorSec: number;
  /** Unlabeled sub-tick interval in seconds. Smaller than majorSec. */
  subSec: number;
}

export function pickRulerTicks(
  targetSec: number,
  fps: number,
  pxPerSec: number,
): RulerTicks {
  const frameSec = 1 / Math.max(1, fps);
  // Major: pick the smallest nice interval ≥ 1s that's at least the
  // requested target. `niceTickSeconds` may return 0.2s / 0.5s at high
  // zoom — clamp those up to 1s so the labels stay "Ns" no matter how
  // far the user zooms in.
  const majorSec = Math.max(1, niceTickSeconds(targetSec));
  // Sub: drop to 1-frame ticks once frames are visually distinct.
  // Otherwise 5 subs per major (0.2s, 0.4s, …).
  const framePx = pxPerSec * frameSec;
  const subSec =
    framePx >= FRAME_SUB_MIN_PX ? frameSec : majorSec / 5;
  return { majorSec, subSec };
}

export function formatRulerLabel(sec: number): string {
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function clampScale(s: number): number {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, s));
}

/**
 * Snap targets aggregated from all clips in the project plus the
 * playhead and origin. Excludes the dragged clip (caller passes its id).
 */
export function snapTargets(
  project: Project,
  playheadMs: Ms,
  ignoreClipId: string | null,
): Ms[] {
  const arr: Ms[] = [0, playheadMs];
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.id === ignoreClipId) continue;
      arr.push(c.start, c.start + (c.out - c.in));
      // Each keyframe is a timeline-absolute snap target. Without this
      // keyframes can't snap to each other (or to clip drags hitting
      // a keyframe's time). Note: a keyframe's own time is also a
      // legit target during its own drag — same-time check in the
      // snap distance loop handles "snap to self" as a zero-cost no-op.
      if (c.keyframes) {
        for (const kf of c.keyframes) arr.push(c.start + kf.time);
      }
    }
  }
  return arr;
}

/**
 * Return whether placing `clip` at `start..end` on `track` would
 * collide with any *other* clip already on that track.
 */
export function wouldOverlap(
  track: Track,
  clipId: string,
  start: Ms,
  end: Ms,
): boolean {
  for (const c of track.clips) {
    if (c.id === clipId) continue;
    const cEnd = c.start + (c.out - c.in);
    if (start < cEnd && end > c.start) return true;
  }
  return false;
}

/** Look up `(track, clip)` for `clipId` across the project. */
export function findClip(
  project: Project,
  clipId: string,
): { track: Track; clip: Clip; trackIndex: number } | null {
  for (let i = 0; i < project.tracks.length; i++) {
    const t = project.tracks[i]!;
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { track: t, clip: c, trackIndex: i };
  }
  return null;
}

/**
 * Uncovered intervals across the whole video timeline, in ms — i.e.
 * spans where no clip on any video track plays. Returned in time
 * order, half-open `[start, end)`. Used by the drawer to highlight
 * gaps in warning color so the user notices accidentally orphaned
 * regions.
 */
export function uncoveredIntervals(project: Project): Array<[Ms, Ms]> {
  const intervals: Array<[Ms, Ms]> = [];
  for (const t of project.tracks) {
    if (t.kind !== "video") continue;
    for (const c of t.clips) {
      const end = c.start + (c.out - c.in);
      if (end > c.start) intervals.push([c.start, end]);
    }
  }
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[Ms, Ms]> = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const gaps: Array<[Ms, Ms]> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = e;
  }
  // Trailing gap (after last clip) is intentionally NOT reported —
  // that's "the end of the timeline", not a coverage hole.
  return gaps;
}
