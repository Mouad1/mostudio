import assert from "node:assert/strict";
import { test } from "node:test";
import { capWordDurations, MAX_WORD_SEC, unitsToWords } from "./units.ts";

test("capWordDurations: a word stretched over a pause keeps the side that touches speech", () => {
  const W = (w: string, start: number, end: number) => ({ w, start, end });
  // leading silence (first word, next word right after): the sound is at the end
  const lead = capWordDurations([W("شوف", 6.51, 12.78), W("ماشي", 12.78, 13)]);
  assert.deepEqual(lead[0], { w: "شوف", start: 11.58, end: 12.78 });
  assert.deepEqual(lead[1], { w: "ماشي", start: 12.78, end: 13 });
  // trailing silence (previous word right before, gap after): the sound is at the start
  const trail = capWordDurations([W("ana", 1.6, 2.18), W("kankhdem", 2.18, 8.56), W("daba", 8.6, 9)]);
  assert.deepEqual(trail[1], { w: "kankhdem", start: 2.18, end: 3.38 });
  // touching speech on both sides: ASR puts a pause at the start of the word after it, so keep the end
  const both = capWordDurations([W("a", 0, 1), W("b", 1, 4), W("c", 4, 4.5)]);
  assert.deepEqual(both[1], { w: "b", start: 2.8, end: 4 });
});

test("capWordDurations leaves short and untimed words alone, never reorders, is idempotent", () => {
  const words = [{ w: "a", start: 0, end: 1.2 }, { w: "x", start: Number.NaN, end: Number.NaN }, { w: "b", start: 1.3, end: 1.5, conf: 0.9 }];
  const out = capWordDurations(words);
  assert.equal(out[0], words[0]);
  assert.equal(out[1], words[1]);
  assert.equal(out[2], words[2]);
  const once = capWordDurations([{ w: "a", start: 0, end: 9 }, { w: "b", start: 9.5, end: 10 }]);
  assert.deepEqual(capWordDurations(once), once);
  for (const w of once) assert.ok(w.end - w.start <= MAX_WORD_SEC + 1e-9);
});

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
