/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_TS_URL?: string;
  readonly VITE_BACKEND_GO_URL?: string;
  readonly VITE_UPLOAD_ENDPOINT?: string;
  readonly VITE_BASE_PATH?: string;
  /**
   * Hide the Lighting v2 / v3 routes and their nav tabs. Set to "1"
   * (or any truthy value) in CI / public builds where the lighting
   * showcase isn't appropriate to expose. Defaults to off in local
   * dev so the routes remain discoverable.
   */
  readonly VITE_HIDE_LIGHTING?: string;
  /**
   * Pre-seed the demo with a video clip on first mount. Convenient
   * for local dev so reload doesn't require re-uploading every time.
   * Accepts any same-origin path (e.g. `/sample.mp4` served from
   * `examples/react-demo/public/`) or absolute URL. Unset → demo
   * starts empty and the user uploads manually.
   */
  readonly VITE_PRELOAD_VIDEO_URL?: string;
  /** Optional display name for the pre-seeded source. Defaults to the
   *  URL's filename. */
  readonly VITE_PRELOAD_VIDEO_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
