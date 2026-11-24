import type { Word } from "../../../core/src/index.ts";
import { normalizeText } from "./hallucinations.ts";
import type { Segment } from "./whisper-cpp.ts";

/**
 * Whisper text with no speech under it. Two shapes seen on Groq whisper-large-v3 with the Darija prompt:
 * - a sentence repeated, or translated into French, after the real one: Whisper's word alignment has no audio
 *   left for it and gives each word 20 ms (`dropCollapsedRuns`);
 * - the prompt read back over near-silence (a short window, a long pause): the words get plausible timings, so
 *   the text itself is compared with the prompt that was sent (`dropPromptEcho`).
 */

/** A word lasting at most this long has no audio under it (a spoken syllable takes 50 ms or more). */
export const COLLAPSED_WORD_SEC = 0.025;
/** This many collapsed words in a row mark text Whisper invented. */
export const MIN_COLLAPSED_RUN = 3;
/** A prompt copy is a run of at least this many words taken in order from the prompt. */
export const MIN_ECHO_RUN = 4;
/** A segment is an echo when at least this share of its words sit in such runs. */
export const ECHO_SHARE = 0.5;

type Filtered = { words: Word[]; segments: Segment[]; dropped: number };

/**
 * Index of the segment each word belongs to. When the segment texts, split on spaces, are exactly the words in
 * order (true of every Groq reply seen), by that order: Groq can time a segment's last words past the next
 * segment's start. Otherwise by time: the last segment starting at or before the word's midpoint, or the first
 * segment for words before every segment; -1 with no segments.
 */
export function segmentIndex(words: Word[], segments: Segment[]): number[] {
  const order = segments.flatMap((s, k) => s.text.trim().split(/\s+/).filter((t) => t !== "").map(() => k));
  const tokens = segments.flatMap((s) => s.text.trim().split(/\s+/).filter((t) => t !== ""));
  if (tokens.length === words.length && tokens.every((t, i) => t === (words[i] as Word).w)) return order;
  return words.map((w) => {
    if (segments.length === 0) return -1;
    const mid = (w.start + w.end) / 2;
    let k = 0;
    for (let i = 0; i < segments.length; i++) if ((segments[i] as Segment).start <= mid) k = i;
    return k;
  });
}

/** Keep the words not in `drop`; a segment that lost words takes the text and span of the ones left, or goes. */
function rebuild(words: Word[], segments: Segment[], seg: number[], drop: Set<number>): Filtered {
  if (drop.size === 0) return { words, segments, dropped: 0 };
  const touched = new Set([...drop].map((i) => seg[i] as number));
  const out: Segment[] = [];
  segments.forEach((s, k) => {
    if (!touched.has(k)) return out.push(s);
    const kept = words.filter((_, i) => seg[i] === k && !drop.has(i));
    if (kept.length === 0) return;
    out.push({ start: (kept[0] as Word).start, end: (kept.at(-1) as Word).end, text: ` ${kept.map((w) => w.w).join(" ")}` });
  });
  return { words: words.filter((_, i) => !drop.has(i)), segments: out, dropped: drop.size };
}

/**
 * Drop runs of MIN_COLLAPSED_RUN or more consecutive words lasting COLLAPSED_WORD_SEC or less, plus the word right
 * after a run when it ends its segment (Whisper hands the leftover time of the segment to the last token).
 */
export function dropCollapsedRuns(words: Word[], segments: Segment[]): Filtered {
  const seg = segmentIndex(words, segments);
  const collapsed = (w: Word): boolean => w.end - w.start <= COLLAPSED_WORD_SEC;
  const drop = new Set<number>();
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j < words.length && collapsed(words[j] as Word)) j++;
    if (j - i >= MIN_COLLAPSED_RUN) {
      for (let k = i; k < j; k++) drop.add(k);
      const lastOfSegment = j < words.length && seg[j] === seg[j - 1] && (j + 1 === words.length || seg[j + 1] !== seg[j]);
      if (lastOfSegment) drop.add(j);
    }
    i = Math.max(j, i + 1);
  }
  return rebuild(words, segments, seg, drop);
}

const tokens = (text: string): string[] => normalizeText(text).split(" ").filter((t) => t !== "");

/**
 * True when the segment reads like the prompt sent with it: MIN_ECHO_RUN words or more, and ECHO_SHARE or more of
 * them inside runs of MIN_ECHO_RUN+ words that appear in the same order in the prompt. Real speech that shares a
 * few words with the prompt ("بزاف ديال الناس") stays.
 */
export function isPromptEcho(text: string, prompt: string | undefined): boolean {
  if (!prompt) return false;
  const t = tokens(text);
  if (t.length < MIN_ECHO_RUN) return false;
  const p = tokens(prompt);
  const covered = new Array<boolean>(t.length).fill(false);
  for (let i = 0; i < t.length; i++) {
    for (let s = 0; s < p.length; s++) {
      let n = 0;
      while (i + n < t.length && s + n < p.length && t[i + n] === p[s + n]) n++;
      if (n >= MIN_ECHO_RUN) for (let k = i; k < i + n; k++) covered[k] = true;
    }
  }
  return covered.filter(Boolean).length / t.length >= ECHO_SHARE;
}

/** Drop the segments that echo `prompt` and the words that belong to them; `dropped` counts words. */
export function dropPromptEcho(words: Word[], segments: Segment[], prompt: string | undefined): Filtered {
  if (!prompt) return { words, segments, dropped: 0 };
  const seg = segmentIndex(words, segments);
  const echoed = new Set(segments.flatMap((s, k) => (isPromptEcho(s.text, prompt) ? [k] : [])));
  const drop = new Set(words.flatMap((_, i) => (echoed.has(seg[i] as number) ? [i] : [])));
  const out = rebuild(words, segments, seg, drop);
  // an echoed segment Whisper returned without words still goes
  return echoed.size > 0 ? { ...out, segments: out.segments.filter((s) => !segments.some((x, k) => x === s && echoed.has(k))) } : out;
}
