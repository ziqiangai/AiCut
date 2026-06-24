<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import {
  LightingEditor as CoreLightingEditor,
  type LightingConfig,
  type LightingEditorOptions,
  type LightingView,
} from "@aicut/core/lighting";
import type { Theme } from "@aicut/core";

const props = defineProps<{
  subjectImageUrl?: string;
  defaultConfig?: Partial<LightingConfig>;
  defaultView?: LightingView;
  theme?: Theme;
  locale?: LightingEditorOptions["locale"];
}>();

const emit = defineEmits<{
  (e: "ready", api: CoreLightingEditor): void;
  (e: "change", cfg: LightingConfig): void;
}>();

const host = useTemplateRef<HTMLDivElement>("host");
let editor: CoreLightingEditor | null = null;
/**
 * Footer slot DOM node — set after mount so the Teleport target
 * exists before Vue tries to portal slot content into it.
 */
const footerSlot = ref<HTMLElement | null>(null);

onMounted(() => {
  if (!host.value) return;
  editor = CoreLightingEditor.create({
    container: host.value,
    subjectImageUrl: props.subjectImageUrl,
    config: props.defaultConfig,
    view: props.defaultView,
    theme: props.theme,
    locale: props.locale,
    onChange: (cfg) => emit("change", cfg),
  });
  footerSlot.value = editor.controlsFooter;
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
    if (editor) editor.setLocale(locale ?? {});
  },
);
watch(
  () => props.subjectImageUrl,
  (url) => {
    if (url && editor) editor.setSubjectImage(url);
  },
);

onBeforeUnmount(() => {
  editor?.destroy();
  editor = null;
  footerSlot.value = null;
});

defineExpose({
  api: (): CoreLightingEditor | null => editor,
});
</script>

<template>
  <div ref="host" data-aicut-lighting-host="">
    <Teleport v-if="footerSlot" :to="footerSlot">
      <slot name="controlsFooter" />
    </Teleport>
  </div>
</template>
