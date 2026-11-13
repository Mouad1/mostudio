import type { Word } from "../../../core/src/index.ts";
import { normalizeArabic } from "./darija.ts";
import type { Segment } from "./whisper-cpp.ts";

/** Lines Whisper is known to invent over silence or music (training-data credits and outros). */
export const HALLUCINATIONS = [
  "اشتركوا في القناة",
  "لا تنسوا الاشتراك في القناة",
  "ترجمة نانسي قنقر",
  "شكرا على المشاهدة",
  "sous-titres réalisés par la communauté d'amara.org",
  "sous-titrage st' 501",
  "thanks for watching",
  "subtitles by the amara.org community",
];

/** Comparison form: lowercase, Latin and Arabic diacritics stripped, Arabic letters normalized, punctuation -> space, spaces collapsed. */
export function normalizeText(text: string): string {
  return normalizeArabic(text.normalize("NFD").replace(/\p{M}/gu, ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const BLOCKLIST = HALLUCINATIONS.map(normalizeText);

/** True when the segment's normalized text equals a blocklisted line or is a run of whole words inside one. */
export function isHallucination(text: string): boolean {
  const t = normalizeText(text);
  if (t === "") return false;
  return BLOCKLIST.some((b) => b === t || ` ${b} `.includes(` ${t} `));
}

/** Drop hallucinated segments and every word whose midpoint falls inside one (inclusive bounds). */
export function dropHallucinations(words: Word[], segments: Segment[]): { words: Word[]; segments: Segment[]; dropped: number } {
  const bad = segments.filter((s) => isHallucination(s.text));
  if (bad.length === 0) return { words, segments, dropped: 0 };
  const inBad = (w: Word): boolean => {
    const mid = (w.start + w.end) / 2;
    return bad.some((s) => mid >= s.start && mid <= s.end);
  };
  return { words: words.filter((w) => !inBad(w)), segments: segments.filter((s) => !bad.includes(s)), dropped: bad.length };
}
