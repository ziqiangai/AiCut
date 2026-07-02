/**
 * Frame capture helpers used by `Editor.captureFrame`. Split out so
 * the editor stays engine-agnostic and jsdom tests don't have to stub
 * the DOM plumbing.
 *
 * Two shapes:
 *   captureRawFrame — spawn a hidden `<video>`, seek to source-local
 *                     ms, draw one frame to canvas, encode to Blob.
 *   encodeCanvas    — read an already-composited canvas (from the
 *                     playback engine) into a Blob, optionally
 *                     downscaling to `maxWidth`.
 */

const RAW_SEEK_TIMEOUT_MS = 10_000;

interface FrameOut {
  blob: Blob;
  width: number;
  height: number;
}

export async function captureRawFrame(
  url: string,
  sourceMs: number,
  maxWidth: number | undefined,
  format: "image/jpeg" | "image/png",
  quality: number,
): Promise<FrameOut> {
  if (typeof document === "undefined") {
    throw new Error(
      "captureRawFrame requires a DOM (browser). Skip source: 'raw' in Node/tests.",
    );
  }
  const v = document.createElement("video");
  v.preload = "auto";
  v.muted = true;
  // playsInline lets iOS Safari decode inline instead of taking over
  // fullscreen — required for offscreen frame grabs.
  v.playsInline = true;
  v.crossOrigin = "anonymous";
  v.src = url;

  await waitForEvent(v, "loadedmetadata", RAW_SEEK_TIMEOUT_MS);
  // Clamp seek — seeking past duration silently no-ops in some browsers.
  const durMs = Number.isFinite(v.duration) ? v.duration * 1000 : 0;
  const targetMs = Math.max(0, Math.min(sourceMs, Math.max(0, durMs - 1)));
  v.currentTime = targetMs / 1000;
  await waitForEvent(v, "seeked", RAW_SEEK_TIMEOUT_MS);

  const srcW = v.videoWidth;
  const srcH = v.videoHeight;
  const scale = maxWidth != null && srcW > maxWidth ? maxWidth / srcW : 1;
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("captureRawFrame: 2d context unavailable");
  ctx.drawImage(v, 0, 0, w, h);

  // Release the video ASAP so we don't leak a decoder for a one-shot
  // frame grab. Node/GC would eventually collect it but toBlob is
  // async and the video can sit resident until it does.
  v.removeAttribute("src");
  try {
    v.load();
  } catch {
    // load() without src throws in some browsers — safe to ignore.
  }

  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, format, quality),
  );
  if (!blob) throw new Error("captureRawFrame: canvas.toBlob returned null");
  return { blob, width: w, height: h };
}

export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  maxWidth: number | undefined,
  format: "image/jpeg" | "image/png",
  quality: number,
): Promise<FrameOut> {
  const srcW = canvas.width;
  const srcH = canvas.height;
  if (srcW === 0 || srcH === 0) {
    throw new Error("encodeCanvas: source canvas has zero dimensions");
  }
  const scale = maxWidth != null && srcW > maxWidth ? maxWidth / srcW : 1;
  if (scale === 1) {
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, format, quality),
    );
    if (!blob) throw new Error("encodeCanvas: toBlob returned null");
    return { blob, width: srcW, height: srcH };
  }
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d");
  if (!ctx) throw new Error("encodeCanvas: 2d context unavailable on tmp");
  ctx.drawImage(canvas, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) =>
    tmp.toBlob(r, format, quality),
  );
  if (!blob) throw new Error("encodeCanvas: toBlob returned null");
  return { blob, width: w, height: h };
}

function waitForEvent(
  target: EventTarget,
  type: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, handler);
      reject(new Error(`captureFrame: timed out waiting for ${type}`));
    }, timeoutMs);
    const handler = (): void => {
      clearTimeout(timer);
      target.removeEventListener(type, handler);
      resolve();
    };
    target.addEventListener(type, handler, { once: true });
  });
}
