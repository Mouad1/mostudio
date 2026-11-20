import { mapToCut } from "../../../core/src/index.ts";
import type { Range, Word } from "../../../core/src/index.ts";

export type CaptionStyle = "long" | "short";
export type CueWord = { w: string; start: number; end: number };
export type Cue = { start: number; end: number; text: string; words: CueWord[] };
/** A word on the cut timeline; `seg` is the index of the keep it lives in. */
export type CutWord = CueWord & { seg: number };

export const MAX_CHARS = 42;
export const MAX_CUE_SEC = 5;
export const MAX_GAP_SEC = 0.6;
export const MIN_CUE_SEC = 0.5;
export const SHORT_MAX_WORDS = 3;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Source words (transcript order, normalized timings) -> cut timeline. A word is kept when its midpoint is in a keep; its edges are clamped into that keep. Never sorts by start: that reorders the text. */
export function toCutWords(words: Word[], keep: Range[]): CutWord[] {
  const out: CutWord[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const seg = keep.findIndex((k) => mid >= k.start && mid <= k.end);
    if (seg < 0) continue;
    const k = keep[seg];
    const start = mapToCut(Math.min(Math.max(w.start, k.start), k.end), keep);
    const end = mapToCut(Math.min(Math.max(w.end, k.start), k.end), keep);
    if (start === undefined || end === undefined) continue;
    out.push({ w: w.w, start: r3(start), end: r3(end), seg });
  }
  return out;
}

/** Words already on the cut timeline -> CutWords: `seg` is the first keep whose cut-end is at or after the word's midpoint (the last keep for anything past the end). */
export function withSegments(words: Word[], segEnds: number[]): CutWord[] {
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    const i = segEnds.findIndex((e) => mid <= e + 1e-9);
    return { w: w.w, start: r3(w.start), end: r3(w.end), seg: i < 0 ? Math.max(0, segEnds.length - 1) : i };
  });
}

/** Group cut-timeline words into cues. Never crosses a keep boundary; min 0.5 s (extended into the following gap, never past the cut-end of its keep), max 5 s. */
export function buildCues(words: CutWord[], style: CaptionStyle, segEnds: number[]): Cue[] {
  const groups: CutWord[][] = [];
  let cur: CutWord[] = [];
  let chars = 0;
  for (const w of words) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const tooLong = style === "long" ? chars + 1 + w.w.length > MAX_CHARS : cur.length >= SHORT_MAX_WORDS;
      if (w.seg !== prev.seg || w.start - prev.end > MAX_GAP_SEC || w.end - cur[0].start > MAX_CUE_SEC || tooLong) {
        groups.push(cur);
        cur = [];
      }
    }
    chars = cur.length === 0 ? w.w.length : chars + 1 + w.w.length;
    cur.push(w);
  }
  if (cur.length > 0) groups.push(cur);

  const segOf = groups.map((g) => g[g.length - 1].seg);
  const cues: Cue[] = groups.map((g) => ({
    start: g[0].start,
    end: g[g.length - 1].end,
    text: g.map((w) => w.w).join(" "),
    words: g.map(({ w, start, end }) => ({ w, start, end })),
  }));
  cues.forEach((c, i) => {
    if (c.end - c.start >= MIN_CUE_SEC) return;
    const limit = Math.min(i + 1 < cues.length ? cues[i + 1].start : Infinity, segEnds[segOf[i]] ?? Infinity);
    c.end = r3(Math.max(c.end, Math.min(c.start + MIN_CUE_SEC, limit)));
  });
  return cues;
}
