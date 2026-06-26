import type { Theme } from "../types.js";
import type { Locale } from "../i18n.js";
import type { LightingLocale } from "../lighting/i18n.js";
import type { LightingView } from "../lighting/types.js";

export type { LightingView } from "../lighting/types.js";

/**
 * V3 keeps the v2 data shape — same `keyDirection` / `brightness` /
 * `color` / `keyPreset` — and grows ONE new field:
 *
 *   rotation: degrees, 0..360, clockwise as seen by the user looking
 *   at the front of the sphere. Applied as `subjectMesh.rotation.z`
 *   in the scene. Independent of `keyDirection` — the light dot
 *   stays where the user put it while the subject spins under it.
 *
 * Existing v2 projects round-trip cleanly: a v2 LightingConfig is
 * also a valid v3 config (rotation defaults to 0).
 */
export type KeyPresetV3 =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "custom";

export interface LightingConfigV3 {
  brightness: number;
  color: string;
  keyDirection: { x: number; y: number; z: number };
  keyPreset: KeyPresetV3;
  rim: boolean;
  /** In-sphere image rotation, degrees. Default 0. */
  rotation: number;
}

export interface LightingEditorV3Options {
  container: HTMLElement;
  subjectImageUrl?: string;
  config?: Partial<LightingConfigV3>;
  theme?: Theme;
  locale?: Partial<Locale & LightingLocale>;
  /** Title chip rendered above the sphere panel. Defaults to "智能光源" / "Smart light". */
  title?: string;
  /** The "Generate" CTA copy at the bottom-right. Default "生成" / "Generate". */
  generateLabel?: string;
  /** Number / string badge painted at the right of the Generate CTA
   *  (matches the Figma reference's "✦ 2" pill). Omit to hide. */
  generateBadge?: number | string;
  /** Initial scene camera mode. Default "perspective". Switchable
   *  via the top-center pill in the scene column. */
  view?: LightingView;
  /**
   * Color scheme — `"light"` (default, white card) or `"dark"` (dark
   * card). Different from `theme` (which only sets CSS variables);
   * `mode` flips a data attribute on the root that swaps the v3
   * palette wholesale. Reactive via `setMode("dark" | "light")`. */
  mode?: "light" | "dark";
  /** Fires on EVERY config mutation. */
  onChange?: (cfg: LightingConfigV3) => void;
  /** Fires when the user clicks the brand Generate CTA. */
  onGenerate?: (cfg: LightingConfigV3) => void;
  /** Fires when the user clicks the top-right close (×) button. */
  onClose?: () => void;
  /** Fires when the user toggles the perspective / front view pill. */
  onViewChange?: (view: LightingView) => void;
  /** Fires when the user clicks the bottom-left Reset button. */
  onReset?: () => void;
}

export const DEFAULT_LIGHTING_CONFIG_V3: LightingConfigV3 = {
  brightness: 0.5,
  color: "#ffffff",
  keyDirection: { x: 0, y: 0, z: 1 },
  keyPreset: "front",
  rim: false,
  rotation: 0,
};
