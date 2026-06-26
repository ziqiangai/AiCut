import type { Ms } from "../types.js";

const THUMB_HEIGHT = 44;
const THUMB_WIDTH = Math.round(THUMB_HEIGHT * (16 / 9));
/**
 * Round all sample times to this bucket so multiple zoom levels share
 * cache hits. 250ms means at the highest zoom (400 px/s) we still get
 * a fresh thumbnail roughly every 100px — plenty of visual continuity.
 */
const BUCKET_MS = 250;

interface SourceState {
  video: HTMLVideoElement;
  /** Bucketed ms → bitmap, once extracted. */
  cache: Map<number, ImageBitmap>;
  /** Times currently being extracted. */
  inflight: Set<number>;
  /** Resolved when the video is past readyState=1 (have metadata). */
  ready: Promise<void>;
  /** Pending samples to extract, FIFO. */
  queue: number[];
  /** True while a seek/draw cycle is in progress. */
  busy: boolean;
}

/**
 * Extracts frame thumbnails from a hidden `<video>` per source and
 * paints them onto a per-clip strip canvas. Decoupled from the main
 * `PlaybackEngine` videos so seeking-for-thumbnails doesn't disturb
 * playback.
 *
 * Strategy: lazy, only extract what the timeline asks for via
 * `paintStrip`. Missing thumbnails get queued; when extraction
 * completes, we call `onUpdate` so the host can request another
 * paint with the now-available bitmap.
 */
export class ThumbnailRibbon {
  private host: HTMLElement;
  private sources = new Map<string, SourceState>();
  private onUpdate: () => void;

  static get THUMB_HEIGHT(): number {
    return THUMB_HEIGHT;
  }
  static get THUMB_WIDTH(): number {
    return THUMB_WIDTH;
  }

  constructor(host: HTMLElement, onUpdate: () => void) {
    this.host = host;
    this.onUpdate = onUpdate;
  }

  syncSources(sources: Array<{ id: string; url: string; kind: string }>): void {
    const wanted = new Set(sources.map((s) => s.id));
    for (const [id, st] of this.sources) {
      if (!wanted.has(id)) {
        st.video.remove();
        for (const bmp of st.cache.values()) bmp.close();
        this.sources.delete(id);
      }
    }
    for (const src of sources) {
      if (src.kind !== "video") continue;
      if (this.sources.has(src.id)) continue;
      const v = document.createElement("video");
      v.src = src.url;
      v.preload = "auto";
      v.muted = true;
      v.playsInline = true;
      // Off-screen but in the layout so the browser actually decodes it.
      v.style.position = "absolute";
      v.style.left = "-9999px";
      v.style.top = "-9999px";
      v.style.width = "160px";
      v.style.height = "90px";
      this.host.appendChild(v);
      const ready = new Promise<void>((resolve) => {
        if (v.readyState >= 1) resolve();
        else v.addEventListener("loadedmetadata", () => resolve(), { once: true });
      });
      this.sources.set(src.id, {
        video: v,
        cache: new Map(),
        inflight: new Set(),
        ready,
        queue: [],
        busy: false,
      });
    }
  }

  /**
   * Paint thumbnails for the clip's visible window onto `ctx`. The
   * canvas is the per-clip strip — width = clip's px width, height =
   * `pxHeight` (defaults to the cached `THUMB_HEIGHT`). Source-time
   * range derives from the clip's `in/out` and the px range we're
   * drawing into.
   *
   * `pxHeight` lets the caller stretch thumbs to fill a taller clip
   * body when `trackHeight` is configured above the default. Aspect
   * ratio is already broken per-thumb (we slice variable widths from a
   * fixed-aspect cached bitmap), so stretching height too is fine — it
   * preserves the "filmstrip" look without leaving an empty bottom
   * band of the brand gradient showing through.
   */
  paintStrip(
    ctx: CanvasRenderingContext2D,
    sourceId: string,
    sourceInMs: Ms,
    sourceOutMs: Ms,
    pxWidth: number,
    pxHeight: number = THUMB_HEIGHT,
  ): void {
    ctx.clearRect(0, 0, pxWidth, pxHeight);
    const st = this.sources.get(sourceId);
    if (!st) return;
    if (sourceOutMs <= sourceInMs || pxWidth <= 0) return;

    const count = Math.max(1, Math.ceil(pxWidth / THUMB_WIDTH));
    const spanMs = sourceOutMs - sourceInMs;
    for (let i = 0; i < count; i++) {
      const tMs = sourceInMs + (spanMs * i) / count;
      const bucket = Math.round(tMs / BUCKET_MS) * BUCKET_MS;
      const bmp = st.cache.get(bucket);
      const x = Math.round((i * pxWidth) / count);
      const w =
        Math.round(((i + 1) * pxWidth) / count) - x;
      if (bmp) {
        ctx.drawImage(bmp, x, 0, w, pxHeight);
      } else {
        // Placeholder shimmer block — same color as track surface.
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(x, 0, w, pxHeight);
        this.enqueue(st, bucket);
      }
    }
  }

  destroy(): void {
    for (const st of this.sources.values()) {
      st.video.remove();
      for (const bmp of st.cache.values()) bmp.close();
    }
    this.sources.clear();
  }

  // ---- internals ------------------------------------------------------

  private enqueue(st: SourceState, bucketMs: number): void {
    if (st.cache.has(bucketMs) || st.inflight.has(bucketMs)) return;
    st.inflight.add(bucketMs);
    st.queue.push(bucketMs);
    void this.drain(st);
  }

  private async drain(st: SourceState): Promise<void> {
    if (st.busy) return;
    st.busy = true;
    try {
      await st.ready;
      while (st.queue.length > 0) {
        const t = st.queue.shift()!;
        try {
          const bmp = await this.extractFrame(st.video, t);
          st.cache.set(t, bmp);
        } catch {
          // ignore — failed extractions just leave the placeholder
        } finally {
          st.inflight.delete(t);
        }
        this.onUpdate();
      }
    } finally {
      st.busy = false;
    }
  }

  private extractFrame(
    video: HTMLVideoElement,
    timeMs: Ms,
  ): Promise<ImageBitmap> {
    const targetSec = Math.max(
      0,
      Math.min((video.duration || Infinity) - 0.05, timeMs / 1000),
    );
    return new Promise((resolve, reject) => {
      const onSeeked = () => {
        try {
          const cnv = document.createElement("canvas");
          cnv.width = THUMB_WIDTH;
          cnv.height = THUMB_HEIGHT;
          const cx = cnv.getContext("2d");
          if (!cx) return reject(new Error("no 2d ctx"));
          // Cover-crop the source into the fixed 16:9 thumb box so a
          // portrait / square video doesn't get squished into a strip.
          // Mirrors CapCut / Premiere timeline thumbnails (centered
          // crop of the active frame). Source-rect math, dest fills.
          const vw = video.videoWidth || THUMB_WIDTH;
          const vh = video.videoHeight || THUMB_HEIGHT;
          const targetAr = THUMB_WIDTH / THUMB_HEIGHT;
          const srcAr = vw / vh;
          let sx = 0;
          let sy = 0;
          let sw = vw;
          let sh = vh;
          if (srcAr > targetAr) {
            // Source wider than thumb — crop the sides.
            sw = vh * targetAr;
            sx = (vw - sw) / 2;
          } else if (srcAr < targetAr) {
            // Source taller than thumb — crop top + bottom.
            sh = vw / targetAr;
            sy = (vh - sh) / 2;
          }
          cx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
          // createImageBitmap is async but cheap and gives a portable
          // GPU-friendly handle the strip canvas can blit fast.
          createImageBitmap(cnv).then(resolve, reject);
        } catch (e) {
          reject(e as Error);
        }
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = targetSec;
      } catch (e) {
        video.removeEventListener("seeked", onSeeked);
        reject(e as Error);
      }
    });
  }
}
