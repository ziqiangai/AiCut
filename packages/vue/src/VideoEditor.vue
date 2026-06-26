<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Editor,
  type AspectRatio,
  type EditorApi,
  type Locale,
  type Ms,
  type PlaybackEngineFactory,
  type Project,
  type Theme,
} from "@aicut/core";

/**
 * Vue 3 wrapper around `@aicut/core`. Same shape as `@aicut/react`:
 * uncontrolled for project state, theme is reactive, API exposed via
 * `defineExpose` so a parent `ref` can call cut/seek/setProject/etc.
 */
const props = defineProps<{
  defaultProject?: Project;
  theme?: Theme;
  /** UI string overrides (English default). Reactive — swap to `localeZh` for Chinese. */
  locale?: Partial<Locale>;
  /**
   * Initial-only factory for a custom playback engine. Defaults to the
   * built-in `HtmlVideoEngine`. Pass `WebCodecsEngine` (v0.6+) or your
   * own engine to override. Bound at mount; later prop changes are
   * ignored.
   */
  playbackEngine?: PlaybackEngineFactory;
  /**
   * Initial-only — pixel height of each track row (default 56). Lower
   * values (~32–40) shrink the timeline for small viewports. Applied
   * process-wide at construction time.
   */
  trackHeight?: number;
  /** Initial-only — pixel height of the timeline ruler (default 24). */
  rulerHeight?: number;
  /**
   * Pixel height of the whole bottom timeline area (default 240).
   * Reactive — swap any time to recompact. The canvas inside fills
   * 100% and shows an internal scrollbar when track count overflows.
   */
  timelineHeight?: number;
  /**
   * Per-clip keyframe animation (X / Y / Scale). Reactive — set
   * `{ enabled: true }` to surface keyframe diamonds on the timeline
   * and route the canvas-based engines through the transform pipeline.
   * Data is preserved when disabled.
   */
  keyframes?: { enabled?: boolean };
  /**
   * Jump-to-clip-edge toolbar cluster (|◀ ▶|) + I/O keyboard shortcuts.
   * Reactive — set `{ enabled: true }` to surface the buttons next to
   * the keyframe diamond and bind the shortcuts. Off hides the buttons
   * entirely (no toolbar space cost).
   */
  clipEdgeNav?: { enabled?: boolean };
  /**
   * Dashed outline of the output canvas on top of the preview.
   * Defaults to `{ enabled: true }` — purely visual. Set
   * `{ enabled: false }` to hide it entirely. Independent of
   * `keyframes`; when keyframes mode is also on the frame body
   * becomes draggable and grows corner scale handles.
   */
  previewFrame?: { enabled?: boolean };
  /**
   * Multi-track picture-in-picture compositing in the preview. Off
   * by default. Reactive — set `{ enabled: true }` to composite
   * every video track's active clip with track `0` on top. Audio
   * policy: only top track unmuted; lower tracks mute.
   */
  pictureInPicture?: { enabled?: boolean; toolbarAdd?: boolean };
  /**
   * Built-in aspect-ratio picker (CapCut-style 比例 dropdown). Reactive
   * — set `{ enabled: true }` to surface the chip at the left of the
   * toolbar. Listen for `aspectChange` to drive your preview letterbox
   * / export defaults.
   */
  aspect?: { enabled?: boolean };
}>();

const emit = defineEmits<{
  (e: "ready", api: EditorApi): void;
  (e: "change", project: Project): void;
  (e: "export", project: Project): void;
  (e: "timeUpdate", timeMs: Ms): void;
  (e: "play"): void;
  (e: "pause"): void;
  (e: "selectionChange", clipId: string | null): void;
  (
    e: "keyframeSelectionChange",
    target: { clipId: string; keyframeId: string } | null,
  ): void;
  (e: "aspectChange", aspect: AspectRatio | null): void;
  (e: "pictureInPictureAddRequested"): void;
  (e: "error", error: Error): void;
}>();

const host = ref<HTMLDivElement | null>(null);
let editor: Editor | null = null;
const offs: Array<() => void> = [];
/** Header slot DOM nodes — set after editor mount so Vue Teleports
 *  have a valid target. Library renders nothing here; named slots
 *  `#headerLeft` / `#headerRight` portal whatever the host provides. */
const headerLeftSlot = ref<HTMLElement | null>(null);
const headerRightSlot = ref<HTMLElement | null>(null);

onMounted(() => {
  if (!host.value) return;
  editor = Editor.create({
    container: host.value,
    project: props.defaultProject,
    theme: props.theme,
    locale: props.locale,
    playbackEngine: props.playbackEngine,
    ...(props.trackHeight != null ? { trackHeight: props.trackHeight } : {}),
    ...(props.rulerHeight != null ? { rulerHeight: props.rulerHeight } : {}),
    ...(props.timelineHeight != null
      ? { timelineHeight: props.timelineHeight }
      : {}),
    ...(props.keyframes != null ? { keyframes: props.keyframes } : {}),
    ...(props.clipEdgeNav != null ? { clipEdgeNav: props.clipEdgeNav } : {}),
    ...(props.previewFrame != null
      ? { previewFrame: props.previewFrame }
      : {}),
    ...(props.pictureInPicture != null
      ? { pictureInPicture: props.pictureInPicture }
      : {}),
    ...(props.aspect != null ? { aspect: props.aspect } : {}),
  });

  offs.push(
    editor.on("change", ({ project }) => emit("change", project)),
    editor.on("export", ({ project }) => emit("export", project)),
    editor.on("time", ({ timeMs }) => emit("timeUpdate", timeMs)),
    editor.on("play", () => emit("play")),
    editor.on("pause", () => emit("pause")),
    editor.on("selectionChange", ({ clipId }) =>
      emit("selectionChange", clipId),
    ),
    editor.on("keyframeSelectionChange", ({ target }) =>
      emit("keyframeSelectionChange", target),
    ),
    editor.on("aspectChange", ({ aspect }) => emit("aspectChange", aspect)),
    editor.on("requestPictureInPictureAdd", () =>
      emit("pictureInPictureAddRequested"),
    ),
    editor.on("error", ({ error }) => emit("error", error)),
  );

  headerLeftSlot.value = editor.headerLeft;
  headerRightSlot.value = editor.headerRight;
  emit("ready", editor);
});

watch(
  () => props.theme,
  (theme) => {
    if (theme && editor) editor.setTheme(theme);
  },
);

watch(
  () => props.locale,
  (locale) => {
    if (locale && editor) editor.setLocale(locale);
  },
);

// Reactive — flip keyframe mode without remount. Data preserved.
watch(
  () => props.keyframes?.enabled,
  (enabled) => {
    if (!editor) return;
    const desired = enabled === true;
    if (editor.isKeyframesEnabled() !== desired) {
      editor.setKeyframesEnabled(desired);
    }
  },
);

// Reactive — flip clip-edge nav cluster (|◀ ▶|) + I/O shortcuts.
watch(
  () => props.clipEdgeNav?.enabled,
  (enabled) => {
    if (!editor) return;
    const desired = enabled === true;
    if (editor.isClipEdgeNavEnabled() !== desired) {
      editor.setClipEdgeNavEnabled(desired);
    }
  },
);

// Reactive — flip the dashed output-frame outline.
watch(
  () => props.previewFrame?.enabled,
  (enabled) => {
    if (!editor) return;
    const desired = enabled !== false;
    if (editor.isPreviewFrameEnabled() !== desired) {
      editor.setPreviewFrameEnabled(desired);
    }
  },
);

// Reactive — flip multi-track PiP compositing.
watch(
  () => props.pictureInPicture?.enabled,
  (enabled) => {
    if (!editor) return;
    const desired = enabled === true;
    if (editor.isPictureInPictureEnabled() !== desired) {
      editor.setPictureInPictureEnabled(desired);
    }
  },
);

// Reactive — flip built-in aspect picker visibility.
watch(
  () => props.aspect?.enabled,
  (enabled) => {
    if (!editor) return;
    const desired = enabled === true;
    if (editor.isAspectEnabled() !== desired) {
      editor.setAspectEnabled(desired);
    }
  },
);

// Reactive — sets the CSS custom property directly so the timeline
// height can be tweaked without remounting.
watch(
  () => props.timelineHeight,
  (timelineHeight) => {
    const root = host.value;
    if (!root) return;
    if (timelineHeight != null && timelineHeight > 0) {
      root.style.setProperty(
        "--aicut-timeline-height",
        `${Math.round(timelineHeight)}px`,
      );
    } else {
      root.style.removeProperty("--aicut-timeline-height");
    }
  },
);

onBeforeUnmount(() => {
  for (const off of offs) off();
  offs.length = 0;
  editor?.destroy();
  editor = null;
  headerLeftSlot.value = null;
  headerRightSlot.value = null;
});

defineExpose({
  /** Returns the underlying core API or null if not yet mounted. */
  api: (): EditorApi | null => editor,
});
</script>

<template>
  <div ref="host" data-aicut-host="">
    <Teleport v-if="headerLeftSlot" :to="headerLeftSlot">
      <slot name="headerLeft" />
    </Teleport>
    <Teleport v-if="headerRightSlot" :to="headerRightSlot">
      <slot name="headerRight" />
    </Teleport>
  </div>
</template>
