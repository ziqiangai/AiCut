import { createId } from "./ids.js";
import { interpolateProp } from "./keyframes/interpolate.js";
import type {
  AspectRatio,
  Clip,
  Keyframe,
  KeyframeProp,
  Ms,
  Project,
  ProjectOutput,
  Track,
} from "./types.js";

/**
 * Default 1080p-tier output dimensions per aspect ratio — the canvas
 * the editor renders into when the user picks an aspect from the
 * built-in chip. 1080p is the lowest-common-denominator distribution
 * target (web, mobile, most SaaS encoders) and matches CapCut's
 * "Standard 1080p" default. Hosts can override by writing directly
 * into `project.output` via `editor.setOutput(...)`.
 */
export const DEFAULT_OUTPUT_DIMS: Record<
  AspectRatio,
  { width: number; height: number }
> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "4:5": { width: 1080, height: 1350 },
  "21:9": { width: 2560, height: 1080 },
};

/** Pick canvas dims for a chosen aspect, snapping to even pixels. */
export function defaultOutputForAspect(
  aspect: AspectRatio,
): { width: number; height: number } {
  const d = DEFAULT_OUTPUT_DIMS[aspect];
  return { width: evenPx(d.width), height: evenPx(d.height) };
}

function evenPx(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r - 1;
}

const KEYFRAME_PROPS: KeyframeProp[] = ["panX", "panY", "scale"];

/**
 * Default frame rate when a project has no `fps`. 30 matches CapCut /
 * Premiere "new project" defaults. Changing this is a project-wide
 * UX shift — the user should opt in via `Project.fps`.
 */
export const DEFAULT_FPS = 30;
/** Shift + arrow nudges this many frames at once. */
export const BIG_FRAME_STEP = 10;

/**
 * Project's effective fps. Resolution order: `output.fps` (new) →
 * top-level `fps` (legacy back-compat) → `DEFAULT_FPS`. The two
 * fields coexist so existing projects keep working without a manual
 * migration; `setOutput` writes to `output.fps` going forward.
 */
export function projectFps(project: Project): number {
  const fromOutput = project.output?.fps;
  if (fromOutput != null && fromOutput > 0) return fromOutput;
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

// ── Query helpers ──────────────────────────────────────────────────
// Pure functions on a Project snapshot. Meant for tool-loops / AI
// callers that get a project from `editor.getProject()` and want to
// answer "what's at time X on track Y" without scanning the JSON
// themselves. All return references into the passed project, do NOT
// mutate.

/**
 * First clip on any track that contains `timeMs` (inclusive start,
 * exclusive end). Pass `trackIndex` to restrict to a single track;
 * omit to scan tracks top-down and return the first match.
 * Returns `null` if no clip matches.
 */
export function findClipAt(
  project: Project,
  timeMs: Ms,
  trackIndex?: number,
): { track: Track; clip: Clip } | null {
  if (trackIndex != null) {
    const t = project.tracks[trackIndex];
    if (!t) return null;
    const c = findClipContaining(t, timeMs);
    return c ? { track: t, clip: c } : null;
  }
  for (const t of project.tracks) {
    const c = findClipContaining(t, timeMs);
    if (c) return { track: t, clip: c };
  }
  return null;
}

/**
 * All clips whose playable interval overlaps `[startMs, endMs)`. Half-
 * open range matches `findClipContaining`. Order preserved (per-track,
 * left-to-right). Pass `trackIndex` to restrict to a single track.
 */
export function getClipsInRange(
  project: Project,
  startMs: Ms,
  endMs: Ms,
  trackIndex?: number,
): Array<{ trackIndex: number; track: Track; clip: Clip }> {
  const out: Array<{ trackIndex: number; track: Track; clip: Clip }> = [];
  const tracks =
    trackIndex != null
      ? project.tracks[trackIndex]
        ? [{ i: trackIndex, t: project.tracks[trackIndex]! }]
        : []
      : project.tracks.map((t, i) => ({ i, t }));
  for (const { i, t } of tracks) {
    for (const c of t.clips) {
      const cStart = c.start;
      const cEnd = clipEnd(c);
      if (!(cEnd <= startMs || cStart >= endMs)) {
        out.push({ trackIndex: i, track: t, clip: c });
      }
    }
  }
  return out;
}

/** All clips on a specific track, in timeline order. Empty if index
 *  is out of range. */
export function getClipsOnTrack(project: Project, trackIndex: number): Clip[] {
  const t = project.tracks[trackIndex];
  if (!t) return [];
  // Returns a shallow copy so callers can't accidentally mutate the
  // track's internal ordering.
  return t.clips.slice();
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
  // Preserve top-level project fields beyond version/sources/tracks.
  // `aspect`, `fps`, and `output` are authored state that must survive
  // a setProject round-trip — without this, picking 9:16 in the toolbar
  // and then adding a clip (which routes through setProject) used to
  // silently reset the canvas back to the first-clip fallback.
  const norm: Project = { version: 1, sources, tracks };
  if (project.aspect != null) norm.aspect = project.aspect;
  if (project.fps != null && project.fps > 0) norm.fps = project.fps;
  // Fill in `output` for projects that don't have it yet — `aspect`
  // → DEFAULT_OUTPUT_DIMS, falling back to a sane 1080p when neither
  // is set. Hosts that need a different size can call `setOutput`
  // anytime; once persisted in the project JSON the migration is
  // a no-op.
  const explicit = normalizeOutput(project.output);
  if (explicit) {
    norm.output = explicit;
  } else if (project.aspect) {
    const dims = defaultOutputForAspect(project.aspect);
    norm.output = { width: dims.width, height: dims.height };
    if (project.fps != null && project.fps > 0) norm.output.fps = project.fps;
  }
  return norm;
}

function normalizeOutput(
  output: ProjectOutput | undefined,
): ProjectOutput | null {
  if (!output) return null;
  const w = evenPx(output.width);
  const h = evenPx(output.height);
  if (w <= 0 || h <= 0) return null;
  const norm: ProjectOutput = { width: w, height: h };
  if (output.fps != null && output.fps > 0) norm.fps = output.fps;
  return norm;
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

// ── Timeline ↔ source time conversion ────────────────────────────
// A `Clip` has:
//   - `clip.start`     — timeline-absolute Ms where the clip begins
//   - `clip.in`        — Ms into the source where playback starts
//   - `clip.out`       — Ms into the source where playback ends
// So local (source) time = clip.in + (timelineTime - clip.start).
// Speed multiplier compresses the mapping but for MVP we treat clips
// as 1× — matches how `clipDuration()` handles missing `speed`.

/** Convert a timeline-absolute Ms into the source-local Ms of the
 *  given clip. Result is clamped to `[clip.in, clip.out]`. */
export function timelineToSourceMs(clip: Clip, timelineMs: Ms): Ms {
  const raw = clip.in + (timelineMs - clip.start);
  if (raw < clip.in) return clip.in;
  if (raw > clip.out) return clip.out;
  return raw;
}

/** Inverse of `timelineToSourceMs`. Result clamped to
 *  `[clip.start, clip.start + duration]`. */
export function sourceToTimelineMs(clip: Clip, sourceMs: Ms): Ms {
  const raw = clip.start + (sourceMs - clip.in);
  if (raw < clip.start) return clip.start;
  const end = clipEnd(clip);
  if (raw > end) return end;
  return raw;
}

export function projectDuration(project: Project): Ms {
  let max = 0;
  for (const t of project.tracks) {
    const e = trackEnd(t);
    if (e > max) max = e;
  }
  return max;
}
