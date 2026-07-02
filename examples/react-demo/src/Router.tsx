import { useEffect, useState } from "react";
import { App } from "./App.js";
import { CompositionDemo } from "./CompositionDemo.js";
import { LightingDemo } from "./LightingDemo.js";
import { LightingV3Demo } from "./LightingV3Demo.js";
import { ApiPlayground } from "./ApiPlayground.js";

/**
 * Tiny hash-based router — keeps the demo dep-free. Two routes:
 *   #/           video editor (the original demo, default)
 *   #/lighting   the LightingEditor showcase
 *
 * No history.pushState games — hash routing has zero server-config
 * cost and survives Vite's static dev server without rewrites.
 *
 * `VITE_HIDE_LIGHTING=1` (set in CI for the public GitHub Pages build)
 * suppresses the lighting tabs + routes — visitors only see the
 * video editor. Local dev keeps everything visible by default.
 */
const HIDE_LIGHTING =
  Boolean(import.meta.env.VITE_HIDE_LIGHTING) &&
  import.meta.env.VITE_HIDE_LIGHTING !== "0" &&
  import.meta.env.VITE_HIDE_LIGHTING !== "false";
function useHash(): string {
  const [hash, setHash] = useState<string>(
    () => window.location.hash || "#/",
  );
  useEffect(() => {
    const sync = (): void => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return hash;
}

interface TabSpec {
  href: string;
  label: string;
  isActive: (hash: string) => boolean;
}

const TABS: TabSpec[] = [
  {
    href: "#/",
    label: "Video editor",
    isActive: (h) =>
      h === "#/" ||
      h === "" ||
      (!h.startsWith("#/lighting") &&
        !h.startsWith("#/composition") &&
        !h.startsWith("#/api")),
  },
  {
    href: "#/composition",
    label: "Composition (primitives)",
    isActive: (h: string) => h.startsWith("#/composition"),
  },
  {
    href: "#/api",
    label: "API playground 🧪",
    isActive: (h: string) => h.startsWith("#/api"),
  },
  ...(HIDE_LIGHTING
    ? []
    : ([
        {
          href: "#/lighting",
          label: "Lighting v2",
          isActive: (h: string) => h === "#/lighting",
        },
        {
          href: "#/lighting-v3",
          label: "Lighting v3 ★",
          isActive: (h: string) => h.startsWith("#/lighting-v3"),
        },
      ] satisfies TabSpec[])),
];

export function Router() {
  const hash = useHash();
  // When lighting is hidden in CI builds, accessing a `#/lighting*`
  // URL falls through to the video editor instead of rendering a
  // dead route. Local dev keeps both routes live.
  const onLightingV3 = !HIDE_LIGHTING && hash.startsWith("#/lighting-v3");
  const onLightingV2 = !HIDE_LIGHTING && hash === "#/lighting";
  const onComposition = hash.startsWith("#/composition");
  const onApi = hash.startsWith("#/api");

  return (
    <div className="demo-root">
      <nav className="demo-topnav">
        <div className="demo-topnav-brand">AiCut · demo</div>
        <div className="demo-topnav-tabs">
          {TABS.map((t) => (
            <a
              key={t.href}
              href={t.href}
              className={
                "demo-topnav-tab" + (t.isActive(hash) ? " active" : "")
              }
              data-testid={`demo-tab-${t.href.replace("#/", "") || "home"}`}
            >
              {t.label}
            </a>
          ))}
        </div>
      </nav>
      <div className="demo-page">
        {onLightingV3 ? (
          <LightingV3Demo />
        ) : onLightingV2 ? (
          <LightingDemo />
        ) : onComposition ? (
          <CompositionDemo />
        ) : onApi ? (
          <ApiPlayground />
        ) : (
          <App />
        )}
      </div>
    </div>
  );
}
