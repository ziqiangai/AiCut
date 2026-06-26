import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CanvasCompositorEngine,
  TRACK_HEIGHT,
  Timeline,
  VideoEditor,
  createEmptyProject,
  createId,
  htmlVideoEngineFactory,
  localeEn,
  localeZh,
  type Locale,
  type PlaybackEngineFactory,
  type Project,
  type Theme,
  type TimelineApi,
  type VideoEditorApi,
} from "@aicut/react";
import {
  WebCodecsEngine,
  isWebCodecsSupported,
} from "@aicut/react/webcodecs";
import { useToast } from "./Toast.js";
import { UploadPanel, type UploadResult } from "./UploadPanel.js";

/**
 * Two reference themes the demo cycles through. The library itself
 * ships only the dark default; light mode is host-driven — exactly
 * the surface a real consumer would use.
 */
const THEMES: Record<"dark" | "light", Theme> = {
  // Both themes set every relevant variable explicitly so flipping
  // back from light → dark actually overrides the prior values
  // (setTheme only writes the keys we pass — it never clears CSS vars).
  dark: {
    controlsBg: "#1f1f22",
    controlsBorder: "rgba(255, 255, 255, 0.08)",
    controlsText: "rgba(255, 255, 255, 0.85)",
    controlsHover: "rgba(255, 255, 255, 0.08)",
    controlsActive: "rgba(255, 255, 255, 0.12)",
    // Black letterbox reads as "this is film", which is right at home
    // under a dark studio chrome.
    previewBg: "#000",
  },
  light: {
    controlsBg: "#f6f6f8",
    controlsBorder: "rgba(0, 0, 0, 0.08)",
    controlsText: "rgba(0, 0, 0, 0.78)",
    controlsHover: "rgba(0, 0, 0, 0.06)",
    controlsActive: "rgba(0, 0, 0, 0.08)",
    // Soft neutral grey instead of slamming black on the user — keeps
    // the editor in the same visual register as the surrounding light
    // UI while still giving the video a slight letterbox.
    previewBg: "#e4e4e7",
  },
};

// Same-origin URLs served straight from `examples/react-demo/public/`
// by Vite at root path. Using same-origin paths matters for the
// WebCodecs engine: it uses fetch() under the hood, and fetch enforces
// CORS while <video> doesn't. Same-origin sidesteps the whole topic.
//
// The .mov files are gitignored — drop your own clips at
// examples/react-demo/public/{a,b}.mov to make the demo work locally.
const SRC_A = {
  id: createId("src"),
  url: "/a.mov",
  kind: "video" as const,
  name: "a.mov",
};
const SRC_B = {
  id: createId("src"),
  url: "/b.mov",
  kind: "video" as const,
  name: "b.mov",
};

function seed(): Project {
  // Two empty video tracks so multi-track layout is visible from
  // first paint; uploads land on the first empty one by default.
  // Preload via env var is local-dev convenience — when set, the
  // source lands here and the `ready`-event handler in onReady
  // creates the clip as soon as metadata resolves.
  const sources = PRELOAD_VIDEO_URL
    ? [
        {
          id: createId("src"),
          url: PRELOAD_VIDEO_URL,
          kind: "video" as const,
          name: PRELOAD_VIDEO_NAME,
        },
      ]
    : [];
  return {
    version: 1,
    sources,
    tracks: [
      { id: createId("track"), kind: "video", clips: [] },
      { id: createId("track"), kind: "video", clips: [] },
    ],
  };
}

const STORAGE_KEY = "aicut-demo-project";

/**
 * A separate, standalone Timeline driving a single-clip project — the
 * "frame picker" use case the host's other project needs. No editor,
 * no toolbar, no preview video; clicking the strip seeks and the host
 * displays the resulting timestamp.
 */
function FramePicker() {
  const [pickedMs, setPickedMs] = useState(0);
  const [posterMs, setPosterMs] = useState<number | null>(null);
  const pickerRef = useRef<TimelineApi | null>(null);
  const sourceId = useMemo(() => createId("fp-src"), []);
  const project = useMemo<Project>(
    () => ({
      version: 1,
      sources: [
        {
          id: sourceId,
          url: "/a.mov",
          kind: "video",
          name: "a.mov",
        },
      ],
      tracks: [
        {
          id: createId("fp-track"),
          kind: "video",
          // out: 0 is the convention for "patch from metadata"; the
          // Timeline currently expects a real duration so we set a
          // large guess that gets visually corrected once the host
          // calls setProject with the real value (via api.setProject
          // after probing). For demo, a 60s guess works.
          clips: [
            {
              id: createId("fp-clip"),
              sourceId,
              in: 0,
              out: 60_000,
              start: 0,
            },
          ],
        },
      ],
    }),
    [sourceId],
  );
  return (
    <div className="demo-framepicker">
      <h2>Frame picker (standalone Timeline)</h2>
      <Timeline
        apiRef={pickerRef}
        defaultProject={project}
        showHeader={false}
        readOnly
        snap={false}
        autoFit
        toolbar
        toolbarLeft={
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Picked at {(pickedMs / 1000).toFixed(2)}s
          </span>
        }
        toolbarRight={
          <button
            type="button"
            data-testid="demo-fp-poster"
            className="demo-slot-btn"
            onClick={() => setPosterMs(pickedMs)}
            style={demoSlotBtnStyle}
          >
            Use as poster
          </button>
        }
        style={{ height: 136 }}
        onSeek={(ms) => setPickedMs(ms)}
      />
      <div className="demo-state" data-testid="demo-framepicker-time">
        Picked: <code>{(pickedMs / 1000).toFixed(2)}s</code>
        {posterMs !== null ? (
          <>
            {" · "}Poster: <code>{(posterMs / 1000).toFixed(2)}s</code>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Settings popover for the export action. Floats below the "导出"
 * button. Click-outside / Esc dismisses (Cancel button does the same).
 * Confirm calls back into the parent which triggers `api.requestExport`
 * after stashing the latest output settings.
 */
type ExportAspectKey = "16:9" | "9:16" | "1:1" | "4:3";
function ExportPopover(props: {
  aspect: ExportAspectKey;
  resIdx: number;
  fps: number;
  resolutions: Record<
    ExportAspectKey,
    Array<{ label: string; width: number; height: number }>
  >;
  fpsOptions: number[];
  onChangeAspect: (a: ExportAspectKey) => void;
  onChangeResIdx: (i: number) => void;
  onChangeFps: (f: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Click-outside + Esc — same pattern as the keyframe panel dropdown.
  // rAF defers the listener so the same click that opened us doesn't
  // immediately close us via outside-click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onCancel();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
    };
    const handle = requestAnimationFrame(() => {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKeydown);
    });
    return () => {
      cancelAnimationFrame(handle);
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown);
    };
  }, [props]);
  const opts = props.resolutions[props.aspect];
  return (
    <div
      ref={ref}
      role="dialog"
      data-testid="demo-export-popover"
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        zIndex: 100,
        minWidth: 240,
        padding: 12,
        background: "var(--aicut-controls-bg, #1a1a1d)",
        border: "1px solid var(--aicut-controls-border, rgba(255,255,255,0.12))",
        borderRadius: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,0.32)",
        color: "var(--aicut-controls-text, rgba(255,255,255,0.92))",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>Export settings</div>
      <Row label="比例">
        <PopoverSelect
          testId="demo-export-aspect"
          value={props.aspect}
          options={(Object.keys(props.resolutions) as ExportAspectKey[]).map(
            (a) => ({ value: a, label: a }),
          )}
          onChange={(v) => props.onChangeAspect(v)}
        />
      </Row>
      <Row label="分辨率">
        <PopoverSelect
          testId="demo-export-resolution"
          value={props.resIdx}
          options={opts.map((r, i) => ({ value: i, label: r.label }))}
          onChange={(v) => props.onChangeResIdx(v)}
        />
      </Row>
      <Row label="帧率">
        <PopoverSelect
          testId="demo-export-fps"
          value={props.fps}
          options={props.fpsOptions.map((f) => ({
            value: f,
            label: `${f} fps`,
          }))}
          onChange={(v) => props.onChangeFps(v)}
        />
      </Row>
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 4,
        }}
      >
        <button
          type="button"
          onClick={props.onCancel}
          style={{
            ...demoSlotBtnStyle,
            background:
              "var(--aicut-controls-hover, rgba(255,255,255,0.06))",
          }}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="demo-export-confirm"
          onClick={props.onConfirm}
          style={{
            ...demoSlotBtnStyle,
            background: "var(--color-brand, #9a31f4)",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          确定
        </button>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ opacity: 0.72 }}>{props.label}</span>
      {props.children}
    </label>
  );
}

/**
 * Custom themed select — button trigger + floating menu. Native
 * <select> dropdowns are OS-painted (foreign font, no theme), which
 * looked off inside the export popover. This keeps the value type
 * generic so we can use it for strings (aspect) or numbers (resIdx,
 * fps) without coercion.
 *
 * Click-outside / Esc closes; selected item gets the brand color +
 * a CSS checkmark. Nests fine inside an outer popover because the
 * outer's "click-inside-me-doesn't-close" check still passes —
 * clicking on the trigger / menu items lands inside the OUTER ref.
 */
function PopoverSelect<T extends string | number>(props: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handle = requestAnimationFrame(() => {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
    });
    return () => {
      cancelAnimationFrame(handle);
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = props.options.find((o) => o.value === props.value);
  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-block", minWidth: 140 }}
      data-testid={props.testId}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          width: "100%",
          height: 28,
          padding: "0 26px 0 10px",
          textAlign: "left",
          background:
            "var(--aicut-controls-hover, rgba(255,255,255,0.06))",
          border:
            "1px solid " +
            (open
              ? "var(--color-brand, #9a31f4)"
              : "var(--aicut-controls-border, rgba(255,255,255,0.16))"),
          borderRadius: 6,
          color: "inherit",
          fontFamily: "inherit",
          fontSize: 12,
          cursor: "pointer",
          position: "relative",
          boxShadow: open ? "0 0 0 2px rgba(154, 49, 244,0.22)" : undefined,
          transition: "border-color 120ms ease-out, box-shadow 120ms ease-out",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
          }}
        >
          {current?.label ?? ""}
        </span>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 9,
            top: "50%",
            width: 0,
            height: 0,
            borderLeft: "4px solid transparent",
            borderRight: "4px solid transparent",
            borderTop: "5px solid currentColor",
            marginTop: -2,
            opacity: 0.75,
            transform: open ? "rotate(180deg)" : "none",
            transformOrigin: "50% 35%",
            color: open ? "var(--color-brand, #9a31f4)" : "currentColor",
            transition: "transform 120ms ease-out",
          }}
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "var(--aicut-controls-bg, #1a1a1d)",
            border:
              "1px solid var(--aicut-controls-border, rgba(255,255,255,0.16))",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
            zIndex: 200,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {props.options.map((opt) => {
            const selected = opt.value === props.value;
            return (
              <li
                key={String(opt.value)}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  props.onChange(opt.value);
                  setOpen(false);
                }}
                style={{
                  padding: "6px 10px 6px 24px",
                  position: "relative",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: selected
                    ? "var(--color-brand, #9a31f4)"
                    : "inherit",
                  background: "transparent",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "var(--aicut-controls-active, rgba(255,255,255,0.1))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {selected ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: 8,
                      top: "50%",
                      width: 4,
                      height: 8,
                      marginTop: -5,
                      borderRight: "2px solid currentColor",
                      borderBottom: "2px solid currentColor",
                      transform: "rotate(45deg)",
                    }}
                  />
                ) : null}
                {opt.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// Mirror .aicut-icon-btn chrome exactly — same height, radius, no
// border, background tints on hover. Using `appearance: none` on the
// <select> is required: macOS' native popup-button has a minimum
// height the browser enforces over CSS, which is the actual source
// of the "row got taller" perception. Stripping appearance lets our
// 32px height + 0 vertical padding stick.
const demoSlotBtnStyle: CSSProperties = {
  height: 32,
  padding: "0 12px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  boxSizing: "border-box",
};

const demoSlotSelectStyle: CSSProperties = {
  height: 32,
  padding: "0 22px 0 10px",
  borderRadius: 8,
  border: "none",
  background:
    "var(--aicut-controls-hover) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%23999' d='M0 0l5 6 5-6z'/></svg>\") no-repeat right 8px center",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  boxSizing: "border-box",
};

const demoSlotInputStyle: CSSProperties = {
  height: 28,
  padding: "0 8px",
  borderRadius: 8,
  border: "1px solid var(--aicut-controls-border)",
  background: "var(--aicut-controls-hover)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1,
  width: 60,
  boxSizing: "border-box",
};

interface ExportStatus {
  running: boolean;
  phase?: "encode" | "concat" | "done" | "error";
  overall?: number;
  clipIndex?: number;
  totalClips?: number;
  fileUrl?: string;
  error?: string;
}

/**
 * Compact live indicator that takes the timeline-toolbar's right
 * slot (where the "导出" button used to live). Renders empty when
 * idle, a brand-tinted progress pill while encoding/concatenating,
 * and an error chip if the last export failed. The full status
 * card with the file link is still in the sidebar; this is just
 * the at-a-glance progress so the user doesn't have to look away
 * from the timeline while waiting.
 */
function ExportStatusPill({ status }: { status: ExportStatus }) {
  if (status.running) {
    const pct = Math.round((status.overall ?? 0) * 100);
    const label =
      status.phase === "concat"
        ? `合并中 ${pct}%`
        : status.totalClips != null && status.clipIndex != null
          ? `编码 ${status.clipIndex + 1}/${status.totalClips} · ${pct}%`
          : `编码中 ${pct}%`;
    return (
      <span
        data-testid="demo-export-pill"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 24,
          padding: "0 10px",
          borderRadius: 12,
          fontSize: 11,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-brand, #9a31f4)",
          background: "rgba(154, 49, 244,0.10)",
          border: "1px solid rgba(154, 49, 244,0.32)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: 3,
            background: "var(--color-brand, #9a31f4)",
            animation: "aicut-pulse 1.2s ease-in-out infinite",
          }}
        />
        {label}
      </span>
    );
  }
  if (status.error) {
    return (
      <span
        data-testid="demo-export-pill-error"
        title={status.error}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 24,
          padding: "0 10px",
          borderRadius: 12,
          fontSize: 11,
          color: "#ff3b30",
          background: "rgba(255,59,48,0.10)",
          border: "1px solid rgba(255,59,48,0.32)",
          maxWidth: 280,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Export failed — {status.error}
      </span>
    );
  }
  return null;
}

/**
 * Backend URLs come from Vite env vars at build time. Empty string =
 * not configured. When the user picks a backend with an empty URL,
 * clicking export shows a toast hint instead of firing a request.
 *
 *   VITE_BACKEND_TS_URL   — TypeScript exporter
 *   VITE_BACKEND_GO_URL   — Go exporter
 *
 * Default for `pnpm dev` (no env file) is the local 8787 / 8788 so
 * the historical "just start the backends and click export" flow
 * keeps working. The GitHub Pages build sets both to empty, which is
 * intentional — the hosted demo can't talk to your localhost.
 */
const ENV_BACKEND_TS = (import.meta.env.VITE_BACKEND_TS_URL as string | undefined) ?? "http://127.0.0.1:8787";
const ENV_BACKEND_GO = (import.meta.env.VITE_BACKEND_GO_URL as string | undefined) ?? "http://127.0.0.1:8788";

const BACKENDS = {
  ts: { label: "TypeScript", url: ENV_BACKEND_TS },
  go: { label: "Go", url: ENV_BACKEND_GO },
} as const;

/** POST endpoint that accepts a multipart upload and returns
 *  `{ url }`. Null = no server upload, fall back to blob URLs. */
const UPLOAD_ENDPOINT =
  (import.meta.env.VITE_UPLOAD_ENDPOINT as string | undefined) || null;

/**
 * Local-dev convenience: if a video URL is set in the env, the demo
 * auto-seeds it as a clip on first mount so reloading the page
 * doesn't require dragging the file in again. CI / Pages builds
 * leave this unset and start empty.
 */
const PRELOAD_VIDEO_URL =
  (import.meta.env.VITE_PRELOAD_VIDEO_URL as string | undefined) || null;
const PRELOAD_VIDEO_NAME =
  (import.meta.env.VITE_PRELOAD_VIDEO_NAME as string | undefined) ||
  PRELOAD_VIDEO_URL?.split("/").pop() ||
  "sample.mp4";

export function App() {
  const apiRef = useRef<VideoEditorApi | null>(null);
  const toast = useToast();
  const [savedJson, setSavedJson] = useState("");
  const [exportJson, setExportJson] = useState("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [themeName, setThemeName] = useState<"dark" | "light">("dark");
  // Export popover state. The user opens it via the "导出" button,
  // picks aspect / resolution / fps, then Confirm posts. Mirrors how
  // real NLEs gate export behind a settings dialog so accidental
  // single-clicks don't kick off a 30-second encode at the wrong
  // dimensions. The keyframe-compilation branch on the backend is
  // ALSO gated on width+height, so silently exporting at "no dims"
  // would skip animation entirely — bug we just fixed.
  type ExportAspect = "16:9" | "9:16" | "1:1" | "4:3";
  const RESOLUTIONS: Record<
    ExportAspect,
    Array<{ label: string; width: number; height: number }>
  > = {
    "16:9": [
      { label: "480p (854×480)", width: 854, height: 480 },
      { label: "720p (1280×720)", width: 1280, height: 720 },
      { label: "1080p (1920×1080)", width: 1920, height: 1080 },
      { label: "1440p (2560×1440)", width: 2560, height: 1440 },
      { label: "4K (3840×2160)", width: 3840, height: 2160 },
    ],
    "9:16": [
      { label: "480p (480×854)", width: 480, height: 854 },
      { label: "720p (720×1280)", width: 720, height: 1280 },
      { label: "1080p (1080×1920)", width: 1080, height: 1920 },
    ],
    "1:1": [
      { label: "720×720", width: 720, height: 720 },
      { label: "1080×1080", width: 1080, height: 1080 },
      { label: "1440×1440", width: 1440, height: 1440 },
    ],
    "4:3": [
      { label: "480p (640×480)", width: 640, height: 480 },
      { label: "720p (1024×768)", width: 1024, height: 768 },
      { label: "1080p (1440×1080)", width: 1440, height: 1080 },
    ],
  };
  const FPS_OPTIONS = [24, 30, 60];
  const [exportPopoverOpen, setExportPopoverOpen] = useState(false);
  const [exportAspect, setExportAspect] = useState<ExportAspect>("16:9");
  // Index into RESOLUTIONS[exportAspect] — keep as index so changing
  // aspect can fall back to "same tier" (e.g. 1080p) without remembering
  // the old (w, h) tuple. Default to 1080p slot for 16:9.
  const [exportResIdx, setExportResIdx] = useState(2);
  const [exportFps, setExportFps] = useState(30);
  const [showToolbarLeft, setShowToolbarLeft] = useState(true);
  // Free-form text shown inside the `toolbarLeft` slot — proves the
  // slot still accepts any host content even though aspect is now
  // built into the editor. Demo only; not persisted.
  const [projectName, setProjectName] = useState("Untitled cut");
  const [showToolbarRight, setShowToolbarRight] = useState(true);
  const [showHeader, setShowHeader] = useState(true);
  const [backendKind, setBackendKind] = useState<"ts" | "go">("ts");
  const [localeName, setLocaleName] = useState<"en" | "zh">("en");
  const locale: Locale = useMemo(
    () => (localeName === "zh" ? localeZh : localeEn),
    [localeName],
  );
  // Demo of the new pluggable playback engine — flip between the
  // built-in HTML5 engine, a host-supplied Canvas compositor, and the
  // WebCodecs PoC (frame-accurate, decodes MP4 manually via mp4box.js).
  // The engine binds at construction, so we force a VideoEditor remount
  // via `key={engineKind}` when this changes. Canvas + WebCodecs both
  // opt INTO `debug: true` so the HUD identifies the active engine —
  // that's the whole point of the demo. Production hosts omit `debug`
  // (defaults to false) and get a clean canvas.
  const webCodecsAvailable = isWebCodecsSupported();
  const [engineKind, setEngineKind] = useState<
    "html" | "canvas" | "webcodecs"
  >("html");
  // Demo of EditorOptions.trackHeight — shrinking each track row
  // tightens the timeline footprint. setTimelineMetrics is applied
  // at construction so changes here force a remount via `key`.
  const [trackHeight, setTrackHeight] = useState<number>(56);
  // Demo of EditorOptions.timelineHeight — controls the OUTER height
  // of the bottom timeline area (the canvas inside fills 100% and
  // scrolls). Reactive — no remount needed, the React wrapper
  // pushes it through as a CSS custom property update.
  const [timelineHeight, setTimelineHeight] = useState<number>(240);
  // Keyframe mode toggle — surfaces diamond markers on the timeline +
  // routes the canvas / WebCodecs engines through the transform
  // pipeline. Data round-trips either way, so flipping off and back on
  // doesn't lose the keyframes.
  const [keyframesEnabled, setKeyframesEnabled] = useState<boolean>(false);
  // Jump-to-clip-edge nav cluster (|◀ ▶|) + I/O keyboard shortcuts.
  // Off by default — the buttons take toolbar space and the I/O keys
  // would shadow page typing, so hosts opt in like they do for kfs.
  const [clipEdgeNavEnabled, setClipEdgeNavEnabled] = useState<boolean>(false);
  // Multi-track PiP — controlled by the editor's built-in toolbar
  // toggle (configured via `pictureInPicture.toolbarToggle: true`
  // below). We mirror the state into React via the editor's
  // `pictureInPictureEnabledChange` event so the toolbar's chip
  // and the demo's chrome stay in sync.
  const [pipEnabled, setPipEnabled] = useState<boolean>(false);
  const playbackEngine: PlaybackEngineFactory = useMemo(() => {
    if (engineKind === "canvas") {
      return (opts) => new CanvasCompositorEngine({ ...opts, debug: true });
    }
    if (engineKind === "webcodecs") {
      return (opts) => new WebCodecsEngine({ ...opts, debug: true });
    }
    return htmlVideoEngineFactory;
  }, [engineKind]);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ running: false });
  const exportAbortRef = useRef<AbortController | null>(null);
  // Latest backend pick — read inside the editor `export` listener
  // (which is wired once on mount and captures stale closures otherwise).
  const backendKindRef = useRef(backendKind);
  backendKindRef.current = backendKind;
  const theme = useMemo(() => THEMES[themeName], [themeName]);

  const runBackendExport = async (
    project: Project,
    output: { width: number; height: number; fps: number },
  ): Promise<void> => {
    exportAbortRef.current?.abort();
    const ac = new AbortController();
    exportAbortRef.current = ac;
    const baseUrl = BACKENDS[backendKindRef.current].url;
    if (!baseUrl) {
      toast.push(
        `Export failed: ${backendKindRef.current.toUpperCase()} backend URL is not configured. Set VITE_BACKEND_${backendKindRef.current.toUpperCase()}_URL in .env.local and rebuild.`,
        { variant: "warn", duration: 6000 },
      );
      setExportStatus({ running: false });
      return;
    }
    // Blob URLs only live in the browser tab — ffmpeg can't fetch
    // them. If any source URL is a blob:, warn the user up front.
    if (project.sources.some((s) => s.url.startsWith("blob:"))) {
      toast.push(
        "Export may fail: some video sources are browser-local blob URLs that the backend can't reach. Set VITE_UPLOAD_ENDPOINT so uploads land at a fetchable URL, then re-upload.",
        { variant: "warn", duration: 6000 },
      );
    }
    setExportStatus({ running: true, overall: 0, phase: "encode" });
    // Resolve dev-server-relative URLs (e.g. "/a.mov") into absolute
    // http URLs the backend's ffmpeg can fetch. Demo seeds use Vite's
    // /public/ paths which are only meaningful to the browser; the
    // backend opens whatever string we send via `-i`, and "/a.mov"
    // would try to read from the filesystem root. Leave already-
    // absolute URLs (http(s)://, file://) untouched.
    const projectForExport: Project = {
      ...project,
      sources: project.sources.map((s) => {
        if (s.url.startsWith("/") && !s.url.startsWith("//")) {
          return { ...s, url: `${window.location.origin}${s.url}` };
        }
        return s;
      }),
    };
    try {
      const res = await fetch(`${baseUrl}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Output dims gate the kf compilation on the backend — without
        // them ffmpeg gets neither `-vf` nor `-filter_complex` and
        // keyframe transforms are silently skipped. The popover always
        // supplies all three so we never accidentally regress to "no
        // dims" again.
        body: JSON.stringify({
          project: projectForExport,
          output,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      // Parse SSE manually — EventSource doesn't allow POST bodies,
      // and we want a single round-trip. Events are `data: <json>\n\n`;
      // comment lines (`: ping`) are heartbeats we ignore.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Read loop — exits when reader.read() resolves with done=true.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = JSON.parse(line.slice(6)) as ExportStatus & {
              fileUrl?: string;
            };
            if (data.phase === "done" && data.fileUrl) {
              const fullUrl = `${baseUrl}${data.fileUrl}`;
              setExportStatus({
                running: false,
                phase: "done",
                fileUrl: fullUrl,
                overall: 1,
              });
              // Best-effort — popup blockers may swallow this since
              // we're well past the originating user-gesture frame.
              // The sidebar shows an explicit Open link as fallback.
              window.open(fullUrl, "_blank", "noopener,noreferrer");
            } else if (data.phase === "error") {
              setExportStatus({ running: false, error: data.error });
            } else {
              const { running: _ignored, ...rest } = data;
              void _ignored;
              setExportStatus({ ...rest, running: true });
            }
          }
          idx = buf.indexOf("\n\n");
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        setExportStatus({ running: false, error: "已取消" });
      } else {
        setExportStatus({
          running: false,
          error: `${e.message}（确认 ${backendKindRef.current.toUpperCase()} 后端是否在跑）`,
        });
      }
    } finally {
      exportAbortRef.current = null;
    }
  };

  const cancelExport = (): void => {
    exportAbortRef.current?.abort();
  };

  // Hidden file input the toolbar "+ PiP overlay" button drives.
  const pipFileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Wired to the editor's `requestPictureInPictureAdd` event — when
   * the toolbar's "+ PiP overlay" button fires, surface a file
   * picker. The picked file flows through the same upload pipeline
   * as the sidebar (server upload when configured, else local blob
   * URL); the resulting clip lands on a fresh video track so it
   * stacks on top of the main track per the engine's z-order
   * convention.
   */
  const triggerPipUpload = (): void => {
    pipFileInputRef.current?.click();
  };

  const handlePipFile = async (file: File): Promise<void> => {
    const api = apiRef.current;
    if (!api) {
      toast.push("Editor isn't ready yet — try again in a moment.", { variant: "warn" });
      return;
    }
    let url: string;
    let isLocal: boolean;
    try {
      if (UPLOAD_ENDPOINT) {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await fetch(UPLOAD_ENDPOINT, { method: "POST", body: form });
        if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
        const data = (await res.json()) as { url?: string };
        if (!data.url) throw new Error("Upload response missing `url` field");
        url = data.url;
        isLocal = false;
      } else {
        url = URL.createObjectURL(file);
        isLocal = true;
        toast.push(
          "VITE_UPLOAD_ENDPOINT not set — the PiP overlay uses a local blob URL. Playable in this browser only, can't be exported.",
          { variant: "warn", duration: 5000 },
        );
      }
    } catch (e) {
      toast.push(`PiP upload error: ${e instanceof Error ? e.message : String(e)}`, {
        variant: "error",
      });
      return;
    }
    // Probe duration via a transient <video>.
    const durationMs = await new Promise<number | undefined>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = url;
      const timeout = setTimeout(() => resolve(undefined), 5000);
      v.onloadedmetadata = () => {
        clearTimeout(timeout);
        const ms = Math.round(v.duration * 1000);
        resolve(Number.isFinite(ms) && ms > 0 ? ms : undefined);
      };
      v.onerror = () => {
        clearTimeout(timeout);
        resolve(undefined);
      };
    });

    const project = api.getProject();
    const sourceId = createId("src");
    const clipId = createId("clip");
    // Find the first non-track-0 video track without overlapping
    // clips at the playhead; create a fresh track when there's none.
    const playhead = api.getTime();
    const overlayTrackIdx = project.tracks.findIndex((t, i) => {
      if (t.kind !== "video") return false;
      if (i === 0) return false;
      return !t.clips.some(
        (c) => playhead >= c.start && playhead < c.start + (c.out - c.in),
      );
    });
    const usableDurationMs = durationMs ?? 5000;
    const newClip = {
      id: clipId,
      sourceId,
      in: 0,
      out: usableDurationMs,
      // Land at the playhead so the user sees the PiP overlay
      // immediately at the current preview time.
      start: playhead,
      // Centered + scaled — pre-seeds the PiP as a small frame
      // inside the canvas. User drags from there.
      scale: 0.4,
    };
    const next: Project = {
      ...project,
      sources: [
        ...project.sources,
        { id: sourceId, url, kind: "video", name: file.name, duration: durationMs },
      ],
      tracks:
        overlayTrackIdx >= 0
          ? project.tracks.map((t, i) =>
              i === overlayTrackIdx ? { ...t, clips: [...t.clips, newClip] } : t,
            )
          : [
              ...project.tracks,
              {
                id: createId("track"),
                kind: "video" as const,
                clips: [newClip],
              },
            ],
    };
    api.setProject(next);
    if (!isLocal) {
      toast.push(`Added PiP overlay: ${file.name}`, { variant: "success" });
    }
  };

  /**
   * Handler the UploadPanel calls after a video resolves to a URL
   * (either a server-uploaded http URL or a local blob URL). Adds the
   * source AND drops a clip onto the first video track, appended to
   * whatever's already there. The editor's history records this as
   * one normal mutation so the user can Cmd+Z to undo.
   */
  const handleUploaded = (r: UploadResult): void => {
    const api = apiRef.current;
    if (!api) {
      toast.push("Editor isn't ready yet — try again in a moment.", { variant: "warn" });
      return;
    }
    const project = api.getProject();
    const sourceId = createId("src");
    const trackIdx = project.tracks.findIndex((t) => t.kind === "video");
    if (trackIdx < 0) {
      toast.push("No video track available.", { variant: "warn" });
      return;
    }
    const track = project.tracks[trackIdx]!;
    const tail = track.clips.reduce(
      (acc, c) => Math.max(acc, c.start + (c.out - c.in)),
      0,
    );
    const durationMs = r.durationMs ?? 5000;
    const next: Project = {
      ...project,
      sources: [
        ...project.sources,
        {
          id: sourceId,
          url: r.url,
          kind: "video",
          name: r.name,
          duration: r.durationMs,
        },
      ],
      tracks: project.tracks.map((t, i) =>
        i === trackIdx
          ? {
              ...t,
              clips: [
                ...t.clips,
                {
                  id: createId("clip"),
                  sourceId,
                  in: 0,
                  out: durationMs,
                  start: tail,
                },
              ],
            }
          : t,
      ),
    };
    api.setProject(next);
  };

  // Note: `onReady` is the right hook to expose the API to e2e via
  // window.__aicut — it fires synchronously on mount, BEFORE any
  // parent useEffect runs in React 19 strict mode (where parent
  // effects can race with the child mount). Putting this in a
  // separate useEffect was flaky under strict mode.

  return (
    <div className="demo-shell">
      <div className="demo-editor">
        <VideoEditor
          // The engine + trackHeight both bind at construction —
          // flipping either forces React to remount the editor so the
          // new value takes effect. Playback state resets, acceptable
          // for a demo. `timelineHeight` is reactive (CSS custom prop
          // under the hood) so it isn't in the key.
          key={`${engineKind}|${trackHeight}`}
          apiRef={apiRef}
          defaultProject={seed()}
          theme={theme}
          locale={locale}
          playbackEngine={playbackEngine}
          trackHeight={trackHeight}
          timelineHeight={timelineHeight}
          pictureInPicture={{
            enabled: pipEnabled,
            // Surface the "+ PiP overlay" toolbar action so users
            // can trigger an upload from inside the editor. The
            // ENABLE flag stays a host concern (sidebar checkbox);
            // the toolbar button is purely "add a PiP", not a
            // toggle.
            toolbarAdd: true,
          }}
          onPictureInPictureAddRequested={triggerPipUpload}
          keyframes={{ enabled: keyframesEnabled }}
          clipEdgeNav={{ enabled: clipEdgeNavEnabled }}
          aspect={{ enabled: true }}
          onAspectChange={(a) => {
            // Built-in picker drives the demo's export aspect default
            // — pickers in real hosts wire to whatever output settings
            // they own (preview letterbox, ffmpeg dims, etc.).
            if (a == null) return; // "Original" keeps the current export aspect
            if (a === "16:9" || a === "9:16" || a === "1:1" || a === "4:3") {
              setExportAspect(a);
              setExportResIdx((i) =>
                Math.min(i, RESOLUTIONS[a].length - 1),
              );
            }
          }}
          style={{ height: "100%" }}
          headerLeft={
            showHeader ? (
              <span className="demo-header-title">Untitled project</span>
            ) : null
          }
          headerRight={
            showHeader ? (
              <>
                <button
                  type="button"
                  className="demo-slot-btn"
                  data-testid="demo-share"
                  onClick={() => {
                    const p = apiRef.current?.getProject();
                    if (p) void navigator.clipboard?.writeText(JSON.stringify(p));
                  }}
                  style={demoSlotBtnStyle}
                >
                  Share
                </button>
                <span style={{ position: "relative", display: "inline-block" }}>
                  <button
                    type="button"
                    className="demo-slot-btn"
                    data-testid="demo-header-export"
                    disabled={exportStatus.running}
                    onClick={() => setExportPopoverOpen((v) => !v)}
                    style={{
                      ...demoSlotBtnStyle,
                      background: exportStatus.running
                        ? "var(--aicut-controls-hover, rgba(255,255,255,0.08))"
                        : "var(--color-brand, #9a31f4)",
                      color: exportStatus.running
                        ? "var(--aicut-controls-text, rgba(255,255,255,0.6))"
                        : "#fff",
                      cursor: exportStatus.running ? "not-allowed" : "pointer",
                    }}
                  >
                    {exportStatus.running ? "Exporting…" : "Export"}
                  </button>
                  {exportPopoverOpen && !exportStatus.running ? (
                    <ExportPopover
                      aspect={exportAspect}
                      resIdx={exportResIdx}
                      fps={exportFps}
                      onChangeAspect={(a) => {
                        setExportAspect(a);
                        setExportResIdx((i) =>
                          Math.min(i, RESOLUTIONS[a].length - 1),
                        );
                      }}
                      onChangeResIdx={setExportResIdx}
                      onChangeFps={setExportFps}
                      onCancel={() => setExportPopoverOpen(false)}
                      onConfirm={() => {
                        const api = apiRef.current;
                        if (!api) {
                          setExportStatus({
                            running: false,
                            error: "Editor API not ready yet",
                          });
                          return;
                        }
                        setExportPopoverOpen(false);
                        setExportStatus({
                          running: true,
                          overall: 0,
                          phase: "encode",
                        });
                        api.requestExport();
                      }}
                      resolutions={RESOLUTIONS}
                      fpsOptions={FPS_OPTIONS}
                    />
                  ) : null}
                </span>
              </>
            ) : null
          }
          toolbarLeft={
            showToolbarLeft ? (
              // Aspect ratio is now built into the editor (see
              // `aspect={{ enabled: true }}` above) — this slot still
              // accepts whatever the host wants. Here it's a quick
              // project-name editor to prove the slot mechanism is
              // unchanged.
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <span style={{ opacity: 0.7 }}>Project</span>
                <input
                  type="text"
                  data-testid="demo-project-name"
                  className="demo-slot-input"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  style={demoSlotInputStyle}
                  spellCheck={false}
                />
              </label>
            ) : null
          }
          toolbarRight={
            showToolbarRight ? (
              <ExportStatusPill status={exportStatus} />
            ) : null
          }
          onReady={(api) => {
            // Expose the API for e2e immediately (canvas clips have
            // no DOM nodes to query).
            // `TRACK_HEIGHT` is an ESM live binding — re-reading it
            // here after editor mount reflects whatever setTimelineMetrics
            // has applied. E2E uses it to verify the trackHeight knob
            // actually plumbed through to the layout module.
            (window as unknown as { __aicut?: unknown }).__aicut = {
              api,
              metrics: { trackHeight: TRACK_HEIGHT },
            };
            api.on("selectionChange", ({ clipId }) =>
              setSelectedClipId(clipId),
            );
            api.on("historyChange", (h) => setHistoryState(h));
            api.on("pictureInPictureEnabledChange", ({ enabled }) =>
              setPipEnabled(enabled),
            );

            // Build clips as each source's metadata resolves. The core
            // `ready` event fires per-source with the duration already
            // applied to `getProject().sources[].duration`. Only
            // auto-seeds when the source has NO existing clip anywhere
            // — host code (e.g. multi-track PiP setups, scripted
            // setProject calls) that already arranged clips for the
            // source doesn't get its layout clobbered.
            const seeded = new Set<string>();
            api.on("ready", ({ sourceId }) => {
              if (!sourceId || seeded.has(sourceId)) return;
              const project = api.getProject();
              const src = project.sources.find((s) => s.id === sourceId);
              if (!src?.duration) return;
              const alreadyHasClip = project.tracks.some((t) =>
                t.clips.some((c) => c.sourceId === sourceId),
              );
              if (alreadyHasClip) {
                seeded.add(sourceId);
                return;
              }
              const track = project.tracks.find((t) => t.kind === "video");
              if (!track) return;
              const start = track.clips.reduce(
                (acc, c) => acc + (c.out - c.in),
                0,
              );
              track.clips.push({
                id: createId("clip"),
                sourceId: src.id,
                in: 0,
                out: src.duration,
                start,
              });
              seeded.add(sourceId);
              api.setProject(project);
            });
          }}
          onChange={(p) => setSavedJson(JSON.stringify(p, null, 2))}
          onExport={(p) => {
            setExportJson(JSON.stringify(p, null, 2));
            const res = RESOLUTIONS[exportAspect][exportResIdx]
              ?? RESOLUTIONS[exportAspect][0]!;
            void runBackendExport(p, {
              width: res.width,
              height: res.height,
              fps: exportFps,
            });
          }}
        />
        {/* Hidden — driven by the toolbar "+ PiP overlay" button. */}
        <input
          ref={pipFileInputRef}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          data-testid="demo-pip-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handlePipFile(f);
            e.target.value = "";
          }}
        />
      </div>
      <aside className="demo-sidebar">
        <h2>Upload video</h2>
        <div className="demo-row">
          <UploadPanel
            uploadEndpoint={UPLOAD_ENDPOINT}
            onUploaded={handleUploaded}
          />
        </div>

        <h2>Theme</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="demo-theme-toggle"
            onClick={() => setThemeName(themeName === "dark" ? "light" : "dark")}
          >
            {themeName === "dark" ? "Switch to Light Studio" : "Switch to Pro Dark"}
          </button>
        </div>

        <h2>Language</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="demo-locale-toggle"
            onClick={() => setLocaleName(localeName === "en" ? "zh" : "en")}
          >
            {localeName === "en" ? "Switch to 中文" : "Switch to English"}
          </button>
        </div>

        <h2>Timeline density</h2>
        <div className="demo-row demo-track-height-row">
          <label>
            Total timeline area: <strong>{timelineHeight}px</strong>
          </label>
          <input
            type="range"
            min={120}
            max={400}
            step={10}
            value={timelineHeight}
            data-testid="demo-timeline-height"
            onChange={(e) => setTimelineHeight(Number(e.target.value))}
          />
          <p className="demo-engine-help">
            Outer height of the bottom timeline section. Reactive —
            the preview reclaims any space you take from this. The
            canvas inside scrolls vertically when there are more
            tracks than fit.
          </p>
        </div>
        <div className="demo-row demo-track-height-row">
          <label>
            Track row height: <strong>{trackHeight}px</strong>
          </label>
          <input
            type="range"
            min={28}
            max={80}
            step={2}
            value={trackHeight}
            data-testid="demo-track-height"
            onChange={(e) => setTrackHeight(Number(e.target.value))}
          />
          <p className="demo-engine-help">
            Height of each individual track row inside the timeline.
            Changing this remounts the editor (process-wide setting).
          </p>
        </div>

        <h2>Playback engine</h2>
        <div className="demo-row demo-engine-row">
          <label>
            <input
              type="radio"
              name="engine"
              value="html"
              data-testid="demo-engine-html"
              checked={engineKind === "html"}
              onChange={() => setEngineKind("html")}
            />
            <span>HTML5 video (default)</span>
          </label>
          <label>
            <input
              type="radio"
              name="engine"
              value="canvas"
              data-testid="demo-engine-canvas"
              checked={engineKind === "canvas"}
              onChange={() => setEngineKind("canvas")}
            />
            <span>Canvas compositor (host-supplied)</span>
          </label>
          <label
            title={
              webCodecsAvailable
                ? "Decodes MP4 via WebCodecs + mp4box.js. Frame-accurate seek."
                : "This browser doesn't expose VideoDecoder. Try Chrome 94+ or Safari 17.4+."
            }
          >
            <input
              type="radio"
              name="engine"
              value="webcodecs"
              data-testid="demo-engine-webcodecs"
              checked={engineKind === "webcodecs"}
              disabled={!webCodecsAvailable}
              onChange={() => setEngineKind("webcodecs")}
            />
            <span>
              WebCodecs (mp4box + VideoDecoder)
              {!webCodecsAvailable ? " — unsupported" : ""}
            </span>
          </label>
          <p className="demo-engine-help">
            Same interface, different rendering surface. All three
            paint a HUD badge identifying who's drawing.
          </p>
        </div>

        <h2>Picture-in-picture</h2>
        <div className="demo-row demo-checkbox-row">
          <label>
            <input
              type="checkbox"
              data-testid="demo-pip-toggle"
              checked={pipEnabled}
              onChange={(e) => setPipEnabled(e.target.checked)}
            />
            <span>Enable multi-track preview compositing</span>
          </label>
        </div>
        <p className="demo-engine-help">
          Toggle compositing here. The toolbar's "+ PiP overlay"
          button uploads a video onto a new overlay track (centered
          + scale 0.4). Higher tracks paint on top; lower tracks
          mute their audio.
        </p>

        <h2>Keyframes</h2>
        <div className="demo-row demo-checkbox-row">
          <label>
            <input
              type="checkbox"
              data-testid="demo-keyframes-toggle"
              checked={keyframesEnabled}
              onChange={(e) => setKeyframesEnabled(e.target.checked)}
            />
            <span>Enable keyframe animation (X / Y / Scale)</span>
          </label>
        </div>
        <div className="demo-row demo-checkbox-row">
          <label>
            <input
              type="checkbox"
              data-testid="demo-clip-edge-nav-toggle"
              checked={clipEdgeNavEnabled}
              onChange={(e) => setClipEdgeNavEnabled(e.target.checked)}
            />
            <span>Enable "jump to clip start / end" (|◀ ▶|, I / O)</span>
          </label>
        </div>
        <p className="demo-engine-help">
          Library-provided UI: a "+ keyframe" button appears in the
          toolbar; clicking pins the current X / Y / Scale at the
          playhead. Selected clips show a dashed frame border in the
          preview with drag-to-translate + corner-handles-to-scale.
          The numeric panel pops up in the preview's top-left whenever
          a keyframe is selected. (HtmlVideoEngine renders identity —
          swap to Canvas / WebCodecs for live animated preview.)
        </p>

        <h2>Header</h2>
        <div className="demo-row demo-checkbox-row">
          <label>
            <input
              type="checkbox"
              data-testid="demo-toggle-header"
              checked={showHeader}
              onChange={(e) => setShowHeader(e.target.checked)}
            />
            <span>Show header (title + Share + Export)</span>
          </label>
        </div>

        <h2>Toolbar slots</h2>
        <div className="demo-row demo-checkbox-row">
          <label>
            <input
              type="checkbox"
              data-testid="demo-toggle-toolbar-left"
              checked={showToolbarLeft}
              onChange={(e) => setShowToolbarLeft(e.target.checked)}
            />
            <span>Left (Project name)</span>
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="demo-toggle-toolbar-right"
              checked={showToolbarRight}
              onChange={(e) => setShowToolbarRight(e.target.checked)}
            />
            <span>Right (Export)</span>
          </label>
        </div>

        <h2>Persistence</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="demo-save"
            onClick={() => {
              const project = apiRef.current?.getProject();
              if (project) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
            }}
          >
            Save to localStorage
          </button>
          <button
            type="button"
            data-testid="demo-restore"
            onClick={() => {
              const raw = localStorage.getItem(STORAGE_KEY);
              if (raw) apiRef.current?.setProject(JSON.parse(raw) as Project);
            }}
          >
            Restore
          </button>
          <button
            type="button"
            data-testid="demo-reset"
            onClick={() => {
              apiRef.current?.setProject(createEmptyProject());
            }}
          >
            Reset (empty)
          </button>
        </div>

        <h2>State</h2>
        <div className="demo-state">
          <div>
            Selection: <code data-testid="demo-selected">{selectedClipId ?? "—"}</code>
          </div>
          <div>
            Undo: {historyState.canUndo ? "yes" : "no"} · Redo:{" "}
            {historyState.canRedo ? "yes" : "no"}
          </div>
        </div>

        <h2>Quick actions</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="demo-add-track"
            onClick={() => apiRef.current?.addTrack("video")}
          >
            + Video track
          </button>
          <button
            type="button"
            data-testid="demo-move-to-track2"
            disabled={!selectedClipId}
            onClick={() => {
              const api = apiRef.current;
              if (!api || !selectedClipId) return;
              const project = api.getProject();
              const t2 = project.tracks[1];
              if (t2) api.moveClip(selectedClipId, { trackId: t2.id });
            }}
          >
            Selected → Track 2
          </button>
        </div>

        <h2>Shortcuts</h2>
        <ul className="demo-shortcuts">
          <li><kbd>Space</kbd> play / pause</li>
          <li><kbd>K</kbd> split at playhead</li>
          <li><kbd>Q</kbd> trim left to playhead</li>
          <li><kbd>W</kbd> trim right to playhead</li>
          <li><kbd>⌘Z</kbd> undo · <kbd>⌘⇧Z</kbd> redo</li>
          <li><kbd>Del</kbd> remove selected clip</li>
        </ul>

        <h2>Export backend</h2>
        <div className="demo-row">
          <select
            data-testid="demo-backend-select"
            value={backendKind}
            onChange={(e) => setBackendKind(e.target.value as "ts" | "go")}
            disabled={exportStatus.running}
          >
            <option value="ts">{BACKENDS.ts.label}</option>
            <option value="go">{BACKENDS.go.label}</option>
          </select>
        </div>
        <div className="demo-state" data-testid="demo-export-status">
          {exportStatus.running ? (
            <>
              <progress
                value={exportStatus.overall ?? 0}
                max={1}
                style={{ width: "100%" }}
              />
              <div>
                {exportStatus.phase === "concat" ? "合并中…" : "编码中"}
                {exportStatus.totalClips != null && exportStatus.clipIndex != null
                  ? ` (clip ${exportStatus.clipIndex + 1}/${exportStatus.totalClips})`
                  : null}
                {" · "}
                {Math.round((exportStatus.overall ?? 0) * 100)}%
              </div>
              <button type="button" onClick={cancelExport}>
                取消
              </button>
            </>
          ) : null}
          {exportStatus.fileUrl ? (
            <div>
              输出：
              <a
                data-testid="demo-export-file"
                href={exportStatus.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {exportStatus.fileUrl}
              </a>
            </div>
          ) : null}
          {exportStatus.error ? (
            <div className="demo-export-error" data-testid="demo-export-error">
              {exportStatus.error}
            </div>
          ) : null}
          {!exportStatus.running && !exportStatus.fileUrl && !exportStatus.error ? (
            <div style={{ opacity: 0.6 }}>
              Click the Export button in the toolbar to start — the backend must be running.
            </div>
          ) : null}
        </div>

        <h2>Live project JSON</h2>
        <textarea
          className="demo-json"
          data-testid="demo-project-json"
          value={savedJson}
          readOnly
        />

        <h2>Last export payload</h2>
        <textarea
          className="demo-json"
          data-testid="demo-export-json"
          value={exportJson}
          readOnly
        />

        <FramePicker />
      </aside>
    </div>
  );
}
