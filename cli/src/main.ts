import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startDashboard } from "../../dashboard/src/server.ts";
import {
  approveStep,
  checkSystem,
  defaultWorkspace,
  createProject,
  createRedactor,
  createRegistry,
  findWorkspace,
  latest,
  loadConfig,
  loadEnvFile,
  loadProvidersFile,
  PACKAGE_ROOT,
  parseWorkflow,
  pendingApprovals,
  readJson,
  readLedger,
  readProjectWorkflow,
  resolveShared,
  runBin,
  scaffoldWorkspace,
  runStep,
  runWorkflow,
  WorkflowMismatchError,
  WorkflowParamError,
  writeAppSettings,
} from "../../core/src/index.ts";
import type { ProviderEntry, StepModule, StepResult, SystemDeps } from "../../core/src/index.ts";
import { defaultSteps } from "../../steps/index.ts";

export type Io = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Resolves user-given relative paths (--project, --brief, file params). */
  cwd: string;
  env: Record<string, string>;
  /** Repo root holding providers.json, mostudio.config.json and .env.local (tests override it). */
  root?: string;
  system?: Partial<SystemDeps>;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
};

/** Repo root: io.root, else MOSTUDIO_ROOT, else nearest ancestor workspace, else package root. */
export function rootOf(io: Io): string {
  if (io.root !== undefined) return io.root;
  if (io.env.MOSTUDIO_ROOT) return io.env.MOSTUDIO_ROOT;
  return findWorkspace(io.cwd) ?? PACKAGE_ROOT;
}

const USAGE = `usage:
  mostudio init [--dir <path>]
  mostudio new <slug> [--brief <file>]
  mostudio step <name> --project <dir> [--param k=v]... [--force] [--json]
  mostudio status --project <dir> [--json]
  mostudio run <workflow> --project <dir> [--param <step>.<key>=<value>]... [--force <step>]... [--switch-workflow] [--auto] [--json]
  mostudio approve <step> --project <dir>
  mostudio ui [--port <n>] [--open]
`;

class UsageError extends Error {}

type Parsed = {
  positional: string[];
  dir?: string;
  project?: string;
  brief?: string;
  params: Record<string, string>;
  force: boolean;
  /** `run` only: steps named by --force <step>. */
  forceSteps: string[];
  json: boolean;
  help: boolean;
  /** `run` only: allow a workflow other than the one the project ran. */
  switchWorkflow: boolean;
  /** `run` only: auto-approve steps waiting for approval. */
  auto: boolean;
  port?: number;
  open: boolean;
};

function parseArgs(args: string[]): Parsed {
  const p: Parsed = { positional: [], params: {}, force: false, forceSteps: [], json: false, help: false, switchWorkflow: false, auto: false, open: false };
  const isRun = args[0] === "run";
  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--dir") p.dir = value(++i, a);
    else if (a === "--project") p.project = value(++i, a);
    else if (a === "--brief") p.brief = value(++i, a);
    else if (a === "--param") {
      const kv = value(++i, a);
      const eq = kv.indexOf("=");
      if (eq < 1) throw new UsageError(`--param expects k=v, got ${JSON.stringify(kv)}`);
      p.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--force") {
      if (isRun) p.forceSteps.push(value(++i, a));
      else p.force = true;
    }
    else if (a === "--port") {
      const v = value(++i, a);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new UsageError(`--port expects a non-negative integer, got ${JSON.stringify(v)}`);
      p.port = n;
    } else if (a === "--open") p.open = true;
    else if (a === "--json") p.json = true;
    else if (a === "--switch-workflow" && isRun) p.switchWorkflow = true;
    else if (a === "--auto" && isRun) p.auto = true;
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
  if (r.status === "fail" && r.error) lines.push(`error: ${r.error}`);
  if (r.status !== "pass") {
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
  const config = await loadConfig(rootOf(io), env);
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
  const mod = Object.hasOwn(steps, name) ? steps[name] : undefined;
  if (!mod) {
    io.stderr(`unknown step: ${name}\navailable steps: ${Object.keys(steps).sort().join(", ") || "(none)"}\n`);
    return 64;
  }
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  const config = await loadConfig(rootOf(io), env);
  const entries = await loadProvidersFile(rootOf(io));
  const providers = createRegistry(entries, env, join(config.home, "quota.json"), config.billing);
  // File params are user paths: resolve them against the caller's cwd.
  const params: Record<string, string> = { ...p.params };
  for (const key of mod.contract.fileParams ?? []) {
    const v = params[key];
    if (v !== undefined && v !== "") params[key] = resolve(io.cwd, v);
  }
  const result = await runStep(projectDir, mod, {
    params,
    force: p.force,
    config,
    providers,
    env,
    log: (msg) => io.stderr(`[${name}] ${msg}\n`),
  });
  io.stdout(`${p.json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
  return result.status === "fail" ? 2 : 0;
}

const REVIEW_HINTS: Record<string, string> = {
  captions: "review captions/captions.txt, add fixes to edits/replacements.txt, re-run the same command",
};

async function listWorkflows(root: string): Promise<string[]> {
  const files = await readdir(resolveShared(root, "workflows")).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

async function cmdRun(
  p: Parsed,
  io: Io,
  env: Record<string, string>,
  steps: Record<string, StepModule>,
): Promise<number> {
  const name = p.positional[1];
  if (!name || p.positional.length > 2) throw new UsageError("run needs exactly one <workflow>");
  const root = rootOf(io);
  const known = await listWorkflows(root);
  if (!known.includes(name)) {
    io.stderr(`unknown workflow: ${name}\navailable workflows: ${known.join(", ") || "(none)"}\n`);
    return 64;
  }
  let wf;
  try {
    wf = parseWorkflow(await readJson<unknown>(join(resolveShared(root, "workflows"), `${name}.json`)), Object.keys(steps));
  } catch (err) {
    io.stderr(`invalid workflow ${name}: ${(err as Error).message}\n`);
    return 64;
  }
  const inWf = new Set(wf.steps.map((s) => s.step));
  const params: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(p.params)) {
    const dot = k.indexOf(".");
    const step = dot < 1 ? "" : k.slice(0, dot);
    const key = k.slice(dot + 1);
    if (!step || !key) throw new UsageError(`--param for run expects <step>.<key>=<value>, got ${JSON.stringify(`${k}=${v}`)}`);
    if (!inWf.has(step)) throw new UsageError(`--param ${k}: step "${step}" is not in workflow ${name}`);
    // File params are user paths: resolve them against the caller's cwd.
    const isFile = steps[step]?.contract.fileParams?.includes(key) && v !== "";
    (params[step] ??= {})[key] = isFile ? resolve(io.cwd, v) : v;
  }
  for (const f of p.forceSteps) {
    if (!inWf.has(f)) throw new UsageError(`--force ${f}: step is not in workflow ${name}`);
  }
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  const config = await loadConfig(root, env);
  const providers = createRegistry(await loadProvidersFile(root), env, join(config.home, "quota.json"), config.billing);
  const result = await runWorkflow(projectDir, wf, steps, {
    params,
    force: p.forceSteps,
    switchWorkflow: p.switchWorkflow,
    autoApprove: p.auto,
    config,
    providers,
    env,
    log: (msg) => io.stderr(`${msg}\n`),
    onStep: (r) => {
      if (!p.json) io.stdout(`${formatResult(r)}\n`);
    },
    onApprove: (step, auto) => {
      if (auto) io.stderr(`auto-approved ${step}\n`);
    },
  });
  if (p.json) {
    io.stdout(`${JSON.stringify({ status: result.status, stoppedAt: result.stoppedAt, results: result.results }, null, 2)}\n`);
  } else if (result.status === "done") {
    io.stdout(`${name}: done\n`);
  } else if (result.status === "failed") {
    io.stdout(`${name}: failed at ${result.stoppedAt}\n`);
  } else {
    const step = result.stoppedAt as string;
    const hint = REVIEW_HINTS[step] ?? `review the outputs of ${step}`;
    io.stdout(`${name}: awaiting approval at ${step}\n${hint}, then: mostudio approve ${step} --project ${projectDir}\n`);
  }
  return result.status === "done" ? 0 : result.status === "failed" ? 2 : 3;
}

async function cmdApprove(p: Parsed, io: Io): Promise<number> {
  const step = p.positional[1];
  if (!step || p.positional.length > 2) throw new UsageError("approve needs exactly one <step>");
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  await approveStep(projectDir, step);
  io.stdout(`approved ${step}\n`);
  return 0;
}

/** Approval steps of the project's workflow (steps/workflow.json) still waiting for `mostudio approve`. */
async function awaitingApproval(projectDir: string, root: string, steps: Record<string, StepModule>): Promise<Set<string>> {
  const name = await readProjectWorkflow(projectDir);
  if (!name) return new Set();
  try {
    const wf = parseWorkflow(await readJson<unknown>(join(resolveShared(root, "workflows"), `${name}.json`)), Object.keys(steps));
    return new Set(await pendingApprovals(projectDir, wf));
  } catch {
    return new Set(); // workflow file gone or invalid: status still lists results
  }
}

async function cmdStatus(p: Parsed, io: Io, steps: Record<string, StepModule>): Promise<number> {
  const projectDir = await projectDirOf(p, io);
  await assertProjectDir(projectDir);
  const ledger = await readLedger(projectDir);
  const names = Object.keys(ledger.steps).sort();
  const waiting = await awaitingApproval(projectDir, rootOf(io), steps);
  const results: Record<string, StepResult & { awaitingApproval?: true }> = {};
  for (const n of names) {
    const r = latest(ledger, n);
    if (r) results[n] = waiting.has(n) ? { ...r, awaitingApproval: true } : r;
  }
  if (p.json) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
  else if (Object.keys(results).length === 0) io.stdout("no steps yet\n");
  else {
    const lines = Object.values(results).map((r) => {
      const [head, ...rest] = formatResult(r).split("\n");
      return [`${head}${r.awaitingApproval ? `  awaiting approval (mostudio approve ${r.step} --project ${projectDir})` : ""}`, ...rest].join("\n");
    });
    io.stdout(`${lines.join("\n")}\n`);
  }
  return 0;
}

async function cmdInit(p: Parsed, io: Io, env: Record<string, string>): Promise<number> {
  if (p.positional.length > 1) throw new UsageError("init takes no positional arguments");
  const dir = p.dir ? resolve(io.cwd, p.dir) : defaultWorkspace();
  const entries = await scaffoldWorkspace(dir);
  for (const entry of entries) {
    if (entry.status === "created") {
      io.stdout(`  + ${entry.path.padEnd(24)} ${entry.purpose}\n`);
    } else {
      io.stdout(`  = ${entry.path} (kept)\n`);
    }
  }
  const checks = await checkSystem(env, io.system);
  for (const check of checks) {
    if (check.ok) {
      io.stdout(`  ✓ ${check.label}\n`);
    } else {
      io.stdout(`  ✗ ${check.label}: ${check.detail}\n`);
      if (check.fix) {
        io.stdout(`      fix: ${check.fix}\n`);
      }
    }
  }
  const home = io.env.MOSTUDIO_HOME ?? join(homedir(), ".mostudio");
  await writeAppSettings(home, { workspace: dir });
  io.stdout("\nNext: mostudio ui\n");
  return 0;
}


async function cmdUi(
  p: Parsed,
  io: Io,
  env: Record<string, string>,
  steps: Record<string, StepModule>,
): Promise<number> {
  if (p.positional.length > 1) throw new UsageError(`${p.positional[0]} takes no positional arguments`);
  const root = io.root ?? io.env.MOSTUDIO_ROOT ?? findWorkspace(io.cwd);
  const packaged = env.MOSTUDIO_PACKAGED === "1";
  let d;
  try {
    d = await startDashboard({
      home: io.env.MOSTUDIO_HOME,
      root,
      port: p.port,
      steps,
      processEnv: env,
      packaged,
    });
  } catch (err) {
    if (p.port !== undefined && ((err as NodeJS.ErrnoException).code === "EADDRINUSE" || (err as Error).message?.includes("EADDRINUSE"))) {
      io.stderr(`Port ${p.port} is busy. Start without --port to pick a free one.\n`);
      return 1;
    }
    throw err;
  }

  io.stdout(
    `mostudio is running at http://127.0.0.1:${d.port}\nKeep this window open while you work. Close it (or press Ctrl+C) to stop.\n`,
  );

  const link = `${d.url}/?t=${d.token}`;
  if (p.open) {
    const openUrl = io.openUrl ?? (async (u: string) => { await runBin("open", [u]); });
    await openUrl(link);
  } else {
    io.stdout(`Open this link: ${link}\n`);
  }

  await new Promise<void>((resolve) => {
    if (io.signal?.aborted) return resolve();
    io.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  await d.close();
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
    if (command !== "init" && command !== "new" && command !== "step" && command !== "status" && command !== "run" && command !== "approve" && command !== "ui" && command !== "dashboard") {
      io.stderr(command ? `unknown command: ${command}\n${USAGE}` : USAGE);
      return 64;
    }
    fileEnv = loadEnvFile(join(rootOf(io), ".env.local"));
    const env = { ...fileEnv, ...io.env };
    if (command === "init") return await cmdInit(p, io, env);
    if (command === "new") return await cmdNew(p, io, env);
    if (command === "step") return await cmdStep(p, io, env, steps);
    if (command === "run") return await cmdRun(p, io, env, steps);
    if (command === "approve") return await cmdApprove(p, io);
    if (command === "ui" || command === "dashboard") return await cmdUi(p, io, env, steps);
    return await cmdStatus(p, io, steps);
  } catch (err) {
    if (err instanceof WorkflowMismatchError) {
      io.stderr(`${err.message}\n`);
      return 64;
    }
    if (err instanceof UsageError || err instanceof WorkflowParamError) {
      io.stderr(`${err.message}\n${USAGE}`);
      return 64;
    }
    const redactor = createRedactor([process.env, fileEnv, io.env]);
    io.stderr(`error: ${redactor.redact(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }
}
