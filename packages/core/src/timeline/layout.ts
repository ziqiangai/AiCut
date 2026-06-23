import type { Clip, Ms, Project, Track } from "../types.js";

/** Visual constants — kept here so draw + hit-test share one source of truth. */
export const TRACK_HEIGHT = 56;
export const RULER_HEIGHT = 24;
export const HEADER_WIDTH = 96;
export const HANDLE_PX = 8;
export const CLIP_INSET = 6;
export const SCALE_MIN = 10;
export const SCALE_MAX = 400;

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

/** Convert timeline ms → x pixel coordinate, accounting for header + scroll. */
export function msToX(
  timeMs: Ms,
  pxPerSec: number,
  scrollLeft: number,
  showHeader: boolean,
): number {
  const base = showHeader ? HEADER_WIDTH : 0;
  return base + (timeMs / 1000) * pxPerSec - scrollLeft;
}

/** Convert x pixel coordinate back → timeline ms. */
export function xToMs(
  x: number,
  pxPerSec: number,
  scrollLeft: number,
  showHeader: boolean,
): Ms {
  const base = showHeader ? HEADER_WIDTH : 0;
  return Math.max(0, ((x - base + scrollLeft) / pxPerSec) * 1000);
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
