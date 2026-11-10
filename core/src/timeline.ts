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

/** Total length of the kept ranges in seconds. */
export function keepDuration(keep: Range[]): number {
  return keep.reduce((sum, r) => sum + (r.end - r.start), 0);
}
