import { join } from "node:path";
import {
  createRegistry,
  loadConfig,
  loadLayeredEnv,
  loadProvidersFile,
  type Config,
  type ProviderRegistry,
  type StepModule,
} from "../../core/src/index.ts";
import { HttpError } from "./http.ts";
import type { JobManager } from "./jobs.ts";

export type DashboardContext = {
  home: string;
  root: string | undefined;
  port: number;
  token: string;
  packaged: boolean;
  version: string;
  steps: Record<string, StepModule>;
  processEnv: Record<string, string>;
  fetch: typeof fetch;
  openPath: (p: string, reveal: boolean) => Promise<void>;
  jobs: JobManager;
};

/** Returns ctx.root or throws HttpError 409 "setup needed". */
export function requireRoot(ctx: DashboardContext): string {
  if (!ctx.root) {
    throw new HttpError(409, "setup needed");
  }
  return ctx.root;
}

/** Loads config, layered env, and providers registry for ctx.root. */
export async function runtime(ctx: DashboardContext): Promise<{
  root: string;
  config: Config;
  env: Record<string, string>;
  sources: Record<string, "app" | "workspace" | "process">;
  providers: ProviderRegistry;
}> {
  const root = requireRoot(ctx);
  const { env, sources } = loadLayeredEnv({
    home: ctx.home,
    root,
    processEnv: ctx.processEnv,
  });
  const config = await loadConfig(root, env);
  const providers = createRegistry(
    await loadProvidersFile(root),
    env,
    join(config.home, "quota.json"),
    config.billing,
  );
  return { root, config, env, sources, providers };
}
