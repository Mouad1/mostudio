import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { readJson } from "./fs/atomic.ts";
import { latest, readLedger, recordStep } from "./ledger.ts";
import { createProject } from "./project.ts";
import type { StepResult } from "./types.ts";

let tmp: string;
let dir: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-ledger-"));
  dir = await createProject(tmp, "ledger-test");
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function result(step: string, status: StepResult["status"], n: number): StepResult {
  return {
    step,
    status,
    startedAt: "2026-11-09T10:00:00.000Z",
    endedAt: "2026-11-09T10:00:01.000Z",
    durationMs: 1000 + n,
    inputsHash: `hash${n}`,
    metrics: { n },
    verdicts: [],
    artifacts: [],
  };
}

test("readLedger on missing run.json returns fresh ledger without writing", async () => {
  const l = await readLedger(dir);
  assert.equal(l.version, 1);
  assert.equal(l.project, basename(dir));
  assert.deepEqual(l.steps, {});
  assert.ok(!Number.isNaN(Date.parse(l.createdAt)));
  assert.ok(!existsSync(join(dir, "run.json")));
});

test("recordStep keeps history and writes latest", async () => {
  const r1 = result("ingest", "warn", 1);
  const r2 = result("ingest", "pass", 2);
  await recordStep(dir, r1);
  await recordStep(dir, r2);
  const ledger = await readLedger(dir);
  assert.equal(ledger.steps.ingest.length, 2);
  assert.deepEqual(await readJson(join(dir, "steps/ingest.json")), r2);
  assert.deepEqual(latest(ledger, "ingest"), r2);
  assert.equal(latest(ledger, "nope"), undefined);
});

test("recordStep rejects invalid step names", async () => {
  for (const bad of ["../evil", "a/b", "Ingest", "", "a--b", "-a"]) {
    await assert.rejects(recordStep(dir, result(bad, "pass", 0)), /step/i, bad);
  }
  assert.ok(!existsSync(join(dir, "..", "evil.json")));
});
