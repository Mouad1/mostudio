import { join } from "node:path";
import {
  loadEnvFile,
  loadLayeredEnv,
  loadProvidersFile,
  PACKAGE_ROOT,
  readAppSettings,
  writeAppSettings,
  type ProviderEntry,
} from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { HttpError, type Router, readJsonBody, sendJson } from "../http.ts";
import { probeProvider } from "../probes.ts";
import { readSettings, settingsSchema, writeSettings } from "../settings.ts";

export async function getEntries(ctx: DashboardContext): Promise<ProviderEntry[]> {
  return loadProvidersFile(ctx.root ?? PACKAGE_ROOT);
}

export function registerSettingsRoutes(
  router: Router,
  ctx: DashboardContext,
  options?: { entries?: ProviderEntry[] | (() => Promise<ProviderEntry[]>) },
): void {
  async function resolveEntries(): Promise<ProviderEntry[]> {
    if (options?.entries) {
      if (typeof options.entries === "function") {
        return options.entries();
      }
      return options.entries;
    }
    return getEntries(ctx);
  }

  // GET /api/settings
  router.add("GET", "/api/settings", async (_req, res) => {
    const entries = await resolveEntries();
    const fields = readSettings({
      home: ctx.home,
      root: ctx.root,
      processEnv: ctx.processEnv,
      entries,
    });
    const appSettings = await readAppSettings(ctx.home);
    sendJson(res, 200, {
      keysFile: join(ctx.home, ".env"),
      fields,
      animatedCaptions: Boolean(appSettings.animatedCaptions),
    });
  });

  // PUT /api/settings
  router.add("PUT", "/api/settings", async (req, res) => {
    const body = await readJsonBody<{
      values?: Record<string, string>;
      animatedCaptions?: boolean;
    }>(req);
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "invalid body");
    }

    const entries = await resolveEntries();
    const schemaNames = new Set(settingsSchema(entries).map((f) => f.name));

    if (body.values !== undefined) {
      if (typeof body.values !== "object" || body.values === null) {
        throw new HttpError(400, "values must be an object");
      }
      for (const key of Object.keys(body.values)) {
        if (!schemaNames.has(key)) {
          throw new HttpError(400, `unknown setting: ${key}`);
        }
      }
      await writeSettings(ctx.home, body.values, entries);
    }

    if (body.animatedCaptions !== undefined) {
      await writeAppSettings(ctx.home, {
        animatedCaptions: Boolean(body.animatedCaptions),
      });
    }

    const fields = readSettings({
      home: ctx.home,
      root: ctx.root,
      processEnv: ctx.processEnv,
      entries,
    });
    const appSettings = await readAppSettings(ctx.home);

    sendJson(res, 200, {
      keysFile: join(ctx.home, ".env"),
      fields,
      animatedCaptions: Boolean(appSettings.animatedCaptions),
    });
  });

  // POST /api/settings/reveal
  router.add("POST", "/api/settings/reveal", async (req, res) => {
    const body = await readJsonBody<{ name?: string }>(req);
    if (!body || typeof body.name !== "string" || !body.name) {
      throw new HttpError(400, "name is required");
    }

    const entries = await resolveEntries();
    const fields = readSettings({
      home: ctx.home,
      root: ctx.root,
      processEnv: ctx.processEnv,
      entries,
    });

    const field = fields.find((f) => f.name === body.name);
    if (!field || field.source !== "app") {
      throw new HttpError(403, "This key is managed outside mostudio");
    }

    const appEnv = loadEnvFile(join(ctx.home, ".env"));
    const rawVal = appEnv[body.name] ?? "";
    sendJson(res, 200, { value: rawVal });
  });

  // POST /api/settings/test
  router.add("POST", "/api/settings/test", async (req, res) => {
    const body = await readJsonBody<{
      provider?: string;
      values?: Record<string, string>;
    }>(req);
    if (!body || typeof body.provider !== "string" || !body.provider) {
      throw new HttpError(400, "provider is required");
    }

    const entries = await resolveEntries();
    const entry = entries.find((e) => e.id === body.provider);
    if (!entry) {
      throw new HttpError(404, `unknown provider: ${body.provider}`);
    }

    const schema = settingsSchema(entries);
    const allowedOverrides = new Set(
      schema
        .filter((f) => f.kind === "secret" || f.kind === "text")
        .map((f) => f.name),
    );

    const { env: baseEnv } = loadLayeredEnv({
      home: ctx.home,
      root: ctx.root,
      processEnv: ctx.processEnv,
    });

    const mergedEnv: Record<string, string> = { ...baseEnv };
    if (body.values && typeof body.values === "object") {
      for (const [k, v] of Object.entries(body.values)) {
        if (allowedOverrides.has(k) && typeof v === "string") {
          mergedEnv[k] = v;
        }
      }
    }

    const result = await probeProvider(entry, mergedEnv, { fetch: ctx.fetch });
    sendJson(res, 200, result);
  });
}
