/**
 * Darija support for transcribe: the prompt that keeps Whisper in Moroccan Darija when forced to `ar`, and the
 * per-window choice between that pass (A) and an auto-language pass (B).
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

const MSA_MARKERS = ["سوف", "الذي", "التي", "الذين", "ليس", "ليست", "لقد", "أيضا", "حيث", "يجب", "لدي", "لدينا", "نحن", "عندما", "كيفية", "يمكنك"];
const DARIJA_MARKERS = ["ديال", "دابا", "واش", "غادي", "بزاف", "شنو", "علاش", "كيفاش", "ماشي", "بغيت", "كاين"];
const MSA = new Set(MSA_MARKERS.map(normalizeArabic));
const DARIJA = new Set(DARIJA_MARKERS.map(normalizeArabic));

/** Arabic-script tokens with punctuation removed and alef/hamza normalized. */
function arabicTokens(text: string): string[] {
  return normalizeArabic(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** A marker as a whole token, or with the conjunction و glued in front ("وسوف"). */
function count(tokens: string[], set: Set<string>): number {
  return tokens.filter((t) => set.has(t) || (t.length > 2 && t.startsWith("و") && set.has(t.slice(1)))).length;
}

/** MSA markers minus Darija markers; above 0 the text reads as Modern Standard Arabic rather than Darija. */
export function msaScore(text: string): number {
  const tokens = arabicTokens(text);
  return count(tokens, MSA) - count(tokens, DARIJA);
}

/** Whisper's detected language is French or English (full name or ISO code, any case). */
export function isFrenchOrEnglish(language: string | undefined): boolean {
  const l = (language ?? "").trim().toLowerCase();
  return l === "french" || l === "fr" || l === "english" || l === "en";
}

/**
 * Pick the auto pass (B) only when it heard French or English AND the forced-Arabic pass (A) reads as MSA,
 * i.e. forcing `ar` translated French/English speech. Otherwise A (near-verbatim Darija).
 */
export function choosePass(aText: string, bLanguage: string | undefined): "A" | "B" {
  return isFrenchOrEnglish(bLanguage) && msaScore(aText) > 0 ? "B" : "A";
}
