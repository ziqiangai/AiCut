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
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Editor,
  Timeline as CoreTimeline,
  type EditorApi,
  type EditorEventName,
  type HeadlessEditorOptions,
  type Locale,
  type Ms,
  type Project,
  type Theme,
} from "@aicut/core";

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

  const editor = useMemo<Editor | null>(() => {
    if (isAdoptMode) return (adopted as Editor | null) ?? null;
    const { defaultProject, children: _children, editor: _e, ...rest } =
      optsRef.current;
    return Editor.createHeadless({
      ...(rest as HeadlessEditorOptions),
      project: defaultProject,
    });
    // adopted flips exactly when the parent hands us a new instance —
    // rebuild the context so subscribers repoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adopted, isAdoptMode]);

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

  useEffect(() => {
    // Adopted editors are owned by the parent — do NOT destroy them
    // on unmount.
    if (isAdoptMode || !editor) return;
    return () => {
      editor.destroy();
    };
  }, [isAdoptMode, editor]);

  const value = useMemo<EditorContextValue | null>(
    () => (editor ? { editor } : null),
    [editor],
  );
  return (
    <EditorContext.Provider value={value}>
      {props.children}
    </EditorContext.Provider>
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

export function useEditorState<T>(
  selector: (editor: EditorApi) => T,
  events: EditorEventName[] = DEFAULT_EVENTS,
): T {
  const editor = useEditor();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const eventsKey = events.join(",");

  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = events.map((ev) => editor.on(ev, () => onChange()));
      return () => {
        for (const off of offs) off();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, eventsKey],
  );

  const getSnapshot = useCallback(
    () => selectorRef.current(editor),
    [editor],
  );

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
      onClick={() => editor.togglePlay()}
      style={style}
    >
      {children ?? (playing ? "⏸" : "▶")}
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
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-fullscreen ${className ?? ""}`.trim()}
      data-testid="aicut-fullscreen"
      onClick={() => editor.enterFullscreen()}
      style={style}
    >
      {children ?? "⛶"}
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
  const canUndo = useEditorState((e) => e.canUndo());
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-undo ${props.className ?? ""}`.trim()}
      data-testid="aicut-undo"
      disabled={props.disabled ?? !canUndo}
      onClick={() => editor.undo()}
      style={props.style}
    >
      {props.children ?? "↶"}
    </button>
  );
}

export function RedoButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  const canRedo = useEditorState((e) => e.canRedo());
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-redo ${props.className ?? ""}`.trim()}
      data-testid="aicut-redo"
      disabled={props.disabled ?? !canRedo}
      onClick={() => editor.redo()}
      style={props.style}
    >
      {props.children ?? "↷"}
    </button>
  );
}

export function SplitButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-split ${props.className ?? ""}`.trim()}
      data-testid="aicut-split"
      disabled={props.disabled}
      onClick={() => editor.split()}
      style={props.style}
    >
      {props.children ?? "✂"}
    </button>
  );
}

export function TrimLeftButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-trim-left ${props.className ?? ""}`.trim()}
      data-testid="aicut-trim-left"
      disabled={props.disabled}
      onClick={() => editor.trimLeft()}
      style={props.style}
    >
      {props.children ?? "]|"}
    </button>
  );
}

export function TrimRightButton(props: ActionProps): ReactElement {
  const editor = useEditor();
  return (
    <button
      type="button"
      className={`aicut-icon-btn aicut-trim-right ${props.className ?? ""}`.trim()}
      data-testid="aicut-trim-right"
      disabled={props.disabled}
      onClick={() => editor.trimRight()}
      style={props.style}
    >
      {props.children ?? "|["}
    </button>
  );
}

/** Snap toggle — reflects and drives `editor.getSnap()`. */
export function SnapToggle(props: ButtonProps): ReactElement {
  const editor = useEditor();
  const snap = useEditorState((e) => e.getSnap(), ["snapChange"]);
  return (
    <button
      type="button"
      className={`aicut-icon-btn ${snap ? "aicut-toggle-on" : ""} ${props.className ?? ""}`.trim()}
      data-testid="aicut-snap"
      onClick={() => editor.setSnap(!snap)}
      style={props.style}
    >
      {props.children ?? "⌘"}
    </button>
  );
}
