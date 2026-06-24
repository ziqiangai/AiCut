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
  LightingEditor as CoreLightingEditor,
  type LightingConfig,
  type LightingEditorOptions,
  type LightingView,
} from "@aicut/core/lighting";
import type { Theme } from "@aicut/core";

export interface LightingEditorApi {
  setConfig(partial: Partial<LightingConfig>): void;
  getConfig(): LightingConfig;
  setSubjectImage(url: string): void;
  setView(v: LightingView): void;
  getView(): LightingView;
  /** Convenience — restores config to safe defaults. */
  reset(): void;
}

export interface LightingEditorProps {
  /** Initial subject image (URL or data URI). Reactive. */
  subjectImageUrl?: string;
  /** Initial config. */
  defaultConfig?: Partial<LightingConfig>;
  /** Initial view. Default `"perspective"`. */
  defaultView?: LightingView;
  /** Theme — reactive (calls editor.setTheme). */
  theme?: Theme;
  /** Locale partial — reactive (calls editor.setLocale). */
  locale?: LightingEditorOptions["locale"];

  /**
   * Any React node — portaled into the editor's controls footer slot
   * (where the built-in Reset button used to live). Hosts put their
   * Reset / Generate / save-preset / etc. buttons here. Empty until
   * populated; the library renders nothing into the slot.
   */
  controlsFooter?: ReactNode;

  className?: string;
  style?: CSSProperties;
  apiRef?: Ref<LightingEditorApi | null>;

  onChange?: (cfg: LightingConfig) => void;
}

/**
 * React shell for the 3D lighting picker. Renders scene + controls;
 * the host owns everything else (smart panel beside, action buttons
 * in the controlsFooter slot, layout, theming the surrounding page).
 */
export function LightingEditor(props: LightingEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CoreLightingEditor | null>(null);
  // Hold the footer slot DOM node in state so the portal mounts after
  // editor creation. Same lifecycle dance VideoEditor does for its
  // toolbar slots.
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);

  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = CoreLightingEditor.create({
      container: host,
      subjectImageUrl: cbRef.current.subjectImageUrl,
      config: cbRef.current.defaultConfig,
      view: cbRef.current.defaultView,
      theme: cbRef.current.theme,
      locale: cbRef.current.locale,
      onChange: (cfg) => cbRef.current.onChange?.(cfg),
    });
    editorRef.current = editor;
    setFooterSlot(editor.controlsFooter);
    return () => {
      editor.destroy();
      editorRef.current = null;
      setFooterSlot(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.theme) editorRef.current?.setTheme(props.theme);
  }, [props.theme]);
  useEffect(() => {
    editorRef.current?.setLocale(props.locale ?? {});
  }, [props.locale]);
  useEffect(() => {
    if (props.subjectImageUrl)
      editorRef.current?.setSubjectImage(props.subjectImageUrl);
  }, [props.subjectImageUrl]);

  useImperativeHandle<LightingEditorApi | null, LightingEditorApi | null>(
    props.apiRef,
    () => {
      const ed = editorRef.current;
      if (!ed) return null;
      return {
        setConfig: (p) => ed.setConfig(p),
        getConfig: () => ed.getConfig(),
        setSubjectImage: (url) => ed.setSubjectImage(url),
        setView: (v) => ed.setView(v),
        getView: () => ed.getView(),
        reset: () => ed.reset(),
      };
    },
    // Keyed on footerSlot — same null-lock fix the VideoEditor uses.
    [footerSlot],
  );

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={props.style}
      data-aicut-lighting-host=""
    >
      {footerSlot && props.controlsFooter != null
        ? createPortal(props.controlsFooter, footerSlot)
        : null}
    </div>
  );
}
