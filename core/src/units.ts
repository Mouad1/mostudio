import type { Word } from "./providers/openai-compat.ts";

/** A caption/subtitle line on the cut timeline (seconds): `text` is what is shown, `src` the source-language words it came from. */
export type Unit = { id: number; start: number; end: number; text: string; src: string };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Shortest span per token when a unit has no usable duration, so every token still has end > start. */
const MIN_TOKEN_SEC = 0.01;
/** Longest a single spoken word is believed to last; ASR words longer than this are stretched over a pause. */
export const MAX_WORD_SEC = 1.2;

/**
 * Words (transcript order, normalized timings) with every word longer than `maxSec` shrunk to `maxSec`. ASR word
 * timestamps often swallow a pause: the word after a silence starts when the silence starts (6 s of lead-in on the
 * first word is common), or a word's end runs on into the silence after it. Left alone, a unit and its caption stay
 * on screen for the whole pause. The shrunk word keeps the side that touches speech: its start when the gap after
 * it is larger than the gap before it, otherwise its end (lead-in silence, the usual case). Only ever shortens, so
 * timings stay monotonic and non-overlapping; order, `w`, `conf` and untimed words are untouched. Idempotent.
 */
export function capWordDurations<T extends Word>(words: T[], maxSec: number = MAX_WORD_SEC): T[] {
  const timed = (w: T | undefined): w is T => w !== undefined && Number.isFinite(w.start) && Number.isFinite(w.end);
  return words.map((w, i) => {
    if (!timed(w) || w.end - w.start <= maxSec) return w;
    const prev = words.slice(0, i).findLast(timed);
    const next = words.slice(i + 1).find(timed);
    const gapBefore = prev ? w.start - prev.end : Infinity;
    const gapAfter = next ? next.start - w.end : Infinity;
    return gapAfter > gapBefore ? { ...w, end: round3(w.start + maxSec) } : { ...w, start: round3(w.end - maxSec) };
  });
}

/**
 * Units -> words on the cut timeline. Each unit's text is split on whitespace and its [start, end] is shared out
 * in proportion to token length (characters). Times are monotonic, every token has end > start, and the last token
 * ends at the unit's end. A unit without a usable span (end <= start) gets 10 ms per token from its start.
 */
export function unitsToWords(units: Unit[]): Word[] {
  const out: Word[] = [];
  for (const u of units) {
    const tokens = u.text.split(/\s+/).filter((t) => t !== "");
    if (tokens.length === 0) continue;
    const start = u.start;
    const end = u.end - u.start >= tokens.length * 0.001 ? u.end : u.start + tokens.length * MIN_TOKEN_SEC;
    const lens = tokens.map((t) => [...t].length);
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    let prev = round3(start);
    tokens.forEach((t, i) => {
      acc += lens[i] as number;
      const last = i === tokens.length - 1;
      // a token never ends before 1 ms past the previous one, nor so late that the rest cannot fit
      const room = round3(end - (tokens.length - 1 - i) * 0.001);
      const at = last ? round3(end) : Math.min(room, Math.max(prev + 0.001, round3(start + ((end - start) * acc) / total)));
      const e = round3(at);
      out.push({ w: t, start: prev, end: e });
      prev = e;
    });
  }
  return out;
}
