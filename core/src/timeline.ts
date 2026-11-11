import type { Word } from "./providers/openai-compat.ts";

export type Range = { start: number; end: number };

/** Source time -> cut time, given sorted non-overlapping keep ranges. Undefined when `t` is in a removed part. A keep's end is inclusive. */
export function mapToCut(t: number, keep: Range[]): number | undefined {
  let before = 0;
  for (const r of keep) {
    if (t >= r.start && t <= r.end) return before + (t - r.start);
    before += r.end - r.start;
  }
  return undefined;
}

/** Smallest positive finite value, Infinity when none: the usable source length from several measurements. */
export function durationBound(...values: (number | undefined)[]): number {
  const ok = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return ok.length ? Math.min(...ok) : Infinity;
}

/**
 * Keep ranges cut at `boundSec` (ranges left empty are dropped); `clamped` when anything changed. cut, mix,
 * assemble and chapters all clamp with the same bound so audio, video and chapter times agree.
 */
export function clampKeeps(keep: Range[], boundSec: number): { keep: Range[]; clamped: boolean } {
  const out = keep
    .map((k) => ({ start: Math.min(k.start, boundSec), end: Math.min(k.end, boundSec) }))
    .filter((k) => k.end - k.start > 1e-6);
  const clamped = out.length !== keep.length || out.some((k, i) => k.end !== keep[i]?.end || k.start !== keep[i]?.start);
  return { keep: clamped ? out : keep, clamped };
}

/** Total length of the kept ranges in seconds. */
export function keepDuration(keep: Range[]): number {
  return keep.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/**
 * Words in transcript order with monotonic, non-overlapping timings: each start is clamped to the latest end
 * so far, each end to at least its start; `w`, `conf` and order are untouched (as are words without finite times). ASR timestamps can overlap, nest,
 * or start before the previous word (Groq whisper-large-v3); the text order is trusted, the timestamps are not.
 * Clamping the later word keeps every earlier word whole and handles nested/reversed words, where splitting an
 * overlap at its midpoint is undefined. Idempotent; never sort words by start (that reorders the text).
 */
export function normalizeWordTimings(words: Word[]): Word[] {
  let at = 0;
  return words.map((w) => {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) return w; // untimed words pass through, untouched
    const start = Math.max(w.start, at);
    const end = Math.max(w.end, start);
    at = end;
    return start === w.start && end === w.end ? w : { ...w, start, end };
  });
}
