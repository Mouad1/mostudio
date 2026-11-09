import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createProject,
  createRedactor,
  createRegistry,
  latest,
  loadConfig,
  loadEnvFile,
  readJson,
  readLedger,
  runStep,
} from "../../core/src/index.ts";
import type { ProviderEntry, StepModule, StepResult } from "../../core/src/index.ts";
import { defaultSteps } from "../../steps/index.ts";

export type Io = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  env: Record<string, string>;
};

const USAGE = `usage:
  mostudio new <slug> [--brief <file>]
  mostudio step <name> --project <dir> [--param k=v]... [--force] [--json]
  mostudio status --project <dir> [--json]
`;

class UsageError extends Error {}

type Parsed = {
  positional: string[];
  project?: string;
  brief?: string;
  params: Record<string, string>;
  force: boolean;
  json: boolean;
  help: boolean;
};

function parseArgs(args: string[]): Parsed {
  const p: Parsed = { positional: [], params: {}, force: false, json: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--project") p.project = value(++i, a);
    else if (a === "--brief") p.brief = value(++i, a);
    else if (a === "--param") {
      const kv = value(++i, a);
      const eq = kv.indexOf("=");
      if (eq < 1) throw new UsageError(`--param expects k=v, got ${JSON.stringify(kv)}`);
      p.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--force") p.force = true;
    else if (a === "--json") p.json = true;
    else if (a === "--help" || a === "-h") p.help = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown option: ${a}`);
    else p.positional.push(a);
  }
  return p;
}

function formatResult(r: StepResult & { cached?: boolean }): string {
  const metrics = Object.keys(r.metrics)
    .sort()
    .map((k) => `${k}=${String(r.metrics[k])}`);
  let line = [`${r.step}  ${r.status}  ${(r.durationMs / 1000).toFixed(1)}s`, ...metrics.length ? [metrics.join(" ")] : []].join("  ");
  if (r.cached) line += "  (cached)";
  const lines = [line];
  if (r.status === "fail") {
    if (r.error) lines.push(`error: ${r.error}`);
    for (const v of r.verdicts) {
      if (v.ok) continue;
      const t = v.threshold;
      const value = Array.isArray(t.value) ? t.value.join("..") : String(t.value);
      lines.push(`  ✗ ${v.metric} ${t.op} ${value} (actual ${String(v.actual)})`);
    }
  }
  return lines.join("\n");
}

async function cmdNew(p: Parsed, io: Io, env: Record<string, string>): Promise<number> {
  const slug = p.positional[1];
  if (!slug || p.positional.length > 2) throw new UsageError("new needs exactly one <slug>");
  const config = await loadConfig(io.cwd, env);
  const brief = p.brief ? await readFile(resolve(io.cwd, p.brief), "utf8") : undefined;
  await mkdir(config.projectsRoot, { recursive: true });
  const dir = await createProject(config.projectsRoot, slug, brief === undefined ? {} : { brief });
  io.stdout(`${dir}\n`);
  return 0;
}

async function projectDirOf(p: Parsed, io: Io): Promise<string> {
  if (!p.project) throw new UsageError("--project <dir> is required");
  return resolve(io.cwd, p.project);
}

async function assertProjectDir(dir: string): Promise<void> {
  const ok = await stat(dir).then((s) => s.isDirectory(), () => false);
  if (!ok) throw new Error(`project folder not found: ${dir}`);
}

async function cmdStep(
  p: Parsed,
  io: Io,
  env: Record<string, string>,
  steps: Record<string, StepModule>,
): Promise<number> {
  const name = p.positional[1];
  if (!name || p.positional.length > 2) throw new UsageError("step needs exactly one <name>");
  const mod = steps[name];
  if (!mod) {
    io.stderr(`unknown step: ${name}\navailable steps: ${Object.keys(steps).sort().join(", ") || "(none)"}\n`);
    return 64;
  }
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  const config = await loadConfig(io.cwd, env);
  const entries = (await readJson<ProviderEntry[]>(join(io.cwd, "providers.json"))) ?? [];
  const providers = createRegistry(entries, env, join(config.home, "quota.json"), config.billing);
  const result = await runStep(projectDir, mod, {
    params: p.params,
    force: p.force,
    config,
    providers,
    env,
    log: (msg) => io.stderr(`[${name}] ${msg}\n`),
  });
  io.stdout(`${p.json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
  return result.status === "fail" ? 2 : 0;
}

async function cmdStatus(p: Parsed, io: Io): Promise<number> {
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  const ledger = await readLedger(projectDir);
  const names = Object.keys(ledger.steps).sort();
  const results: Record<string, StepResult> = {};
  for (const n of names) {
    const r = latest(ledger, n);
    if (r) results[n] = r;
  }
  if (p.json) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
  else if (Object.keys(results).length === 0) io.stdout("no steps yet\n");
  else io.stdout(`${Object.values(results).map(formatResult).join("\n")}\n`);
  return 0;
}

export async function main(
  argv: string[],
  io: Io,
  steps: Record<string, StepModule> = defaultSteps,
): Promise<number> {
  let fileEnv: Record<string, string> = {};
  try {
    const p = parseArgs(argv);
    if (p.help) {
      io.stdout(USAGE);
      return 0;
    }
    const command = p.positional[0];
    if (command !== "new" && command !== "step" && command !== "status") {
      io.stderr(command ? `unknown command: ${command}\n${USAGE}` : USAGE);
      return 64;
    }
    fileEnv = loadEnvFile(join(io.cwd, ".env.local"));
    const env = { ...fileEnv, ...io.env };
    if (command === "new") return await cmdNew(p, io, env);
    if (command === "step") return await cmdStep(p, io, env, steps);
    return await cmdStatus(p, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${err.message}\n${USAGE}`);
      return 64;
    }
    const redactor = createRedactor([process.env, fileEnv, io.env]);
    io.stderr(`error: ${redactor.redact(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }
}
