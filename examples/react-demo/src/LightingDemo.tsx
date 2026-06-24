import { useMemo, useRef, useState } from "react";
import {
  LightingEditor,
  lightingLocaleZh,
  type LightingConfig,
  type LightingEditorApi,
  type LightingView,
} from "@aicut/react/lighting";
import { localeZh, type Theme } from "@aicut/react";

const THEMES: Record<"dark" | "light", Theme> = {
  dark: {
    controlsBg: "#1f1f22",
    controlsBorder: "rgba(255, 255, 255, 0.08)",
    controlsText: "rgba(255, 255, 255, 0.85)",
    controlsHover: "rgba(255, 255, 255, 0.08)",
    controlsActive: "rgba(255, 255, 255, 0.12)",
  },
  light: {
    controlsBg: "#f6f6f8",
    controlsBorder: "rgba(0, 0, 0, 0.08)",
    controlsText: "rgba(0, 0, 0, 0.78)",
    controlsHover: "rgba(0, 0, 0, 0.06)",
    controlsActive: "rgba(0, 0, 0, 0.08)",
  },
};

interface Preset {
  id: string;
  name: string;
  config: Partial<LightingConfig>;
}

const PRESETS: Preset[] = [
  { id: "rembrandt", name: "Rembrandt", config: { keyDirection: { x: -0.7, y: 0.7, z: 0.3 }, brightness: 0.5, color: "#fff2d6" } },
  { id: "blue-back", name: "Blue back-light", config: { keyDirection: { x: 0.2, y: 0.1, z: -1 }, brightness: 0.8, color: "#5b8cff", rim: true } },
  { id: "overexposed", name: "Overexposed film", config: { keyDirection: { x: 0, y: 0, z: 1 }, brightness: 1, color: "#ffffff" } },
  { id: "cyberpunk", name: "Cyberpunk", config: { keyDirection: { x: -0.5, y: -0.3, z: 0.8 }, brightness: 0.75, color: "#ff44ff", rim: true } },
  { id: "sunset", name: "Sunset", config: { keyDirection: { x: 0.9, y: 0.2, z: 0.3 }, brightness: 0.65, color: "#ffaa3a" } },
  { id: "noir", name: "Noir", config: { keyDirection: { x: -0.9, y: 0.3, z: 0.2 }, brightness: 0.25, color: "#dddddd", rim: true } },
  { id: "golden-hour", name: "Golden hour", config: { keyDirection: { x: -0.8, y: 0.4, z: 0.4 }, brightness: 0.6, color: "#ffcf6e" } },
  { id: "cool-grey", name: "Cool grey", config: { keyDirection: { x: 0, y: 0.5, z: 0.8 }, brightness: 0.5, color: "#c8d2dc" } },
];

const SUBJECT_URL = "/lighting-samples/subject.jpg";

export function LightingDemo() {
  const apiRef = useRef<LightingEditorApi | null>(null);
  const [config, setConfig] = useState<LightingConfig | null>(null);
  const [view, setView] = useState<LightingView>("perspective");
  const [prompt, setPrompt] = useState("");
  const [subject, setSubject] = useState<string>(SUBJECT_URL);
  const [language, setLanguage] = useState<"en" | "zh">("en");
  const [themeName, setThemeName] = useState<"dark" | "light">("dark");
  // Smart panel state is OWNED by the host now — the library is just
  // a picker. We render the panel beside <LightingEditor> in our own
  // layout and hide/show it locally.
  const [smartOpen, setSmartOpen] = useState(true);
  const [lastGenerated, setLastGenerated] = useState<LightingConfig | null>(
    null,
  );

  const locale = useMemo(
    () =>
      language === "zh"
        ? { ...localeZh, ...lightingLocaleZh }
        : undefined,
    [language],
  );
  const theme = useMemo(() => THEMES[themeName], [themeName]);

  const applyPreset = (p: Preset): void => {
    apiRef.current?.setConfig(p.config);
  };

  const onUploadSubject = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      setSubject(url);
      apiRef.current?.setSubjectImage(url);
    };
    r.readAsDataURL(f);
  };

  // "Generate" is just a host function — snapshot the config and do
  // whatever (here we mirror it into the sidebar JSON dump).
  const handleGenerate = (): void => {
    const cfg = apiRef.current?.getConfig();
    if (cfg) setLastGenerated(cfg);
  };

  return (
    <div className="lighting-shell">
      <div className="lighting-editor-area">
        {/* Host wraps editor + smart panel in their own flex/grid.
            Library has zero opinion on the smart panel's existence. */}
        <div className="ldemo-stage">
          <LightingEditor
            apiRef={apiRef}
            subjectImageUrl={subject}
            defaultView={view}
            locale={locale}
            theme={theme}
            onChange={(cfg) => setConfig(cfg)}
            controlsFooter={
              <button
                type="button"
                className="ldemo-controls-footer-btn"
                data-testid="ldemo-reset"
                onClick={() => apiRef.current?.reset()}
              >
                Reset
              </button>
            }
          />
          {smartOpen ? (
            <aside className="ldemo-smart-panel" data-testid="ldemo-smart-panel">
              <header className="ldemo-smart-header">
                <h3 className="ldemo-smart-title">Smart mode</h3>
                <button
                  type="button"
                  className="ldemo-smart-close"
                  aria-label="Close smart mode"
                  data-testid="ldemo-smart-close"
                  onClick={() => setSmartOpen(false)}
                >
                  ×
                </button>
              </header>
              <textarea
                className="ldemo-smart-textarea"
                placeholder="Describe the lighting / mood you want…"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <label className="ldemo-smart-upload">
                <input
                  type="file"
                  accept="image/*"
                  onChange={onUploadSubject}
                  style={{ display: "none" }}
                />
                <span>↑ Upload subject</span>
              </label>
              <div className="ldemo-smart-preset-title">Presets</div>
              <div className="ldemo-smart-preset-grid">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="ldemo-smart-preset"
                    onClick={() => applyPreset(p)}
                    title={p.name}
                    data-testid={`ldemo-preset-${p.id}`}
                  >
                    <span
                      className="ldemo-smart-preset-swatch"
                      style={{ background: String(p.config.color ?? "#888") }}
                    />
                    <span className="ldemo-smart-preset-name">{p.name}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="ldemo-generate"
                onClick={handleGenerate}
                data-testid="ldemo-generate"
              >
                Generate
              </button>
            </aside>
          ) : null}
        </div>
      </div>
      <aside className="lighting-sidebar">
        <h2>Theme</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="ldemo-theme-toggle"
            onClick={() =>
              setThemeName(themeName === "dark" ? "light" : "dark")
            }
          >
            {themeName === "dark" ? "Switch to Light" : "Switch to Dark"}
          </button>
        </div>

        <h2>Language</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="ldemo-locale-toggle"
            onClick={() => setLanguage(language === "en" ? "zh" : "en")}
          >
            {language === "en" ? "Switch to 中文" : "Switch to English"}
          </button>
        </div>

        <h2>Smart panel (host-controlled)</h2>
        <div className="demo-row">
          <button
            type="button"
            data-testid="ldemo-smart-toggle"
            onClick={() => setSmartOpen((s) => !s)}
          >
            {smartOpen ? "Hide smart panel" : "Show smart panel"}
          </button>
        </div>

        <h2>View</h2>
        <div className="demo-row">
          <button
            type="button"
            onClick={() => {
              const next: LightingView =
                view === "perspective" ? "front" : "perspective";
              setView(next);
              apiRef.current?.setView(next);
            }}
          >
            Toggle ({view})
          </button>
        </div>

        <h2>Live config</h2>
        <pre className="lighting-state" data-testid="ldemo-config-json">
{config ? JSON.stringify(config, null, 2) : "(drag the dot or pick a preset)"}
        </pre>

        <h2>Last generate payload</h2>
        <pre className="lighting-state" data-testid="ldemo-generated-json">
{lastGenerated
  ? JSON.stringify(lastGenerated, null, 2)
  : "(click Generate)"}
        </pre>

        <h2>Prompt (host state)</h2>
        <pre className="lighting-state">{prompt || "(empty)"}</pre>
      </aside>
    </div>
  );
}
