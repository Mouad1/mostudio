import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs/atomic.ts";
import { latest, readLedger, recordStep } from "./ledger.ts";
import { createRedactor } from "./redact.ts";
import { checkParams, runStep } from "./step.ts";
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
  /** Allow running a workflow other than the one this project ran before (steps/workflow.json). */
  switchWorkflow?: boolean;
  /** Auto-approve human approval steps instead of pausing. */
  autoApprove?: boolean;
  /** Called immediately before running each step. */
  onStepStart?: (step: string) => void;
  /** Called when an approval step is approved (auto or manual). */
  onApprove?: (step: string, auto: boolean) => void;
};

/** A --param naming an unknown step/key or a bad value; nothing is persisted. */
export class WorkflowParamError extends Error {}

/** The project already ran another workflow; nothing is persisted. */
export class WorkflowMismatchError extends Error {}

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
const workflowPath = (projectDir: string) => join(projectDir, "steps", "workflow.json");

type StepParams = Record<string, Record<string, unknown>>;
type WorkflowParams = Record<string, StepParams>;

/** Name of the workflow this project runs (steps/workflow.json), if any. */
export async function readProjectWorkflow(projectDir: string): Promise<string | undefined> {
  const j = await readJson<{ name?: unknown }>(workflowPath(projectDir));
  return typeof j?.name === "string" && j.name !== "" ? j.name : undefined;
}

/**
 * Params remembered from earlier runs, keyed workflow -> step -> key. The pre-workflow flat shape
 * (step -> key -> primitive) is read as belonging to `legacyOwner`.
 */
async function readParams(projectDir: string, legacyOwner: string): Promise<WorkflowParams> {
  const raw = (await readJson<Record<string, unknown>>(paramsPath(projectDir))) ?? {};
  const flat = Object.values(raw).some((step) => isObject(step) && Object.values(step).some((v) => !isObject(v)));
  if (flat) return { [legacyOwner]: raw as StepParams };
  return raw as WorkflowParams;
}

/** Approval steps of `wf` whose latest pass/warn result is not approved (for status displays). */
export async function pendingApprovals(projectDir: string, wf: Workflow): Promise<string[]> {
  const ledger = await readLedger(projectDir);
  const approvals = await readApprovals(projectDir);
  return wf.steps
    .filter((s) => s.approve)
    .map((s) => s.step)
    .filter((step) => {
      const r = latest(ledger, step);
      return r !== undefined && r.status !== "fail" && r.inputsHash !== "" && approvals[step] !== r.inputsHash;
    });
}

/**
 * Merges workflow entry params with remembered params from steps/workflow-params.json
 * (the exact same merge runWorkflow uses; returns {} if the step is not in wf).
 */
export async function stepParams(
  projectDir: string,
  wf: Workflow,
  step: string,
): Promise<Record<string, unknown>> {
  const entry = wf.steps.find((s) => s.step === step);
  if (!entry) return {};
  const ran = await readProjectWorkflow(projectDir);
  const all = await readParams(projectDir, ran ?? wf.name);
  const persisted = all[wf.name] ?? {};
  return { ...(entry.params ?? {}), ...(persisted[step] ?? {}) };
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
  const { params: cliParams, force, onStep, switchWorkflow, autoApprove, onStepStart, onApprove, ...rest } = opts;
  const results: WorkflowResult["results"] = [];
  const redactor = createRedactor([process.env, rest.env]);
  // Validate before persisting: a typo must not be remembered.
  for (const [step, p] of Object.entries(cliParams ?? {})) {
    const mod = Object.hasOwn(steps, step) ? steps[step] : undefined;
    if (!mod) throw new WorkflowParamError(`--param: unknown step "${step}"`);
    const given = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== ""));
    try {
      checkParams(mod.contract.params, given);
    } catch (err) {
      throw new WorkflowParamError(`--param for step "${step}": ${(err as Error).message}`);
    }
  }
  // One workflow per project: its params, approvals and outputs belong together.
  const ran = await readProjectWorkflow(projectDir);
  if (ran !== undefined && ran !== wf.name && !switchWorkflow) {
    throw new WorkflowMismatchError(`this project ran ${ran}; create a new project (mostudio new) or pass --switch-workflow`);
  }
  const all = await readParams(projectDir, ran ?? wf.name);
  if (ran !== wf.name) {
    await mkdir(join(projectDir, "steps"), { recursive: true });
    await writeJsonAtomic(workflowPath(projectDir), { name: wf.name });
  }
  // Remembered params: workflow file < persisted < this call's params. Passing a param again changes it;
  // an empty value forgets the remembered key.
  const persisted = all[wf.name] ?? {};
  const remembered: StepParams = { ...persisted };
  for (const [step, p] of Object.entries(cliParams ?? {})) {
    const merged = { ...persisted[step], ...p };
    for (const [k, v] of Object.entries(merged)) if (v === "") delete merged[k];
    if (Object.keys(merged).length > 0) remembered[step] = merged;
    else delete remembered[step];
  }
  if (Object.keys(cliParams ?? {}).length > 0) {
    await mkdir(join(projectDir, "steps"), { recursive: true });
    const next: WorkflowParams = { ...all, [wf.name]: remembered };
    if (Object.keys(remembered).length === 0) delete next[wf.name];
    await writeJsonAtomic(paramsPath(projectDir), next);
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
    onStepStart?.(entry.step);
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
      try {
        await mkdir(join(projectDir, "steps"), { recursive: true });
        await recordStep(projectDir, result);
      } catch {
        // The ledger write is best-effort here; the failure is still returned to the caller.
      }
    }
    results.push(result);
    onStep?.(result);
    if (result.status === "fail") return { status: "failed", results, stoppedAt: entry.step };
    if (entry.approve && (await readApprovals(projectDir))[entry.step] !== result.inputsHash) {
      if (autoApprove) {
        await approveStep(projectDir, entry.step);
        onApprove?.(entry.step, true);
      } else {
        return { status: "awaiting-approval", results, stoppedAt: entry.step };
      }
    }
  }
  return { status: "done", results };
}
