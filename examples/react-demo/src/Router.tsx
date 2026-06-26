import { useEffect, useState } from "react";
import { App } from "./App.js";
import { LightingDemo } from "./LightingDemo.js";
import { LightingV3Demo } from "./LightingV3Demo.js";

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
    isActive: (h) => h === "#/" || h === "" || (!h.startsWith("#/lighting")),
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
        <a
          className="demo-topnav-github"
          href="https://github.com/ziqiangai/AiCut"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="demo-github-link"
          title="View source on GitHub"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span>GitHub</span>
        </a>
      </nav>
      <div className="demo-page">
        {onLightingV3 ? (
          <LightingV3Demo />
        ) : onLightingV2 ? (
          <LightingDemo />
        ) : (
          <App />
        )}
      </div>
    </div>
  );
}
