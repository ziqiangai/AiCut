import { useEffect, useMemo, useState } from "react";
import {
  getEffectiveTransform,
  type EffectiveTransform,
  type Project,
  type VideoEditorApi,
} from "@aicut/react";

interface KeyframePanelProps {
  api: VideoEditorApi | null;
  /** Bumped on every editor "change" / "time" event so the panel
   *  re-reads the live project + interpolated values. The actual
   *  number isn't used — it's just a render trigger. */
  tick: number;
  selectedClipId: string | null;
  selectedKeyframe: { clipId: string; keyframeId: string } | null;
}

/**
 * Sidebar panel for the demo. Shown when keyframe mode is on AND the
 * user has selected a clip. Lets the user:
 *   - Read the currently-interpolated X / Y / Scale at the playhead
 *   - Edit the values of the selected keyframe (if any)
 *   - Add a keyframe at the playhead (defaults values to the currently
 *     interpolated transform — never visually jumps)
 *   - Delete the selected keyframe
 *
 * Numeric inputs use small step sizes to make experimentation cheap.
 */
export function KeyframePanel(props: KeyframePanelProps) {
  const { api, selectedClipId, selectedKeyframe } = props;

  // Pull the live project + selected clip + interpolated transform.
  const project: Project | null = api?.getProject() ?? null;
  const clip = useMemo(() => {
    if (!project || !selectedClipId) return null;
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === selectedClipId);
      if (c) return c;
    }
    return null;
  }, [project, selectedClipId, props.tick]);

  // Currently effective transform at the playhead — what the editor
  // would render right now. Doubles as the "default values" for a new
  // keyframe so adding doesn't jump the preview.
  const effective: EffectiveTransform = useMemo(() => {
    if (!api || !clip) return { x: 0, y: 0, scale: 1 };
    const local = api.getTime() - clip.start;
    return getEffectiveTransform(clip, local);
  }, [api, clip, props.tick]);

  // The selected keyframe object (if it still exists — it can vanish
  // from undo).
  const selectedKf = useMemo(() => {
    if (!clip || !selectedKeyframe) return null;
    if (selectedKeyframe.clipId !== clip.id) return null;
    return clip.keyframes?.find((k) => k.id === selectedKeyframe.keyframeId)
      ?? null;
  }, [clip, selectedKeyframe]);

  // Editable values come from the selected keyframe when one exists,
  // otherwise from the currently interpolated transform (so the
  // numbers reflect what the user sees on screen).
  const baseX = selectedKf?.x ?? effective.x;
  const baseY = selectedKf?.y ?? effective.y;
  const baseScale = selectedKf?.scale ?? effective.scale;

  // Local input state so typing isn't laggy — flushed to the editor
  // on commit (Enter / blur).
  const [draftX, setDraftX] = useState(String(Math.round(baseX)));
  const [draftY, setDraftY] = useState(String(Math.round(baseY)));
  const [draftScale, setDraftScale] = useState(baseScale.toFixed(2));
  useEffect(() => setDraftX(String(Math.round(baseX))), [baseX]);
  useEffect(() => setDraftY(String(Math.round(baseY))), [baseY]);
  useEffect(() => setDraftScale(baseScale.toFixed(2)), [baseScale]);

  if (!clip) {
    return (
      <p className="demo-engine-help">
        Select a clip on the timeline to add or edit keyframes.
      </p>
    );
  }

  const commit = (axis: "x" | "y" | "scale", raw: string) => {
    if (!api) return;
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    if (selectedKf) {
      api.setKeyframeValues(clip.id, selectedKf.id, { [axis]: num });
    } else {
      // No keyframe selected → adding one at the playhead is the
      // CapCut-style "auto-keyframe" behavior. We compose the new
      // value with the currently interpolated ones so the preview
      // doesn't jump on the unedited axes.
      const time = Math.round(api.getTime() - clip.start);
      api.addKeyframe(clip.id, {
        time,
        x: axis === "x" ? num : effective.x,
        y: axis === "y" ? num : effective.y,
        scale: axis === "scale" ? num : effective.scale,
      });
    }
  };

  const onAddAtPlayhead = () => {
    if (!api) return;
    const time = Math.round(api.getTime() - clip.start);
    api.addKeyframe(clip.id, {
      time,
      x: effective.x,
      y: effective.y,
      scale: effective.scale,
    });
  };

  const onDelete = () => {
    if (!api || !selectedKf) return;
    api.removeKeyframe(clip.id, selectedKf.id);
  };

  return (
    <div className="demo-kf-panel" data-testid="demo-kf-panel">
      <div className="demo-kf-row">
        <label>X</label>
        <input
          type="number"
          step={1}
          value={draftX}
          data-testid="demo-kf-x"
          onChange={(e) => setDraftX(e.target.value)}
          onBlur={() => commit("x", draftX)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="demo-kf-row">
        <label>Y</label>
        <input
          type="number"
          step={1}
          value={draftY}
          data-testid="demo-kf-y"
          onChange={(e) => setDraftY(e.target.value)}
          onBlur={() => commit("y", draftY)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="demo-kf-row">
        <label>Scale</label>
        <input
          type="number"
          step={0.05}
          value={draftScale}
          data-testid="demo-kf-scale"
          onChange={(e) => setDraftScale(e.target.value)}
          onBlur={() => commit("scale", draftScale)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="demo-kf-actions">
        <button
          type="button"
          data-testid="demo-kf-add"
          onClick={onAddAtPlayhead}
        >
          + Add at playhead
        </button>
        <button
          type="button"
          data-testid="demo-kf-delete"
          disabled={selectedKf == null}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
      <p className="demo-engine-help">
        {selectedKf
          ? `Editing keyframe at ${(selectedKf.time / 1000).toFixed(2)}s.`
          : "No keyframe selected — values from interpolation. Edit a field to auto-add one at the playhead."}
        {" "}
        {clip.keyframes?.length ?? 0} keyframe(s) on this clip.
      </p>
    </div>
  );
}
