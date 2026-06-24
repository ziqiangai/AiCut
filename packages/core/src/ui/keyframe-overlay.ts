import type { Editor } from "../editor.js";
import {
  getEffectiveTransform,
  type EffectiveTransform,
} from "../keyframes/index.js";
import type { Clip } from "../types.js";

/**
 * Direct-manipulation overlay on top of the preview area. When
 * keyframes mode is on AND the active engine exposes a frame rect,
 * paints a 1px border around the frame + four corner handles. Pointer
 * gestures:
 *
 *   - Drag inside the frame body      → translate (clip X / Y)
 *   - Drag a corner handle             → uniform scale around frame center
 *
 * When no keyframe is selected the gesture auto-creates one at the
 * playhead (CapCut-style). With a keyframe selected, the gesture
 * edits that keyframe's values.
 *
 * The overlay element itself has `pointer-events: none` so non-
 * keyframe clicks pass through to whatever lives below. The frame
 * border + corner handles have `pointer-events: auto` so users can
 * grab them. When keyframe mode is off the whole thing is hidden via
 * `display: none`.
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
        keyframeId: string;
        pointerStartX: number;
        pointerStartY: number;
        startX: number;
        startY: number;
      }
    | {
        kind: "scale";
        clipId: string;
        keyframeId: string;
        centerX: number;
        centerY: number;
        startDistance: number;
        startScale: number;
      }
    | null = null;
  private capturedPointerId: number | null = null;

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
    // ctrlKey: true. Browser usually scales the whole page on this —
    // we preventDefault and reinterpret it as a scale change on the
    // active keyframe (auto-adding one if needed).
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
    const ctx = this.ensureDragContext();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    this.frameBody.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;
    this.drag = {
      kind: "translate",
      clipId: ctx.clipId,
      keyframeId: ctx.keyframeId,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      startX: ctx.kfValues.x,
      startY: ctx.kfValues.y,
    };
    this.frameBody.addEventListener("pointermove", this.onPointerMove);
    this.frameBody.addEventListener("pointerup", this.onPointerUp);
    this.frameBody.addEventListener("pointercancel", this.onPointerUp);
  }

  // ---- pinch-to-scale --------------------------------------------------

  private onPinchScale(e: WheelEvent): void {
    // Trackpad pinch → wheel + ctrlKey (synthetic). Plain wheel still
    // scrolls / zooms the page normally.
    if (!e.ctrlKey) return;
    const ctx = this.ensureDragContext();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    // -e.deltaY because most pinch gestures send negative deltaY for
    // outward (zoom-in). Clamp the per-tick multiplier so a fast
    // pinch doesn't jump several stops.
    const step = Math.max(-50, Math.min(50, -e.deltaY));
    const factor = Math.exp(step * 0.01);
    const next = Math.max(
      0.05,
      Math.min(16, ctx.kfValues.scale * factor),
    );
    this.editor.setKeyframeValues(ctx.clipId, ctx.keyframeId, {
      scale: Math.round(next * 100) / 100,
    });
  }

  // ---- corner-handle drag (scale) --------------------------------------

  private onScaleStart(corner: "tl" | "tr" | "bl" | "br", e: PointerEvent): void {
    if (e.button !== 0) return;
    const ctx = this.ensureDragContext();
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    // Scale around the OUTPUT frame center, not the content center
    // — that way dragging a handle outward grows the content
    // symmetrically around the stage even if it's already translated.
    const rect = this.editor.getActiveOutputFrameRect()
      ?? this.editor.getActiveFrameRect();
    if (!rect) return;
    const hostRect = this.host.getBoundingClientRect();
    const cx = hostRect.left + rect.x + rect.w / 2;
    const cy = hostRect.top + rect.y + rect.h / 2;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy);
    if (startDist < 1) return; // pointer right on center — meaningless
    const target = this.handles[corner];
    target.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;
    this.drag = {
      kind: "scale",
      clipId: ctx.clipId,
      keyframeId: ctx.keyframeId,
      centerX: cx,
      centerY: cy,
      startDistance: startDist,
      startScale: ctx.kfValues.scale,
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
      this.editor.setKeyframeValues(this.drag.clipId, this.drag.keyframeId, {
        x: Math.round(this.drag.startX + dx),
        y: Math.round(this.drag.startY + dy),
      });
    } else {
      const dist = Math.hypot(
        e.clientX - this.drag.centerX,
        e.clientY - this.drag.centerY,
      );
      // Clamp to [0.05, 16] — match the demo's "reasonable scale" band.
      // Round to 2 decimals so the panel's display stays tidy.
      const ratio = dist / this.drag.startDistance;
      const next = Math.max(
        0.05,
        Math.min(16, this.drag.startScale * ratio),
      );
      this.editor.setKeyframeValues(this.drag.clipId, this.drag.keyframeId, {
        scale: Math.round(next * 100) / 100,
      });
    }
  };

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
    // The dashed border + the body drag-target are anchored here so
    // they don't move with the keyframe transform — they represent
    // the export bounds, not the content position.
    const outRect = this.editor.getActiveOutputFrameRect();
    // Content rect = where the video pixels currently land (after
    // transform). Scale handles attach to its corners so they
    // visually grow / shrink WITH the video as you drag them.
    const contentRect =
      this.editor.getActiveFrameRect() ?? outRect;
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
    const halfHandle = 6; // visible 12×12 px
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
   * Make sure there's a keyframe to edit. If none is selected, add
   * one at the playhead and select it. Returns the clip + keyframe
   * ids + the values to use as the drag's "start" baseline.
   */
  private ensureDragContext(): {
    clipId: string;
    keyframeId: string;
    kfValues: EffectiveTransform;
  } | null {
    const selectedClipId = this.editor.getSelection();
    if (!selectedClipId) return null;
    const project = this.editor.getProject();
    let targetClip: Clip | null = null;
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === selectedClipId);
      if (c) {
        targetClip = c;
        break;
      }
    }
    if (!targetClip) return null;
    const playheadLocal = this.editor.getTime() - targetClip.start;
    if (playheadLocal < 0 || playheadLocal > targetClip.out - targetClip.in) {
      return null;
    }

    const existing = this.editor.getSelectedKeyframe();
    if (existing && existing.clipId === selectedClipId) {
      const kf = targetClip.keyframes?.find((k) => k.id === existing.keyframeId);
      if (kf) {
        return {
          clipId: existing.clipId,
          keyframeId: existing.keyframeId,
          kfValues: { x: kf.x ?? 0, y: kf.y ?? 0, scale: kf.scale ?? 1 },
        };
      }
    }

    // Auto-add at playhead with current interpolated values so the
    // drag doesn't visually jump.
    const baseline = getEffectiveTransform(targetClip, playheadLocal);
    const newId = this.editor.addKeyframe(targetClip.id, {
      time: Math.round(playheadLocal),
      x: baseline.x,
      y: baseline.y,
      scale: baseline.scale,
    });
    if (!newId) return null;
    this.editor.setSelectedKeyframe({
      clipId: targetClip.id,
      keyframeId: newId,
    });
    return {
      clipId: targetClip.id,
      keyframeId: newId,
      kfValues: baseline,
    };
  }
}
