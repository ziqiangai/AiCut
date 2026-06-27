import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { Project } from "@aicut/core";
import { renderProject, type ProgressEvent } from "./render.js";

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const OUTPUTS_DIR = path.resolve(process.cwd(), "outputs");
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
await mkdir(OUTPUTS_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

const ALLOWED_VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4v",
]);

app.get("/health", async () => ({ ok: true, backend: "ts" }));

/**
 * Multipart upload landing zone — the demo's UploadPanel POSTs the
 * picked file here. We stash it under `uploads/<uuid><ext>` and hand
 * back the absolute URL the editor should use as the clip's `source.url`.
 * Same URL is also a valid `-i` input for ffmpeg at export time.
 */
app.post("/upload", async (req, reply) => {
  const file = await req.file();
  if (!file) {
    return reply.code(400).send({ error: "Missing file field" });
  }
  const ext = path.extname(file.filename).toLowerCase();
  if (!ALLOWED_VIDEO_EXTS.has(ext)) {
    return reply
      .code(400)
      .send({ error: `Unsupported file type: ${ext || "unknown"}` });
  }
  const id = randomUUID();
  const stored = `${id}${ext}`;
  const dest = path.join(UPLOADS_DIR, stored);
  try {
    await pipeline(file.file, createWriteStream(dest));
  } catch (err) {
    await unlink(dest).catch(() => undefined);
    req.log.error({ err }, "upload failed");
    return reply.code(500).send({ error: (err as Error).message });
  }
  if (file.file.truncated) {
    await unlink(dest).catch(() => undefined);
    return reply.code(413).send({ error: "File too large" });
  }
  const origin = `${req.protocol}://${req.headers.host}`;
  return { url: `${origin}/files/${stored}`, id: stored, name: file.filename };
});

interface ExportBody {
  project: Project;
  output?: { width?: number; height?: number; fps?: number };
}

/**
 * Streams the export job back as Server-Sent Events. Each `data:` line
 * is a JSON object with `phase` ∈ {encode, concat, done, error} plus
 * progress / final-url fields. Client uses a fetch + ReadableStream
 * reader (EventSource doesn't accept POST bodies).
 */
app.post("/export", async (req, reply) => {
  const body = req.body as ExportBody | undefined;
  if (!body?.project) {
    return reply.code(400).send({ error: "Missing project in request body" });
  }

  const id = randomUUID();
  const outputPath = path.join(OUTPUTS_DIR, `${id}.mp4`);

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // CORS preflight already accepted by the cors plugin above; SSE
    // responses need the origin header repeated on the raw write.
    "access-control-allow-origin": req.headers.origin ?? "*",
  });

  const send = (data: object): void => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  req.raw.once("close", () => controller.abort());

  // Heartbeat — keep proxies / load balancers from closing the
  // connection during long encodes that emit no progress events.
  const heartbeat = setInterval(() => {
    reply.raw.write(": ping\n\n");
  }, 15_000);

  try {
    let lastSent = 0;
    await renderProject(body.project, {
      ...body.output,
      outputPath,
      signal: controller.signal,
      onProgress: (e: ProgressEvent) => {
        // Throttle to ~5/sec so the SSE stream isn't a flood when the
        // ffmpeg fast preset emits dozens of progress lines per sec.
        const now = Date.now();
        if (e.phase === "encode" && now - lastSent < 200) return;
        lastSent = now;
        send(e);
      },
    });
    send({ phase: "done", fileUrl: `/files/${id}.mp4`, id });
  } catch (err) {
    req.log.error({ err }, "export failed");
    send({ phase: "error", error: (err as Error).message });
  } finally {
    clearInterval(heartbeat);
    reply.raw.end();
  }
});

/**
 * Serve rendered exports AND uploaded source files. ID format:
 *   - exports: `<uuid>.mp4`
 *   - uploads: `<uuid><.mp4|.mov|.webm|.mkv|.m4v>`
 * Both shapes are anchored at uuid + a whitelisted extension so the
 * regex catches all path-traversal attempts before disk lookup.
 *
 * Supports HTTP Range requests — required by ffmpeg when reading a
 * QuickTime/.mov with the `moov` atom at the END of the file (typical
 * for screen recordings). Without range support ffmpeg can't seek to
 * the end of the stream, fails with "moov atom not found", and the
 * export aborts before encoding the first frame.
 */
app.get("/files/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[a-f0-9-]{36}\.(mp4|mov|webm|mkv|m4v)$/i.test(id)) {
    return reply.code(400).send({ error: "bad file id" });
  }
  const ext = path.extname(id).toLowerCase();
  // Try outputs first (exports), then uploads.
  for (const dir of [OUTPUTS_DIR, UPLOADS_DIR]) {
    const p = path.join(dir, id);
    const stats = await stat(p).catch(() => null);
    if (!stats) continue;
    const ctype =
      ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4";
    reply
      .header("content-type", ctype)
      .header("cache-control", "no-store")
      .header("accept-ranges", "bytes");

    const range = req.headers.range;
    const rangeMatch = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (rangeMatch) {
      const totalSize = stats.size;
      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : totalSize - 1;
      // Handle suffix range `bytes=-N` (last N bytes).
      if (!startStr && endStr) {
        const suffix = parseInt(endStr, 10);
        start = Math.max(0, totalSize - suffix);
        end = totalSize - 1;
      }
      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start > end ||
        start >= totalSize
      ) {
        return reply
          .code(416)
          .header("content-range", `bytes */${totalSize}`)
          .send({ error: "range not satisfiable" });
      }
      end = Math.min(end, totalSize - 1);
      const chunkSize = end - start + 1;
      reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${totalSize}`)
        .header("content-length", chunkSize);
      return reply.send(createReadStream(p, { start, end }));
    }

    reply.header("content-length", stats.size);
    return reply.send(createReadStream(p));
  }
  return reply.code(404).send({ error: "not found" });
});

const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "127.0.0.1";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
