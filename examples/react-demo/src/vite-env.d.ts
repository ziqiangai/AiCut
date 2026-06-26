/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_TS_URL?: string;
  readonly VITE_BACKEND_GO_URL?: string;
  readonly VITE_UPLOAD_ENDPOINT?: string;
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
