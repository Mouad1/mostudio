import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineState } from "./pipeline.ts";
import { buildRunRequest, modeCopy, primaryAction } from "./run.ts";

function ps(partial: Partial<PipelineState>): PipelineState {
  return {
    mode: "manual",
    running: false,
    cards: [],
    lastEventId: 0,
    ...partial,
  };
}

test("buildRunRequest drops empties", () => {
  assert.deepEqual(
    buildRunRequest({
      workflow: "short",
      mode: "auto",
      source: "uploads/a.mov",
      params: { localize: { lang: "arabizi", prefer: "" }, cut: { pace: "" } },
    }),
    {
      workflow: "short",
      mode: "auto",
      source: "uploads/a.mov",
      params: { localize: { lang: "arabizi" } },
    }
  );
});

test("buildRunRequest omits empty source and empty params", () => {
  assert.deepEqual(
    buildRunRequest({
      workflow: "short",
      mode: "manual",
      source: "",
      params: { cut: { pace: "" } },
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
  assert.equal(primaryAction(ps({ outcome: "failed" }), true), "start");
  assert.equal(primaryAction(ps({ outcome: "cancelled" }), true), "start");
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
