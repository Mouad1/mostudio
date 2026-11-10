import { quietestPoint } from "../../../core/src/index.ts";
import type { Range, Word } from "../../../core/src/index.ts";

const WINDOW_MS = 10;
const PHRASE_GAP_SEC = 0.6;
const EPS = 1e-6;

/** lowercase, strip punctuation (letters and digits of any script stay); `collapse` merges runs of the same letter ("euuuh" -> "euh"). */
export function normalizeWord(w: string, collapse = false): string {
  const n = w.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");
  return collapse ? n.replace(/(\p{L})\1+/gu, "$1") : n;
}

export type FillerList = { always: string[]; isolated?: string[] };

const ISOLATED_GAP_SEC = 0.3;
const ISOLATED_MAX_SEC = 0.4;

/**
 * Indices of filler words. `always` words are fillers wherever they are; `isolated` (soft) words only when
 * the pause before or after is >= 0.3 s and the word is <= 0.4 s long. A plain array means all `always`.
 */
export function fillerWords(words: Word[], fillers: string[] | FillerList): number[] {
  const list: FillerList = Array.isArray(fillers) ? { always: fillers } : fillers;
  const norm = (l: string[]) => new Set(l.map((f) => normalizeWord(f, true)).filter((f) => f !== ""));
  const always = norm(list.always);
  const soft = norm(list.isolated ?? []);
  const out: number[] = [];
  words.forEach((w, i) => {
    const n = normalizeWord(w.w, true);
    if (always.has(n)) out.push(i);
    else if (soft.has(n) && w.end - w.start <= ISOLATED_MAX_SEC + EPS) {
      const prev = words[i - 1];
      const next = words[i + 1];
      const before = prev ? w.start - prev.end : 0;
      const after = next ? next.start - w.end : 0;
      if (before >= ISOLATED_GAP_SEC - EPS || after >= ISOLATED_GAP_SEC - EPS) out.push(i);
    }
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
  return retakeEvents(words, windowSec, k).map((e) => ({ start: e.start, end: e.end }));
}

export type RetakeEvent = Range & { phrases: number; sec: number };

/** Like retakeSpans, with the number of phrases removed and the distance (s) between the two takes' starts. */
export function retakeEvents(words: Word[], windowSec: number, k: number): RetakeEvent[] {
  const ph = phrases(words);
  const spans: RetakeEvent[] = [];
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
    spans.push({ start: a.start, end: (ph[match - 1] as Phrase).end, phrases: match - i, sec: (ph[match] as Phrase).start - a.start });
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
type Keep = { start: number; end: number; lo: number; hi: number; firstWord: Word; lastWord: Word; first: number; last: number };

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

  const keeps: Keep[] = [];
  for (const r of runs) {
    const fw = words[r.first] as Word;
    const lw = words[r.last] as Word;
    const before = words[r.first - 1];
    const after = words[r.last + 1];
    const start = Math.max(0, before ? Math.max(fw.start - opts.pre, Math.min(before.end, fw.start)) : fw.start - opts.pre);
    const end = Math.min(opts.durationSec, after ? Math.min(lw.end + opts.post, Math.max(after.start, lw.end)) : lw.end + opts.post);
    keeps.push({ start, end, lo: fw.start, hi: lw.end, firstWord: fw, lastWord: lw, first: r.first, last: r.last });
  }

  // merge touching/overlapping paddings
  const merged: Keep[] = [];
  for (const k of keeps) {
    const p = merged[merged.length - 1];
    if (p && p.end >= k.start) {
      p.end = Math.max(p.end, k.end);
      p.hi = k.hi;
      p.lastWord = k.lastWord;
      p.last = k.last;
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

  // every keep holds kept speech, so a short one is extended toward minKeep (never into a neighbouring word), never dropped
  for (let i = 0; i < merged.length; i++) {
    const k = merged[i] as Keep;
    const need = opts.minKeep - (k.end - k.start);
    if (need <= EPS) continue;
    const prevWord = words[k.first - 1];
    const nextWord = words[k.last + 1];
    const prevKeep = merged[i - 1];
    const nextKeep = merged[i + 1];
    const lo = Math.min(k.start, Math.max(0, prevWord ? prevWord.end : 0, prevKeep ? prevKeep.end : 0));
    const hi = Math.max(k.end, Math.min(opts.durationSec, nextWord ? nextWord.start : opts.durationSec, nextKeep ? nextKeep.start : opts.durationSec));
    const roomDown = k.start - lo;
    const roomUp = hi - k.end;
    const up = Math.min(need - Math.min(need / 2, roomDown), roomUp);
    const down = Math.min(need - up, roomDown);
    k.start -= down;
    k.end += up;
  }

  return merged.map((k) => ({ start: round3(Math.max(0, k.start)), end: round3(Math.min(opts.durationSec, k.end)) }));
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
