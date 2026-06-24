import type { Clip, EasingKind, Keyframe, KeyframeProp, Ms } from "../types.js";
import {
  IDENTITY_TRANSFORM,
  type EffectiveTransform,
} from "./types.js";

/**
 * Map normalized time t∈[0,1] to eased t' via cubic easing. Cubic was
 * picked over quadratic because the start / end "stickiness" is more
 * pronounced — when the user picks `easeIn` they typically want the
 * motion to clearly hold at the start, not just barely slow down.
 *
 * `easing` is the leaving keyframe's outgoing curve — matches AE /
 * Premiere / CapCut convention so the user only sets it once per kf,
 * not once per segment.
 */
export function applyEasing(t: number, easing: EasingKind): number {
  switch (easing) {
    case "linear":
      return t;
    case "easeIn":
      return t * t * t;
    case "easeOut": {
      const u = 1 - t;
      return 1 - u * u * u;
    }
    case "easeInOut":
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

/** Default value when a property has neither static base nor keyframes. */
function defaultFor(prop: KeyframeProp): number {
  return prop === "scale" ? 1 : 0;
}

/** Static fallback for `prop` on a clip. */
function staticValue(clip: Clip, prop: KeyframeProp): number {
  const v = clip[prop];
  return v ?? defaultFor(prop);
}

/**
 * Sub-keyframes for a single property in time order. Cheap on small
 * arrays (a few keyframes per clip in practice) — no caching needed.
 */
export function keyframesForProp(
  kfs: Keyframe[],
  prop: KeyframeProp,
): Keyframe[] {
  const out: Keyframe[] = [];
  for (const k of kfs) if (k.prop === prop) out.push(k);
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** True when the clip has any keyframes pinning this property. */
export function hasKeyframesForProp(clip: Clip, prop: KeyframeProp): boolean {
  return clip.keyframes?.some((k) => k.prop === prop) ?? false;
}

/**
 * Interpolate one property at the given clip-local time.
 *
 * Rules per property:
 *   - No keyframes for this prop → static base (or 0 / 1).
 *   - Before first keyframe → first keyframe's value (held).
 *   - After last keyframe   → last keyframe's value (held).
 *   - Between two           → linear interpolation.
 */
export function interpolateProp(
  clip: Clip,
  prop: KeyframeProp,
  localMs: Ms,
): number {
  if (!clip.keyframes || clip.keyframes.length === 0) {
    return staticValue(clip, prop);
  }
  const arr = keyframesForProp(clip.keyframes, prop);
  if (arr.length === 0) return staticValue(clip, prop);
  if (arr.length === 1) return arr[0]!.value;
  const first = arr[0]!;
  const last = arr[arr.length - 1]!;
  if (localMs <= first.time) return first.value;
  if (localMs >= last.time) return last.value;
  for (let i = 0; i < arr.length - 1; i += 1) {
    const a = arr[i]!;
    const b = arr[i + 1]!;
    if (localMs >= a.time && localMs <= b.time) {
      if (b.time === a.time) return a.value;
      const rawT = (localMs - a.time) / (b.time - a.time);
      // Easing belongs to the LEAVING keyframe (a) — the curve from
      // a→b is shaped by a.easing. Undefined / missing field
      // gracefully degrades to "linear" so old projects look the same.
      const eased = applyEasing(rawT, a.easing ?? "linear");
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * Effective transform = all three properties evaluated together. The
 * engine applies this to the content inside the fixed output frame:
 * scale around frame center, then translate by (panX, panY).
 */
export function getEffectiveTransform(
  clip: Clip,
  localMs: Ms,
): EffectiveTransform {
  if (
    (!clip.keyframes || clip.keyframes.length === 0) &&
    clip.panX === undefined &&
    clip.panY === undefined &&
    clip.scale === undefined
  ) {
    return IDENTITY_TRANSFORM;
  }
  return {
    panX: interpolateProp(clip, "panX", localMs),
    panY: interpolateProp(clip, "panY", localMs),
    scale: interpolateProp(clip, "scale", localMs),
  };
}

/** Same as `getEffectiveTransform` but takes timeline-absolute time. */
export function getTransformAtTimelineTime(
  clip: Clip,
  timelineMs: Ms,
): EffectiveTransform {
  return getEffectiveTransform(clip, timelineMs - clip.start);
}

/**
 * Insert a keyframe for `prop` at `time`, or update value if one
 * already exists at the same (rounded) time. Returns the next array.
 *
 * The 16ms tolerance handles "click button while seeking" — two
 * keyframes 1 frame apart get coalesced. Reference behavior.
 */
export function upsertKeyframe(
  kfs: Keyframe[] | undefined,
  prop: KeyframeProp,
  time: Ms,
  value: number,
  idFactory: () => string,
): Keyframe[] {
  const existing = kfs ?? [];
  const idx = existing.findIndex(
    (k) => k.prop === prop && Math.abs(k.time - time) < 16,
  );
  if (idx >= 0) {
    const next = existing.slice();
    next[idx] = { ...next[idx]!, value };
    return next;
  }
  return [...existing, { id: idFactory(), prop, time, value }];
}

/** Drop every keyframe for one prop on a clip. */
export function removeKeyframesForProp(
  kfs: Keyframe[] | undefined,
  prop: KeyframeProp,
): Keyframe[] {
  return (kfs ?? []).filter((k) => k.prop !== prop);
}
