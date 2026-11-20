import type { CaptionStyle, Cue } from "./group.ts";

// \k: text is SecondaryColour until sung, then PrimaryColour -> white before, highlight after
export const HIGHLIGHT_ASS = "&H0000D4FF"; // #FFD400 as ASS BGR
const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";

/** ASS timestamp H:MM:SS.cc (idea adapted from tubemauto formatAssTimestamp). */
export function formatAssTimestamp(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}.${p(cs % 100)}`;
}

/** Escape ASS override-block characters and newlines (idea adapted from tubemauto escapeAssText). */
export function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");
}

/** Dialogue text: plain escaped text (long) or `{\k<cs>}word` per word (short). */
export function assDialogueText(cue: Cue, style: CaptionStyle): string {
  if (style === "long") return escapeAssText(cue.text);
  return cue.words
    .map((w, i) => {
      const next = i + 1 < cue.words.length ? cue.words[i + 1].start : cue.end;
      return `{\\k${Math.max(0, Math.round((next - w.start) * 100))}}${escapeAssText(w.w)}`;
    })
    .join(" ");
}

export type AssOptions = { width: number; height: number; font: string };

export function buildAss(cues: Cue[], style: CaptionStyle, o: AssOptions): string {
  const size = Math.round(style === "long" ? 48 * (o.height / 1080) : 84 * (o.width / 1080));
  const marginV = Math.round(style === "long" ? 60 * (o.height / 1080) : 340 * (o.height / 1920));
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${o.font},${size},${style === "short" ? HIGHLIGHT_ASS : WHITE},${WHITE},${BLACK},${BLACK},-1,0,0,0,100,100,0,0,1,6,0,2,40,40,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.map((c) => `Dialogue: 0,${formatAssTimestamp(c.start)},${formatAssTimestamp(c.end)},Default,,0,0,0,,${assDialogueText(c, style)}`),
  ];
  return `${lines.join("\n")}\n`;
}
