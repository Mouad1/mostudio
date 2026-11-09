import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonicalize(obj[k])]),
    );
  }
  return value;
}

/** A file to hash: a bare path is its own key; `key` names it stably (e.g. relative to the project). */
export type HashInput = string | { path: string; key: string };

/** sha256 over sorted keys, streamed file bytes, and canonical JSON of params. */
export async function hashFiles(files: HashInput[], params: unknown): Promise<string> {
  const hash = createHash("sha256");
  const items = files
    .map((f) => (typeof f === "string" ? { path: f, key: f } : f))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { path: p, key } of items) {
    hash.update(`${key}\0`);
    try {
      for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
    } catch (err) {
      throw new Error(`hashFiles: cannot read ${p}: ${(err as Error).message}`, { cause: err });
    }
    hash.update("\0");
  }
  hash.update(JSON.stringify(canonicalize(params === undefined ? null : params)));
  return hash.digest("hex");
}
