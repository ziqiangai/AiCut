import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useToast } from "./Toast.js";

export interface UploadResult {
  /** Public URL the editor stores in `sources[].url`. Either an
   *  uploaded http URL (server mode) or a `blob:` URL (local mode). */
  url: string;
  /** Original filename — used for the source's display name. */
  name: string;
  /** Probed duration in ms (best-effort via <video> metadata). */
  durationMs?: number;
  /** True when the URL is a local `blob:` URL — the backend can't
   *  open these, so the export-side knows to surface a hint. */
  isLocal: boolean;
}

interface Props {
  uploadEndpoint: string | null;
  onUploaded: (r: UploadResult) => void;
}

/**
 * Sidebar upload widget. Click to browse OR drag-drop a video file.
 *
 *   - `uploadEndpoint` set → POST multipart to it; expect JSON
 *     `{ url }` back. Stored URL is the server URL (backend-openable).
 *   - `uploadEndpoint` null → fall back to `URL.createObjectURL` for
 *     a local `blob:` URL (browser-playable, not backend-openable).
 *
 * Tries to probe the video's duration via a transient `<video>` so the
 * editor seeds an accurate clip length on first drop.
 */
export function UploadPanel({ uploadEndpoint, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const toast = useToast();

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/") && !file.name.match(/\.(mp4|mov|m4v|webm|mkv|avi)$/i)) {
        toast.push(`不支持的文件类型：${file.type || file.name}`, {
          variant: "error",
        });
        return;
      }
      setBusy(true);
      try {
        let url: string;
        let isLocal: boolean;
        if (uploadEndpoint) {
          const form = new FormData();
          form.append("file", file, file.name);
          const res = await fetch(uploadEndpoint, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            throw new Error(`上传失败 HTTP ${res.status}`);
          }
          const data = (await res.json()) as { url?: string };
          if (!data.url) {
            throw new Error("上传响应缺少 url 字段");
          }
          url = data.url;
          isLocal = false;
        } else {
          url = URL.createObjectURL(file);
          isLocal = true;
          toast.push(
            "未配置 VITE_UPLOAD_ENDPOINT — 使用本地 blob URL，仅浏览器内可用，无法导出。",
            { variant: "warn", duration: 5000 },
          );
        }
        const durationMs = await probeDuration(url).catch(() => undefined);
        onUploaded({ url, name: file.name, durationMs, isLocal });
        if (!isLocal) {
          toast.push(`已上传：${file.name}`, { variant: "success" });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.push(`上传出错：${msg}`, { variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [uploadEndpoint, onUploaded, toast],
  );

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="demo-upload-zone"
        style={{
          ...zoneStyle,
          borderColor: dragOver
            ? "var(--color-brand, #ff3386)"
            : "rgba(255, 255, 255, 0.18)",
          background: dragOver
            ? "rgba(255, 51, 134, 0.06)"
            : "transparent",
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {busy ? "上传中…" : "点击或拖拽视频文件"}
        </div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.6,
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {uploadEndpoint
            ? `已配置上传地址 → 视频会 POST 到后端`
            : `未配置 VITE_UPLOAD_ENDPOINT → 仅本地 blob 预览`}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          // Reset so picking the same file twice still fires.
          e.target.value = "";
        }}
      />
    </div>
  );
}

const zoneStyle: CSSProperties = {
  border: "1.5px dashed rgba(255, 255, 255, 0.18)",
  borderRadius: 10,
  padding: 14,
  textAlign: "center" as const,
  transition: "background-color 120ms ease, border-color 120ms ease",
  userSelect: "none" as const,
};

/** Probe a video URL's duration via a hidden <video>. */
function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    v.onloadedmetadata = () => {
      const ms = Math.round(v.duration * 1000);
      v.src = "";
      resolve(Number.isFinite(ms) && ms > 0 ? ms : 0);
    };
    v.onerror = () => reject(new Error("metadata probe failed"));
    // Some browsers need a brief tick before metadata fires; bail
    // after 5s rather than hanging forever.
    setTimeout(() => reject(new Error("metadata probe timeout")), 5000);
  });
}
