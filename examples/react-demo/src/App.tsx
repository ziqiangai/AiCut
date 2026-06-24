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
  return {
    version: 1,
    sources: [SRC_A, SRC_B],
    tracks: [
      { id: createId("track"), kind: "video", clips: [] },
      // A second empty video track to demonstrate multi-track layout.
      // The host can drop clips into it via apiRef.moveClip(...) or
      // duplicate the seed logic.
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
      <div style={{ fontWeight: 600, fontSize: 13 }}>导出设置</div>
      <Row label="比例">
        <select
          data-testid="demo-export-aspect"
          value={props.aspect}
          onChange={(e) =>
            props.onChangeAspect(e.target.value as ExportAspectKey)
          }
          style={popoverSelectStyle}
        >
          {(Object.keys(props.resolutions) as ExportAspectKey[]).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Row>
      <Row label="分辨率">
        <select
          data-testid="demo-export-resolution"
          value={props.resIdx}
          onChange={(e) => props.onChangeResIdx(Number(e.target.value))}
          style={popoverSelectStyle}
        >
          {opts.map((r, i) => (
            <option key={r.label} value={i}>
              {r.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="帧率">
        <select
          data-testid="demo-export-fps"
          value={props.fps}
          onChange={(e) => props.onChangeFps(Number(e.target.value))}
          style={popoverSelectStyle}
        >
          {props.fpsOptions.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
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
            background: "var(--color-brand, #ff3386)",
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

const popoverSelectStyle: CSSProperties = {
  minWidth: 140,
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border:
    "1px solid var(--aicut-controls-border, rgba(255,255,255,0.16))",
  background:
    "var(--aicut-controls-hover, rgba(255,255,255,0.06))",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 12,
  appearance: "none",
};

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

interface ExportStatus {
  running: boolean;
  phase?: "encode" | "concat" | "done" | "error";
  overall?: number;
  clipIndex?: number;
  totalClips?: number;
  fileUrl?: string;
  error?: string;
}

const BACKENDS = {
  ts: { label: "TypeScript (8787)", url: "http://127.0.0.1:8787" },
  go: { label: "Go (8788)", url: "http://127.0.0.1:8788" },
} as const;

export function App() {
  const apiRef = useRef<VideoEditorApi | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [exportJson, setExportJson] = useState("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [themeName, setThemeName] = useState<"dark" | "light">("dark");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
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
          keyframes={{ enabled: keyframesEnabled }}
          clipEdgeNav={{ enabled: clipEdgeNavEnabled }}
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
                <button
                  type="button"
                  className="demo-slot-btn"
                  data-testid="demo-header-export"
                  onClick={() => apiRef.current?.requestExport()}
                  style={{
                    ...demoSlotBtnStyle,
                    background: "var(--color-brand, #ff3386)",
                    color: "#fff",
                  }}
                >
                  Export
                </button>
              </>
            ) : null
          }
          toolbarLeft={
            showToolbarLeft ? (
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <span style={{ opacity: 0.7 }}>Aspect</span>
                <select
                  data-testid="demo-aspect"
                  className="demo-slot-select"
                  value={aspect}
                  onChange={(e) => setAspect(e.target.value as typeof aspect)}
                  style={demoSlotSelectStyle}
                >
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </label>
            ) : null
          }
          toolbarRight={
            showToolbarRight ? (
              <span style={{ position: "relative", display: "inline-block" }}>
                <button
                  type="button"
                  data-testid="demo-export"
                  className="demo-slot-btn"
                  disabled={exportStatus.running}
                  onClick={() => setExportPopoverOpen((v) => !v)}
                  style={demoSlotBtnStyle}
                >
                  {exportStatus.running ? "导出中…" : "导出"}
                </button>
                {exportPopoverOpen && !exportStatus.running ? (
                  <ExportPopover
                    aspect={exportAspect}
                    resIdx={exportResIdx}
                    fps={exportFps}
                    onChangeAspect={(a) => {
                      setExportAspect(a);
                      // Clamp the resolution index to the new aspect's
                      // option count so we don't dangle past the array.
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
                      // requestExport fires the editor's `export` event
                      // synchronously; onExport (below) closes over the
                      // current export* state and posts with those dims.
                      api.requestExport();
                    }}
                    resolutions={RESOLUTIONS}
                    fpsOptions={FPS_OPTIONS}
                  />
                ) : null}
              </span>
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

            // Build clips as each source's metadata resolves. The core
            // `ready` event fires per-source with the duration already
            // applied to `getProject().sources[].duration`.
            const seeded = new Set<string>();
            api.on("ready", ({ sourceId }) => {
              if (!sourceId || seeded.has(sourceId)) return;
              const project = api.getProject();
              const src = project.sources.find((s) => s.id === sourceId);
              if (!src?.duration) return;
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
      </div>
      <aside className="demo-sidebar">
        <h2>Theme</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="demo-theme-toggle"
            onClick={() => setThemeName(themeName === "dark" ? "light" : "dark")}
          >
            {themeName === "dark" ? "切换到 Light Studio" : "切换到 Pro Dark"}
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
            <span>Left (Aspect)</span>
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
              点工具栏的"导出"按钮触发；后端要先单独启动。
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
