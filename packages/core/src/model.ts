import { createId } from "./ids.js";
import { interpolateProp } from "./keyframes/interpolate.js";
import type { Clip, Keyframe, KeyframeProp, Ms, Project, Track } from "./types.js";

const KEYFRAME_PROPS: KeyframeProp[] = ["panX", "panY", "scale"];

/**
 * Default frame rate when a project has no `fps`. 30 matches CapCut /
 * Premiere "new project" defaults. Changing this is a project-wide
 * UX shift — the user should opt in via `Project.fps`.
 */
export const DEFAULT_FPS = 30;
/** Shift + arrow nudges this many frames at once. */
export const BIG_FRAME_STEP = 10;

/** Project's effective fps — falls back to the default when unset. */
export function projectFps(project: Project): number {
  const f = project.fps;
  return f != null && f > 0 ? f : DEFAULT_FPS;
}

/** Milliseconds per frame at the project's fps. Rounded to integer ms
 *  because the playhead is integer-ms and we don't want sub-ms drift. */
export function frameStepMs(project: Project): number {
  return Math.max(1, Math.round(1000 / projectFps(project)));
}

/** Milliseconds for a shift+arrow nudge (one "big step" = N frames). */
export function bigFrameStepMs(project: Project): number {
  return Math.max(1, Math.round((BIG_FRAME_STEP * 1000) / projectFps(project)));
}

export function createEmptyProject(): Project {
  return {
    version: 1,
    sources: [],
    tracks: [{ id: createId("track"), kind: "video", clips: [] }],
  };
}

export function clipDuration(c: Clip): Ms {
  return c.out - c.in;
}

/** End of a clip on the timeline (start + duration). */
export function clipEnd(c: Clip): Ms {
  return c.start + clipDuration(c);
}

export function trackEnd(track: Track): Ms {
  let max = 0;
  for (const c of track.clips) {
    const end = clipEnd(c);
    if (end > max) max = end;
  }
  return max;
}

/**
 * Find which clip on the track contains `timeMs`. Edges:
 *   - start inclusive
 *   - end exclusive (a clip ending at T does not contain T)
 */
export function findClipContaining(track: Track, timeMs: Ms): Clip | null {
  for (const c of track.clips) {
    if (timeMs >= c.start && timeMs < clipEnd(c)) return c;
  }
  return null;
}

export function findTrackOfClip(
  project: Project,
  clipId: string,
): Track | null {
  for (const t of project.tracks) {
    if (t.clips.some((c) => c.id === clipId)) return t;
  }
  return null;
}

/**
 * Defensive normalization — ensures clips on each track are sorted by
 * `start`, IDs exist, and trivially-empty clips (out <= in) are dropped.
 * Called from `Editor.setProject` so consumers can hand us loosely-formed
 * JSON without risking inconsistent internal state.
 */
export function normalizeProject(project: Project): Project {
  const sources = project.sources.map((s) => ({ ...s }));
  const tracks = project.tracks.map<Track>((t) => {
    const clips = t.clips
      .filter((c) => c.out > c.in)
      .map<Clip>((c) => {
        const out: Clip = { ...c, id: c.id || createId("clip") };
        if (c.keyframes && c.keyframes.length > 0) {
          // Sort by (prop, time) + assign ids to any keyframe missing
          // one. Drop empties / out-of-range keyframes (defensive — a
          // host restoring a stale snapshot might have them).
          //
          // Also: migrate the v0.5 tuple-keyframe format
          //   { time, x?, y?, scale? }
          // into per-property keyframes if we see any. Old projects
          // round-trip cleanly into the new model without the host
          // having to know.
          const duration = c.out - c.in;
          out.keyframes = migrateKeyframes(c.keyframes)
            .filter((kf) => kf.time >= 0 && kf.time <= duration)
            .map<Keyframe>((kf) => ({ ...kf, id: kf.id || createId("kf") }))
            .sort((a, b) => {
              if (a.prop !== b.prop) return a.prop.localeCompare(b.prop);
              return a.time - b.time;
            });
        }
        return out;
      })
      .sort((a, b) => a.start - b.start);
    return { ...t, id: t.id || createId("track"), clips };
  });
  return { version: 1, sources, tracks };
}

/**
 * Back-compat: the v0.5 keyframe shape was a single object with
 * `{ time, x?, y?, scale? }` — all three values together. v0.6 splits
 * them into per-property entries `{ prop, time, value }`. If we see
 * the old shape, fan out into N per-property keyframes; otherwise
 * pass through unchanged.
 */
function migrateKeyframes(
  raw: Array<
    | Keyframe
    | { id?: string; time: number; x?: number; y?: number; scale?: number }
  >,
): Keyframe[] {
  const out: Keyframe[] = [];
  for (const kf of raw) {
    if ("prop" in kf && "value" in kf) {
      out.push(kf as Keyframe);
      continue;
    }
    // Old tuple shape — fan out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tuple = kf as any;
    const id = tuple.id;
    const t = tuple.time;
    if (typeof tuple.x === "number") {
      out.push({
        id: id ? `${id}-px` : createId("kf"),
        prop: "panX",
        time: t,
        value: tuple.x,
      });
    }
    if (typeof tuple.y === "number") {
      out.push({
        id: id ? `${id}-py` : createId("kf"),
        prop: "panY",
        time: t,
        value: tuple.y,
      });
    }
    if (typeof tuple.scale === "number") {
      out.push({
        id: id ? `${id}-s` : createId("kf"),
        prop: "scale",
        time: t,
        value: tuple.scale,
      });
    }
  }
  return out;
}

/** Splits a clip at `localOffset` ms (measured from clip.start on the timeline). */
export function splitClipAt(clip: Clip, localOffset: Ms): [Clip, Clip] | null {
  const sourceLen = clip.out - clip.in;
  if (localOffset <= 0 || localOffset >= sourceLen) return null;
  const left: Clip = { ...clip, out: clip.in + localOffset };
  const right: Clip = {
    ...clip,
    id: createId("clip"),
    in: clip.in + localOffset,
    start: clip.start + localOffset,
  };
  // Partition keyframes across the cut, AND insert interpolated
  // boundary keyframes at the seam so playing the two halves back-to-
  // back is visually identical to the un-cut clip. Without the
  // boundary insertion, a cut mid-ramp would snap to the prior kf's
  // value on the left half (because "after last kf = hold") and to
  // the next kf's value on the right half — instant value jump at
  // the seam. Done per-property because only the props that actually
  // have keyframes need a boundary; props that ride the static base
  // are inherited unchanged.
  //
  // Static base values (panX / panY / scale) are inherited unchanged
  // by both halves — they were per-clip defaults.
  if (clip.keyframes && clip.keyframes.length > 0) {
    const leftKf: Keyframe[] = [];
    const rightKf: Keyframe[] = [];
    for (const prop of KEYFRAME_PROPS) {
      const propKfs = clip.keyframes.filter((k) => k.prop === prop);
      if (propKfs.length === 0) continue;
      const boundaryValue = interpolateProp(clip, prop, localOffset);
      let leftSeamPresent = false;
      let rightSeamPresent = false;
      for (const kf of propKfs) {
        if (kf.time < localOffset) {
          leftKf.push(kf);
        } else if (kf.time > localOffset) {
          // Re-id the shifted ones — the original kf belongs to the
          // left half conceptually; the right half is a brand-new clip.
          rightKf.push({ ...kf, id: createId("kf"), time: kf.time - localOffset });
        } else {
          // kf sits exactly on the cut. It IS the seam — keep on the
          // left at its current time, and clone to the right at t=0.
          leftKf.push(kf);
          leftSeamPresent = true;
          rightKf.push({ ...kf, id: createId("kf"), time: 0 });
          rightSeamPresent = true;
        }
      }
      if (!leftSeamPresent) {
        leftKf.push({
          id: createId("kf"),
          prop,
          time: localOffset,
          value: boundaryValue,
        });
      }
      if (!rightSeamPresent) {
        rightKf.push({
          id: createId("kf"),
          prop,
          time: 0,
          value: boundaryValue,
        });
      }
    }
    left.keyframes = leftKf.length > 0 ? leftKf : undefined;
    right.keyframes = rightKf.length > 0 ? rightKf : undefined;
  }
  return [left, right];
}

/** Alias retained for back-compat with existing call sites. */
export function findClipAt(track: Track, timeMs: Ms): Clip | null {
  return findClipContaining(track, timeMs);
}

export function projectDuration(project: Project): Ms {
  let max = 0;
  for (const t of project.tracks) {
    const e = trackEnd(t);
    if (e > max) max = e;
  }
  return max;
}
