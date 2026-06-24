import { EventBus } from "./events.js";
import { HistoryStack } from "./history.js";
import { createId } from "./ids.js";
import {
  clipDuration,
  clipEnd,
  createEmptyProject,
  findClipContaining,
  findTrackOfClip,
  normalizeProject,
  projectDuration,
  splitClipAt,
  trackEnd,
} from "./model.js";
import { wouldOverlap } from "./timeline/layout.js";
import { HtmlVideoEngine, type PlaybackEngine } from "./playback/index.js";
import { applyTheme } from "./theme.js";
import { type Locale, mergeLocale } from "./i18n.js";
import type {
  Clip,
  MediaSource,
  Ms,
  Project,
  Theme,
  Track,
} from "./types.js";
import { EditorUI } from "./ui/index.js";

export interface EditorOptions {
  /** Host element to mount the editor into. Will be wiped on init. */
  container: HTMLElement;
  /** Initial project state. Falls back to an empty single-track project. */
  project?: Project;
  /** CSS variable overrides. */
  theme?: Theme;
  /** Initial playhead position (ms). */
  initialTime?: Ms;
  /** Initial timeline zoom (pixels per second). Defaults to 80. */
  initialScale?: number;
  /** Initial snap toggle. Defaults to true. */
  initialSnap?: boolean;
  /**
   * UI string overrides. Falls back to English (`localeEn`) for any
   * keys not provided. Use `localeZh` as the value for full Chinese.
   * Call `editor.setLocale(...)` to switch at runtime.
   */
  locale?: Partial<Locale>;
}

export interface EditorEventMap {
  /** Emitted whenever the project mutates. */
  change: { project: Project };
  /** Playhead position update — driven by the playback tick loop. */
  time: { timeMs: Ms };
  play: void;
  pause: void;
  /** A source's metadata finished loading (duration etc). */
  ready: { sourceId: string | null };
  /** User clicked the Export button. Host decides what to do with the JSON. */
  export: { project: Project };
  error: { error: Error };
  /** Currently selected clip id, or null. */
  selectionChange: { clipId: string | null };
  /** Zoom (px/sec) changed. */
  scaleChange: { pxPerSec: number };
  /** Snap toggle changed. */
  snapChange: { snap: boolean };
  /** Undo/redo stack states changed (button enablement). */
  historyChange: { canUndo: boolean; canRedo: boolean };
}

export type EditorEventName = keyof EditorEventMap;

export interface EditorApi {
  // playback
  play(): void;
  pause(): void;
  togglePlay(): void;
  seek(timeMs: Ms): void;
  getTime(): Ms;
  getDuration(): Ms;
  isPlaying(): boolean;
  enterFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;

  // editing
  split(timeMs?: Ms): string[] | null;
  /** Alias of split, kept for back-compat. */
  cut(timeMs?: Ms): string[] | null;
  /** Trim the selected clip's left edge to the given time (or playhead). */
  trimLeft(timeMs?: Ms): boolean;
  /** Trim the selected clip's right edge to the given time (or playhead). */
  trimRight(timeMs?: Ms): boolean;
  removeClip(clipId: string): boolean;
  setClipSpeed(clipId: string, speed: number): boolean;
  previewMoveTarget(
    clipId: string,
    start: Ms,
    intendedTrackId?: string,
  ): { trackIndex: number; trackId: string; wouldCreateNew: boolean } | null;

  // tracks
  addTrack(kind: Track["kind"]): Track;
  removeTrack(trackId: string): boolean;
  moveClip(
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ): boolean;
  resizeClip(clipId: string, edits: Partial<Pick<Clip, "in" | "out" | "start">>): boolean;

  // sources & state
  addSource(source: MediaSource, opts?: { appendClip?: boolean }): MediaSource;
  setProject(project: Project): void;
  getProject(): Project;
  /** Replace the project with a brand-new empty one. */
  reset(): void;
  setTheme(theme: Theme): void;
  /**
   * Swap the UI locale at runtime. Partial overrides merge with the
   * English default. Triggers a re-render so the toolbar tooltips
   * and timeline canvas labels pick up the new strings immediately.
   */
  setLocale(locale: Partial<Locale>): void;
  /**
   * Fire the `export` event with the current project JSON. Hosts call
   * this from their own export button (built into their toolbarRight
   * slot, a keyboard shortcut, a menu item, etc.) to surface project
   * data to whatever pipeline they own. The library never invokes
   * this on its own — it has no UI for export.
   */
  requestExport(): void;

  // viewport
  getScale(): number;
  setScale(pxPerSec: number): void;
  getSnap(): boolean;
  setSnap(snap: boolean): void;

  // selection
  getSelection(): string | null;
  setSelection(clipId: string | null): void;

  // history
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;

  /**
   * Bookend slot at the very left of the top toolbar — host appends
   * its own controls (e.g. an aspect-ratio dropdown). Empty by default
   * and renders no separator until populated.
   */
  readonly toolbarLeft: HTMLElement;
  /** Right-side bookend slot — conventionally export / save / share. */
  readonly toolbarRight: HTMLElement;
  /**
   * Optional editor header above the preview. Host appends branding,
   * project name, file menu, etc. on the left and Share / Export /
   * profile / settings on the right. Layout is identical to today's
   * editor when both slots are empty — CSS collapses the bar.
   */
  readonly headerLeft: HTMLElement;
  /** Right-side header slot — conventionally Share / Export / etc. */
  readonly headerRight: HTMLElement;

  // events
  on<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): () => void;
  off<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): void;
  destroy(): void;
}

const DEFAULT_PX_PER_SEC = 80;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 400;
/** Snap distance in pixels at the current zoom. Converted to ms per call. */
const SNAP_PX = 8;

/**
 * Top-level editor instance — the only stateful object a host app
 * interacts with. Owns the project, the playback engine, the vanilla
 * DOM UI, plus viewport (zoom/snap), selection, and history state.
 *
 * Framework wrappers (`@aicut/react`, `@aicut/vue`) should mount a
 * container, instantiate this once, mirror prop changes (`theme`)
 * into it, and forward events as framework-native callbacks.
 */
export class Editor implements EditorApi {
  private container: HTMLElement;
  private project: Project;
  private engine: PlaybackEngine;
  private ui: EditorUI;
  private bus = new EventBus<EditorEventMap>();
  private history = new HistoryStack();

  private selectedClipId: string | null = null;
  private pxPerSec: number;
  private snap: boolean;
  private locale: Locale;
  private destroyed = false;

  constructor(opts: EditorOptions) {
    this.container = opts.container;
    this.project = normalizeProject(opts.project ?? createEmptyProject());
    this.pxPerSec = clampScale(opts.initialScale ?? DEFAULT_PX_PER_SEC);
    this.snap = opts.initialSnap !== false;
    this.locale = mergeLocale(opts.locale);

    applyTheme(this.container, opts.theme);

    this.ui = new EditorUI(this.container, this, {
      onPlayToggle: () => this.togglePlay(),
      onSplit: () => this.split(),
      onTrimLeft: () => this.trimLeft(),
      onTrimRight: () => this.trimRight(),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onReset: () => this.reset(),
      onFullscreen: () => this.ui.toggleFullscreen(),
      onSnapToggle: () => this.setSnap(!this.snap),
      onScaleChange: (s) => this.setScale(s),
      onSeek: (t) => this.seek(t),
      onSelectClip: (id) => this.setSelection(id),
      onDeleteClip: (id) => this.removeClip(id),
      onMoveClip: (id, opts) => this.moveClip(id, opts),
      onResizeClip: (id, edits) => this.resizeClip(id, edits),
    });

    this.engine = new HtmlVideoEngine({
      host: this.ui.previewHost,
      project: this.project,
    });
    this.engine.onTimeUpdate = (ms) => {
      this.bus.emit("time", { timeMs: ms });
      this.ui.onTimeTick(ms);
    };
    this.engine.onEnded = () => this.bus.emit("pause", undefined);
    this.engine.onError = (err) => this.bus.emit("error", { error: err });
    this.engine.onReady = () => this.bus.emit("ready", { sourceId: null });
    this.engine.onSourceMetadata = (sourceId, durMs) =>
      this.handleSourceMetadata(sourceId, durMs);

    if (opts.initialTime) this.engine.seek(opts.initialTime);
    this.ui.render();
  }

  static create(opts: EditorOptions): Editor {
    return new Editor(opts);
  }

  get toolbarLeft(): HTMLElement {
    return this.ui.toolbarLeft;
  }

  get toolbarRight(): HTMLElement {
    return this.ui.toolbarRight;
  }

  get headerLeft(): HTMLElement {
    return this.ui.headerLeft;
  }

  get headerRight(): HTMLElement {
    return this.ui.headerRight;
  }

  // ---- playback -------------------------------------------------------

  play(): void {
    this.engine.play();
    this.bus.emit("play", undefined);
    this.ui.render();
  }

  pause(): void {
    this.engine.pause();
    this.bus.emit("pause", undefined);
    this.ui.render();
  }

  togglePlay(): void {
    if (this.engine.isPlaying()) this.pause();
    else this.play();
  }

  seek(timeMs: Ms): void {
    this.engine.seek(timeMs);
    this.ui.render();
  }

  getTime(): Ms {
    // Engine may not exist yet during UI construction (we build UI
    // first to get its previewHost). Treat as 0 in that case.
    return this.engine?.getTime() ?? 0;
  }

  getDuration(): Ms {
    return projectDuration(this.project);
  }

  isPlaying(): boolean {
    return this.engine?.isPlaying() ?? false;
  }

  /**
   * In-tab "fullscreen" — covers the browser viewport via fixed
   * positioning, NOT the OS Fullscreen API. This is what the reference
   * UI calls "全屏预览": the user stays in their tab, no browser
   * permission prompt, ESC exits. Browser fullscreen would also work
   * but is heavier UX and gets blocked in iframes.
   */
  async enterFullscreen(): Promise<void> {
    this.ui.setFullscreen(true);
  }

  async exitFullscreen(): Promise<void> {
    this.ui.setFullscreen(false);
  }

  isFullscreen(): boolean {
    return this.ui.isFullscreen();
  }

  // ---- editing --------------------------------------------------------

  /**
   * Split the clip at `timeMs` (or playhead). Returns the two new clip ids
   * or null if there's no clip to split at that time.
   */
  split(timeMs?: Ms): string[] | null {
    const t = timeMs ?? this.engine.getTime();
    // Pick the track of the currently selected clip, else the first
    // video track that has a clip at this time.
    let target: { track: Track; clip: Clip } | null = null;
    if (this.selectedClipId) {
      const trk = findTrackOfClip(this.project, this.selectedClipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedClipId) ?? null;
      if (trk && cl && t > cl.start && t < clipEnd(cl)) target = { track: trk, clip: cl };
    }
    if (!target) {
      for (const trk of this.project.tracks) {
        const cl = findClipContaining(trk, t);
        if (cl && t > cl.start && t < clipEnd(cl)) {
          target = { track: trk, clip: cl };
          break;
        }
      }
    }
    if (!target) return null;
    const split = splitClipAt(target.clip, t - target.clip.start);
    if (!split) return null;
    this.pushHistory();
    const [left, right] = split;
    target.track.clips = target.track.clips
      .filter((c) => c.id !== target!.clip.id)
      .concat(left, right)
      .sort((a, b) => a.start - b.start);
    this.afterMutation();
    return [left.id, right.id];
  }

  cut(timeMs?: Ms): string[] | null {
    return this.split(timeMs);
  }

  trimLeft(timeMs?: Ms): boolean {
    const t = timeMs ?? this.engine.getTime();
    const target = this.resolveTrimTarget(t);
    if (!target) return false;
    const { clip } = target;
    const delta = t - clip.start;
    if (delta <= 0 || delta >= clipDuration(clip)) return false;
    this.pushHistory();
    const oldStart = clip.start;
    clip.in += delta;
    clip.start += delta;

    // Ripple-close the gap [oldStart, oldStart + delta] when it isn't
    // covered by any clip on any other track. The user's mental model:
    // "trim away the lead-in and tighten the timeline" — but only if
    // we're not stranding material on a parallel track that was lining
    // up with the trimmed region.
    const gapStart = oldStart;
    const gapEnd = clip.start;
    let covered = false;
    outer: for (const trk of this.project.tracks) {
      for (const c of trk.clips) {
        if (c.id === clip.id) continue;
        const cEnd = c.start + clipDuration(c);
        if (c.start < gapEnd && cEnd > gapStart) {
          covered = true;
          break outer;
        }
      }
    }
    if (!covered) {
      clip.start = gapStart;
      for (const trk of this.project.tracks) {
        for (const c of trk.clips) {
          if (c.id === clip.id) continue;
          if (c.start >= gapEnd) c.start -= delta;
        }
        trk.clips.sort((a, b) => a.start - b.start);
      }
    }

    this.afterMutation();
    return true;
  }

  trimRight(timeMs?: Ms): boolean {
    const t = timeMs ?? this.engine.getTime();
    const target = this.resolveTrimTarget(t);
    if (!target) return false;
    const { clip } = target;
    const delta = clipEnd(clip) - t;
    if (delta <= 0 || delta >= clipDuration(clip)) return false;
    this.pushHistory();
    clip.out -= delta;
    this.afterMutation();
    return true;
  }

  removeClip(clipId: string): boolean {
    let removed = false;
    const before = JSON.stringify(this.project);
    for (const t of this.project.tracks) {
      const len = t.clips.length;
      t.clips = t.clips.filter((c) => c.id !== clipId);
      if (t.clips.length !== len) removed = true;
    }
    if (!removed) return false;
    // Restore previous state in `history` keyed off the pre-mutation
    // snapshot for accurate undo.
    this.history.push(JSON.parse(before) as Project);
    if (this.selectedClipId === clipId) {
      this.selectedClipId = null;
      this.bus.emit("selectionChange", { clipId: null });
    }
    this.afterMutation();
    return true;
  }

  setClipSpeed(clipId: string, speed: number): boolean {
    if (!Number.isFinite(speed) || speed <= 0) return false;
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    this.pushHistory();
    cl.speed = speed === 1 ? undefined : speed;
    this.afterMutation();
    return true;
  }

  // ---- tracks ---------------------------------------------------------

  addTrack(kind: Track["kind"]): Track {
    this.pushHistory();
    const t: Track = { id: createId("track"), kind, clips: [] };
    this.project.tracks.push(t);
    this.afterMutation();
    return t;
  }

  removeTrack(trackId: string): boolean {
    const idx = this.project.tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return false;
    this.pushHistory();
    this.project.tracks.splice(idx, 1);
    this.afterMutation();
    return true;
  }

  /**
   * Pure prediction of where a `moveClip(...)` would land — same smart
   * routing as the real move (intended → source → other → new track),
   * just no mutation, no history. Lets the Timeline preview the
   * ACTUAL outcome of a drop so the ghost stops lying about new
   * tracks that won't get created.
   */
  previewMoveTarget(
    clipId: string,
    start: Ms,
    intendedTrackId?: string,
  ): { trackIndex: number; trackId: string; wouldCreateNew: boolean } | null {
    const fromTrack = findTrackOfClip(this.project, clipId);
    const clip = fromTrack?.clips.find((c) => c.id === clipId);
    if (!fromTrack || !clip) return null;
    const nextStart = Math.max(0, start);
    const nextEnd = nextStart + clipDuration(clip);
    const intended = intendedTrackId
      ? this.project.tracks.find((t) => t.id === intendedTrackId)
      : fromTrack;
    const candidates: Track[] = [];
    const seen = new Set<string>();
    const push = (t: Track | undefined) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      candidates.push(t);
    };
    push(intended);
    push(fromTrack);
    for (const t of this.project.tracks) {
      if (t.kind === fromTrack.kind) push(t);
    }
    for (const c of candidates) {
      if (!wouldOverlap(c, clipId, nextStart, nextEnd)) {
        const idx = this.project.tracks.indexOf(c);
        return { trackIndex: idx, trackId: c.id, wouldCreateNew: false };
      }
    }
    // No fit → preview a brand-new track appended at the end.
    return {
      trackIndex: this.project.tracks.length,
      trackId: "",
      wouldCreateNew: true,
    };
  }

  moveClip(
    clipId: string,
    opts: { start?: Ms; trackId?: string; newTrack?: boolean },
  ): boolean {
    const fromTrack = findTrackOfClip(this.project, clipId);
    const clip = fromTrack?.clips.find((c) => c.id === clipId);
    if (!fromTrack || !clip) return false;
    const nextStart = Math.max(0, opts.start ?? clip.start);
    const nextEnd = nextStart + clipDuration(clip);

    // Explicit "new track" intent from the UI's phantom-row drop —
    // bypass smart routing entirely, append a fresh track, move there.
    if (opts.newTrack) {
      this.pushHistory();
      const created = this.appendTrack({ kind: fromTrack.kind });
      clip.start = nextStart;
      fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
      created.clips.push(clip);
      if (
        fromTrack.clips.length === 0 &&
        this.project.tracks.filter((t) => t.kind === fromTrack.kind).length > 1
      ) {
        this.project.tracks = this.project.tracks.filter(
          (t) => t.id !== fromTrack.id,
        );
      }
      this.afterMutation();
      return true;
    }

    const intended = opts.trackId
      ? this.project.tracks.find((t) => t.id === opts.trackId)
      : fromTrack;
    if (!intended) return false;

    this.pushHistory();

    // Smart routing — prefer in priority:
    //   1. intended track (user's hover target)
    //   2. the source track (because vacating it for a brand-new track
    //      would be wasteful when there's room on the original row)
    //   3. any other existing track of the same kind
    //   4. as a last resort, a freshly-appended track
    //
    // `wouldOverlap` excludes the dragged clip itself, so the source
    // track always has room for it back where it started (the user
    // can effectively cancel a cross-track drag by hovering somewhere
    // crowded — we drop back onto source).
    const candidates: Track[] = [];
    const seen = new Set<string>();
    const push = (t: Track | undefined) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      candidates.push(t);
    };
    push(intended);
    push(fromTrack);
    for (const t of this.project.tracks) {
      if (t.kind === fromTrack.kind) push(t);
    }

    let targetTrack: Track | null = null;
    for (const c of candidates) {
      if (!wouldOverlap(c, clipId, nextStart, nextEnd)) {
        targetTrack = c;
        break;
      }
    }
    if (!targetTrack) {
      targetTrack = this.appendTrack({ kind: fromTrack.kind });
    }

    // Apply the move.
    clip.start = nextStart;
    if (targetTrack !== fromTrack) {
      fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
      targetTrack.clips.push(clip);
    }
    targetTrack.clips.sort((a, b) => a.start - b.start);

    // Auto-prune: if the source track is now empty AND it isn't the
    // only track of its kind, drop it. Keeps the UI compact when the
    // user is shuffling clips around — without this the track count
    // monotonically grows.
    if (
      fromTrack !== targetTrack &&
      fromTrack.clips.length === 0 &&
      this.project.tracks.filter((t) => t.kind === fromTrack.kind).length > 1
    ) {
      this.project.tracks = this.project.tracks.filter(
        (t) => t.id !== fromTrack.id,
      );
    }

    this.afterMutation();
    return true;
  }

  resizeClip(
    clipId: string,
    edits: Partial<Pick<Clip, "in" | "out" | "start">>,
  ): boolean {
    const trk = findTrackOfClip(this.project, clipId);
    const cl = trk?.clips.find((c) => c.id === clipId);
    if (!trk || !cl) return false;
    const next: Clip = { ...cl, ...edits };
    if (next.out <= next.in) return false;
    if (next.start < 0) return false;
    this.pushHistory();
    Object.assign(cl, next);
    trk.clips.sort((a, b) => a.start - b.start);
    this.afterMutation();
    return true;
  }

  addSource(
    source: MediaSource,
    opts: { appendClip?: boolean } = {},
  ): MediaSource {
    const src: MediaSource = { ...source, id: source.id || createId("src") };
    this.pushHistory();
    this.project.sources.push(src);
    const append = opts.appendClip !== false;
    if (append && src.kind === "video") {
      const track =
        this.project.tracks.find((t) => t.kind === "video") ??
        this.appendTrack({ kind: "video" });
      const start = trackEnd(track);
      track.clips.push({
        id: createId("clip"),
        sourceId: src.id,
        in: 0,
        out: src.duration ?? 0,
        start,
      });
    }
    this.afterMutation();
    return src;
  }

  // ---- project --------------------------------------------------------

  setProject(project: Project): void {
    this.pushHistory();
    this.project = normalizeProject(project);
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    // Re-fit on project swap — the new project's duration is likely
    // different so the previous scale is meaningless.
    this.ui.resetAutoFit();
    this.ui.render();
  }

  getProject(): Project {
    return JSON.parse(JSON.stringify(this.project)) as Project;
  }

  /**
   * Restore the "fresh import" state: same media library, single
   * default video track, one full-length clip per video source laid
   * end-to-end. This mirrors the initial layout a host would get
   * after dropping their videos in, so "reset" feels like "start
   * over without re-importing" rather than "wipe everything".
   *
   * Goes through the regular history stack — ⌘Z brings the previous
   * edit back. Sources without a known duration are skipped (they'd
   * render as zero-width clips, which is worse than absent).
   */
  reset(): void {
    const sources = this.project.sources.map((s) => ({ ...s }));
    const trackId = createId("track");
    const clips: Clip[] = [];
    let start = 0;
    for (const src of sources) {
      if (src.kind !== "video") continue;
      const dur = src.duration;
      if (!dur || dur <= 0) continue;
      clips.push({
        id: createId("clip"),
        sourceId: src.id,
        in: 0,
        out: dur,
        start,
      });
      start += dur;
    }
    this.setProject({
      version: 1,
      sources,
      tracks: [{ id: trackId, kind: "video", clips }],
    });
  }

  setTheme(theme: Theme): void {
    applyTheme(this.container, theme);
    // The timeline canvas reads CSS vars at paint time and bakes them
    // into pixels — it has no way to know the vars just changed.
    // Without this re-render, the chrome (toolbar/headers) flips
    // immediately via CSS but the canvas keeps its last colours until
    // the next interaction (wheel, click, etc.). Force a repaint now.
    this.ui.render();
  }

  setLocale(locale: Partial<Locale>): void {
    this.locale = mergeLocale(locale);
    this.ui.setLocale(this.locale);
  }

  /** Internal — UI reads the resolved locale here on each render. */
  getLocale(): Locale {
    return this.locale;
  }

  requestExport(): void {
    this.bus.emit("export", { project: this.getProject() });
  }

  // ---- viewport -------------------------------------------------------

  getScale(): number {
    return this.pxPerSec;
  }

  setScale(pxPerSec: number): void {
    const next = clampScale(pxPerSec);
    if (next === this.pxPerSec) return;
    this.pxPerSec = next;
    this.bus.emit("scaleChange", { pxPerSec: next });
    this.ui.render();
  }

  getSnap(): boolean {
    return this.snap;
  }

  setSnap(snap: boolean): void {
    if (snap === this.snap) return;
    this.snap = snap;
    this.bus.emit("snapChange", { snap });
    this.ui.render();
  }

  /** Snap a candidate ms to the nearest snappable surface within SNAP_PX. */
  snapMs(timeMs: Ms, ignoreClipId?: string | null): Ms {
    if (!this.snap) return timeMs;
    const snapTol = Math.max(20, (SNAP_PX / this.pxPerSec) * 1000);
    const targets: Ms[] = [0, this.engine.getTime()];
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.id === ignoreClipId) continue;
        targets.push(c.start, clipEnd(c));
      }
    }
    let best: Ms = timeMs;
    let bestDist = snapTol;
    for (const t of targets) {
      const d = Math.abs(t - timeMs);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  // ---- selection ------------------------------------------------------

  getSelection(): string | null {
    return this.selectedClipId;
  }

  setSelection(clipId: string | null): void {
    if (clipId === this.selectedClipId) return;
    this.selectedClipId = clipId;
    this.bus.emit("selectionChange", { clipId });
    this.ui.render();
  }

  // ---- history --------------------------------------------------------

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  undo(): boolean {
    const prev = this.history.undo(this.project);
    if (!prev) return false;
    this.project = prev;
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    this.ui.render();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.project);
    if (!next) return false;
    this.project = next;
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.emitHistory();
    this.ui.render();
    return true;
  }

  // ---- events ---------------------------------------------------------

  on<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): () => void {
    return this.bus.on(event, handler);
  }

  off<K extends EditorEventName>(
    event: K,
    handler: (payload: EditorEventMap[K]) => void,
  ): void {
    this.bus.off(event, handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.destroy();
    this.ui.destroy();
    this.bus.clear();
    this.history.clear();
  }

  // ---- internals ------------------------------------------------------

  private appendTrack(opts: { kind: Track["kind"] }): Track {
    const t: Track = { id: createId("track"), kind: opts.kind, clips: [] };
    this.project.tracks.push(t);
    return t;
  }

  private resolveTrimTarget(
    timeMs: Ms,
  ): { track: Track; clip: Clip } | null {
    if (this.selectedClipId) {
      const trk = findTrackOfClip(this.project, this.selectedClipId);
      const cl = trk?.clips.find((c) => c.id === this.selectedClipId);
      if (trk && cl && timeMs >= cl.start && timeMs <= clipEnd(cl)) {
        return { track: trk, clip: cl };
      }
    }
    for (const trk of this.project.tracks) {
      const cl = findClipContaining(trk, timeMs);
      if (cl) return { track: trk, clip: cl };
    }
    return null;
  }

  private pushHistory(): void {
    this.history.push(this.project);
    this.emitHistory();
  }

  private emitHistory(): void {
    this.bus.emit("historyChange", {
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    });
  }

  private afterMutation(): void {
    this.engine.setProject(this.project);
    this.bus.emit("change", { project: this.getProject() });
    this.ui.render();
  }

  private handleSourceMetadata(sourceId: string, durMs: Ms): void {
    const src = this.project.sources.find((s) => s.id === sourceId);
    let mutated = false;
    if (src && !src.duration) {
      src.duration = durMs;
      mutated = true;
    }
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.sourceId === sourceId && c.out === 0) {
          c.out = durMs;
          mutated = true;
        }
      }
    }
    this.bus.emit("ready", { sourceId });
    if (mutated) {
      // Source metadata patching is not a user action — don't pollute
      // the undo stack with it.
      this.engine.setProject(this.project);
      this.bus.emit("change", { project: this.getProject() });
      this.ui.render();
    }
  }
}

function clampScale(s: number): number {
  return Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, s));
}
