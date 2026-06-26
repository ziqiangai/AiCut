import type { LightingLocale } from "../lighting/i18n.js";
import { PRESET_DIRECTIONS } from "../lighting/presets.js";
import type { KeyPresetV3, LightingConfigV3 } from "./types.js";

/**
 * Right-hand controls panel for the v3 lighting picker. Matches the
 * Figma reference: 2 sliders (Brightness + Color temp), a 3×2 grid
 * of preset key-light directions with the active one in solid black,
 * a brand-pink rotation slider, and a Generate CTA at the bottom.
 *
 * The class is stateless about values — the editor calls `render(cfg)`
 * after every mutation, the panel only owns the DOM + listeners.
 */
export interface ControlsV3Callbacks {
  onBrightnessChange: (level: number) => void; // 0..1
  onColorTempChange: (kelvin: number) => void; // 2000..10000
  onKeyDirectionPick: (preset: Exclude<KeyPresetV3, "custom">) => void;
  onRotationChange: (degrees: number) => void; // 0..360
  onRimToggle: (on: boolean) => void;
  onGenerate: () => void;
  onClose: () => void;
}

/** Six canonical directions, ordered exactly as the Figma's 3×2 grid
 *  reads. Top row = top / front / bottom; bottom row = left / back /
 *  right. Reads like a flattened cube net so muscle memory is stable. */
const PRESET_GRID: Array<Exclude<KeyPresetV3, "custom">> = [
  "top",
  "front",
  "bottom",
  "left",
  "back",
  "right",
];

export class LightingControlsV3 {
  readonly root: HTMLDivElement;
  private brightnessRange: HTMLInputElement;
  private brightnessBubble: HTMLSpanElement;
  private colorTempRange: HTMLInputElement;
  private colorTempBubble: HTMLSpanElement;
  private rotationRange: HTMLInputElement;
  private rotationBubble: HTMLSpanElement;
  private presetBtns: Record<
    Exclude<KeyPresetV3, "custom">,
    HTMLButtonElement
  >;
  private generateBtn: HTMLButtonElement;
  private generateBadgeEl: HTMLSpanElement;
  private closeBtn: HTMLButtonElement;
  private rimToggleBtn: HTMLButtonElement;
  private rimLabelEl: HTMLSpanElement;

  private titleEl: HTMLSpanElement;
  private brightnessLabelEl: HTMLSpanElement;
  private colorTempLabelEl: HTMLSpanElement;
  private directionLabelEl: HTMLSpanElement;
  private rotationLabelEl: HTMLSpanElement;
  private generateLabelEl: HTMLSpanElement;
  private presetLabels: Record<Exclude<KeyPresetV3, "custom">, HTMLSpanElement>;

  private locale: LightingLocale;
  private generateLabel: string;

  constructor(
    locale: LightingLocale,
    cb: ControlsV3Callbacks,
    generateLabel: string,
  ) {
    this.locale = locale;
    this.generateLabel = generateLabel;

    this.root = document.createElement("div");
    this.root.className = "aicut-lighting-v3-controls";

    // --- Title row (with close button) ---
    const titleRow = mkDiv("aicut-lighting-v3-title-row");
    this.titleEl = mkSpan("aicut-lighting-v3-title", "");
    this.closeBtn = document.createElement("button");
    this.closeBtn.type = "button";
    this.closeBtn.className = "aicut-lighting-v3-close";
    this.closeBtn.setAttribute("data-testid", "aicut-lighting-v3-close");
    this.closeBtn.setAttribute("aria-label", "Close");
    this.closeBtn.innerHTML = closeIconSvg();
    this.closeBtn.addEventListener("click", () => cb.onClose());
    titleRow.append(this.titleEl, this.closeBtn);
    this.root.appendChild(titleRow);

    // --- Brightness ---
    this.brightnessLabelEl = mkSpan("aicut-lighting-v3-row-label", "");
    const { row: brRow, range: brRange, bubble: brBubble } = mkSliderRow({
      testId: "aicut-lighting-v3-brightness",
      min: 0,
      max: 100,
      step: 1,
      kind: "solid",
      bubbleStyle: "icon-value",
      bubbleIcon: sunIconSvg(),
      onInput: (v) => cb.onBrightnessChange(v / 100),
    });
    this.brightnessRange = brRange;
    this.brightnessBubble = brBubble;
    this.root.append(this.brightnessLabelEl, brRow);

    // --- Color temperature ---
    this.colorTempLabelEl = mkSpan("aicut-lighting-v3-row-label", "");
    const { row: ctRow, range: ctRange, bubble: ctBubble } = mkSliderRow({
      testId: "aicut-lighting-v3-color-temp",
      min: 2000,
      max: 10000,
      step: 100,
      kind: "gradient",
      bubbleStyle: "icon-value",
      bubbleIcon: thermometerIconSvg(),
      onInput: (v) => cb.onColorTempChange(v),
    });
    this.colorTempRange = ctRange;
    this.colorTempBubble = ctBubble;
    this.root.append(this.colorTempLabelEl, ctRow);

    // --- Direction (3×2 preset grid) ---
    this.directionLabelEl = mkSpan("aicut-lighting-v3-row-label", "");
    this.root.appendChild(this.directionLabelEl);
    const grid = mkDiv("aicut-lighting-v3-preset-grid");
    this.presetBtns = {} as Record<
      Exclude<KeyPresetV3, "custom">,
      HTMLButtonElement
    >;
    this.presetLabels = {} as Record<
      Exclude<KeyPresetV3, "custom">,
      HTMLSpanElement
    >;
    for (const preset of PRESET_GRID) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "aicut-lighting-v3-preset";
      btn.setAttribute("data-preset", preset);
      btn.setAttribute("data-testid", `aicut-lighting-v3-preset-${preset}`);
      const lab = mkSpan("aicut-lighting-v3-preset-label", "");
      btn.appendChild(lab);
      btn.addEventListener("click", () => cb.onKeyDirectionPick(preset));
      this.presetBtns[preset] = btn;
      this.presetLabels[preset] = lab;
      grid.appendChild(btn);
    }
    this.root.appendChild(grid);

    // --- Rotation (brand-pink slider) ---
    this.rotationLabelEl = mkSpan("aicut-lighting-v3-row-label", "");
    const { row: rotRow, range: rotRange, bubble: rotBubble } = mkSliderRow({
      testId: "aicut-lighting-v3-rotation",
      min: 0,
      max: 360,
      step: 1,
      kind: "brand",
      onInput: (v) => cb.onRotationChange(v),
    });
    this.rotationRange = rotRange;
    this.rotationBubble = rotBubble;
    this.root.append(this.rotationLabelEl, rotRow);

    // --- Rim light toggle ---
    const rimRow = mkDiv("aicut-lighting-v3-rim-row");
    this.rimLabelEl = mkSpan("aicut-lighting-v3-row-label", "");
    this.rimLabelEl.classList.add("aicut-lighting-v3-rim-label");
    this.rimToggleBtn = document.createElement("button");
    this.rimToggleBtn.type = "button";
    this.rimToggleBtn.className = "aicut-lighting-v3-toggle";
    this.rimToggleBtn.setAttribute("role", "switch");
    this.rimToggleBtn.setAttribute("aria-checked", "false");
    this.rimToggleBtn.setAttribute("data-testid", "aicut-lighting-v3-rim");
    const rimThumb = document.createElement("span");
    rimThumb.className = "aicut-lighting-v3-toggle-thumb";
    this.rimToggleBtn.appendChild(rimThumb);
    this.rimToggleBtn.addEventListener("click", () => {
      const next = this.rimToggleBtn.getAttribute("aria-checked") !== "true";
      cb.onRimToggle(next);
    });
    rimRow.append(this.rimLabelEl, this.rimToggleBtn);
    this.root.appendChild(rimRow);

    // --- Generate CTA + optional number badge ---
    const actions = mkDiv("aicut-lighting-v3-actions");
    this.generateBtn = document.createElement("button");
    this.generateBtn.type = "button";
    this.generateBtn.className = "aicut-lighting-v3-generate";
    this.generateBtn.setAttribute("data-testid", "aicut-lighting-v3-generate");
    this.generateBtn.innerHTML = sparkleIconSvg();
    this.generateLabelEl = mkSpan("aicut-lighting-v3-generate-label", "");
    this.generateBtn.appendChild(this.generateLabelEl);
    this.generateBadgeEl = mkSpan("aicut-lighting-v3-generate-badge", "");
    this.generateBadgeEl.style.display = "none";
    this.generateBtn.appendChild(this.generateBadgeEl);
    this.generateBtn.addEventListener("click", () => cb.onGenerate());
    actions.appendChild(this.generateBtn);
    this.root.appendChild(actions);

    this.applyLocaleText();
  }

  render(cfg: LightingConfigV3, colorTempKelvin: number): void {
    const brPct = Math.round(cfg.brightness * 100);
    if (this.brightnessRange.value !== String(brPct)) {
      this.brightnessRange.value = String(brPct);
    }
    setBubbleText(this.brightnessBubble, `${brPct} %`);
    setRangeFill(this.brightnessRange, brPct / 100);

    if (this.colorTempRange.value !== String(colorTempKelvin)) {
      this.colorTempRange.value = String(colorTempKelvin);
    }
    setBubbleText(this.colorTempBubble, `${colorTempKelvin} K`);
    setRangeFill(this.colorTempRange, (colorTempKelvin - 2000) / 8000);

    const rotDeg = Math.round(cfg.rotation) % 360;
    if (this.rotationRange.value !== String(rotDeg)) {
      this.rotationRange.value = String(rotDeg);
    }
    setBubbleText(this.rotationBubble, `${rotDeg}°`);
    setRangeFill(this.rotationRange, rotDeg / 360);

    for (const preset of PRESET_GRID) {
      this.presetBtns[preset].classList.toggle(
        "active",
        cfg.keyPreset === preset,
      );
    }

    // Rim light toggle state — drives the visible thumb position
    // (CSS reads aria-checked).
    this.rimToggleBtn.setAttribute("aria-checked", cfg.rim ? "true" : "false");
    this.rimToggleBtn.classList.toggle("active", cfg.rim);
  }

  /** Set the small number / string badge at the right of the
   *  Generate CTA. Pass null to hide the badge. */
  setBadge(text: string | null): void {
    if (text == null || text === "") {
      this.generateBadgeEl.style.display = "none";
    } else {
      this.generateBadgeEl.textContent = text;
      this.generateBadgeEl.style.display = "";
    }
  }

  setLocale(locale: LightingLocale, generateLabel?: string): void {
    this.locale = locale;
    if (generateLabel != null) this.generateLabel = generateLabel;
    this.applyLocaleText();
  }

  private applyLocaleText(): void {
    this.titleEl.textContent = this.locale.lightingGlobalTitle;
    this.brightnessLabelEl.textContent = this.locale.lightingBrightness;
    this.colorTempLabelEl.textContent = this.locale.lightingColorTemp;
    this.directionLabelEl.textContent = this.locale.lightingKeyTitle;
    this.rotationLabelEl.textContent = this.locale.lightingRotation;
    this.rimLabelEl.textContent = this.locale.lightingRim;
    this.generateLabelEl.textContent = this.generateLabel || this.locale.lightingGenerate;
    const presetLabels: Record<Exclude<KeyPresetV3, "custom">, string> = {
      top: this.locale.lightingDirTop,
      front: this.locale.lightingDirFront,
      bottom: this.locale.lightingDirBottom,
      left: this.locale.lightingDirLeft,
      back: this.locale.lightingDirBack,
      right: this.locale.lightingDirRight,
    };
    for (const preset of PRESET_GRID) {
      this.presetLabels[preset].textContent = presetLabels[preset];
    }
  }
}

// ---- DOM helpers ------------------------------------------------------

function mkDiv(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function mkSpan(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function mkSliderRow(opts: {
  testId: string;
  min: number;
  max: number;
  step: number;
  kind: "gradient" | "brand" | "solid";
  bubbleStyle?: "value" | "icon-value";
  bubbleIcon?: string; // inline SVG markup
  onInput: (v: number) => void;
}): { row: HTMLDivElement; range: HTMLInputElement; bubble: HTMLSpanElement } {
  const row = mkDiv(`aicut-lighting-v3-slider aicut-lighting-v3-slider--${opts.kind}`);
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(opts.min);
  range.max = String(opts.max);
  range.step = String(opts.step);
  range.setAttribute("data-testid", opts.testId);
  range.addEventListener("input", () => opts.onInput(Number(range.value)));
  const bubble = document.createElement("span");
  bubble.className = "aicut-lighting-v3-slider-bubble";
  if (opts.bubbleStyle === "icon-value" && opts.bubbleIcon) {
    bubble.classList.add("aicut-lighting-v3-slider-bubble--with-icon");
    const icon = document.createElement("span");
    icon.className = "aicut-lighting-v3-slider-bubble-icon";
    icon.innerHTML = opts.bubbleIcon;
    bubble.appendChild(icon);
    const txt = document.createElement("span");
    txt.className = "aicut-lighting-v3-slider-bubble-text";
    bubble.appendChild(txt);
  }
  row.append(range, bubble);
  return { row, range, bubble };
}

function setRangeFill(input: HTMLInputElement, ratio: number): void {
  input.style.setProperty(
    "--aicut-lighting-v3-fill",
    `${Math.max(0, Math.min(1, ratio)) * 100}%`,
  );
}

function closeIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

function sparkleIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1l1.6 3.6L12.2 6 8.6 7.5 7 11.2 5.4 7.5 1.8 6l3.6-1.4L7 1z" fill="currentColor"/></svg>`;
}

/** Sun icon for the brightness bubble. Small + flat to read at 12px. */
function sunIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="1.2"/><path d="M6 .8v1.4M6 9.8v1.4M.8 6h1.4M9.8 6h1.4M2.3 2.3l1 1M8.7 8.7l1 1M2.3 9.7l1-1M8.7 3.3l1-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
}

/** Thermometer for the color-temp bubble. */
function thermometerIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1.5v6.2a1.8 1.8 0 1 0 0 0z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Bubble text update — if the bubble was built with the icon + text
 *  layout (`bubbleStyle: 'icon-value'`), update only the text span;
 *  else write directly to the bubble. Keeps the icon DOM stable. */
function setBubbleText(bubble: HTMLSpanElement, text: string): void {
  const textEl = bubble.querySelector<HTMLSpanElement>(
    ".aicut-lighting-v3-slider-bubble-text",
  );
  if (textEl) textEl.textContent = text;
  else bubble.textContent = text;
}
