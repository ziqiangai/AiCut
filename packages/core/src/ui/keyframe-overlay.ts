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
  /** Snap-target threshold in CSS px — the same feel as the timeline. */
  private static readonly SNAP_PX = 8;

  constructor(host: HTMLElement, editor: Editor) {
    this.host = host;
    this.editor = editor;

    this.root = document.createElement("div");
    this.root.className = "aicut-keyframe-overlay";
    this.root.setAttribute("data-testid", "aicut-keyframe-overlay");
    this.root.style.display = "none";

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
    const rect = this.editor.getActiveOutputFrameRect()
      ?? this.editor.getActiveFrameRect();
    if (!rect) return;
    const hostRect = this.host.getBoundingClientRect();
    const cx = hostRect.left + rect.x + rect.w / 2;
    const cy = hostRect.top + rect.y + rect.h / 2;
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
    const enabled = this.editor.isKeyframesEnabled();
    if (!enabled) {
      this.root.style.display = "none";
      return;
    }
    // Output rect = the FIXED stage where the video gets clipped.
    // The brand-colored border + body drag-target are anchored here.
    const outRect = this.editor.getActiveOutputFrameRect();
    // Content rect = where the video pixels currently land (after
    // transform). Scale handles attach to its corners so they visually
    // grow / shrink WITH the video.
    const contentRect = this.editor.getActiveFrameRect() ?? outRect;
    if (!outRect) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = "block";
    Object.assign(this.frameBody.style, {
      left: `${outRect.x}px`,
      top: `${outRect.y}px`,
      width: `${outRect.w}px`,
      height: `${outRect.h}px`,
    });
    // Border tint: brand by default; red while the user is actively
    // dragging AND the content doesn't fully cover the output frame
    // (i.e. they've panned far enough to expose letterbox). Helps
    // catch "I dragged my video off-screen by accident."
    const dragging = this.drag != null;
    const fullyCovered = contentRect
      ? contentRect.x <= outRect.x + 0.5 &&
        contentRect.x + contentRect.w >= outRect.x + outRect.w - 0.5 &&
        contentRect.y <= outRect.y + 0.5 &&
        contentRect.y + contentRect.h >= outRect.y + outRect.h - 0.5
      : true;
    this.frameBody.classList.toggle(
      "aicut-keyframe-overlay__frame--warn",
      dragging && !fullyCovered,
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
