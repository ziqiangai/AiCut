# @aicut/react

> React wrapper for the **AiCut** video editor — canvas timeline, custom toolbar slots, theming, i18n, drop-in `<VideoEditor>`.

[![npm](https://img.shields.io/npm/v/@aicut/react.svg)](https://www.npmjs.com/package/@aicut/react)
[![License](https://img.shields.io/npm/l/@aicut/react.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/repo-ziqiangai/AiCut-181717?logo=github)](https://github.com/ziqiangai/AiCut)

![AiCut editor](https://raw.githubusercontent.com/ziqiangai/AiCut/main/docs/screenshots/editor-dark.png)

## Install

```bash
pnpm add @aicut/react @aicut/core
```

## Quick start

```tsx
import { useRef } from "react";
import {
  VideoEditor,
  type VideoEditorApi,
  type Project,
} from "@aicut/react";
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

export function Editor() {
  const apiRef = useRef<VideoEditorApi | null>(null);
  return (
    <VideoEditor
      apiRef={apiRef}
      defaultProject={project}
      onChange={(p) => console.log("autosave", p)}
      onExport={(p) => fetch("/api/export", {
        method: "POST",
        body: JSON.stringify({ project: p }),
      })}
      style={{ height: 600 }}
    />
  );
}
```

The component is **uncontrolled for project state** — the editor owns the current project. To restore from JSON later:

```ts
apiRef.current?.setProject(savedJson);
```

## Props

```ts
interface VideoEditorProps {
  defaultProject?: Project;

  theme?: Theme;                         // CSS-var overrides; reactive
  locale?: Partial<Locale>;              // EN default; pass localeZh for ZH

  toolbarLeft?: ReactNode;               // host controls — left bookend
  toolbarRight?: ReactNode;              //                 right bookend

  apiRef?: Ref<VideoEditorApi | null>;

  onReady?: (api: VideoEditorApi) => void;
  onChange?: (project: Project) => void;
  onExport?: (project: Project) => void; // fired by api.requestExport()
  onTimeUpdate?: (ms: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSelectionChange?: (clipId: string | null) => void;
  onError?: (err: Error) => void;

  className?: string;
  style?: CSSProperties;
}
```

The `apiRef` value exposes the full **`EditorApi`** — `play`, `pause`, `seek`, `split`, `trimLeft`, `trimRight`, `setProject`, `getProject`, `addSource`, `addTrack`, `removeClip`, `undo`, `redo`, `setTheme`, `setLocale`, `requestExport`, and more. See [@aicut/core](https://www.npmjs.com/package/@aicut/core) for the complete surface.

## Custom toolbar controls

The editor's top toolbar reserves bookend slots for any React node. The library hides the visual separator until you put something in them.

```tsx
<VideoEditor
  apiRef={apiRef}
  defaultProject={project}
  toolbarLeft={
    <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
      <option value="16:9">16:9</option>
      <option value="9:16">9:16</option>
      <option value="1:1">1:1</option>
    </select>
  }
  toolbarRight={
    <button onClick={() => apiRef.current?.requestExport()}>Export</button>
  }
/>
```

`api.requestExport()` fires the `export` event with the current project JSON, which flows back through your `onExport` prop. Your handler decides whether to POST to a backend, download locally, etc.

## Theming

```tsx
<VideoEditor
  theme={{
    controlsBg: "#f6f6f8",
    controlsText: "rgba(0, 0, 0, 0.78)",
    controlsBorder: "rgba(0, 0, 0, 0.08)",
    controlsHover: "rgba(0, 0, 0, 0.06)",
    controlsActive: "rgba(0, 0, 0, 0.08)",
    previewBg: "#e4e4e7",      // letterbox colour around the video
  }}
  /* … */
/>
```

The `theme` prop is reactive — swap it any time and the editor calls `setTheme` internally.

## i18n

```tsx
import { VideoEditor, localeZh } from "@aicut/react";

// Whole-locale swap
<VideoEditor locale={localeZh} /* … */ />

// Partial override
<VideoEditor locale={{ undo: "Annuler" }} /* … */ />
```

`locale` is reactive too — runtime swap re-titles the toolbar and re-paints canvas labels in place.

## Standalone `<Timeline>`

Use the canvas timeline without the rest of the editor — frame-pickers, thumbnail strips, read-only previews.

```tsx
import { Timeline, type TimelineApi } from "@aicut/react";

<Timeline
  apiRef={timelineRef}
  defaultProject={singleClipProject}
  showHeader={false}
  readOnly
  toolbar                                            // 36px top strip
  toolbarLeft={<span>Picked at {ms / 1000}s</span>}
  toolbarRight={<button onClick={pick}>Use frame</button>}
  onSeek={(ms) => setPicked(ms)}
/>
```

---

[Full docs & demo](https://github.com/ziqiangai/AiCut) · [@aicut/core](https://www.npmjs.com/package/@aicut/core) · [@aicut/vue](https://www.npmjs.com/package/@aicut/vue)
