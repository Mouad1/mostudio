/**
 * Darija support for transcribe: the prompt that keeps Whisper in Moroccan Darija when forced to `ar`, and the
 * per-segment choice between that pass (A) and an auto-language pass (B).
 */

/** Darija in Arabic script, mixing the French/tech loanwords a Moroccan creator uses. Steers Whisper away from MSA. */
export const DARIJA_PROMPT =
  "السلام عليكم، دابا غادي نشرح ليكم كيفاش كنخدم بهاد l'outil، واش واضح؟ بزاف ديال الناس كيسولوني على montage و sous-titres و workflow، ماشي مشكل، غادي نوريكم كلشي.";

/** Built-in Darija prompt, with the user's own prompt (names, terms) appended when given. */
export function darijaPrompt(user?: string): string {
  const extra = user?.trim();
  return extra ? `${DARIJA_PROMPT} ${extra}` : DARIJA_PROMPT;
}

/** Alef/hamza variants -> bare alef, alef maqsura -> ya, harakat and tatweel removed. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي");
}

// Whole tokens only. Reviewed with Gemini 4 Neon (2026-11-24). Left out on purpose because they are Darija too:
// حيث (7it, because), إلى (ila, if), يمكن (yemken, maybe), لكي (Whisper splits "اللي كيخدموا" into "لكي ختموا"),
// أن, نشارك, إذا, غير, حتى, كيف, ولكن.
const MSA_MARKERS = [
  "سوف", "الذي", "التي", "الذين", "ليس", "ليست", "لقد", "أيضا", "يجب", "نحن", "عندما", "كيفية", "هذا", "هذه", "ذلك", "معكم",
  "لدي", "لدينا", "لديك", "لديه", "لديها", "لديهم", "لديكم", "يمكنك", "يمكننا", "يمكنكم", "يمكنهم", "يمكنه", "يمكنها",
  // datives: Darija always has -i- (لينا ليكم ليهم ليها)
  "لنا", "لكم", "لهم", "لها",
  "لهذا", "لهذه", "بهذا", "بهذه", "لذلك", "بذلك", "كذلك", "تلك", "هؤلاء", "أولئك",
  "أنه", "أنها", "أنهم", "أنني", "بأنه", "بأنها", "بأنهم", "لأنني", "لأننا", "لأنه", "لأنها", "لأنهم",
  "لماذا", "ماذا", "متى", "أين", "للغاية", "إذن", "لن", "بينما",
  "أستطيع", "تستطيع", "يستطيع", "نستطيع", "يستطيعون", "نتحدث", "يتحدث", "تتحدث", "أتحدث",
  "قمت", "قمنا", "نقوم", "يقوم", "تقوم", "أقوم", "نراكم", "أراكم", "الكثير", "الأشياء", "الشأن", "أحد",
];
const DARIJA_MARKERS = [
  "ديال", "ديالي", "ديالك", "ديالو", "ديالها", "ديالنا", "ديالكم", "ديالهم",
  "دابا", "واش", "غادي", "غادية", "غادين", "بزاف", "شنو", "أشنو", "لشنو", "فشنو", "بشنو", "علاش", "كيفاش", "ماشي",
  "بغيت", "بغيتي", "بغينا", "بغيتو", "بغاو", "باغي", "باغية", "باغيين", "كاين", "كاينة", "كاينين", "ماكاينش", "ماكايناش",
  "هاد", "فهاد", "بهاد", "لهاد", "هادا", "هادي", "هادو", "هادشي", "فهادشي", "بهادشي", "لهادشي", "باش",
  "معاكم", "معايا", "معاك", "معاه", "معاها", "معانا", "معاهم",
  "ليا", "ليك", "ليه", "ليها", "لينا", "ليكم", "ليهم", "بيكم", "بينا", "بيهم", "اللي", "بلي", "باللي",
  "داك", "ديك", "داكشي", "هنايا", "تما", "تماك", "فين", "فوقاش", "شحال", "شكون", "منين",
  "حنا", "حنايا", "نتوما", "هوما", "كلشي", "شوية", "مزيان", "مزيانة", "زوين", "زوينة", "بالصح", "وخا", "صافي", "ملي", "فاش",
  "ديما", "دغيا", "والو", "حوايج", "اللول", "اللولة",
  "درت", "درتي", "درنا", "دير", "ندير", "يدير", "كندير", "كيدير", "نديرو", "خاصني", "خاصك", "خاصو", "خاصنا", "خاصكم", "خاصهم",
];
const MSA = new Set(MSA_MARKERS.map(normalizeArabic));
const DARIJA = new Set(DARIJA_MARKERS.map(normalizeArabic));
// no conjunction و stripped before these: ولدي is "my son", ولنا/ولكم/ولن/واحد read as Darija too
const NO_WAW = new Set([...MSA].filter((m) => m.startsWith("ل") || m === "احد"));

/** Arabic-script tokens with punctuation removed and alef/hamza normalized. */
function arabicTokens(text: string): string[] {
  return normalizeArabic(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** A marker as a whole token, or with the conjunction و glued in front ("وسوف"). */
function count(tokens: string[], set: Set<string>): number {
  return tokens.filter((t) => set.has(t) || (t.length > 2 && t.startsWith("و") && set.has(t.slice(1)) && !NO_WAW.has(t.slice(1)))).length;
}

/** With this many Arabic words, no Darija word and no French/English word, a sentence is MSA or garbled Arabic. */
export const BARE_ARABIC_WORDS = 10;

/**
 * True when any sentence of `text` reads as MSA or garbled Arabic rather than Darija: it has an MSA marker and
 * no more Darija markers than MSA ones, or BARE_ARABIC_WORDS+ Arabic words with no Darija marker and no Latin word.
 * Sentences are judged one by one, so a Darija first sentence cannot hide a garbled second one.
 */
export function readsAsMsa(text: string): boolean {
  return text.split(/[.؟?!]+/).some((sentence) => {
    const tokens = arabicTokens(sentence);
    const msa = count(tokens, MSA);
    const darija = count(tokens, DARIJA);
    if (msa > 0 && msa >= darija) return true;
    const arabic = tokens.filter((t) => /\p{Script=Arabic}/u.test(t)).length;
    return arabic >= BARE_ARABIC_WORDS && darija === 0 && !/\p{Script=Latin}/u.test(sentence);
  });
}

/** At least this many Latin words and no Arabic word: a forced-Arabic segment that Whisper translated into French. */
export const FRENCH_ONLY_WORDS = 6;

/** True when `text` has no Arabic-script word and FRENCH_ONLY_WORDS+ Latin words (only meaningful for pass A). */
export function readsAsFrenchOnly(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return !words.some((w) => /\p{Script=Arabic}/u.test(w)) && words.filter((w) => /\p{Script=Latin}/u.test(w)).length >= FRENCH_ONLY_WORDS;
}

/** Whisper's detected language is French or English (full name or ISO code, any case). */
export function isFrenchOrEnglish(language: string | undefined): boolean {
  const l = (language ?? "").trim().toLowerCase();
  return l === "french" || l === "fr" || l === "english" || l === "en";
}
