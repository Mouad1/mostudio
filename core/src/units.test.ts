import assert from "node:assert/strict";
import { test } from "node:test";
import { unitsToWords } from "./units.ts";

test("unitsToWords spreads tokens over the unit by length", () => {
  const words = unitsToWords([{ id: 1, start: 1, end: 2, text: "ab  abcd\tab", src: "x" }]);
  assert.deepEqual(words.map((w) => w.w), ["ab", "abcd", "ab"]);
  assert.deepEqual(words.map((w) => [w.start, w.end]), [[1, 1.25], [1.25, 1.75], [1.75, 2]]);
});

test("unitsToWords is monotonic across units, end > start, last token at unit end", () => {
  const words = unitsToWords([
    { id: 1, start: 0, end: 0.9, text: "salam 3likom a sahbi", src: "" },
    { id: 2, start: 1.4, end: 3.333, text: "daba ghadi nchr7 lkom l'outil", src: "" },
  ]);
  for (const [i, w] of words.entries()) {
    assert.ok(w.end > w.start, `token ${i}`);
    if (i > 0) assert.ok(w.start >= (words[i - 1]?.end as number), `token ${i} start`);
  }
  assert.equal(words[3]?.end, 0.9);
  assert.equal(words.at(-1)?.end, 3.333);
  assert.equal(words[4]?.start, 1.4);
});

test("unitsToWords skips empty text and survives a zero-length unit", () => {
  assert.deepEqual(unitsToWords([{ id: 1, start: 0, end: 1, text: "   ", src: "" }]), []);
  const words = unitsToWords([{ id: 2, start: 5, end: 5, text: "a b", src: "" }]);
  assert.equal(words.length, 2);
  for (const w of words) assert.ok(w.end > w.start);
  assert.equal(words[0]?.start, 5);
});

test("unitsToWords keeps 1 ms per token on a very short unit", () => {
  const words = unitsToWords([{ id: 1, start: 0, end: 0.004, text: "aaaaaaaaaa b c d", src: "" }]);
  for (const w of words) assert.ok(w.end > w.start, JSON.stringify(words));
  assert.equal(words.at(-1)?.end, 0.004);
});
