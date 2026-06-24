import type { LightingConfig, KeyPreset } from "./types.js";
import type { LightingLocale } from "./i18n.js";
import { PRESET_DIRECTIONS } from "./presets.js";

export interface ControlsCallbacks {
  onBrightnessChange: (level: number) => void;    // 0..1
  onColorChange: (hex: string) => void;
  onKeyDirectionPick: (preset: Exclude<KeyPreset, "custom">) => void;
  onRimToggle: (on: boolean) => void;
}

/**
 * Renders the right-hand controls column DOM (brightness, color,
 * six-direction grid, rim toggle). Stateless about the values it
 * displays — the parent calls `render(config)` whenever the config
 * mutates. Doesn't own any timers / observers; just DOM + listeners.
 */
export class LightingControls {
  readonly root: HTMLDivElement;
  /** Exposed so the editor can append host-level chrome (e.g. the
   *  Smart Mode toggle) without LightingControls knowing about it. */
  readonly headerSlot: HTMLDivElement;
  /**
   * Footer slot — sits where the built-in Reset used to live. Host
   * appends any action buttons (Reset, Generate, Save preset, etc.)
   * via the React wrapper's `controlsFooter` prop / Vue's
   * `<slot name="controlsFooter">`. Library renders nothing here.
   */
  readonly footerSlot: HTMLDivElement;

  private brightnessInput: HTMLInputElement;
  private colorInput: HTMLInputElement;
  private dirButtons: Record<Exclude<KeyPreset, "custom">, HTMLButtonElement>;
  private rimToggle: HTMLDivElement;
  private rimThumb: HTMLDivElement;
  /** Section title + per-section label elements held by reference so
   *  setLocale() can retranslate them without rebuilding the DOM. */
  private titleEl: HTMLSpanElement;
  private brightnessLabelEl: HTMLSpanElement;
  private colorLabelEl: HTMLSpanElement;
  private keyLabelEl: HTMLSpanElement;
  private rimLabelEl: HTMLSpanElement;

  private locale: LightingLocale;
  private lastConfig: LightingConfig | null = null;

  constructor(locale: LightingLocale, cb: ControlsCallbacks) {
    this.locale = locale;
    this.root = document.createElement("div");
    this.root.className = "aicut-lighting-controls";

    // --- Header ---
    const header = mkDiv("aicut-lighting-controls-header");
    this.titleEl = mkSpan(
      "aicut-lighting-controls-title",
      locale.lightingGlobalTitle,
    );
    header.appendChild(this.titleEl);
    this.headerSlot = mkDiv("aicut-lighting-controls-header-slot");
    header.appendChild(this.headerSlot);
    this.root.appendChild(header);

    // --- Brightness ---
    const brSection = mkDiv("aicut-lighting-section");
    this.brightnessLabelEl = mkSpan(
      "aicut-lighting-label",
      locale.lightingBrightness,
    );
    brSection.appendChild(this.brightnessLabelEl);
    this.brightnessInput = document.createElement("input");
    this.brightnessInput.type = "range";
    this.brightnessInput.min = "0";
    this.brightnessInput.max = "4";
    this.brightnessInput.step = "1";
    this.brightnessInput.value = "2";
    this.brightnessInput.className = "aicut-lighting-range";
    this.brightnessInput.setAttribute("data-testid", "aicut-lighting-brightness");
    this.brightnessInput.addEventListener("input", () => {
      const level = Number(this.brightnessInput.value) / 4;
      cb.onBrightnessChange(level);
    });
    brSection.appendChild(this.brightnessInput);
    this.root.appendChild(brSection);

    // --- Color ---
    const colorSection = mkDiv("aicut-lighting-section aicut-lighting-section-row");
    this.colorLabelEl = mkSpan("aicut-lighting-label", locale.lightingColor);
    colorSection.appendChild(this.colorLabelEl);
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = "#ffffff";
    this.colorInput.className = "aicut-lighting-color";
    this.colorInput.setAttribute("data-testid", "aicut-lighting-color");
    this.colorInput.addEventListener("input", () => {
      cb.onColorChange(this.colorInput.value);
    });
    colorSection.appendChild(this.colorInput);
    this.root.appendChild(colorSection);

    // --- Key light direction grid (6 buttons in 3×2) ---
    const keySection = mkDiv("aicut-lighting-section");
    this.keyLabelEl = mkSpan("aicut-lighting-label", locale.lightingKeyTitle);
    keySection.appendChild(this.keyLabelEl);
    const dirGrid = mkDiv("aicut-lighting-dir-grid");
    const order: Array<{
      preset: Exclude<KeyPreset, "custom">;
      label: keyof LightingLocale;
    }> = [
      { preset: "left",   label: "lightingDirLeft" },
      { preset: "top",    label: "lightingDirTop" },
      { preset: "right",  label: "lightingDirRight" },
      { preset: "front",  label: "lightingDirFront" },
      { preset: "bottom", label: "lightingDirBottom" },
      { preset: "back",   label: "lightingDirBack" },
    ];
    this.dirButtons = {} as Record<
      Exclude<KeyPreset, "custom">,
      HTMLButtonElement
    >;
    for (const { preset, label } of order) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "aicut-lighting-dir-btn";
      btn.textContent = locale[label];
      btn.setAttribute("data-testid", `aicut-lighting-dir-${preset}`);
      btn.addEventListener("click", () => cb.onKeyDirectionPick(preset));
      this.dirButtons[preset] = btn;
      dirGrid.appendChild(btn);
    }
    keySection.appendChild(dirGrid);
    this.root.appendChild(keySection);

    // --- Rim toggle ---
    const rimSection = mkDiv("aicut-lighting-section aicut-lighting-section-row");
    this.rimLabelEl = mkSpan("aicut-lighting-label", locale.lightingRim);
    rimSection.appendChild(this.rimLabelEl);
    this.rimToggle = mkDiv("aicut-lighting-toggle");
    this.rimToggle.setAttribute("role", "switch");
    this.rimToggle.setAttribute("aria-checked", "false");
    this.rimToggle.setAttribute("tabindex", "0");
    this.rimToggle.setAttribute("data-testid", "aicut-lighting-rim");
    this.rimThumb = mkDiv("aicut-lighting-toggle-thumb");
    this.rimToggle.appendChild(this.rimThumb);
    this.rimToggle.addEventListener("click", () => {
      const next = this.rimToggle.getAttribute("aria-checked") !== "true";
      cb.onRimToggle(next);
    });
    rimSection.appendChild(this.rimToggle);
    this.root.appendChild(rimSection);

    // --- Footer slot ---
    this.footerSlot = mkDiv("aicut-lighting-controls-footer");
    this.footerSlot.setAttribute(
      "data-testid",
      "aicut-lighting-controls-footer",
    );
    this.root.appendChild(this.footerSlot);
  }

  /** Idempotent — mirror the given config into all visible controls. */
  render(cfg: LightingConfig): void {
    if (!this.lastConfig || this.lastConfig.brightness !== cfg.brightness) {
      const level = Math.round(cfg.brightness * 4);
      this.brightnessInput.value = String(level);
    }
    if (!this.lastConfig || this.lastConfig.color !== cfg.color) {
      this.colorInput.value = cfg.color;
    }
    if (!this.lastConfig || this.lastConfig.keyPreset !== cfg.keyPreset) {
      for (const [preset, btn] of Object.entries(this.dirButtons)) {
        btn.classList.toggle("active", preset === cfg.keyPreset);
      }
    }
    if (!this.lastConfig || this.lastConfig.rim !== cfg.rim) {
      this.rimToggle.setAttribute("aria-checked", cfg.rim ? "true" : "false");
      this.rimToggle.classList.toggle("active", cfg.rim);
    }
    this.lastConfig = { ...cfg };
  }

  setLocale(locale: LightingLocale): void {
    this.locale = locale;
    // Section titles + labels — held by reference (see ctor).
    this.titleEl.textContent = locale.lightingGlobalTitle;
    this.brightnessLabelEl.textContent = locale.lightingBrightness;
    this.colorLabelEl.textContent = locale.lightingColor;
    this.keyLabelEl.textContent = locale.lightingKeyTitle;
    this.rimLabelEl.textContent = locale.lightingRim;
    // 6-way direction button labels.
    const dirLabels: Record<Exclude<KeyPreset, "custom">, keyof LightingLocale> = {
      left: "lightingDirLeft",
      right: "lightingDirRight",
      top: "lightingDirTop",
      bottom: "lightingDirBottom",
      front: "lightingDirFront",
      back: "lightingDirBack",
    };
    for (const preset of Object.keys(PRESET_DIRECTIONS) as Array<
      Exclude<KeyPreset, "custom">
    >) {
      this.dirButtons[preset].textContent = locale[dirLabels[preset]];
    }
  }
}

// ---- tiny helpers --------------------------------------------------------

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
