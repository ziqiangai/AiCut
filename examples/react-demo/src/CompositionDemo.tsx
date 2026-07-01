/**
 * Composition demo — shows the primitive-based API. The layout is
 * host-defined (nothing structural comes from `@aicut/core`):
 *
 *   ┌────────────────────┬───────────────────────────────────────┐
 *   │  Media list        │  <Preview />                          │
 *   │  (host-supplied)   │                                       │
 *   │                    ├───────────────────────────────────────┤
 *   │  li.a.mov          │  [ Export ]  ← host button            │
 *   │  li.b.mp4          │                                       │
 *   ├────────────────────┴───────────────────────────────────────┤
 *   │  Toolbar row — play button centered                        │
 *   ├────────────────────────────────────────────────────────────┤
 *   │  <Timeline />                                              │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Every AiCut element is a primitive picked from `@aicut/react`:
 *   <EditorProvider>          state + engine context
 *   <Preview>                 playback surface
 *   <TimelinePrimitive>       timeline bound to shared editor
 *   <PlayButton>              play / pause
 *   <TimeLabel/DurationLabel> mm:ss labels
 *   <UndoButton/RedoButton>   undo/redo
 *   <SplitButton/TrimLeftButton/TrimRightButton> edit ops
 *   <SnapToggle>              snap on/off
 *
 * Theme + locale flow through `<EditorProvider>` — same tokens as the
 * one-piece `<VideoEditor>`.
 */
import { useState, type ReactElement } from "react";
import {
  EditorProvider,
  Preview,
  TimelinePrimitive,
  PlayButton,
  TimeLabel,
  DurationLabel,
  UndoButton,
  RedoButton,
  SplitButton,
  TrimLeftButton,
  TrimRightButton,
  SnapToggle,
  localeEn,
  localeZh,
  useEditor,
  useEditorState,
  createId,
  type Project,
  type Theme,
  type Locale,
} from "@aicut/react";
import "@aicut/core/styles.css";

const SAMPLE_URL =
  (import.meta.env.VITE_PRELOAD_VIDEO_URL as string | undefined) ||
  "/sample.mp4";

// The composition demo intentionally does NOT auto-add clips — it lets
// the host media list drive project construction so users can see the
// "empty state → add a source → clip appears on timeline" flow that a
// real embedding host would build.
const EMPTY_PROJECT: Project = {
  version: 1,
  sources: [],
  tracks: [
    { id: createId("track"), kind: "video", clips: [] },
    { id: createId("track"), kind: "video", clips: [] },
  ],
};

const THEME_LIGHT: Theme = {
  controlsBg: "#f6f6f8",
  controlsBorder: "rgba(0, 0, 0, 0.08)",
  controlsText: "rgba(0, 0, 0, 0.78)",
  controlsHover: "rgba(0, 0, 0, 0.06)",
  controlsActive: "rgba(0, 0, 0, 0.08)",
  previewBg: "#e4e4e7",
};

const THEME_DARK: Theme = {
  controlsBg: "#1f1f22",
  controlsBorder: "rgba(255, 255, 255, 0.08)",
  controlsText: "rgba(255, 255, 255, 0.85)",
  controlsHover: "rgba(255, 255, 255, 0.08)",
  controlsActive: "rgba(255, 255, 255, 0.12)",
  previewBg: "#000",
};

interface MediaAsset {
  id: string;
  name: string;
  url: string;
  durationMs?: number;
}

const SEED_ASSETS: MediaAsset[] = [
  { id: "asset-sample", name: "sample.mp4", url: SAMPLE_URL, durationMs: 5000 },
];

export function CompositionDemo(): ReactElement {
  const [themeName, setThemeName] = useState<"dark" | "light">("dark");
  const [localeName, setLocaleName] = useState<"en" | "zh">("en");
  const theme = themeName === "dark" ? THEME_DARK : THEME_LIGHT;
  const locale: Partial<Locale> =
    localeName === "zh" ? localeZh : localeEn;

  const [assets, setAssets] = useState<MediaAsset[]>(SEED_ASSETS);

  return (
    <EditorProvider
      defaultProject={EMPTY_PROJECT}
      theme={theme}
      locale={locale}
      keyframes={{ enabled: true }}
      pictureInPicture={{ enabled: true }}
      aspect={{ enabled: true }}
    >
      <div className="composition-shell">
        <header className="composition-header">
          <strong>Primitives demo</strong>
          <span className="composition-header-hint">
            layout entirely host-defined — same theme + i18n tokens as{" "}
            <code>&lt;VideoEditor&gt;</code>
          </span>
          <div className="composition-header-controls">
            <button
              type="button"
              className="composition-chip"
              data-testid="composition-toggle-theme"
              onClick={() =>
                setThemeName((n) => (n === "dark" ? "light" : "dark"))
              }
            >
              Theme: {themeName}
            </button>
            <button
              type="button"
              className="composition-chip"
              data-testid="composition-toggle-locale"
              onClick={() =>
                setLocaleName((n) => (n === "en" ? "zh" : "en"))
              }
            >
              Locale: {localeName}
            </button>
          </div>
        </header>

        <div className="composition-body">
          <MediaList
            assets={assets}
            onAdd={(a) => setAssets((s) => [...s, a])}
          />
          <RightColumn />
        </div>

        <ToolbarRow />

        <TimelinePrimitive />
      </div>
    </EditorProvider>
  );
}

// ---- Left column: host-owned media list ---------------------------------

interface MediaListProps {
  assets: MediaAsset[];
  onAdd: (a: MediaAsset) => void;
}

/** Host-owned side panel. Everything here is user code — no AiCut
 *  primitive prescribes the layout. Clicking an asset adds it to the
 *  editor's project via the raw `useEditor()` API. */
function MediaList({ assets, onAdd }: MediaListProps): ReactElement {
  const editor = useEditor();

  const handleFilePick = (file: File): void => {
    const url = URL.createObjectURL(file);
    const asset: MediaAsset = {
      id: createId("asset"),
      name: file.name,
      url,
    };
    onAdd(asset);
  };

  const dropOntoTimeline = (asset: MediaAsset): void => {
    const project = editor.getProject();
    const sourceId = createId("src");
    const clipId = createId("clip");
    const trackIdx = 0;
    const track = project.tracks[trackIdx];
    if (!track) return;
    const tail = track.clips.reduce(
      (acc, c) => Math.max(acc, c.start + (c.out - c.in)),
      0,
    );
    const durMs = asset.durationMs ?? 5000;
    editor.setProject({
      ...project,
      sources: [
        ...project.sources,
        {
          id: sourceId,
          url: asset.url,
          kind: "video",
          name: asset.name,
          duration: durMs,
        },
      ],
      tracks: project.tracks.map((t, i) =>
        i === trackIdx
          ? {
              ...t,
              clips: [
                ...t.clips,
                { id: clipId, sourceId, in: 0, out: durMs, start: tail },
              ],
            }
          : t,
      ),
    });
  };

  return (
    <aside className="composition-media">
      <div className="composition-media-title">Media</div>
      <ul className="composition-media-list" data-testid="composition-media-list">
        {assets.map((a) => (
          <li
            key={a.id}
            className="composition-media-item"
            data-testid={`composition-media-${a.id}`}
          >
            <span className="composition-media-name">{a.name}</span>
            <button
              type="button"
              className="composition-chip composition-chip-add"
              data-testid={`composition-media-add-${a.id}`}
              onClick={() => dropOntoTimeline(a)}
            >
              + Timeline
            </button>
          </li>
        ))}
        {assets.length === 0 ? (
          <li className="composition-media-empty">No assets yet.</li>
        ) : null}
      </ul>
      <label className="composition-media-upload">
        <input
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFilePick(f);
            e.target.value = "";
          }}
          data-testid="composition-media-file"
        />
        <span className="composition-chip">+ upload</span>
      </label>
    </aside>
  );
}

// ---- Right column: preview stacked on export button ---------------------

function RightColumn(): ReactElement {
  return (
    <section className="composition-right">
      <div className="composition-preview-slot">
        <Preview className="composition-preview" data-testid="composition-preview" />
      </div>
      <ExportBar />
    </section>
  );
}

function ExportBar(): ReactElement {
  const editor = useEditor();
  const [status, setStatus] = useState<string>("");
  const hasClips = useEditorState((e) => {
    return e.getProject().tracks.some((t) => t.clips.length > 0);
  });
  return (
    <div className="composition-export-bar">
      <button
        type="button"
        className="composition-export-button"
        data-testid="composition-export"
        disabled={!hasClips}
        onClick={() => {
          editor.requestExport();
          setStatus("Exported project JSON (see console).");
          setTimeout(() => setStatus(""), 1800);
          // eslint-disable-next-line no-console
          console.log(
            "[composition demo] export requested",
            JSON.stringify(editor.getProject(), null, 2),
          );
        }}
      >
        Export
      </button>
      {status ? <span className="composition-export-hint">{status}</span> : null}
    </div>
  );
}

// ---- Toolbar row: play button centered ----------------------------------

/** Absolute-position the play button in the row's center regardless of
 *  how many buttons sit on either side. The left / right clusters flex
 *  around it. Matches the "播放按钮在按钮栏正中间" requirement. */
function ToolbarRow(): ReactElement {
  return (
    <div className="composition-toolbar" data-testid="composition-toolbar">
      <div className="composition-toolbar-left">
        <UndoButton className="composition-toolbar-btn" />
        <RedoButton className="composition-toolbar-btn" />
        <span className="composition-toolbar-sep" />
        <TrimLeftButton className="composition-toolbar-btn" />
        <SplitButton className="composition-toolbar-btn" />
        <TrimRightButton className="composition-toolbar-btn" />
      </div>
      <div className="composition-toolbar-center">
        <TimeLabel />
        <PlayButton
          className="composition-toolbar-play"
          data-testid="composition-play"
        />
        <DurationLabel />
      </div>
      <div className="composition-toolbar-right">
        <SnapToggle className="composition-toolbar-btn" />
      </div>
    </div>
  );
}
