/**
 * Public contracts for the effects layer. Kept in a standalone module
 * so custom-effect authors can import the types without pulling the
 * React component tree along for the ride.
 */
import type { ReactElement } from "react";
import type { OperationEvent, Ms } from "@aicut/core";

/**
 * Geometry helpers passed to every effect handler. The `<AiCutEffects>`
 * component computes these by walking the DOM (finding the timeline
 * canvas, the preview host, and reading their bounding rects). Handlers
 * use them to place their animation without doing DOM archaeology
 * themselves.
 *
 * All rects are in **viewport coordinates** (`getBoundingClientRect`),
 * which matches the coordinate system the overlay `<div>` uses —
 * effects should render inside the overlay with `position: fixed`
 * (or `position: absolute` when the overlay is `position: fixed`
 * itself) and set `top`/`left` to the rect values directly.
 *
 * Returning `null` from any helper means "the element isn't mounted
 * yet / the id doesn't exist" — effect handlers should defensively
 * treat that as "skip animation" rather than crashing.
 */
export interface EffectContext {
  /** Timeline root rect (the `[data-testid="aicut-timeline"]` element).
   *  `null` while the timeline is unmounted. */
  timelineRect: DOMRect | null;
  /** Preview host rect (the `.aicut-preview-host` element). */
  previewRect: DOMRect | null;
  /** Convert a timeline-absolute Ms into a viewport X pixel. Uses the
   *  timeline's `pxPerSec` + scroll offset. `null` when the timeline
   *  isn't measurable. */
  timelineToScreenX: (timelineMs: Ms) => number | null;
  /** Look up a clip's rect on the timeline in viewport coordinates.
   *  `null` for missing clips or unmounted timeline. */
  clipToScreenRect: (clipId: string) => DOMRect | null;
}

/**
 * An effect handler receives an operation event + geometry helpers
 * and returns JSX to render (or `null` to skip). The returned element
 * gets a stable `key` so React can mount / unmount it across ops.
 *
 * Handlers should be self-contained animations: on mount they run
 * whatever intro / action / outro they want, then call `onComplete`
 * so the overlay layer can garbage-collect the element. Handlers
 * that don't self-terminate stay pinned to the overlay until the
 * next event with the same `op.kind` (which unmounts them
 * automatically — one-at-a-time per kind).
 */
export type EffectHandler = (
  op: OperationEvent,
  ctx: EffectContext,
  onComplete: () => void,
) => ReactElement | null;

/**
 * A map of `op.kind` → handler. Any missing kind is a no-op. Set a
 * kind to `false` explicitly to disable the default without providing
 * a replacement.
 */
export type EffectsMap = Partial<
  Record<OperationEvent["kind"], EffectHandler | false>
>;

