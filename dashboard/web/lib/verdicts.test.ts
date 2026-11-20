import assert from "node:assert/strict";
import test from "node:test";
import type { StepView } from "../../src/types.ts";
import { canAccept, checkDetails, explainVerdict, gateNotes, missedChecks } from "./verdicts.ts";

function result(step: string, verdicts: StepView["verdicts"]): StepView {
  return {
    step,
    status: "warn",
    startedAt: "",
    endedAt: "",
    durationMs: 0,
    inputsHash: "h",
    metrics: {},
    verdicts,
    artifacts: [],
  };
}

test("known gates read as plain sentences", () => {
  assert.equal(
    explainVerdict("transcribe", {
      metric: "meanConfidence",
      actual: 0.6789,
      threshold: { metric: "meanConfidence", op: ">=", value: 0.7, level: "warn" },
      ok: false,
    }),
    "Transcription confidence 0.68 (aim ≥ 0.7): check the captions closely."
  );
  assert.equal(
    explainVerdict("mix", {
      metric: "integratedLufs",
      actual: -16.2,
      threshold: { metric: "integratedLufs", op: "between", value: [-15, -13], level: "fail" },
      ok: false,
    }),
    "Loudness -16.2 LUFS (aim between -15 and -13)."
  );
});

test("unknown gates fall back to metric, actual and target", () => {
  assert.equal(
    explainVerdict("x", {
      metric: "weirdness",
      actual: 3,
      threshold: { metric: "weirdness", op: "<=", value: 2, level: "warn" },
      ok: false,
    }),
    "weirdness 3 vs target ≤ 2"
  );
});

test("gateNotes lists only the gates that were missed", () => {
  const notes = gateNotes(
    result("chapters", [
      { metric: "firstAtZero", actual: true, threshold: { metric: "firstAtZero", op: "==", value: true, level: "fail" }, ok: true },
      { metric: "fallback", actual: true, threshold: { metric: "fallback", op: "==", value: false, level: "warn" }, ok: false },
    ])
  );
  assert.deepEqual(notes, [
    { level: "warn", text: "No AI provider answered, so chapters were placed at pauses with simple titles." },
  ]);
  assert.deepEqual(gateNotes(undefined), []);
});

const drift = (ok: boolean): StepView["verdicts"][number] => ({
  metric: "driftSec",
  actual: 0.033,
  threshold: { metric: "driftSec", op: "<=", value: 0.02, level: "fail" },
  ok,
});

test("canAccept: only a finished step that missed a must-pass check", () => {
  assert.equal(canAccept({ ...result("mix", [drift(false)]), status: "fail" }), true);
  assert.equal(canAccept({ ...result("mix", [drift(true)]), status: "pass" }), false);
  // a crash or a missing output has no verdicts; a validation error has no inputs hash
  assert.equal(canAccept({ ...result("mix", []), status: "fail", error: "ffmpeg died" }), false);
  assert.equal(canAccept({ ...result("mix", [drift(false)]), status: "fail", inputsHash: "" }), false);
  assert.equal(canAccept(undefined), false);
});

test("missedChecks: plain sentence plus what you can do", () => {
  const missed = missedChecks({ ...result("mix", [drift(false)]), status: "fail" });
  assert.equal(missed.length, 1);
  assert.equal(missed[0]?.text, "Sound drifts 0.03s from the picture (aim ≤ 0.02s).");
  assert.match(missed[0]?.hint ?? "", /lips/);
  // a check without a hint still reads plainly
  const other = missedChecks({
    ...result("x", [{ metric: "score", actual: 5, threshold: { metric: "score", op: ">=", value: 10, level: "fail" }, ok: false }]),
    status: "fail",
  });
  assert.deepEqual(other, [{ text: "score 5 vs target ≥ 10" }]);
});

test("checkDetails lists every check with its measured value", () => {
  const lines = checkDetails({
    ...result("mix", [
      drift(false),
      { metric: "integratedLufs", actual: -14, threshold: { metric: "integratedLufs", op: "between", value: [-15, -13], level: "fail" }, ok: true },
    ]),
    status: "fail",
  });
  assert.deepEqual(lines, ["✗ driftSec = 0.03 (target ≤ 0.02)", "✓ integratedLufs = -14 (target between -15 and -13)"]);
});
