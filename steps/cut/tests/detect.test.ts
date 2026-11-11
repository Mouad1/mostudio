import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../../../core/src/index.ts";
import { fillerWords, keepRanges, midWordCuts, normalizeTimings, retakeSpans } from "../src/detect.ts";

const FILLERS = ["euh", "heu", "hum", "hmm", "um", "uh", "erm", "ah", "eh", "bah"];
const W = (w: string, start: number, end: number): Word => ({ w, start, end });
const opts = (o: Partial<{ maxGap: number; pre: number; post: number; minKeep: number; durationSec: number }> = {}) => ({
  maxGap: 0.45,
  pre: 0.1,
  post: 0.15,
  minKeep: 0.3,
  durationSec: 20,
  ...o,
});

test("gap above maxGap is removed", () => {
  const words = [W("bonjour", 1, 1.5), W("tout", 1.6, 2), W("le", 3.5, 3.7), W("monde", 3.8, 4.4)];
  const keep = keepRanges(words, new Set(), opts());
  assert.equal(keep.length, 2);
  assert.deepEqual(keep[0], { start: 0.9, end: 2.15 });
  assert.deepEqual(keep[1], { start: 3.4, end: 4.55 });
});

test("tight pace removes a 0.3 s gap that natural keeps", () => {
  const words = [W("a", 1, 1.5), W("b", 1.5, 2), W("c", 2.3, 2.8), W("d", 2.8, 3.3)];
  assert.equal(keepRanges(words, new Set(), opts()).length, 1);
  const tight = keepRanges(words, new Set(), opts({ maxGap: 0.25, pre: 0.05, post: 0.08 }));
  assert.equal(tight.length, 2);
});

test("filler words are removed", () => {
  const words = [W("on", 1, 1.2), W("va", 1.2, 1.5), W("Euh,", 1.6, 2.4), W("voir", 2.5, 3), W("hmmm", 3.1, 3.9), W("bien", 4, 4.5)];
  assert.deepEqual(fillerWords(words, FILLERS), [2, 4]);
  const keep = keepRanges(words, new Set([2, 4]), opts());
  for (const k of keep) {
    assert.ok(!(k.start < 2.4 && k.end > 1.6 && k.end - k.start > 0 && k.start > 1.6 && k.end < 2.4));
  }
  assert.ok(keep.every((k) => !(k.start <= 1.7 && k.end >= 2.3)), "filler 1.6-2.4 fully inside a keep");
  assert.equal(midWordCuts(keep, words, new Set([2, 4])), 0);
});

test("filler matching keeps real words and accents", () => {
  assert.deepEqual(fillerWords([W("umbrella", 0, 1), W("ah!", 1, 1.2), W("euuuh", 1.3, 1.6), W("été", 2, 2.2), W("", 2.3, 2.4)], FILLERS), [1, 2]);
});

test("earlier take is dropped, last take kept", () => {
  const words = [
    W("on", 1, 1.2), W("va", 1.2, 1.4), W("voir", 1.4, 1.8),
    W("on", 4, 4.2), W("va", 4.2, 4.4), W("voir", 4.4, 4.8), W("comment", 4.9, 5.4),
  ];
  const spans = retakeSpans(words, 20, 3);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], { start: 1, end: 1.8 });
});

test("retake chain A A A keeps only the last", () => {
  const A = (t: number): Word[] => [W("on", t, t + 0.2), W("va", t + 0.2, t + 0.4), W("voir", t + 0.4, t + 0.8)];
  const words = [...A(1), ...A(3), ...A(5)];
  const spans = retakeSpans(words, 20, 3);
  assert.deepEqual(spans, [{ start: 1, end: 3.8 }]);
});

test("short phrases and far-away repeats never trigger a retake", () => {
  const short = [W("oui", 1, 1.2), W("non", 1.2, 1.4), W("oui", 3, 3.2), W("non", 3.2, 3.4)];
  assert.deepEqual(retakeSpans(short, 20, 3), []);
  const far = [W("on", 1, 1.2), W("va", 1.2, 1.4), W("voir", 1.4, 1.8), W("on", 30, 30.2), W("va", 30.2, 30.4), W("voir", 30.4, 30.8)];
  assert.deepEqual(retakeSpans(far, 20, 3), []);
});

test("boundaries never land inside a word", () => {
  const words: Word[] = [];
  let t = 0.5;
  for (let i = 0; i < 40; i++) {
    const d = 0.15 + (i % 4) * 0.05;
    words.push(W(`w${i}`, t, t + d));
    t += d + [0.02, 0.2, 0.5, 0.8, 0.05][i % 5];
  }
  const keep = keepRanges(words, new Set([3, 9, 17]), opts({ durationSec: t + 1 }));
  assert.equal(midWordCuts(keep, words, new Set([3, 9, 17])), 0);
  assert.equal(midWordCuts([{ start: 1.1, end: 2 }], [W("x", 1, 1.5)]), 1);
});

test("edl keep ranges sorted, non-overlapping, within duration", () => {
  const words = [W("a", 0.02, 0.2), W("b", 5, 5.02), W("c", 9, 9.5), W("d", 9.6, 10)];
  const keep = keepRanges(words, new Set(), opts({ durationSec: 10.05 }));
  assert.equal(keep.length, 3);
  assert.ok(keep[0] && keep[0].start >= 0 && (keep.at(-1) as { end: number }).end <= 10.05);
  for (let i = 1; i < keep.length; i++) assert.ok((keep[i] as { start: number }).start > (keep[i - 1] as { end: number }).end);
});

test("isolated 0.1 s word survives under tight and is extended toward minKeep", () => {
  const words = [W("bonjour", 1, 1.5), W("oui", 5, 5.1), W("merci", 9, 9.5)];
  const keep = keepRanges(words, new Set(), opts({ maxGap: 0.25, pre: 0.05, post: 0.08 }));
  assert.equal(keep.length, 3);
  const k = keep[1] as { start: number; end: number };
  assert.ok(k.start <= 5 && k.end >= 5.1);
  assert.ok(k.end - k.start >= 0.3 - 1e-9, `len ${k.end - k.start}`);
});

test("euh [oui] euh keeps oui, without entering the fillers", () => {
  const words = [W("euh", 1, 1.4), W("oui", 1.5, 1.6), W("euh", 1.7, 2.1)];
  const keep = keepRanges(words, new Set([0, 2]), opts());
  assert.equal(keep.length, 1);
  const k = keep[0] as { start: number; end: number };
  assert.ok(k.start >= 1.4 && k.start <= 1.5 && k.end >= 1.6 && k.end <= 1.7, JSON.stringify(k));
});

test("keep with no room to grow is kept as is", () => {
  const words = [W("a", 1, 1.1), W("b", 1.12, 1.2), W("c", 1.22, 1.3)];
  const keep = keepRanges(words, new Set([0, 2]), opts({ pre: 0.5, post: 0.5 }));
  assert.equal(keep.length, 1);
});

test("retake window: same opening 15 s apart is not removed", () => {
  const words = [W("on", 1, 1.2), W("va", 1.2, 1.4), W("voir", 1.4, 1.8), W("on", 16, 16.2), W("va", 16.2, 16.4), W("voir", 16.4, 16.8)];
  assert.deepEqual(retakeSpans(words, 8, 3), []);
  assert.equal(retakeSpans(words, 20, 3).length, 1);
});

test("retake matching does not collapse letter runs", () => {
  const A = (t: number, w: string): Word[] => [W("on", t, t + 0.2), W("va", t + 0.2, t + 0.4), W(w, t + 0.4, t + 0.8)];
  assert.deepEqual(retakeSpans([...A(1, "pas"), ...A(3, "passs")], 8, 3), []);
});

test("soft fillers: ah in a continuous phrase is kept, isolated ah is removed", () => {
  const phrase = [W("ah", 1, 1.2), W("bon", 1.25, 1.6), W("alors", 1.65, 2)];
  assert.deepEqual(fillerWords(phrase, { always: ["euh"], isolated: ["ah", "eh", "bah"] }), []);
  const iso = [W("alors", 1, 1.4), W("ah", 2, 2.2), W("bon", 2.25, 2.6)];
  assert.deepEqual(fillerWords(iso, { always: ["euh"], isolated: ["ah"] }), [1]);
  const long = [W("alors", 1, 1.4), W("ah", 2, 2.6), W("bon", 3.2, 3.5)];
  assert.deepEqual(fillerWords(long, { always: ["euh"], isolated: ["ah"] }), []);
});

test("empty input gives no keeps", () => {
  assert.deepEqual(keepRanges([], new Set(), opts()), []);
});

test("normalizeTimings keeps transcript order and makes timings monotonic", () => {
  // Groq pattern: "with" starts before "skin" and spans past it
  const raw = [W("the", 65.92, 66.1), W("skin", 66.1, 66.38), { w: "with", start: 65.9, end: 66.98, conf: 0.8 }, W("a", 66.98, 67.12)];
  const n = normalizeTimings(raw);
  assert.deepEqual(n.map((w) => w.w), ["the", "skin", "with", "a"]);
  assert.deepEqual(n[2], { w: "with", start: 66.38, end: 66.98, conf: 0.8 });
  // partial overlap: start clamped to the previous end
  assert.deepEqual(normalizeTimings([W("margins", 25.48, 26.48), W("while", 26, 26.82)])[1], W("while", 26.48, 26.82));
  // fully nested: zero length at the previous end
  assert.deepEqual(normalizeTimings([W("areas", 51.7, 52.88), W("we", 52.7, 52.8), W("go", 53, 53.2)]).slice(1), [W("we", 52.88, 52.88), W("go", 53, 53.2)]);
  for (let i = 1; i < n.length; i++) assert.ok((n[i] as Word).start >= (n[i - 1] as Word).end);
  assert.deepEqual(normalizeTimings(n), n, "idempotent");
  assert.equal(raw[2]?.start, 65.9, "input not mutated");
});

test("a word starting before its predecessor never gets a cut inside it", () => {
  const raw = [W("on", 65.76, 65.92), W("the", 65.92, 66.1), W("skin", 66.1, 66.38), W("with", 65.9, 66.98), W("a", 66.98, 67.12), W("fair", 67.12, 67.32)];
  for (const pace of [opts(), opts({ maxGap: 0.25, pre: 0.05, post: 0.08 })]) {
    const keep = keepRanges(normalizeTimings(raw), new Set(), pace);
    assert.equal(keep.length, 1, JSON.stringify(keep));
    assert.equal(midWordCuts(keep, raw), 0, JSON.stringify(keep));
  }
});
