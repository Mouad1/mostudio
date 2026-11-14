import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { loadConfig, writeOutputAtomic } from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { requireRoot } from "../context.ts";
import { insideDir, safeFileName, saveStream, uniquePath } from "../files.ts";
import { HttpError, type Router, readJsonBody, sendJson } from "../http.ts";
import {
  addLink,
  classifyLink,
  listLinks,
  platformOf,
  removeLink,
  routeInspirationFile,
} from "../inspiration.ts";
import type {
  InspirationFile,
  InspirationKind,
  InspirationShelf,
} from "../types.ts";

async function readShelf(
  inspirationRoot: string,
  kind: InspirationKind,
): Promise<InspirationShelf> {
  const kindDir = join(inspirationRoot, kind);
  const linksPath = join(kindDir, "links.txt");
  let links: InspirationShelf["links"] = [];
  try {
    const text = await readFile(linksPath, "utf8");
    links = listLinks(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const files: InspirationFile[] = [];

  // 1. Root notes in kindDir: .md, .txt, except links.txt
  try {
    const entries = await readdir(kindDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (name.toLowerCase() === "links.txt") continue;
        const ext = extname(name).toLowerCase();
        if (ext === ".md" || ext === ".txt") {
          const filePath = join(kindDir, name);
          const st = await stat(filePath);
          files.push({
            name,
            path: relative(inspirationRoot, filePath),
            sizeBytes: st.size,
            kind: "note",
          });
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  // 2. Media files in kindDir/media
  const mediaDir = join(kindDir, "media");
  try {
    const entries = await readdir(mediaDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const name = entry.name;
        if (name.startsWith(".")) continue;
        const filePath = join(mediaDir, name);
        const st = await stat(filePath);
        files.push({
          name,
          path: relative(inspirationRoot, filePath),
          sizeBytes: st.size,
          kind: "media",
        });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind,
    folder: kindDir,
    links,
    files,
  };
}

export function registerInspirationRoutes(router: Router, ctx: DashboardContext): void {
  // GET /api/inspiration -> { shelves: InspirationShelf[] }
  router.add("GET", "/api/inspiration", async (_req, res) => {
    const root = requireRoot(ctx);
    const config = await loadConfig(root, ctx.processEnv);
    const inspirationRoot = config.inspirationRoot;

    const shelves: InspirationShelf[] = [
      await readShelf(inspirationRoot, "shorts"),
      await readShelf(inspirationRoot, "long"),
    ];

    sendJson(res, 200, { shelves });
  });

  // POST /api/inspiration/links -> { kind, link }
  router.add("POST", "/api/inspiration/links", async (req, res) => {
    const root = requireRoot(ctx);
    const config = await loadConfig(root, ctx.processEnv);
    const inspirationRoot = config.inspirationRoot;

    const body = await readJsonBody<{ url?: unknown; note?: unknown; kind?: unknown }>(req);
    if (!body || typeof body.url !== "string" || !body.url) {
      throw new HttpError(400, "url is required");
    }
    const rawUrl = body.url.trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      throw new HttpError(400, "Only web links (http or https) can be added");
    }

    let kind: InspirationKind;
    if (body.kind !== undefined) {
      if (body.kind !== "shorts" && body.kind !== "long") {
        throw new HttpError(400, "invalid kind");
      }
      kind = body.kind;
    } else {
      kind = classifyLink(rawUrl);
    }

    const note = typeof body.note === "string" ? body.note.trim() || undefined : undefined;

    const kindDir = join(inspirationRoot, kind);
    const linksFile = join(kindDir, "links.txt");

    let existing = "";
    try {
      existing = await readFile(linksFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    const updated = addLink(existing, rawUrl, note);
    await mkdir(kindDir, { recursive: true });
    await writeOutputAtomic(linksFile, async (tmp) => {
      await writeFile(tmp, updated, "utf8");
    });

    sendJson(res, 200, {
      kind,
      link: {
        url: rawUrl,
        note,
        platform: platformOf(rawUrl),
      },
    });
  });

  // DELETE /api/inspiration/links -> { ok: true }
  router.add("DELETE", "/api/inspiration/links", async (req, res) => {
    const root = requireRoot(ctx);
    const config = await loadConfig(root, ctx.processEnv);
    const inspirationRoot = config.inspirationRoot;

    const body = await readJsonBody<{ url?: unknown; kind?: unknown }>(req);
    if (!body || typeof body.url !== "string" || (body.kind !== "shorts" && body.kind !== "long")) {
      throw new HttpError(400, "url and valid kind are required");
    }

    const linksFile = join(inspirationRoot, body.kind, "links.txt");
    let existing = "";
    try {
      existing = await readFile(linksFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(res, 200, { ok: true });
        return;
      }
      throw err;
    }

    const updated = removeLink(existing, body.url.trim());
    await writeOutputAtomic(linksFile, async (tmp) => {
      await writeFile(tmp, updated, "utf8");
    });

    sendJson(res, 200, { ok: true });
  });

  // PUT /api/inspiration/:kind/files?name= -> InspirationFile
  router.add("PUT", "/api/inspiration/:kind/files", async (req, res, params, url) => {
    const root = requireRoot(ctx);
    const config = await loadConfig(root, ctx.processEnv);
    const inspirationRoot = config.inspirationRoot;

    const kind = params.kind;
    if (kind !== "shorts" && kind !== "long") {
      throw new HttpError(400, "invalid kind");
    }

    const rawName = url.searchParams.get("name") || "";
    const name = safeFileName(rawName);

    const rel = routeInspirationFile(kind, name);
    const targetDir = join(inspirationRoot, dirname(rel));
    await mkdir(targetDir, { recursive: true });

    const finalPath = await uniquePath(targetDir, basename(rel));
    const sizeBytes = await saveStream(req, finalPath);

    const isMedia = rel.startsWith(`${kind}/media/`);
    const result: InspirationFile = {
      name: basename(finalPath),
      path: relative(inspirationRoot, finalPath),
      sizeBytes,
      kind: isMedia ? "media" : "note",
    };

    sendJson(res, 200, result);
  });

  // DELETE /api/inspiration/files -> { ok: true }
  router.add("DELETE", "/api/inspiration/files", async (req, res) => {
    const root = requireRoot(ctx);
    const config = await loadConfig(root, ctx.processEnv);
    const inspirationRoot = config.inspirationRoot;

    const body = await readJsonBody<{ path?: unknown }>(req);
    if (!body || typeof body.path !== "string" || !body.path) {
      throw new HttpError(400, "path is required");
    }

    try {
      const abs = await insideDir(inspirationRoot, body.path);
      await unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "file not found");
      }
      throw err;
    }

    sendJson(res, 200, { ok: true });
  });
}
