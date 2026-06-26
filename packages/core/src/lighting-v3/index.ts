/**
 * @aicut/core/lighting-v3 — Figma-driven redesign of the lighting
 * picker with a new `rotation` knob. Same three.js scene as v2 under
 * the hood (re-exported for tree-shaking) but a fresh chrome.
 *
 * v2 (`@aicut/core/lighting`) remains untouched — hosts can adopt v3
 * incrementally or run both side-by-side.
 */

export { LightingEditorV3 } from "./editor.js";
export {
  DEFAULT_LIGHTING_CONFIG_V3,
  type KeyPresetV3,
  type LightingConfigV3,
  type LightingEditorV3Options,
  type LightingView,
} from "./types.js";
// Re-export v2's locale + presets so hosts that already pass these to
// the v2 editor don't have to duplicate them for v3.
export {
  lightingLocaleEn,
  lightingLocaleZh,
  mergeLightingLocale,
  type LightingLocale,
} from "../lighting/i18n.js";
export {
  PRESET_DIRECTIONS,
  snapToPreset,
} from "../lighting/presets.js";
