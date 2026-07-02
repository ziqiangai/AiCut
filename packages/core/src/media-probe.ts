/**
 * Load a media URL just far enough to read its duration + intrinsic
 * dimensions. Used by `Editor.addClip({ sourceUrl })` when the caller
 * hasn't already added the source (so we don't know how long the clip
 * is). Browser-only — the module falls through to a Promise rejection
 * in non-DOM environments.
 *
 * Kept out of `editor.ts` so headless unit tests (which pass
 * `sourceId` to skip the probe) don't need to stub `<video>`.
 */

export interface ProbedMedia {
  durationMs: number;
  width: number;
  height: number;
}

/** Time we'll wait for `loadedmetadata` before giving up. Matches
 *  common CDN timeouts — long enough for a first-byte fetch on cold
 *  cache, short enough that AI tool-loops don't wedge. */
const PROBE_TIMEOUT_MS = 10_000;

export async function probeMediaSource(url: string): Promise<ProbedMedia> {
  if (typeof document === "undefined") {
    throw new Error(
      "probeMediaSource requires a DOM (browser). In tests, pass sourceId + explicit duration to Editor.addClip instead.",
    );
  }
  return new Promise<ProbedMedia>((resolve, reject) => {
    const v = document.createElement("video");
    // Only need the metadata, not the whole file.
    v.preload = "metadata";
    v.muted = true;
    // Guard against CORS blocking pixel access down the line (e.g.
    // captureFrame). If the server doesn't allow CORS this listener
    // will still fire loadedmetadata; only pixel reads would fail.
    v.crossOrigin = "anonymous";
    let done = false;
    const cleanup = (): void => {
      done = true;
      v.removeAttribute("src");
      try {
        v.load();
      } catch {
        // load() can throw when there's no src — safe to ignore.
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(
        new Error(
          `probeMediaSource timed out after ${PROBE_TIMEOUT_MS}ms for ${url}`,
        ),
      );
    }, PROBE_TIMEOUT_MS);
    v.addEventListener(
      "loadedmetadata",
      () => {
        if (done) return;
        clearTimeout(timer);
        const durationMs = Number.isFinite(v.duration)
          ? Math.round(v.duration * 1000)
          : 0;
        const width = v.videoWidth;
        const height = v.videoHeight;
        cleanup();
        if (durationMs <= 0) {
          reject(new Error(`probeMediaSource: ${url} reported zero duration`));
          return;
        }
        resolve({ durationMs, width, height });
      },
      { once: true },
    );
    v.addEventListener(
      "error",
      () => {
        if (done) return;
        clearTimeout(timer);
        const detail = v.error?.message ?? "unknown";
        cleanup();
        reject(new Error(`probeMediaSource failed to load ${url}: ${detail}`));
      },
      { once: true },
    );
    v.src = url;
  });
}
