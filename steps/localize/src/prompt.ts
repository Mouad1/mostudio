import type { ChatMessage } from "../../../core/src/index.ts";

export const LANGS = ["source", "arabizi", "fr", "en"] as const;
export type Lang = (typeof LANGS)[number];
export type TargetLang = Exclude<Lang, "source">;

/** Arabic-script letters (Arabic, Supplement, Extended-A, presentation forms). */
export const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

const SHAPE = 'Reply with ONLY JSON in exactly this shape: {"units":[{"id":<same id>,"text":"<line>"}]}, one entry per input id, same ids, no extra keys.';

const SYSTEM: Record<TargetLang, string> = {
  arabizi:
    "You transliterate Moroccan Darija subtitle lines into Arabizi: Darija written in Latin letters the way Moroccans text, " +
    "using the digits 3 (ع), 7 (ح), 9 (ق), 2 (ء) and 5 (خ) where natural. Transliterate, do NOT translate: keep the speaker's words and order. " +
    "French and English words written phonetically in Arabic script are loanwords: restore their normal spelling (الوتي -> l'outil, سوتيتر -> sous-titres, ليزانفلوونسور -> les influenceurs, الكابشنز -> captions). " +
    "Some lines may be in Modern Standard Arabic because of a speech-recognition error: render those as natural Moroccan Darija in Arabizi. " +
    "Keep names and tech terms as they are usually written. Never output Arabic script.",
  fr:
    "You translate subtitle lines from a video (Moroccan Darija mixed with French and English, possibly in Arabic script) into natural, concise French subtitles. " +
    "Keep the meaning and tone, keep names and tech terms as they are usually written, keep each line short enough to read. Never output Arabic script.",
  en:
    "You translate subtitle lines from a video (Moroccan Darija mixed with French and English, possibly in Arabic script) into natural, concise English subtitles. " +
    "Keep the meaning and tone, keep names and tech terms as they are usually written, keep each line short enough to read. Never output Arabic script.",
};

/** Comfortable subtitle reading speed (characters per second) used to size each translated line. */
export const READ_CPS = 15;
const MIN_BUDGET = 12;

/** Most characters a translated line may use to be read in its time on screen. */
export function charBudget(start: number, end: number): number {
  return Math.max(MIN_BUDGET, Math.floor(Math.max(0, end - start) * READ_CPS));
}

const BUDGET =
  'Each unit has "max": the most characters its line may use so viewers can read it in time. Stay within it: condense (drop fillers, repetitions and asides) rather than translate word for word.';

/** System + user messages for one batch of units. Translations get a per-line character budget; Arabizi keeps the speaker's words, so none. */
export function buildMessages(lang: TargetLang, units: { id: number; text: string; start?: number; end?: number }[]): ChatMessage[] {
  const budget = lang !== "arabizi";
  return [
    { role: "system", content: `${SYSTEM[lang]}${budget ? ` ${BUDGET}` : ""} ${SHAPE}` },
    {
      role: "user",
      content: JSON.stringify({
        units: units.map(({ id, text, start, end }) =>
          budget && typeof start === "number" && typeof end === "number" ? { id, text, max: charBudget(start, end) } : { id, text },
        ),
      }),
    },
  ];
}

/** Parse + validate a batch reply: JSON (fences stripped), the same ids once each, non-empty text, no Arabic script. Throws so withProvider rotates. */
export function parseReply(raw: string, ids: number[]): Map<number, string> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    try {
      if (a < 0 || b <= a) throw new Error("none");
      data = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new Error("model reply is not valid JSON");
    }
  }
  const list = (data as { units?: unknown } | null)?.units;
  if (!Array.isArray(list)) throw new Error("model reply has no units array");
  const want = new Set(ids);
  const out = new Map<number, string>();
  for (const item of list) {
    const { id, text: t } = (item ?? {}) as { id?: unknown; text?: unknown };
    const n = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
    if (typeof n !== "number" || !want.has(n)) throw new Error(`unexpected unit id ${JSON.stringify(id)}`);
    if (out.has(n)) throw new Error(`unit ${n} appears twice`);
    if (typeof t !== "string" || t.trim() === "") throw new Error(`unit ${n}: empty text`);
    if (ARABIC.test(t)) throw new Error(`unit ${n}: Arabic script in reply`);
    out.set(n, t.replace(/\s+/g, " ").trim());
  }
  if (out.size !== want.size) throw new Error(`model reply is missing ${want.size - out.size} unit(s)`);
  return out;
}

/** Share (0-100, one decimal) of whitespace tokens across the texts that contain Arabic-script letters. */
export function arabicScriptPct(texts: string[]): number {
  const tokens = texts.flatMap((t) => t.split(/\s+/).filter((x) => x !== ""));
  if (tokens.length === 0) return 0;
  return Math.round((1000 * tokens.filter((t) => ARABIC.test(t)).length) / tokens.length) / 10;
}
