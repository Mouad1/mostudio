import { open, readFile, rename, rm } from "node:fs/promises";

export type AtomicDeps = {
  rename?: (from: string, to: string) => Promise<void>;
};

/** Write JSON via `<path>.<pid>.tmp` + fsync + rename; never leaves a partial target. */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  deps: AtomicDeps = {},
): Promise<void> {
  const doRename = deps.rename ?? rename;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await doRename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Parsed JSON, or undefined only if the file does not exist. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}
