import { useRef, useState } from "react";
import {
  LightingEditorV3,
  DEFAULT_LIGHTING_CONFIG_V3,
  lightingLocaleZh,
  type LightingConfigV3,
  type LightingEditorV3Api,
} from "@aicut/react/lighting-v3";
import "@aicut/core/lighting-v3.css";

/**
 * Demo of the React wrapper for the v3 lighting picker. Shows:
 *   - `theme` prop (drives the CSS variables on the host)
 *   - `defaultConfig` + `onChange` for controlled-ish state mirror
 *   - `generateBadge` reactive prop
 *   - apiRef + imperative `reset()` button
 */
export function LightingV3Demo() {
  const apiRef = useRef<LightingEditorV3Api | null>(null);
  const [config, setConfig] = useState<LightingConfigV3>(
    DEFAULT_LIGHTING_CONFIG_V3,
  );
  const [badge, setBadge] = useState<number>(2);
  const [mode, setMode] = useState<"light" | "dark">("light");

  return (
    <div
      style={{
        padding: 24,
        // Page bg follows the picked mode so light/dark contrast
        // reads outside the editor card too.
        background: mode === "dark" ? "#0d0d10" : "#f5f5f7",
        color: mode === "dark" ? "#fafafa" : "#1a1a1a",
        minHeight: "100vh",
        boxSizing: "border-box",
        transition: "background 160ms ease, color 160ms ease",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            margin: "0 0 16px",
          }}
        >
          Lighting picker — V3 (React wrapper)
        </h2>

        <LightingEditorV3
          apiRef={apiRef}
          locale={lightingLocaleZh}
          generateBadge={badge}
          mode={mode}
          onChange={(c) => setConfig(c)}
          onGenerate={(c) => {
            // eslint-disable-next-line no-console
            console.log("[v3 demo] Generate clicked with config:", c);
            alert(
              `Generate clicked\n\nbrightness: ${c.brightness}\nrotation: ${c.rotation}°\nkey: ${c.keyPreset}\ndirection: ${JSON.stringify(c.keyDirection)}`,
            );
          }}
          onClose={() => {
            // eslint-disable-next-line no-console
            console.log("[v3 demo] Close clicked");
          }}
        />

        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
            data-testid="demo-lighting-v3-theme-toggle"
            style={{
              ...demoButtonStyle,
              background: mode === "dark" ? "#fafafa" : "#1a1a1a",
              color: mode === "dark" ? "#1a1a1a" : "#fafafa",
              borderColor: "transparent",
              fontWeight: 600,
            }}
          >
            {mode === "dark" ? "☀ 切换到日间" : "🌙 切换到夜间"}
          </button>
          <button
            type="button"
            onClick={() => apiRef.current?.reset()}
            style={demoButtonStyle}
          >
            Reset (imperative)
          </button>
          <button
            type="button"
            onClick={() => setBadge((b) => b + 1)}
            style={demoButtonStyle}
          >
            Bump badge
          </button>
          <button
            type="button"
            onClick={() => apiRef.current?.setView("front")}
            style={demoButtonStyle}
          >
            View → 正面
          </button>
          <button
            type="button"
            onClick={() => apiRef.current?.setView("perspective")}
            style={demoButtonStyle}
          >
            View → 透视
          </button>
        </div>

        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: "#1a1a1a",
            color: "#fafafa",
            borderRadius: 8,
            fontSize: 11,
            lineHeight: 1.5,
            overflow: "auto",
          }}
        >
          {JSON.stringify(config, null, 2)}
        </pre>
      </div>
    </div>
  );
}

const demoButtonStyle: React.CSSProperties = {
  height: 30,
  padding: "0 12px",
  border: "1px solid rgba(0,0,0,0.12)",
  background: "#fff",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};
