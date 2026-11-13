import { chmod, open, readFile, rename, rm } from "node:fs/promises";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const BARE_VALUE_RE = /^[A-Za-z0-9_./:@+,-]*$/;

/**
 * Format a string value for dotenv storage.
 * - bare if matches `/^[A-Za-z0-9_./:@+,-]*$/` and non-empty
 * - single-quoted if contains no `'`
 * - double-quoted if contains no `"`
 * - throws if contains both quote kinds or newlines
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("newline in value");
  }
  if (value.length > 0 && BARE_VALUE_RE.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  throw new Error("cannot store value with both quote kinds");
}

/**
 * Mask a secret string for display.
 * - empty string returns empty
 * - <= 8 chars returns "••••"
 * - > 8 chars returns first 3 + "…" + last 4
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/**
 * Update key-value pairs in a dotenv-style file.
 * - Replaces owning line in place and keeps every other line byte-for-byte.
 * - `null` or `""` removes the key lines.
 * - Dropping `export` prefix and inline comments on updated lines; subsequent duplicates removed.
 * - New keys appended at the end in insertion order.
 * - Atomic write via `<path>.<pid>.tmp` with mode 0600.
 * - Output ends with exactly one \n unless empty.
 */
export async function updateEnvFile(
  path: string,
  updates: Record<string, string | null>,
): Promise<void> {
  for (const [key, val] of Object.entries(updates)) {
    if (!KEY_RE.test(key)) {
      throw new Error(`invalid env name: ${key}`);
    }
    if (val !== null && val !== undefined && /[\r\n]/.test(val)) {
      throw new Error(`newline in value of ${key}`);
    }
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      text = "";
    } else {
      throw err;
    }
  }

  const rawLines = text.length === 0
    ? []
    : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

  const seen = new Set<string>();
  const outLines: string[] = [];

  for (const line of rawLines) {
    const m = KEY_LINE_RE.exec(line);
    if (m) {
      const key = m[1] as string;
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        const val = updates[key];
        if (val === null || val === "" || val === undefined) {
          // Removal: skip this owning line
          continue;
        }
        if (seen.has(key)) {
          // Subsequent duplicates of the key are removed
          continue;
        }
        seen.add(key);
        outLines.push(`${key}=${formatEnvValue(val)}`);
        continue;
      }
    }
    outLines.push(line);
  }

  // Append new keys in insertion order
  for (const [key, val] of Object.entries(updates)) {
    if (val !== null && val !== "" && val !== undefined && !seen.has(key)) {
      seen.add(key);
      outLines.push(`${key}=${formatEnvValue(val)}`);
    }
  }

  let content = outLines.join("\n");
  if (content.length > 0) {
    content = content.replace(/\n*$/, "\n");
  }

  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
