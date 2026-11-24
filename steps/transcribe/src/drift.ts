import type { Word } from "../../../core/src/index.ts";
import { readsAsMsa } from "./darija.ts";
import { segmentIndex } from "./echo.ts";
import type { Segment } from "./whisper-cpp.ts";

/**
 * MSA drift inside a Darija window: forced Arabic sometimes renders a stretch of speech as Modern Standard Arabic
 * ("وما إلى ذلك" for the French "etc.", "هذا الشأن") while the Darija around it is fine. Only those segments are
 * replaced, from another pass over the same window (the auto-language pass, or a retry of pass A).
 */
type Pass = { words: Word[]; segments: Segment[] };

/** Indexes of the segments that read as Modern Standard Arabic or garbled Arabic (`readsAsMsa`). */
export function driftedSegments(segments: Segment[]): number[] {
  return segments.flatMap((s, k) => (readsAsMsa(s.text) ? [k] : []));
}

/**
 * Replace the `drifted` segments of pass A with the words pass B heard over the same time. A segment's span runs
 * halfway into the gap to the neighbouring A words; where there is none, to the edge of the B segments overlapping
 * the A segment's words (A may have dropped the end of a sentence that B has in full); B words
 * whose midpoint is inside it replace the segment's words, and the segment text is rebuilt from them. Every word
 * keeps the timing of the pass it comes from. A segment stays as it is when B has no words in its span or B's words
 * there are `rejected` too (default: they read as MSA).
 */
export function replaceDrift(a: Pass, b: Pass, drifted: number[], rejected: (text: string) => boolean = readsAsMsa): Pass & { replaced: number } {
  const seg = segmentIndex(a.words, a.segments);
  const bad = new Set(drifted);
  const words: Word[] = a.words.filter((_, i) => !bad.has(seg[i] as number));
  const segments: Segment[] = [];
  let replaced = 0;
  a.segments.forEach((s, k) => {
    const idx = a.words.flatMap((_, i) => (seg[i] === k ? [i] : []));
    if (!bad.has(k) || idx.length === 0) {
      segments.push(s);
      return;
    }
    const first = a.words[idx[0] as number] as Word;
    const last = a.words[idx.at(-1) as number] as Word;
    const prev = a.words[(idx[0] as number) - 1];
    const next = a.words[(idx.at(-1) as number) + 1];
    // with no A word on a side, the span reaches the edge of the B segments it overlaps: A may have dropped the
    // end of a sentence B has in full, while a separate B segment (a "oui" over a silent tail) stays out
    const over = b.segments.filter((x) => x.start < last.end && x.end > first.start);
    const lo = prev ? (prev.end + first.start) / 2 : Math.min(first.start, ...over.map((x) => x.start));
    const hi = next ? (last.end + next.start) / 2 : Math.max(last.end, ...over.map((x) => x.end));
    const from = b.words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= lo && mid < hi;
    });
    if (from.length === 0 || rejected(from.map((w) => w.w).join(" "))) {
      words.push(...idx.map((i) => a.words[i] as Word));
      segments.push(s);
      return;
    }
    replaced++;
    words.push(...from);
    segments.push({ start: (from[0] as Word).start, end: (from.at(-1) as Word).end, text: ` ${from.map((w) => w.w).join(" ")}` });
  });
  const byStart = <T extends { start: number }>(x: T, y: T): number => x.start - y.start;
  return { words: words.sort(byStart), segments: segments.sort(byStart), replaced };
}
