import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { evaluateGate, mergeThresholds } from "./gate.ts";
import { hashFiles } from "./hash.ts";
import { latest, readLedger, recordStep } from "./ledger.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { Metrics, StepResult, Threshold } from "./types.ts";

export type StepContract = {
  name: string;
  /** Paths relative to the project folder; a glob is allowed only as `<dir>/*`. */
  inputs: string[];
  outputs: string[];
  params?: Record<string, "string" | "number" | "boolean">;
  /** Names of params holding absolute file paths; the files' bytes join the input hash. */
  fileParams?: string[];
  gate: Threshold[];
  private?: boolean;
};

export type StepContext = {
  projectDir: string;
  params: Record<string, unknown>;
  config: Config;
  providers: ProviderRegistry;
  log: (msg: string) => void;
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
  declared: Record<string, "string" | "number" | "boolean">,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const extras = Object.keys(given).filter((k) => !(k in declared));
  if (extras.length) throw new Error(`undeclared params: ${extras.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(declared)) {
    let value = given[key];
    if (value === undefined) throw new Error(`missing param: ${key}`);
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

/** Validate, cache-check by input hash, run, gate, and record a single step. */
export async function runStep(
  projectDir: string,
  mod: StepModule,
  opts: RunStepOptions,
): Promise<StepResult & { cached: boolean }> {
  const { contract } = mod;
  const startedAt = new Date();
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
  try {
    params = resolveParams(contract.params ?? {}, opts.params ?? {});
    const files = await expandInputs(projectDir, contract.inputs);
    for (const key of contract.fileParams ?? []) {
      const value = params[key];
      if (typeof value !== "string" || !isAbsolute(value) || !(await isFile(value))) {
        throw new Error(`fileParam ${key} must be an absolute path to an existing file`);
      }
      files.push(value);
    }
    inputsHash = await hashFiles(files, { step: contract.name, params });
  } catch (err) {
    const failed = result({
      status: "fail",
      inputsHash: "",
      durationMs: 0,
      error: (err as Error).message,
    });
    await recordStep(projectDir, failed);
    return { ...failed, cached: false };
  }

  if (!opts.force) {
    const prev = latest(await readLedger(projectDir), contract.name);
    if (
      prev &&
      prev.inputsHash === inputsHash &&
      (prev.status === "pass" || prev.status === "warn") &&
      (await outputsExist(projectDir, contract.outputs)).length === 0
    ) {
      return { ...prev, cached: true };
    }
  }

  const ctx: StepContext = {
    projectDir,
    params,
    config: opts.config,
    providers: opts.providers,
    log: opts.log ?? ((msg) => void process.stderr.write(`[${contract.name}] ${msg}\n`)),
  };
  let final: StepResult;
  try {
    const out = await mod.run(ctx);
    const missing = await outputsExist(projectDir, contract.outputs);
    if (missing.length) {
      final = result({
        status: "fail",
        inputsHash,
        metrics: out.metrics,
        artifacts: out.artifacts,
        error: `missing declared output: ${missing.join(", ")}`,
      });
    } else {
      const gate = evaluateGate(out.metrics, mergeThresholds(contract.gate, opts.gateOverrides ?? []));
      final = result({
        status: gate.status,
        inputsHash,
        metrics: out.metrics,
        verdicts: gate.verdicts,
        artifacts: out.artifacts,
        ...(out.provider ? { provider: out.provider } : {}),
        ...(out.quota ? { quota: out.quota } : {}),
      });
    }
  } catch (err) {
    final = result({
      status: "fail",
      inputsHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await recordStep(projectDir, final);
  return { ...final, cached: false };
}
