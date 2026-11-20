import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ScaffoldEntry = {
  path: string;
  status: "created" | "kept";
  purpose: string;
};

const DEFAULT_CONFIG = JSON.stringify(
  {
    billing: "free-only",
    projectsRoot: "projects",
    inspirationRoot: "inspiration",
  },
  null,
  2,
) + "\n";

const PROJECTS_README = `# Projects

One folder per video. Create one in the mostudio app (Studio) or with \`mostudio new <slug>\`. Your footage is copied into <project>/media/ when a run starts.
`;

const SHORTS_LINKS = `# Shorts I like: one link per line. Add a note after the link with " # ".\n`;

const SHORTS_README = `# Short-form inspiration

- Links: one per line in links.txt, or paste them in the mostudio app (Inspiration).
- Clips and screenshots: put them in the media folder. They stay on this computer and are never used inside your videos.
- Notes: any .md or .txt file next to links.txt (hook ideas, pacing, style).

mostudio keeps these for your reference; it does not read them automatically yet.
`;

const LONG_LINKS = `# Long videos I like: one link per line. Add a note after the link with " # ".\n`;

const LONG_README = `# Long-form inspiration

- Links: one per line in links.txt, or paste them in the mostudio app (Inspiration).
- Clips and screenshots: put them in the media folder. They stay on this computer and are never used inside your videos.
- Notes: any .md or .txt file next to links.txt (hook ideas, pacing, style).

mostudio keeps these for your reference; it does not read them automatically yet.
`;

const GITIGNORE_LINES = [".env.local", "projects/", "inspiration/**/media/"];

async function createFileIfAbsent(
  fullPath: string,
  relPath: string,
  content: string,
  purpose: string,
): Promise<ScaffoldEntry> {
  await mkdir(dirname(fullPath), { recursive: true });
  try {
    await writeFile(fullPath, content, { flag: "wx" });
    return { path: relPath, status: "created", purpose };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: relPath, status: "kept", purpose };
    }
    throw err;
  }
}

async function createDirIfAbsent(
  fullPath: string,
  relPath: string,
  purpose: string,
): Promise<ScaffoldEntry> {
  await mkdir(dirname(fullPath), { recursive: true });
  try {
    await mkdir(fullPath);
    return { path: relPath, status: "created", purpose };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: relPath, status: "kept", purpose };
    }
    throw err;
  }
}

export async function scaffoldWorkspace(dir: string): Promise<ScaffoldEntry[]> {
  await mkdir(dir, { recursive: true });
  const entries: ScaffoldEntry[] = [];

  entries.push(
    await createFileIfAbsent(
      join(dir, "mostudio.config.json"),
      "mostudio.config.json",
      DEFAULT_CONFIG,
      "settings for this workspace",
    ),
  );

  entries.push(
    await createFileIfAbsent(
      join(dir, "projects", "README.md"),
      "projects/README.md",
      PROJECTS_README,
      "your video projects, one folder per video",
    ),
  );

  entries.push(
    await createFileIfAbsent(
      join(dir, "inspiration", "shorts", "links.txt"),
      "inspiration/shorts/links.txt",
      SHORTS_LINKS,
      "vertical references: Reels, Shorts, TikToks",
    ),
  );

  entries.push(
    await createDirIfAbsent(
      join(dir, "inspiration", "shorts", "media"),
      "inspiration/shorts/media/",
      "vertical references: Reels, Shorts, TikToks",
    ),
  );

  entries.push(
    await createFileIfAbsent(
      join(dir, "inspiration", "shorts", "README.md"),
      "inspiration/shorts/README.md",
      SHORTS_README,
      "vertical references: Reels, Shorts, TikToks",
    ),
  );

  entries.push(
    await createFileIfAbsent(
      join(dir, "inspiration", "long", "links.txt"),
      "inspiration/long/links.txt",
      LONG_LINKS,
      "landscape references: YouTube, podcasts",
    ),
  );

  entries.push(
    await createDirIfAbsent(
      join(dir, "inspiration", "long", "media"),
      "inspiration/long/media/",
      "landscape references: YouTube, podcasts",
    ),
  );

  entries.push(
    await createFileIfAbsent(
      join(dir, "inspiration", "long", "README.md"),
      "inspiration/long/README.md",
      LONG_README,
      "landscape references: YouTube, podcasts",
    ),
  );

  if (existsSync(join(dir, ".git"))) {
    const gitignorePath = join(dir, ".gitignore");
    try {
      await writeFile(gitignorePath, GITIGNORE_LINES.join("\n") + "\n", { flag: "wx" });
      entries.push({ path: ".gitignore", status: "created", purpose: "keeps keys and footage out of git" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await readFile(gitignorePath, "utf8");
        const existingLines = new Set(existing.split("\n").map((l) => l.trim()));
        const missing = GITIGNORE_LINES.filter((l) => !existingLines.has(l));
        if (missing.length > 0) {
          const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          await appendFile(gitignorePath, `${sep}${missing.join("\n")}\n`);
        }
        entries.push({ path: ".gitignore", status: "kept", purpose: "keeps keys and footage out of git" });
      } else {
        throw err;
      }
    }
  }

  return entries;
}
