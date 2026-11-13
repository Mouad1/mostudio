import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WORD_SEC, tightenToVoice, voiceThreshold } from "../src/voice.ts";

const WIN = 10;
/** Envelope of `sec` seconds at -70 dB with voiced spans [from, to) at -20 dB. */
function env(sec: number, voiced: [number, number][]): Float32Array {
  const e = new Float32Array(Math.round((sec * 1000) / WIN)).fill(-70);
  for (const [from, to] of voiced) for (let i = Math.round((from * 1000) / WIN); i < Math.round((to * 1000) / WIN); i++) e[i] = -20;
  return e;
}

test("voiceThreshold is speech level minus 25 dB, floored at -60", () => {
  assert.equal(voiceThreshold(env(10, [[0, 10]])), -45);
  assert.equal(voiceThreshold(new Float32Array(10).fill(-90)), -60);
  assert.equal(voiceThreshold(new Float32Array(0)), -60);
});

test("a word stretched over a silent opening is moved to its voiced part", () => {
  const e = env(15, [[12.4, 12.8], [12.9, 14]]);
  const { words, tightened } = tightenToVoice([{ w: "شوف", start: 0, end: 12.78, conf: 0.7 }, { w: "ماشي", start: 12.9, end: 13.1 }], e, WIN);
  assert.equal(tightened, 1);
  assert.deepEqual(words[0], { w: "شوف", start: 12.4, end: 12.78, conf: 0.7 });
  assert.deepEqual(words[1], { w: "ماشي", start: 12.9, end: 13.1 });
});

test("short words, fully voiced long words and words with no voice are unchanged", () => {
  const e = env(10, [[2, 4]]);
  const short = { w: "a", start: 0, end: MAX_WORD_SEC };
  const voiced = { w: "b", start: 2, end: 4 };
  const silent = { w: "c", start: 5, end: 8 };
  const r = tightenToVoice([short, voiced, silent], e, WIN);
  assert.equal(r.tightened, 0);
  assert.deepEqual(r.words, [short, voiced, silent]);
});

test("keeps at least 0.15 s and never grows a word", () => {
  const e = env(10, [[3, 3.02]]);
  const { words } = tightenToVoice([{ w: "x", start: 1, end: 3.05 }], e, WIN);
  const w = words[0] as { start: number; end: number };
  assert.ok(w.end - w.start >= 0.15 - 1e-9);
  assert.ok(w.start >= 1 && w.end <= 3.05);
});
