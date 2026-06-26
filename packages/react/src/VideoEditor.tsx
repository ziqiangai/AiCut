import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  Editor,
  type AspectRatio,
  type EditorApi,
  type Locale,
  type Ms,
  type PlaybackEngineFactory,
  type Project,
  type Theme,
} from "@aicut/core";

export type VideoEditorApi = EditorApi;

export interface VideoEditorProps {
  /**
   * Initial project. Read once on mount — to swap projects after mount,
   * call `apiRef.current.setProject(...)` so React doesn't reinstantiate
   * the editor and lose playback state.
   */
  defaultProject?: Project;
  /** CSS variable overrides applied on mount and whenever this ref changes. */
  theme?: Theme;
  /**
   * UI string overrides (English default). Mirror prop — switching the
   * value calls `editor.setLocale` and the toolbar / canvas labels
   * update in place. Use `localeZh` from `@aicut/core` for Chinese.
   */
  locale?: Partial<Locale>;

  className?: string;
  style?: CSSProperties;

  /** Imperative handle for cut/seek/getProject/setProject/etc. */
  apiRef?: Ref<VideoEditorApi | null>;

  onReady?: (api: VideoEditorApi) => void;
  onChange?: (project: Project) => void;
  onExport?: (project: Project) => void;
  onTimeUpdate?: (timeMs: Ms) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSelectionChange?: (clipId: string | null) => void;
  onError?: (error: Error) => void;

  /**
   * Rendered into the very left of the editor's top toolbar — host
   * adds anything here (size dropdown, branding, status badge). The
   * library reserves no space for it; if you pass nothing, no
   * separator appears.
   */
  toolbarLeft?: ReactNode;
  /** Same as `toolbarLeft` but at the very right of the toolbar. */
  toolbarRight?: ReactNode;
  /**
   * Rendered into the LEFT side of an optional header bar above the
   * preview (project name, file menu, breadcrumbs). The header
   * collapses entirely when both header slots are empty, so the
   * default layout is identical to before this slot existed.
   */
  headerLeft?: ReactNode;
  /** Right side of the editor header — conventionally Share / Export / profile. */
  headerRight?: ReactNode;

  /**
   * Initial-only — picks the playback engine used by the underlying
   * core Editor. Defaults to the built-in `HtmlVideoEngine`. Pass a
   * factory to plug in a custom engine (WebCodecs, WebGL compositor,
   * IPC bridge to a native player, …). Swapping this prop after mount
   * has no effect — the editor binds its engine at construction.
   */
  playbackEngine?: PlaybackEngineFactory;
  /**
   * Initial-only — pixel height of each track row (default 56). Lower
   * values (~32–40) shrink the timeline for small viewports where the
   * default crowds out the preview. Applied process-wide; to re-apply
   * change this prop AND remount the component (e.g. via `key`).
   */
  trackHeight?: number;
  /** Initial-only — pixel height of the timeline ruler (default 24). */
  rulerHeight?: number;
  /**
   * Pixel height of the whole bottom timeline area (default 240).
   * Reactive — set anytime to change. The canvas inside fills 100%
   * and shows an internal scrollbar when track count overflows.
   * Useful range: [120, 480] depending on viewport.
   */
  timelineHeight?: number;
  /**
   * Per-clip keyframe animation (X / Y / Scale). Reactive — set
   * `{ enabled: true }` to surface keyframe diamonds on the timeline
   * and route the canvas-based engines through the transform pipeline.
   * Disabling hides the editing UI but preserves the data in
   * `Project.tracks[].clips[].keyframes`.
   *
   * `HtmlVideoEngine` cannot animate frames; swap to
   * `CanvasCompositorEngine` or `WebCodecsEngine` for live preview.
   */
  keyframes?: { enabled?: boolean };
  /** Fires when the user selects or deselects a keyframe diamond. */
  onKeyframeSelectionChange?: (
    target: { clipId: string; keyframeId: string } | null,
  ) => void;
  /**
   * Jump-to-clip-edge toolbar cluster (|◀ ▶|) + I/O keyboard shortcuts.
   * Reactive — set `{ enabled: true }` to surface the buttons next to
   * the keyframe diamond and bind the shortcuts. Off hides the buttons
   * entirely (display: none, no toolbar space cost) and lets I/O
   * fall through to the page.
   */
  clipEdgeNav?: { enabled?: boolean };
  /**
   * Dashed outline of the output canvas on top of the preview.
   * Defaults to `{ enabled: true }` — the frame is purely visual
   * (visualises the current aspect ratio / output dimensions) and is
   * useful even without keyframe editing. Set `{ enabled: false }`
   * for a clean preview. Independent of `keyframes`: when keyframes
   * mode is on, the frame body additionally becomes draggable (pan)
   * and grows corner scale handles.
   */
  previewFrame?: { enabled?: boolean };
  /**
   * Built-in aspect-ratio picker (CapCut-style 比例 dropdown). Reactive
   * — set `{ enabled: true }` to surface the chip at the left of the
   * toolbar. Off keeps today's chrome unchanged. Pair with
   * `onAspectChange` to drive the host's preview letterbox / export
   * defaults; the library does not letterbox by itself.
   */
  aspect?: { enabled?: boolean };
  /** Fires when the user picks an output aspect (or "Original" → null). */
  onAspectChange?: (aspect: AspectRatio | null) => void;
}

/**
 * Declarative React shell over `@aicut/core` `Editor`. Mounts the
 * editor instance once, mirrors prop changes (`theme`) into it, and
 * forwards events as React-style callbacks.
 *
 * Intentionally uncontrolled for project state — the editor owns the
 * current project. Use `onChange` to persist and `apiRef.setProject`
 * to restore.
 */
export function VideoEditor(props: VideoEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Toolbar slot DOM nodes don't exist until the editor mounts; we
  // hold them in state so React re-runs the render after mount and
  // the portals attach. Tracked separately for left + right because
  // each is independently controlled by host props.
  const [slots, setSlots] = useState<{
    left: HTMLElement;
    right: HTMLElement;
    headerLeft: HTMLElement;
    headerRight: HTMLElement;
  } | null>(null);

  // Latest-callback refs so the effect that creates the editor doesn't
  // re-run on every parent render just because props.onChange is a new
  // identity — the editor would otherwise be torn down constantly.
  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = Editor.create({
      container: host,
      project: cbRef.current.defaultProject,
      theme: cbRef.current.theme,
      locale: cbRef.current.locale,
      playbackEngine: cbRef.current.playbackEngine,
      ...(cbRef.current.trackHeight != null
        ? { trackHeight: cbRef.current.trackHeight }
        : {}),
      ...(cbRef.current.rulerHeight != null
        ? { rulerHeight: cbRef.current.rulerHeight }
        : {}),
      ...(cbRef.current.timelineHeight != null
        ? { timelineHeight: cbRef.current.timelineHeight }
        : {}),
      ...(cbRef.current.keyframes != null
        ? { keyframes: cbRef.current.keyframes }
        : {}),
      ...(cbRef.current.clipEdgeNav != null
        ? { clipEdgeNav: cbRef.current.clipEdgeNav }
        : {}),
      ...(cbRef.current.previewFrame != null
        ? { previewFrame: cbRef.current.previewFrame }
        : {}),
      ...(cbRef.current.aspect != null
        ? { aspect: cbRef.current.aspect }
        : {}),
    });
    editorRef.current = editor;
    setSlots({
      left: editor.toolbarLeft,
      right: editor.toolbarRight,
      headerLeft: editor.headerLeft,
      headerRight: editor.headerRight,
    });

    const offs = [
      editor.on("change", ({ project }) => cbRef.current.onChange?.(project)),
      editor.on("export", ({ project }) => cbRef.current.onExport?.(project)),
      editor.on("time", ({ timeMs }) => cbRef.current.onTimeUpdate?.(timeMs)),
      editor.on("play", () => cbRef.current.onPlay?.()),
      editor.on("pause", () => cbRef.current.onPause?.()),
      editor.on("selectionChange", ({ clipId }) =>
        cbRef.current.onSelectionChange?.(clipId),
      ),
      editor.on("keyframeSelectionChange", ({ target }) =>
        cbRef.current.onKeyframeSelectionChange?.(target),
      ),
      editor.on("aspectChange", ({ aspect }) =>
        cbRef.current.onAspectChange?.(aspect),
      ),
      editor.on("error", ({ error }) => cbRef.current.onError?.(error)),
    ];

    cbRef.current.onReady?.(editor);

    return () => {
      for (const off of offs) off();
      editor.destroy();
      editorRef.current = null;
      setSlots(null);
    };
    // Editor lifecycle is tied to mount; we deliberately don't list
    // any reactive deps. `theme` changes are pushed through the
    // separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.theme) editorRef.current?.setTheme(props.theme);
  }, [props.theme]);

  useEffect(() => {
    if (props.locale) editorRef.current?.setLocale(props.locale);
  }, [props.locale]);

  // Reactive — flipping `keyframes.enabled` instantly toggles diamond
  // visibility on the timeline and routes the canvas / WebCodecs
  // engines through the transform pipeline (or not). Data is
  // preserved either way.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const desired = props.keyframes?.enabled === true;
    if (editor.isKeyframesEnabled() !== desired) {
      editor.setKeyframesEnabled(desired);
    }
  }, [props.keyframes?.enabled]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const desired = props.clipEdgeNav?.enabled === true;
    if (editor.isClipEdgeNavEnabled() !== desired) {
      editor.setClipEdgeNavEnabled(desired);
    }
  }, [props.clipEdgeNav?.enabled]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Default true — only flip when host explicitly sets false.
    const desired = props.previewFrame?.enabled !== false;
    if (editor.isPreviewFrameEnabled() !== desired) {
      editor.setPreviewFrameEnabled(desired);
    }
  }, [props.previewFrame?.enabled]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const desired = props.aspect?.enabled === true;
    if (editor.isAspectEnabled() !== desired) {
      editor.setAspectEnabled(desired);
    }
  }, [props.aspect?.enabled]);

  // Reactive — the underlying CSS custom property can be updated on
  // the container any time; the timeline picks up the new height
  // immediately via CSS. No remount required.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (props.timelineHeight != null && props.timelineHeight > 0) {
      host.style.setProperty(
        "--aicut-timeline-height",
        `${Math.round(props.timelineHeight)}px`,
      );
    } else {
      host.style.removeProperty("--aicut-timeline-height");
    }
  }, [props.timelineHeight]);

  // Deps must include `slots`. Without it, the factory ran once during
  // the first commit — BEFORE the useEffect above had a chance to
  // create the editor — so `apiRef.current` was permanently locked to
  // null. `slots` flips from null to a real value the same instant
  // the editor is created, so it's the cleanest re-run trigger.
  useImperativeHandle<VideoEditorApi | null, VideoEditorApi | null>(
    props.apiRef,
    () => editorRef.current,
    [slots],
  );

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={props.style}
      data-aicut-host=""
    >
      {slots && props.toolbarLeft != null
        ? createPortal(props.toolbarLeft, slots.left)
        : null}
      {slots && props.toolbarRight != null
        ? createPortal(props.toolbarRight, slots.right)
        : null}
      {slots && props.headerLeft != null
        ? createPortal(props.headerLeft, slots.headerLeft)
        : null}
      {slots && props.headerRight != null
        ? createPortal(props.headerRight, slots.headerRight)
        : null}
    </div>
  );
}
