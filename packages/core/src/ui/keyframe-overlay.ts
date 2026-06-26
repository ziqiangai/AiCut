import type { Editor } from "../editor.js";
import { getEffectiveTransform } from "../keyframes/index.js";
import type { Clip } from "../types.js";

/**
 * Direct-manipulation overlay on top of the preview area. When
 * keyframes mode is on AND the active engine exposes a frame rect,
 * paints a 1px dashed border around the OUTPUT frame (fixed) + four
 * corner handles attached to the CONTENT (moves with the transform).
 *
 * Pointer gestures all act on the SELECTED clip's three transform
 * properties (`panX`, `panY`, `scale`), routed through
 * `Editor.setValueAtPlayhead` — so a gesture either updates the
 * clip's static base (no animation track yet) or upserts a keyframe
 * at the playhead (when the prop is already animated).
 *
 *   - Drag inside the frame body            → setValueAtPlayhead(panX, panY)
 *   - Drag a corner handle (or pinch wheel) → setValueAtPlayhead(scale)
 *
 * Overlay element has `pointer-events: none` so non-keyframe clicks
 * pass through to whatever lives below; only the body + handles
 * capture clicks. Hidden via display: none when keyframe mode is off.
 */
export class KeyframeOverlay {
  private editor: Editor;
  private host: HTMLElement;
  readonly root: HTMLDivElement;
  /**
   * Static canvas-extent guide pinned to the OUTPUT rect. Shows the
   * editable area regardless of selection — same affordance the
   * dashed border had before PiP. Visibility gated on
   * `previewFrame.enabled`. Always purely visual: pointer-events
   * pass through so clicks land on whatever lives below.
   */
  private canvasGuide: HTMLDivElement;
  /** Selection-following frame pinned to the SELECTED clip's content
   *  rect. Doubles as the drag-to-pan hit target when keyframes mode
   *  is on; corner handles attach to its bounds. */
  private frameBody: HTMLDivElement;
  private handles: Record<"tl" | "tr" | "bl" | "br", HTMLDivElement>;
  private rafHandle: number | null = null;
  private destroyed = false;
  private drag:
    | {
        kind: "translate";
        clipId: string;
        pointerStartX: number;
        pointerStartY: number;
        startPanX: number;
        startPanY: number;
      }
    | {
        kind: "scale";
        clipId: string;
        centerX: number;
        centerY: number;
        startDistance: number;
        startScale: number;
      }
    | null = null;
  private capturedPointerId: number | null = null;
  /** Timer handle for the wheel-burst → interaction commit. */
  private wheelInteractionTimer: number | null = null;
  /** Snap-target threshold in CSS px — the same feel as the timeline. */
  private static readonly SNAP_PX = 8;

  constructor(host: HTMLElement, editor: Editor) {
    this.host = host;
    this.editor = editor;

    this.root = document.createElement("div");
    this.root.className = "aicut-keyframe-overlay";
    this.root.setAttribute("data-testid", "aicut-keyframe-overlay");
    this.root.style.display = "none";

    this.canvasGuide = document.createElement("div");
    this.canvasGuide.className = "aicut-keyframe-overlay__canvas-guide";
    this.canvasGuide.setAttribute("data-testid", "aicut-keyframe-canvas-guide");
    this.root.appendChild(this.canvasGuide);

    this.frameBody = document.createElement("div");
    this.frameBody.className = "aicut-keyframe-overlay__frame";
    this.frameBody.setAttribute("data-testid", "aicut-keyframe-frame");
    this.frameBody.addEventListener("pointerdown", (e) => this.onTransStart(e));
    // Pinch-to-zoom: macOS trackpads fire `wheel` events with
    // ctrlKey: true. We preventDefault the page zoom and reinterpret
    // as a scale change on the selected clip.
    this.frameBody.addEventListener(
      "wheel",
      (e) => this.onPinchScale(e),
      { passive: false },
    );
    this.root.appendChild(this.frameBody);

    this.handles = {
      tl: this.makeHandle("tl"),
      tr: this.makeHandle("tr"),
      bl: this.makeHandle("bl"),
      br: this.makeHandle("br"),
    };

    host.appendChild(this.root);
    this.startTick();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
    if (this.wheelInteractionTimer != null) {
      clearTimeout(this.wheelInteractionTimer);
      this.wheelInteractionTimer = null;
      // The editor outlives this overlay on a normal teardown, but
      // if a burst was in flight we still owe it an endInteraction
      // to balance the begin (otherwise pushHistory stays muted).
      this.editor.endInteraction();
    }
    this.root.remove();
  }

  // ---- frame body drag (translate) -------------------------------------

  private onTransStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    const ctx = this.ensureSelectedClip();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    this.frameBody.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;
    this.drag = {
      kind: "translate",
      clipId: ctx.clip.id,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      startPanX: ctx.transform.panX,
      startPanY: ctx.transform.panY,
    };
    // Open a drag session so the 30-100 pointermove mutations
    // coalesce into ONE history entry — committed on pointer-up.
    this.editor.beginInteraction();
    this.frameBody.addEventListener("pointermove", this.onPointerMove);
    this.frameBody.addEventListener("pointerup", this.onPointerUp);
    this.frameBody.addEventListener("pointercancel", this.onPointerUp);
  }

  // ---- pinch-to-scale --------------------------------------------------

  private onPinchScale(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    const ctx = this.ensureSelectedClip();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    const step = Math.max(-50, Math.min(50, -e.deltaY));
    const factor = Math.exp(step * 0.01);
    const next = Math.max(
      0.05,
      Math.min(16, ctx.transform.scale * factor),
    );
    // Wheel events have no down / up boundary, so use a debounce-
    // flush instead: first event opens an interaction, every
    // subsequent event within 200ms resets the timer, and 200ms
    // after the last wheel tick we commit. The result is one
    // history entry per "burst" of scrolling — matches the user's
    // mental model of "I scrolled, then I stopped".
    if (this.wheelInteractionTimer == null) {
      this.editor.beginInteraction();
    } else {
      clearTimeout(this.wheelInteractionTimer);
    }
    this.wheelInteractionTimer = window.setTimeout(() => {
      this.wheelInteractionTimer = null;
      this.editor.endInteraction();
    }, 200);
    this.editor.setValueAtPlayhead(
      ctx.clip.id,
      "scale",
      Math.round(next * 100) / 100,
    );
  }

  // ---- corner-handle drag (scale) --------------------------------------

  private onScaleStart(corner: "tl" | "tr" | "bl" | "br", e: PointerEvent): void {
    if (e.button !== 0) return;
    const ctx = this.ensureSelectedClip();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    // Anchor the scale-distance reference to the SELECTED clip's
    // own center, NOT the output canvas center. For a PiP overlay
    // sitting away from canvas center, canvas-distance scaling
    // makes the corner feel mushy near the canvas center and
    // hyper-responsive near canvas edges; clip-distance scaling
    // gives the same uniform-from-center feel everywhere.
    const clipRect = this.editor.getActiveFrameRect()
      ?? this.editor.getActiveOutputFrameRect();
    if (!clipRect) return;
    const hostRect = this.host.getBoundingClientRect();
    const cx = hostRect.left + clipRect.x + clipRect.w / 2;
    const cy = hostRect.top + clipRect.y + clipRect.h / 2;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy);
    if (startDist < 1) return;
    const target = this.handles[corner];
    target.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;
    this.drag = {
      kind: "scale",
      clipId: ctx.clip.id,
      centerX: cx,
      centerY: cy,
      startDistance: startDist,
      startScale: ctx.transform.scale,
    };
    this.editor.beginInteraction();
    target.addEventListener("pointermove", this.onPointerMove);
    target.addEventListener("pointerup", this.onPointerUp);
    target.addEventListener("pointercancel", this.onPointerUp);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (this.drag.kind === "translate") {
      const dx = e.clientX - this.drag.pointerStartX;
      const dy = e.clientY - this.drag.pointerStartY;
      const rawPanX = this.drag.startPanX + dx;
      const rawPanY = this.drag.startPanY + dy;
      // Snap to: centered (0), and (when content > output) left/right
      // / top/bottom edge alignment between content and output.
      const snapped = this.applySnap(this.drag.clipId, rawPanX, rawPanY);
      this.editor.setValueAtPlayhead(
        this.drag.clipId,
        "panX",
        Math.round(snapped.panX),
      );
      this.editor.setValueAtPlayhead(
        this.drag.clipId,
        "panY",
        Math.round(snapped.panY),
      );
    } else {
      const dist = Math.hypot(
        e.clientX - this.drag.centerX,
        e.clientY - this.drag.centerY,
      );
      const ratio = dist / this.drag.startDistance;
      const next = Math.max(
        0.05,
        Math.min(16, this.drag.startScale * ratio),
      );
      this.editor.setValueAtPlayhead(
        this.drag.clipId,
        "scale",
        Math.round(next * 100) / 100,
      );
    }
  };

  /**
   * Snap raw pan to: centered (panX/Y = 0) and the four edge-alignment
   * stops (content's L/R/T/B edge flush with the output's matching
   * edge). When content is smaller than output, the edge stops collapse
   * to the same point as 0 — harmless dup. Threshold = 8 CSS px.
   */
  private applySnap(
    clipId: string,
    rawPanX: number,
    rawPanY: number,
  ): { panX: number; panY: number } {
    const out = this.editor.getActiveOutputFrameRect();
    if (!out) return { panX: rawPanX, panY: rawPanY };
    const clip = this.findClip(clipId);
    if (!clip) return { panX: rawPanX, panY: rawPanY };
    // Content size at current scale (which may differ from base — the
    // user can be mid-scaling alongside the drag conceptually).
    const t = (() => {
      try {
        const transformer = this.editor.getActiveFrameRect();
        if (!transformer) return null;
        return { w: transformer.w, h: transformer.h };
      } catch {
        return null;
      }
    })();
    const contentW = t?.w ?? out.w;
    const contentH = t?.h ?? out.h;
    // Edge stops: content edge aligned with output edge.
    //   contentRight = panX + contentW/2 + outCenter.x — but here we
    //   work in "panX from centered=0", so the edge-alignment panX is
    //   ±(contentW - outW)/2 (same for Y).
    const edgeX = (contentW - out.w) / 2;
    const edgeY = (contentH - out.h) / 2;
    const xTargets = [0, edgeX, -edgeX];
    const yTargets = [0, edgeY, -edgeY];
    const px = nearestSnap(rawPanX, xTargets, KeyframeOverlay.SNAP_PX);
    const py = nearestSnap(rawPanY, yTargets, KeyframeOverlay.SNAP_PX);
    return { panX: px, panY: py };
  }

  private findClip(clipId: string): Clip | null {
    const project = this.editor.getProject();
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === clipId);
      if (c) return c;
    }
    return null;
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    const targetEl = e.currentTarget as HTMLElement | null;
    if (targetEl && this.capturedPointerId === e.pointerId) {
      try {
        targetEl.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
    targetEl?.removeEventListener("pointermove", this.onPointerMove);
    targetEl?.removeEventListener("pointerup", this.onPointerUp);
    targetEl?.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = null;
    this.capturedPointerId = null;
    // Commit the drag session — single history entry for the whole
    // gesture, dropped entirely if the project ended up unchanged
    // (e.g. mousedown without movement).
    this.editor.endInteraction();
  };

  // ---- per-frame layout ------------------------------------------------

  private startTick(): void {
    const tick = () => {
      if (this.destroyed) return;
      this.layout();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private layout(): void {
    const frameVisible = this.editor.isPreviewFrameEnabled();
    const interactive = this.editor.isKeyframesEnabled();
    if (!frameVisible && !interactive) {
      this.root.style.display = "none";
      return;
    }
    // Output rect = the FIXED stage where the video gets clipped.
    // The brand-colored border + body drag-target are anchored here.
    // Without a loaded clip the engine has nothing to report; fall
    // back to an aspect-fit rect inside the preview host so the user
    // sees "this is where the video will land" before uploading
    // anything. Driven by `Project.aspect` so switching ratios in
    // the built-in picker is visible even in the empty state.
    const outRect =
      this.editor.getActiveOutputFrameRect() ??
      (frameVisible ? this.computeEmptyStateRect() : null);
    // Content rect = where the video pixels currently land (after
    // transform). Scale handles attach to its corners so they visually
    // grow / shrink WITH the video.
    const contentRect = this.editor.getActiveFrameRect() ?? outRect;
    if (!outRect) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = "block";
    // Interactive bits (frame-body drag-to-pan + corner scale handles)
    // light up only with keyframes mode. Without it the frame is a
    // pure outline — pointer events pass straight through.
    this.root.classList.toggle(
      "aicut-keyframe-overlay--interactive",
      interactive,
    );
    // Canvas guide — dashed outline of the output canvas. Same
    // affordance the dashed border had before PiP existed. Gated on
    // `previewFrame.enabled` regardless of selection.
    this.canvasGuide.style.display = frameVisible ? "block" : "none";
    Object.assign(this.canvasGuide.style, {
      left: `${outRect.x}px`,
      top: `${outRect.y}px`,
      width: `${outRect.w}px`,
      height: `${outRect.h}px`,
    });

    // Selection-following frame body — wraps the SELECTED clip's
    // content rect so a PiP overlay (content < canvas) gets a clear
    // outline + handles around the actual clip, while a normal full-
    // frame clip behaves identically to before (content == canvas).
    // Visibility ties to whether there's anything to select: with no
    // active clip the body collapses out of the way and only the
    // canvas guide remains.
    const hasSelection = this.editor.getSelection() != null;
    const frameRect = contentRect ?? outRect;
    this.frameBody.style.display = hasSelection ? "block" : "none";
    Object.assign(this.frameBody.style, {
      left: `${frameRect.x}px`,
      top: `${frameRect.y}px`,
      width: `${frameRect.w}px`,
      height: `${frameRect.h}px`,
    });
    // Border warn state: only relevant when the SELECTED clip is
    // intended to fill the canvas (scale ≈ 1). For a deliberately-
    // shrunk PiP overlay, "content doesn't cover canvas" is the
    // entire point — firing the red warn ring would be noise. Heuristic:
    // suppress warn whenever the content rect is meaningfully smaller
    // than the canvas (>5% gap on either axis). When it's near full
    // size we still flag panning that exposes letterbox.
    const intentionallySmall =
      contentRect != null &&
      (contentRect.w < outRect.w * 0.95 ||
        contentRect.h < outRect.h * 0.95);
    const fullyCovered =
      intentionallySmall ||
      (contentRect
        ? contentRect.x <= outRect.x + 0.5 &&
          contentRect.x + contentRect.w >= outRect.x + outRect.w - 0.5 &&
          contentRect.y <= outRect.y + 0.5 &&
          contentRect.y + contentRect.h >= outRect.y + outRect.h - 0.5
        : true);
    this.frameBody.classList.toggle(
      "aicut-keyframe-overlay__frame--warn",
      !fullyCovered,
    );
    const halfHandle = 6;
    const r = contentRect ?? outRect;
    const fbLeft = r.x;
    const fbTop = r.y;
    const fbRight = r.x + r.w;
    const fbBottom = r.y + r.h;
    const place = (
      el: HTMLDivElement,
      cx: number,
      cy: number,
    ): void => {
      el.style.left = `${cx - halfHandle}px`;
      el.style.top = `${cy - halfHandle}px`;
    };
    place(this.handles.tl, fbLeft, fbTop);
    place(this.handles.tr, fbRight, fbTop);
    place(this.handles.bl, fbLeft, fbBottom);
    place(this.handles.br, fbRight, fbBottom);
  }

  // ---- helpers ---------------------------------------------------------

  /**
   * Fallback rect used in the "no clip loaded yet" empty state — so
   * the dashed outline visualises the chosen aspect ratio even before
   * the user uploads anything. Aspect-fit math inside the preview
   * host with a 16px breathing margin; defaults to 16:9 when no
   * `Project.aspect` is set.
   */
  private computeEmptyStateRect(): { x: number; y: number; w: number; h: number } | null {
    const aspect = this.editor.getAspect();
    const [aw, ah] = parseAspect(aspect) ?? [16, 9];
    const containerW = this.host.clientWidth;
    const containerH = this.host.clientHeight;
    if (containerW <= 0 || containerH <= 0) return null;
    const margin = 16;
    const innerW = Math.max(0, containerW - margin * 2);
    const innerH = Math.max(0, containerH - margin * 2);
    if (innerW <= 0 || innerH <= 0) return null;
    const targetAr = aw / ah;
    const containerAr = innerW / innerH;
    let w: number;
    let h: number;
    if (containerAr > targetAr) {
      h = innerH;
      w = h * targetAr;
    } else {
      w = innerW;
      h = w / targetAr;
    }
    return {
      x: (containerW - w) / 2,
      y: (containerH - h) / 2,
      w,
      h,
    };
  }

  private makeHandle(name: "tl" | "tr" | "bl" | "br"): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `aicut-keyframe-overlay__handle aicut-keyframe-overlay__handle--${name}`;
    el.setAttribute("data-testid", `aicut-keyframe-handle-${name}`);
    el.addEventListener("pointerdown", (e) => this.onScaleStart(name, e));
    this.root.appendChild(el);
    return el;
  }

  /**
   * Resolve the currently selected clip + its current effective
   * transform (so drag baselines are correct). Returns null when no
   * clip is selected or the playhead isn't over it.
   */
  private ensureSelectedClip():
    | {
        clip: Clip;
        transform: { panX: number; panY: number; scale: number };
      }
    | null {
    const selectedClipId = this.editor.getSelection();
    if (!selectedClipId) return null;
    const project = this.editor.getProject();
    let clip: Clip | null = null;
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === selectedClipId);
      if (c) {
        clip = c;
        break;
      }
    }
    if (!clip) return null;
    const playheadLocal = this.editor.getTime() - clip.start;
    if (playheadLocal < 0 || playheadLocal > clip.out - clip.in) {
      return null;
    }
    const transform = getEffectiveTransform(clip, playheadLocal);
    return { clip, transform };
  }
}

/** Pick the snap target within `threshold`, else return the raw value. */
function nearestSnap(
  raw: number,
  targets: number[],
  threshold: number,
): number {
  let best = raw;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(raw - t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/**
 * Parse an aspect-ratio string like "16:9" into a [w, h] tuple.
 * Returns null for malformed input so callers can apply a default.
 */
function parseAspect(value: string | null): [number, number] | null {
  if (!value) return null;
  const m = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return [w, h];
}
