import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve which ffmpeg binary to use. Order of preference:
 *   1. AICUT_FFMPEG env var (explicit override)
 *   2. ./ffmpeg-bin/ffmpeg next to the running backend (extracted from
 *      the layered ffmpeg.zip — see backends/ts/README.md)
 *   3. system PATH `ffmpeg`
 */
export async function resolveFfmpeg(): Promise<string> {
  const envBin = process.env["AICUT_FFMPEG"];
  if (envBin && (await fileExists(envBin))) return envBin;

  const bundled = path.resolve(__dirname, "..", "ffmpeg-bin", "ffmpeg");
  if (await fileExists(bundled)) return bundled;

  return "ffmpeg";
}

/** Resolve ffprobe alongside ffmpeg, with the same precedence. */
export async function resolveFfprobe(): Promise<string> {
  const envBin = process.env["AICUT_FFPROBE"];
  if (envBin && (await fileExists(envBin))) return envBin;

  const bundled = path.resolve(__dirname, "..", "ffmpeg-bin", "ffprobe");
  if (await fileExists(bundled)) return bundled;

  return "ffprobe";
}

/** Same proxy-strip env used by ffmpeg subprocesses — see runFfmpeg
 *  for the why. Exported so ffprobe spawns can share it. */
function noProxyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  env.no_proxy = "localhost,127.0.0.1,::1";
  return env;
}

/**
 * Probe a source's intrinsic video dimensions. Used to derive the
 * export canvas size when the client doesn't pass one, matching the
 * frontend's `canvasReferenceDims` (= first video clip on the bottom
 * track). Returns null on any failure — caller decides the fallback.
 */
export async function probeVideoDimensions(
  ffprobeBin: string,
  url: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobeBin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: noProxyEnv() },
    );
    let stdout = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const trimmed = stdout.trim();
      const m = /^(\d+),(\d+)$/.exec(trimmed);
      if (!m) return resolve(null);
      const width = Number(m[1]);
      const height = Number(m[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return resolve(null);
      }
      resolve({ width, height });
    });
  });
}

/**
 * Check whether a source has at least one audio stream. The render
 * graph hits a hard "no streams" error when we wire `[N:a]` against
 * a video-only source (and ffmpeg's `?` modifier only helps if the
 * sub-graph is independently dropped — chained filters trip the same
 * error). Probe up front so we know which clips contribute audio.
 *
 * Failures (network error, missing binary) treat the source as
 * audio-less rather than aborting the whole render — at worst the
 * output is silent, which is recoverable.
 */
export async function probeHasAudio(
  ffprobeBin: string,
  url: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobeBin,
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: noProxyEnv() },
    );
    let stdout = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.on("error", () => resolve(false));
    proc.on("close", () => {
      resolve(stdout.trim().length > 0);
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FfmpegRunResult {
  code: number;
  stderr: string;
}

export interface FfmpegRunOpts {
  signal?: AbortSignal;
  /**
   * Called for each newline-terminated chunk on ffmpeg's STDOUT.
   * We use this to consume ffmpeg's `-progress pipe:1` output — a
   * stream of `key=value` lines terminated by `progress=continue` or
   * `progress=end` after each report block.
   */
  onStdoutLine?: (line: string) => void;
}

export function runFfmpeg(
  bin: string,
  args: string[],
  opts: FfmpegRunOpts = {},
): Promise<FfmpegRunResult> {
  return new Promise((resolve, reject) => {
    // We want stdout when progress is being parsed; without an
    // onStdoutLine consumer, draining it costs nothing meaningful but
    // keeps the contract uniform.
    // Strip any inherited HTTP/HTTPS proxy env vars from the ffmpeg
    // subprocess — see noProxyEnv for the why.
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: noProxyEnv(),
    });
    let stderr = "";
    let stdoutBuf = "";
    proc.stdout.on("data", (b: Buffer) => {
      if (!opts.onStdoutLine) return;
      stdoutBuf += b.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trimEnd();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) opts.onStdoutLine(line);
      }
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    proc.once("error", (err) => reject(err));
    proc.once("close", (code) => resolve({ code: code ?? -1, stderr }));
    opts.signal?.addEventListener(
      "abort",
      () => {
        proc.kill("SIGTERM");
      },
      { once: true },
    );
  });
}
