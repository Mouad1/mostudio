import { mapToCut } from "../../../core/src/index.ts";
import type { Range, Unit, Word } from "../../../core/src/index.ts";

/** A word on the cut timeline; `seg` is the index of the keep it lives in. */
export type CutWord = Word & { seg: number };

export const MAX_GAP_SEC = 0.6;
export const MAX_UNIT_SEC = 7;
export const MAX_UNIT_WORDS = 18;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Source words (transcript order, normalized timings) -> cut timeline (a word is kept when its midpoint is inside a keep; edges clamped into it). Never sorts by start: that reorders the text. */
export function toCut(words: Word[], keep: Range[]): CutWord[] {
  const out: CutWord[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const seg = keep.findIndex((r) => mid >= r.start && mid <= r.end);
    if (seg < 0) continue;
    const k = keep[seg] as Range;
    const start = mapToCut(Math.min(Math.max(w.start, k.start), k.end), keep);
    const end = mapToCut(Math.min(Math.max(w.end, k.start), k.end), keep);
    if (start === undefined || end === undefined) continue;
    out.push({ w: w.w, start: round3(start), end: round3(end), seg });
  }
  return out;
}

/** Cut words -> subtitle units (ids from 1). A new unit starts after a gap over 0.6 s, at a keep boundary, or when the unit would pass 7 s or 18 words. */
export function groupUnits(words: CutWord[]): Unit[] {
  const groups: CutWord[][] = [];
  let cur: CutWord[] = [];
  for (const w of words) {
    const first = cur[0];
    const prev = cur[cur.length - 1];
    if (first && prev && (w.seg !== prev.seg || w.start - prev.end > MAX_GAP_SEC || w.end - first.start > MAX_UNIT_SEC || cur.length >= MAX_UNIT_WORDS)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length > 0) groups.push(cur);
  return groups.map((g, i) => {
    const text = g.map((w) => w.w).join(" ");
    return { id: i + 1, start: (g[0] as CutWord).start, end: (g[g.length - 1] as CutWord).end, text, src: text };
  });
}
