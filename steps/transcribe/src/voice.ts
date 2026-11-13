import type { Word } from "../../../core/src/index.ts";

/** Words longer than this are checked against the audio: real Darija words rarely last over a second. */
export const MAX_WORD_SEC = 1.0;
/** A window is voiced when it is within this many dB of the speech level (90th percentile of the envelope). */
export const VOICE_DROP_DB = 25;
const MIN_WORD_SEC = 0.15;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Speech level minus VOICE_DROP_DB, floored at -60 dBFS. */
export function voiceThreshold(env: Float32Array): number {
  const finite = Array.from(env).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return -60;
  const p90 = finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.9))] as number;
  return Math.max(-60, p90 - VOICE_DROP_DB);
}

/**
 * ASR word timings can stretch a word over a long silence (a 12 s "شوف" over a silent opening), which makes
 * the cut keep the silence. For each word longer than MAX_WORD_SEC, move its start to the first voiced window
 * and its end to the last voiced window inside it. Only shrinks; keeps at least MIN_WORD_SEC; words with no
 * voiced window are left alone (the cut decides). Order and monotonic timings are preserved.
 */
export function tightenToVoice(words: Word[], env: Float32Array, windowMs: number): { words: Word[]; tightened: number } {
  const thr = voiceThreshold(env);
  const sec = windowMs / 1000;
  let tightened = 0;
  const out = words.map((w) => {
    if (w.end - w.start <= MAX_WORD_SEC) return w;
    const a = Math.max(0, Math.floor(w.start / sec));
    const b = Math.min(env.length - 1, Math.ceil(w.end / sec) - 1);
    let first = -1;
    let last = -1;
    for (let i = a; i <= b; i++) {
      if ((env[i] as number) >= thr) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return w;
    let start = Math.max(w.start, first * sec);
    let end = Math.min(w.end, (last + 1) * sec);
    if (end - start < MIN_WORD_SEC) {
      end = Math.min(w.end, start + MIN_WORD_SEC);
      start = Math.max(w.start, end - MIN_WORD_SEC);
    }
    if (start === w.start && end === w.end) return w;
    tightened++;
    return { ...w, start: round3(start), end: round3(end) };
  });
  return { words: out, tightened };
}
