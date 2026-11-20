import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { DashboardContext } from "../context.ts";
import { requireRoot } from "../context.ts";
import { insideDir } from "../files.ts";
import { HttpError, type Router, readJsonBody, sendJson } from "../http.ts";

export function registerFinderRoutes(router: Router, ctx: DashboardContext): void {
  router.add("POST", "/api/show-in-finder", async (req, res) => {
    const root = requireRoot(ctx);
    const body = await readJsonBody<{ path?: unknown }>(req);
    if (!body || typeof body.path !== "string" || !body.path) {
      throw new HttpError(400, "path is required");
    }
    const targetPath = body.path;
    if (!isAbsolute(targetPath)) {
      throw new HttpError(400, "path must be absolute");
    }

    const rel = relative(root, targetPath);
    const resolved = await insideDir(root, rel);

    let isFile = false;
    try {
      const st = await stat(resolved);
      isFile = st.isFile();
    } catch {}

    await ctx.openPath(resolved, isFile);
    sendJson(res, 200, { ok: true });
  });
}
