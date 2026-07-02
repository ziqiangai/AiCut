/**
 * API playground — one card per new/refactored AI-facing API on
 * @aicut/react (splitClip, moveClipTo, trimClip, deleteClip, addClip,
 * captureFrame, batch, findClipAt, getClipsOnTrack, findGapsOnTrack).
 *
 * Each card:
 *   1. A form bound to that method's params.
 *   2. A "Run" button.
 *   3. A pretty-printed response log.
 *
 * The editor lives in an <EditorProvider>, same seed project as the
 * composition demo, with a live <Preview> + <TimelinePrimitive> on
 * the right so mutations are visible immediately.
 *
 * Purpose: dogfood the ergonomics of the new API surface before
 * wiring AI on top of it. If a form feels awkward here, an LLM tool
 * call built from the same shape will feel worse.
 */
import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  EditorProvider,
  Preview,
  TimelinePrimitive,
  useEditor,
  createId,
  timelineToSourceMs,
  sourceToTimelineMs,
  findClipAt,
  getClipsOnTrack,
  getClipsInRange,
  canvasCompositorEngineFactory,
  type Project,
  type Theme,
} from "@aicut/react";
import "@aicut/core/styles.css";

const SAMPLE_URL =
  (import.meta.env.VITE_PRELOAD_VIDEO_URL as string | undefined) ||
  "/sample.mp4";

function makeSeedProject(): Project {
  const sourceId = createId("src");
  return {
    version: 1,
    sources: [
      {
        id: sourceId,
        url: SAMPLE_URL,
        kind: "video",
        name: "sample.mp4",
        duration: 5000,
      },
    ],
    tracks: [
      {
        id: "track-0",
        kind: "video",
        clips: [
          {
            id: "clip-0",
            sourceId,
            in: 0,
            out: 5000,
            start: 0,
          },
        ],
      },
      { id: "track-1", kind: "video", clips: [] },
    ],
  };
}

const THEME: Theme = {
  controlsBg: "#1f1f22",
  controlsBorder: "rgba(255, 255, 255, 0.08)",
  controlsText: "rgba(255, 255, 255, 0.85)",
  controlsHover: "rgba(255, 255, 255, 0.08)",
  controlsActive: "rgba(255, 255, 255, 0.12)",
  previewBg: "#141416",
};

export function ApiPlayground(): ReactElement {
  const [seedProject] = useState(() => makeSeedProject());
  return (
    // CanvasCompositorEngine so composite frame capture actually works —
    // HtmlVideoEngine has no <canvas> to read from.
    <EditorProvider
      defaultProject={seedProject}
      theme={THEME}
      playbackEngine={canvasCompositorEngineFactory}
      keyframes={{ enabled: true }}
      pictureInPicture={{ enabled: true }}
      aspect={{ enabled: true }}
    >
      <div className="apiplay-shell">
        <div className="apiplay-header">
          <strong>API playground</strong>
          <span className="apiplay-hint">
            Every card = one AI-facing method. Fire, watch the timeline
            respond, read the typed EditResult.
          </span>
        </div>
        <div className="apiplay-body">
          <aside className="apiplay-cards">
            <StateSnapshot />
            <SplitCard />
            <MoveClipCard />
            <TrimCard />
            <DeleteCard />
            <AddClipCard />
            <BatchCard />
            <CaptureFrameCard />
            <QueryCard />
          </aside>
          <section className="apiplay-preview">
            <Preview className="apiplay-preview-video" />
            <TimelinePrimitive />
          </section>
        </div>
      </div>
    </EditorProvider>
  );
}

// ── Cards ─────────────────────────────────────────────────────────

/** `useEditorState` compares snapshots by reference — passing
 *  `getProject()` (which returns a fresh JSON.parse clone every call)
 *  triggers an infinite render loop. Bump a counter on `change`
 *  events instead, then read-through in render. */
function useProjectSnapshot(): Project {
  const editor = useEditor();
  const [, setBump] = useState(0);
  useEffect(() => {
    const off = editor.on("change", () => setBump((b) => b + 1));
    return () => off();
  }, [editor]);
  return editor.getProject();
}

function StateSnapshot(): ReactElement {
  const editor = useEditor();
  const project = useProjectSnapshot();
  return (
    <Card
      title="State snapshot"
      description="Current project JSON — feeds the input fields below. Refreshes on every mutation."
    >
      <div className="apiplay-snapshot">
        {project.tracks.map((t, ti) => (
          <div key={t.id} className="apiplay-track-row">
            <span className="apiplay-track-label">
              {ti}. {t.id}
            </span>
            <div className="apiplay-track-clips">
              {t.clips.length === 0 ? (
                <em className="apiplay-empty">empty</em>
              ) : (
                t.clips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="apiplay-clip-chip"
                    title={`in=${c.in} out=${c.out} start=${c.start}`}
                    onClick={() => editor.seek(c.start)}
                  >
                    {c.id} · {c.start}→{c.start + (c.out - c.in)}ms
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SplitCard(): ReactElement {
  const editor = useEditor();
  const [clipId, setClipId] = useState("clip-0");
  const [timeMs, setTimeMs] = useState(2500);
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="splitClip"
      description="Split a specific clip at a timeline-absolute time. Fails cleanly outside range."
      docTag="EditResult<{ newClipIds: [string, string] }>"
    >
      <Field label="clipId">
        <input value={clipId} onChange={(e) => setClipId(e.target.value)} />
      </Field>
      <Field label="timeMs">
        <input
          type="number"
          value={timeMs}
          onChange={(e) => setTimeMs(Number(e.target.value))}
        />
      </Field>
      <RunRow
        onClick={() => setResult(editor.splitClip({ clipId, timeMs }))}
        result={result}
      />
    </Card>
  );
}

function MoveClipCard(): ReactElement {
  const editor = useEditor();
  const [clipId, setClipId] = useState("clip-0");
  const [toTrackId, setToTrackId] = useState("track-1");
  const [startMs, setStartMs] = useState(0);
  const [onOverlap, setOnOverlap] = useState<"error" | "auto">("error");
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="moveClipTo"
      description="Move clip to explicit destination. 'error' overlaps refuse; 'auto' smart-routes."
      docTag="EditResult<{ clipId, trackId, startMs }>"
    >
      <Field label="clipId">
        <input value={clipId} onChange={(e) => setClipId(e.target.value)} />
      </Field>
      <Field label="toTrackId">
        <input
          value={toTrackId}
          onChange={(e) => setToTrackId(e.target.value)}
        />
      </Field>
      <Field label="startMs">
        <input
          type="number"
          value={startMs}
          onChange={(e) => setStartMs(Number(e.target.value))}
        />
      </Field>
      <Field label="onOverlap">
        <select
          value={onOverlap}
          onChange={(e) =>
            setOnOverlap(e.target.value as "error" | "auto")
          }
        >
          <option value="error">error (strict)</option>
          <option value="auto">auto (smart-route)</option>
        </select>
      </Field>
      <RunRow
        onClick={() =>
          setResult(
            editor.moveClipTo({
              clipId,
              toTrackId: toTrackId || undefined,
              startMs,
              onOverlap,
            }),
          )
        }
        result={result}
      />
    </Card>
  );
}

function TrimCard(): ReactElement {
  const editor = useEditor();
  const [clipId, setClipId] = useState("clip-0");
  const [edge, setEdge] = useState<"left" | "right">("left");
  const [timeMs, setTimeMs] = useState(1000);
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="trimClip"
      description="Move one edge of a clip to a timeline time. Predictable — no ripple, no track side effects."
      docTag="EditResult<{ clipId }>"
    >
      <Field label="clipId">
        <input value={clipId} onChange={(e) => setClipId(e.target.value)} />
      </Field>
      <Field label="edge">
        <select
          value={edge}
          onChange={(e) => setEdge(e.target.value as "left" | "right")}
        >
          <option value="left">left</option>
          <option value="right">right</option>
        </select>
      </Field>
      <Field label="timeMs">
        <input
          type="number"
          value={timeMs}
          onChange={(e) => setTimeMs(Number(e.target.value))}
        />
      </Field>
      <RunRow
        onClick={() => setResult(editor.trimClip({ clipId, edge, timeMs }))}
        result={result}
      />
    </Card>
  );
}

function DeleteCard(): ReactElement {
  const editor = useEditor();
  const [clipId, setClipId] = useState("clip-0");
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="deleteClip"
      description="Remove a clip by id."
      docTag="EditResult<{ clipId }>"
    >
      <Field label="clipId">
        <input value={clipId} onChange={(e) => setClipId(e.target.value)} />
      </Field>
      <RunRow
        onClick={() => setResult(editor.deleteClip({ clipId }))}
        result={result}
      />
    </Card>
  );
}

function AddClipCard(): ReactElement {
  const editor = useEditor();
  const [sourceUrl, setSourceUrl] = useState(SAMPLE_URL);
  const [sourceId, setSourceId] = useState("");
  const [trackId, setTrackId] = useState("track-1");
  const [startMs, setStartMs] = useState(0);
  const [inMs, setInMs] = useState<string>("");
  const [outMs, setOutMs] = useState<string>("");
  const [onOverlap, setOnOverlap] = useState<"error" | "auto">("error");
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="addClip"
      description="One-shot: probe URL for duration, register as source, insert clip. Async."
      docTag="Promise<EditResult<{ clipId, sourceId }>>"
    >
      <Field label="sourceUrl">
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="/sample.mp4 or https://..."
        />
      </Field>
      <Field label="sourceId (alt)">
        <input
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          placeholder="reuse existing source instead of probing URL"
        />
      </Field>
      <Field label="trackId">
        <input value={trackId} onChange={(e) => setTrackId(e.target.value)} />
      </Field>
      <Field label="startMs">
        <input
          type="number"
          value={startMs}
          onChange={(e) => setStartMs(Number(e.target.value))}
        />
      </Field>
      <Field label="inMs (opt)">
        <input
          type="number"
          value={inMs}
          onChange={(e) => setInMs(e.target.value)}
        />
      </Field>
      <Field label="outMs (opt)">
        <input
          type="number"
          value={outMs}
          onChange={(e) => setOutMs(e.target.value)}
        />
      </Field>
      <Field label="onOverlap">
        <select
          value={onOverlap}
          onChange={(e) =>
            setOnOverlap(e.target.value as "error" | "auto")
          }
        >
          <option value="error">error</option>
          <option value="auto">auto</option>
        </select>
      </Field>
      <RunRow
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await editor.addClip({
              ...(sourceId ? { sourceId } : { sourceUrl }),
              trackId,
              startMs,
              ...(inMs !== "" ? { inMs: Number(inMs) } : {}),
              ...(outMs !== "" ? { outMs: Number(outMs) } : {}),
              onOverlap,
            });
            setResult(r);
          } catch (e) {
            setResult({ ok: false, threw: String(e) });
          } finally {
            setBusy(false);
          }
        }}
        result={result}
      />
    </Card>
  );
}

function BatchCard(): ReactElement {
  const editor = useEditor();
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="batch"
      description="Group N mutations into one undo entry. Example: split @ 1500 + split @ 3000 in one gesture."
      docTag="batch(label, fn) → T | Promise<T>"
    >
      <RunRow
        onClick={() => {
          try {
            const out = editor.batch("split-and-split", () => {
              const a = editor.splitClip({
                clipId: "clip-0",
                timeMs: 1500,
              });
              if (!a.ok) return { first: a };
              const b = editor.splitClip({
                clipId: a.data.newClipIds[1],
                timeMs: 3000,
              });
              return { first: a, second: b };
            });
            setResult({ ok: true, ...out });
          } catch (e) {
            setResult({ ok: false, threw: String(e) });
          }
        }}
        result={result}
      />
      <button
        type="button"
        className="apiplay-secondary"
        onClick={() => editor.undo()}
      >
        undo (should revert BOTH splits — proves batching works)
      </button>
    </Card>
  );
}

function CaptureFrameCard(): ReactElement {
  const editor = useEditor();
  const [timeMs, setTimeMs] = useState(2500);
  const [source, setSource] = useState<"composite" | "raw">("composite");
  const [clipId, setClipId] = useState("clip-0");
  const [maxWidth, setMaxWidth] = useState(640);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="captureFrame"
      description="Grab a still frame as a JPEG/PNG Blob. Composite = what user sees; raw = source pixel. Async."
      docTag="Promise<EditResult<{ blob, width, height }>>"
    >
      <Field label="timeMs">
        <input
          type="number"
          value={timeMs}
          onChange={(e) => setTimeMs(Number(e.target.value))}
        />
      </Field>
      <Field label="source">
        <select
          value={source}
          onChange={(e) =>
            setSource(e.target.value as "composite" | "raw")
          }
        >
          <option value="composite">composite</option>
          <option value="raw">raw (needs clipId)</option>
        </select>
      </Field>
      {source === "raw" ? (
        <Field label="clipId">
          <input value={clipId} onChange={(e) => setClipId(e.target.value)} />
        </Field>
      ) : null}
      <Field label="maxWidth">
        <input
          type="number"
          value={maxWidth}
          onChange={(e) => setMaxWidth(Number(e.target.value))}
        />
      </Field>
      <RunRow
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await editor.captureFrame({
              timeMs,
              source,
              clipId: source === "raw" ? clipId : undefined,
              maxWidth,
              format: "image/jpeg",
            });
            if (r.ok) {
              setPreview((old) => {
                if (old) URL.revokeObjectURL(old);
                return URL.createObjectURL(r.data.blob);
              });
              setResult({
                ok: true,
                width: r.data.width,
                height: r.data.height,
                bytes: r.data.blob.size,
              });
            } else {
              setResult(r);
            }
          } catch (e) {
            setResult({ ok: false, threw: String(e) });
          } finally {
            setBusy(false);
          }
        }}
        result={result}
      />
      {preview ? (
        <img
          src={preview}
          alt="captured frame"
          className="apiplay-thumb"
          style={{ maxWidth: 320 }}
        />
      ) : null}
    </Card>
  );
}

function QueryCard(): ReactElement {
  const editor = useEditor();
  const [timeMs, setTimeMs] = useState(1500);
  const [trackIdx, setTrackIdx] = useState(0);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(5000);
  const [result, setResult] = useState<unknown>(null);
  return (
    <Card
      title="pure query helpers"
      description="findClipAt / getClipsOnTrack / getClipsInRange / timelineToSourceMs. All pure — no mutation."
      docTag="from @aicut/react"
    >
      <Field label="timeMs (for findClipAt)">
        <input
          type="number"
          value={timeMs}
          onChange={(e) => setTimeMs(Number(e.target.value))}
        />
      </Field>
      <Field label="trackIndex">
        <input
          type="number"
          value={trackIdx}
          onChange={(e) => setTrackIdx(Number(e.target.value))}
        />
      </Field>
      <Field label="range [start, end)">
        <div style={{ display: "flex", gap: 4 }}>
          <input
            type="number"
            value={rangeStart}
            onChange={(e) => setRangeStart(Number(e.target.value))}
          />
          <input
            type="number"
            value={rangeEnd}
            onChange={(e) => setRangeEnd(Number(e.target.value))}
          />
        </div>
      </Field>
      <RunRow
        onClick={() => {
          const p = editor.getProject();
          const at = findClipAt(p, timeMs);
          const onTrack = getClipsOnTrack(p, trackIdx);
          const inRange = getClipsInRange(p, rangeStart, rangeEnd);
          // Demo the time-conversion helpers too.
          const clockDemo =
            onTrack[0] != null
              ? {
                  timelineToSource: timelineToSourceMs(onTrack[0], 1000),
                  sourceToTimeline: sourceToTimelineMs(onTrack[0], 1000),
                }
              : null;
          setResult({
            findClipAt: at
              ? { clipId: at.clip.id, trackId: at.track.id }
              : null,
            "getClipsOnTrack(#{idx})": onTrack.map((c) => c.id),
            "getClipsInRange": inRange.map((h) => ({
              clip: h.clip.id,
              track: h.trackIndex,
            })),
            clockDemo,
          });
        }}
        result={result}
      />
    </Card>
  );
}

// ── Card primitives ────────────────────────────────────────────────

function Card({
  title,
  description,
  docTag,
  children,
}: {
  title: string;
  description: string;
  docTag?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="apiplay-card" data-testid={`apiplay-card-${title}`}>
      <div className="apiplay-card-header">
        <div>
          <div className="apiplay-card-title">{title}</div>
          {docTag ? <code className="apiplay-card-tag">{docTag}</code> : null}
        </div>
      </div>
      <div className="apiplay-card-desc">{description}</div>
      <div className="apiplay-card-body">{children}</div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="apiplay-field">
      <span className="apiplay-field-label">{label}</span>
      <span className="apiplay-field-input">{children}</span>
    </label>
  );
}

function RunRow({
  onClick,
  result,
  busy,
}: {
  onClick: () => void;
  result: unknown;
  busy?: boolean;
}): ReactElement {
  return (
    <>
      <div className="apiplay-run-row">
        <button
          type="button"
          className="apiplay-run-btn"
          onClick={onClick}
          disabled={busy}
        >
          {busy ? "…" : "Run"}
        </button>
        {result != null ? (
          <span
            className={`apiplay-status ${
              (result as { ok?: boolean })?.ok === true
                ? "ok"
                : (result as { ok?: boolean })?.ok === false
                  ? "err"
                  : ""
            }`}
          >
            {(result as { ok?: boolean })?.ok === true
              ? "ok"
              : (result as { ok?: boolean })?.ok === false
                ? (result as { reason?: string }).reason ?? "err"
                : ""}
          </span>
        ) : null}
      </div>
      {result != null ? (
        <pre className="apiplay-result">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </>
  );
}
