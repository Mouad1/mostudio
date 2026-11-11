import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "./providers/openai-compat.ts";
import { clampKeeps, durationBound, keepDuration, mapToCut, normalizeWordTimings } from "./timeline.ts";

const W = (w: string, start: number, end: number): Word => ({ w, start, end });

const keep = [
  { start: 0, end: 2 },
  { start: 4, end: 6 },
];

test("mapToCut shifts by removed time", () => assert.equal(mapToCut(5, keep), 3));
test("mapToCut inside removed part is undefined", () => assert.equal(mapToCut(3, keep), undefined));
test("mapToCut maps a keep's end inclusively", () => {
  assert.equal(mapToCut(2, keep), 2);
  assert.equal(mapToCut(6, keep), 4);
  assert.equal(mapToCut(0, keep), 0);
});
test("mapToCut outside all keeps is undefined", () => {
  assert.equal(mapToCut(-1, keep), undefined);
  assert.equal(mapToCut(7, keep), undefined);
  assert.equal(mapToCut(1, []), undefined);
});
test("keepDuration sums ranges", () =>
  assert.equal(keepDuration([{ start: 0, end: 2 }, { start: 4, end: 6.5 }]), 4.5));

test("normalizeWordTimings keeps transcript order and makes timings monotonic", () => {
  // Groq pattern: "with" starts before "skin" and spans past it
  const raw = [W("the", 65.92, 66.1), W("skin", 66.1, 66.38), { w: "with", start: 65.9, end: 66.98, conf: 0.8 }, W("a", 66.98, 67.12)];
  const n = normalizeWordTimings(raw);
  assert.deepEqual(n.map((w) => w.w), ["the", "skin", "with", "a"]);
  assert.deepEqual(n[2], { w: "with", start: 66.38, end: 66.98, conf: 0.8 });
  // partial overlap: start clamped to the previous end
  assert.deepEqual(normalizeWordTimings([W("margins", 25.48, 26.48), W("while", 26, 26.82)])[1], W("while", 26.48, 26.82));
  // fully nested: zero length at the previous end
  assert.deepEqual(normalizeWordTimings([W("areas", 51.7, 52.88), W("we", 52.7, 52.8), W("go", 53, 53.2)]).slice(1), [W("we", 52.88, 52.88), W("go", 53, 53.2)]);
  for (let i = 1; i < n.length; i++) assert.ok((n[i] as Word).start >= (n[i - 1] as Word).end);
  assert.deepEqual(normalizeWordTimings(n), n, "idempotent");
  assert.equal(raw[2]?.start, 65.9, "input not mutated");
});

test("normalizeWordTimings passes untimed words through without poisoning the rest", () => {
  const n = normalizeWordTimings([W("a", 1, 2), W("b", Number.NaN, Number.NaN), W("c", 1.5, 3)]);
  assert.ok(Number.isNaN(n[1]?.start));
  assert.deepEqual(n[2], W("c", 2, 3));
});

test("durationBound is the smallest positive finite value", () => {
  assert.equal(durationBound(10, 9.5, undefined, 0, Number.NaN), 9.5);
  assert.equal(durationBound(undefined, 0), Infinity);
});

test("clampKeeps cuts ranges at the bound and reports changes", () => {
  assert.deepEqual(clampKeeps([{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 8 }], 5), {
    keep: [{ start: 0, end: 2 }, { start: 4, end: 5 }],
    clamped: true,
  });
  assert.deepEqual(clampKeeps([{ start: 0, end: 2 }], Infinity), { keep: [{ start: 0, end: 2 }], clamped: false });
});
