/**
 * DOM archaeology for the effects layer. Given a running editor
 * (headless or mounted), walk the document to find the timeline
 * canvas + preview host and derive helpers that translate
 * timeline-time to viewport pixels + look up per-clip rects.
 *
 * All helpers are best-effort: they return `null` when the elements
 * aren't mounted (headless editor before `<Preview>` mounts) or when
 * an id doesn't exist. Effect handlers should treat that as "skip"
 * rather than "crash" — the effects layer is a visual bonus, not a
 * critical path.
 */
import type { EditorApi, Ms } from "@aicut/core";
import type { EffectContext } from "./types.js";

/**
 * Build an `EffectContext` snapshot at the moment of the op.
 * Timeline scale + scroll can change mid-animation, so effect
 * handlers should either capture pixel coords eagerly or re-derive
 * on each frame using the helpers we return (which read the DOM
 * live).
 */
export function buildEffectContext(editor: EditorApi): EffectContext {
  const timelineEl = findTimelineEl();
  const previewHost = findPreviewHost(editor);

  const timelineRect = timelineEl?.getBoundingClientRect() ?? null;
  const previewRect = previewHost?.getBoundingClientRect() ?? null;

  return {
    timelineRect,
    previewRect,
    timelineToScreenX: (timelineMs: Ms): number | null => {
      const el = findTimelineEl();
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const pxPerSec = editor.getScale();
      // Timeline's header column (track labels) sits at the left; the
      // clip area starts after HEADER_WIDTH_PX. Read the CSS variable
      // the timeline sets so we don't hard-code layout.
      const headerPx = readHeaderWidthPx(el, rect);
      const scrollLeft = readTimelineScroll(el);
      return rect.left + headerPx + (timelineMs / 1000) * pxPerSec - scrollLeft;
    },
    clipToScreenRect: (clipId: string): DOMRect | null => {
      const el = findTimelineEl();
      if (!el) return null;
      const project = editor.getProject();
      let found: {
        trackIndex: number;
        start: Ms;
        end: Ms;
      } | null = null;
      project.tracks.forEach((t, ti) => {
        const c = t.clips.find((cc) => cc.id === clipId);
        if (c) {
          found = {
            trackIndex: ti,
            start: c.start,
            end: c.start + (c.out - c.in),
          };
        }
      });
      if (!found) return null;
      const rect = el.getBoundingClientRect();
      const pxPerSec = editor.getScale();
      const headerPx = readHeaderWidthPx(el, rect);
      const scrollLeft = readTimelineScroll(el);
      // Use non-null local aliases so TypeScript stops narrowing to `never`.
      const foundRow: {
        trackIndex: number;
        start: Ms;
        end: Ms;
      } = found;
      const x0 =
        rect.left + headerPx + (foundRow.start / 1000) * pxPerSec - scrollLeft;
      const x1 =
        rect.left + headerPx + (foundRow.end / 1000) * pxPerSec - scrollLeft;
      // Track row = ruler + trackIndex * row height. Read from CSS
      // rather than hard-code so a demo that overrides `--aicut-*`
      // metrics still gets sensible rects.
      const rulerH = readCssPx(el, "--aicut-ruler-height", 24);
      const trackH = readCssPx(el, "--aicut-track-height", 56);
      const y0 = rect.top + rulerH + foundRow.trackIndex * trackH;
      const y1 = y0 + trackH;
      return new DOMRect(x0, y0, x1 - x0, y1 - y0);
    },
  };
}

function findTimelineEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-testid='aicut-timeline']",
  );
}

function findPreviewHost(editor: EditorApi): HTMLElement | null {
  // `EditorApi.previewHost` is the canonical handle — walks with the
  // detached-then-teleported div. Falls back to DOM query if the
  // editor's getter isn't set up yet (shouldn't happen after mount).
  return editor.previewHost ?? document.querySelector(".aicut-preview-host");
}

function readCssPx(
  el: HTMLElement,
  varName: string,
  fallback: number,
): number {
  const raw = getComputedStyle(el).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readHeaderWidthPx(el: HTMLElement, rect: DOMRect): number {
  // Timeline root exposes header width via a CSS var so hosts can
  // theme without recompiling. Fall back to 48 (the ship default) if
  // the variable isn't declared.
  void rect;
  return readCssPx(el, "--aicut-header-width", 48);
}

function readTimelineScroll(el: HTMLElement): number {
  // The scrollable child inside the timeline root — first descendant
  // with a horizontal scrollbar. Cheap heuristic: walk to the canvas
  // and read its parent.
  const canvas = el.querySelector("canvas");
  const scroller =
    canvas?.parentElement ??
    el.querySelector<HTMLElement>("[data-aicut-timeline-scroll]");
  return scroller ? scroller.scrollLeft : 0;
}
