import type { Sample } from "mp4box";
import type { Clip, Ms, Project } from "../../types.js";
import type {
  PlaybackEngine,
  PlaybackEngineFactory,
  PlaybackEngineOptions,
} from "../types.js";
import { Mp4Demuxer, type DemuxedTrack } from "./demuxer.js";
import { isWebCodecsSupported } from "./feature.js";

export interface WebCodecsEngineOptions extends PlaybackEngineOptions {
  /**
   * Show a corner HUD ("engine: webcodecs • t=… • decoded N • queue M").
   * Off by default — production hosts get a clean canvas.
   */
  debug?: boolean;
}

/** Window of decoded frames to keep ahead of the playhead. Past frames
 *  are closed immediately so GPU buffers don't leak. */
const FRAME_QUEUE_AHEAD = 30;
/** Frames older than this many ms behind the playhead are closed. */
const FRAME_RETAIN_BEHIND_MS = 100;

interface SourceState {
  sourceId: string;
  demuxer: Mp4Demuxer;
  decoder: VideoDecoder | null;
  track: DemuxedTrack | null;
  samples: Sample[];
  /** Index of the next sample to feed the decoder. */
  nextSampleIndex: number;
  /** sampleIndex → decoded VideoFrame. Filled by decoder.output, drained
   *  by paint(). Frames are .close()'d on eviction. */
  frames: Map<number, VideoFrame>;
  /** When seeking, render gates on cts >= gateCtsMicros so we don't
   *  flash post-keyframe frames before the actual seek target. */
  renderGateCtsMicros: number;
  ready: boolean;
}

/**
 * Frame-accurate single-track playback via WebCodecs `VideoDecoder`.
 * Mp4Demuxer feeds encoded samples; the decoder emits VideoFrames we
 * paint to a canvas on rAF. Seek snaps to the nearest keyframe at-or-
 * before the target and decodes forward (true frame-accurate, not the
 * browser's keyframe-snap).
 *
 * Scope of v1 (this PoC):
 *   - Single video clip per source (boundaries handled, but no
 *     transitions / compositing yet).
 *   - MP4 / MOV containers via mp4box.js (H.264 / HEVC / VP9 / AV1
 *     codecs, whatever the browser's VideoDecoder supports).
 *   - Audio not played.
 *
 * Follow-ups: multi-track compositing, audio, in/out trim cropping at
 * the decoder level, segment-prefetch across clip boundaries.
 */
export class WebCodecsEngine implements PlaybackEngine {
  private host: HTMLElement;
  private mount: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private badge: HTMLDivElement | null = null;
  private project: Project;
  private currentClipId: string | null = null;
  private sources = new Map<string, SourceState>();
  private playing = false;
  private timeMs: Ms = 0;
  private rafHandle: number | null = null;
  private lastFrameTs = 0;
  private decodedFramesTotal = 0;
  private destroyed = false;

  onTimeUpdate?: (ms: Ms) => void;
  onEnded?: () => void;
  onError?: (err: Error) => void;
  onReady?: () => void;
  onSourceMetadata?: (sourceId: string, durationMs: Ms) => void;

  constructor(opts: WebCodecsEngineOptions) {
    if (!isWebCodecsSupported()) {
      throw new Error(
        "WebCodecsEngine: this browser doesn't expose VideoDecoder / " +
          "VideoFrame / EncodedVideoChunk. Use HtmlVideoEngine instead, " +
          "or feature-detect with isWebCodecsSupported() and fall back.",
      );
    }
    this.host = opts.host;
    this.project = opts.project;

    this.mount = document.createElement("div");
    this.mount.className = "aicut-preview aicut-preview--webcodecs";
    Object.assign(this.mount.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    } satisfies Partial<CSSStyleDeclaration>);

    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "contain",
      background: "#000",
    } satisfies Partial<CSSStyleDeclaration>);
    this.mount.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("WebCodecsEngine: 2d context unavailable");
    this.ctx = ctx;

    if (opts.debug) {
      const badge = document.createElement("div");
      badge.className = "aicut-preview__badge";
      Object.assign(badge.style, {
        position: "absolute",
        top: "8px",
        left: "8px",
        padding: "4px 8px",
        borderRadius: "6px",
        background: "rgba(0, 0, 0, 0.55)",
        color: "rgba(255, 255, 255, 0.92)",
        font: "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        pointerEvents: "none",
        zIndex: "2",
        letterSpacing: "0.02em",
      } satisfies Partial<CSSStyleDeclaration>);
      badge.textContent = "engine: webcodecs • loading…";
      this.mount.appendChild(badge);
      this.badge = badge;
    }

    this.host.appendChild(this.mount);
    this.syncSources();
    this.resizeCanvas();
    this.startTickLoop();
  }

  setProject(next: Project): void {
    this.project = next;
    this.syncSources();
    const clip = this.clipAtTime(this.timeMs);
    if (!clip) {
      this.timeMs = 0;
      this.activate(null);
      this.onTimeUpdate?.(0);
    } else {
      this.activate(clip);
      this.seekActiveTo(this.timeMs - clip.start);
    }
  }

  play(): void {
    if (this.playing) return;
    if (this.totalDuration() <= 0) return;
    const clip =
      this.clipAtTime(this.timeMs) ?? this.nextClipAfterTime(this.timeMs);
    if (!clip) return;
    if (this.timeMs < clip.start) this.timeMs = clip.start;
    this.activate(clip);
    this.seekActiveTo(this.timeMs - clip.start);
    this.playing = true;
    this.lastFrameTs = performance.now();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getTime(): Ms {
    return this.timeMs;
  }

  seek(timeMs: Ms): void {
    const total = this.totalDuration();
    if (total <= 0) {
      this.timeMs = 0;
      return;
    }
    const clamped = Math.max(0, Math.min(timeMs, total));
    this.timeMs = clamped;
    const clip = this.clipAtTime(clamped);
    if (clip) {
      this.activate(clip);
      this.seekActiveTo(clamped - clip.start);
    } else {
      this.activate(null);
    }
    this.onTimeUpdate?.(clamped);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTickLoop();
    for (const src of this.sources.values()) this.teardownSource(src);
    this.sources.clear();
    this.mount.remove();
  }

  // --- internals -------------------------------------------------------

  private syncSources(): void {
    const wantedVideoIds = new Set(
      this.project.sources.filter((s) => s.kind === "video").map((s) => s.id),
    );
    for (const [id, src] of this.sources) {
      if (!wantedVideoIds.has(id)) {
        this.teardownSource(src);
        this.sources.delete(id);
      }
    }
    for (const ms of this.project.sources) {
      if (ms.kind !== "video") continue;
      if (this.sources.has(ms.id)) continue;
      const state: SourceState = {
        sourceId: ms.id,
        decoder: null,
        track: null,
        samples: [],
        nextSampleIndex: 0,
        frames: new Map(),
        renderGateCtsMicros: 0,
        ready: false,
        // demuxer assigned below — placeholder so TS doesn't yell
        demuxer: undefined as unknown as Mp4Demuxer,
      };
      state.demuxer = new Mp4Demuxer({
        url: ms.url,
        onError: (e) => this.onError?.(e),
        onReady: (track) => this.onTrackReady(state, track),
        onSample: (sample) => {
          // mp4box guarantees decode-order; we just append.
          state.samples.push(sample);
        },
      });
      this.sources.set(ms.id, state);
    }
  }

  private teardownSource(src: SourceState): void {
    src.demuxer.destroy();
    if (src.decoder && src.decoder.state !== "closed") {
      try {
        src.decoder.close();
      } catch {
        /* already closed */
      }
    }
    for (const f of src.frames.values()) f.close();
    src.frames.clear();
  }

  private onTrackReady(src: SourceState, track: DemuxedTrack): void {
    if (this.destroyed) return;
    src.track = track;
    const decoder = new VideoDecoder({
      output: (frame) => this.onDecodedFrame(src, frame),
      error: (e) => this.onError?.(e),
    });
    try {
      decoder.configure({
        codec: track.codec,
        codedWidth: track.width,
        codedHeight: track.height,
        description: track.description,
      });
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }
    src.decoder = decoder;
    src.ready = true;
    // Hand the host the source duration if the project didn't ship one.
    this.onSourceMetadata?.(src.sourceId, track.durationMs);
    this.onReady?.();
    // If the playhead is already inside a clip backed by this source,
    // kick off decode so playback can start as soon as the user hits play.
    const activeClip = this.clipAtTime(this.timeMs);
    if (activeClip && activeClip.sourceId === src.sourceId) {
      this.activate(activeClip);
      this.seekActiveTo(this.timeMs - activeClip.start);
    }
  }

  private onDecodedFrame(src: SourceState, frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    // Find the sample index whose dts matches this frame's timestamp.
    // WebCodecs returns frames in presentation order; we tagged each
    // EncodedVideoChunk with cts (in micros) as `timestamp`, so frame
    // .timestamp matches a sample cts. Search by cts.
    const targetCts = frame.timestamp;
    let matched = -1;
    for (let i = 0; i < src.samples.length; i += 1) {
      const s = src.samples[i];
      if (!s) continue;
      if (sampleCtsMicros(s) === targetCts) {
        matched = i;
        break;
      }
    }
    if (matched < 0) {
      // No matching sample (shouldn't happen with well-formed input);
      // drop the frame so we don't leak GPU memory.
      frame.close();
      return;
    }
    // If we already have a frame for this index (rare — happens on
    // overlapping decode sessions during seek), close the old one.
    const existing = src.frames.get(matched);
    if (existing) existing.close();
    src.frames.set(matched, frame);
    this.decodedFramesTotal += 1;
  }

  private activate(clip: Clip | null): void {
    if (clip?.id === this.currentClipId) return;
    // Switching clips: stop feeding the previous source's decoder,
    // close its frame queue. Don't tear down — the source may come
    // back, and re-warming the decoder per swap is wasteful.
    if (this.currentClipId) {
      const prev = this.clipById(this.currentClipId);
      if (prev) {
        const prevSrc = this.sources.get(prev.sourceId);
        if (prevSrc) this.flushFrames(prevSrc);
      }
    }
    this.currentClipId = clip?.id ?? null;
  }

  private seekActiveTo(offsetMs: Ms): void {
    const clip = this.currentClipId ? this.clipById(this.currentClipId) : null;
    if (!clip) return;
    const src = this.sources.get(clip.sourceId);
    if (!src || !src.ready || !src.decoder) return;
    // Target = clip.in + offset, in source-local time (ms → micros for
    // WebCodecs).
    const targetMs = clip.in + Math.max(0, offsetMs);
    const targetMicros = Math.round(targetMs * 1000);
    // Find keyframe at-or-before target.
    let keyIdx = 0;
    for (let i = 0; i < src.samples.length; i += 1) {
      const s = src.samples[i];
      if (!s) continue;
      if (sampleCtsMicros(s) > targetMicros) break;
      if (s.is_sync) keyIdx = i;
    }
    // Reset decoder state.
    try {
      src.decoder.reset();
      src.decoder.configure({
        codec: src.track!.codec,
        codedWidth: src.track!.width,
        codedHeight: src.track!.height,
        description: src.track!.description,
      });
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }
    this.flushFrames(src);
    src.nextSampleIndex = keyIdx;
    src.renderGateCtsMicros = targetMicros;
    // Pre-feed a few samples so we have something to render quickly.
    this.feedDecoder(src);
  }

  private flushFrames(src: SourceState): void {
    for (const f of src.frames.values()) f.close();
    src.frames.clear();
  }

  /**
   * Feed enough samples to keep the frame queue at FRAME_QUEUE_AHEAD.
   * Called every paint() cycle plus immediately after seek.
   */
  private feedDecoder(src: SourceState): void {
    if (!src.decoder || src.decoder.state !== "configured") return;
    while (
      src.frames.size + src.decoder.decodeQueueSize < FRAME_QUEUE_AHEAD &&
      src.nextSampleIndex < src.samples.length
    ) {
      const s = src.samples[src.nextSampleIndex];
      src.nextSampleIndex += 1;
      if (!s || !s.data) continue;
      try {
        src.decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: sampleCtsMicros(s),
            duration: Math.round((s.duration / s.timescale) * 1_000_000),
            data: s.data,
          }),
        );
      } catch (err) {
        this.onError?.(err as Error);
        return;
      }
    }
  }

  private clipById(id: string): Clip | null {
    for (const t of this.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c;
    }
    return null;
  }

  private clipAtTime(timeMs: Ms): Clip | null {
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (timeMs >= c.start && timeMs < c.start + (c.out - c.in)) return c;
      }
    }
    return null;
  }

  private nextClipAfterTime(timeMs: Ms): Clip | null {
    let best: Clip | null = null;
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (c.start >= timeMs && (!best || c.start < best.start)) best = c;
      }
    }
    return best;
  }

  private totalDuration(): Ms {
    let max = 0;
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        const e = c.start + (c.out - c.in);
        if (e > max) max = e;
      }
    }
    return max;
  }

  private resizeCanvas(): void {
    const rect = this.mount.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private startTickLoop(): void {
    this.lastFrameTs = performance.now();
    const tick = (now: number): void => {
      if (this.destroyed) return;
      this.resizeCanvas();
      if (this.playing) {
        const dtMs = now - this.lastFrameTs;
        this.lastFrameTs = now;
        this.advance(dtMs);
      }
      this.paint();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopTickLoop(): void {
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private advance(dtMs: number): void {
    if (this.project.tracks.length === 0) return;
    this.timeMs += dtMs;
    const totalDur = this.totalDuration();
    if (this.timeMs >= totalDur) {
      this.timeMs = totalDur;
      this.onTimeUpdate?.(this.timeMs);
      this.pause();
      this.onEnded?.();
      return;
    }
    const clip = this.clipAtTime(this.timeMs);
    if (!clip) {
      const next = this.nextClipAfterTime(this.timeMs);
      if (next) {
        this.timeMs = next.start;
        this.activate(next);
        this.seekActiveTo(0);
      } else {
        this.pause();
        this.onEnded?.();
        return;
      }
    } else if (clip.id !== this.currentClipId) {
      this.activate(clip);
      this.seekActiveTo(this.timeMs - clip.start);
    }
    this.onTimeUpdate?.(this.timeMs);
  }

  /**
   * Render the frame matching the current playhead, top up the decoder
   * queue, evict stale frames. Always runs (not just on play) so seek
   * previews the target frame and the HUD stays current when paused.
   */
  private paint(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.clearRect(0, 0, cw, ch);

    const clip = this.currentClipId ? this.clipById(this.currentClipId) : null;
    const src = clip ? this.sources.get(clip.sourceId) : null;

    if (src && clip && src.ready) {
      const localMs = this.timeMs - clip.start;
      const targetCtsMicros = Math.round((clip.in + localMs) * 1000);

      // Find the latest decoded frame whose cts is <= target.
      let chosenIdx = -1;
      let chosenFrame: VideoFrame | null = null;
      for (const [idx, frame] of src.frames) {
        if (frame.timestamp >= src.renderGateCtsMicros) {
          if (
            frame.timestamp <= targetCtsMicros &&
            (chosenFrame == null || frame.timestamp > chosenFrame.timestamp)
          ) {
            chosenFrame = frame;
            chosenIdx = idx;
          }
        }
      }
      // Evict frames clearly behind the playhead (with a small retention
      // window so seek-backwards micro-jitter doesn't thrash decode).
      const evictBeforeMicros =
        targetCtsMicros - FRAME_RETAIN_BEHIND_MS * 1000;
      for (const [idx, frame] of src.frames) {
        if (frame.timestamp < evictBeforeMicros && idx !== chosenIdx) {
          frame.close();
          src.frames.delete(idx);
        }
      }
      if (chosenFrame) {
        const vw = chosenFrame.displayWidth || chosenFrame.codedWidth;
        const vh = chosenFrame.displayHeight || chosenFrame.codedHeight;
        const scale = Math.min(cw / vw, ch / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (cw - dw) / 2;
        const dy = (ch - dh) / 2;
        this.ctx.drawImage(chosenFrame, dx, dy, dw, dh);
      }
      // Keep the decoder fed for upcoming frames.
      this.feedDecoder(src);
    }

    this.updateBadge();
  }

  private updateBadge(): void {
    if (!this.badge) return;
    const sec = (this.timeMs / 1000).toFixed(2);
    const clip = this.currentClipId ? this.clipById(this.currentClipId) : null;
    const src = clip ? this.sources.get(clip.sourceId) : null;
    const q = src?.frames.size ?? 0;
    const ready = src?.ready ? "ready" : "loading…";
    this.badge.textContent =
      `engine: webcodecs • t=${sec}s • decoded: ${this.decodedFramesTotal} • queue: ${q} • ${ready}`;
  }
}

/** Sample cts in microseconds (WebCodecs timestamp unit). */
function sampleCtsMicros(s: Sample): number {
  return Math.round((s.cts / s.timescale) * 1_000_000);
}

/** Factory shorthand — defaults debug off. */
export const webCodecsEngineFactory: PlaybackEngineFactory = (opts) =>
  new WebCodecsEngine(opts);
