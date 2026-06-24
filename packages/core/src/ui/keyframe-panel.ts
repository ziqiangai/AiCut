import type { Editor } from "../editor.js";
import type { Locale } from "../i18n.js";
import {
  getEffectiveTransform,
  hasKeyframesForProp,
  keyframesForProp,
} from "../keyframes/index.js";
import type { Clip, EasingKind, Keyframe, KeyframeProp } from "../types.js";

const EASING_VALUES: EasingKind[] = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
];
function easingLabel(value: EasingKind, locale: Locale): string {
  switch (value) {
    case "linear":
      return locale.keyframeEasingLinear;
    case "easeIn":
      return locale.keyframeEasingEaseIn;
    case "easeOut":
      return locale.keyframeEasingEaseOut;
    case "easeInOut":
      return locale.keyframeEasingEaseInOut;
  }
}

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
  private locale: Locale;
  readonly root: HTMLDivElement;
  private inputs: Record<KeyframeProp, HTMLInputElement>;
  private kfBadges: Record<KeyframeProp, HTMLSpanElement>;
  private timeLabel: HTMLSpanElement;
  private titleLabel!: HTMLSpanElement;
  private resetBtn: HTMLButtonElement;
  private easingTrigger!: HTMLButtonElement;
  private easingTriggerLabel!: HTMLSpanElement;
  private easingMenu!: HTMLUListElement;
  private easingItems!: Map<EasingKind, HTMLLIElement>;
  private easingValue: EasingKind = "linear";
  private easingDisabled = false;
  private easingOpen = false;
  private easingLabelEl!: HTMLLabelElement;
  private rowLabels!: Record<KeyframeProp, HTMLLabelElement>;
  private lastSyncKey = "";
  // Bound once so add/remove listener pairs reference the same fn.
  private boundOutsideClick: ((e: MouseEvent) => void) | null = null;
  private boundDocKeydown: ((e: KeyboardEvent) => void) | null = null;

  constructor(host: HTMLElement, editor: Editor, locale: Locale) {
    this.editor = editor;
    this.locale = locale;

    this.root = document.createElement("div");
    this.root.className = "aicut-keyframe-panel";
    this.root.setAttribute("data-testid", "aicut-keyframe-panel");
    this.root.style.display = "none";
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("wheel", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "aicut-keyframe-panel__title";
    this.titleLabel = document.createElement("span");
    this.timeLabel = document.createElement("span");
    this.timeLabel.className = "aicut-keyframe-panel__time";
    title.append(this.titleLabel, this.timeLabel);
    this.root.appendChild(title);

    const xRow = this.makeRow("kf-x", "panX", 1);
    const yRow = this.makeRow("kf-y", "panY", 1);
    const scaleRow = this.makeRow("kf-scale", "scale", 0.05);
    this.inputs = {
      panX: xRow.input,
      panY: yRow.input,
      scale: scaleRow.input,
    };
    this.rowLabels = {
      panX: xRow.label,
      panY: yRow.label,
      scale: scaleRow.label,
    };
    this.kfBadges = {
      panX: this.makeBadge(this.inputs.panX),
      panY: this.makeBadge(this.inputs.panY),
      scale: this.makeBadge(this.inputs.scale),
    };

    // Easing — one dropdown applies to all three props at this moment.
    // Shapes the curve from THIS moment to the next kf on each prop.
    // Custom dropdown (not native <select>) so the floating panel can
    // be themed consistently across browsers — native <option> styling
    // is OS-locked and looks foreign next to the rest of the panel.
    const easingRow = document.createElement("div");
    easingRow.className =
      "aicut-keyframe-panel__row aicut-keyframe-panel__row--easing";
    this.easingLabelEl = document.createElement("label");

    const dd = document.createElement("div");
    dd.className = "aicut-keyframe-panel__dropdown";
    dd.setAttribute("data-testid", "aicut-kf-easing");

    this.easingTrigger = document.createElement("button");
    this.easingTrigger.type = "button";
    this.easingTrigger.className = "aicut-keyframe-panel__dropdown-trigger";
    this.easingTrigger.setAttribute("aria-haspopup", "listbox");
    this.easingTrigger.setAttribute("aria-expanded", "false");
    this.easingTriggerLabel = document.createElement("span");
    this.easingTriggerLabel.className =
      "aicut-keyframe-panel__dropdown-trigger-label";
    const chevron = document.createElement("span");
    chevron.className = "aicut-keyframe-panel__dropdown-chevron";
    chevron.setAttribute("aria-hidden", "true");
    this.easingTrigger.append(this.easingTriggerLabel, chevron);
    this.easingTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.easingDisabled) return;
      this.toggleEasingMenu();
    });
    this.easingTrigger.addEventListener("keydown", (e) => {
      if (this.easingDisabled) return;
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        if (!this.easingOpen) this.openEasingMenu();
        // Focus the currently selected item so arrows step from there.
        this.easingItems.get(this.easingValue)?.focus();
      }
    });

    this.easingMenu = document.createElement("ul");
    this.easingMenu.className = "aicut-keyframe-panel__dropdown-menu";
    this.easingMenu.setAttribute("role", "listbox");
    this.easingMenu.style.display = "none";
    this.easingItems = new Map();
    for (const value of EASING_VALUES) {
      const li = document.createElement("li");
      li.className = "aicut-keyframe-panel__dropdown-item";
      li.setAttribute("role", "option");
      li.setAttribute("data-value", value);
      li.setAttribute("tabindex", "-1");
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectEasing(value);
      });
      li.addEventListener("keydown", (e) => this.onMenuKeydown(e, value));
      this.easingItems.set(value, li);
      this.easingMenu.appendChild(li);
    }

    dd.append(this.easingTrigger, this.easingMenu);
    easingRow.append(this.easingLabelEl, dd);
    this.root.appendChild(easingRow);

    const actions = document.createElement("div");
    actions.className = "aicut-keyframe-panel__actions";
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "aicut-keyframe-panel__reset";
    this.resetBtn.setAttribute("data-testid", "aicut-keyframe-reset");
    this.resetBtn.addEventListener("click", () => this.onReset());
    actions.appendChild(this.resetBtn);
    this.root.appendChild(actions);

    // Paint all locale-driven text up front. setLocale() reuses this.
    this.applyLocaleText();

    host.appendChild(this.root);
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.applyLocaleText();
    // Force a render so the time-suffix / badge tooltips also refresh
    // (those are written inside render()'s value path).
    this.lastSyncKey = "";
    this.render();
  }

  private applyLocaleText(): void {
    this.titleLabel.textContent = this.locale.keyframePanelTitle;
    this.rowLabels.panX.textContent = this.locale.keyframePanelLabelX;
    this.rowLabels.panY.textContent = this.locale.keyframePanelLabelY;
    this.rowLabels.scale.textContent = this.locale.keyframePanelLabelScale;
    this.easingLabelEl.textContent = this.locale.keyframePanelLabelEasing;
    this.resetBtn.textContent = this.locale.keyframePanelReset;
    this.resetBtn.title = this.locale.keyframePanelResetTitle;
    // Re-label each menu item + the trigger's visible label.
    for (const [value, li] of this.easingItems) {
      li.textContent = easingLabel(value, this.locale);
    }
    this.easingTriggerLabel.textContent = easingLabel(
      this.easingValue,
      this.locale,
    );
  }

  destroy(): void {
    // Make sure the document-level listeners detached if the panel is
    // torn down while the menu was open (e.g. editor.destroy() during
    // an interaction).
    this.closeEasingMenu();
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
    // Easing shown in the dropdown — the moment's "shared" easing,
    // which is the common value across panX/panY/scale at this time.
    // If they diverge we surface the anchor kf's easing (the one the
    // user clicked); changing the dropdown re-syncs all three.
    const sharedEasing = (() => {
      if (moment.length === 0) return "linear" as EasingKind;
      const anchor = moment.find((k) => k.id === sel.keyframeId) ?? moment[0]!;
      return anchor.easing ?? "linear";
    })();
    const syncKey = `${clip.id}|${time}|${v.panX.toFixed(2)}|${v.panY.toFixed(2)}|${v.scale.toFixed(4)}|${moment.map((m) => m.prop).join(",")}|${sharedEasing}`;
    this.root.style.display = "flex";
    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    this.setIfBlur(this.inputs.panX, String(Math.round(v.panX)));
    this.setIfBlur(this.inputs.panY, String(Math.round(v.panY)));
    this.setIfBlur(this.inputs.scale, v.scale.toFixed(2));
    this.timeLabel.textContent = `${(time / 1000).toFixed(2)}${this.locale.keyframePanelTimeSuffix}`;
    this.setEasingValue(sharedEasing);
    // Disable when there's no kf at this moment to attach easing to —
    // panel can also surface for "future kf" cases where the moment
    // array is empty.
    this.setEasingDisabled(moment.length === 0);

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
        ? this.locale.keyframePanelBadgePinned
        : animated
          ? this.locale.keyframePanelBadgeAnimated
          : this.locale.keyframePanelBadgeStatic;
    }
    // Reset enabled when we have a clip + time to write into.
    this.resetBtn.disabled = false;
  }

  // ---- internals ------------------------------------------------------

  private makeRow(
    testId: string,
    prop: KeyframeProp,
    step: number,
  ): { input: HTMLInputElement; label: HTMLLabelElement } {
    const row = document.createElement("div");
    row.className = "aicut-keyframe-panel__row";
    const lab = document.createElement("label");
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
    return { input, label: lab };
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

  // ---- custom dropdown -------------------------------------------------

  private setEasingValue(value: EasingKind): void {
    if (this.easingValue === value) return;
    this.easingValue = value;
    this.easingTriggerLabel.textContent = easingLabel(value, this.locale);
    for (const [v, li] of this.easingItems) {
      li.classList.toggle(
        "aicut-keyframe-panel__dropdown-item--selected",
        v === value,
      );
      li.setAttribute("aria-selected", v === value ? "true" : "false");
    }
  }

  private setEasingDisabled(disabled: boolean): void {
    if (this.easingDisabled === disabled) return;
    this.easingDisabled = disabled;
    this.easingTrigger.disabled = disabled;
    this.easingTrigger.classList.toggle(
      "aicut-keyframe-panel__dropdown-trigger--disabled",
      disabled,
    );
    if (disabled && this.easingOpen) this.closeEasingMenu();
  }

  private toggleEasingMenu(): void {
    if (this.easingOpen) this.closeEasingMenu();
    else this.openEasingMenu();
  }

  private openEasingMenu(): void {
    if (this.easingOpen || this.easingDisabled) return;
    this.easingOpen = true;
    this.easingMenu.style.display = "";
    this.easingTrigger.setAttribute("aria-expanded", "true");
    this.easingTrigger.classList.add(
      "aicut-keyframe-panel__dropdown-trigger--open",
    );
    // rAF defers the listeners so the same click event that opened
    // the menu doesn't immediately close it via the outside-click path.
    requestAnimationFrame(() => {
      if (!this.easingOpen) return;
      this.boundOutsideClick = (e: MouseEvent) => {
        if (!this.easingMenu.contains(e.target as Node)
          && !this.easingTrigger.contains(e.target as Node)) {
          this.closeEasingMenu();
        }
      };
      this.boundDocKeydown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          this.closeEasingMenu();
          this.easingTrigger.focus();
        } else if (e.key === "Tab") {
          // Tabbing out should close the menu.
          this.closeEasingMenu();
        }
      };
      document.addEventListener("click", this.boundOutsideClick, true);
      document.addEventListener("keydown", this.boundDocKeydown);
    });
  }

  private closeEasingMenu(): void {
    if (!this.easingOpen) return;
    this.easingOpen = false;
    this.easingMenu.style.display = "none";
    this.easingTrigger.setAttribute("aria-expanded", "false");
    this.easingTrigger.classList.remove(
      "aicut-keyframe-panel__dropdown-trigger--open",
    );
    if (this.boundOutsideClick) {
      document.removeEventListener("click", this.boundOutsideClick, true);
      this.boundOutsideClick = null;
    }
    if (this.boundDocKeydown) {
      document.removeEventListener("keydown", this.boundDocKeydown);
      this.boundDocKeydown = null;
    }
  }

  private selectEasing(value: EasingKind): void {
    this.closeEasingMenu();
    this.easingTrigger.focus();
    const sel = this.editor.getSelectedKeyframe();
    if (!sel) return;
    const clip = this.findClip(sel.clipId);
    const anchorKf = clip?.keyframes?.find((k) => k.id === sel.keyframeId);
    if (!clip || !anchorKf) return;
    this.editor.setKeyframesEasingAtTime(sel.clipId, anchorKf.time, value);
  }

  private onMenuKeydown(e: KeyboardEvent, value: EasingKind): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.selectEasing(value);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = EASING_VALUES.indexOf(value);
      const next = e.key === "ArrowDown"
        ? EASING_VALUES[(idx + 1) % EASING_VALUES.length]!
        : EASING_VALUES[(idx - 1 + EASING_VALUES.length) % EASING_VALUES.length]!;
      this.easingItems.get(next)?.focus();
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
