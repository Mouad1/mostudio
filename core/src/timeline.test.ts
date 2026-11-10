import assert from "node:assert/strict";
import { test } from "node:test";
import { keepDuration, mapToCut } from "./timeline.ts";

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
