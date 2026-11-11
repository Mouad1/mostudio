import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { Config } from "./config.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { StepModule } from "./step.ts";
import { approveStep, parseWorkflow, runWorkflow } from "./workflow.ts";
import type { Workflow } from "./workflow.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
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
  }
});
