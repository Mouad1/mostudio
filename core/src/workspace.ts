import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson } from "./fs/atomic.ts";
import { parseProviders } from "./providers/parse.ts";
import type { ProviderEntry } from "./providers/registry.ts";

/** Package directory of mostudio. */
export const PACKAGE_ROOT: string = resolve(import.meta.dirname, "..", "..");

/** Finds the nearest ancestor (inclusive) holding mostudio.config.json. */
export function findWorkspace(start: string): string | undefined {
  let curr = resolve(start);
  while (true) {
    if (existsSync(join(curr, "mostudio.config.json"))) {
      return curr;
    }
    const parent = dirname(curr);
    if (parent === curr) {
      return undefined;
    }
    curr = parent;
  }
}

/** Resolves a relative path preferring the workspace copy, falling back to package root. */
export function resolveShared(root: string, rel: string): string {
  const local = join(root, rel);
  if (existsSync(local)) return local;
  return join(PACKAGE_ROOT, rel);
}

/** Reads providers.json from the workspace or the package fallback. */
export async function loadProvidersFile(root: string): Promise<ProviderEntry[]> {
  const path = resolveShared(root, "providers.json");
  let json: unknown;
  try {
    json = await readJson<unknown>(path);
  } catch (err) {
    throw new Error(`providers.json at ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (json === undefined) throw new Error(`providers.json not found at ${path} (set MOSTUDIO_ROOT to the mostudio repo)`);
  return parseProviders(json);
}
