/**
 * Primitives — low-level, composable React components + hooks that a
 * host can arrange into any editor layout. The existing `<VideoEditor>`
 * shell is (conceptually) `<EditorProvider>` wrapping `<Preview>` +
 * `<Timeline>` + toolbar buttons in the 3-column layout. Hosts who
 * want a custom layout skip `<VideoEditor>` and drop the primitives
 * wherever they want.
 *
 * Shared state model: `<EditorProvider>` owns a HEADLESS `Editor`
 * instance in context; every primitive reads it via `useEditor()` (raw
 * API) or `useEditorState(selector)` (reactive slice). Nothing here
 * lives outside React — swap providers and the primitives repoint at
 * whichever editor is closest in the tree.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Editor,
  ICONS,
  Timeline as CoreTimeline,
  type EditorApi,
  type EditorEventName,
  type HeadlessEditorOptions,
  type IconName,
  type Locale,
  type Ms,
  type Project,
  type Theme,
} from "@aicut/core";

/**
 * Render one of the core-provided SVG icons. Kept as a plain span
 * with `dangerouslySetInnerHTML` because ICONS ships as strings (core
 * has no framework dependency). Icons inherit `currentColor` so the
 * surrounding button's `color` drives them.
 */
function Icon({ name }: { name: IconName }): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-flex", lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

// ---- Provider + hooks -----------------------------------------------------

interface EditorContextValue {
  editor: EditorApi & Editor;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export interface EditorProviderProps
  extends Omit<HeadlessEditorOptions, "project"> {
  /** Initial project. Swap after mount via `useEditor().setProject(...)`. */
  defaultProject?: Project;
  /** Optional locale — falls back to English. */
  locale?: Partial<Locale>;
  /** Optional theme tokens applied to every primitive's host div. */
  theme?: Theme;
  /**
   * Adopt an existing Editor instance instead of creating a headless
   * one. Used internally by `<VideoEditor>` so any primitive dropped
   * into its slots (headerLeft, panelRight, etc.) can subscribe to the
   * SAME editor via `useEditor()`. Ignored when `defaultProject` is
   * also present.
   */
  editor?: Editor | EditorApi;
  children: ReactNode;
}

/**
 * Root of every primitives composition. Creates a headless `Editor`
 * on mount, exposes it via React context, and destroys it on unmount.
 *
 * The provider itself renders NO DOM — hosts control layout entirely
 * with the child primitives (`<Preview>`, `<Timeline>`, button
 * components).
 */
export function EditorProvider(props: EditorProviderProps): ReactElement {
  // Refs to keep the latest prop values available to editor callbacks
  // without re-creating the editor on every render.
  const optsRef = useRef(props);
  optsRef.current = props;
  const adopted = props.editor ?? null;
  // "Adopt with no editor yet" — the parent (`<VideoEditor>`) declared
  // adoption via the `editor` prop but hasn't attached the instance
  // yet (first render, before useEffect creates it). Don't spin up a
  // stray headless editor; skip context entirely until the parent
  // supplies one.
  const isAdoptMode = "editor" in props;

  // Editor lives in state — not `useMemo` — because StrictMode fires
  // the effect cleanup + re-runs it on the first mount, and useMemo
  // wouldn't rebuild between the two. State + useEffect gives us a
  // reliable "destroy + recreate" pair that keeps engines and DOM
  // ownership consistent across dev-mode double invocation.
  const [editor, setEditor] = useState<Editor | null>(() =>
    isAdoptMode ? (adopted as Editor | null) : null,
  );

  useEffect(() => {
    if (isAdoptMode) {
      setEditor(adopted as Editor | null);
      return;
    }
    const {
      defaultProject,
      children: _children,
      editor: _e,
      ...rest
    } = optsRef.current;
    const e = Editor.createHeadless({
      ...(rest as HeadlessEditorOptions),
      project: defaultProject,
    });
    setEditor(e);
    return () => {
      e.destroy();
      setEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdoptMode, adopted]);

  // Reactive props → editor state (theme, locale). Skipped in adopt
  // mode — the parent already syncs these.
  useEffect(() => {
    if (isAdoptMode || !editor) return;
    if (props.theme) editor.setTheme(props.theme);
  }, [isAdoptMode, editor, props.theme]);

  useEffect(() => {
    if (isAdoptMode || !editor) return;
    if (props.locale) editor.setLocale(props.locale);
  }, [isAdoptMode, editor, props.locale]);

  const value = useMemo<EditorContextValue | null>(
    () => (editor ? { editor } : null),
    [editor],
  );

  // Theme tokens ride on a `display: contents` wrapper — a headless
  // editor has no `.aicut-root` container of its own, so setTheme
  // would otherwise be a no-op. CSS custom properties inherit through
  // `display: contents`, so every primitive underneath picks up the
  // `--aicut-controls-*` values transparently. Skipped in adopt mode
  // (the mounted `<VideoEditor>` already writes tokens to its own
  // container).
  const themeRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isAdoptMode) return;
    const el = themeRootRef.current;
    if (!el || !editor) return;
    editor.applyThemeTo(el, props.theme);
  }, [isAdoptMode, editor, props.theme]);

  // Wrapper identity must stay stable across the pre-/post-editor
  // renders — swapping between a Fragment and `<Context.Provider>`
  // would remount the entire child subtree, which for `<VideoEditor>`
  // means the `hostRef` div gets torn down the same tick
  // `Editor.create({ container: ref.current })` populated it.
  //
  // Always render `<EditorContext.Provider>`. `value` is null while
  // the editor is being constructed; primitives that call
  // `useEditor()` throw, but that only matters in headless mode where
  // we gate rendering below. In adopt mode the children rarely touch
  // `useEditor` before the mount effect finishes — portaled slot
  // content only fires after `<VideoEditor>` sets its `slots` state.
  const inner = (
    <EditorContext.Provider value={value}>
      {props.children}
    </EditorContext.Provider>
  );
  if (isAdoptMode) return inner;
  return (
    <div ref={themeRootRef} style={{ display: "contents" }} data-aicut-provider="">
      {editor ? inner : null}
    </div>
  );
}

/** Get the raw `EditorApi`. Throws when called outside `<EditorProvider>`. */
export function useEditor(): EditorApi {
  const ctx = useContext(EditorContext);
  if (!ctx) {
    throw new Error(
      "useEditor must be used inside <EditorProvider>. Wrap your composition.",
    );
  }
  return ctx.editor;
}

/**
 * Subscribe to a slice of editor state. Selector runs on every relevant
 * event; component re-renders only when the returned value's identity
 * changes (Object.is). Uses `useSyncExternalStore` under the hood so
 * concurrent-mode + StrictMode double-invocation are handled cleanly.
 *
 * Default event list is broad ("change" + "time" + "selectionChange").
 * Tune per selector if you know your slice only depends on a subset.
 */
const DEFAULT_EVENTS: EditorEventName[] = [
  "change",
  "time",
  "selectionChange",
  "play",
  "pause",
  "keyframeSelectionChange",
  "aspectChange",
  "keyframesEnabledChange",
  "previewLayoutChange",
];

/**
 * Subscribe to the editor's resolved `Locale` object. Re-renders when
 * `editor.setLocale(...)` fires — hosts can bind tooltips, labels, or
 * accessible names to locale strings without wiring the subscription
 * themselves.
 */
export function useLocale(): Locale {
  return useEditorState((e) => e.getLocale(), ["localeChange"]);
}

export function useEditorState<T>(
  selector: (editor: EditorApi) => T,
  events: EditorEventName[] = DEFAULT_EVENTS,
): T {
  const editor = useEditor();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const eventsKey = events.join(",");

  // Snapshot cache. React 19's `useSyncExternalStore` calls
  // `getSnapshot` on every render. The naive version
  // `() => selector(editor)` runs the selector fresh each call and
  // returns a NEW reference whenever the selector produces a fresh
  // object (e.g. `e => e.getProject()` → `JSON.parse` clone). React
  // sees the snapshot always changing → panics with
  //   "The result of getSnapshot should be cached to avoid an
  //    infinite loop"
  // and can enter a runaway rerender cycle.
  //
  // Fix: cache the snapshot in a ref, invalidate ONLY when a
  // subscribed editor event actually fires. During render, return
  // the stable cached reference. This preserves the intended
  // semantics — the component only re-renders on real state changes,
  // and selectors that build fresh objects are safe.
  interface Cache {
    hasValue: boolean;
    value: T;
    editor: EditorApi;
  }
  const cacheRef = useRef<Cache>({
    hasValue: false,
    value: undefined as unknown as T,
    editor,
  });

  const subscribe = useCallback(
    (onChange: () => void) => {
      const invalidateAndNotify = (): void => {
        // Mark stale so the next getSnapshot recomputes; then tell
        // React to re-render (which reads getSnapshot).
        cacheRef.current.hasValue = false;
        onChange();
      };
      const offs = events.map((ev) => editor.on(ev, invalidateAndNotify));
      return () => {
        for (const off of offs) off();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, eventsKey],
  );

  const getSnapshot = useCallback((): T => {
    const cache = cacheRef.current;
    // Adopt-mode: parent handed us a new editor. Old snapshot is
    // meaningless — invalidate.
    if (cache.editor !== editor) cache.hasValue = false;
    if (!cache.hasValue) {
      cache.value = selectorRef.current(editor);
      cache.hasValue = true;
      cache.editor = editor;
    }
    return cache.value;
  }, [editor]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- Preview --------------------------------------------------------------

export interface PreviewProps {
  className?: string;
  style?: CSSProperties;
  /** Host-supplied test id (default `aicut-preview`). */
  "data-testid"?: string;
}

/**
 * Playback surface — teleports the editor's `previewHost` (created by
 * `createHeadless`) into a host-supplied div. That div can live inside
 * any layout the user builds; we just move the DOM node.
 *
 * On unmount, the preview host returns to its detached parent so the
 * engine keeps painting silently (useful for keep-alive across route
 * switches). Destroying the editor via provider teardown fully cleans
 * up the engine.
 */
export function Preview({
  className,
  style,
  "data-testid": testId = "aicut-preview-slot",
}: PreviewProps): ReactElement {
  const editor = useEditor();
  const slotRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const host = editor.previewHost;
    // Detach from wherever it was (initial detached div OR previous slot).
    if (host.parentElement) host.parentElement.removeChild(host);
    slot.appendChild(host);
    return () => {
      // Move back to a detached "trash" wrapper on unmount — keeps the
      // engine alive for provider-level cleanup.
      const trash = document.createElement("div");
      if (host.parentElement === slot) slot.removeChild(host);
      trash.appendChild(host);
    };
  }, [editor]);

  return (
    <div
      ref={slotRef}
      data-testid={testId}
      className={className}
      style={{ position: "relative", ...style }}
    />
  );
}

// ---- Timeline (primitive — bound to shared editor) ------------------------

export interface TimelinePrimitiveProps {
  className?: string;
  style?: CSSProperties;
}

/**
 * Timeline primitive — spins up a `CoreTimeline` bound to the shared
 * editor's project, wires the standard callbacks so drags / scrubs /
 * splits propagate back through the API. Different from the standalone
 * `<Timeline>` export in that it doesn't accept a project prop —
 * everything flows through provider context.
 */
export function Timeline({
  className,
  style,
}: TimelinePrimitiveProps): ReactElement {
  const editor = useEditor();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<CoreTimeline | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const timeline = CoreTimeline.create({
      container: host,
      project: editor.getProject(),
      time: editor.getTime(),
      pxPerSec: editor.getScale(),
      selectedClipId: editor.getSelection(),
      snap: editor.getSnap(),
      keyframesEnabled: editor.isKeyframesEnabled(),
      selectedKeyframe: editor.getSelectedKeyframe(),
      onSeek: (t) => editor.seek(t),
      onSelectClip: (id) => editor.setSelection(id),
      onDeleteTrack: (id) => editor.removeTrack(id),
      onMoveClip: (id, opts) => editor.moveClip(id, opts),
      onResizeClip: (id, edits) => editor.resizeClip(id, edits),
      onScaleChange: (s) => editor.setScale(s),
      onSelectKeyframe: (target) => editor.setSelectedKeyframe(target),
      onMoveKeyframe: (clipId, keyframeId, timeMs) =>
        editor.moveKeyframe(clipId, keyframeId, timeMs),
    });
    timelineRef.current = timeline;

    const offs = [
      editor.on("change", ({ project }) => timeline.setProject(project)),
      editor.on("time", ({ timeMs }) => timeline.setTime(timeMs)),
      // Theme fanout — the canvas caches colours per paint, so a CSS
      // var flip on an ancestor doesn't invalidate it. Push the new
      // theme through `Timeline.setTheme`, which schedules a redraw.
      editor.on("themeChange", ({ theme }) => timeline.setTheme(theme)),
      editor.on("selectionChange", ({ clipId }) => timeline.setSelection(clipId)),
      editor.on("snapChange", ({ snap }) => timeline.setSnap(snap)),
      editor.on("keyframeSelectionChange", ({ target }) =>
        timeline.setKeyframeState({ selected: target }),
      ),
      editor.on("keyframesEnabledChange", ({ enabled }) =>
        timeline.setKeyframeState({ enabled }),
      ),
    ];

    return () => {
      for (const off of offs) off();
      timeline.destroy();
      timelineRef.current = null;
    };
  }, [editor]);

  return (
    <div
      ref={hostRef}
      className={`aicut-timeline ${className ?? ""}`.trim()}
      data-testid="aicut-timeline"
      style={{
        position: "relative",
        height: "var(--aicut-timeline-height, 240px)",
        ...style,
      }}
    />
  );
}

// ---- Playback buttons -----------------------------------------------------

export interface ButtonProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Test-id override for hosts that wire their own selectors. */
  "data-testid"?: string;
}

/** Play / pause toggle. Reads playing state via editor events. */
export function PlayButton({
  className,
  style,
  children,
  "data-testid": testId = "aicut-play",
}: ButtonProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  const playing = useEditorState(
    (e) => e.isPlaying(),
    ["play", "pause"],
  );
  return (
    <button
      type="button"
      className={`aicut-play-btn ${className ?? ""}`.trim()}
      data-testid={testId}
      data-state={playing ? "playing" : "paused"}
      title={locale.playPause}
      aria-label={locale.playPause}
      onClick={() => editor.togglePlay()}
      style={style}
    >
      {children ?? <Icon name={playing ? "pause" : "play"} />}
    </button>
  );
}

// ---- Time labels ----------------------------------------------------------

/** Format `ms` as `MM:SS` — utility exposed so hosts can build custom labels. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export interface TimeLabelProps {
  className?: string;
  style?: CSSProperties;
  format?: (ms: number) => string;
}

export function TimeLabel({
  className,
  style,
  format = formatClock,
}: TimeLabelProps): ReactElement {
  const timeMs = useEditorState(
    (e) => e.getTime(),
    ["time"],
  );
  return (
    <span
      className={`aicut-time-current ${className ?? ""}`.trim()}
      data-testid="aicut-time-current"
      style={style}
    >
      {format(timeMs)}
    </span>
  );
}

export function DurationLabel({
  className,
  style,
  format = formatClock,
}: TimeLabelProps): ReactElement {
  const duration = useEditorState(
    (e) => e.getDuration(),
    ["change"],
  );
  return (
    <span
      className={`aicut-time-total ${className ?? ""}`.trim()}
      data-testid="aicut-time-total"
      style={style}
    >
      {format(duration)}
    </span>
  );
}

// ---- Fullscreen button ---------------------------------------------------

export function FullscreenButton({
  className,
  style,
  children,
}: ButtonProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-fullscreen ${className ?? ""}`.trim()}
      data-testid="aicut-fullscreen"
      title={locale.fullscreen}
      aria-label={locale.fullscreen}
      onClick={() => editor.enterFullscreen()}
      style={style}
    >
      {children ?? <Icon name="fullscreen" />}
    </button>
  );
}

// ---- Toolbar action buttons ----------------------------------------------

interface ActionProps extends ButtonProps {
  /** Disabled state selector — defaults are provided per button. */
  disabled?: boolean;
}

export function UndoButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  const canUndo = useEditorState((e) => e.canUndo());
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-undo ${props.className ?? ""}`.trim()}
      data-testid="aicut-undo"
      title={locale.undo}
      aria-label={locale.undo}
      disabled={props.disabled ?? !canUndo}
      onClick={() => editor.undo()}
      style={props.style}
    >
      {props.children ?? <Icon name="undo" />}
    </button>
  );
}

export function RedoButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  const canRedo = useEditorState((e) => e.canRedo());
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-redo ${props.className ?? ""}`.trim()}
      data-testid="aicut-redo"
      title={locale.redo}
      aria-label={locale.redo}
      disabled={props.disabled ?? !canRedo}
      onClick={() => editor.redo()}
      style={props.style}
    >
      {props.children ?? <Icon name="redo" />}
    </button>
  );
}

export function SplitButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-split ${props.className ?? ""}`.trim()}
      data-testid="aicut-split"
      title={locale.split}
      aria-label={locale.split}
      disabled={props.disabled}
      onClick={() => editor.split()}
      style={props.style}
    >
      {props.children ?? <Icon name="split" />}
    </button>
  );
}

export function TrimLeftButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-trim-left ${props.className ?? ""}`.trim()}
      data-testid="aicut-trim-left"
      title={locale.trimLeft}
      aria-label={locale.trimLeft}
      disabled={props.disabled}
      onClick={() => editor.trimLeft()}
      style={props.style}
    >
      {props.children ?? <Icon name="trimLeft" />}
    </button>
  );
}

export function TrimRightButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-trim-right ${props.className ?? ""}`.trim()}
      data-testid="aicut-trim-right"
      title={locale.trimRight}
      aria-label={locale.trimRight}
      disabled={props.disabled}
      onClick={() => editor.trimRight()}
      style={props.style}
    >
      {props.children ?? <Icon name="trimRight" />}
    </button>
  );
}

/** Snap toggle — reflects and drives `editor.getSnap()`. */
export function SnapToggle(props: ButtonProps): ReactElement {
  const editor = useEditor();
  const locale = useLocale();
  const snap = useEditorState((e) => e.getSnap(), ["snapChange"]);
  const label = snap ? locale.snapOnTitle : locale.snapOffTitle;
  return (
    <button
      type="button"
      className={`aicut-icon-btn ${snap ? "aicut-toggle-on" : ""} ${props.className ?? ""}`.trim()}
      data-testid="aicut-snap"
      title={label}
      aria-label={label}
      onClick={() => editor.setSnap(!snap)}
      style={props.style}
    >
      {props.children ?? <Icon name="snap" />}
    </button>
  );
}
