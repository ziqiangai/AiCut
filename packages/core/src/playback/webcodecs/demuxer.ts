import {
  DataStream,
  Endianness,
  MP4BoxBuffer,
  createFile,
  type ISOFile,
  type Sample,
} from "mp4box";
import type { Ms } from "../../types.js";

export interface DemuxedTrack {
  trackId: number;
  /** WebCodecs codec string, e.g. "avc1.42E01E" / "hvc1.1.6.L93.B0". */
  codec: string;
  /** Raw bytes of the codec config box (avcC / hvcC / vpcC / av1C)
   *  — feed straight to `decoder.configure({ description })`. */
  description: Uint8Array;
  width: number;
  height: number;
  /** Track timescale (ticks per second in cts/dts). */
  timescale: number;
  /** Track duration in ms. */
  durationMs: Ms;
}

export interface Mp4DemuxerOptions {
  url: string;
  /** Fires once after the moov is parsed — track info ready. */
  onReady: (track: DemuxedTrack) => void;
  /** Fires repeatedly as encoded samples arrive. Sorted by cts. */
  onSample: (sample: Sample) => void;
  /** Fires once all samples have been emitted. */
  onComplete?: () => void;
  /** Fires on fetch / parse / extraction errors. */
  onError?: (err: Error) => void;
}

/**
 * Thin wrapper around mp4box.js that streams an MP4 from a URL,
 * surfaces the video track config + codec description (avcC etc.),
 * and emits encoded samples ready to be wrapped in EncodedVideoChunks.
 *
 * Single video track only — the first video track in the file wins.
 * Audio / subtitles / metadata are ignored. This is the PoC; multi-
 * track + audio land alongside the multi-clip work in a follow-up.
 */
export class Mp4Demuxer {
  private file: ISOFile;
  private destroyed = false;
  private trackInfo: DemuxedTrack | null = null;
  private opts: Mp4DemuxerOptions;

  constructor(opts: Mp4DemuxerOptions) {
    this.opts = opts;
    this.file = createFile();
    this.file.onError = (msg: string) => {
      opts.onError?.(new Error(`mp4box: ${msg}`));
    };
    this.file.onReady = (info) => {
      const t = info.videoTracks[0];
      if (!t || !t.video) {
        opts.onError?.(new Error("Mp4Demuxer: no video track in file"));
        return;
      }
      try {
        const description = extractDescription(this.file, t.id);
        this.trackInfo = {
          trackId: t.id,
          codec: t.codec,
          description,
          width: t.video.width,
          height: t.video.height,
          timescale: t.timescale,
          // Use the track's own timescale, not the movie's — Sample.cts /
          // .dts / .duration are all in track-timescale ticks.
          durationMs: Math.round((t.samples_duration / t.timescale) * 1000),
        };
        this.file.setExtractionOptions(t.id);
        opts.onReady(this.trackInfo);
        // Trigger immediate emission of any already-buffered samples.
        this.file.start();
      } catch (err) {
        opts.onError?.(err as Error);
      }
    };
    this.file.onSamples = (_id, _user, samples) => {
      for (const s of samples) opts.onSample(s);
    };
    void this.load();
  }

  destroy(): void {
    this.destroyed = true;
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(this.opts.url);
      if (!res.ok || !res.body) {
        throw new Error(`Mp4Demuxer: HTTP ${res.status} fetching ${this.opts.url}`);
      }
      const reader = res.body.getReader();
      let offset = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.destroyed) return;
        const { done, value } = await reader.read();
        if (done) break;
        // mp4box wants each ArrayBuffer tagged with its offset in the
        // overall stream so it can stitch boxes together correctly. v2's
        // MP4BoxBuffer.fromArrayBuffer wraps this for us.
        const ab = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        );
        const buf = MP4BoxBuffer.fromArrayBuffer(ab, offset);
        offset += buf.byteLength;
        this.file.appendBuffer(buf);
      }
      this.file.flush();
      this.opts.onComplete?.();
    } catch (err) {
      if (!this.destroyed) this.opts.onError?.(err as Error);
    }
  }
}

/**
 * Pull the codec config box (avcC / hvcC / vpcC / av1C) out of the
 * track's SampleEntry and serialise it to bytes. This is exactly the
 * blob WebCodecs `VideoDecoder.configure({ description })` expects.
 *
 * The 8 leading bytes of a serialised box are the box header
 * (size + 4-char type) — we strip them, the decoder wants only the
 * box body.
 */
function extractDescription(file: ISOFile, trackId: number): Uint8Array {
  const trak = file.getTrackById(trackId);
  // `as any` because mp4box's SampleEntry union doesn't statically
  // expose avcC/hvcC/etc — they're attached dynamically by codec-
  // specific parsers (avc1Box etc.). Runtime check below catches the
  // common cases.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = trak.mdia.minf.stbl.stsd.entries as Array<any>;
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      // DataStream.buffer is the underlying ArrayBuffer the box wrote
      // into. Slice off the 8-byte box header to get just the config.
      return new Uint8Array((stream.buffer as ArrayBuffer).slice(8));
    }
  }
  throw new Error(
    "Mp4Demuxer: no codec config box (avcC/hvcC/vpcC/av1C) found — unsupported codec",
  );
}
