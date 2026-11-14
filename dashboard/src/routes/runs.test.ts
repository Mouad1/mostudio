import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  latest,
  readLedger,
  runBin,
  writeAppSettings,
  type StepContext,
  type StepModule,
  type StepOutput,
} from "../../../core/src/index.ts";
import { startTestDashboard } from "../testkit.ts";
import type { RunEvent } from "../types.ts";

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function lastRunEnd(d: { events: (id: string) => RunEvent[] }, id: string) {
  const evs = d.events(id).filter((e) => e.type === "run-end");
  const last = evs.at(-1) as { type: "run-end"; status: string; stoppedAt?: string; error?: string } | undefined;
  if (!last) return undefined;
  return {
    status: last.status,
    ...(last.stoppedAt !== undefined ? { stoppedAt: last.stoppedAt } : {}),
  };
}

function createFakeSteps(recorded?: { assembleRenderer?: string }) {
  const stepA: StepModule = {
    contract: { name: "a", inputs: [], outputs: [], gate: [] },
    run: async () => ({ metrics: {}, artifacts: [] }),
  };

  const stepB: StepModule = {
    contract: {
      name: "b",
      inputs: [],
      outputs: [],
      gate: [],
      params: { n: "number?" },
    },
    run: async (ctx: StepContext) => ({
      metrics: { ...(ctx.params.n !== undefined ? { n: Number(ctx.params.n) } : {}) },
      artifacts: [],
    }),
  };

  const stepC: StepModule = {
    contract: { name: "c", inputs: [], outputs: [], gate: [] },
    run: async () => ({ metrics: {}, artifacts: [] }),
  };

  const stepX: StepModule = {
    contract: {
      name: "x",
      inputs: [],
      outputs: [],
      gate: [{ metric: "score", op: ">=", value: 10, level: "fail" }],
    },
    run: async () => ({
      metrics: { score: 5 },
      artifacts: [],
    }),
  };

  const stepSlow: StepModule = {
    contract: { name: "slow", inputs: [], outputs: [], gate: [] },
    run: async () => {
      await runBin("sleep", ["30"]);
      return { metrics: {}, artifacts: [] };
    },
  };

  const stepAssemble: StepModule = {
    contract: {
      name: "assemble",
      inputs: [],
      outputs: [],
      gate: [],
      params: { captionsRenderer: "string?" },
    },
    run: async (ctx: StepContext) => {
      if (recorded) {
        recorded.assembleRenderer = String(ctx.params.captionsRenderer);
      }
      return {
        metrics: { captionsRenderer: String(ctx.params.captionsRenderer) },
        artifacts: [],
      };
    },
  };

  return { a: stepA, b: stepB, c: stepC, x: stepX, slow: stepSlow, assemble: stepAssemble };
}

function setupWorkflows(ws: string) {
  mkdirSync(join(ws, "workflows"), { recursive: true });
  writeFileSync(
    join(ws, "workflows", "t.json"),
    JSON.stringify({
      name: "t",
      steps: [
        { step: "a" },
        { step: "b", approve: true, params: { n: 7 } },
        { step: "c" },
      ],
    }),
  );

  writeFileSync(
    join(ws, "workflows", "t-fail.json"),
    JSON.stringify({
      name: "t-fail",
      steps: [{ step: "a" }, { step: "x" }],
    }),
  );

  writeFileSync(
    join(ws, "workflows", "t-slow.json"),
    JSON.stringify({
      name: "t-slow",
      steps: [{ step: "slow" }],
    }),
  );

  writeFileSync(
    join(ws, "workflows", "t-assemble.json"),
    JSON.stringify({
      name: "t-assemble",
      steps: [{ step: "assemble" }],
    }),
  );

  writeFileSync(
    join(ws, "workflows", "other.json"),
    JSON.stringify({
      name: "other",
      steps: [{ step: "a" }],
    }),
  );
}

test("manual stops at review; approve+continue finishes", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "rev" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
    await d.idle(id);
    assert.deepEqual(lastRunEnd(d, id), { status: "awaiting-approval", stoppedAt: "b" });

    assert.equal((await d.api(`/api/projects/${id}/approve`, post({ step: "b", continue: true }))).status, 202);
    await d.idle(id);
    assert.equal(lastRunEnd(d, id)?.status, "done");
  } finally {
    await d.close();
  }
});

test("auto runs end to end; approved{auto:true} right after b's step-end", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "auto" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "auto" }))).status, 202);
    await d.idle(id);

    const types = d.events(id).map((e) => e.type);
    assert.deepEqual(types, [
      "run-start",
      "step-start",
      "step-end",
      "step-start",
      "step-end",
      "approved",
      "step-start",
      "step-end",
      "run-end",
    ]);

    const approvedEvent = d.events(id)[5] as Extract<RunEvent, { type: "approved" }>;
    assert.deepEqual(
      { type: approvedEvent.type, step: approvedEvent.step, auto: approvedEvent.auto },
      { type: "approved", step: "b", auto: true },
    );
    assert.equal(lastRunEnd(d, id)?.status, "done");
  } finally {
    await d.close();
  }
});

test("auto still stops at a failing gate", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "gate" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t-fail", mode: "auto" }))).status, 202);
    await d.idle(id);
    assert.deepEqual(lastRunEnd(d, id), { status: "failed", stoppedAt: "x" });
  } finally {
    await d.close();
  }
});

test("cancel during a slow step kills it and ends cancelled", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "slow" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t-slow", mode: "manual" }))).status, 202);

    // Wait until step-start for slow has fired
    while (!d.events(id).some((e) => e.type === "step-start" && (e as any).step === "slow")) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const t0 = Date.now();
    const cancelRes = await d.api(`/api/projects/${id}/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 200);

    await d.idle(id);
    const durationMs = Date.now() - t0;
    assert.ok(durationMs < 2000, `expected cancel < 2000ms, took ${durationMs}ms`);
    assert.equal(lastRunEnd(d, id)?.status, "cancelled");

    const ledger = await readLedger(join(d.ws, "projects", id));
    const slowResult = latest(ledger, "slow");
    assert.equal(slowResult?.error, "cancelled by user");
  } finally {
    await d.close();
  }
});

test("second run while running → 409", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "double" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t-slow", mode: "manual" }))).status, 202);
    const res = await d.api(`/api/projects/${id}/run`, post({ workflow: "t-slow", mode: "manual" }));
    assert.equal(res.status, 409);

    await d.api(`/api/projects/${id}/cancel`, { method: "POST" });
    await d.idle(id);
  } finally {
    await d.close();
  }
});

test("rerun and single step use workflow params", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "params" }))).json();
    const id = p.id;

    // Run workflow initially to record workflow and reach review
    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
    await d.idle(id);

    // POST /rerun { step: "b" }
    assert.equal((await d.api(`/api/projects/${id}/rerun`, post({ step: "b" }))).status, 202);
    await d.idle(id);
    const stepEndRerun = d.events(id).filter((e) => e.type === "step-end" && (e as any).result?.step === "b").at(-1) as any;
    assert.equal(stepEndRerun?.result?.metrics?.n, 7);

    // POST /steps/b {}
    assert.equal((await d.api(`/api/projects/${id}/steps/b`, post({}))).status, 202);
    await d.idle(id);
    const stepEndSingle = d.events(id).filter((e) => e.type === "step-end" && (e as any).result?.step === "b").at(-1) as any;
    assert.equal(stepEndSingle?.result?.metrics?.n, 7);
  } finally {
    await d.close();
  }
});

test("mismatched workflow → 409 friendly; source outside project → 400; bad param → 400", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "checks" }))).json();
    const id = p.id;

    // Run workflow t once
    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
    await d.idle(id);

    // Mismatched workflow
    const mismatch = await d.api(`/api/projects/${id}/run`, post({ workflow: "other", mode: "manual" }));
    assert.equal(mismatch.status, 409);
    const mismatchBody = await mismatch.json();
    assert.match(mismatchBody.error, /This project already made a/);

    // Source outside project
    const badSource = await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual", source: "../secret.txt" }));
    assert.equal(badSource.status, 400);

    // Bad param (undeclared parameter for step a)
    const badParam = await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual", params: { a: { undeclared: 123 } } }));
    assert.equal(badParam.status, 400);
  } finally {
    await d.close();
  }
});

test("packaged app defaults assemble captions to ass, opt-in hyperframes", async () => {
  const recorded = { assembleRenderer: "" };
  const steps = createFakeSteps(recorded);
  const d = await startTestDashboard({ packaged: true, steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "pkg" }))).json();
    const id = p.id;

    // First run with packaged: true defaults assemble to "ass"
    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t-assemble", mode: "auto" }))).status, 202);
    await d.idle(id);
    assert.equal(recorded.assembleRenderer, "ass");

    // Write app setting animatedCaptions = true
    await writeAppSettings(d.home, { animatedCaptions: true });

    // Second run with force: ["assemble"] -> "hyperframes"
    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t-assemble", mode: "auto", force: ["assemble"] }))).status, 202);
    await d.idle(id);
    assert.equal(recorded.assembleRenderer, "hyperframes");
  } finally {
    await d.close();
  }
});

test("logs with [step] prefix move prefix to step field", async () => {
  const stepLog: StepModule = {
    contract: { name: "logstep", inputs: [], outputs: [], gate: [] },
    run: async (ctx) => {
      ctx.log("processing chunk 1");
      return { metrics: {}, artifacts: [] };
    },
  };
  const d = await startTestDashboard({ steps: { logstep: stepLog } });
  try {
    mkdirSync(join(d.ws, "workflows"), { recursive: true });
    writeFileSync(
      join(d.ws, "workflows", "w-log.json"),
      JSON.stringify({ name: "w-log", steps: [{ step: "logstep" }] }),
    );
    const p = await (await d.api("/api/projects", post({ slug: "logs" }))).json();
    const id = p.id;

    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "w-log", mode: "manual" }))).status, 202);
    await d.idle(id);

    const logEv = d.events(id).find((e) => e.type === "log") as any;
    assert.ok(logEv, "expected a log event");
    assert.equal(logEv.step, "logstep");
    assert.equal(logEv.message, "processing chunk 1");
  } finally {
    await d.close();
  }
});

test("approve without continue returns 200 and emits approved {auto:false}; unpassed step returns 409", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "appr" }))).json();
    const id = p.id;

    // Approving step b before running -> 409
    const earlyAppr = await d.api(`/api/projects/${id}/approve`, post({ step: "b" }));
    assert.equal(earlyAppr.status, 409);
    const earlyBody = await earlyAppr.json();
    assert.match(earlyBody.error, /no passing result for step "b"/);

    // Run workflow in manual mode to stop at review
    assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
    await d.idle(id);

    // Approve without continue -> 200 { ok: true }
    const okAppr = await d.api(`/api/projects/${id}/approve`, post({ step: "b" }));
    assert.equal(okAppr.status, 200);
    const okBody = await okAppr.json();
    assert.deepEqual(okBody, { ok: true });

    // Verify approved event was emitted with auto: false
    const apprEv = d.events(id).filter((e) => e.type === "approved").at(-1) as any;
    assert.deepEqual(
      { type: apprEv.type, step: apprEv.step, auto: apprEv.auto },
      { type: "approved", step: "b", auto: false },
    );
  } finally {
    await d.close();
  }
});

test("unknown step returns 404; rerun on fresh project returns 400", async () => {
  const steps = createFakeSteps();
  const d = await startTestDashboard({ steps });
  try {
    setupWorkflows(d.ws);
    const p = await (await d.api("/api/projects", post({ slug: "errs" }))).json();
    const id = p.id;

    // POST /steps/unknown -> 404
    const unknownStep = await d.api(`/api/projects/${id}/steps/nonexistent`, post({}));
    assert.equal(unknownStep.status, 404);

    // POST /rerun on project without workflow -> 400
    const noWfRerun = await d.api(`/api/projects/${id}/rerun`, post({ step: "b" }));
    assert.equal(noWfRerun.status, 400);
  } finally {
    await d.close();
  }
});
