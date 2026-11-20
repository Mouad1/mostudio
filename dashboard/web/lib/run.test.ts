import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineState } from "./pipeline.ts";
import { buildRunRequest, defaultSpokenLanguage, modeCopy, primaryAction } from "./run.ts";

function ps(partial: Partial<PipelineState>): PipelineState {
  return {
    mode: "manual",
    running: false,
    cards: [],
    lastEventId: 0,
    ...partial,
  };
}

test("buildRunRequest drops unset values and keeps empty ones (an empty value forgets a remembered one)", () => {
  assert.deepEqual(
    buildRunRequest({
      workflow: "short",
      mode: "auto",
      source: "uploads/a.mov",
      params: { localize: { lang: "arabizi", prefer: undefined }, cut: { pace: "" } },
    }),
    {
      workflow: "short",
      mode: "auto",
      source: "uploads/a.mov",
      params: { localize: { lang: "arabizi" }, cut: { pace: "" } },
    }
  );
});

test("buildRunRequest omits empty source and empty params", () => {
  assert.deepEqual(
    buildRunRequest({
      workflow: "short",
      mode: "manual",
      source: "",
      params: { cut: { pace: undefined } },
    }),
    {
      workflow: "short",
      mode: "manual",
    }
  );
  assert.deepEqual(
    buildRunRequest({
      workflow: "reel",
      mode: "auto",
      source: undefined,
      params: {},
    }),
    {
      workflow: "reel",
      mode: "auto",
    }
  );
});

test("primaryAction", () => {
  assert.equal(primaryAction(ps({ running: true }), true), "stop");
  assert.equal(primaryAction(ps({ running: true }), false), "stop");
  assert.equal(primaryAction(ps({ outcome: "awaiting-approval" }), true), "continue");
  assert.equal(primaryAction(ps({ outcome: "awaiting-approval" }), false), "continue");
  assert.equal(
    primaryAction(
      ps({
        cards: [
          {
            step: "captions",
            approve: true,
            state: "awaiting",
            logs: [],
          },
        ],
      }),
      true
    ),
    "continue"
  );
  assert.equal(primaryAction(ps({}), false), "none");
  assert.equal(primaryAction(ps({}), true), "start");
  assert.equal(primaryAction(ps({ outcome: "done" }), true), "start-over");
  assert.equal(primaryAction(ps({ outcome: "failed" }), true), "retry");
  assert.equal(primaryAction(ps({ outcome: "failed" }), false), "retry");
  assert.equal(primaryAction(ps({ outcome: "cancelled" }), true), "retry");
  assert.equal(
    primaryAction(ps({ cards: [{ step: "ingest", approve: false, state: "interrupted", logs: [] }] }), true),
    "retry"
  );
  assert.equal(primaryAction(ps({ running: true, outcome: "failed" }), true), "stop");
});

test("modeCopy returns expected title and help", () => {
  const manual = modeCopy("manual");
  assert.equal(manual.title, "Review before finishing");
  assert.equal(
    manual.help,
    "mostudio pauses at the captions so you can fix words before the video is rendered."
  );

  const auto = modeCopy("auto");
  assert.equal(auto.title, "Do it all for me");
  assert.equal(
    auto.help,
    "mostudio makes the whole video without pausing. If a step fails its quality check, it still stops and tells you why."
  );
});

test("auto copy is honest about failing steps", () => {
  assert.match(modeCopy("auto").help, /still stops/);
});

test("buildRunRequest: Darija sends transcribe.dialect, Auto-detect clears a remembered one", () => {
  assert.deepEqual(
    buildRunRequest({ workflow: "short", mode: "manual", params: {}, spoken: "darija" }).params,
    { transcribe: { dialect: "darija" } }
  );
  // An empty value is how the server forgets a remembered param; it must survive the empty-drop.
  assert.deepEqual(
    buildRunRequest({ workflow: "short", mode: "manual", params: { cut: { pace: undefined } }, spoken: "auto" }).params,
    { transcribe: { dialect: "" } }
  );
  assert.equal(buildRunRequest({ workflow: "short", mode: "manual", params: {} }).params, undefined);
});

test("defaultSpokenLanguage: Darija for Arabizi subtitles, else the project's remembered choice, else Auto", () => {
  assert.equal(defaultSpokenLanguage("arabizi", undefined), "darija");
  assert.equal(defaultSpokenLanguage("", { localize: { lang: "arabizi" } }), "darija");
  assert.equal(defaultSpokenLanguage("fr", { transcribe: { dialect: "darija" } }), "darija");
  assert.equal(defaultSpokenLanguage("fr", { localize: { lang: "arabizi" } }), "auto");
  assert.equal(defaultSpokenLanguage("", undefined), "auto");
});
