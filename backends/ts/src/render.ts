import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Clip, MediaSource, Project, Track } from "@aicut/core";
import {
  probeHasAudio,
  probeVideoDimensions,
  resolveFfmpeg,
  resolveFfprobe,
  runFfmpeg,
} from "./ffmpeg.js";
import { compileKeyframeExpression } from "./keyframe-expression.js";

/**
 * Turn a frontend source URL into something ffmpeg can open.
 *
 * Accepted as-is:
 *   - Absolute filesystem paths (`/Users/me/a.mov`, `C:\videos\a.mp4`)
 *   - HTTP(S) URLs (`http://localhost:5173/a.mov`)
 *   - file:// URLs
 *
 * Rewritten:
 *   - Bare paths like `/a.mov` (Vite-public style) when the
 *     `AICUT_ASSETS_DIR` env var is set. The leading `/` is treated
 *     as the asset-root, NOT the filesystem root, so projects authored
 *     against a public/ dir stay portable. Without the env var we
 *     pass through unchanged and let ffmpeg report "no such file".
 */
function resolveSourceUrl(url: string): string {
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(url)) return url;
  const assetsDir = process.env.AICUT_ASSETS_DIR;
  if (assetsDir && url.startsWith("/")) {
    return path.join(assetsDir, url);
  }
  return url;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  fps?: number;
  signal?: AbortSignal;
  /**
   * Final output path. Render writes its mp4 directly here so the
   * server doesn't have to copy across mount points. Parent dir is
   * created by the caller; we still place intermediates in a temp dir
   * that gets cleaned up regardless.
   */
  outputPath: string;
  /** Granular progress notifications during the encode pass. */
  onProgress?: (e: ProgressEvent) => void;
}

export interface ProgressEvent {
  /** Single phase now: `encode` while ffmpeg is running, `concat`
   *  pinned at 0.99/1 for backwards compat with the UI's two-phase
   *  progress pill. */
  phase: "encode" | "concat";
  /** 0–1 overall, derived from ffmpeg's out_time_us. */
  overall: number;
  clipIndex?: number;
  totalClips?: number;
}

/**
 * Render a Project to a single mp4 at `opts.outputPath`.
 *
 * Strategy: ONE ffmpeg call with a hand-built filter_complex that
 * mirrors the editor's compositor — black canvas of the output size,
 * each clip trimmed and shifted to its timeline `start`, transformed
 * (scale / pan / keyframes), then overlaid bottom-track-first so the
 * last track in `project.tracks` reads as the top layer (matches the
 * frontend's PiP z-order).
 *
 * Audio: only the topmost video track's clips contribute audio (the
 * editor's PiP policy — lower tracks mute). Multiple clips on the
 * top track are trim+delayed and `amix`ed.
 */
export async function renderProject(
  project: Project,
  opts: RenderOptions,
): Promise<void> {
  const bin = await resolveFfmpeg();
  const work = await mkdtemp(path.join(tmpdir(), "aicut-"));
  const cleanupWork = async () => {
    try {
      await rm(work, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  try {
    const videoTracks = project.tracks.filter(
      (t) => t.kind === "video" && t.clips.length > 0,
    );
    if (videoTracks.length === 0) {
      throw new Error("Project has no video clips to export");
    }

    // Flat list of every video clip in the project, paired with the
    // input index of its source. Source indices are shared across
    // clips so each unique source is opened exactly once.
    const allClips = videoTracks.flatMap((track, ti) =>
      track.clips.map((clip) => ({ track, trackIndex: ti, clip })),
    );

    // Collect unique sources in the order they first appear so the
    // `-i` flags below line up with the `[N:v]` references in the
    // filter graph.
    const sources = new Map(project.sources.map((s) => [s.id, s]));
    const inputOrder: MediaSource[] = [];
    const inputIndex = new Map<string, number>();
    for (const { clip } of allClips) {
      if (inputIndex.has(clip.sourceId)) continue;
      const src = sources.get(clip.sourceId);
      if (!src) throw new Error(`Missing source ${clip.sourceId}`);
      inputIndex.set(clip.sourceId, inputOrder.length);
      inputOrder.push(src);
    }

    const totalDurationSec = allClips.reduce((acc, { clip }) => {
      const end = (clip.start + (clip.out - clip.in)) / 1000;
      return Math.max(acc, end);
    }, 0);
    if (totalDurationSec <= 0) {
      throw new Error("Project timeline duration is zero");
    }

    // Probe which sources have audio so the filter graph can skip
    // `[N:a]` for video-only inputs (ffmpeg errors out instead of
    // silently dropping the chain, even with the `?` modifier).
    const probeBin = await resolveFfprobe();
    const sourceHasAudio = new Map<string, boolean>();
    await Promise.all(
      inputOrder.map(async (src) => {
        const has = await probeHasAudio(probeBin, resolveSourceUrl(src.url));
        sourceHasAudio.set(src.id, has);
      }),
    );

    // Output dims: resolve in priority order:
    //   1. explicit `opts.width/height` from the request body
    //   2. `project.output.{width,height}` — authoritative canvas
    //      authored by the user; every spatial value (panX/panY,
    //      keyframe values) is in these units, so this is the only
    //      size where preview == export pixel-for-pixel
    //   3. ffprobe of the bottom track's first clip — last-resort
    //      legacy fallback for old projects without `output`
    //   4. 1920×1080
    let width = opts.width;
    let height = opts.height;
    if (width == null || height == null) {
      if (project.output?.width && project.output?.height) {
        width ??= project.output.width;
        height ??= project.output.height;
      }
    }
    if (width == null || height == null) {
      const bottomTrack = videoTracks[0]!;
      const anchor = [...bottomTrack.clips].sort(
        (a, b) => a.start - b.start,
      )[0];
      if (anchor) {
        const src = sources.get(anchor.sourceId);
        if (src) {
          const dims = await probeVideoDimensions(
            probeBin,
            resolveSourceUrl(src.url),
          );
          if (dims) {
            width ??= dims.width;
            height ??= dims.height;
          }
        }
      }
      width ??= 1920;
      height ??= 1080;
    }
    // Even-pixel guard — H.264 requires even dims.
    width = width % 2 === 0 ? width : width - 1;
    height = height % 2 === 0 ? height : height - 1;
    const fps =
      opts.fps ?? project.output?.fps ?? project.fps ?? 30;
    const topTrackIndex = videoTracks.length - 1;

    const { fc, audioOut } = buildTimelineFilterComplex({
      videoTracks,
      inputIndex,
      sourceHasAudio,
      topTrackIndex,
      width,
      height,
      fps,
      totalDurationSec,
    });

    // One `-i` per unique source, in input-order so the `[N:v]`
    // labels in the filter graph match.
    const args: string[] = ["-y"];
    for (const src of inputOrder) {
      args.push("-i", resolveSourceUrl(src.url));
    }

    args.push(
      "-filter_complex",
      fc,
      "-map",
      "[vout]",
      ...(audioOut ? ["-map", audioOut] : []),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
    );
    if (audioOut) {
      args.push("-c:a", "aac");
    } else {
      args.push("-an");
    }
    args.push(
      "-movflags",
      "+faststart",
      "-nostats",
      "-progress",
      "pipe:1",
    );

    const tmpOut = path.join(work, "output.mp4");
    args.push(tmpOut);

    const { code, stderr } = await runFfmpeg(bin, args, {
      signal: opts.signal,
      onStdoutLine: (line) => {
        const us = parseUsLine(line);
        if (us == null) return;
        const elapsedSec = us / 1_000_000;
        const overall =
          totalDurationSec > 0
            ? Math.min(0.99, elapsedSec / totalDurationSec)
            : 0;
        opts.onProgress?.({
          phase: "encode",
          overall,
          totalClips: allClips.length,
        });
      },
    });
    if (code !== 0) {
      throw new Error(`ffmpeg compositor failed: ${stderr.slice(-2000)}`);
    }

    opts.onProgress?.({
      phase: "concat",
      overall: 0.99,
      totalClips: allClips.length,
    });
    await rename(tmpOut, opts.outputPath);
    opts.onProgress?.({
      phase: "concat",
      overall: 1,
      totalClips: allClips.length,
    });
  } finally {
    await cleanupWork();
  }
}

interface BuildArgs {
  videoTracks: Track[];
  inputIndex: Map<string, number>;
  /** sourceId → has-audio-track. Drives which clips contribute audio. */
  sourceHasAudio: Map<string, boolean>;
  topTrackIndex: number;
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
}

/**
 * Build the filter_complex graph for a multi-track project. Layout:
 *
 *   1. `color=black` base canvas spanning the full timeline
 *   2. Per-clip chain:
 *      [N:v] → trim(in,out) → setpts shift to clip.start
 *            → fit to W×H letterbox
 *            → scale by clip.scale (keyframe-animated)
 *   3. Overlay each transformed clip onto the running canvas in
 *      track-order (bottom track first → last track on top), with
 *      `enable='between(t,start,end)'` so a clip only paints during
 *      its window. Pan offsets feed the `overlay=x:y` expression.
 *   4. Audio: trim + delay each clip on the top track and `amix`
 *      them. Optional `?` on stream specifiers tolerates audio-less
 *      sources (libavformat 4.4+).
 */
function buildTimelineFilterComplex(a: BuildArgs): {
  fc: string;
  audioOut: string | null;
} {
  const parts: string[] = [];
  // Render the whole filter graph at 2× the final output dimensions
  // and downscale at the very end. The browser preview gets sub-pixel
  // smoothness for free (Retina canvases compose at 2× DPI + drawImage
  // accepts float dx/dy/dw/dh); ffmpeg's `scale` filter outputs
  // integer dimensions and an animated `scale=...:eval=frame` therefore
  // wobbles in 1-output-pixel steps that the eye catches. Working at
  // 2× internally and downsampling to the requested output halves the
  // per-step displacement at the final resolution and matches the
  // preview's perceived smoothness.
  const ow = a.width;
  const oh = a.height;
  const w = ow * 2;
  const h = oh * 2;
  parts.push(
    `color=c=black:s=${w}x${h}:r=${a.fps}:d=${fmt(a.totalDurationSec)}[bg]`,
  );

  // Walk tracks bottom→top in `project.tracks` order. Within each
  // track, we paint clips in start-time order so any sneaky reverse
  // sort upstream doesn't reverse z within the track.
  const trackClipLabels: Array<{
    track: Track;
    trackIndex: number;
    clip: Clip;
    label: string;
    startSec: number;
    endSec: number;
  }> = [];
  let clipNum = 0;
  for (let ti = 0; ti < a.videoTracks.length; ti += 1) {
    const track = a.videoTracks[ti]!;
    const ordered = [...track.clips].sort((c1, c2) => c1.start - c2.start);
    for (const clip of ordered) {
      const inputIdx = a.inputIndex.get(clip.sourceId)!;
      const inSec = clip.in / 1000;
      const durSec = (clip.out - clip.in) / 1000;
      const startSec = clip.start / 1000;
      const endSec = startSec + durSec;
      // Clip-local time variable for keyframe expressions — the
      // overlay filter sees global `t`, so keyframe times anchored at
      // 0 must be measured from `clip.start`.
      const tVar = `(t-${fmt(startSec)})`;
      const scaleExpr = compileKeyframeExpression(
        clip.keyframes,
        "scale",
        clip.scale ?? 1,
        { tVar },
      );

      // 1. Trim source to [in, out], shift to timeline start, snap to
      //    output framerate grid via `fps`. NOTE: do NOT chain another
      //    `setpts=N/(fps*TB)` after `fps` — it resets PTS to start
      //    from 0 (losing the clip.start offset) which makes
      //    `overlay enable='between(t,a,b)'` show the upper stream out
      //    of sync with the canvas, leaving a single-frame "twitch" on
      //    every duplicated frame from the variable-fps source.
      parts.push(
        `[${inputIdx}:v]trim=${fmt(inSec)}:${fmt(inSec + durSec)},setpts=PTS-STARTPTS+${fmt(startSec)}/TB,fps=${a.fps}[c${clipNum}t]`,
      );
      // 2. Single combined scale: fit-to-canvas × clip.scale, computed
      //    in one filter pass instead of fit-then-rescale. Two-stage
      //    scaling introduced cumulative interpolation drift that
      //    showed up as the PiP "trembling" frame-to-frame.
      //    `fit_ratio = min(W/iw, H/ih)` is constant (source ↔ canvas),
      //    `scaleExpr` is the keyframe-animated multiplier. Even-pixel
      //    guard isn't needed here — overlay onto the even canvas
      //    happily accepts odd dims and H.264 only cares about the
      //    final output. `round` keeps dim transitions 1px not 2px.
      //    `setsar=1` keeps the encoder from inheriting a non-square
      //    SAR from a screen-cap that lies about its display aspect.
      const wExpr = `round(iw*min(${w}/iw\\,${h}/ih)*(${scaleExpr}))`;
      const hExpr = `round(ih*min(${w}/iw\\,${h}/ih)*(${scaleExpr}))`;
      parts.push(
        `[c${clipNum}t]scale=w='${wExpr}':h='${hExpr}':eval=frame:flags=bicubic,setsar=1[c${clipNum}z]`,
      );
      trackClipLabels.push({
        track,
        trackIndex: ti,
        clip,
        label: `c${clipNum}z`,
        startSec,
        endSec,
      });
      clipNum += 1;
    }
  }

  // 4. Overlay onto the (2×) canvas in track order — last track on
  //    top. We hold the last comp at `[vfull]` so the final downscale
  //    pass can land it at the requested output dimensions tagged
  //    `[vout]`. Pan values are CSS pixels at OUTPUT scale; multiply
  //    by 2 here to stay in step with the 2× internal canvas.
  let canvas = "bg";
  for (let i = 0; i < trackClipLabels.length; i += 1) {
    const entry = trackClipLabels[i]!;
    const isLast = i === trackClipLabels.length - 1;
    const out = isLast ? "vfull" : `L${i}`;
    const tVar = `(t-${fmt(entry.startSec)})`;
    const panXExpr = compileKeyframeExpression(
      entry.clip.keyframes,
      "panX",
      entry.clip.panX ?? 0,
      { tVar },
    );
    const panYExpr = compileKeyframeExpression(
      entry.clip.keyframes,
      "panY",
      entry.clip.panY ?? 0,
      { tVar },
    );
    parts.push(
      `[${canvas}][${entry.label}]overlay=` +
        `x='(W-w)/2+2*(${panXExpr})':` +
        `y='(H-h)/2+2*(${panYExpr})':` +
        `enable='between(t,${fmt(entry.startSec)},${fmt(entry.endSec)})':` +
        `eval=frame:format=auto[${out}]`,
    );
    canvas = out;
  }

  // 4b. Final downscale from the 2× internal canvas to the requested
  //     output dimensions. `lanczos` keeps high-freq content crisp and
  //     averages sub-pixel jitter from the per-frame scale animation
  //     down to half-pixel motion at output resolution.
  parts.push(`[vfull]scale=${ow}:${oh}:flags=lanczos[vout]`);

  // 5. Audio: only the top track contributes per the editor's PiP
  //    policy. Each clip's audio is trimmed, rebased, and delayed to
  //    its timeline `start`; multiple clips amix together. Sources
  //    without an audio stream are skipped — see probeHasAudio.
  const topTrack = a.videoTracks[a.topTrackIndex];
  const audioLabels: string[] = [];
  if (topTrack) {
    let ai = 0;
    for (const clip of [...topTrack.clips].sort(
      (c1, c2) => c1.start - c2.start,
    )) {
      if (!a.sourceHasAudio.get(clip.sourceId)) continue;
      const inputIdx = a.inputIndex.get(clip.sourceId)!;
      const inSec = clip.in / 1000;
      const outSec = clip.out / 1000;
      const startMs = Math.round(clip.start);
      // atrim crops audio to [in, out]; asetpts rebases to 0; adelay
      // shifts to clip.start in ms. `all=1` is required for multi-
      // channel sources or only the first channel gets delayed.
      parts.push(
        `[${inputIdx}:a]atrim=${fmt(inSec)}:${fmt(outSec)},asetpts=PTS-STARTPTS,adelay=${startMs}|${startMs}:all=1[a${ai}]`,
      );
      audioLabels.push(`a${ai}`);
      ai += 1;
    }
  }

  let audioOut: string | null = null;
  if (audioLabels.length === 1) {
    parts.push(`[${audioLabels[0]}]anull[aout]`);
    audioOut = "[aout]";
  } else if (audioLabels.length > 1) {
    const inputs = audioLabels.map((l) => `[${l}]`).join("");
    parts.push(
      `${inputs}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`,
    );
    audioOut = "[aout]";
  }

  return { fc: parts.join(";"), audioOut };
}

/** ffmpeg-friendly number — 6 sig figs, no scientific notation. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Parse a single `key=value` line from ffmpeg's `-progress` stream.
 * We only care about `out_time_us` (microseconds — unambiguous across
 * ffmpeg builds, unlike `out_time_ms` which has flipped meanings).
 */
function parseUsLine(line: string): number | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const key = line.slice(0, eq);
  if (key !== "out_time_us") return null;
  const v = Number(line.slice(eq + 1));
  return Number.isFinite(v) ? v : null;
}
