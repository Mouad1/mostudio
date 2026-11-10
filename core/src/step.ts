import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { writeJsonAtomic } from "./fs/atomic.ts";
import { evaluateGate, mergeThresholds } from "./gate.ts";
import { hashFiles } from "./hash.ts";
import type { HashInput } from "./hash.ts";
import { readLedger, recordStep } from "./ledger.ts";
import { createRedactor, publicEnv } from "./redact.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { Metrics, StepResult, Threshold } from "./types.ts";

export type ParamType = "string" | "number" | "boolean" | "string?" | "number?" | "boolean?";

export type StepContract = {
  name: string;
  /** Paths relative to the project folder; a glob is allowed only as `<dir>/*`. */
  inputs: string[];
  outputs: string[];
  /** A trailing `?` marks the param optional: absent -> omitted from ctx.params. */
  params?: Record<string, ParamType>;
  /** Names of params holding absolute file paths; the files' bytes join the input hash. */
  fileParams?: string[];
  gate: Threshold[];
  private?: boolean;
  /** Bump when the step's behaviour changes so cached results are invalidated. Default "0". */
  version?: string;
};

export type StepContext = {
  projectDir: string;
  params: Record<string, unknown>;
  config: Config;
  providers: ProviderRegistry;
  log: (msg: string) => void;
  /** Non-secret environment (process env merged with .env.local); keys come only via providers.pick. */
  env: Record<string, string | undefined>;
};

export type StepOutput = {
  metrics: Metrics;
  artifacts: string[];
  provider?: { id: string; model: string };
  quota?: Record<string, number>;
};

export type StepModule = {
  contract: StepContract;
  run: (ctx: StepContext) => Promise<StepOutput>;
};

export type RunStepOptions = {
  params?: Record<string, unknown>;
  gateOverrides?: Threshold[];
  force?: boolean;
  config: Config;
  providers: ProviderRegistry;
  log?: (msg: string) => void;
  /** Merged env (process env + .env.local). Scanned for secrets to redact; its non-secret part becomes ctx.env. Defaults to process.env. */
  env?: Record<string, string | undefined>;
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Coerce CLI strings to declared number/boolean, then check types and undeclared extras. */
function resolveParams(
  declared: Record<string, ParamType>,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const extras = Object.keys(given).filter((k) => !(k in declared));
  if (extras.length) throw new Error(`undeclared params: ${extras.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const [key, declaredType] of Object.entries(declared)) {
    const optional = declaredType.endsWith("?");
    const type = optional ? declaredType.slice(0, -1) : declaredType;
    let value = given[key];
    if (value === undefined) {
      if (optional) continue;
      throw new Error(`missing param: ${key}`);
    }
    if (type === "number" && typeof value === "string") {
      const num = value.trim() === "" ? Number.NaN : Number(value);
      if (Number.isNaN(num)) throw new Error(`param ${key} must be a number`);
      value = num;
    } else if (type === "boolean" && typeof value === "string") {
      if (value !== "true" && value !== "false") throw new Error(`param ${key} must be true or false`);
      value = value === "true";
    }
    if (typeof value !== type || (type === "number" && Number.isNaN(value))) {
      throw new Error(`param ${key} must be a ${type}`);
    }
    out[key] = value;
  }
  return out;
}

const OPS = new Set(["<", "<=", ">", ">=", "==", "between"]);

/** Throw a clear error for anything that is not a well-formed list of thresholds. */
function checkOverrides(overrides: unknown): Threshold[] {
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides)) throw new Error("gateOverrides must be an array of thresholds");
  overrides.forEach((t, i) => {
    const o = t as Partial<Threshold> | null;
    if (
      typeof o !== "object" ||
      o === null ||
      typeof o.metric !== "string" ||
      !OPS.has(String(o.op)) ||
      (o.level !== "warn" && o.level !== "fail") ||
      o.value === undefined
    ) {
      throw new Error(`gateOverrides[${i}] is not a valid threshold (needs metric, op, value, level)`);
    }
  });
  return overrides as Threshold[];
}

/** Expand declared inputs to absolute file paths. Only a trailing `*` segment is supported. */
async function expandInputs(projectDir: string, inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    if (!input.includes("*")) {
      const abs = resolve(projectDir, input);
      if (!(await isFile(abs))) throw new Error(`missing input: ${input}`);
      files.push(abs);
      continue;
    }
    const segments = input.split("/");
    const last = segments.pop();
    if (last !== "*" || segments.length === 0 || segments.some((s) => s.includes("*"))) {
      throw new Error(`unsupported input pattern: ${input}`);
    }
    const dirRel = segments.join("/");
    let names: string[] = [];
    try {
      names = (await readdir(resolve(projectDir, dirRel), { withFileTypes: true }))
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      // unreadable or absent folder: empty expansion
    }
    if (names.length === 0) throw new Error(`missing input: ${input}`);
    for (const name of names) files.push(resolve(projectDir, dirRel, name));
  }
  return files;
}

async function outputsExist(projectDir: string, outputs: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const out of outputs) if (!(await isFile(resolve(projectDir, out)))) missing.push(out);
  return missing;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Validate, cache-check by input hash, run, gate, and record a single step. */
export async function runStep(
  projectDir: string,
  mod: StepModule,
  opts: RunStepOptions,
): Promise<StepResult & { cached: boolean }> {
  const { contract } = mod;
  let startedAt = new Date();
  const redactor = createRedactor([process.env, opts.env]);
  let lastPicked: { id: string; model: string } | undefined;
  const message = (err: unknown): string =>
    redactor.redact(err instanceof Error ? err.message : String(err));
  const cleanMetrics = (m: Metrics): Metrics =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "string" ? redactor.redact(v) : v]));
  const record = async (r: StepResult): Promise<void> => {
    await mkdir(join(projectDir, "steps"), { recursive: true });
    await recordStep(projectDir, r);
  };
  // Present while mod.run is in flight; a leftover marker means the last run crashed.
  const marker = join(projectDir, "steps", `${contract.name}.running`);
  const providers: ProviderRegistry = {
    ...opts.providers,
    pick: async (capability, o) => {
      const entry = await opts.providers.pick(capability, {
        ...o,
        private: Boolean(o?.private || contract.private),
      });
      if (entry.key) redactor.add(entry.key.reveal());
      lastPicked = { id: entry.id, model: entry.model };
      return entry;
    },
    recordUse: (...a: Parameters<ProviderRegistry["recordUse"]>) => opts.providers.recordUse(...a),
    markExhausted: (...a: Parameters<ProviderRegistry["markExhausted"]>) =>
      opts.providers.markExhausted(...a),
  };
  const withProvider = (p: { id: string; model: string } | undefined) =>
    p ? { provider: { id: p.id, model: p.model } } : {};
  const result = (
    partial: Pick<StepResult, "status" | "inputsHash"> & Partial<StepResult>,
  ): StepResult => {
    const endedAt = new Date();
    return {
      step: contract.name,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      metrics: {},
      verdicts: [],
      artifacts: [],
      ...partial,
    };
  };

  let params: Record<string, unknown>;
  let inputsHash: string;
  let thresholds: Threshold[];
  try {
    thresholds = mergeThresholds(contract.gate, checkOverrides(opts.gateOverrides));
    params = resolveParams(contract.params ?? {}, opts.params ?? {});
    // Project inputs are keyed relative to the project so moving the folder keeps the cache.
    const files: HashInput[] = (await expandInputs(projectDir, contract.inputs)).map((p) => ({
      path: p,
      key: relative(projectDir, p).split(sep).join("/"),
    }));
    for (const key of contract.fileParams ?? []) {
      const value = params[key];
      if (value === undefined && contract.params?.[key]?.endsWith("?")) continue;
      if (typeof value !== "string" || !isAbsolute(value) || !(await isFile(value))) {
        throw new Error(`fileParam ${key} must be an absolute path to an existing file`);
      }
      files.push(value);
    }
    inputsHash = await hashFiles(files, { step: contract.name, version: contract.version ?? "0", params });
  } catch (err) {
    const failed = result({
      status: "fail",
      inputsHash: "",
      durationMs: 0,
      error: message(err),
    });
    await record(failed);
    return { ...failed, cached: false };
  }

  if (!opts.force) {
    // Validation failures carry no hash; they must not hide the last real run.
    const prev = (await readLedger(projectDir)).steps[contract.name]?.findLast((r) => r.inputsHash !== "");
    if (
      prev &&
      prev.inputsHash === inputsHash &&
      (prev.status === "pass" || prev.status === "warn") &&
      !(await exists(marker)) &&
      (await outputsExist(projectDir, contract.outputs)).length === 0 &&
      (await Promise.all(prev.artifacts.map((a) => exists(resolve(projectDir, a))))).every(Boolean)
    ) {
      const gate = evaluateGate(prev.metrics, thresholds);
      if (gate.status !== "fail") {
        return { ...prev, status: gate.status, verdicts: gate.verdicts, cached: true };
      }
    }
  }

  const ctx: StepContext = {
    projectDir,
    params,
    config: opts.config,
    providers,
    env: publicEnv(opts.env ?? process.env),
    log: (msg) => {
      const clean = redactor.redact(msg);
      if (opts.log) opts.log(clean);
      else process.stderr.write(`[${contract.name}] ${clean}\n`);
    },
  };
  let final: StepResult;
  try {
    await mkdir(join(projectDir, "steps"), { recursive: true });
    await writeJsonAtomic(marker, { pid: process.pid, startedAt: new Date().toISOString() });
    for (const out of contract.outputs) await rm(resolve(projectDir, out), { force: true });
    startedAt = new Date();
    const raw = await mod.run(ctx);
    const out = { ...raw, metrics: cleanMetrics(raw.metrics ?? {}) };
    const missing = await outputsExist(projectDir, contract.outputs);
    if (missing.length) {
      final = result({
        status: "fail",
        inputsHash,
        metrics: out.metrics,
        artifacts: out.artifacts,
        ...withProvider(out.provider ?? lastPicked),
        error: message(new Error(`missing declared output: ${missing.join(", ")}`)),
      });
    } else {
      const gate = evaluateGate(out.metrics, thresholds);
      final = result({
        status: gate.status,
        inputsHash,
        metrics: out.metrics,
        verdicts: gate.verdicts,
        artifacts: out.artifacts,
        ...withProvider(out.provider ?? lastPicked),
        ...(out.quota ? { quota: out.quota } : {}),
      });
    }
  } catch (err) {
    final = result({
      status: "fail",
      inputsHash,
      ...withProvider(lastPicked),
      error: message(err),
    });
  }
  await record(final);
  await rm(marker, { force: true });
  return { ...final, cached: false };
}
