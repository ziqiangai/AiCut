import type { Locale } from "../i18n.js";
import { fmtClock } from "./format.js";
import { ICONS, type IconName } from "./icons.js";

const SCALE_MIN = 10;
const SCALE_MAX = 400;

export interface ToolbarCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onSplit: () => void;
  onTrimLeft: () => void;
  onTrimRight: () => void;
  onPlayToggle: () => void;
  onFullscreen: () => void;
  onReset: () => void;
  onSnapToggle: () => void;
  onScaleChange: (pxPerSec: number) => void;
  /** Add a keyframe at the playhead — or remove the existing one if
   *  a keyframe already sits exactly at the playhead's clip-local time
   *  (CapCut-style toggle on the same button). */
  onKeyframeToggle: () => void;
  /** Move the playhead to the selected clip's start / end. End seek
   *  intentionally lands 1ms inside the clip so subsequent
   *  keyframe-add finds the clip — see Editor.seekToSelectedClipEdge. */
  onSeekClipStart: () => void;
  onSeekClipEnd: () => void;
}

interface ToolbarState {
  playing: boolean;
  time: number;
  duration: number;
  canUndo: boolean;
  canRedo: boolean;
  canSplit: boolean;
  canTrim: boolean;
  snap: boolean;
  pxPerSec: number;
  /** True when keyframe mode is enabled AND the selected clip
   *  contains the playhead — only then is the button clickable. */
  canKeyframe: boolean;
  /** True when a keyframe exists at the exact playhead time on the
   *  selected clip. Drives the button icon (filled vs outlined) and
   *  the tooltip (remove vs add). */
  hasKeyframeAtPlayhead: boolean;
  /** Only render the keyframe button at all when keyframe mode is on,
   *  matching the user's "demo只一个开关" requirement — chrome stays
   *  identical to today when the feature is disabled. */
  keyframesEnabled: boolean;
  /** Enable the |◀ / ▶| jump-to-clip-edge buttons. Mirrors the
   *  selection-driven gating used by split / trim. */
  canSeekClipEdge: boolean;
}

/**
 * Top toolbar — three groups laid out per the reference:
 *   left: [undo] [redo] [split] [trim-left] [trim-right] [speed]
 *   center: [time]  ▶  [duration]  [fullscreen]
 *   right: [snap] [zoom-out] [zoom-slider] [zoom-in] [reset]
 *
 * Export is intentionally NOT built-in — every host has its own
 * pipeline (download, server pipeline, etc.). Drop a custom button
 * into `editor.toolbarRight` or call `editor.requestExport()` from
 * any host UI to fire the `export` event.
 */
export class Toolbar {
  private root: HTMLDivElement;
  private cb: ToolbarCallbacks;
  private locale: Locale;

  /**
   * Bookend slots reserved for host-supplied controls. The library
   * paints nothing into either — hosts (React/Vue wrappers or plain
   * JS) append their own buttons / dropdowns. `extrasLeft` sits at
   * the very start of the toolbar; `extrasRight` at the very end.
   * Empty by default and visually hidden (no separator) until they
   * actually contain children.
   */
  readonly extrasLeft: HTMLDivElement;
  readonly extrasRight: HTMLDivElement;

  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private splitBtn!: HTMLButtonElement;
  private trimLeftBtn!: HTMLButtonElement;
  private trimRightBtn!: HTMLButtonElement;
  private seekClipStartBtn!: HTMLButtonElement;
  private seekClipEndBtn!: HTMLButtonElement;
  private keyframeBtn!: HTMLButtonElement;
  private playBtn!: HTMLButtonElement;
  private playIcon!: HTMLSpanElement;
  private timeLabel!: HTMLSpanElement;
  private durationLabel!: HTMLSpanElement;
  private fullscreenBtn!: HTMLButtonElement;
  private snapBtn!: HTMLButtonElement;
  private zoomOutBtn!: HTMLButtonElement;
  private zoomSlider!: HTMLInputElement;
  private zoomInBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private lastState: ToolbarState | null = null;

  constructor(host: HTMLElement, cb: ToolbarCallbacks, locale: Locale) {
    this.cb = cb;
    this.locale = locale;
    this.root = document.createElement("div");
    this.root.className = "aicut-toolbar";
    this.root.setAttribute("data-testid", "aicut-toolbar");

    this.extrasLeft = mkGroup("aicut-toolbar-extras aicut-toolbar-extras-left");
    this.extrasRight = mkGroup("aicut-toolbar-extras aicut-toolbar-extras-right");

    const left = mkGroup("aicut-toolbar-left");
    this.undoBtn = mkIconButton("undo", locale.undo, () => cb.onUndo(), "aicut-undo");
    this.redoBtn = mkIconButton("redo", locale.redo, () => cb.onRedo(), "aicut-redo");
    this.splitBtn = mkIconButton("split", locale.split, () => cb.onSplit(), "aicut-split");
    this.trimLeftBtn = mkIconButton("trimLeft", locale.trimLeft, () => cb.onTrimLeft(), "aicut-trim-left");
    this.trimRightBtn = mkIconButton("trimRight", locale.trimRight, () => cb.onTrimRight(), "aicut-trim-right");
    this.seekClipStartBtn = mkIconButton(
      "seekClipStart",
      locale.seekClipStart,
      () => cb.onSeekClipStart(),
      "aicut-seek-clip-start",
    );
    this.keyframeBtn = mkIconButton(
      "keyframeOutline",
      locale.keyframeAdd,
      () => cb.onKeyframeToggle(),
      "aicut-keyframe",
    );
    this.keyframeBtn.style.display = "none"; // gated by render() on keyframesEnabled
    this.seekClipEndBtn = mkIconButton(
      "seekClipEnd",
      locale.seekClipEnd,
      () => cb.onSeekClipEnd(),
      "aicut-seek-clip-end",
    );
    // Order: trim handles, then [|◀ ◇ ▶|] — start, kf, end — so the
    // three nav buttons cluster around the keyframe affordance.
    left.append(
      this.undoBtn,
      this.redoBtn,
      this.splitBtn,
      this.trimLeftBtn,
      this.trimRightBtn,
      this.seekClipStartBtn,
      this.keyframeBtn,
      this.seekClipEndBtn,
    );

    const center = mkGroup("aicut-toolbar-center");
    this.timeLabel = mkSpan("aicut-time-current", "00:00", "aicut-time-current");
    this.playBtn = document.createElement("button");
    this.playBtn.type = "button";
    this.playBtn.className = "aicut-play-btn";
    this.playBtn.title = locale.playPause;
    this.playBtn.setAttribute("data-testid", "aicut-play");
    this.playIcon = document.createElement("span");
    this.playIcon.innerHTML = ICONS.play;
    this.playBtn.appendChild(this.playIcon);
    this.playBtn.addEventListener("click", () => cb.onPlayToggle());
    this.durationLabel = mkSpan("aicut-time-total", "00:00", "aicut-time-total");
    this.fullscreenBtn = mkIconButton("fullscreen", locale.fullscreen, () => cb.onFullscreen(), "aicut-fullscreen");
    center.append(this.timeLabel, this.playBtn, this.durationLabel, this.fullscreenBtn);

    const right = mkGroup("aicut-toolbar-right");
    this.snapBtn = mkIconButton("snap", locale.snap, () => cb.onSnapToggle(), "aicut-snap");
    this.zoomOutBtn = mkIconButton("zoomOut", locale.zoomOut, () => this.nudgeZoom(-1), "aicut-zoom-out");
    this.zoomSlider = document.createElement("input");
    this.zoomSlider.type = "range";
    this.zoomSlider.min = "0";
    this.zoomSlider.max = "100";
    this.zoomSlider.className = "aicut-zoom-slider";
    this.zoomSlider.setAttribute("data-testid", "aicut-zoom-slider");
    this.zoomSlider.addEventListener("input", () => {
      const ratio = Number(this.zoomSlider.value) / 100;
      cb.onScaleChange(sliderToScale(ratio));
    });
    this.zoomInBtn = mkIconButton("zoomIn", locale.zoomIn, () => this.nudgeZoom(1), "aicut-zoom-in");
    this.resetBtn = mkIconButton("reset", locale.reset, () => cb.onReset(), "aicut-reset");
    right.append(this.snapBtn, this.zoomOutBtn, this.zoomSlider, this.zoomInBtn, this.resetBtn);

    this.root.append(this.extrasLeft, left, center, right, this.extrasRight);
    host.appendChild(this.root);
  }

  get element(): HTMLDivElement {
    return this.root;
  }

  /**
   * Idempotent render. Critically: only mutates DOM when a state
   * field actually changed. Without this, `playIcon.innerHTML = ICONS`
   * re-parsed the SVG every playback tick (~60Hz) — and replacing the
   * element between a user's mousedown and mouseup meant the browser
   * never fired `click` (the two events landed on different element
   * identities). That manifested as "needs 3 clicks to pause".
   *
   * Rule of thumb here: any `innerHTML =` / element rebuild MUST be
   * behind a "did the input change" guard. Plain `.disabled` /
   * `.textContent` writes are idempotent in browsers and safe to set
   * unconditionally, but we still diff them for cheap CPU.
   */
  render(state: ToolbarState): void {
    if (!this.lastState || this.lastState.time !== state.time) {
      this.timeLabel.textContent = fmtClock(state.time);
    }
    if (!this.lastState || this.lastState.duration !== state.duration) {
      this.durationLabel.textContent = fmtClock(state.duration);
    }
    if (!this.lastState || this.lastState.playing !== state.playing) {
      this.playIcon.innerHTML = state.playing ? ICONS.pause : ICONS.play;
      this.playBtn.setAttribute(
        "data-state",
        state.playing ? "playing" : "paused",
      );
    }
    if (!this.lastState || this.lastState.canUndo !== state.canUndo) {
      this.undoBtn.disabled = !state.canUndo;
    }
    if (!this.lastState || this.lastState.canRedo !== state.canRedo) {
      this.redoBtn.disabled = !state.canRedo;
    }
    if (!this.lastState || this.lastState.canSplit !== state.canSplit) {
      this.splitBtn.disabled = !state.canSplit;
    }
    if (!this.lastState || this.lastState.canTrim !== state.canTrim) {
      this.trimLeftBtn.disabled = !state.canTrim;
      this.trimRightBtn.disabled = !state.canTrim;
    }
    if (
      !this.lastState ||
      this.lastState.canSeekClipEdge !== state.canSeekClipEdge
    ) {
      this.seekClipStartBtn.disabled = !state.canSeekClipEdge;
      this.seekClipEndBtn.disabled = !state.canSeekClipEdge;
    }
    if (!this.lastState || this.lastState.snap !== state.snap) {
      this.snapBtn.setAttribute("aria-pressed", state.snap ? "true" : "false");
      this.snapBtn.classList.toggle("aicut-toggle-on", state.snap);
      this.snapBtn.title = state.snap
        ? this.locale.snapOnTitle
        : this.locale.snapOffTitle;
    }
    // Keyframe button — toggle visibility via display, swap icon to
    // reflect whether a kf exists at the playhead, swap tooltip.
    if (
      !this.lastState ||
      this.lastState.keyframesEnabled !== state.keyframesEnabled
    ) {
      this.keyframeBtn.style.display = state.keyframesEnabled ? "" : "none";
    }
    if (state.keyframesEnabled) {
      if (
        !this.lastState ||
        this.lastState.hasKeyframeAtPlayhead !== state.hasKeyframeAtPlayhead
      ) {
        this.keyframeBtn.innerHTML = state.hasKeyframeAtPlayhead
          ? ICONS.keyframeFilled
          : ICONS.keyframeOutline;
        const title = state.hasKeyframeAtPlayhead
          ? this.locale.keyframeRemove
          : this.locale.keyframeAdd;
        this.keyframeBtn.title = title;
        this.keyframeBtn.setAttribute("aria-label", title);
        this.keyframeBtn.setAttribute(
          "data-state",
          state.hasKeyframeAtPlayhead ? "on" : "off",
        );
      }
      if (
        !this.lastState ||
        this.lastState.canKeyframe !== state.canKeyframe
      ) {
        this.keyframeBtn.disabled = !state.canKeyframe;
      }
    }
    if (!this.lastState || this.lastState.pxPerSec !== state.pxPerSec) {
      const ratio = scaleToSlider(state.pxPerSec);
      const nextVal = String(Math.round(ratio * 100));
      if (this.zoomSlider.value !== nextVal) this.zoomSlider.value = nextVal;
      this.zoomSlider.style.setProperty(
        "--aicut-zoom-fill",
        `${Math.round(ratio * 100)}%`,
      );
    }
    this.lastState = { ...state };
  }

  destroy(): void {
    this.root.remove();
  }

  /**
   * Apply a new locale to all already-mounted controls. Re-uses the
   * same DOM elements (so event listeners and pointer-capture state
   * stay intact) — only writes `title` / `aria-label`. Snap toggle
   * title is then refreshed via the next render pass.
   */
  setLocale(locale: Locale): void {
    this.locale = locale;
    const applyTitle = (
      el: HTMLElement | undefined,
      title: string,
    ): void => {
      if (!el) return;
      el.title = title;
      el.setAttribute("aria-label", title);
    };
    applyTitle(this.undoBtn, locale.undo);
    applyTitle(this.redoBtn, locale.redo);
    applyTitle(this.splitBtn, locale.split);
    applyTitle(this.trimLeftBtn, locale.trimLeft);
    applyTitle(this.trimRightBtn, locale.trimRight);
    applyTitle(this.seekClipStartBtn, locale.seekClipStart);
    applyTitle(this.seekClipEndBtn, locale.seekClipEnd);
    applyTitle(this.playBtn, locale.playPause);
    applyTitle(this.fullscreenBtn, locale.fullscreen);
    applyTitle(this.snapBtn, locale.snap);
    applyTitle(this.zoomOutBtn, locale.zoomOut);
    applyTitle(this.zoomInBtn, locale.zoomIn);
    applyTitle(this.resetBtn, locale.reset);
    // Keyframe button tooltip — picks add/remove off the lastState if
    // we have one, otherwise default to add.
    if (this.keyframeBtn) {
      const hasKf = this.lastState?.hasKeyframeAtPlayhead === true;
      const t = hasKf ? locale.keyframeRemove : locale.keyframeAdd;
      this.keyframeBtn.title = t;
      this.keyframeBtn.setAttribute("aria-label", t);
    }
    // Force snap title re-evaluation on next render.
    if (this.lastState) {
      this.snapBtn.title = this.lastState.snap
        ? locale.snapOnTitle
        : locale.snapOffTitle;
    }
  }

  private nudgeZoom(dir: -1 | 1): void {
    const cur = Number(this.zoomSlider.value);
    const next = Math.max(0, Math.min(100, cur + dir * 8));
    this.zoomSlider.value = String(next);
    this.cb.onScaleChange(sliderToScale(next / 100));
  }
}

function mkGroup(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function mkSpan(cls: string, text: string, testId?: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  if (testId) s.setAttribute("data-testid", testId);
  return s;
}

function mkIconButton(
  icon: IconName,
  title: string,
  onClick: () => void,
  testId?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "aicut-icon-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = ICONS[icon];
  if (testId) b.setAttribute("data-testid", testId);
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Slider ↔ scale mapping is exponential so the slider feels uniform
 * across a wide zoom range. Matches the figma reference (exp-based
 * zoom step). 0 → SCALE_MIN, 1 → SCALE_MAX.
 */
function sliderToScale(ratio: number): number {
  const lo = Math.log(SCALE_MIN);
  const hi = Math.log(SCALE_MAX);
  return Math.exp(lo + (hi - lo) * ratio);
}

function scaleToSlider(scale: number): number {
  const lo = Math.log(SCALE_MIN);
  const hi = Math.log(SCALE_MAX);
  return (Math.log(Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale))) - lo) /
    (hi - lo);
}
