import { basename, join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs/atomic.ts";
import { SLUG_RE } from "./project.ts";
import type { StepResult } from "./types.ts";

export type Ledger = {
  version: 1;
  project: string;
  createdAt: string;
  steps: Record<string, StepResult[]>;
};

/** Ledger from `run.json`, or a fresh in-memory one (not written) if absent. */
export async function readLedger(projectDir: string): Promise<Ledger> {
  const existing = await readJson<Ledger>(join(projectDir, "run.json"));
  return (
    existing ?? {
      version: 1,
      project: basename(projectDir),
      createdAt: new Date().toISOString(),
      steps: {},
    }
  );
}

/** Append to history in run.json and write the latest result to steps/<step>.json. */
export async function recordStep(projectDir: string, result: StepResult): Promise<void> {
  if (!SLUG_RE.test(result.step)) {
    throw new Error(`invalid step name: ${JSON.stringify(result.step)}`);
  }
  const ledger = await readLedger(projectDir);
  (ledger.steps[result.step] ??= []).push(result);
  await writeJsonAtomic(join(projectDir, "steps", `${result.step}.json`), result);
  await writeJsonAtomic(join(projectDir, "run.json"), ledger);
}

export function latest(ledger: Ledger, step: string): StepResult | undefined {
  return ledger.steps[step]?.at(-1);
}
