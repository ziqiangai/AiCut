/**
 * UI strings the editor paints into the DOM (toolbar tooltips, the
 * fullscreen exit button) and onto the timeline canvas (phantom new-
 * track label, track header labels). Every user-visible literal in
 * `@aicut/core` flows through this interface — there are no hidden
 * hard-coded translations elsewhere in the library.
 *
 * Defaults to English. Hosts that want Chinese (or any other locale)
 * pass `locale: localeZh` to `Editor.create` / `Timeline.create`, or
 * override individual keys with `locale: { undo: "撤销" }`.
 */
export interface Locale {
  // Toolbar tooltips
  undo: string;
  redo: string;
  split: string;
  trimLeft: string;
  trimRight: string;
  playPause: string;
  fullscreen: string;
  snap: string;
  /** Title shown on the snap button when snap is ON (clicking turns OFF). */
  snapOnTitle: string;
  /** Title shown when snap is OFF (clicking turns ON). */
  snapOffTitle: string;
  zoomOut: string;
  zoomIn: string;
  reset: string;
  /** Toolbar tooltip when no keyframe exists at the playhead. */
  keyframeAdd: string;
  /** Toolbar tooltip when one exists — clicking removes it. */
  keyframeRemove: string;
  /** Toolbar tooltip — jump the playhead to the selected clip's start. */
  seekClipStart: string;
  /** Toolbar tooltip — jump the playhead to the selected clip's end. */
  seekClipEnd: string;

  /** Toolbar tooltip — "+ PiP overlay" action button (host's file
   *  picker takes over on click). */
  pipAdd: string;

  // Aspect-ratio picker (built-in, opt-in via aspect.enabled)
  /** Toolbar button tooltip — opens the aspect picker popover. */
  aspectTitle: string;
  /** Header inside the popover — sits above the ratio grid. */
  aspectMenuLabel: string;
  /** Label for the "follow source clip" item — clears `Project.aspect`. */
  aspectOriginal: string;

  // Keyframe panel chrome
  /** Header text on the keyframe parameter panel. */
  keyframePanelTitle: string;
  /** Row label for the X-translation numeric input. */
  keyframePanelLabelX: string;
  /** Row label for the Y-translation numeric input. */
  keyframePanelLabelY: string;
  /** Row label for the scale numeric input. */
  keyframePanelLabelScale: string;
  /** Row label for the easing dropdown. */
  keyframePanelLabelEasing: string;
  /** Reset button label — pins this kf to identity (0, 0, 1). */
  keyframePanelReset: string;
  /** Reset button tooltip. */
  keyframePanelResetTitle: string;
  /** Badge tooltip — kf for THIS prop is pinned at this moment. */
  keyframePanelBadgePinned: string;
  /** Badge tooltip — prop has kfs elsewhere but not at this moment. */
  keyframePanelBadgeAnimated: string;
  /** Badge tooltip — prop has no kfs (riding the static base). */
  keyframePanelBadgeStatic: string;
  /** Time display suffix — appended after the seconds value. */
  keyframePanelTimeSuffix: string;
  // Easing dropdown options (curve names)
  keyframeEasingLinear: string;
  keyframeEasingEaseIn: string;
  keyframeEasingEaseOut: string;
  keyframeEasingEaseInOut: string;

  // Fullscreen exit overlay
  exitFullscreen: string;
  exitFullscreenTitle: string;

  // Timeline canvas labels
  /** Phantom row that appears under the last track during a drag. */
  newTrack: string;
  /** Track header — `{n}` is replaced with the 1-based track index. */
  videoTrackLabel: string;
  /** Same template format as videoTrackLabel. */
  audioTrackLabel: string;
}

/** English. The library default — chosen over Chinese as the OSS norm. */
export const localeEn: Locale = {
  undo: "Undo (⌘Z)",
  redo: "Redo (⇧⌘Z)",
  split: "Split (K)",
  trimLeft: "Trim left edge (Q)",
  trimRight: "Trim right edge (W)",
  playPause: "Play / Pause (Space)",
  fullscreen: "Fullscreen preview",
  snap: "Snap",
  snapOnTitle: "Turn off snap",
  snapOffTitle: "Turn on snap",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  reset: "Reset edits (keep sources)",
  keyframeAdd: "Add keyframe at playhead",
  keyframeRemove: "Remove keyframe at playhead",
  seekClipStart: "Jump to clip start (I)",
  seekClipEnd: "Jump to clip end (O)",
  pipAdd: "Add picture-in-picture overlay",
  aspectTitle: "Aspect ratio",
  aspectMenuLabel: "Aspect ratio",
  aspectOriginal: "Original",
  keyframePanelTitle: "Keyframe",
  keyframePanelLabelX: "X",
  keyframePanelLabelY: "Y",
  keyframePanelLabelScale: "Scale",
  keyframePanelLabelEasing: "Easing",
  keyframePanelReset: "Reset to 0 0 1",
  keyframePanelResetTitle:
    "Pin this keyframe to identity (panX=0, panY=0, scale=1)",
  keyframePanelBadgePinned: "Pinned at this moment",
  keyframePanelBadgeAnimated: "Animated — but not pinned at this exact moment",
  keyframePanelBadgeStatic: "Static value",
  keyframePanelTimeSuffix: "s",
  keyframeEasingLinear: "Linear",
  keyframeEasingEaseIn: "Ease in",
  keyframeEasingEaseOut: "Ease out",
  keyframeEasingEaseInOut: "Ease in-out",
  exitFullscreen: "Exit fullscreen",
  exitFullscreenTitle: "Exit fullscreen (Esc)",
  newTrack: "+ New track",
  videoTrackLabel: "Video {n}",
  audioTrackLabel: "Audio {n}",
};

/** Simplified Chinese. */
export const localeZh: Locale = {
  undo: "撤销 (⌘Z)",
  redo: "重做 (⇧⌘Z)",
  split: "分割 (K)",
  trimLeft: "向左裁剪 (Q)",
  trimRight: "向右裁剪 (W)",
  playPause: "播放 / 暂停 (Space)",
  fullscreen: "全屏预览",
  snap: "吸附",
  snapOnTitle: "关闭吸附",
  snapOffTitle: "开启吸附",
  zoomOut: "缩小",
  zoomIn: "放大",
  reset: "重置编辑（保留视频源）",
  keyframeAdd: "添加关键帧",
  keyframeRemove: "删除当前关键帧",
  seekClipStart: "跳到片段起点 (I)",
  seekClipEnd: "跳到片段末尾 (O)",
  pipAdd: "添加画中画",
  aspectTitle: "比例",
  aspectMenuLabel: "画面比例",
  aspectOriginal: "原始",
  keyframePanelTitle: "关键帧",
  keyframePanelLabelX: "X 位移",
  keyframePanelLabelY: "Y 位移",
  keyframePanelLabelScale: "缩放",
  keyframePanelLabelEasing: "缓动",
  keyframePanelReset: "重置为 0 0 1",
  keyframePanelResetTitle:
    "将该关键帧重置为初始姿态（panX=0, panY=0, scale=1）",
  keyframePanelBadgePinned: "已在该时刻固定",
  keyframePanelBadgeAnimated: "整段有动画，但当前时刻没有锁点",
  keyframePanelBadgeStatic: "未动画（沿用静态值）",
  keyframePanelTimeSuffix: "秒",
  keyframeEasingLinear: "线性",
  keyframeEasingEaseIn: "缓入",
  keyframeEasingEaseOut: "缓出",
  keyframeEasingEaseInOut: "缓入缓出",
  exitFullscreen: "退出全屏",
  exitFullscreenTitle: "退出全屏 (Esc)",
  newTrack: "+ 新轨道",
  videoTrackLabel: "视频 {n}",
  audioTrackLabel: "音频 {n}",
};

/** Spread defaults under host overrides — host can supply a partial. */
export function mergeLocale(partial: Partial<Locale> | undefined): Locale {
  return partial ? { ...localeEn, ...partial } : localeEn;
}

/**
 * Replace `{key}` placeholders in a template. We only need `{n}`
 * substitution today; the implementation is generic so additional
 * keys (e.g. `{name}`) won't need a second pass.
 */
export function formatLabel(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}
