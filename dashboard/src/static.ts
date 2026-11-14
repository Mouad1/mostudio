import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PACKAGE_ROOT } from "../../core/src/index.ts";
import { insideDir } from "./files.ts";
import { HttpError, type Req, type Res } from "./http.ts";

export const WEB_ROOT: string = join(PACKAGE_ROOT, "dashboard", "web");

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export function contentType(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/**
 * Parses HTTP Range header.
 * Supports `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`.
 * Rejects multiple ranges or out-of-bounds as "invalid".
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (header === undefined) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return "invalid";
  if (size <= 0) return "invalid";

  const startStr = m[1]!;
  const endStr = m[2]!;

  if (startStr !== "" && endStr !== "") {
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "invalid";
    if (start < 0 || start > end || end >= size) return "invalid";
    return { start, end };
  } else if (startStr !== "" && endStr === "") {
    const start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return "invalid";
    return { start, end: size - 1 };
  } else if (startStr === "" && endStr !== "") {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  return "invalid";
}

/**
 * Serves a file with Range support (200 / 206 / 416).
 * Adds nosniff and Accept-Ranges.
 * Adds Content-Disposition: attachment on .svg and .html files.
 */
export async function serveFile(req: Req, res: Res, absPath: string): Promise<void> {
  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (stats.isDirectory()) {
    throw new HttpError(404, "not found");
  }

  const mime = contentType(absPath);
  const ext = extname(absPath).toLowerCase();

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  if (ext === ".svg" || ext === ".html") {
    res.setHeader("Content-Disposition", "attachment");
  }

  const range = parseRange(req.headers.range, stats.size);

  if (range === "invalid") {
    res.writeHead(416, {
      "Content-Range": `bytes */${stats.size}`,
    });
    res.end();
    return;
  }

  const isHead = (req.method ?? "GET").toUpperCase() === "HEAD";

  if (range === undefined) {
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", stats.size);
    res.writeHead(200);
    if (isHead) {
      res.end();
      return;
    }
    try {
      await pipeline(createReadStream(absPath), res);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
        throw err;
      }
    }
    return;
  }

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stats.size}`);
  res.setHeader("Content-Length", range.end - range.start + 1);
  res.writeHead(206);
  if (isHead) {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(absPath, { start: range.start, end: range.end }), res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      throw err;
    }
  }
}

const tsCache = new Map<string, { mtimeMs: number; code: string }>();

const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'";

/**
 * Serves files from WEB_ROOT.
 * Handles "/" -> "index.html".
 * Rejects escapes and *.test.ts (returns false).
 * Strips TypeScript types from .ts files, cached by mtime.
 * Returns true if handled, false if not found.
 */
export async function serveWeb(req: Req, res: Res, url: URL): Promise<boolean> {
  let rel = url.pathname;
  if (rel === "/" || rel === "") {
    rel = "index.html";
  } else if (rel.startsWith("/")) {
    rel = rel.slice(1);
  }

  if (rel.endsWith(".test.ts") || rel.includes(".test.")) {
    return false;
  }

  let absPath: string;
  try {
    absPath = await insideDir(WEB_ROOT, rel);
  } catch {
    return false;
  }

  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    return false;
  }

  if (stats.isDirectory()) {
    try {
      absPath = await insideDir(absPath, "index.html");
      stats = await stat(absPath);
    } catch {
      return false;
    }
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", WEB_CSP);

  const isHead = (req.method ?? "GET").toUpperCase() === "HEAD";

  if (absPath.endsWith(".ts")) {
    const cached = tsCache.get(absPath);
    let code: string;
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      code = cached.code;
    } else {
      const source = await readFile(absPath, "utf8");
      code = stripTypeScriptTypes(source, { mode: "strip" });
      tsCache.set(absPath, { mtimeMs: stats.mtimeMs, code });
    }

    const buf = Buffer.from(code, "utf8");
    res.setHeader("Content-Type", "text/javascript");
    res.setHeader("Content-Length", buf.length);
    res.writeHead(200);
    if (isHead) {
      res.end();
    } else {
      res.end(buf);
    }
    return true;
  }

  const mime = contentType(absPath);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", stats.size);
  res.setHeader("Accept-Ranges", "bytes");

  const range = parseRange(req.headers.range, stats.size);
  if (range === "invalid") {
    res.writeHead(416, {
      "Content-Range": `bytes */${stats.size}`,
    });
    res.end();
    return true;
  }

  if (range !== undefined) {
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stats.size}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
    res.writeHead(206);
    if (isHead) {
      res.end();
    } else {
      try {
        await pipeline(createReadStream(absPath, { start: range.start, end: range.end }), res);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
      }
    }
    return true;
  }

  res.writeHead(200);
  if (isHead) {
    res.end();
  } else {
    try {
      await pipeline(createReadStream(absPath), res);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
    }
  }
  return true;
}
