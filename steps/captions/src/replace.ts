import type { Word } from "../../../core/src/index.ts";

export type Rule = { from: string[]; to: string };

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** Matching form of a token: lowercase, surrounding punctuation stripped. */
export const normalizeToken = (t: string): string => t.toLowerCase().replace(EDGE, "");

/** Parse `wrong => right` lines; `#` comments, blank lines, lines without `=>` or with an empty side are ignored (and counted). */
export function parseReplacementsWithStats(text: string): { rules: Rule[]; ignored: number } {
  const rules: Rule[] = [];
  let ignored = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=>");
    if (at < 0) {
      ignored++;
      continue;
    }
    const from = line.slice(0, at).trim().split(/\s+/).map(normalizeToken).filter((t) => t !== "");
    const to = line.slice(at + 2).trim();
    if (from.length === 0 || to === "") {
      ignored++;
      continue;
    }
    rules.push({ from, to });
  }
  return { rules, ignored };
}

export const parseReplacements = (text: string): Rule[] => parseReplacementsWithStats(text).rules;

const trailingPunct = (w: string): string => w.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";

/** Whole-word, case-insensitive replacement on the source timeline. Longest `from` wins; matches never overlap. */
export function applyReplacements(words: Word[], rules: Rule[]): { words: Word[]; applied: number } {
  const ordered = [...rules].sort((a, b) => b.from.length - a.from.length);
  const norm = words.map((w) => normalizeToken(w.w));
  const out: Word[] = [];
  let applied = 0;
  for (let i = 0; i < words.length; ) {
    const rule = ordered.find((r) => i + r.from.length <= words.length && r.from.every((t, k) => norm[i + k] === t));
    if (!rule) {
      out.push(words[i]);
      i++;
      continue;
    }
    const last = words[i + rule.from.length - 1];
    out.push({ w: rule.to + trailingPunct(last.w), start: words[i].start, end: last.end });
    applied++;
    i += rule.from.length;
  }
  return { words: out, applied };
}
