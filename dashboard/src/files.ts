import { createWriteStream } from "node:fs";
import { realpath, stat, statfs } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { writeOutputAtomic } from "../../core/src/index.ts";
import { HttpError, type Req } from "./http.ts";

/**
 * Rejects "..", absolute paths, and NUL bytes.
 * Verifies that the deepest existing ancestor stays inside `realpath(dir)`.
 * Throws HttpError(400, "path escapes folder") on escape.
 */
export async function insideDir(dir: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.includes("\0")) {
    throw new HttpError(400, "path escapes folder");
  }
  if (isAbsolute(rel)) {
    throw new HttpError(400, "path escapes folder");
  }
  const parts = rel.split(/[\/\\]/);
  if (parts.includes("..")) {
    throw new HttpError(400, "path escapes folder");
  }

  const realDir = await realpath(dir);
  const dirWithSep = realDir.endsWith(sep) ? realDir : realDir + sep;
  const target = resolve(realDir, rel);

  let ancestor = target;
  while (true) {
    try {
      await stat(ancestor);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      } else {
        throw err;
      }
    }
  }

  const realAncestor = await realpath(ancestor);
  const isAncestorInside = realAncestor === realDir || realAncestor.startsWith(dirWithSep);
  if (!isAncestorInside) {
    throw new HttpError(400, "path escapes folder");
  }

  const tail = relative(ancestor, target);
  const resolved = tail ? join(realAncestor, tail) : realAncestor;

  if (resolved !== realDir && !resolved.startsWith(dirWithSep)) {
    throw new HttpError(400, "path escapes folder");
  }

  return resolved;
}

/**
 * Sanitizes file name: takes basename, strips control chars and leading dots, trims whitespace,
 * caps length at 120 chars while preserving extension. Throws HttpError(400, "bad file name") if empty.
 */
export function safeFileName(name: string): string {
  if (typeof name !== "string") {
    throw new HttpError(400, "bad file name");
  }
  const noControl = name.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  let base = basename(noControl.replace(/\\/g, "/"));
  base = base.replace(/^\.+/, "").trim();
  base = base.replace(/^\.+/, "").trim();
  if (!base) {
    throw new HttpError(400, "bad file name");
  }
  if (base.length > 120) {
    const ext = extname(base);
    if (ext.length < 120) {
      const stem = base.slice(0, -ext.length);
      base = stem.slice(0, 120 - ext.length) + ext;
    } else {
      base = base.slice(0, 120);
    }
  }
  if (!base) {
    throw new HttpError(400, "bad file name");
  }
  return base;
}

/**
 * Returns `join(dir, name)` if available, or appends " (2)", " (3)" until finding an unused filename.
 */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  try {
    await stat(p);
  } catch {
    return p;
  }
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let counter = 2;
  while (true) {
    const candidate = join(dir, `${stem} (${counter})${ext}`);
    try {
      await stat(candidate);
      counter++;
    } catch {
      return candidate;
    }
  }
}

/**
 * Uses statfs to verify available disk space.
 * Throws HttpError(507, "Not enough free disk space...") if bavail * bsize < bytes.
 */
export async function ensureSpace(dir: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;

  let checkDir = dir;
  while (true) {
    try {
      await stat(checkDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(checkDir);
        if (parent === checkDir) break;
        checkDir = parent;
      } else {
        throw err;
      }
    }
  }

  const stats = await statfs(checkDir);
  const available = BigInt(stats.bavail) * BigInt(stats.bsize);
  const needed = BigInt(bytes);
  if (available < needed) {
    const needGB = (Number(needed) / (1024 * 1024 * 1024)).toFixed(2);
    const haveGB = (Number(available) / (1024 * 1024 * 1024)).toFixed(2);
    throw new HttpError(507, `Not enough free disk space: need ${needGB} GB, have ${haveGB} GB`);
  }
}

/**
 * Saves incoming request body stream to finalPath atomically.
 * Requires Content-Length header, checks disk space for 2.2x length, and cleans up on abort.
 */
export async function saveStream(req: Req, finalPath: string): Promise<number> {
  const cl = req.headers["content-length"];
  if (!cl) {
    throw new HttpError(411, "Length Required");
  }
  const len = Number(cl);
  if (!Number.isSafeInteger(len) || len < 0) {
    throw new HttpError(400, "invalid Content-Length");
  }

  await ensureSpace(dirname(finalPath), Math.ceil(2.2 * len));

  let bytesWritten = 0;
  try {
    await writeOutputAtomic(finalPath, async (tmpPath) => {
      const out = createWriteStream(tmpPath);
      req.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });
      await pipeline(req, out);
    });
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE" ||
      (req as any).destroyed ||
      (req as any).aborted
    ) {
      throw new HttpError(400, "upload interrupted");
    }
    throw err;
  }

  return bytesWritten;
}
