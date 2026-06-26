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
 */
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
  {
    href: "#/lighting",
    label: "Lighting v2",
    isActive: (h) => h === "#/lighting",
  },
  {
    href: "#/lighting-v3",
    label: "Lighting v3 ★",
    isActive: (h) => h.startsWith("#/lighting-v3"),
  },
];

export function Router() {
  const hash = useHash();
  const onLightingV3 = hash.startsWith("#/lighting-v3");
  const onLightingV2 = hash === "#/lighting";

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
        ) : (
          <App />
        )}
      </div>
    </div>
  );
}
