# @aicut/vue

> Vue 3 wrapper for the **AiCut** video editor — canvas timeline, custom toolbar slots, theming, i18n, drop-in `<VideoEditor>`.

[![npm](https://img.shields.io/npm/v/@aicut/vue.svg)](https://www.npmjs.com/package/@aicut/vue)
[![License](https://img.shields.io/npm/l/@aicut/vue.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/repo-ziqiangai/AiCut-181717?logo=github)](https://github.com/ziqiangai/AiCut)

![AiCut editor](https://raw.githubusercontent.com/ziqiangai/AiCut/main/docs/screenshots/editor-dark.png)

## Install

```bash
pnpm add @aicut/vue @aicut/core
```

## Quick start

```vue
<script setup lang="ts">
import { ref } from "vue";
import {
  VideoEditor,
  type EditorApi,
  type Project,
} from "@aicut/vue";
import "@aicut/core/styles.css";

const project: Project = {
  version: 1,
  sources: [
    { id: "s1", url: "/media/a.mp4", kind: "video", name: "a.mp4" },
  ],
  tracks: [{
    id: "t1",
    kind: "video",
    clips: [{ id: "c1", sourceId: "s1", in: 0, out: 5000, start: 0 }],
  }],
};

const editor = ref<{ api(): EditorApi | null } | null>(null);

function save(p: Project) {
  console.log("autosave", p);
}

async function doExport(p: Project) {
  await fetch("/api/export", {
    method: "POST",
    body: JSON.stringify({ project: p }),
  });
}
</script>

<template>
  <VideoEditor
    ref="editor"
    :default-project="project"
    @change="save"
    @export="doExport"
    style="height: 600px"
  />
</template>
```

The component is **uncontrolled for project state**. Restore later with:

```ts
editor.value?.api()?.setProject(saved);
```

## Props

```ts
interface VideoEditorProps {
  defaultProject?: Project;
  theme?: Theme;            // CSS-var overrides; reactive
  locale?: Partial<Locale>; // EN default; pass localeZh for ZH; reactive
}
```

## Events

```ts
ready              (api: EditorApi)
change             (project: Project)
export             (project: Project)        // fired by api.requestExport()
time-update        (timeMs: number)
play               ()
pause              ()
selection-change   (clipId: string | null)
error              (error: Error)
```

The exposed `api()` returns the full **`EditorApi`** described in [@aicut/core](https://www.npmjs.com/package/@aicut/core) — `play`, `pause`, `seek`, `split`, `setProject`, `requestExport`, `setTheme`, `setLocale`, and more.

## Theming

```vue
<VideoEditor
  :theme="{
    controlsBg: '#f6f6f8',
    controlsText: 'rgba(0, 0, 0, 0.78)',
    controlsBorder: 'rgba(0, 0, 0, 0.08)',
    controlsHover: 'rgba(0, 0, 0, 0.06)',
    controlsActive: 'rgba(0, 0, 0, 0.08)',
    previewBg: '#e4e4e7',
  }"
  /* … */
/>
```

## i18n

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import { VideoEditor, localeEn, localeZh, type Locale } from "@aicut/vue";

const lang = ref<"en" | "zh">("en");
const locale = computed<Locale>(() =>
  lang.value === "zh" ? localeZh : localeEn,
);
</script>

<template>
  <VideoEditor :locale="locale" /* … */ />
</template>
```

`locale` swap re-titles the toolbar and re-paints canvas labels in place.

## Standalone `<Timeline>`

```vue
<script setup lang="ts">
import { ref } from "vue";
import { Timeline } from "@aicut/vue";

const picked = ref(0);
</script>

<template>
  <Timeline
    :default-project="singleClipProject"
    :show-header="false"
    read-only
    @seek="(ms) => (picked = ms)"
  />
</template>
```

---

[Full docs & demo](https://github.com/ziqiangai/AiCut) · [@aicut/core](https://www.npmjs.com/package/@aicut/core) · [@aicut/react](https://www.npmjs.com/package/@aicut/react)
