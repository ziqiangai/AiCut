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
  Timeline as CoreTimeline,
  type Clip,
  type Locale,
  type Ms,
  type Project,
  type Theme,
  type TimelineOptions,
} from "@aicut/core";

/** Imperative handle exposed via `apiRef`. */
export interface TimelineApi {
  setProject(p: Project): void;
  getProject(): Project;
  setTime(t: Ms): void;
  getTime(): Ms;
  setScale(pxPerSec: number): void;
  getScale(): number;
  setSelection(id: string | null): void;
  getSelection(): string | null;
  setSnap(snap: boolean): void;
  fitToWindow(): void;
  setTheme(theme: Theme): void;
  getDebugInfo(): ReturnType<CoreTimeline["getDebugInfo"]>;
}

export interface TimelineProps {
  /** Initial project. Use `apiRef.current.setProject(...)` to swap. */
  defaultProject: Project;
  /** Initial scale (px/sec). Defaults to 80; auto-fits on first render. */
  defaultScale?: number;
  /** Initial playhead position. */
  defaultTime?: Ms;
  /** Initial selection. */
  defaultSelectedClipId?: string | null;

  /** Hide the left header column (compact / frame-picker mode). */
  showHeader?: boolean;
  /** Disable all editing interactions. */
  readOnly?: boolean;
  /** Snap to clip edges + playhead when dragging. Default true. */
  snap?: boolean;
  /** Apply fit-to-window on mount once duration is known. Default true. */
  autoFit?: boolean;
  /** UI string overrides (English default). */
  locale?: Partial<Locale>;
  /** Theme tokens. Reactive — flipping the object calls
   *  `timeline.setTheme(theme)` underneath. */
  theme?: Theme;
  /**
   * Render a 36px top toolbar strip with empty left/right flex slots
   * for host-supplied controls. Default false. Pair with `toolbarLeft`
   * / `toolbarRight` to inject content.
   */
  toolbar?: boolean;
  /** Rendered into the left slot of the timeline toolbar (toolbar must be true). */
  toolbarLeft?: ReactNode;
  /** Rendered into the right slot of the timeline toolbar. */
  toolbarRight?: ReactNode;

  className?: string;
  style?: CSSProperties;

  apiRef?: Ref<TimelineApi | null>;

  onSeek?: (timeMs: Ms) => void;
  onSelectClip?: (clipId: string | null) => void;
  onScaleChange?: (pxPerSec: number) => void;
  onMoveClip?: TimelineOptions["onMoveClip"];
  onResizeClip?: TimelineOptions["onResizeClip"];
  onChange?: (project: Project) => void;
}

/**
 * Standalone, framework-agnostic canvas Timeline wrapped for React.
 * Mount it without an `Editor` for use cases like a video frame-picker:
 *
 * ```tsx
 * <Timeline
 *   defaultProject={{ version: 1, sources: [video], tracks: [{ id, kind: "video", clips: [{...}] }] }}
 *   showHeader={false}
 *   readOnly
 *   onSeek={(ms) => setCurrentMs(ms)}
 * />
 * ```
 *
 * Uncontrolled for `project` and `pxPerSec` — the underlying Timeline
 * owns them and reports changes via callbacks. Call methods on
 * `apiRef.current` to drive it imperatively (mirroring ag-Grid /
 * VideoEditor patterns).
 */
export function Timeline(props: TimelineProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tlRef = useRef<CoreTimeline | null>(null);
  const [slots, setSlots] = useState<{
    left: HTMLElement;
    right: HTMLElement;
  } | null>(null);

  // Latest-callback ref so the create-once effect doesn't tear the
  // timeline down on every render just because callback identities
  // change.
  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tl = CoreTimeline.create({
      container: host,
      project: cbRef.current.defaultProject,
      pxPerSec: cbRef.current.defaultScale,
      time: cbRef.current.defaultTime,
      selectedClipId: cbRef.current.defaultSelectedClipId ?? null,
      showHeader: cbRef.current.showHeader,
      readOnly: cbRef.current.readOnly,
      snap: cbRef.current.snap,
      autoFit: cbRef.current.autoFit,
      locale: cbRef.current.locale,
      theme: cbRef.current.theme,
      toolbar: cbRef.current.toolbar,
      onSeek: (t) => cbRef.current.onSeek?.(t),
      onSelectClip: (id) => cbRef.current.onSelectClip?.(id),
      onScaleChange: (s) => cbRef.current.onScaleChange?.(s),
      onMoveClip: (id, opts) => cbRef.current.onMoveClip?.(id, opts),
      onResizeClip: (id, e) => cbRef.current.onResizeClip?.(id, e),
      onChange: (p) => cbRef.current.onChange?.(p),
    });
    tlRef.current = tl;
    if (tl.toolbarLeft && tl.toolbarRight) {
      setSlots({ left: tl.toolbarLeft, right: tl.toolbarRight });
    }
    return () => {
      tl.destroy();
      tlRef.current = null;
      setSlots(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.locale) tlRef.current?.setLocale(props.locale);
  }, [props.locale]);
  useEffect(() => {
    if (props.theme) tlRef.current?.setTheme(props.theme);
  }, [props.theme]);

  useImperativeHandle<TimelineApi | null, TimelineApi | null>(
    props.apiRef,
    () => {
      const tl = tlRef.current;
      if (!tl) return null;
      return {
        setProject: (p) => tl.setProject(p),
        getProject: () => tl.getProject(),
        setTime: (t) => tl.setTime(t),
        getTime: () => tl.getTime(),
        setScale: (s) => tl.setScale(s),
        getScale: () => tl.getScale(),
        setSelection: (id) => tl.setSelection(id),
        getSelection: () => tl.getSelection(),
        setSnap: (s) => tl.setSnap(s),
        fitToWindow: () => tl.fitToWindow(),
        setTheme: (t) => tl.setTheme(t),
        getDebugInfo: () => tl.getDebugInfo(),
      };
    },
    // Same caveat as VideoEditor.tsx — factory must re-run once the
    // timeline is created in useEffect, otherwise apiRef.current is
    // null forever. `slots` flips from null to a real value the
    // instant the timeline is ready, so it's the cleanest trigger.
    [slots],
  );

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={{ width: "100%", height: 240, ...props.style }}
      data-aicut-timeline-host=""
    >
      {slots && props.toolbarLeft != null
        ? createPortal(props.toolbarLeft, slots.left)
        : null}
      {slots && props.toolbarRight != null
        ? createPortal(props.toolbarRight, slots.right)
        : null}
    </div>
  );

  // Type-only re-export used to keep React/Vue prop typings in lockstep
  // with the core. Reference here so the symbol isn't tree-shaken.
  void ({} as Clip);
}
