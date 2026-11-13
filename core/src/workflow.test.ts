import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { latest, readLedger } from "./ledger.ts";
import type { Config } from "./config.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { StepModule } from "./step.ts";
import { approveStep, parseWorkflow, runWorkflow, stepParams, WorkflowMismatchError } from "./workflow.ts";
import type { Workflow } from "./workflow.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", inspirationRoot: "/x", home: "/x" };
const providers = {} as ProviderRegistry;
const base = () => ({ config, providers, log: () => {} });

let tmp: string;
let dir: string;
let n = 0;
let calls: Record<string, number>;
let seen: Record<string, Record<string, unknown>>;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-wf-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = join(tmp, `p${n++}`);
  await mkdir(join(dir, "media"), { recursive: true });
  await writeFile(join(dir, "media", "in.txt"), "v1");
  calls = {};
  seen = {};
});

function fake(name: string, over: { fail?: boolean; params?: boolean } = {}): StepModule {
  return {
    contract: {
      name,
      inputs: ["media/in.txt"],
      outputs: [`out/${name}.txt`],
      gate: over.fail ? [{ metric: "x", op: ">=", value: 5, level: "fail" }] : [],
      ...(over.params ? { params: { k: "string?" as const, n: "number?" as const } } : {}),
    },
    run: async (ctx) => {
      calls[name] = (calls[name] ?? 0) + 1;
      seen[name] = ctx.params;
      await mkdir(join(ctx.projectDir, "out"), { recursive: true });
      await writeFile(join(ctx.projectDir, "out", `${name}.txt`), "x");
      return { metrics: { x: over.fail ? 1 : 9 }, artifacts: [`out/${name}.txt`] };
    },
  };
}

const wf = (steps: Workflow["steps"]): Workflow => ({ name: "t", steps });

test("runs steps in order and reports done", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const seenOrder: string[] = [];
  const r = await runWorkflow(dir, wf([{ step: "a" }, { step: "b" }]), mods, {
    ...base(),
    onStep: (res) => seenOrder.push(res.step),
  });
  assert.equal(r.status, "done");
  assert.deepEqual(r.results.map((x) => x.step), ["a", "b"]);
  assert.deepEqual(seenOrder, ["a", "b"]);
  assert.equal(r.stoppedAt, undefined);
});

test("stops at the first fail", async () => {
  const mods = { a: fake("a", { fail: true }), b: fake("b") };
  const r = await runWorkflow(dir, wf([{ step: "a" }, { step: "b" }]), mods, base());
  assert.equal(r.status, "failed");
  assert.equal(r.stoppedAt, "a");
  assert.equal(calls.b, undefined);
  assert.equal(r.results.length, 1);
});

test("pauses after an approve step until approved", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a", approve: true }, { step: "b" }]);
  const r1 = await runWorkflow(dir, w, mods, base());
  assert.equal(r1.status, "awaiting-approval");
  assert.equal(r1.stoppedAt, "a");
  assert.equal(calls.b, undefined);
  await approveStep(dir, "a");
  const r2 = await runWorkflow(dir, w, mods, base());
  assert.equal(r2.status, "done");
  assert.equal(calls.b, 1);
  assert.equal(calls.a, 1);
  const approvals = JSON.parse(await readFile(join(dir, "steps", "approvals.json"), "utf8"));
  assert.equal(approvals.a, r2.results[0]?.inputsHash);
});

test("approval is invalidated when the step's inputs change", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a", approve: true }, { step: "b" }]);
  await runWorkflow(dir, w, mods, base());
  await approveStep(dir, "a");
  await writeFile(join(dir, "media", "in.txt"), "v2");
  const r = await runWorkflow(dir, w, mods, base());
  assert.equal(r.status, "awaiting-approval");
  assert.equal(calls.a, 2);
  assert.equal(calls.b, undefined);
});

test("approveStep fails without a pass/warn result", async () => {
  await assert.rejects(approveStep(dir, "a"), /no passing result/);
  const mods = { a: fake("a", { fail: true }) };
  await runWorkflow(dir, wf([{ step: "a" }]), mods, base());
  await assert.rejects(approveStep(dir, "a"), /no passing result/);
});

test("resume skips cached steps", async () => {
  const mods = { a: fake("a"), b: fake("b", { fail: true }) };
  const w = wf([{ step: "a" }, { step: "b" }]);
  const r1 = await runWorkflow(dir, w, mods, base());
  assert.equal(r1.status, "failed");
  const r2 = await runWorkflow(dir, w, mods, base());
  assert.equal(calls.a, 1);
  assert.equal(r2.results[0]?.cached, true);
});

test("force reruns only the listed steps", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a" }, { step: "b" }]);
  await runWorkflow(dir, w, mods, base());
  await runWorkflow(dir, w, mods, { ...base(), force: ["b"] });
  assert.equal(calls.a, 1);
  assert.equal(calls.b, 2);
});

test("CLI params override workflow params per step", async () => {
  const mods = { a: fake("a", { params: true }), b: fake("b", { params: true }) };
  const w = wf([
    { step: "a", params: { k: "wf", n: 1 } },
    { step: "b", params: { k: "wf" } },
  ]);
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "cli" } } });
  assert.deepEqual(seen.a, { k: "cli", n: 1 });
  assert.deepEqual(seen.b, { k: "wf" });
});

test("parseWorkflow validates shape and step names", () => {
  const ok = parseWorkflow({ name: "x", steps: [{ step: "a", params: { k: 1 }, approve: true }] }, ["a"]);
  assert.equal(ok.steps[0]?.approve, true);
  assert.throws(() => parseWorkflow({ steps: [] }), /name/);
  assert.throws(() => parseWorkflow({ name: "x", steps: [] }), /steps/);
  assert.throws(() => parseWorkflow({ name: "x", steps: [{}] }), /steps\[0\]\.step/);
  assert.throws(() => parseWorkflow({ name: "x", steps: [{ step: "a", approve: "y" }] }), /approve/);
  assert.throws(() => parseWorkflow({ name: "x", steps: [{ step: "nope" }] }, ["a"]), /unknown step "nope"/);
});

test("shipped workflows parse against the real step names", async () => {
  const { defaultSteps } = await import("../../steps/index.ts");
  const names = Object.keys(defaultSteps);
  for (const f of ["rough-cut", "short"]) {
    const json = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "workflows", `${f}.json`), "utf8"));
    const w = parseWorkflow(json, names);
    assert.equal(w.name, f);
    const order = w.steps.map((x) => x.step);
    assert.equal(order[order.indexOf("cut") + 1], "localize", `${f}: localize runs right after cut`);
    assert.ok(order.indexOf("localize") < order.indexOf("captions"), f);
  }
});

test("remembered params: later runs need no --param; passing again changes it", async () => {
  const mods = { a: fake("a", { params: true }), b: fake("b") };
  const w = wf([{ step: "a", params: { k: "wf", n: 1 } }, { step: "b" }]);
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "cli" } } });
  assert.deepEqual(seen.a, { k: "cli", n: 1 });
  const r2 = await runWorkflow(dir, w, mods, base());
  assert.equal(r2.results[0]?.cached, true);
  assert.equal(calls.a, 1);
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "new" } } });
  assert.deepEqual(seen.a, { k: "new", n: 1 });
  await runWorkflow(dir, w, mods, base());
  assert.equal(calls.a, 2);
});

test("an unexpected throw ends the workflow as failed with a redacted message", async () => {
  const bad = fake("a");
  Object.defineProperty(bad.contract, "name", {
    get() {
      throw new Error("kaboom sekret-token-999");
    },
  });
  const seenSteps: string[] = [];
  const r = await runWorkflow(dir, wf([{ step: "a" }, { step: "b" }]), { a: bad, b: fake("b") }, {
    ...base(),
    env: { API_KEY: "sekret-token-999" },
    onStep: (x) => seenSteps.push(x.step),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.stoppedAt, "a");
  assert.match(r.results[0]?.error ?? "", /kaboom/);
  assert.doesNotMatch(r.results[0]?.error ?? "", /sekret-token-999/);
  assert.deepEqual(seenSteps, ["a"]);
  assert.equal(calls.b, undefined);
  const rec = latest(await readLedger(dir), "a");
  assert.equal(rec?.status, "fail");
  assert.equal(rec?.inputsHash, "");
  assert.doesNotMatch(rec?.error ?? "", /sekret-token-999/);
  await assert.rejects(approveStep(dir, "a"), /no passing result/);
});

test("force on an approve step clears its approval", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a", approve: true }, { step: "b" }]);
  await runWorkflow(dir, w, mods, base());
  await approveStep(dir, "a");
  assert.equal((await runWorkflow(dir, w, mods, base())).status, "done");
  const r = await runWorkflow(dir, w, mods, { ...base(), force: ["a"] });
  assert.equal(r.status, "awaiting-approval");
  assert.equal(calls.a, 2);
});

test("a warn step mid-workflow does not stop later steps", async () => {
  const warn: StepModule = {
    contract: { name: "w", inputs: [], outputs: [], gate: [{ metric: "x", op: ">=", value: 5, level: "warn" }] },
    run: async () => ({ metrics: { x: 1 }, artifacts: [] }),
  };
  const r = await runWorkflow(dir, wf([{ step: "w" }, { step: "b" }]), { w: warn, b: fake("b") }, base());
  assert.equal(r.status, "done");
  assert.deepEqual(r.results.map((x) => x.status), ["warn", "pass"]);
});

test("invalid --param is rejected before anything is persisted", async () => {
  const mods = { a: fake("a", { params: true }) };
  const w = wf([{ step: "a" }]);
  await assert.rejects(runWorkflow(dir, w, mods, { ...base(), params: { a: { typo: "x" } } }), /step "a".*undeclared params: typo/);
  await assert.rejects(runWorkflow(dir, w, mods, { ...base(), params: { a: { n: "abc" } } }), /must be a number/);
  await assert.rejects(runWorkflow(dir, w, mods, { ...base(), params: { zzz: { k: "x" } } }), /unknown step "zzz"/);
  assert.equal(existsSync(join(dir, "steps", "workflow-params.json")), false);
  assert.equal(calls.a, undefined);
});

test("empty --param value forgets the remembered key", async () => {
  const mods = { a: fake("a", { params: true }) };
  const w = wf([{ step: "a", params: { n: 1 } }]);
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "mine" } } });
  assert.deepEqual(seen.a, { k: "mine", n: 1 });
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "" } } });
  assert.deepEqual(seen.a, { n: 1 });
  await runWorkflow(dir, w, mods, base());
  assert.deepEqual(seen.a, { n: 1 });
  const saved = JSON.parse(await readFile(join(dir, "steps", "workflow-params.json"), "utf8"));
  assert.deepEqual(saved, {});
});

test("remembered params are keyed by workflow", async () => {
  const mods = { a: fake("a", { params: true }) };
  await runWorkflow(dir, { name: "one", steps: [{ step: "a" }] }, mods, { ...base(), params: { a: { k: "x" } } });
  const saved = JSON.parse(await readFile(join(dir, "steps", "workflow-params.json"), "utf8"));
  assert.deepEqual(saved, { one: { a: { k: "x" } } });
});

test("old flat workflow-params.json is migrated on read", async () => {
  const mods = { a: fake("a", { params: true }) };
  await mkdir(join(dir, "steps"), { recursive: true });
  await writeFile(join(dir, "steps", "workflow-params.json"), JSON.stringify({ a: { k: "old" } }));
  await runWorkflow(dir, { name: "one", steps: [{ step: "a" }] }, mods, base());
  assert.deepEqual(seen.a, { k: "old" });
  await runWorkflow(dir, { name: "one", steps: [{ step: "a" }] }, mods, { ...base(), params: { a: { n: 2 } } });
  const saved = JSON.parse(await readFile(join(dir, "steps", "workflow-params.json"), "utf8"));
  assert.deepEqual(saved, { one: { a: { k: "old", n: 2 } } });
});

test("one workflow per project: another one is refused unless switchWorkflow", async () => {
  const mods = { a: fake("a", { params: true }) };
  await runWorkflow(dir, { name: "one", steps: [{ step: "a" }] }, mods, { ...base(), params: { a: { k: "x" } } });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "steps", "workflow.json"), "utf8")), { name: "one" });
  await assert.rejects(
    runWorkflow(dir, { name: "two", steps: [{ step: "a" }] }, mods, { ...base(), params: { a: { k: "y" } } }),
    (e: unknown) => e instanceof WorkflowMismatchError && /this project ran one; create a new project \(mostudio new\) or pass --switch-workflow/.test(e.message),
  );
  assert.deepEqual(JSON.parse(await readFile(join(dir, "steps", "workflow-params.json"), "utf8")), { one: { a: { k: "x" } } });
  const r = await runWorkflow(dir, { name: "two", steps: [{ step: "a" }] }, mods, { ...base(), switchWorkflow: true });
  assert.equal(r.status, "done");
  assert.deepEqual(seen.a, {});
  assert.deepEqual(JSON.parse(await readFile(join(dir, "steps", "workflow.json"), "utf8")), { name: "two" });
});

test("autoApprove records approval and runs to the end", async () => {
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a", approve: true }, { step: "b" }]);
  const started: string[] = [];
  const approved: { step: string; auto: boolean }[] = [];
  const r = await runWorkflow(dir, w, mods, {
    ...base(),
    autoApprove: true,
    onStepStart: (s) => started.push(s),
    onApprove: (step, auto) => approved.push({ step, auto }),
  });
  assert.equal(r.status, "done");
  assert.equal(calls.a, 1);
  assert.equal(calls.b, 1);
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(approved, [{ step: "a", auto: true }]);
  const approvals = JSON.parse(await readFile(join(dir, "steps", "approvals.json"), "utf8"));
  assert.equal(approvals.a, r.results[0]?.inputsHash);
});

test("autoApprove never skips a failing gate", async () => {
  const mods = { a: fake("a", { fail: true }), b: fake("b") };
  const w = wf([{ step: "a", approve: true }, { step: "b" }]);
  const approved: { step: string; auto: boolean }[] = [];
  const r = await runWorkflow(dir, w, mods, {
    ...base(),
    autoApprove: true,
    onApprove: (step, auto) => approved.push({ step, auto }),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.stoppedAt, "a");
  assert.equal(calls.b, undefined);
  assert.deepEqual(approved, []);
  assert.equal(existsSync(join(dir, "steps", "approvals.json")), false);
});

test("stepParams merges workflow entry and remembered params", async () => {
  const mods = { a: fake("a", { params: true }), b: fake("b") };
  const w = wf([
    { step: "a", params: { k: "wf", n: 1 } },
    { step: "b" },
  ]);
  assert.deepEqual(await stepParams(dir, w, "a"), { k: "wf", n: 1 });
  assert.deepEqual(await stepParams(dir, w, "b"), {});
  assert.deepEqual(await stepParams(dir, w, "unknown"), {});
  await runWorkflow(dir, w, mods, { ...base(), params: { a: { k: "cli" } } });
  assert.deepEqual(await stepParams(dir, w, "a"), { k: "cli", n: 1 });
  assert.deepEqual(await stepParams(dir, w, "b"), {});
  assert.deepEqual(await stepParams(dir, w, "unknown"), {});
});

test("runWorkflow stops before the next step once aborted", async () => {
  const ac = new AbortController();
  const mods = { a: fake("a"), b: fake("b") };
  const w = wf([{ step: "a" }, { step: "b" }]);
  const r = await runWorkflow(dir, w, mods, {
    ...base(),
    signal: ac.signal,
    onStep: (stepRes) => {
      if (stepRes.step === "a") {
        ac.abort();
      }
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.stoppedAt, "b");
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0]?.step, "a");
  assert.equal(calls.b, undefined);
});
