import { mergeLocale, type Locale } from "../i18n.js";
import { applyTheme } from "../theme.js";
import type { Theme } from "../types.js";
import { LightingControls } from "./controls.js";
import { mergeLightingLocale, type LightingLocale } from "./i18n.js";
import { normalize, PRESET_DIRECTIONS, snapToPreset } from "./presets.js";
import { LightingScene } from "./scene.js";
import {
  DEFAULT_LIGHTING_CONFIG,
  type LightingConfig,
  type LightingEditorOptions,
  type LightingView,
} from "./types.js";

/**
 * Top-level lighting picker. Two columns: a 3D scene (sphere + subject
 * plane + draggable light dot + cone beam) and a controls panel
 * (brightness / color / 6-direction key-light grid / rim toggle).
 *
 * Deliberately scoped to JUST the picker — the host owns everything
 * around it (smart-mode UI, generate buttons, layout, close handling,
 * theming above the editor). Render <LightingEditor> alongside your
 * own Smart panel in your own flex/grid; the library doesn't try to
 * model "open / closed drawer" semantics for you.
 */
export class LightingEditor {
  private root: HTMLElement;
  private opts: LightingEditorOptions;
  private config: LightingConfig;
  private view: LightingView;
  private locale: Locale & LightingLocale;

  private scene: LightingScene;
  private controls: LightingControls;
  private sceneViewport: HTMLDivElement;
  private viewToggleEl: HTMLDivElement;
  /** Footer slot in the controls column. Host appends Reset/Generate/
   *  preset-save/etc. buttons here. The library renders nothing into
   *  it — it's the same convention as the video editor's toolbar slots. */
  readonly controlsFooter: HTMLDivElement;

  private resizeObs: ResizeObserver | null = null;
  private destroyed = false;

  static create(opts: LightingEditorOptions): LightingEditor {
    return new LightingEditor(opts);
  }

  constructor(opts: LightingEditorOptions) {
    this.opts = opts;
    this.root = opts.container;
    this.config = { ...DEFAULT_LIGHTING_CONFIG, ...opts.config };
    this.view = opts.view ?? "perspective";
    this.locale = {
      ...mergeLocale(opts.locale),
      ...mergeLightingLocale(opts.locale),
    };

    this.root.classList.add("aicut-root", "aicut-lighting-editor");
    this.root.innerHTML = "";
    if (!this.root.style.position) this.root.style.position = "relative";
    applyTheme(this.root, opts.theme);

    // ---- Layout shell — scene column + controls column ----
    const body = document.createElement("div");
    body.className = "aicut-lighting-body";
    this.root.appendChild(body);

    const sceneCol = document.createElement("div");
    sceneCol.className = "aicut-lighting-scene-col";
    this.viewToggleEl = this.buildViewToggle();
    sceneCol.appendChild(this.viewToggleEl);
    this.sceneViewport = document.createElement("div");
    this.sceneViewport.className = "aicut-lighting-scene-viewport";
    this.sceneViewport.setAttribute("data-testid", "aicut-lighting-scene");
    sceneCol.appendChild(this.sceneViewport);
    body.appendChild(sceneCol);

    this.controls = new LightingControls(this.locale, {
      onBrightnessChange: (level) => this.applyMutation({ brightness: level }),
      onColorChange: (hex) => this.applyMutation({ color: hex }),
      onKeyDirectionPick: (preset) =>
        this.applyMutation({
          keyDirection: PRESET_DIRECTIONS[preset],
          keyPreset: preset,
        }),
      onRimToggle: (on) => this.applyMutation({ rim: on }),
    });
    body.appendChild(this.controls.root);
    this.controlsFooter = this.controls.footerSlot;

    // ---- Scene mount ----
    this.scene = new LightingScene(this.sceneViewport, this.view);
    this.scene.setLightDirection(this.config.keyDirection);
    this.scene.setBrightness(this.config.brightness);
    this.scene.setLightColor(this.config.color);
    if (opts.subjectImageUrl) this.scene.setSubjectImage(opts.subjectImageUrl);
    this.scene.onLightDrag = (dir) => {
      const d = normalize(dir);
      this.applyMutation({ keyDirection: d, keyPreset: snapToPreset(d) });
    };

    this.controls.render(this.config);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => {
        const rect = this.sceneViewport.getBoundingClientRect();
        const side = Math.min(rect.width, rect.height);
        if (side > 0) this.scene.setSize(side);
      });
      this.resizeObs.observe(this.sceneViewport);
    }
  }

  // ---- Public API ----------------------------------------------------

  getConfig(): LightingConfig {
    return { ...this.config, keyDirection: { ...this.config.keyDirection } };
  }

  setConfig(
    partial: Partial<LightingConfig>,
    _reason: "external" | "reset" = "external",
  ): void {
    const merged: LightingConfig = {
      ...this.config,
      ...partial,
      keyDirection: partial.keyDirection
        ? normalize(partial.keyDirection)
        : this.config.keyDirection,
    };
    if (partial.keyDirection && partial.keyPreset === undefined) {
      merged.keyPreset = snapToPreset(merged.keyDirection);
    }
    this.config = merged;
    this.scene.setLightDirection(this.config.keyDirection);
    this.scene.setBrightness(this.config.brightness);
    this.scene.setLightColor(this.config.color);
    this.controls.render(this.config);
    this.opts.onChange?.(this.getConfig());
  }

  setSubjectImage(url: string): void {
    this.opts.subjectImageUrl = url;
    this.scene.setSubjectImage(url);
  }

  /** Restore config to the safe defaults. Convenience for host's
   *  "Reset" button — equivalent to `setConfig(DEFAULT_LIGHTING_CONFIG)`. */
  reset(): void {
    this.setConfig(DEFAULT_LIGHTING_CONFIG, "reset");
  }

  setView(v: LightingView): void {
    if (v === this.view) return;
    this.view = v;
    this.scene.setView(v);
    this.syncViewToggle();
  }

  getView(): LightingView {
    return this.view;
  }

  setTheme(theme: Theme): void {
    applyTheme(this.root, theme);
  }

  setLocale(locale: Partial<Locale & LightingLocale>): void {
    this.locale = {
      ...mergeLocale(locale),
      ...mergeLightingLocale(locale),
    };
    this.controls.setLocale(this.locale);
    this.syncViewToggle();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObs?.disconnect();
    this.scene.destroy();
    this.root.innerHTML = "";
    this.root.classList.remove("aicut-root", "aicut-lighting-editor");
  }

  // ---- Internal ------------------------------------------------------

  private applyMutation(partial: Partial<LightingConfig>): void {
    const merged: LightingConfig = {
      ...this.config,
      ...partial,
      keyDirection: partial.keyDirection
        ? normalize(partial.keyDirection)
        : this.config.keyDirection,
    };
    this.config = merged;
    this.scene.setLightDirection(this.config.keyDirection);
    if (partial.brightness !== undefined)
      this.scene.setBrightness(this.config.brightness);
    if (partial.color !== undefined)
      this.scene.setLightColor(this.config.color);
    this.controls.render(this.config);
    this.opts.onChange?.(this.getConfig());
  }

  private buildViewToggle(): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "aicut-lighting-view-toggle";
    wrap.setAttribute("data-active", this.view);

    const mk = (v: LightingView, label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "aicut-lighting-view-opt";
      b.textContent = label;
      b.setAttribute("data-view", v);
      b.setAttribute("data-testid", `aicut-lighting-view-${v}`);
      if (v === this.view) b.classList.add("active");
      b.addEventListener("click", () => this.setView(v));
      return b;
    };
    wrap.appendChild(mk("perspective", this.locale.lightingViewPerspective));
    wrap.appendChild(mk("front", this.locale.lightingViewFront));
    return wrap;
  }

  private syncViewToggle(): void {
    this.viewToggleEl.setAttribute("data-active", this.view);
    for (const btn of Array.from(
      this.viewToggleEl.querySelectorAll<HTMLButtonElement>(
        ".aicut-lighting-view-opt",
      ),
    )) {
      const v = btn.getAttribute("data-view") as LightingView | null;
      btn.classList.toggle("active", v === this.view);
      if (v === "perspective") btn.textContent = this.locale.lightingViewPerspective;
      if (v === "front") btn.textContent = this.locale.lightingViewFront;
    }
  }
}
