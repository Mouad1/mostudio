import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs/atomic.ts";
import { latest, readLedger } from "./ledger.ts";
import { createRedactor } from "./redact.ts";
import { runStep } from "./step.ts";
import type { RunStepOptions, StepModule } from "./step.ts";
import type { StepResult, Threshold } from "./types.ts";

export type Workflow = {
  name: string;
  steps: { step: string; params?: Record<string, unknown>; gate?: Threshold[]; approve?: boolean }[];
};

export type WorkflowResult = {
  status: "done" | "failed" | "awaiting-approval";
  results: (StepResult & { cached: boolean })[];
  stoppedAt?: string;
};

export type RunWorkflowOptions = Omit<RunStepOptions, "params" | "force" | "gateOverrides"> & {
  /** Per-step params from the caller (CLI); they win over the workflow's own. */
  params?: Record<string, Record<string, unknown>>;
  /** Steps to force-rerun (only these). */
  force?: string[];
  /** Called as each step completes. */
  onStep?: (result: StepResult & { cached: boolean }) => void;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a workflow JSON document; throws naming the bad field. `known` lists valid step names. */
export function parseWorkflow(json: unknown, known?: string[]): Workflow {
  if (!isObject(json)) throw new Error("workflow must be an object");
  if (typeof json.name !== "string" || json.name === "") throw new Error("workflow.name must be a non-empty string");
  if (!Array.isArray(json.steps) || json.steps.length === 0) throw new Error("workflow.steps must be a non-empty array");
  const steps = json.steps.map((raw: unknown, i): Workflow["steps"][number] => {
    const at = `workflow.steps[${i}]`;
    if (!isObject(raw)) throw new Error(`${at} must be an object`);
    if (typeof raw.step !== "string" || raw.step === "") throw new Error(`${at}.step must be a non-empty string`);
    if (known && !known.includes(raw.step)) {
      throw new Error(`${at}: unknown step "${raw.step}" (known: ${[...known].sort().join(", ")})`);
    }
    if (raw.params !== undefined && !isObject(raw.params)) throw new Error(`${at}.params must be an object`);
    if (raw.gate !== undefined && !Array.isArray(raw.gate)) throw new Error(`${at}.gate must be an array`);
    if (raw.approve !== undefined && typeof raw.approve !== "boolean") throw new Error(`${at}.approve must be a boolean`);
    return {
      step: raw.step,
      ...(raw.params ? { params: raw.params } : {}),
      ...(raw.gate ? { gate: raw.gate as Threshold[] } : {}),
      ...(raw.approve !== undefined ? { approve: raw.approve } : {}),
    };
  });
  return { name: json.name, steps };
}

const approvalsPath = (projectDir: string) => join(projectDir, "steps", "approvals.json");

async function readApprovals(projectDir: string): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(approvalsPath(projectDir))) ?? {};
}

const paramsPath = (projectDir: string) => join(projectDir, "steps", "workflow-params.json");

type StepParams = Record<string, Record<string, unknown>>;

/** Per-step params remembered from earlier runs of this project. */
async function readParams(projectDir: string): Promise<StepParams> {
  return (await readJson<StepParams>(paramsPath(projectDir))) ?? {};
}

/** Record the step's latest pass/warn inputsHash as approved. */
export async function approveStep(projectDir: string, step: string): Promise<void> {
  const r = latest(await readLedger(projectDir), step);
  if (!r || r.status === "fail" || r.inputsHash === "") {
    throw new Error(`no passing result for step "${step}"; run it first`);
  }
  const approvals = await readApprovals(projectDir);
  approvals[step] = r.inputsHash;
  await writeJsonAtomic(approvalsPath(projectDir), approvals);
}

/** Run workflow steps in order; stop on fail, or after an unapproved approve step. */
export async function runWorkflow(
  projectDir: string,
  wf: Workflow,
  steps: Record<string, StepModule>,
  opts: RunWorkflowOptions,
): Promise<WorkflowResult> {
  const { params: cliParams, force, onStep, ...rest } = opts;
  const results: WorkflowResult["results"] = [];
  const redactor = createRedactor([process.env, rest.env]);
  // Remembered params: workflow file < persisted < this call's params. Passing a param again changes it.
  const persisted = await readParams(projectDir);
  const remembered: StepParams = { ...persisted };
  for (const [step, p] of Object.entries(cliParams ?? {})) remembered[step] = { ...persisted[step], ...p };
  if (Object.keys(cliParams ?? {}).length > 0) {
    await mkdir(join(projectDir, "steps"), { recursive: true });
    await writeJsonAtomic(paramsPath(projectDir), remembered);
  }
  for (const entry of wf.steps) {
    const mod = Object.hasOwn(steps, entry.step) ? steps[entry.step] : undefined;
    if (!mod) throw new Error(`unknown step "${entry.step}" in workflow ${wf.name}`);
    if (force?.includes(entry.step) && entry.approve) {
      const approvals = await readApprovals(projectDir);
      if (entry.step in approvals) {
        delete approvals[entry.step];
        await writeJsonAtomic(approvalsPath(projectDir), approvals);
      }
    }
    let result: StepResult & { cached: boolean };
    try {
      result = await runStep(projectDir, mod, {
      ...rest,
      params: { ...entry.params, ...remembered[entry.step] },
      ...(entry.gate ? { gateOverrides: entry.gate } : {}),
      force: force?.includes(entry.step) ?? false,
      ...(rest.log ? { log: (msg: string) => rest.log?.(`[${entry.step}] ${msg}`) } : {}),
      });
    } catch (err) {
      const now = new Date().toISOString();
      result = {
        step: entry.step,
        status: "fail",
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        inputsHash: "",
        metrics: {},
        verdicts: [],
        artifacts: [],
        error: redactor.redact(err instanceof Error ? err.message : String(err)),
        cached: false,
      };
    }
    results.push(result);
    onStep?.(result);
    if (result.status === "fail") return { status: "failed", results, stoppedAt: entry.step };
    if (entry.approve && (await readApprovals(projectDir))[entry.step] !== result.inputsHash) {
      return { status: "awaiting-approval", results, stoppedAt: entry.step };
    }
  }
  return { status: "done", results };
}
