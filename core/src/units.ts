import type { Word } from "./providers/openai-compat.ts";

/** A caption/subtitle line on the cut timeline (seconds): `text` is what is shown, `src` the source-language words it came from. */
export type Unit = { id: number; start: number; end: number; text: string; src: string };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Shortest span per token when a unit has no usable duration, so every token still has end > start. */
const MIN_TOKEN_SEC = 0.01;

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
