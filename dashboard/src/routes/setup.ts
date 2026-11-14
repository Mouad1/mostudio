import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  checkSystem,
  defaultWorkspace,
  loadLayeredEnv,
  readAppSettings,
  scaffoldWorkspace,
  writeAppSettings,
} from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { HttpError, type Router, readJsonBody, sendJson } from "../http.ts";
import type { SetupState } from "../types.ts";

export async function buildSetupState(ctx: DashboardContext): Promise<SetupState> {
  const { env } = loadLayeredEnv({
    home: ctx.home,
    root: ctx.root,
    processEnv: ctx.processEnv,
  });
  const checks = await checkSystem(env);
  const hasAiKey =
    Boolean(env.GROQ_API_KEY?.trim()) ||
    Boolean(env.CLOUDFLARE_API_TOKEN?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim()) ||
    Boolean(checks.find((c) => c.name === "whisper")?.ok);

  return {
    needsSetup: !ctx.root,
    workspace: ctx.root ?? null,
    suggestedWorkspace: defaultWorkspace(),
    checks,
    hasAiKey,
    packaged: ctx.packaged,
    version: ctx.version,
  };
}

export function registerSetupRoutes(router: Router, ctx: DashboardContext): void {
  // GET /api/setup
  router.add("GET", "/api/setup", async (_req, res) => {
    const state = await buildSetupState(ctx);
    sendJson(res, 200, state);
  });

  // POST /api/setup/workspace
  router.add("POST", "/api/setup/workspace", async (req, res) => {
    const body = await readJsonBody<{ path?: unknown }>(req);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      throw new HttpError(400, "Choose a full folder path, like /Users/you/Movies/mostudio");
    }

    let expanded = body.path.trim();
    if (expanded === "~") {
      expanded = homedir();
    } else if (expanded.startsWith("~/")) {
      expanded = join(homedir(), expanded.slice(2));
    } else if (expanded.startsWith("~")) {
      expanded = join(homedir(), expanded.slice(1));
    }

    if (!isAbsolute(expanded)) {
      throw new HttpError(400, "Choose a full folder path, like /Users/you/Movies/mostudio");
    }
    if (!existsSync(dirname(expanded))) {
      throw new HttpError(400, "That folder's parent doesn't exist");
    }

    const entries = await scaffoldWorkspace(expanded);
    const existing = await readAppSettings(ctx.home);
    await writeAppSettings(ctx.home, { ...existing, workspace: expanded });
    ctx.root = expanded;

    const state = await buildSetupState(ctx);
    sendJson(res, 200, { entries, state });
  });
}
