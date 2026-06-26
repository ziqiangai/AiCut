import type { Editor } from "../editor.js";
import { getEffectiveTransform } from "../keyframes/index.js";
import type { Clip } from "../types.js";

/**
 * Eight resize handles: 4 corners (tl/tr/bl/br) + 4 edge midpoints
 * (t/r/b/l). Corners resize both dimensions; edges resize only the
 * perpendicular dimension. Aspect is locked either way (single
 * `scale` value on the clip), so a horizontal edge drag still
 * changes the clip's height proportionally — same posture as
 * shift-resize in any graphics editor.
 */
type HandleKind = "tl" | "tr" | "bl" | "br" | "t" | "r" | "b" | "l";

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
  private handles: Record<HandleKind, HTMLDivElement>;
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
        /** Viewport coords of the anchored point — stays fixed. For
         *  corner drags this is the opposite corner; for edge drags
         *  it's the opposite edge's midpoint. */
        anchorX: number;
        anchorY: number;
        /** Direction from anchor to dragged corner / edge. ±1 per axis. */
        dirX: 1 | -1;
        dirY: 1 | -1;
        /** Per-axis projection mask: corners use both (1, 1); edge
         *  handles only consume the perpendicular axis so a top-edge
         *  drag ignores horizontal cursor motion. */
        axisX: 0 | 1;
        axisY: 0 | 1;
        /** Content dims when scale = 1, in viewport CSS px. */
        baseW: number;
        baseH: number;
        /** Output canvas center in viewport coords — to convert
         *  newCenter into pan offsets. */
        canvasCenterX: number;
        canvasCenterY: number;
        /** Offset between the pointerdown position and the
         *  handle's LOGICAL anchor point (corner / edge midpoint).
         *  Subtracted from every subsequent cursor read so the clip
         *  doesn't jump at the start of a drag when the user clicks
         *  off-center inside the 18×6 / 6×18 handle hit zone. */
        grabOffsetX: number;
        grabOffsetY: number;
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
      t: this.makeHandle("t"),
      r: this.makeHandle("r"),
      b: this.makeHandle("b"),
      l: this.makeHandle("l"),
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

  private onScaleStart(handle: HandleKind, e: PointerEvent): void {
    if (e.button !== 0) return;
    const ctx = this.ensureSelectedClip();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    // CapCut-style anchored resize: the OPPOSITE corner / edge stays
    // pinned. For edge handles the anchor is the parallel edge — the
    // dragged edge moves only along its perpendicular axis but the
    // perpendicular axis still drives a uniform scale, so the
    // dragged edge follows the cursor along its drag axis and the
    // perpendicular axis grows / shrinks in tandem.
    const clipRect = this.editor.getActiveFrameRect();
    const outRect = this.editor.getActiveOutputFrameRect();
    if (!clipRect || !outRect) return;
    const hostRect = this.host.getBoundingClientRect();

    // Edge handles ignore one axis entirely. For top edge, anchor =
    // bottom edge midpoint; for left edge, anchor = right edge
    // midpoint; etc. Corner handles anchor the opposite corner.
    const touchesTop = handle === "tl" || handle === "tr" || handle === "t";
    const touchesBottom = handle === "bl" || handle === "br" || handle === "b";
    const touchesLeft = handle === "tl" || handle === "bl" || handle === "l";
    const touchesRight = handle === "tr" || handle === "br" || handle === "r";
    // Anchor goes to the OPPOSITE side of whatever the handle
    // touches. When the handle doesn't touch a given side (e.g. the
    // "t" edge handle is on top but doesn't touch left/right), the
    // anchor along that axis sits at the clip CENTER — i.e. that
    // axis is shared 50/50 across the resize, mirroring the edge
    // expansion symmetrically.
    let anchorOffsetX: number;
    let dirX: 1 | -1;
    if (touchesLeft) {
      anchorOffsetX = clipRect.w; // anchor at right edge
      dirX = -1;
    } else if (touchesRight) {
      anchorOffsetX = 0; // anchor at left edge
      dirX = 1;
    } else {
      anchorOffsetX = clipRect.w / 2; // anchor at horizontal center
      dirX = 1; // unused for edge handles' projection
    }
    let anchorOffsetY: number;
    let dirY: 1 | -1;
    if (touchesTop) {
      anchorOffsetY = clipRect.h;
      dirY = -1;
    } else if (touchesBottom) {
      anchorOffsetY = 0;
      dirY = 1;
    } else {
      anchorOffsetY = clipRect.h / 2;
      dirY = 1;
    }
    const anchorX = hostRect.left + clipRect.x + anchorOffsetX;
    const anchorY = hostRect.top + clipRect.y + anchorOffsetY;

    // Base content size at scale = 1.
    const baseW = clipRect.w / ctx.transform.scale;
    const baseH = clipRect.h / ctx.transform.scale;
    if (baseW < 1 || baseH < 1) return;

    const canvasCenterX = hostRect.left + outRect.x + outRect.w / 2;
    const canvasCenterY = hostRect.top + outRect.y + outRect.h / 2;

    const target = this.handles[handle];
    target.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;
    const axisX: 0 | 1 = touchesLeft || touchesRight ? 1 : 0;
    const axisY: 0 | 1 = touchesTop || touchesBottom ? 1 : 0;
    // Where the handle's LOGICAL anchor point sits in viewport
    // coords — the actual edge / corner position, not the click
    // location. Used to compute the grab offset below.
    const handleLogicalX = touchesLeft
      ? hostRect.left + clipRect.x
      : touchesRight
        ? hostRect.left + clipRect.x + clipRect.w
        : hostRect.left + clipRect.x + clipRect.w / 2;
    const handleLogicalY = touchesTop
      ? hostRect.top + clipRect.y
      : touchesBottom
        ? hostRect.top + clipRect.y + clipRect.h
        : hostRect.top + clipRect.y + clipRect.h / 2;
    const grabOffsetX = e.clientX - handleLogicalX;
    const grabOffsetY = e.clientY - handleLogicalY;
    this.drag = {
      kind: "scale",
      clipId: ctx.clip.id,
      anchorX,
      anchorY,
      dirX,
      dirY,
      axisX,
      axisY,
      baseW,
      baseH,
      canvasCenterX,
      canvasCenterY,
      grabOffsetX,
      grabOffsetY,
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
      // Corner resize with the OPPOSITE corner anchored. Aspect is
      // locked (single `scale` value); we project the cursor's
      // displacement from the anchor onto the natural diagonal
      // direction (baseW, baseH). This gives a smooth, jitter-free
      // scale that doesn't flicker between axes the way max(sx, sy)
      // does when the cursor wanders slightly off-diagonal — the
      // opposite corner stays pinned to within float-rounding noise
      // instead of bouncing by a pixel each frame.
      // Subtract the grab-offset so the math always treats the
      // cursor as if it had clicked exactly on the handle's logical
      // anchor point. Eliminates the 1-2px "jump" the user sees the
      // moment they press on a wide edge handle slightly off-center.
      const cursorX = e.clientX - this.drag.grabOffsetX;
      const cursorY = e.clientY - this.drag.grabOffsetY;
      const offsetX = (cursorX - this.drag.anchorX) * this.drag.dirX;
      const offsetY = (cursorY - this.drag.anchorY) * this.drag.dirY;
      // Mask out axes the handle isn't supposed to consume (edge
      // handles only listen to the perpendicular axis). For corners
      // axisX = axisY = 1, so this is a no-op.
      const projX = offsetX * this.drag.axisX;
      const projY = offsetY * this.drag.axisY;
      // Effective base length along the active axes. For an edge
      // handle this collapses to a single axis; for a corner it's
      // the natural diagonal. Either way the scale comes out as the
      // ratio along that axis, which is exactly the
      // opposite-anchor-stays-pinned semantics.
      const activeBaseW = this.drag.baseW * this.drag.axisX;
      const activeBaseH = this.drag.baseH * this.drag.axisY;
      const L = Math.hypot(activeBaseW, activeBaseH) || 1;
      const proj = (projX * activeBaseW + projY * activeBaseH) / L;
      const next = Math.max(0.05, Math.min(16, proj / L));
      const newW = this.drag.baseW * next;
      const newH = this.drag.baseH * next;
      // For edge handles the perpendicular axis is the anchor's own
      // axis (axisX = 0 means anchor sits at the clip's horizontal
      // center; axisY = 0 means it sits at the vertical center).
      // Multiplying by axisX/axisY gates the half-dimension offset
      // so an edge drag doesn't shove the clip sideways by half its
      // width — `anchorX + dirX * (newW/2)` would push horizontally
      // for a top-edge drag, which is exactly the "jumps right by
      // the full width" symptom we were seeing.
      const newCenterX =
        this.drag.anchorX + this.drag.axisX * this.drag.dirX * (newW / 2);
      const newCenterY =
        this.drag.anchorY + this.drag.axisY * this.drag.dirY * (newH / 2);
      // Don't round pan offsets here — quantising them to integers
      // would let the anchored corner jitter as scale grows
      // continuously. Storage precision is fine for floats and the
      // editor commits one history entry per drag anyway.
      const newPanX = newCenterX - this.drag.canvasCenterX;
      const newPanY = newCenterY - this.drag.canvasCenterY;
      this.editor.setValueAtPlayhead(this.drag.clipId, "scale", next);
      this.editor.setValueAtPlayhead(this.drag.clipId, "panX", newPanX);
      this.editor.setValueAtPlayhead(this.drag.clipId, "panY", newPanY);
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
    const r = contentRect ?? outRect;
    const fbLeft = r.x;
    const fbTop = r.y;
    const fbRight = r.x + r.w;
    const fbBottom = r.y + r.h;
    // Handle half-dim (px): corners are 12×12 squares, top/bottom
    // edges 18×6, left/right edges 6×18 — keep in sync with the CSS.
    const place = (
      el: HTMLDivElement,
      cx: number,
      cy: number,
      halfW: number,
      halfH: number,
    ): void => {
      el.style.left = `${cx - halfW}px`;
      el.style.top = `${cy - halfH}px`;
    };
    place(this.handles.tl, fbLeft, fbTop, 6, 6);
    place(this.handles.tr, fbRight, fbTop, 6, 6);
    place(this.handles.bl, fbLeft, fbBottom, 6, 6);
    place(this.handles.br, fbRight, fbBottom, 6, 6);
    const midX = (fbLeft + fbRight) / 2;
    const midY = (fbTop + fbBottom) / 2;
    place(this.handles.t, midX, fbTop, 9, 3);
    place(this.handles.r, fbRight, midY, 3, 9);
    place(this.handles.b, midX, fbBottom, 9, 3);
    place(this.handles.l, fbLeft, midY, 3, 9);
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

  private makeHandle(name: HandleKind): HTMLDivElement {
    const el = document.createElement("div");
    const isEdge = name.length === 1;
    el.className =
      `aicut-keyframe-overlay__handle aicut-keyframe-overlay__handle--${name}` +
      (isEdge ? " aicut-keyframe-overlay__handle--edge" : "");
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
