/**
 * @aicut/react/lighting-v3 — Figma-driven v3 redesign of the
 * lighting picker. Same three.js bundle as v2 underneath, but a fresh
 * UI shell with the in-sphere rotation knob, CSS soap-bubble sphere,
 * and the brand-color Generate CTA.
 *
 * v2 (`@aicut/react/lighting`) is unchanged — adopt per-feature.
 */
export { LightingEditorV3 } from "./LightingEditorV3.js";
export type {
  LightingEditorV3Props,
  LightingEditorV3Api,
} from "./LightingEditorV3.js";

// Re-export the data + locale exports from the core sub-entry so
// hosts only need a single import line for everything v3-related.
export {
  DEFAULT_LIGHTING_CONFIG_V3,
  PRESET_DIRECTIONS,
  lightingLocaleEn,
  lightingLocaleZh,
  mergeLightingLocale,
  snapToPreset,
} from "@aicut/core/lighting-v3";
export type {
  KeyPresetV3,
  LightingConfigV3,
  LightingEditorV3Options,
  LightingLocale,
  LightingView,
} from "@aicut/core/lighting-v3";
