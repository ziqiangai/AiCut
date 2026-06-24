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
  undo: "Undo",
  redo: "Redo",
  split: "Split",
  trimLeft: "Trim left edge",
  trimRight: "Trim right edge",
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
  exitFullscreen: "Exit fullscreen",
  exitFullscreenTitle: "Exit fullscreen (Esc)",
  newTrack: "+ New track",
  videoTrackLabel: "Video {n}",
  audioTrackLabel: "Audio {n}",
};

/** Simplified Chinese. */
export const localeZh: Locale = {
  undo: "撤销",
  redo: "重做",
  split: "分割",
  trimLeft: "向左裁剪",
  trimRight: "向右裁剪",
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
