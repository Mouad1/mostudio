import { quietestPoint } from "../../../core/src/index.ts";
import type { Range, Word } from "../../../core/src/index.ts";

const WINDOW_MS = 10;
const PHRASE_GAP_SEC = 0.6;
const EPS = 1e-6;

/** lowercase, strip punctuation (letters and digits of any script stay), collapse runs of the same letter ("euuuh" -> "euh"). */
export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/(\p{L})\1+/gu, "$1");
}

/** Indices of words whose normalized text is in the filler list (list normalized the same way). */
export function fillerWords(words: Word[], fillers: string[]): number[] {
  const set = new Set(fillers.map(normalizeWord).filter((f) => f !== ""));
  const out: number[] = [];
  words.forEach((w, i) => {
    if (set.has(normalizeWord(w.w))) out.push(i);
  });
  return out;
}

export type Phrase = { first: number; last: number; start: number; end: number; norm: string[] };

/** Words split into phrases at gaps longer than 0.6 s. */
export function phrases(words: Word[]): Phrase[] {
  const out: Phrase[] = [];
  let cur: Phrase | undefined;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!cur || (prev && w.start - prev.end > PHRASE_GAP_SEC)) {
      cur = { first: i, last: i, start: w.start, end: w.end, norm: [] };
      out.push(cur);
    }
    cur.last = i;
    cur.end = Math.max(cur.end, w.end);
    cur.norm.push(normalizeWord(w.w));
  });
  return out;
}

function sameStart(a: Phrase, b: Phrase, k: number): boolean {
  if (a.norm.length < k || b.norm.length < k) return false;
  for (let n = 0; n < k; n++) if (a.norm[n] === "" || a.norm[n] !== b.norm[n]) return false;
  return true;
}

/**
 * Spans of earlier takes: if a later phrase (starting within windowSec of phrase i) begins with the
 * same k normalized words, phrases i..j-1 are removed (the last take is kept). Applied repeatedly.
 */
export function retakeSpans(words: Word[], windowSec: number, k: number): Range[] {
  const ph = phrases(words);
  const spans: Range[] = [];
  let i = 0;
  while (i < ph.length) {
    const a = ph[i] as Phrase;
    let match = -1;
    for (let j = ph.length - 1; j > i; j--) {
      const b = ph[j] as Phrase;
      if (b.start - a.start <= windowSec && sameStart(a, b, k)) {
        match = j;
        break;
      }
    }
    if (match < 0) {
      i++;
      continue;
    }
    spans.push({ start: a.start, end: (ph[match - 1] as Phrase).end });
    i = match;
  }
  return spans;
}

export type KeepOptions = {
  maxGap: number;
  pre: number;
  post: number;
  minKeep: number;
  durationSec: number;
  /** RMS envelope (dBFS, 10 ms windows); when given, boundaries snap to the quietest point of their padding. */
  env?: Float32Array;
};

type Run = { first: number; last: number };

/** Keep ranges around runs of kept words; boundaries never enter a neighbouring word. */
export function keepRanges(words: Word[], removedIdx: Set<number>, opts: KeepOptions): Range[] {
  const runs: Run[] = [];
  let cur: Run | undefined;
  let lastKept = -1;
  words.forEach((w, i) => {
    if (removedIdx.has(i)) return;
    const prev = words[lastKept];
    if (!cur || lastKept !== i - 1 || (prev && w.start - prev.end > opts.maxGap)) {
      cur = { first: i, last: i };
      runs.push(cur);
    }
    cur.last = i;
    lastKept = i;
  });

  const keeps: { start: number; end: number; lo: number; hi: number; firstWord: Word; lastWord: Word }[] = [];
  for (const r of runs) {
    const fw = words[r.first] as Word;
    const lw = words[r.last] as Word;
    const before = words[r.first - 1];
    const after = words[r.last + 1];
    const start = Math.max(0, before ? Math.max(fw.start - opts.pre, Math.min(before.end, fw.start)) : fw.start - opts.pre);
    const end = Math.min(opts.durationSec, after ? Math.min(lw.end + opts.post, Math.max(after.start, lw.end)) : lw.end + opts.post);
    keeps.push({ start, end, lo: fw.start, hi: lw.end, firstWord: fw, lastWord: lw });
  }

  // merge touching/overlapping paddings
  const merged: typeof keeps = [];
  for (const k of keeps) {
    const p = merged[merged.length - 1];
    if (p && p.end >= k.start) {
      p.end = Math.max(p.end, k.end);
      p.hi = k.hi;
      p.lastWord = k.lastWord;
    } else merged.push({ ...k });
  }

  // snap each boundary to the quietest point of its padding when the cut is short
  const env = opts.env;
  if (env && env.length > 0) {
    for (let i = 0; i < merged.length; i++) {
      const k = merged[i] as (typeof merged)[number];
      const next = merged[i + 1];
      if (next && next.firstWord.start - k.lastWord.end <= opts.maxGap * 2) {
        if (k.end - k.hi > EPS) k.end = clampTo(quietestPoint(env, WINDOW_MS, k.hi, k.end), k.hi, k.end);
        if (next.lo - next.start > EPS) next.start = clampTo(quietestPoint(env, WINDOW_MS, next.start, next.lo), next.start, next.lo);
      }
    }
  }

  return merged
    .map((k) => ({ start: round3(Math.max(0, k.start)), end: round3(Math.min(opts.durationSec, k.end)) }))
    .filter((k) => k.end - k.start >= opts.minKeep - EPS);
}

const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Keep boundaries strictly inside a kept word. Words in `removedIdx` do not count. */
export function midWordCuts(keep: Range[], words: Word[], removedIdx: Set<number> = new Set()): number {
  let n = 0;
  for (const k of keep) {
    for (const edge of [k.start, k.end]) {
      if (words.some((w, i) => !removedIdx.has(i) && edge > w.start + EPS && edge < w.end - EPS)) n++;
    }
  }
  return n;
}
