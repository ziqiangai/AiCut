import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Clip, Project } from "@aicut/core";
import { resolveFfmpeg, runFfmpeg } from "./ffmpeg.js";
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
  // ffmpeg-native protocol prefixes — never touch.
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
   * created by the caller; we still place segments in a temp dir
   * that gets cleaned up regardless.
   */
  outputPath: string;
  /** Granular progress notifications across encode + concat phases. */
  onProgress?: (e: ProgressEvent) => void;
}

export interface ProgressEvent {
  /**
   * `encode`: a per-clip ffmpeg re-encode pass is in flight. Includes
   *   `clipIndex` so the client can show "Encoding 2/5".
   * `concat`: stream-copy concat pass; emitted once at start and once
   *   when complete (no incremental progress — concat is i/o-bound and
   *   typically takes a tenth of the encode time).
   */
  phase: "encode" | "concat";
  /** 0–1 overall, weighted by clip durations. */
  overall: number;
  clipIndex?: number;
  totalClips?: number;
}

/**
 * Render a Project's video track to a single mp4 at `opts.outputPath`.
 * Returns when finished. Caller is responsible for cleaning up the
 * output file itself if/when it's no longer needed; the temp segments
 * dir is always cleaned up here.
 *
 * Strategy unchanged from v0: per-clip re-encode to a normalized
 * H.264/AAC mp4 segment, then concat-demuxer stream-copy. Progress
 * is reported by parsing ffmpeg's `-progress pipe:1` output for
 * `out_time_us` and aggregating against total project duration.
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
    const videoTrack = project.tracks.find((t) => t.kind === "video");
    if (!videoTrack || videoTrack.clips.length === 0) {
      throw new Error("Project has no video clips to export");
    }
    const sources = new Map(project.sources.map((s) => [s.id, s]));

    const totalMs = videoTrack.clips.reduce(
      (acc, c) => acc + (c.out - c.in),
      0,
    );
    const totalClips = videoTrack.clips.length;
    let accumDoneMs = 0;

    const segmentPaths: string[] = [];
    let i = 0;
    for (const clip of videoTrack.clips) {
      const src = sources.get(clip.sourceId);
      if (!src) throw new Error(`Missing source ${clip.sourceId}`);
      const seg = path.join(work, `seg-${i}.mp4`);
      const inSec = clip.in / 1000;
      const durMs = clip.out - clip.in;
      const durSec = durMs / 1000;
      const args = [
        "-y",
        "-ss",
        inSec.toString(),
        "-i",
        resolveSourceUrl(src.url),
        "-t",
        durSec.toString(),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
      ];
      const hasKeyframes = (clip.keyframes?.length ?? 0) > 0;
      if (hasKeyframes && !(opts.width && opts.height)) {
        // Silent skip historically — kf path needs an output canvas
        // and the original gate `hasKeyframes && opts.width && ...`
        // just fell through to the no-vf branch when dims were
        // missing. Now we warn so the operator notices instead of
        // shipping an un-animated export and wondering why.
        // eslint-disable-next-line no-console
        console.warn(
          `[render] clip ${clip.id} has ${clip.keyframes!.length} keyframe(s) but no output width/height — pass { output: { width, height } } in the request to apply keyframe animation.`,
        );
      }
      if (hasKeyframes && opts.width && opts.height) {
        // Animated path — build a filter_complex that mirrors the
        // frontend PiP semantics (fixed black bg, animated content
        // inside). See buildKeyframeFilterComplex for the math.
        const fc = buildKeyframeFilterComplex(
          clip,
          opts.width,
          opts.height,
          opts.fps ?? 30,
          durSec,
        );
        args.push("-filter_complex", fc, "-map", "[out]", "-map", "0:a?");
      } else if (opts.width && opts.height) {
        args.push(
          "-vf",
          `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2`,
        );
      }
      if (opts.fps) {
        args.push("-r", opts.fps.toString());
      }
      // Quiet logging on stderr + key=value progress on stdout so we
      // can drive the SSE stream without scraping noisy stderr.
      args.push("-nostats", "-progress", "pipe:1", seg);

      const localI = i;
      const { code, stderr } = await runFfmpeg(bin, args, {
        signal: opts.signal,
        onStdoutLine: (line) => {
          const us = parseUsLine(line);
          if (us == null) return;
          const clipMs = Math.min(durMs, us / 1000);
          const overall = totalMs > 0 ? (accumDoneMs + clipMs) / totalMs : 0;
          opts.onProgress?.({
            phase: "encode",
            overall: Math.min(0.99, overall),
            clipIndex: localI,
            totalClips,
          });
        },
      });
      if (code !== 0) {
        throw new Error(`ffmpeg segment ${i} failed: ${stderr.slice(-2000)}`);
      }
      accumDoneMs += durMs;
      segmentPaths.push(seg);
      i++;
    }

    opts.onProgress?.({
      phase: "concat",
      overall: 0.99,
      totalClips,
    });

    const listPath = path.join(work, "concat.txt");
    const listContent = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listContent, "utf8");

    const tmpOut = path.join(work, "output.mp4");
    const concatArgs = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      tmpOut,
    ];
    const concat = await runFfmpeg(bin, concatArgs, { signal: opts.signal });
    if (concat.code !== 0) {
      throw new Error(`ffmpeg concat failed: ${concat.stderr.slice(-2000)}`);
    }
    await rename(tmpOut, opts.outputPath);
    opts.onProgress?.({ phase: "concat", overall: 1, totalClips });
  } finally {
    await cleanupWork();
  }
}

/**
 * Compile a filter_complex graph that applies pan / scale keyframe
 * animation to a single clip. Mirrors the frontend PiP semantics:
 *
 *   1. Fit the source into the output W×H (letterbox, preserve AR).
 *   2. Scale the fitted content by the animated `scale` expression.
 *   3. Composite onto a fixed black background, panning via
 *      animated `panX` / `panY` expressions added to the centered
 *      anchor.
 *
 * Per-frame evaluation is opt-in (`eval=frame`) — without that flag
 * the expressions evaluate exactly once at filter init.
 *
 * Pan note: the frontend stores panX / panY in CSS pixels of the
 * preview area. This backend treats them as OUTPUT pixels 1:1 — the
 * cleanest interpretation when we don't know the authoring preview
 * size. If preview ≠ output dimensions the user may need to scale
 * pan values; documented in the README under "known limitations".
 */
function buildKeyframeFilterComplex(
  clip: Clip,
  width: number,
  height: number,
  fps: number,
  durSec: number,
): string {
  const kfs = clip.keyframes;
  // Static base falls through when a prop has no keyframes. Matches
  // interpolateProp's behavior so the export visual = preview visual.
  const scaleExpr = compileKeyframeExpression(kfs, "scale", clip.scale ?? 1);
  const panXExpr = compileKeyframeExpression(kfs, "panX", clip.panX ?? 0);
  const panYExpr = compileKeyframeExpression(kfs, "panY", clip.panY ?? 0);
  // Round scaled w/h to even integers — H.264 requires even dims;
  // ffmpeg will otherwise error with "width not divisible by 2".
  const wExpr = `trunc(iw*(${scaleExpr})/2)*2`;
  const hExpr = `trunc(ih*(${scaleExpr})/2)*2`;
  return [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[fitted]`,
    `[fitted]scale=w='${wExpr}':h='${hExpr}':eval=frame[zoomed]`,
    `color=c=black:s=${width}x${height}:r=${fps}:d=${durSec.toFixed(3)},format=yuv420p[bg]`,
    `[bg][zoomed]overlay=x='(W-w)/2+(${panXExpr})':y='(H-h)/2+(${panYExpr})':eval=frame:format=auto[out]`,
  ].join(";");
}

/**
 * Parse a single `key=value` line from ffmpeg's `-progress` stream.
 * We only care about `out_time_us` (unambiguous microseconds across
 * ffmpeg versions — `out_time_ms` has varied between ms and us in
 * different builds and is unreliable).
 */
function parseUsLine(line: string): number | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const key = line.slice(0, eq);
  if (key !== "out_time_us") return null;
  const v = Number(line.slice(eq + 1));
  return Number.isFinite(v) ? v : null;
}
