import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGate, mergeThresholds } from "./gate.ts";
import type { Threshold } from "./types.ts";

const lufs: Threshold = { metric: "integratedLufs", op: "between", value: [-15, -13], level: "fail" };
const speed: Threshold = { metric: "readingSpeed", op: "<=", value: 17, level: "warn" };

test("inside range passes", () => assert.equal(evaluateGate({ integratedLufs: -14.2 }, [lufs]).status, "pass"));
test("outside range fails", () => assert.equal(evaluateGate({ integratedLufs: -11 }, [lufs]).status, "fail"));
test("warn-only breach gives warn", () => assert.equal(evaluateGate({ readingSpeed: 19 }, [speed]).status, "warn"));
test("a missing metric fails its threshold", () => assert.equal(evaluateGate({}, [lufs]).verdicts[0].ok, false));
test("fail wins over warn", () => {
  const r = evaluateGate({ readingSpeed: 19, integratedLufs: -11 }, [speed, lufs]);
  assert.equal(r.status, "fail");
});
test("between is inclusive on both ends", () => {
  assert.equal(evaluateGate({ integratedLufs: -15 }, [lufs]).status, "pass");
  assert.equal(evaluateGate({ integratedLufs: -13 }, [lufs]).status, "pass");
});
test("type mismatch is not ok and does not throw", () => {
  assert.equal(evaluateGate({ integratedLufs: "loud" }, [lufs]).verdicts[0].ok, false);
  const bad: Threshold = { metric: "m", op: "between", value: 5, level: "fail" };
  assert.equal(evaluateGate({ m: 5 }, [bad]).verdicts[0].ok, false);
  const bad2: Threshold = { metric: "m", op: "<", value: "x", level: "fail" };
  assert.equal(evaluateGate({ m: 5 }, [bad2]).verdicts[0].ok, false);
});
test("== uses strict equality", () => {
  const t: Threshold = { metric: "codec", op: "==", value: "h264", level: "fail" };
  assert.equal(evaluateGate({ codec: "h264" }, [t]).status, "pass");
  assert.equal(evaluateGate({ codec: "hevc" }, [t]).status, "fail");
  const n: Threshold = { metric: "n", op: "==", value: 1, level: "fail" };
  assert.equal(evaluateGate({ n: "1" }, [n]).status, "fail");
});
test("empty thresholds pass", () => {
  assert.deepEqual(evaluateGate({ a: 1 }, []), { status: "pass", verdicts: [] });
});
test("verdict order follows threshold order", () => {
  const r = evaluateGate({ readingSpeed: 1, integratedLufs: -14 }, [speed, lufs]);
  assert.deepEqual(r.verdicts.map((v) => v.metric), ["readingSpeed", "integratedLufs"]);
});
test("mergeThresholds overrides by metric+level", () => {
  const o: Threshold = { ...lufs, value: [-16, -12] };
  assert.deepEqual(mergeThresholds([lufs], [o]), [o]);
});
test("mergeThresholds keeps position and appends unmatched", () => {
  const o: Threshold = { ...lufs, value: [-16, -12] };
  const extra: Threshold = { metric: "x", op: ">", value: 1, level: "warn" };
  const sameMetricOtherLevel: Threshold = { ...speed, level: "fail" };
  assert.deepEqual(mergeThresholds([lufs, speed], [extra, o, sameMetricOtherLevel]), [o, speed, extra, sameMetricOtherLevel]);
});
