import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SUBDIRS = ["media", "cache", "scenes", "renders", "steps"];

function localDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Create `<root>/<YYYY-MM-DD>-<slug>` with the standard layout; returns its path. */
export async function createProject(
  root: string,
  slug: string,
  opts: { date?: Date; brief?: string } = {},
): Promise<string> {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  const dir = join(root, `${localDate(opts.date ?? new Date())}-${slug}`);
  await mkdir(root, { recursive: true });
  await mkdir(dir); // throws EEXIST if the project already exists
  for (const d of SUBDIRS) await mkdir(join(dir, d));
  await writeFile(join(dir, "brief.md"), opts.brief ?? "# Brief\n");
  return dir;
}
