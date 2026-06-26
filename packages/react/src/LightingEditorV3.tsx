import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import {
  LightingEditorV3 as CoreLightingEditorV3,
  type LightingConfigV3,
  type LightingEditorV3Options,
  type LightingView,
} from "@aicut/core/lighting-v3";
import type { Theme } from "@aicut/core";

export interface LightingEditorV3Api {
  setConfig(partial: Partial<LightingConfigV3>): void;
  getConfig(): LightingConfigV3;
  setSubjectImage(url: string | null): void;
  setView(v: LightingView): void;
  getView(): LightingView;
  setBadge(text: string | number | null): void;
  setMode(mode: "light" | "dark"): void;
  getMode(): "light" | "dark";
  /** Convenience — restores config to safe defaults. */
  reset(): void;
}

export interface LightingEditorV3Props {
  /** Initial subject image (URL or data URI). Reactive — flipping
   *  the prop calls `setSubjectImage(url)` underneath. */
  subjectImageUrl?: string;
  /** Initial config. */
  defaultConfig?: Partial<LightingConfigV3>;
  /** Initial scene camera mode. Default "perspective". Reactive via
   *  `setView`. */
  defaultView?: LightingView;
  /** Theme tokens (CSS variables). Reactive. */
  theme?: Theme;
  /** Color scheme — `"light"` (default) or `"dark"`. Toggles the
   *  `data-aicut-mode` attribute on the root; the v3 stylesheet swaps
   *  card / chrome colors accordingly. Reactive. */
  mode?: "light" | "dark";
  /** Locale partial. Reactive — calls `editor.setLocale`. */
  locale?: LightingEditorV3Options["locale"];
  /** Optional "智能光源" chip title (top-left of the sphere area).
   *  Default = no chip. */
  title?: string;
  /** CTA copy at the bottom-right. Default "生成" / "Generate". */
  generateLabel?: string;
  /** Optional number / string badge painted to the right of the CTA.
   *  Reactive — also exposed imperatively via `apiRef.setBadge`. */
  generateBadge?: number | string;

  className?: string;
  style?: CSSProperties;
  apiRef?: Ref<LightingEditorV3Api | null>;

  onChange?: (cfg: LightingConfigV3) => void;
  onGenerate?: (cfg: LightingConfigV3) => void;
  onClose?: () => void;
  onViewChange?: (view: LightingView) => void;
  onReset?: () => void;
}

/**
 * React shell for the v3 lighting picker — Figma-driven redesign of
 * the v2 `LightingEditor` with:
 *
 *   - CSS soap-bubble sphere (instead of three.js wireframe)
 *   - In-sphere subject rotation (drives `setSubjectRotation` on the
 *     WebGL plane → natural camera tilt without CSS 3D fakery)
 *   - Per-property controls panel: brightness / color temp / 6-preset
 *     key-light grid / rotation / rim toggle
 *   - Bottom-right Generate CTA with optional number badge
 *   - Top-center "透视 / 正面" view toggle, bottom-left "↻ 重置"
 *
 * Pattern mirrors `LightingEditor` (v2) — same prop shape sans v2-only
 * features. Hosts can keep both wrappers in the same app and adopt v3
 * per-feature.
 */
export function LightingEditorV3(props: LightingEditorV3Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CoreLightingEditorV3 | null>(null);
  const [mounted, setMounted] = useState(false);

  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = CoreLightingEditorV3.create({
      container: host,
      subjectImageUrl: cbRef.current.subjectImageUrl,
      config: cbRef.current.defaultConfig,
      view: cbRef.current.defaultView,
      theme: cbRef.current.theme,
      mode: cbRef.current.mode,
      locale: cbRef.current.locale,
      title: cbRef.current.title,
      generateLabel: cbRef.current.generateLabel,
      generateBadge: cbRef.current.generateBadge,
      onChange: (cfg) => cbRef.current.onChange?.(cfg),
      onGenerate: (cfg) => cbRef.current.onGenerate?.(cfg),
      onClose: () => cbRef.current.onClose?.(),
      onViewChange: (v) => cbRef.current.onViewChange?.(v),
      onReset: () => cbRef.current.onReset?.(),
    });
    editorRef.current = editor;
    setMounted(true);
    return () => {
      editor.destroy();
      editorRef.current = null;
      setMounted(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.theme) editorRef.current?.setTheme(props.theme);
  }, [props.theme]);
  useEffect(() => {
    if (props.mode) editorRef.current?.setMode(props.mode);
  }, [props.mode]);
  useEffect(() => {
    editorRef.current?.setLocale(props.locale ?? {});
  }, [props.locale]);
  useEffect(() => {
    // null clears the badge; undefined would mean "no change", but
    // React props don't carry "undefined" meaningfully across renders,
    // so coerce undefined → null (= hide). Hosts that want stable
    // visibility just keep passing the same value each render.
    editorRef.current?.setBadge(props.generateBadge ?? null);
  }, [props.generateBadge]);
  useEffect(() => {
    if (props.subjectImageUrl !== undefined) {
      editorRef.current?.setSubjectImage(props.subjectImageUrl);
    }
  }, [props.subjectImageUrl]);

  useImperativeHandle<LightingEditorV3Api | null, LightingEditorV3Api | null>(
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
        setBadge: (t) => ed.setBadge(t),
        setMode: (m) => ed.setMode(m),
        getMode: () => ed.getMode(),
        reset: () => ed.reset(),
      };
    },
    // Same lifecycle dance the other wrappers do — re-key the factory
    // on `mounted` so apiRef.current isn't locked at null after the
    // initial render.
    [mounted],
  );

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={props.style}
      data-aicut-lighting-v3-host=""
    />
  );
}
