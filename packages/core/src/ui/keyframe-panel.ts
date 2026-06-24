import type { Editor } from "../editor.js";
import {
  getEffectiveTransform,
  hasKeyframesForProp,
  keyframesForProp,
} from "../keyframes/index.js";
import type { Clip, Keyframe, KeyframeProp } from "../types.js";

const TIME_EPS_MS = 16;

/**
 * Floating numeric panel anchored to the preview's top-left corner.
 * Visible only when keyframe mode is on AND a keyframe is selected.
 *
 * A keyframe is per-property (one of panX / panY / scale), but the
 * UX groups all kfs at the same time into one "moment" — the panel
 * shows the three transform values for that moment. Editing an input
 * upserts the matching prop's keyframe at that exact time; the Reset
 * button writes identity values (0, 0, 1) for all three props at the
 * selected time in a single history step.
 */
export class KeyframePanel {
  private editor: Editor;
  readonly root: HTMLDivElement;
  private inputs: Record<KeyframeProp, HTMLInputElement>;
  private kfBadges: Record<KeyframeProp, HTMLSpanElement>;
  private timeLabel: HTMLSpanElement;
  private resetBtn: HTMLButtonElement;
  private lastSyncKey = "";

  constructor(host: HTMLElement, editor: Editor) {
    this.editor = editor;

    this.root = document.createElement("div");
    this.root.className = "aicut-keyframe-panel";
    this.root.setAttribute("data-testid", "aicut-keyframe-panel");
    this.root.style.display = "none";
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("wheel", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "aicut-keyframe-panel__title";
    const titleLabel = document.createElement("span");
    titleLabel.textContent = "Keyframe";
    this.timeLabel = document.createElement("span");
    this.timeLabel.className = "aicut-keyframe-panel__time";
    title.append(titleLabel, this.timeLabel);
    this.root.appendChild(title);

    this.inputs = {
      panX: this.makeRow("X", "kf-x", "panX", 1),
      panY: this.makeRow("Y", "kf-y", "panY", 1),
      scale: this.makeRow("Scale", "kf-scale", "scale", 0.05),
    };
    this.kfBadges = {
      panX: this.makeBadge(this.inputs.panX),
      panY: this.makeBadge(this.inputs.panY),
      scale: this.makeBadge(this.inputs.scale),
    };

    const actions = document.createElement("div");
    actions.className = "aicut-keyframe-panel__actions";
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "aicut-keyframe-panel__reset";
    this.resetBtn.setAttribute("data-testid", "aicut-keyframe-reset");
    this.resetBtn.textContent = "Reset to 0 0 1";
    this.resetBtn.title =
      "Pin this keyframe to identity (panX=0, panY=0, scale=1)";
    this.resetBtn.addEventListener("click", () => this.onReset());
    actions.appendChild(this.resetBtn);
    this.root.appendChild(actions);

    host.appendChild(this.root);
  }

  destroy(): void {
    this.root.remove();
  }

  render(): void {
    const enabled = this.editor.isKeyframesEnabled();
    const sel = this.editor.getSelectedKeyframe();
    if (!enabled || !sel) {
      this.root.style.display = "none";
      this.lastSyncKey = "";
      return;
    }
    const clip = this.findClip(sel.clipId);
    const anchorKf = clip?.keyframes?.find((k) => k.id === sel.keyframeId);
    if (!clip || !anchorKf) {
      this.root.style.display = "none";
      this.lastSyncKey = "";
      return;
    }
    const time = anchorKf.time;
    // The "moment" — all kfs on this clip within 16ms of the selected
    // kf's time. Usually exactly the 3 sibling kfs from a single
    // toolbar-button click, but we tolerate near-matches.
    const moment = (clip.keyframes ?? []).filter(
      (k) => Math.abs(k.time - time) < TIME_EPS_MS,
    );
    // Values to show: prefer the kf at this exact moment if one
    // exists for the prop; else fall back to the currently interpolated
    // value (held / lerped from other kfs at other times).
    const interp = getEffectiveTransform(clip, time);
    const valueOf = (prop: KeyframeProp): number => {
      const m = moment.find((k) => k.prop === prop);
      if (m) return m.value;
      return interp[prop];
    };
    const v = {
      panX: valueOf("panX"),
      panY: valueOf("panY"),
      scale: valueOf("scale"),
    };
    const syncKey = `${clip.id}|${time}|${v.panX.toFixed(2)}|${v.panY.toFixed(2)}|${v.scale.toFixed(4)}|${moment.map((m) => m.prop).join(",")}`;
    this.root.style.display = "flex";
    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    this.setIfBlur(this.inputs.panX, String(Math.round(v.panX)));
    this.setIfBlur(this.inputs.panY, String(Math.round(v.panY)));
    this.setIfBlur(this.inputs.scale, v.scale.toFixed(2));
    this.timeLabel.textContent = `${(time / 1000).toFixed(2)}s`;

    // Filled dot = a keyframe for THIS prop pins THIS moment.
    // Outlined = no kf at this moment for the prop (the displayed
    // value is interpolated; editing will add a kf at this time).
    for (const p of ["panX", "panY", "scale"] as const) {
      const animated =
        moment.some((k) => k.prop === p) || hasKeyframesForProp(clip, p);
      const pinned = moment.some((k) => k.prop === p);
      this.kfBadges[p].classList.toggle(
        "aicut-keyframe-panel__badge--on",
        pinned,
      );
      this.kfBadges[p].title = pinned
        ? "Pinned at this moment"
        : animated
          ? "Animated — but not pinned at this exact moment"
          : "Static value";
    }
    // Reset enabled when we have a clip + time to write into.
    this.resetBtn.disabled = false;
  }

  // ---- internals ------------------------------------------------------

  private makeRow(
    label: string,
    testId: string,
    prop: KeyframeProp,
    step: number,
  ): HTMLInputElement {
    const row = document.createElement("div");
    row.className = "aicut-keyframe-panel__row";
    const lab = document.createElement("label");
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(step);
    input.setAttribute("data-testid", `aicut-${testId}`);
    input.addEventListener("blur", () => this.commit(prop, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
    row.append(lab, input);
    this.root.appendChild(row);
    return input;
  }

  private makeBadge(input: HTMLInputElement): HTMLSpanElement {
    const dot = document.createElement("span");
    dot.className = "aicut-keyframe-panel__badge";
    input.parentElement?.appendChild(dot);
    return dot;
  }

  private commit(prop: KeyframeProp, raw: string): void {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const sel = this.editor.getSelectedKeyframe();
    if (!sel) return;
    const clip = this.findClip(sel.clipId);
    const anchorKf = clip?.keyframes?.find((k) => k.id === sel.keyframeId);
    if (!clip || !anchorKf) return;
    // Upsert this prop's kf at the selected moment. addKeyframe with
    // an explicit time handles upsert via the underlying helper.
    this.editor.addKeyframe(sel.clipId, prop, {
      time: anchorKf.time,
      value: num,
    });
    // If the anchor kf is for this prop, the upsert just updated its
    // value — keep selection. Else a new kf was created at the same
    // time; select THAT one so the user can keep editing it.
    if (anchorKf.prop !== prop) {
      const refreshedClip = this.findClip(sel.clipId);
      const created = (refreshedClip?.keyframes ?? []).find(
        (k) =>
          k.prop === prop && Math.abs(k.time - anchorKf.time) < TIME_EPS_MS,
      );
      if (created) {
        this.editor.setSelectedKeyframe({
          clipId: sel.clipId,
          keyframeId: created.id,
        });
      }
    }
  }

  private onReset(): void {
    const sel = this.editor.getSelectedKeyframe();
    if (!sel) return;
    const clip = this.findClip(sel.clipId);
    const anchorKf = clip?.keyframes?.find((k) => k.id === sel.keyframeId);
    if (!clip || !anchorKf) return;
    this.editor.resetKeyframesAtTime(sel.clipId, anchorKf.time);
  }

  private setIfBlur(input: HTMLInputElement, value: string): void {
    if (document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  private findClip(clipId: string): Clip | null {
    const project = this.editor.getProject();
    for (const t of project.tracks) {
      const c = t.clips.find((cl) => cl.id === clipId);
      if (c) return c;
    }
    return null;
  }
}
// Re-export internal helper for tests / docs that want to walk the
// per-prop keyframe lists with the same sort the panel uses.
export { keyframesForProp };
