/**
 * Lighting-editor-specific string keys. Kept in a SEPARATE interface
 * from the video editor's `Locale` so the timeline-only consumer's
 * type doesn't grow unused fields, but exported so a single host
 * locale object can spread both shapes together.
 */
export interface LightingLocale {
  lightingGlobalTitle: string;
  lightingSmartMode: string;
  lightingBrightness: string;
  lightingColor: string;
  lightingKeyTitle: string;
  lightingRim: string;
  lightingViewPerspective: string;
  lightingViewFront: string;
  // Six canonical key-light direction buttons
  lightingDirLeft: string;
  lightingDirRight: string;
  lightingDirTop: string;
  lightingDirBottom: string;
  lightingDirFront: string;
  lightingDirBack: string;
  // ---- v3-only fields ----
  /** Section label above the color-temperature slider. */
  lightingColorTemp: string;
  /** Section label above the in-sphere rotation slider. */
  lightingRotation: string;
  /** Brand-color CTA label at the bottom-right of v3. */
  lightingGenerate: string;
  /** Bottom-left "Reset" button label in V3. */
  lightingReset: string;
}

export const lightingLocaleEn: LightingLocale = {
  lightingGlobalTitle: "Global",
  lightingSmartMode: "Smart mode",
  lightingBrightness: "Brightness",
  lightingColor: "Color",
  lightingKeyTitle: "Key light",
  lightingRim: "Rim light",
  lightingViewPerspective: "Perspective",
  lightingViewFront: "Front",
  lightingDirLeft: "Left",
  lightingDirRight: "Right",
  lightingDirTop: "Top",
  lightingDirBottom: "Bottom",
  lightingDirFront: "Front",
  lightingDirBack: "Back",
  lightingColorTemp: "Color temperature",
  lightingRotation: "Rotation",
  lightingGenerate: "Generate",
  lightingReset: "Reset",
};

export const lightingLocaleZh: LightingLocale = {
  lightingGlobalTitle: "全局",
  lightingSmartMode: "智能模式",
  lightingBrightness: "亮度",
  lightingColor: "颜色",
  lightingKeyTitle: "主光源",
  lightingRim: "轮廓光",
  lightingViewPerspective: "透视",
  lightingViewFront: "正面",
  lightingDirLeft: "左侧",
  lightingDirRight: "右侧",
  lightingDirTop: "顶部",
  lightingDirBottom: "底部",
  lightingDirFront: "前方",
  lightingDirBack: "后方",
  lightingColorTemp: "色温",
  lightingRotation: "旋转角度",
  lightingGenerate: "生成",
  lightingReset: "重置",
};

export function mergeLightingLocale(
  partial: Partial<LightingLocale> | undefined,
): LightingLocale {
  return partial ? { ...lightingLocaleEn, ...partial } : lightingLocaleEn;
}
