import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Timeline,
  VideoEditor,
  canvasCompositorEngineFactory,
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

const SRC_A = {
  id: createId("src"),
  url: "http://127.0.0.1:8091/a.mov",
  kind: "video" as const,
  name: "a.mov",
};
const SRC_B = {
  id: createId("src"),
  url: "http://127.0.0.1:8091/b.mov",
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
          url: "http://127.0.0.1:8091/a.mov",
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
  // default HtmlVideoEngine and a host-supplied CanvasCompositorEngine
  // (a real second implementation: same browser decode, but rendering
  // happens via ctx.drawImage on a single canvas + a debug HUD).
  // The engine binds at construction, so we force a VideoEditor
  // remount via `key={engineKind}` when this changes.
  const [engineKind, setEngineKind] = useState<"html" | "canvas">("html");
  const playbackEngine: PlaybackEngineFactory = useMemo(
    () =>
      engineKind === "canvas"
        ? canvasCompositorEngineFactory
        : htmlVideoEngineFactory,
    [engineKind],
  );
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ running: false });
  const exportAbortRef = useRef<AbortController | null>(null);
  // Latest backend pick — read inside the editor `export` listener
  // (which is wired once on mount and captures stale closures otherwise).
  const backendKindRef = useRef(backendKind);
  backendKindRef.current = backendKind;
  const theme = useMemo(() => THEMES[themeName], [themeName]);

  const runBackendExport = async (project: Project): Promise<void> => {
    exportAbortRef.current?.abort();
    const ac = new AbortController();
    exportAbortRef.current = ac;
    const baseUrl = BACKENDS[backendKindRef.current].url;
    setExportStatus({ running: true, overall: 0, phase: "encode" });
    try {
      const res = await fetch(`${baseUrl}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
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
          // The engine binds at construction — flipping `engineKind`
          // forces React to remount the editor with the new factory
          // (playback state resets, which is acceptable for a demo).
          key={engineKind}
          apiRef={apiRef}
          defaultProject={seed()}
          theme={theme}
          locale={locale}
          playbackEngine={playbackEngine}
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
              <button
                type="button"
                data-testid="demo-export"
                className="demo-slot-btn"
                disabled={exportStatus.running}
                onClick={() => {
                  // Instant feedback BEFORE the event-bus round-trip,
                  // so a click is obviously registered even if the
                  // editor instance is mid-recreation or the listener
                  // chain has an issue.
                  console.log("[demo] export clicked", apiRef.current);
                  const api = apiRef.current;
                  if (!api) {
                    setExportStatus({
                      running: false,
                      error: "Editor API not ready yet",
                    });
                    return;
                  }
                  if (typeof api.requestExport !== "function") {
                    setExportStatus({
                      running: false,
                      error:
                        "api.requestExport is not a function — stale build?",
                    });
                    return;
                  }
                  setExportStatus({
                    running: true,
                    overall: 0,
                    phase: "encode",
                  });
                  api.requestExport();
                }}
                style={demoSlotBtnStyle}
              >
                {exportStatus.running ? "导出中…" : "导出"}
              </button>
            ) : null
          }
          onReady={(api) => {
            // Expose the API for e2e immediately (canvas clips have
            // no DOM nodes to query).
            (window as unknown as { __aicut?: unknown }).__aicut = { api };
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
            void runBackendExport(p);
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
          <p className="demo-engine-help">
            Same interface, different rendering surface. The canvas
            engine paints a HUD badge so you can see who's drawing.
          </p>
        </div>

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
