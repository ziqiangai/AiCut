import {
  bigFrameStepMs,
  clipDuration,
  findClipContaining,
  findTrackOfClip,
  frameStepMs,
} from "../model.js";
import type { Editor, PreviewLayout } from "../editor.js";
import { Timeline } from "../timeline/index.js";
import type { Clip, Ms } from "../types.js";
import type { Locale } from "../i18n.js";
import { KeyframeOverlay } from "./keyframe-overlay.js";
import { KeyframePanel } from "./keyframe-panel.js";
import { PreviewControls } from "./preview-controls.js";
import { Toolbar, type ToolbarCallbacks } from "./toolbar.js";

/**
 * Callbacks the editor wires into the UI. The toolbar contributes the
 * top-bar buttons; the timeline contributes click/drag intents that
 * the editor turns into model mutations (with overlap → new-track
 * routing centralised in `Editor.moveClip`).
 */
export interface UICallbacks extends ToolbarCallbacks {
  /** Play/pause toggle — wired into the preview-overlay play button. */
  onPlayToggle: () => void;
  /** Fullscreen toggle — wired into the preview-overlay fullscreen button. */
  onFullscreen: () => void;
  onSeek: (timeMs: Ms) => void;
  onSelectClip: (clipId: string | null) => void;
  onDeleteClip: (clipId: string) => void;
  onMoveClip: (
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ) => void;
  onResizeClip: (
    clipId: string,
    edits: Partial<Pick<Clip, "in" | "out" | "start">>,
  ) => void;
  onSelectKeyframe: (
    target: { clipId: string; keyframeId: string } | null,
  ) => void;
  onMoveKeyframe: (
    clipId: string,
    keyframeId: string,
    timeMs: Ms,
  ) => void;
}

/**
 * Composes the editor: preview host on top, toolbar middle, canvas
 * Timeline at the bottom. Single source of repaint via `render()`;
 * frequent `onTimeTick()` is the playback-fast path that only nudges
 * the playhead-related surfaces.
 */
export class EditorUI {
  private root: HTMLElement;
  private editor: Editor;
  private header: HTMLDivElement;
  /** Host-extensible slot at the very left of the editor header. */
  readonly headerLeft: HTMLDivElement;
  /** Host-extensible slot at the very right of the editor header. */
  readonly headerRight: HTMLDivElement;
  /** Wrapping element below the header that holds the side panels +
   *  preview. Becomes a 3-column grid when previewLayout = centered. */
  private main: HTMLDivElement;
  /** Side panel slot to the left of the preview. Visible only when
   *  previewLayout = centered. */
  readonly panelLeft: HTMLDivElement;
  /** Side panel slot to the right of the preview. */
  readonly panelRight: HTMLDivElement;
  /** The "card" wrapping the video viewport + playback footer. Width
   *  is capped via CSS; height auto-fits via the host's aspect ratio. */
  private previewCard: HTMLDivElement;
  private preview: HTMLDivElement;
  private previewControls: PreviewControls;
  private fullscreenExitBtn: HTMLButtonElement;
  private toolbar: Toolbar;
  private timelineHost: HTMLDivElement;
  private timeline: Timeline;
  private keyframePanel: KeyframePanel;
  private keyframeOverlay: KeyframeOverlay;
  private fullscreen = false;
  private onDocKeydown: ((e: KeyboardEvent) => void) | null = null;

  constructor(root: HTMLElement, editor: Editor, cb: UICallbacks) {
    this.root = root;
    this.editor = editor;
    const locale = editor.getLocale();

    root.classList.add("aicut-root");
    root.innerHTML = "";

    // Optional header above the preview — left/right bookend slots
    // the host fills via React/Vue wrappers. Always rendered; CSS
    // collapses it via :has() when both slots are empty so callers
    // who don't use it see exactly today's layout.
    this.header = document.createElement("div");
    this.header.className = "aicut-header";
    this.header.setAttribute("data-testid", "aicut-header");
    this.headerLeft = document.createElement("div");
    this.headerLeft.className = "aicut-header-slot aicut-header-left";
    this.headerRight = document.createElement("div");
    this.headerRight.className = "aicut-header-slot aicut-header-right";
    this.header.append(this.headerLeft, this.headerRight);
    root.appendChild(this.header);

    // Main area below the header. In fullWidth layout it's a single
    // cell holding the preview; in centered layout it becomes a
    // 3-column grid `panel-left | preview | panel-right`. CSS reads
    // `data-preview-layout` on the editor root to switch templates.
    this.main = document.createElement("div");
    this.main.className = "aicut-main";
    this.main.setAttribute("data-testid", "aicut-main");
    this.panelLeft = document.createElement("div");
    this.panelLeft.className = "aicut-panel aicut-panel-left";
    this.panelLeft.setAttribute("data-testid", "aicut-panel-left");
    this.panelRight = document.createElement("div");
    this.panelRight.className = "aicut-panel aicut-panel-right";
    this.panelRight.setAttribute("data-testid", "aicut-panel-right");

    // Preview "card" — capped width, aspect-driven height, rounded
    // surface that visually separates the viewport from the chrome
    // around it. CapCut-desktop's preview area uses this same pattern:
    // a fixed-width media frame with the playback strip as a footer
    // beneath it, rather than overlaying the controls on top of the
    // video where they can collide with the canvas / keyframe guides.
    this.previewCard = document.createElement("div");
    this.previewCard.className = "aicut-preview-card";
    this.previewCard.setAttribute("data-testid", "aicut-preview-card");

    this.preview = document.createElement("div");
    this.preview.className = "aicut-preview-host";
    this.preview.setAttribute("data-testid", "aicut-preview");

    this.fullscreenExitBtn = document.createElement("button");
    this.fullscreenExitBtn.type = "button";
    this.fullscreenExitBtn.className = "aicut-fullscreen-exit";
    this.fullscreenExitBtn.title = locale.exitFullscreenTitle;
    this.fullscreenExitBtn.setAttribute("data-testid", "aicut-fullscreen-exit");
    this.fullscreenExitBtn.textContent = locale.exitFullscreen;
    this.fullscreenExitBtn.addEventListener("click", () =>
      this.setFullscreen(false),
    );
    this.preview.appendChild(this.fullscreenExitBtn);

    // Playback controls — time / play / duration / fullscreen — sit
    // as a card footer beneath the viewport (CapCut-desktop style),
    // not as an overlay on the video. Keeps the footer chrome from
    // colliding with the canvas guide / keyframe handles inside the
    // viewport.
    this.previewControls = new PreviewControls(
      { onPlayToggle: cb.onPlayToggle, onFullscreen: cb.onFullscreen },
      locale,
    );

    this.previewCard.append(this.preview, this.previewControls.element);
    this.main.append(this.panelLeft, this.previewCard, this.panelRight);
    root.appendChild(this.main);

    this.toolbar = new Toolbar(root, cb, locale);
    root.setAttribute("data-preview-layout", editor.getPreviewLayout());
    this.applyAspect(editor.getAspect());

    this.timelineHost = document.createElement("div");
    this.timelineHost.className = "aicut-timeline";
    this.timelineHost.setAttribute("data-testid", "aicut-timeline");
    root.appendChild(this.timelineHost);

    this.timeline = Timeline.create({
      container: this.timelineHost,
      project: editor.getProject(),
      pxPerSec: editor.getScale(),
      time: editor.getTime(),
      selectedClipId: editor.getSelection(),
      snap: editor.getSnap(),
      autoFit: true,
      locale,
      rulerMinTickPx: editor.getRulerMinTickPx(),
      keyframesEnabled: editor.isKeyframesEnabled(),
      selectedKeyframe: editor.getSelectedKeyframe(),
      onSeek: cb.onSeek,
      onSelectClip: cb.onSelectClip,
      onMoveClip: cb.onMoveClip,
      onResizeClip: cb.onResizeClip,
      onSelectKeyframe: cb.onSelectKeyframe,
      onMoveKeyframe: cb.onMoveKeyframe,
      onScaleChange: cb.onScaleChange,
      onDeleteTrack: (trackId) => editor.removeTrack(trackId),
      // Mirror the editor's smart routing into the drag preview so
      // the ghost lands on the same row the commit will pick.
      resolveDrop: (clipId, intent) => {
        const proj = editor.getProject();
        const intendedTrack = proj.tracks[intent.intendedTrackIndex];
        const pred = editor.previewMoveTarget(
          clipId,
          intent.start,
          intendedTrack?.id,
        );
        if (!pred) {
          return {
            trackIndex: intent.intendedTrackIndex,
            wouldCreateNew: false,
          };
        }
        return {
          trackIndex: pred.trackIndex,
          wouldCreateNew: pred.wouldCreateNew,
        };
      },
    });

    // Keyframe panel — mounts into the editor's left panel column so
    // the numeric editor lives next to the preview rather than on top
    // of it. Visible only when keyframes mode is on AND a keyframe is
    // selected. In `fullWidth` layout the panelLeft column is hidden,
    // so hosts who run that layout typically don't need this panel —
    // dragging the in-preview overlay handles is enough.
    this.keyframePanel = new KeyframePanel(this.panelLeft, editor, locale);
    // Keyframe overlay — frame border + scale handles on top of the
    // preview; drives drag-to-translate and corner-handle-to-scale
    // gestures via direct manipulation. Hidden when keyframes off.
    this.keyframeOverlay = new KeyframeOverlay(this.preview, editor);

    this.attachKeyboard(cb);
  }

  // ---- fullscreen -----------------------------------------------------

  isFullscreen(): boolean {
    return this.fullscreen;
  }

  toggleFullscreen(): void {
    this.setFullscreen(!this.fullscreen);
  }

  setFullscreen(on: boolean): void {
    if (on === this.fullscreen) return;
    this.fullscreen = on;
    this.root.classList.toggle("aicut-fullscreen", on);
    if (on) {
      this.onDocKeydown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.setFullscreen(false);
        }
      };
      document.addEventListener("keydown", this.onDocKeydown);
    } else if (this.onDocKeydown) {
      document.removeEventListener("keydown", this.onDocKeydown);
      this.onDocKeydown = null;
    }
  }

  get previewHost(): HTMLElement {
    return this.preview;
  }

  /** Host-extensible slot at the very left of the top toolbar. */
  get toolbarLeft(): HTMLElement {
    return this.toolbar.extrasLeft;
  }

  /** Host-extensible slot at the very right of the top toolbar. */
  get toolbarRight(): HTMLElement {
    return this.toolbar.extrasRight;
  }

  /** Public for e2e — read-back of timeline canvas state (no DOM clips). */
  getTimelineDebug(): ReturnType<Timeline["getDebugInfo"]> {
    return this.timeline.getDebugInfo();
  }

  /** Full sync from editor state. Idempotent. */
  render(): void {
    const project = this.editor.getProject();
    const time = this.editor.getTime();
    const duration = this.editor.getDuration();
    const selectedClipId = this.editor.getSelection();
    const pxPerSec = this.editor.getScale();
    const snap = this.editor.getSnap();

    const kfEnabled = this.editor.isKeyframesEnabled();
    const kfState = this.computeKeyframeToolbarState(
      project,
      selectedClipId,
      time,
      kfEnabled,
    );
    this.toolbar.render({
      canUndo: this.editor.canUndo(),
      canRedo: this.editor.canRedo(),
      canSplit: this.canSplitAt(time),
      canTrim: this.canTrimAt(time, selectedClipId),
      canSeekClipEdge: selectedClipId != null,
      clipEdgeNavEnabled: this.editor.isClipEdgeNavEnabled(),
      aspectEnabled: this.editor.isAspectEnabled(),
      aspect: this.editor.getAspect(),
      // Gate the toolbar "+ PiP" button on the master enable flag.
      // When PiP is disabled there's no point adding overlay clips
      // (they wouldn't paint), so the button stays hidden — same
      // semantics CapCut surfaces in its sidebar PiP toggle.
      pipToolbarAddEnabled:
        this.editor.isPictureInPictureToolbarAddEnabled() &&
        this.editor.isPictureInPictureEnabled(),
      snap,
      pxPerSec,
      ...kfState,
    });
    this.previewControls.render({
      playing: this.editor.isPlaying(),
      time,
      duration,
    });

    this.timeline.setProject(project);
    this.timeline.setTime(time);
    this.timeline.setScale(pxPerSec);
    this.timeline.setSelection(selectedClipId);
    this.timeline.setSnap(snap);
    this.timeline.setKeyframeState({
      enabled: this.editor.isKeyframesEnabled(),
      selected: this.editor.getSelectedKeyframe(),
    });
    this.keyframePanel.render();
  }

  /** Playback-fast path: nudge playhead + toolbar time label only. */
  onTimeTick(timeMs: Ms): void {
    this.timeline.setTime(timeMs);
    const selectedClipId = this.editor.getSelection();
    const kfEnabled = this.editor.isKeyframesEnabled();
    const kfState = this.computeKeyframeToolbarState(
      this.editor.getProject(),
      selectedClipId,
      timeMs,
      kfEnabled,
    );
    this.toolbar.render({
      canUndo: this.editor.canUndo(),
      canRedo: this.editor.canRedo(),
      canSplit: this.canSplitAt(timeMs),
      canTrim: this.canTrimAt(timeMs, selectedClipId),
      canSeekClipEdge: selectedClipId != null,
      clipEdgeNavEnabled: this.editor.isClipEdgeNavEnabled(),
      aspectEnabled: this.editor.isAspectEnabled(),
      aspect: this.editor.getAspect(),
      pipToolbarAddEnabled:
        this.editor.isPictureInPictureToolbarAddEnabled() &&
        this.editor.isPictureInPictureEnabled(),
      snap: this.editor.getSnap(),
      pxPerSec: this.editor.getScale(),
      ...kfState,
    });
    this.previewControls.render({
      playing: this.editor.isPlaying(),
      time: timeMs,
      duration: this.editor.getDuration(),
    });
  }

  setPreviewLayout(layout: PreviewLayout): void {
    this.root.setAttribute("data-preview-layout", layout);
  }

  setRulerMinTickPx(px: number): void {
    this.timeline.setRulerMinTickPx(px);
  }

  /** Update the preview card's aspect-ratio so its height auto-fits
   *  the chosen ratio. Called by Editor when the user picks a new
   *  aspect (or clears to "Original"). */
  setAspect(aspect: import("../types.js").AspectRatio | null): void {
    this.applyAspect(aspect);
  }

  private applyAspect(aspect: import("../types.js").AspectRatio | null): void {
    // "Original" (null) collapses to a sensible default — 16:9 is the
    // overwhelming majority of source material; if the host wants
    // something else they pick from the aspect chip.
    const ratio = aspect ?? "16:9";
    const [w, h] = ratio.split(":");
    this.root.style.setProperty("--aicut-preview-aspect", `${w} / ${h}`);
  }

  /** Explicit re-fit — Editor calls this when a brand-new project replaces the current one. */
  resetAutoFit(): void {
    this.timeline.refit();
  }

  setLocale(locale: Locale): void {
    this.toolbar.setLocale(locale);
    this.previewControls.setLocale(locale);
    this.fullscreenExitBtn.title = locale.exitFullscreenTitle;
    this.fullscreenExitBtn.textContent = locale.exitFullscreen;
    this.timeline.setLocale(locale);
    this.keyframePanel.setLocale(locale);
    this.render();
  }

  destroy(): void {
    if (this.onDocKeydown) {
      document.removeEventListener("keydown", this.onDocKeydown);
      this.onDocKeydown = null;
    }
    this.toolbar.destroy();
    this.previewControls.destroy();
    this.timeline.destroy();
    this.keyframePanel.destroy();
    this.keyframeOverlay.destroy();
    this.root.innerHTML = "";
    this.root.classList.remove("aicut-root", "aicut-fullscreen");
    this.root.removeAttribute("data-preview-layout");
  }

  // ---- helpers --------------------------------------------------------

  /** Walk the selected clip + playhead state to figure out (a) whether
   *  the keyframe button should be enabled, and (b) whether a keyframe
   *  already exists at the playhead's clip-local time (so the button
   *  swaps to "remove" mode). */
  private computeKeyframeToolbarState(
    project: { tracks: { clips: Clip[] }[] },
    selectedClipId: string | null,
    time: Ms,
    keyframesEnabled: boolean,
  ): { canKeyframe: boolean; hasKeyframeAtPlayhead: boolean; keyframesEnabled: boolean } {
    if (!keyframesEnabled || !selectedClipId) {
      return {
        canKeyframe: false,
        hasKeyframeAtPlayhead: false,
        keyframesEnabled,
      };
    }
    let clip: Clip | null = null;
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === selectedClipId);
      if (c) {
        clip = c;
        break;
      }
    }
    if (!clip) {
      return {
        canKeyframe: false,
        hasKeyframeAtPlayhead: false,
        keyframesEnabled,
      };
    }
    const localMs = time - clip.start;
    const duration = clipDuration(clip);
    if (localMs < 0 || localMs > duration) {
      return {
        canKeyframe: false,
        hasKeyframeAtPlayhead: false,
        keyframesEnabled,
      };
    }
    const roundedLocal = Math.round(localMs);
    const hasKf =
      clip.keyframes?.some((k) => k.time === roundedLocal) ?? false;
    return {
      canKeyframe: true,
      hasKeyframeAtPlayhead: hasKf,
      keyframesEnabled,
    };
  }

  private canSplitAt(timeMs: Ms): boolean {
    const project = this.editor.getProject();
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (timeMs > c.start && timeMs < c.start + clipDuration(c)) return true;
      }
    }
    return false;
  }

  private canTrimAt(timeMs: Ms, selectedClipId: string | null): boolean {
    const project = this.editor.getProject();
    if (selectedClipId) {
      const trk = findTrackOfClip(project, selectedClipId);
      const cl = trk?.clips.find((c: Clip) => c.id === selectedClipId);
      if (cl && timeMs > cl.start && timeMs < cl.start + clipDuration(cl)) {
        return true;
      }
    }
    for (const t of project.tracks) {
      const cl = findClipContaining(t, timeMs);
      if (cl) return true;
    }
    return false;
  }

  private attachKeyboard(cb: UICallbacks): void {
    this.root.tabIndex = 0;
    this.root.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        cb.onPlayToggle();
      } else if (e.code === "KeyK") {
        e.preventDefault();
        cb.onSplit();
      } else if (e.code === "KeyQ") {
        e.preventDefault();
        cb.onTrimLeft();
      } else if (e.code === "KeyW") {
        e.preventDefault();
        cb.onTrimRight();
      } else if (e.code === "KeyI" && this.editor.isClipEdgeNavEnabled()) {
        e.preventDefault();
        cb.onSeekClipStart();
      } else if (e.code === "KeyO" && this.editor.isClipEdgeNavEnabled()) {
        e.preventDefault();
        cb.onSeekClipEnd();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // Frame-stepping nav — matches Premiere / Final Cut / CapCut /
        // After Effects: ← / → = one frame, Shift+← / → = 10 frames.
        // Step size derived from Project.fps (defaults to 30 when
        // unset) so a 60 fps project nudges in half-frames relative
        // to a 30 fps one.
        e.preventDefault();
        const project = this.editor.getProject();
        const step = e.shiftKey ? bigFrameStepMs(project) : frameStepMs(project);
        const dir = e.code === "ArrowLeft" ? -1 : 1;
        const next = Math.max(
          0,
          Math.min(this.editor.getDuration(), this.editor.getTime() + dir * step),
        );
        cb.onSeek(next);
      } else if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) cb.onRedo();
        else cb.onUndo();
      } else if (e.code === "Delete" || e.code === "Backspace") {
        const sel = this.editor.getSelection();
        if (sel) {
          e.preventDefault();
          cb.onDeleteClip(sel);
        }
      }
    });
  }
}
