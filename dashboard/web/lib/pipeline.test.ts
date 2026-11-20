import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStatus, RunEvent, StepView, WorkflowInfo } from "../../src/types.ts";
import {
  applyEvent,
  elapsed,
  initialState,
  MAX_LOG_LINES,
  reconcile,
  STEP_LABELS,
  type PipelineState,
  type StepCard,
} from "./pipeline.ts";

function wf(stepsDesc: string[]): WorkflowInfo {
  return {
    name: "short",
    title: "Short",
    steps: stepsDesc.map((s) => {
      const approve = s.endsWith("*");
      const step = approve ? s.slice(0, -1) : s;
      return { step, approve };
    }),
  };
}

const emptyStatus: ProjectStatus = {
  id: "2026-11-14-test",
  dir: "/tmp/test",
  steps: {},
  pending: [],
  running: false,
  state: "new",
  interrupted: [],
  uploads: [],
};

function res(step: string, status: "pass" | "warn" | "fail", extra: Partial<StepView> = {}): StepView {
  return {
    step,
    status,
    startedAt: new Date(1_000).toISOString(),
    endedAt: new Date(2_000).toISOString(),
    durationMs: 1_000,
    inputsHash: "hash123",
    metrics: {},
    verdicts: [],
    artifacts: [],
    ...extra,
  };
}

function ev(id: number, body: any): RunEvent {
  return {
    id,
    at: new Date(id * 1_000).toISOString(),
    ...body,
  };
}

function reduce(s: PipelineState, events: RunEvent[]): PipelineState {
  return events.reduce(applyEvent, s);
}

test("live run to a review pause", () => {
  let s = initialState(wf(["ingest", "captions*"]), emptyStatus);
  s = reduce(s, [
    ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }),
    ev(2, { type: "step-start", step: "ingest" }),
    ev(3, { type: "log", step: "ingest", message: "copied a.mov" }),
    ev(4, { type: "step-end", result: res("ingest", "pass") }),
    ev(5, { type: "step-start", step: "captions" }),
    ev(6, { type: "step-end", result: res("captions", "warn") }),
    ev(7, { type: "run-end", status: "awaiting-approval", stoppedAt: "captions" }),
  ]);
  assert.deepEqual(s.cards.map((c) => c.state), ["pass", "awaiting"]);
  assert.deepEqual([s.running, s.outcome, s.cards[0]!.logs], [false, "awaiting-approval", ["copied a.mov"]]);
});

test("replayed ids are ignored", () => {
  let s = initialState(wf(["ingest"]), emptyStatus);
  s = applyEvent(s, ev(5, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }));
  const before = s;
  s = applyEvent(s, ev(5, { type: "run-start", kind: "workflow", name: "short", mode: "auto" }));
  assert.equal(s, before);
  s = applyEvent(s, ev(3, { type: "run-start", kind: "workflow", name: "short", mode: "auto" }));
  assert.equal(s, before);
});

test("auto approval is marked on the card", () => {
  let s = initialState(wf(["ingest", "captions*"]), emptyStatus);
  s = reduce(s, [
    ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "auto" }),
    ev(2, { type: "step-start", step: "captions" }),
    ev(3, { type: "step-end", result: res("captions", "warn") }),
    ev(4, { type: "approved", step: "captions", auto: true }),
  ]);
  const card = s.cards.find((c) => c.step === "captions")!;
  assert.equal(card.autoApproved, true);
  assert.equal(card.state, "warn");
});

test("cancelled step shows Stopped", () => {
  let s = initialState(wf(["ingest", "cut"]), emptyStatus);
  s = reduce(s, [
    ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }),
    ev(2, { type: "step-start", step: "cut" }),
    ev(3, { type: "step-end", result: res("cut", "fail", { error: "cancelled by user" }) }),
    ev(4, { type: "run-end", status: "cancelled" }),
  ]);
  const cutCard = s.cards.find((c) => c.step === "cut")!;
  assert.equal(cutCard.state, "cancelled");
  assert.equal(s.running, false);
  assert.equal(s.outcome, "cancelled");
});

test("interrupted and awaiting review come from status; pending steps just wait", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    interrupted: ["cut"],
    pending: ["cut", "captions", "assemble"],
    steps: {
      ingest: res("ingest", "pass", { cached: true }),
      captions: res("captions", "pass", { awaitingApproval: true }),
    },
  };
  const s = initialState(wf(["ingest", "cut", "captions*", "assemble"]), status);
  assert.deepEqual(s.cards.map((c) => c.state), ["cached", "interrupted", "awaiting", "idle"]);
});

test("a failed project: failed step is Failed, never-run steps wait, nothing needs review", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    workflow: "short",
    state: "failed",
    pending: ["ingest", "transcribe", "captions", "assemble"],
    steps: { ingest: res("ingest", "fail", { error: "fileParam source must be an absolute path" }) },
  };
  const s = initialState(wf(["ingest", "transcribe", "captions*", "assemble"]), status);
  assert.deepEqual(s.cards.map((c) => c.state), ["fail", "idle", "idle", "idle"]);
  assert.equal(s.outcome, "failed");
  assert.equal(s.running, false);
});

test("outcome follows the server state", () => {
  const w = wf(["ingest", "captions*"]);
  assert.equal(initialState(w, { ...emptyStatus, state: "done" }).outcome, "done");
  assert.equal(initialState(w, { ...emptyStatus, state: "awaiting-approval" }).outcome, "awaiting-approval");
  assert.equal(initialState(w, { ...emptyStatus, state: "new" }).outcome, undefined);
  const running = initialState(w, { ...emptyStatus, running: true, state: "running" });
  assert.deepEqual([running.running, running.outcome], [true, undefined]);
});

test("reconcile rebuilds from the server after a run, keeping logs and the run error", () => {
  const w = wf(["ingest", "transcribe"]);
  let s = initialState(w, emptyStatus);
  s = reduce(s, [
    ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "auto" }),
    ev(2, { type: "step-start", step: "ingest" }),
    ev(3, { type: "log", step: "ingest", message: "probing" }),
  ]);
  // The run ended but its run-end never reached us; the server says it failed.
  const status: ProjectStatus = {
    ...emptyStatus,
    state: "failed",
    steps: { ingest: res("ingest", "fail", { error: "boom" }) },
  };
  const r = reconcile({ ...s, error: "boom" }, w, status);
  assert.deepEqual(
    [r.running, r.outcome, r.cards[0]!.state, r.cards[0]!.logs, r.lastEventId, r.mode, r.error],
    [false, "failed", "fail", ["probing"], 3, "auto", "boom"],
  );
});

test("elapsed and log cap", () => {
  assert.equal(elapsed({ state: "running", startedAt: 0 } as StepCard, 65_000), "1:05");
  assert.equal(elapsed({ state: "pass", durationMs: 4_000 } as StepCard, 0), "0:04");
  assert.equal(elapsed({ state: "idle" } as StepCard, 0), "");

  let s = initialState(wf(["ingest"]), emptyStatus);
  s = applyEvent(s, ev(1, { type: "step-start", step: "ingest" }));
  const logEvents: RunEvent[] = [];
  for (let i = 0; i < 450; i++) {
    logEvents.push(ev(i + 2, { type: "log", step: "ingest", message: `log ${i}` }));
  }
  s = reduce(s, logEvents);
  assert.equal(s.cards[0]!.logs.length, MAX_LOG_LINES);
  assert.equal(s.cards[0]!.logs[0], "log 50");
  assert.equal(s.cards[0]!.logs[399], "log 449");
});

test("log without step targets currently running card", () => {
  let s = initialState(wf(["ingest", "cut"]), emptyStatus);
  s = applyEvent(s, ev(1, { type: "step-start", step: "cut" }));
  s = applyEvent(s, ev(2, { type: "log", message: "cutting silences" }));
  const cutCard = s.cards.find((c) => c.step === "cut")!;
  assert.deepEqual(cutCard.logs, ["cutting silences"]);
  const ingestCard = s.cards.find((c) => c.step === "ingest")!;
  assert.deepEqual(ingestCard.logs, []);
});

test("step outside workflow appended in initialState and step-start", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    steps: {
      qa: res("qa", "pass"),
    },
  };
  let s = initialState(wf(["ingest"]), status);
  assert.equal(s.cards.length, 2);
  assert.equal(s.cards[0]!.step, "ingest");
  assert.equal(s.cards[1]!.step, "qa");
  assert.equal(s.cards[1]!.state, "pass");

  // Dynamically start a step not in workflow
  s = applyEvent(s, ev(1, { type: "step-start", step: "mix" }));
  assert.equal(s.cards.length, 3);
  assert.equal(s.cards[2]!.step, "mix");
  assert.equal(s.cards[2]!.state, "running");
});

test("run-end failed sets outcome and error", () => {
  let s = initialState(wf(["ingest"]), emptyStatus);
  s = applyEvent(s, ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }));
  s = applyEvent(s, ev(2, { type: "run-end", status: "failed", error: "ffmpeg crashed" }));
  assert.equal(s.running, false);
  assert.equal(s.outcome, "failed");
  assert.equal(s.error, "ffmpeg crashed");
});

test("a new workflow run puts every step back to waiting until it runs again", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    workflow: "short",
    state: "done",
    steps: { ingest: res("ingest", "pass"), transcribe: res("transcribe", "warn"), qa: res("qa", "pass") },
  };
  let s = initialState(wf(["ingest", "transcribe", "qa"]), status);
  assert.deepEqual(s.cards.map((c) => c.state), ["pass", "warn", "pass"]);

  s = applyEvent(s, ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "auto" }));
  assert.deepEqual(s.cards.map((c) => c.state), ["idle", "idle", "idle"]);
  assert.equal(s.cards[2]!.result, undefined, "the previous Check result is not shown as this run's");
  assert.equal(s.runKind, "workflow");

  s = applyEvent(s, ev(2, { type: "step-start", step: "ingest" }));
  assert.deepEqual(s.cards.map((c) => c.state), ["running", "idle", "idle"]);
});

test("a single-step run leaves the other steps as they were", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    workflow: "short",
    state: "done",
    steps: { ingest: res("ingest", "pass"), qa: res("qa", "pass") },
  };
  let s = initialState(wf(["ingest", "qa"]), status);
  s = applyEvent(s, ev(1, { type: "run-start", kind: "step", name: "ingest", mode: "manual" }));
  assert.deepEqual(s.cards.map((c) => c.state), ["pass", "pass"]);
  assert.equal(s.runKind, "step");
});

test("a failed check the user accepted shows as accepted, from status, the accept event and the run", () => {
  const status: ProjectStatus = {
    ...emptyStatus,
    workflow: "short",
    state: "new",
    steps: { mix: res("mix", "fail", { accepted: true }) },
  };
  assert.deepEqual(initialState(wf(["mix", "assemble"]), status).cards.map((c) => c.state), ["accepted", "idle"]);

  const failed = initialState(wf(["mix", "assemble"]), { ...status, state: "failed", steps: { mix: res("mix", "fail") } });
  assert.equal(failed.cards[0]!.state, "fail");
  const afterAccept = applyEvent(failed, ev(1, { type: "accepted", step: "mix" }));
  assert.equal(afterAccept.cards[0]!.state, "accepted");

  let s = applyEvent(afterAccept, ev(2, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }));
  s = applyEvent(s, ev(3, { type: "step-start", step: "mix" }));
  s = applyEvent(s, ev(4, { type: "step-end", result: { ...res("mix", "fail"), cached: true, accepted: true } }));
  assert.equal(s.cards[0]!.state, "accepted");
});
