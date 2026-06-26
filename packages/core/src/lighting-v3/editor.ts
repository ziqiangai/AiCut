import { mergeLocale, type Locale } from "../i18n.js";
import { applyTheme } from "../theme.js";
import type { Theme } from "../types.js";
import { mergeLightingLocale, type LightingLocale } from "../lighting/i18n.js";
import { normalize, PRESET_DIRECTIONS, snapToPreset } from "../lighting/presets.js";
import { LightingScene } from "../lighting/scene.js";
import { LightingControlsV3 } from "./controls.js";
import {
  DEFAULT_LIGHTING_CONFIG_V3,
  type LightingConfigV3,
  type LightingEditorV3Options,
} from "./types.js";

/**
 * V3 lighting picker — same scene / data model as v2 but a fresh
 * Figma-driven chrome and a new `rotation` knob that spins the
 * in-sphere subject image. Composed alongside v2 so hosts can adopt
 * incrementally — both can co-exist in the same app.
 *
 * Layout (matches the Figma reference):
 *
 *   ┌────────────────────────────────┬──────────────────────────┐
 *   │                                │  Global              ×   │
 *   │                                │                          │
 *   │     [ sphere scene viewport ]  │  Brightness  ━━●━━━ [50] │
 *   │                                │  Color temp  ━━●━━━ [5K] │
 *   │                                │  Key light               │
 *   │     dotted-bg, square 1:1      │  ▒ ▒ ▒                   │
 *   │                                │  ▒ ▓ ▒   (▓ = active)    │
 *   │     [smart light] tab          │  Rotation   ━●━━━━━ [0°] │
 *   │                                │  ───────────             │
 *   │                                │            [✦ Generate]  │
 *   └────────────────────────────────┴──────────────────────────┘
 */
export class LightingEditorV3 {
  private root: HTMLElement;
  private opts: LightingEditorV3Options;
  private config: LightingConfigV3;
  private locale: Locale & LightingLocale;
  /** Color temperature in Kelvin. Driven by the V3 controls; the scene
   *  receives the derived hex color via `setLightColor`. */
  private colorTempKelvin: number;

  private scene: LightingScene;
  private controls: LightingControlsV3;
  private sceneViewport: HTMLDivElement;
  private chip: HTMLDivElement;
  private subjectStage: HTMLDivElement;
  private subjectCard: HTMLDivElement;
  private viewToggle: HTMLDivElement;
  private resetBtn: HTMLButtonElement;
  private resetLabel: HTMLSpanElement;
  private view: import("../lighting/types.js").LightingView;
  private mode: "light" | "dark" = "light";

  private resizeObs: ResizeObserver | null = null;
  private destroyed = false;

  static create(opts: LightingEditorV3Options): LightingEditorV3 {
    return new LightingEditorV3(opts);
  }

  constructor(opts: LightingEditorV3Options) {
    this.opts = opts;
    this.root = opts.container;
    this.config = { ...DEFAULT_LIGHTING_CONFIG_V3, ...opts.config };
    this.view = opts.view ?? "perspective";
    this.mode = opts.mode ?? "light";
    this.locale = {
      ...mergeLocale(opts.locale),
      ...mergeLightingLocale(opts.locale),
    };
    this.colorTempKelvin = colorToKelvin(this.config.color);

    this.root.classList.add(
      "aicut-root",
      "aicut-lighting-v3",
    );
    this.root.setAttribute("data-aicut-mode", this.mode);
    this.root.innerHTML = "";
    if (!this.root.style.position) this.root.style.position = "relative";
    applyTheme(this.root, opts.theme);

    // --- Layout shell ---
    const body = document.createElement("div");
    body.className = "aicut-lighting-v3-body";
    this.root.appendChild(body);

    // Scene column — viewport fills the col, all chrome (chip,
    // view toggle, reset) is absolute-positioned in the corner /
    // top-center margins around the (shrunken) sphere.
    const sceneCol = document.createElement("div");
    sceneCol.className = "aicut-lighting-v3-scene-col";

    this.sceneViewport = document.createElement("div");
    this.sceneViewport.className = "aicut-lighting-v3-scene-viewport";
    this.sceneViewport.setAttribute("data-testid", "aicut-lighting-v3-scene");
    sceneCol.appendChild(this.sceneViewport);

    // Subject is a WebGL plane (same as V2) — perspective camera
    // produces the natural 3D tilt. Placeholder is drawn into a
    // canvas + fed via setSubjectImage(dataURL).
    this.subjectStage = document.createElement("div"); // unused, kept for typing
    this.subjectCard = document.createElement("div");

    // Top-left chip — opt-in via `title`. Default = no chip,
    // matching the reference image. Hosts that want the chip pass
    // `title: "智能光源"` (or any string) and the eye-icon pill
    // appears with that label.
    this.chip = document.createElement("div");
    if (opts.title) {
      this.chip.className = "aicut-lighting-v3-chip";
      this.chip.innerHTML = `<span class="aicut-lighting-v3-chip-icon">${refreshIconSvg()}</span><span class="aicut-lighting-v3-chip-label">${escapeHtml(opts.title)}</span>`;
      sceneCol.appendChild(this.chip);
    }

    // Top-center "透视" / "正面" toggle.
    this.viewToggle = document.createElement("div");
    this.viewToggle.className = "aicut-lighting-v3-view-toggle";
    this.viewToggle.setAttribute("role", "group");
    const mkViewBtn = (
      v: "perspective" | "front",
      label: string,
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "aicut-lighting-v3-view-opt";
      b.textContent = label;
      b.setAttribute("data-view", v);
      b.setAttribute(
        "data-testid",
        `aicut-lighting-v3-view-${v}`,
      );
      if (v === this.view) b.classList.add("active");
      b.addEventListener("click", () => this.setView(v));
      return b;
    };
    this.viewToggle.appendChild(
      mkViewBtn("perspective", this.locale.lightingViewPerspective),
    );
    this.viewToggle.appendChild(
      mkViewBtn("front", this.locale.lightingViewFront),
    );
    sceneCol.appendChild(this.viewToggle);

    // Bottom-left reset button — "↻ 重置".
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "aicut-lighting-v3-reset";
    this.resetBtn.setAttribute("data-testid", "aicut-lighting-v3-reset");
    this.resetBtn.innerHTML = `<span class="aicut-lighting-v3-reset-icon">${resetIconSvg()}</span>`;
    this.resetLabel = document.createElement("span");
    this.resetLabel.className = "aicut-lighting-v3-reset-label";
    this.resetLabel.textContent = this.locale.lightingReset;
    this.resetBtn.appendChild(this.resetLabel);
    this.resetBtn.addEventListener("click", () => {
      this.reset();
      this.opts.onReset?.();
    });
    sceneCol.appendChild(this.resetBtn);

    body.appendChild(sceneCol);

    // Controls column.
    this.controls = new LightingControlsV3(
      this.locale,
      {
        onBrightnessChange: (level) => this.applyMutation({ brightness: level }),
        onColorTempChange: (kelvin) => {
          this.colorTempKelvin = kelvin;
          this.applyMutation({ color: kelvinToHex(kelvin) });
        },
        onKeyDirectionPick: (preset) =>
          this.applyMutation({
            keyDirection: PRESET_DIRECTIONS[preset],
            keyPreset: preset,
          }),
        onRotationChange: (degrees) =>
          this.applyMutation({ rotation: degrees }),
        onRimToggle: (on) => this.applyMutation({ rim: on }),
        onGenerate: () => this.opts.onGenerate?.(this.getConfig()),
        onClose: () => this.opts.onClose?.(),
      },
      opts.generateLabel ?? "",
    );
    body.appendChild(this.controls.root);

    // --- 3D scene ---
    // V3 picks the "lite" scene: no wireframe (CSS soap bubble shows
    // through), gradient-textured beam visible against the light bg.
    this.scene = new LightingScene(this.sceneViewport, this.view, {
      hideWire: true,
      solidBeam: true,
    });
    this.scene.setLightDirection(this.config.keyDirection);
    this.scene.setBrightness(this.config.brightness);
    this.scene.setLightColor(this.config.color);
    // No real image? Feed a canvas-rendered placeholder as a data URL
    // so the WebGL subject plane has SOMETHING to show. Camera
    // perspective then tilts it naturally, matching v2.
    if (opts.subjectImageUrl) {
      this.scene.setSubjectImage(opts.subjectImageUrl);
    } else {
      this.scene.setSubjectImage(buildPlaceholderDataUrl());
    }
    this.scene.setSubjectRotation(this.config.rotation);
    this.scene.onLightDrag = (dir) => {
      const d = normalize(dir);
      this.applyMutation({ keyDirection: d, keyPreset: snapToPreset(d) });
    };

    this.controls.render(this.config, this.colorTempKelvin);
    if (opts.generateBadge != null) {
      this.controls.setBadge(String(opts.generateBadge));
    }

    // Initial size — don't wait for ResizeObserver to fire on the
    // next frame. Without this the scene draws at the default 240 px
    // then visually pops to the real container size, and during that
    // moment the canvas DOM (100%) is larger than the WebGL drawing
    // buffer, making everything look upscaled / fuzzy.
    requestAnimationFrame(() => {
      const rect = this.sceneViewport.getBoundingClientRect();
      const side = Math.min(rect.width, rect.height);
      if (side > 0) this.scene.setSize(side);
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => {
        const rect = this.sceneViewport.getBoundingClientRect();
        const side = Math.min(rect.width, rect.height);
        if (side > 0) this.scene.setSize(side);
      });
      this.resizeObs.observe(this.sceneViewport);
    }
  }

  // ---- Public API ---------------------------------------------------

  getConfig(): LightingConfigV3 {
    return {
      ...this.config,
      keyDirection: { ...this.config.keyDirection },
    };
  }

  setConfig(partial: Partial<LightingConfigV3>): void {
    const merged: LightingConfigV3 = {
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
    if (partial.color !== undefined) {
      this.colorTempKelvin = colorToKelvin(this.config.color);
    }
    this.scene.setLightDirection(this.config.keyDirection);
    this.scene.setBrightness(this.config.brightness);
    this.scene.setLightColor(this.config.color);
    this.scene.setSubjectRotation(this.config.rotation);
    this.controls.render(this.config, this.colorTempKelvin);
    this.opts.onChange?.(this.getConfig());
  }

  setSubjectImage(url: string | null): void {
    this.opts.subjectImageUrl = url ?? undefined;
    if (!url) {
      // Fall back to the canvas-rendered placeholder.
      this.scene.setSubjectImage(buildPlaceholderDataUrl());
    } else {
      this.scene.setSubjectImage(url);
    }
  }

  reset(): void {
    this.setConfig(DEFAULT_LIGHTING_CONFIG_V3);
  }

  setView(v: import("../lighting/types.js").LightingView): void {
    if (v === this.view) return;
    this.view = v;
    this.scene.setView(v);
    this.syncViewToggle();
    this.opts.onViewChange?.(v);
  }

  getView(): import("../lighting/types.js").LightingView {
    return this.view;
  }

  setBadge(text: string | number | null): void {
    this.controls.setBadge(text == null ? null : String(text));
  }

  setTheme(theme: Theme): void {
    applyTheme(this.root, theme);
  }

  setMode(mode: "light" | "dark"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.root.setAttribute("data-aicut-mode", mode);
  }

  getMode(): "light" | "dark" {
    return this.mode;
  }

  setLocale(locale: Partial<Locale & LightingLocale>): void {
    this.locale = {
      ...mergeLocale(locale),
      ...mergeLightingLocale(locale),
    };
    this.controls.setLocale(this.locale, this.opts.generateLabel);
    this.syncViewToggle();
    this.resetLabel.textContent = this.locale.lightingReset;
  }

  private syncViewToggle(): void {
    for (const btn of Array.from(
      this.viewToggle.querySelectorAll<HTMLButtonElement>(
        ".aicut-lighting-v3-view-opt",
      ),
    )) {
      const v = btn.getAttribute("data-view");
      const active = v === this.view;
      btn.classList.toggle("active", active);
      if (v === "perspective") btn.textContent = this.locale.lightingViewPerspective;
      if (v === "front") btn.textContent = this.locale.lightingViewFront;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObs?.disconnect();
    this.scene.destroy();
    this.root.innerHTML = "";
    this.root.classList.remove("aicut-root", "aicut-lighting-v3");
  }

  // ---- Internal -----------------------------------------------------

  private applyMutation(partial: Partial<LightingConfigV3>): void {
    const merged: LightingConfigV3 = {
      ...this.config,
      ...partial,
      keyDirection: partial.keyDirection
        ? normalize(partial.keyDirection)
        : this.config.keyDirection,
    };
    this.config = merged;
    if (partial.keyDirection !== undefined) {
      this.scene.setLightDirection(this.config.keyDirection);
    }
    if (partial.brightness !== undefined) {
      this.scene.setBrightness(this.config.brightness);
    }
    if (partial.color !== undefined) {
      this.scene.setLightColor(this.config.color);
    }
    if (partial.rotation !== undefined) {
      this.scene.setSubjectRotation(this.config.rotation);
    }
    this.controls.render(this.config, this.colorTempKelvin);
    this.opts.onChange?.(this.getConfig());
  }
}

// ---- Color helpers ----------------------------------------------------

/**
 * Map color temperature in Kelvin to an approximate sRGB hex string.
 * Source: Tanner Helland's classic piecewise approximation — fast,
 * 256-stable, accurate enough for the V3 slider's UX (we just want
 * "warm" and "cool" to read).
 */
function kelvinToHex(kelvin: number): string {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const clamp = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/** Inverse of `kelvinToHex` — picks the K value whose hex is closest
 *  to `hex`. Used to seed the slider from an arbitrary v2 color. */
function colorToKelvin(hex: string): number {
  let bestK = 6500;
  let bestDist = Infinity;
  const target = hexToRgb(hex);
  if (!target) return bestK;
  for (let k = 2000; k <= 10000; k += 100) {
    const c = hexToRgb(kelvinToHex(k))!;
    const d =
      (c.r - target.r) * (c.r - target.r) +
      (c.g - target.g) * (c.g - target.g) +
      (c.b - target.b) * (c.b - target.b);
    if (d < bestDist) {
      bestDist = d;
      bestK = k;
    }
  }
  return bestK;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace("#", "");
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return { r, g, b };
}

/**
 * Render the image-placeholder card to a data: URL so the WebGL
 * subject plane can show it as a texture. Drawing canvas → toDataURL
 * keeps everything DOM-side (no extra network round-trip, no asset
 * to bundle). Called once per editor instance.
 *
 * Canvas size is large enough (512px) that the placeholder still
 * reads at full sphere size; smaller and the icon goes soft.
 */
function buildPlaceholderDataUrl(): string {
  const SIZE = 512;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  // 1. Opaque white base — required because the WebGL subject
  //    material renders with `transparent: false`, so any alpha in
  //    the canvas gets clamped and the RGB underneath bleeds. A
  //    transparent canvas reads as black on the GPU.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 2. Light-gray rounded card sits on top of the white base, with
  //    a small margin so the white "page" shows around it.
  const MARGIN = 24;
  const R = 28;
  ctx.fillStyle = "rgba(26, 26, 26, 0.08)";
  roundRect(ctx, MARGIN, MARGIN, SIZE - MARGIN * 2, SIZE - MARGIN * 2, R);
  ctx.fill();
  // 1px border at 10% alpha — matches the reference card's
  // `border border-dark/10`.
  ctx.strokeStyle = "rgba(26, 26, 26, 0.10)";
  ctx.lineWidth = 2;
  roundRect(
    ctx,
    MARGIN + 1,
    MARGIN + 1,
    SIZE - MARGIN * 2 - 2,
    SIZE - MARGIN * 2 - 2,
    R,
  );
  ctx.stroke();
  // Image icon — same vector as the reference HTML's SVG. Center,
  // about 40% of the canvas height.
  const ICON_W = 220;
  const ICON_H = 196;
  const cx = (SIZE - ICON_W) / 2;
  const cy = (SIZE - ICON_H) / 2;
  ctx.translate(cx, cy);
  // Scale 24-unit viewBox → ~210px.
  const SCALE = ICON_W / 24;
  ctx.scale(SCALE, SCALE);
  ctx.strokeStyle = "rgba(26, 26, 26, 0.40)";
  ctx.fillStyle = "rgba(26, 26, 26, 0.40)";
  ctx.lineWidth = 1.6 / SCALE;
  ctx.lineJoin = "round";
  // Rect frame.
  ctx.beginPath();
  roundRect(ctx, 3, 4, 18, 16, 2);
  ctx.stroke();
  // Sun circle.
  ctx.beginPath();
  ctx.arc(9, 10, 1.6, 0, Math.PI * 2);
  ctx.fill();
  // Mountain path.
  ctx.beginPath();
  ctx.moveTo(3, 17);
  ctx.lineTo(8, 12);
  ctx.lineTo(12, 16);
  ctx.lineTo(15, 13);
  ctx.lineTo(21, 19);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas.toDataURL("image/png");
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Counter-clockwise rotation arrow — same icon as the video
 *  editor's toolbar Reset (Feather/Lucide `rotate-ccw`). Reusing
 *  it keeps the design language consistent across editors. */
function resetIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
}

function refreshIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M.5 3v3h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 9V6h-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.25 5.5C9.99 4.79 9.56 4.15 8.99 3.65 8.42 3.14 7.74 2.79 7 2.62 6.26 2.45 5.49 2.47 4.76 2.68 4.03 2.89 3.36 3.28 2.82 3.82L.5 6M11.5 6L9.18 8.18C8.64 8.72 7.97 9.11 7.24 9.32 6.51 9.53 5.74 9.56 5 9.39 4.26 9.22 3.58 8.87 3.01 8.36 2.44 7.86 2.01 7.21 1.75 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
