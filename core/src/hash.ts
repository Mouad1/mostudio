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

/** sha256 over sorted path names, streamed file bytes, and canonical JSON of params. */
export async function hashFiles(paths: string[], params: unknown): Promise<string> {
  const hash = createHash("sha256");
  for (const p of [...paths].sort()) {
    hash.update(`${p}\0`);
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
