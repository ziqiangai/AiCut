import { type Locale, mergeLocale } from "../i18n.js";
import { applyTheme } from "../theme.js";
import type { Theme } from "../types.js";
import {
  bigFrameStepMs,
  frameStepMs,
  normalizeProject,
  projectDuration,
} from "../model.js";
import type { Clip, Ms, Project } from "../types.js";
import { ThumbnailRibbon } from "../ui/thumbnails.js";
import {
  drawAll,
  type DrawState,
  type DrawStyle,
} from "./draw.js";
import { hitTest, type HitTarget } from "./hit.js";
import {
  HEADER_WIDTH,
  RULER_HEIGHT,
  SCROLLBAR_INSET,
  SCROLLBAR_MIN_THUMB,
  SCROLLBAR_THICKNESS,
  TIMELINE_PAD_RIGHT,
  TRACK_HEIGHT,
  clampScale,
  contentHeight,
  contentLeftX,
  contentWidth,
  findClip,
  snapTargets,
  trackIndexAt,
  wouldOverlap,
  xToMs,
} from "./layout.js";

/**
 * Public options for the standalone `Timeline` component. The class
 * is framework-agnostic — `@aicut/react` and `@aicut/vue` wrap it,
 * and the built-in `Editor` composes one internally for its timeline
 * panel. Reuse the same instance for a "frame-picker" use case by
 * loading a project with a single video clip and `readOnly: true`.
 */
export interface TimelineOptions {
  /** Host element. Will be wiped on init. */
  container: HTMLElement;
  project: Project;
  /** Pixels per second. Defaults to 80; auto-fits on mount when possible. */
  pxPerSec?: number;
  /** Initial playhead position. */
  time?: Ms;
  /** Initially selected clip. */
  selectedClipId?: string | null;
  /** Show the track-name header column (left). Default true. */
  showHeader?: boolean;
  /**
   * Minimum pixel gap between ruler major ticks. Drives the auto
   * picker via `niceTickSeconds(minPx / pxPerSec)` — smaller values
   * pack more labels per zoom level, larger values space them out.
   * Default 80; sensible range ~40–160.
   */
  rulerMinTickPx?: number;
  /** Disable interactions — useful for read-only preview / frame picker. */
  readOnly?: boolean;
  /** Snap to clip edges + playhead when dragging. Default true. */
  snap?: boolean;
  /** Compute and apply fit-to-window on first project change. Default true. */
  autoFit?: boolean;
  /** UI string overrides (English defaults). Use `localeZh` for Chinese. */
  locale?: Partial<Locale>;
  /**
   * Theme tokens — applied as `--aicut-*` CSS variables on the host
   * container. Same shape as the video Editor's `theme` option, so a
   * host can pass the SAME object to both an Editor and a standalone
   * Timeline. Reactive via `setTheme(...)`. */
  theme?: Theme;
  /**
   * Render an empty 36px toolbar strip at the top of the host element
   * with `toolbarLeft` / `toolbarRight` flex slots. The library paints
   * NOTHING into either slot — hosts append their own controls (an
   * export button, a size/aspect dropdown, etc.). Default false; the
   * canvas takes the full host height when the toolbar is off, so
   * adopting the slot later is a non-breaking opt-in.
   */
  toolbar?: boolean;

  onSeek?: (timeMs: Ms) => void;
  onSelectClip?: (clipId: string | null) => void;
  onScaleChange?: (pxPerSec: number) => void;
  onDeleteTrack?: (trackId: string) => void;
  onMoveClip?: (
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ) => void;
  onResizeClip?: (
    clipId: string,
    edits: Partial<Pick<Clip, "in" | "out" | "start">>,
  ) => void;
  onChange?: (project: Project) => void;

  /**
   * Hosts wire these to forward keyframe edits to the Editor. The
   * Timeline only paints + hit-tests; mutation goes through these
   * callbacks so the Editor can push history + emit events.
   */
  onSelectKeyframe?: (
    target: { clipId: string; keyframeId: string } | null,
  ) => void;
  onMoveKeyframe?: (
    clipId: string,
    keyframeId: string,
    timeMs: Ms,
  ) => void;

  /** Host-driven state mirror — Editor passes these on every render
   *  via `Timeline.setKeyframeState`. */
  keyframesEnabled?: boolean;
  selectedKeyframe?: { clipId: string; keyframeId: string } | null;

  /**
   * Lets the host predict where a drop will actually land — used to
   * keep the drag-ghost visual honest. The Editor wires this to its
   * smart routing (intended → source → other → new track), so the
   * ghost shows the real outcome rather than just the user's hover.
   *
   * Return `{ trackIndex }` for an existing track, or
   * `{ wouldCreateNew: true }` for the auto-split case.
   */
  resolveDrop?: (
    clipId: string,
    intent: { start: Ms; intendedTrackIndex: number },
  ) => { trackIndex: number; wouldCreateNew: boolean };
}

interface DragMove {
  kind: "move";
  clipId: string;
  trackIndex: number;
  pointerStartX: number;
  pointerStartY: number;
  originalStart: Ms;
}
interface DragTrim {
  kind: "trim-left" | "trim-right";
  clipId: string;
  trackIndex: number;
  pointerStartX: number;
  originalStart: Ms;
  originalIn: Ms;
  originalOut: Ms;
}
interface DragScrub {
  kind: "scrub";
}
interface DragKeyframe {
  kind: "keyframe-drag";
  clipId: string;
  keyframeId: string;
  trackIndex: number;
  pointerStartX: number;
  originalTimeMs: Ms;
  /** Latest snapped time during the drag — committed once on pointer-up
   *  so the history stack records one entry per drag, not one per
   *  rAF tick. Draw uses this to render the ghost position. */
  ghostTimeMs: Ms;
}
type DragCtx = DragMove | DragTrim | DragScrub | DragKeyframe;

const SNAP_PX = 8;
const DEFAULT_SCALE = 80;
const WHEEL_ZOOM_RATE = 0.012;
const SCROLLBAR_FADE_HOLD_MS = 800;
const SCROLLBAR_FADE_OUT_MS = 400;

/**
 * Canvas-rendered, framework-free timeline. Owns ruler, multi-track
 * layout, headers, frame-thumbnails, playhead, snap, and all pointer
 * gestures. No DOM children for clips/ticks/etc — every pixel is
 * painted via 2D canvas, so even hundreds of clips render in <2ms.
 */
export class Timeline {
  private root: HTMLElement;
  private opts: TimelineOptions;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private thumbs: ThumbnailRibbon;
  private hiddenHost: HTMLDivElement;
  private toolbarEl: HTMLDivElement | null = null;
  /**
   * Public flex slot at the left of the top toolbar. `null` when
   * `toolbar` is disabled. Hosts append their own elements (e.g. a
   * size/aspect dropdown). React/Vue wrappers portal children here.
   */
  readonly toolbarLeft: HTMLDivElement | null = null;
  /** Right-side counterpart — conventionally used for export/save. */
  readonly toolbarRight: HTMLDivElement | null = null;

  private project: Project;
  private pxPerSec: number;
  private timeMs: Ms;
  private selectedClipId: string | null;
  private snapEnabled: boolean;
  private showHeader: boolean;
  private readOnly: boolean;
  private autoFitEnabled: boolean;
  private locale: Locale;
  private rulerMinTickPx: number;
  private keyframesEnabled = false;
  private selectedKeyframe:
    | { clipId: string; keyframeId: string }
    | null = null;

  private scrollLeft = 0;
  private scrollTop = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  /**
   * `Date.now()` of the last interaction with each scrollbar (scroll
   * change OR hover OR drag). Drives the macOS-style fade — bars are
   * fully opaque for SCROLLBAR_FADE_HOLD_MS after activity, then ease
   * out over the next SCROLLBAR_FADE_OUT_MS.
   */
  private lastScrollInteractY = 0;
  private lastScrollInteractX = 0;
  private hoverScrollbarY = false;
  private hoverScrollbarX = false;
  /** When set, pointer is dragging a scrollbar thumb. */
  private scrollbarDrag: {
    axis: "v" | "h";
    pointerStart: number;
    scrollStart: number;
  } | null = null;
  private hoveredClipId: string | null = null;
  private hoveredTrackIndex: number | null = null;
  private hoveredKeyframe:
    | { clipId: string; keyframeId: string }
    | null = null;
  private hoverCursor: string = "default";
  private dropTargetTrackIndex: number | null = null;
  private snapX: number | null = null;
  private drag: DragCtx | null = null;
  /**
   * In-flight ghost of the clip being dragged. Decoupled from the
   * project data so the data stays clean and undo-able only commits
   * on release. Has both the proposed `start` (X) and `trackIndex`
   * (Y), so the rendered ghost follows the cursor across tracks.
   */
  private dragGhost: {
    clipId: string;
    ghostStart: Ms;
    ghostTrackIndex: number;
    wouldOverlap: boolean;
  } | null = null;
  /**
   * Most recent local pointer coords during a move drag — used by the
   * edge-autoscroll loop to re-run drop-target resolution between
   * pointermove events while scrollTop ticks under a stationary cursor.
   */
  private lastDragPointerX = 0;
  private lastDragPointerY = 0;
  private dragScrollRafPending = false;
  private rafPending = false;
  private hasAutoFitted = false;
  private resizeObs: ResizeObserver | null = null;
  private destroyed = false;

  static create(opts: TimelineOptions): Timeline {
    return new Timeline(opts);
  }

  constructor(opts: TimelineOptions) {
    this.opts = opts;
    this.root = opts.container;
    this.project = normalizeProject(opts.project);
    this.pxPerSec = clampScale(opts.pxPerSec ?? DEFAULT_SCALE);
    this.timeMs = opts.time ?? 0;
    this.selectedClipId = opts.selectedClipId ?? null;
    this.snapEnabled = opts.snap !== false;
    this.showHeader = opts.showHeader !== false;
    this.readOnly = opts.readOnly === true;
    this.autoFitEnabled = opts.autoFit !== false;
    this.locale = mergeLocale(opts.locale);
    this.rulerMinTickPx = opts.rulerMinTickPx ?? 80;
    this.keyframesEnabled = opts.keyframesEnabled === true;
    this.selectedKeyframe = opts.selectedKeyframe ?? null;

    this.root.classList.add("aicut-timeline-canvas");
    this.root.innerHTML = "";
    this.root.style.position = this.root.style.position || "relative";
    applyTheme(this.root, opts.theme);

    // Toolbar strip — opt-in. When enabled the root becomes a flex
    // column so the toolbar reserves vertical space and the canvas
    // gets whatever's left via flex:1. When off, the canvas keeps
    // its old 100%-height layout — zero-cost for existing callers.
    if (opts.toolbar) {
      this.root.style.display = "flex";
      this.root.style.flexDirection = "column";
      const bar = document.createElement("div");
      bar.className = "aicut-timeline-toolbar";
      const left = document.createElement("div");
      left.className = "aicut-timeline-toolbar-left";
      const right = document.createElement("div");
      right.className = "aicut-timeline-toolbar-right";
      bar.appendChild(left);
      bar.appendChild(right);
      this.root.appendChild(bar);
      this.toolbarEl = bar;
      (this as { toolbarLeft: HTMLDivElement | null }).toolbarLeft = left;
      (this as { toolbarRight: HTMLDivElement | null }).toolbarRight = right;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    if (opts.toolbar) {
      // Flex child: take remaining height; min-height:0 lets us shrink
      // below content size when the host is constrained.
      this.canvas.style.flex = "1 1 0";
      this.canvas.style.minHeight = "0";
    } else {
      this.canvas.style.height = "100%";
    }
    this.canvas.style.touchAction = "none";
    // No data-testid on the canvas itself — both the editor's and a
    // standalone frame-picker timeline would collide. Tests select via
    // the host element instead (e.g. `[data-testid="aicut-timeline"] canvas`).
    this.root.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    // Off-screen <video> elements for thumbnail extraction live here.
    this.hiddenHost = document.createElement("div");
    this.hiddenHost.style.position = "absolute";
    this.hiddenHost.style.overflow = "hidden";
    this.hiddenHost.style.width = "0";
    this.hiddenHost.style.height = "0";
    this.hiddenHost.style.pointerEvents = "none";
    this.root.appendChild(this.hiddenHost);

    this.thumbs = new ThumbnailRibbon(this.hiddenHost, () =>
      this.scheduleRender(),
    );
    this.thumbs.syncSources(this.project.sources);

    this.attachPointer();
    this.attachWheel();
    this.attachKeyboard();
    this.attachResize();
    this.resizeCanvas();
    this.scheduleRender();
  }

  // ---- public API -----------------------------------------------------

  /**
   * Sync the project data. Does NOT reset the auto-fit latch — that's
   * what caused the editor-side zoom feedback loop: every Editor
   * mutation called `ui.render() → timeline.setProject()` which used
   * to reset auto-fit, refit on the next frame, emit a new scale,
   * which re-rendered… and round we went. Callers that genuinely
   * want a re-fit (e.g. when the host swaps to a brand-new project)
   * should call `refit()` explicitly.
   */
  setProject(p: Project): void {
    this.project = normalizeProject(p);
    this.thumbs.syncSources(this.project.sources);
    this.scheduleRender();
  }

  /** Force a re-fit on the next render. */
  refit(): void {
    if (!this.autoFitEnabled) return;
    this.hasAutoFitted = false;
    this.scheduleRender();
  }

  getProject(): Project {
    return JSON.parse(JSON.stringify(this.project)) as Project;
  }

  setTime(timeMs: Ms): void {
    this.timeMs = Math.max(0, timeMs);
    this.scheduleRender();
  }

  getTime(): Ms {
    return this.timeMs;
  }

  setScale(pxPerSec: number): void {
    const next = clampScale(pxPerSec);
    if (next === this.pxPerSec) return;
    this.pxPerSec = next;
    this.hasAutoFitted = true;
    this.scheduleRender();
  }

  getScale(): number {
    return this.pxPerSec;
  }

  setSelection(id: string | null): void {
    if (id === this.selectedClipId) return;
    this.selectedClipId = id;
    this.scheduleRender();
  }

  getSelection(): string | null {
    return this.selectedClipId;
  }

  setSnap(snap: boolean): void {
    this.snapEnabled = snap;
  }

  getSnap(): boolean {
    return this.snapEnabled;
  }

  setLocale(locale: Partial<Locale>): void {
    this.locale = mergeLocale(locale);
    this.scheduleRender();
  }

  setRulerMinTickPx(px: number): void {
    if (px === this.rulerMinTickPx) return;
    this.rulerMinTickPx = Math.max(20, Math.round(px));
    this.scheduleRender();
  }

  /** Swap the theme tokens at runtime. Same Theme shape as the video
   *  Editor's `setTheme`. */
  setTheme(theme: Theme): void {
    applyTheme(this.root, theme);
    // Force a re-paint — the canvas reads CSS vars at draw time and
    // caches them into pixels, so without this the timeline keeps its
    // old colours until the next mouse move / scroll / focus interaction.
    this.scheduleRender();
  }

  /** Fit the project's full duration into the current viewport width. */
  fitToWindow(): void {
    const fit = this.computeFitScale();
    if (fit == null) return;
    this.pxPerSec = fit;
    this.hasAutoFitted = true;
    this.scrollLeft = 0;
    this.opts.onScaleChange?.(this.pxPerSec);
    this.scheduleRender();
  }

  /**
   * Test/debug introspection — pixel coordinates of every visible clip,
   * the playhead, and the headers. Because clips are canvas-painted
   * there are no DOM nodes to query in e2e; tests use this instead.
   * Exposed publicly so React/Vue wrappers can forward it to a ref.
   */
  getDebugInfo(): {
    pxPerSec: number;
    scrollLeft: number;
    viewportWidth: number;
    viewportHeight: number;
    playheadX: number;
    clips: Array<{
      id: string;
      trackIndex: number;
      x: number;
      width: number;
      y: number;
      height: number;
    }>;
  } {
    const baseX = contentLeftX(this.showHeader);
    const clips: Array<{
      id: string;
      trackIndex: number;
      x: number;
      width: number;
      y: number;
      height: number;
    }> = [];
    for (let ti = 0; ti < this.project.tracks.length; ti++) {
      const t = this.project.tracks[ti]!;
      for (const c of t.clips) {
        const x = baseX + (c.start / 1000) * this.pxPerSec - this.scrollLeft;
        const width = ((c.out - c.in) / 1000) * this.pxPerSec;
        const y = RULER_HEIGHT + ti * TRACK_HEIGHT + 6;
        clips.push({
          id: c.id,
          trackIndex: ti,
          x,
          width,
          y,
          height: TRACK_HEIGHT - 12,
        });
      }
    }
    return {
      pxPerSec: this.pxPerSec,
      scrollLeft: this.scrollLeft,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      playheadX:
        baseX + (this.timeMs / 1000) * this.pxPerSec - this.scrollLeft,
      clips,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObs?.disconnect();
    this.thumbs.destroy();
    this.root.innerHTML = "";
    this.root.classList.remove("aicut-timeline-canvas");
    if (this.opts.toolbar) {
      this.root.style.display = "";
      this.root.style.flexDirection = "";
    }
  }

  // ---- size / layout --------------------------------------------------

  private resizeCanvas(): void {
    // Read the canvas's own box, not the root's — when the toolbar
    // strip is enabled the root flex-allots part of its height to it,
    // and the canvas's rect is the only honest source of the drawing
    // area. With no toolbar, canvas fills root, so this still matches.
    const rect = this.canvas.getBoundingClientRect();
    this.viewportWidth = Math.max(1, Math.floor(rect.width));
    this.viewportHeight = Math.max(
      Math.floor(rect.height) || RULER_HEIGHT + TRACK_HEIGHT + SCROLLBAR_THICKNESS,
      RULER_HEIGHT + TRACK_HEIGHT + SCROLLBAR_THICKNESS,
    );
    const dpr = window.devicePixelRatio || 1;
    // canvas.width/height are the BACKING buffer (pixel) size. CSS layout
    // size (height: 100% or flex: 1 1 0) is set once in the constructor
    // and not touched here — writing `canvas.style.height = ${...}px`
    // here would freeze the inline height at the value sampled on first
    // paint, so any subsequent parent-container resize (e.g. EditorOptions
    // timelineHeight changing reactively) leaves the canvas stuck at the
    // original size.
    this.canvas.width = Math.floor(this.viewportWidth * dpr);
    this.canvas.height = Math.floor(this.viewportHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private computeFitScale(): number | null {
    const baseX = contentLeftX(this.showHeader);
    const w = this.viewportWidth - baseX - 24;
    const dur = projectDuration(this.project);
    if (w <= 0 || dur <= 0) return null;
    return clampScale(w / (dur / 1000));
  }

  private maxScrollLeft(): number {
    const baseX = contentLeftX(this.showHeader);
    const visibleW = this.viewportWidth - baseX - SCROLLBAR_THICKNESS;
    const cw = contentWidth(this.project, this.pxPerSec);
    // Tail pad keeps the right padding visible even when scrolled to
    // the project's end, mirroring the left content padding.
    return Math.max(0, cw - visibleW + TIMELINE_PAD_RIGHT);
  }

  private maxScrollTop(): number {
    const visibleH =
      this.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS;
    const ch = contentHeight(this.project.tracks, this.drag?.kind === "move");
    return Math.max(0, ch - visibleH);
  }

  private clampScroll(): void {
    this.scrollLeft = Math.max(0, Math.min(this.scrollLeft, this.maxScrollLeft()));
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScrollTop()));
  }

  /**
   * Scrollbar opacity = full for SCROLLBAR_FADE_HOLD_MS after last
   * interaction, then linearly fades to 0 over SCROLLBAR_FADE_OUT_MS.
   * Hovering or actively dragging the bar pins opacity at 1. Returns
   * 0 if the bar isn't needed (content fits).
   */
  private scrollbarOpacity(axis: "v" | "h"): number {
    if (axis === "v" && this.maxScrollTop() <= 0) return 0;
    if (axis === "h" && this.maxScrollLeft() <= 0) return 0;
    if (
      (axis === "v" && (this.hoverScrollbarY || this.scrollbarDrag?.axis === "v")) ||
      (axis === "h" && (this.hoverScrollbarX || this.scrollbarDrag?.axis === "h"))
    ) {
      return 1;
    }
    const last = axis === "v" ? this.lastScrollInteractY : this.lastScrollInteractX;
    const elapsed = Date.now() - last;
    if (elapsed < SCROLLBAR_FADE_HOLD_MS) return 1;
    const fade = elapsed - SCROLLBAR_FADE_HOLD_MS;
    if (fade >= SCROLLBAR_FADE_OUT_MS) return 0;
    return 1 - fade / SCROLLBAR_FADE_OUT_MS;
  }

  /** Mark a scrollbar axis as just-touched so its fade timer restarts. */
  private touchScrollbar(axis: "v" | "h"): void {
    if (axis === "v") this.lastScrollInteractY = Date.now();
    else this.lastScrollInteractX = Date.now();
    this.scheduleRender();
  }

  // ---- rendering ------------------------------------------------------

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.destroyed) return;
      this.maybeAutoFit();
      this.resizeCanvas();
      this.clampScroll();
      drawAll(
        this.ctx,
        this.buildDrawState(),
        this.readStyle(),
        this.thumbs,
      );
      this.canvas.style.cursor = this.hoverCursor;
      this.maybeContinueFade();
    });
  }

  /**
   * Keep the raf loop alive while a scrollbar is still in its HOLD or
   * fade-out window. Without this, opacity is sampled once and the
   * bar would freeze at whatever value it had at the last input event
   * instead of smoothly fading out. Skipped when a bar is pinned
   * (hover or active drag) since opacity is constant there.
   */
  private maybeContinueFade(): void {
    const total = SCROLLBAR_FADE_HOLD_MS + SCROLLBAR_FADE_OUT_MS;
    const now = Date.now();
    const needV =
      this.maxScrollTop() > 0 &&
      !this.hoverScrollbarY &&
      this.scrollbarDrag?.axis !== "v" &&
      now - this.lastScrollInteractY < total;
    const needH =
      this.maxScrollLeft() > 0 &&
      !this.hoverScrollbarX &&
      this.scrollbarDrag?.axis !== "h" &&
      now - this.lastScrollInteractX < total;
    if (needV || needH) this.scheduleRender();
  }

  private maybeAutoFit(): void {
    if (!this.autoFitEnabled || this.hasAutoFitted) return;
    if (projectDuration(this.project) <= 0) return;
    const fit = this.computeFitScale();
    if (fit == null) return;
    this.hasAutoFitted = true;
    if (Math.abs(fit - this.pxPerSec) > 0.5) {
      this.pxPerSec = fit;
      this.opts.onScaleChange?.(fit);
    }
  }

  private buildDrawState(): DrawState {
    return {
      project: this.project,
      pxPerSec: this.pxPerSec,
      scrollLeft: this.scrollLeft,
      scrollTop: this.scrollTop,
      timeMs: this.timeMs,
      selectedClipId: this.selectedClipId,
      hoveredClipId: this.hoveredClipId,
      hoveredTrackIndex: this.hoveredTrackIndex,
      dropTargetTrackIndex: this.dropTargetTrackIndex,
      isDragging: this.drag?.kind === "move",
      snapX: this.snapX,
      showHeader: this.showHeader,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      dragGhost: this.dragGhost,
      scrollbarOpacityY: this.scrollbarOpacity("v"),
      scrollbarOpacityX: this.scrollbarOpacity("h"),
      scrollbarActiveY: this.scrollbarDrag?.axis === "v",
      scrollbarActiveX: this.scrollbarDrag?.axis === "h",
      locale: this.locale,
      rulerMinTickPx: this.rulerMinTickPx,
      keyframesEnabled: this.keyframesEnabled,
      selectedKeyframe: this.selectedKeyframe,
      hoveredKeyframe: this.hoveredKeyframe,
      keyframeDragGhost:
        this.drag?.kind === "keyframe-drag"
          ? {
              clipId: this.drag.clipId,
              keyframeId: this.drag.keyframeId,
              ghostTimeMs: this.drag.ghostTimeMs,
            }
          : null,
    };
  }

  /** Host-pushed state — Editor calls this when its keyframe mode
   *  changes or when a keyframe is selected/deselected externally. */
  setKeyframeState(state: {
    enabled?: boolean;
    selected?: { clipId: string; keyframeId: string } | null;
  }): void {
    let dirty = false;
    if (state.enabled !== undefined && state.enabled !== this.keyframesEnabled) {
      this.keyframesEnabled = state.enabled;
      dirty = true;
    }
    if (state.selected !== undefined) {
      const a = this.selectedKeyframe;
      const b = state.selected;
      const same =
        a?.clipId === b?.clipId && a?.keyframeId === b?.keyframeId;
      if (!same) {
        this.selectedKeyframe = b;
        dirty = true;
      }
    }
    if (dirty) this.scheduleRender();
  }

  private readStyle(): DrawStyle {
    const cs = getComputedStyle(this.root);
    const v = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    return {
      bg: v("--aicut-controls-bg", "#1f1f22"),
      border: v("--aicut-controls-border", "rgba(255,255,255,0.08)"),
      // Pass the resolved text color straight through — draw.ts'
      // withAlpha can adjust it for tick / muted variants.
      text: v("--aicut-controls-text", "rgba(255,255,255,0.85)"),
      textMuted: v("--color-muted", "#999999"),
      trackBg: "rgba(255,255,255,0.06)",
      brand: v("--color-brand", "#9a31f4"),
      brandTo: v("--color-secondary", "#9a31f4"),
      info: v("--color-info", "#1077ff"),
      clipText: "#fff",
      selectedRing: v("--color-info", "#1077ff"),
      playhead: v("--color-brand", "#9a31f4"),
    };
  }

  // ---- pointer / wheel ------------------------------------------------

  private attachPointer(): void {
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.drag && !this.scrollbarDrag) {
        this.hoveredClipId = null;
        this.hoveredKeyframe = null;
        this.hoverCursor = "default";
        this.hoverScrollbarY = false;
        this.hoverScrollbarX = false;
        this.scheduleRender();
      }
    });
  }

  private onPointerDown(e: PointerEvent): void {
    const { x, y } = this.localCoords(e);
    const target = this.hitTarget(x, y);
    this.canvas.setPointerCapture(e.pointerId);

    // Scrollbar hits are handled BEFORE readOnly / other targets so the
    // bar works as a regular scroll affordance even in frame-picker mode.
    if (target.kind === "scrollbar-thumb-v") {
      this.scrollbarDrag = {
        axis: "v",
        pointerStart: y,
        scrollStart: this.scrollTop,
      };
      this.touchScrollbar("v");
      return;
    }
    if (target.kind === "scrollbar-thumb-h") {
      this.scrollbarDrag = {
        axis: "h",
        pointerStart: x,
        scrollStart: this.scrollLeft,
      };
      this.touchScrollbar("h");
      return;
    }
    if (target.kind === "scrollbar-track-v") {
      const page = Math.max(
        TRACK_HEIGHT,
        this.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS,
      );
      this.scrollTop += target.before ? -page : page;
      this.clampScroll();
      this.touchScrollbar("v");
      return;
    }
    if (target.kind === "scrollbar-track-h") {
      const baseX = contentLeftX(this.showHeader);
      const page = Math.max(
        80,
        this.viewportWidth - baseX - SCROLLBAR_THICKNESS,
      );
      this.scrollLeft += target.before ? -page : page;
      this.clampScroll();
      this.touchScrollbar("h");
      return;
    }

    // Read-only mode (e.g. frame-picker) — every click in the track
    // area becomes a seek. Drag = scrub. No selection / move / trim.
    if (this.readOnly) {
      if (
        target.kind === "ruler" ||
        target.kind === "clip" ||
        target.kind === "clip-handle-left" ||
        target.kind === "clip-handle-right" ||
        target.kind === "track-empty"
      ) {
        this.drag = { kind: "scrub" };
        const ms = this.applySnap(
          xToMs(x, this.pxPerSec, this.scrollLeft, this.showHeader),
          null,
        );
        this.timeMs = ms;
        this.opts.onSeek?.(ms);
        this.scheduleRender();
      }
      return;
    }

    if (target.kind === "header-delete") {
      const t = this.project.tracks[target.trackIndex];
      if (t) this.opts.onDeleteTrack?.(t.id);
      return;
    }

    if (target.kind === "header") return;

    if (target.kind === "ruler") {
      this.drag = { kind: "scrub" };
      const ms = this.applySnap(
        xToMs(x, this.pxPerSec, this.scrollLeft, this.showHeader),
        null,
      );
      this.timeMs = ms;
      this.opts.onSeek?.(ms);
      this.scheduleRender();
      return;
    }

    if (target.kind === "keyframe") {
      // Look up the current keyframe time (clip-local).
      const found = findClip(this.project, target.clipId);
      const kf = found?.clip.keyframes?.find((k) => k.id === target.keyframeId);
      if (!found || !kf) return;
      this.selectedKeyframe = {
        clipId: target.clipId,
        keyframeId: target.keyframeId,
      };
      this.opts.onSelectKeyframe?.({
        clipId: target.clipId,
        keyframeId: target.keyframeId,
      });
      // Also jump the playhead to the keyframe — matches CapCut. Lets
      // the user instantly see + edit the pinned transform.
      const absMs = found.clip.start + kf.time;
      this.timeMs = absMs;
      this.opts.onSeek?.(absMs);
      this.drag = {
        kind: "keyframe-drag",
        clipId: target.clipId,
        keyframeId: target.keyframeId,
        trackIndex: target.trackIndex,
        pointerStartX: x,
        originalTimeMs: kf.time,
        ghostTimeMs: kf.time,
      };
      this.scheduleRender();
      return;
    }

    if (target.kind === "clip") {
      const found = findClip(this.project, target.clipId);
      if (!found) return;
      this.selectedClipId = target.clipId;
      this.opts.onSelectClip?.(target.clipId);
      this.drag = {
        kind: "move",
        clipId: target.clipId,
        trackIndex: target.trackIndex,
        pointerStartX: x,
        pointerStartY: y,
        originalStart: found.clip.start,
      };
      this.scheduleRender();
      return;
    }

    if (
      target.kind === "clip-handle-left" ||
      target.kind === "clip-handle-right"
    ) {
      const found = findClip(this.project, target.clipId);
      if (!found) return;
      this.selectedClipId = target.clipId;
      this.opts.onSelectClip?.(target.clipId);
      this.drag = {
        kind: target.kind === "clip-handle-left" ? "trim-left" : "trim-right",
        clipId: target.clipId,
        trackIndex: target.trackIndex,
        pointerStartX: x,
        originalStart: found.clip.start,
        originalIn: found.clip.in,
        originalOut: found.clip.out,
      };
      this.scheduleRender();
      return;
    }

    if (target.kind === "track-empty") {
      // Bare-track click = deselect + seek to clicked time.
      this.selectedClipId = null;
      this.opts.onSelectClip?.(null);
      const ms = this.applySnap(
        xToMs(x, this.pxPerSec, this.scrollLeft, this.showHeader),
        null,
      );
      this.timeMs = ms;
      this.opts.onSeek?.(ms);
      this.drag = { kind: "scrub" };
      this.scheduleRender();
      return;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localCoords(e);

    // Scrollbar thumb drag has priority — pointer delta along the bar's
    // axis maps to a scroll delta scaled by (maxScroll / freeTrackLen).
    // freeTrackLen is the gutter length minus the thumb length, i.e.
    // how far the thumb can actually travel.
    if (this.scrollbarDrag) {
      if (this.scrollbarDrag.axis === "v") {
        const visibleH =
          this.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS;
        const contentH = contentHeight(
          this.project.tracks,
          this.drag?.kind === "move",
        );
        const trackLen = visibleH - SCROLLBAR_INSET * 2;
        const thumbLen = Math.max(
          SCROLLBAR_MIN_THUMB,
          trackLen * (visibleH / contentH),
        );
        const maxScroll = Math.max(0, contentH - visibleH);
        const free = Math.max(1, trackLen - thumbLen);
        const ratio = maxScroll / free;
        this.scrollTop =
          this.scrollbarDrag.scrollStart +
          (y - this.scrollbarDrag.pointerStart) * ratio;
      } else {
        const baseX = contentLeftX(this.showHeader);
        const visibleW = this.viewportWidth - baseX - SCROLLBAR_THICKNESS;
        const contentW = contentWidth(this.project, this.pxPerSec);
        const trackLen = visibleW - SCROLLBAR_INSET * 2;
        const thumbLen = Math.max(
          SCROLLBAR_MIN_THUMB,
          trackLen * (visibleW / contentW),
        );
        const maxScroll = Math.max(0, contentW - visibleW);
        const free = Math.max(1, trackLen - thumbLen);
        const ratio = maxScroll / free;
        this.scrollLeft =
          this.scrollbarDrag.scrollStart +
          (x - this.scrollbarDrag.pointerStart) * ratio;
      }
      this.clampScroll();
      this.touchScrollbar(this.scrollbarDrag.axis);
      return;
    }

    if (!this.drag) {
      // Hover-only — update cursor + hoveredClipId + hoveredTrackIndex.
      const target = this.hitTarget(x, y);
      let nextHover: string | null = null;
      let nextHoverTrack: number | null = null;
      let cursor = "default";
      let onScrollbarV = false;
      let onScrollbarH = false;
      let nextHoverKeyframe: { clipId: string; keyframeId: string } | null =
        null;
      if (target.kind === "clip") {
        nextHover = target.clipId;
        nextHoverTrack = target.trackIndex;
        cursor = this.readOnly ? "pointer" : "grab";
      } else if (target.kind === "keyframe") {
        nextHover = target.clipId;
        nextHoverTrack = target.trackIndex;
        nextHoverKeyframe = {
          clipId: target.clipId,
          keyframeId: target.keyframeId,
        };
        cursor = "pointer";
      } else if (
        target.kind === "clip-handle-left" ||
        target.kind === "clip-handle-right"
      ) {
        nextHover = target.clipId;
        nextHoverTrack = target.trackIndex;
        cursor = "ew-resize";
      } else if (target.kind === "ruler") {
        cursor = "ew-resize";
      } else if (target.kind === "track-empty") {
        nextHoverTrack = target.trackIndex;
        cursor = "crosshair";
      } else if (target.kind === "header") {
        nextHoverTrack = target.trackIndex;
        cursor = "default";
      } else if (target.kind === "header-delete") {
        nextHoverTrack = target.trackIndex;
        cursor = "pointer";
      } else if (
        target.kind === "scrollbar-thumb-v" ||
        target.kind === "scrollbar-track-v"
      ) {
        onScrollbarV = true;
        cursor = "default";
      } else if (
        target.kind === "scrollbar-thumb-h" ||
        target.kind === "scrollbar-track-h"
      ) {
        onScrollbarH = true;
        cursor = "default";
      }
      const hoverChanged =
        onScrollbarV !== this.hoverScrollbarY ||
        onScrollbarH !== this.hoverScrollbarX;
      const kfHoverChanged =
        (nextHoverKeyframe?.clipId ?? null) !==
          (this.hoveredKeyframe?.clipId ?? null) ||
        (nextHoverKeyframe?.keyframeId ?? null) !==
          (this.hoveredKeyframe?.keyframeId ?? null);
      if (
        nextHover !== this.hoveredClipId ||
        nextHoverTrack !== this.hoveredTrackIndex ||
        cursor !== this.hoverCursor ||
        hoverChanged ||
        kfHoverChanged
      ) {
        this.hoveredClipId = nextHover;
        this.hoveredTrackIndex = nextHoverTrack;
        this.hoverCursor = cursor;
        this.hoverScrollbarY = onScrollbarV;
        this.hoverScrollbarX = onScrollbarH;
        this.hoveredKeyframe = nextHoverKeyframe;
        this.scheduleRender();
      }
      return;
    }

    if (this.drag.kind === "scrub") {
      const ms = this.applySnap(
        xToMs(x, this.pxPerSec, this.scrollLeft, this.showHeader),
        null,
      );
      this.timeMs = ms;
      this.opts.onSeek?.(ms);
      this.scheduleRender();
      return;
    }

    if (this.drag.kind === "move") {
      this.lastDragPointerX = x;
      this.lastDragPointerY = y;
      this.processMoveDrag(x, y);
      this.scheduleRender();
      this.maybeStartDragAutoScroll();
      return;
    }

    if (this.drag.kind === "keyframe-drag") {
      // Compute the snapped clip-local time and stash it on the drag
      // struct. The actual mutation is deferred to pointer-up so the
      // history stack gets a single entry per drag (not one per tick).
      const found = findClip(this.project, this.drag.clipId);
      if (!found) return;
      const clip = found.clip;
      const duration = clip.out - clip.in;
      const dxPx = x - this.drag.pointerStartX;
      const dxMs = (dxPx / this.pxPerSec) * 1000;
      const nextLocal = Math.max(
        0,
        Math.min(duration, this.drag.originalTimeMs + dxMs),
      );
      const snappedAbs = this.applySnap(clip.start + nextLocal, null);
      const snappedLocal = Math.max(
        0,
        Math.min(duration, snappedAbs - clip.start),
      );
      this.drag.ghostTimeMs = Math.round(snappedLocal);
      this.scheduleRender();
      return;
    }

    if (this.drag.kind === "trim-left" || this.drag.kind === "trim-right") {
      const dxPx = x - this.drag.pointerStartX;
      const dxMs = (dxPx / this.pxPerSec) * 1000;
      const found = findClip(this.project, this.drag.clipId);
      if (!found) return;
      const c = found.clip;
      if (this.drag.kind === "trim-left") {
        // Move start + in by the same delta; clip's right edge stays put.
        let nextStart = Math.max(0, this.drag.originalStart + dxMs);
        nextStart = this.applySnap(nextStart, this.drag.clipId);
        const delta = nextStart - this.drag.originalStart;
        const nextIn = Math.max(
          0,
          Math.min(this.drag.originalIn + delta, this.drag.originalOut - 50),
        );
        const adjStart = this.drag.originalStart + (nextIn - this.drag.originalIn);
        c.in = nextIn;
        c.start = adjStart;
      } else {
        // trim-right — move out only.
        const nextOut = Math.max(
          this.drag.originalIn + 50,
          this.drag.originalOut + dxMs,
        );
        c.out = nextOut;
      }
      this.scheduleRender();
      return;
    }
  }

  /**
   * Update dragGhost + dropTargetTrackIndex for the in-flight move
   * drag, given the current viewport pointer position. Pulled out of
   * onPointerMove so the edge-autoscroll loop can re-run it on each
   * tick — autoscroll moves scrollTop under a stationary cursor, and
   * the ghost must follow the new row under that cursor.
   */
  private processMoveDrag(x: number, y: number): void {
    if (!this.drag || this.drag.kind !== "move") return;
    const drag = this.drag;
    const dxPx = x - drag.pointerStartX;
    const dxMs = (dxPx / this.pxPerSec) * 1000;
    let nextStart = Math.max(0, drag.originalStart + dxMs);
    nextStart = this.applySnap(nextStart, drag.clipId);

    const tiRaw = this.trackIndexAtY(y);
    const phantomIdx = this.project.tracks.length;
    const phantomScreenY =
      RULER_HEIGHT + phantomIdx * TRACK_HEIGHT - this.scrollTop;
    // Hit zone for the "+ 新轨道" phantom row: anywhere below the last
    // existing track up to the viewport bottom. Visually the phantom
    // still draws at `phantomScreenY` (one row tall), but when the
    // viewport is compact (small timelineHeight) the phantom is
    // pushed below the visible area and the user can only reach it
    // after auto-scrolling. Extending the hit zone all the way down
    // means "drop anywhere in the empty space below the tracks" is
    // interpreted as "create a new track" — matches the visual
    // intent without requiring scroll gymnastics.
    const viewportBottom = this.viewportHeight - SCROLLBAR_THICKNESS;
    const onPhantom =
      y >= phantomScreenY && y < Math.max(phantomScreenY + TRACK_HEIGHT, viewportBottom);
    const intendedTrackIndex = onPhantom
      ? phantomIdx
      : tiRaw >= 0
        ? tiRaw
        : drag.trackIndex;

    let ghostTrackIndex = intendedTrackIndex;
    let overlap = false;
    if (onPhantom) {
      ghostTrackIndex = phantomIdx;
      overlap = true;
    } else if (this.opts.resolveDrop) {
      const r = this.opts.resolveDrop(drag.clipId, {
        start: nextStart,
        intendedTrackIndex,
      });
      ghostTrackIndex = r.trackIndex;
      overlap = r.wouldCreateNew;
    } else {
      const found = findClip(this.project, drag.clipId);
      const dur = found ? found.clip.out - found.clip.in : 0;
      const targetTrack = this.project.tracks[intendedTrackIndex];
      overlap = targetTrack
        ? wouldOverlap(targetTrack, drag.clipId, nextStart, nextStart + dur)
        : false;
    }

    this.dragGhost = {
      clipId: drag.clipId,
      ghostStart: nextStart,
      ghostTrackIndex,
      wouldOverlap: overlap,
    };
    this.dropTargetTrackIndex =
      ghostTrackIndex !== drag.trackIndex ? ghostTrackIndex : null;
  }

  /**
   * Px-per-frame scroll speed when the pointer is in a vertical edge
   * zone of the track region. Returns 0 outside the zone. Speed ramps
   * linearly from 0 at the zone's inner edge to ~16 px/frame at the
   * outer edge, so brushing the edge gives a gentle nudge and parking
   * deep at it gives a brisk auto-scroll.
   */
  private dragScrollSpeedY(): number {
    if (!this.drag || this.drag.kind !== "move") return 0;
    const y = this.lastDragPointerY;
    const top = RULER_HEIGHT;
    const bottom = this.viewportHeight - SCROLLBAR_THICKNESS;
    const zone = 36;
    const maxSpeed = 16;
    if (y >= top && y < top + zone) {
      // Top zone — scroll up (decrease scrollTop), but only if there's
      // somewhere to go (otherwise the loop would tick forever).
      if (this.scrollTop <= 0) return 0;
      const depth = (top + zone - y) / zone;
      return -Math.max(2, maxSpeed * depth);
    }
    if (y <= bottom && y > bottom - zone) {
      if (this.scrollTop >= this.maxScrollTop()) return 0;
      const depth = (y - (bottom - zone)) / zone;
      return Math.max(2, maxSpeed * depth);
    }
    return 0;
  }

  /**
   * Drive vertical auto-scroll while the user holds a clip near the
   * top/bottom edge of the track area. Self-stopping — exits the loop
   * once the pointer leaves the zone, the drag ends, or scroll bottoms
   * out at the clamp.
   */
  private maybeStartDragAutoScroll(): void {
    if (this.dragScrollRafPending) return;
    if (this.dragScrollSpeedY() === 0) return;
    this.dragScrollRafPending = true;
    requestAnimationFrame(() => {
      this.dragScrollRafPending = false;
      if (this.destroyed) return;
      const speed = this.dragScrollSpeedY();
      if (speed === 0 || !this.drag || this.drag.kind !== "move") return;
      this.scrollTop += speed;
      this.clampScroll();
      this.touchScrollbar("v");
      this.processMoveDrag(this.lastDragPointerX, this.lastDragPointerY);
      this.scheduleRender();
      this.maybeStartDragAutoScroll();
    });
  }

  private onPointerUp(_e: PointerEvent): void {
    if (this.scrollbarDrag) {
      const axis = this.scrollbarDrag.axis;
      this.scrollbarDrag = null;
      this.touchScrollbar(axis);
      return;
    }
    if (!this.drag) return;
    const drag = this.drag;
    const ghost = this.dragGhost;
    this.drag = null;
    this.dragGhost = null;
    this.dropTargetTrackIndex = null;
    this.snapX = null;

    if (drag.kind === "move") {
      if (ghost) {
        const isPhantom = ghost.ghostTrackIndex >= this.project.tracks.length;
        const finalTrackId = isPhantom
          ? undefined
          : ghost.ghostTrackIndex !== drag.trackIndex
            ? this.project.tracks[ghost.ghostTrackIndex]?.id
            : undefined;
        this.opts.onMoveClip?.(drag.clipId, {
          start: ghost.ghostStart,
          trackId: finalTrackId,
          // Phantom row drop is the user explicitly asking for a new
          // track — bypass the editor's smart routing in that case
          // (which would otherwise route back to the source track and
          // make the gesture a no-op).
          newTrack: isPhantom,
        });
        this.opts.onChange?.(this.getProject());
      }
    } else if (drag.kind === "keyframe-drag") {
      if (drag.ghostTimeMs !== drag.originalTimeMs) {
        this.opts.onMoveKeyframe?.(
          drag.clipId,
          drag.keyframeId,
          drag.ghostTimeMs,
        );
      }
    } else if (drag.kind === "trim-left" || drag.kind === "trim-right") {
      const found = findClip(this.project, drag.clipId);
      if (found) {
        this.opts.onResizeClip?.(drag.clipId, {
          in: found.clip.in,
          out: found.clip.out,
          start: found.clip.start,
        });
        this.opts.onChange?.(this.getProject());
      }
    }
    this.scheduleRender();
  }

  private attachKeyboard(): void {
    // Make the canvas focusable so it can receive keydown. Without
    // tabIndex the browser's accessibility tree refuses to deliver
    // key events to a <canvas>. -1 means "focusable by click but not
    // by tab" — the timeline isn't a primary tab stop, but it
    // accepts focus when the user clicks on it.
    this.canvas.tabIndex = -1;
    this.canvas.style.outline = "none"; // suppress the focus ring
    this.canvas.addEventListener("keydown", (e) => {
      if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
      // Frame-stepping nav — step size derived from Project.fps
      // (defaults to 30). Same helpers as EditorUI so behavior stays
      // consistent whether the timeline is embedded or standalone.
      e.preventDefault();
      const step = e.shiftKey
        ? bigFrameStepMs(this.project)
        : frameStepMs(this.project);
      const dir = e.code === "ArrowLeft" ? -1 : 1;
      const dur = projectDuration(this.project);
      const next = Math.max(0, Math.min(dur, this.timeMs + dir * step));
      if (next === this.timeMs) return;
      this.timeMs = next;
      this.opts.onSeek?.(next);
      this.scheduleRender();
    });
    // Auto-focus on pointer-down so the very first arrow press after
    // clicking the timeline actually moves the playhead. Without this
    // the canvas only gets focus on the second interaction, which
    // feels broken.
    this.canvas.addEventListener("pointerdown", () => {
      if (document.activeElement !== this.canvas) this.canvas.focus();
    });
  }

  private attachWheel(): void {
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const rect = this.canvas.getBoundingClientRect();
          const cursorX = e.clientX - rect.left;
          const anchorMs = xToMs(
            cursorX,
            this.pxPerSec,
            this.scrollLeft,
            this.showHeader,
          );
          const dy = Math.max(-50, Math.min(50, e.deltaY));
          const factor = Math.exp(-dy * WHEEL_ZOOM_RATE);
          const next = clampScale(this.pxPerSec * factor);
          if (Math.abs(next - this.pxPerSec) < 0.01) return;
          this.pxPerSec = next;
          this.hasAutoFitted = true;
          // Re-anchor: keep the time under the cursor visually pinned.
          const baseX = contentLeftX(this.showHeader);
          this.scrollLeft =
            (anchorMs / 1000) * this.pxPerSec - (cursorX - baseX);
          this.clampScroll();
          this.touchScrollbar("h");
          this.opts.onScaleChange?.(this.pxPerSec);
          this.scheduleRender();
          return;
        }
        // Pan. Trackpad horizontal swipe (|deltaX|>|deltaY|) → X axis.
        // Otherwise vertical wheel/swipe → Y axis when tracks overflow,
        // falling through to X when there's no Y to scroll (preserves
        // the single-track UX where a mouse wheel pans horizontally).
        const horizDominant = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (horizDominant) {
          if (e.deltaX === 0) return;
          e.preventDefault();
          this.scrollLeft += e.deltaX;
          this.clampScroll();
          this.touchScrollbar("h");
          this.scheduleRender();
          return;
        }
        if (e.deltaY === 0) return;
        e.preventDefault();
        if (this.maxScrollTop() > 0) {
          this.scrollTop += e.deltaY;
          this.clampScroll();
          this.touchScrollbar("v");
        } else {
          this.scrollLeft += e.deltaY;
          this.clampScroll();
          this.touchScrollbar("h");
        }
        this.scheduleRender();
      },
      { passive: false },
    );
  }

  private attachResize(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObs = new ResizeObserver(() => {
      this.resizeCanvas();
      if (!this.hasAutoFitted && this.autoFitEnabled) {
        const fit = this.computeFitScale();
        if (fit != null) {
          this.pxPerSec = fit;
          this.opts.onScaleChange?.(fit);
        }
      }
      this.scheduleRender();
    });
    this.resizeObs.observe(this.root);
  }

  // ---- helpers --------------------------------------------------------

  private localCoords(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private hitTarget(x: number, y: number): HitTarget {
    return hitTest(x, y, {
      project: this.project,
      pxPerSec: this.pxPerSec,
      scrollLeft: this.scrollLeft,
      scrollTop: this.scrollTop,
      showHeader: this.showHeader,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      isDragging: this.drag?.kind === "move",
      keyframesEnabled: this.keyframesEnabled,
    });
  }

  private trackIndexAtY(y: number): number {
    return trackIndexAt(y, this.project.tracks.length, this.scrollTop);
  }

  private applySnap(ms: Ms, ignoreClipId: string | null): Ms {
    if (!this.snapEnabled) {
      this.snapX = null;
      return ms;
    }
    const tolMs = Math.max(20, (SNAP_PX / this.pxPerSec) * 1000);
    const targets = snapTargets(this.project, this.timeMs, ignoreClipId);
    let best = ms;
    let bestDist = tolMs;
    for (const t of targets) {
      const d = Math.abs(t - ms);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (best !== ms) {
      const baseX = contentLeftX(this.showHeader);
      this.snapX = baseX + (best / 1000) * this.pxPerSec - this.scrollLeft;
    } else {
      this.snapX = null;
    }
    return best;
  }
}

// Expose helpers from layout.ts via a deep import for consumers who
// want the px math without instantiating Timeline.
export { TRACK_HEIGHT, RULER_HEIGHT, HEADER_WIDTH } from "./layout.js";
