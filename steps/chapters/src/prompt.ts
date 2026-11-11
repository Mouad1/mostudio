import type { Word } from "../../../core/src/index.ts";

export const LINE_SEC = 30;
export const MAX_TRANSCRIPT_CHARS = 24_000;

export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Cut-timeline words -> lines, each starting with `[mm:ss]` at the first word after every 30 s boundary. Over-long text keeps evenly spaced lines. */
export function buildTranscript(words: Word[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const lines: string[] = [];
  let cur: string[] = [];
  let boundary = 0;
  for (const w of words) {
    if (cur.length === 0 || w.start >= boundary) {
      if (cur.length > 0) lines.push(cur.join(" "));
      cur = [`[${mmss(w.start)}]`];
      boundary = (Math.floor(w.start / LINE_SEC) + 1) * LINE_SEC;
    }
    cur.push(w.w);
  }
  if (cur.length > 0) lines.push(cur.join(" "));
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return lines.join("\n");
  const avg = total / lines.length;
  const keepCount = Math.max(1, Math.floor(maxChars / avg));
  const picked: string[] = [];
  for (let i = 0; i < keepCount; i++) picked.push(lines[Math.floor((i * lines.length) / keepCount)]);
  return picked.join("\n").slice(0, maxChars);
}

export function buildMessages(transcript: string, outDurationSec: number, language: string | undefined): { role: "system" | "user"; content: string }[] {
  const long = outDurationSec >= 180;
  const count = long ? "between 4 and 10 chapters" : "between 2 and 4 chapters";
  const lang = language ? `Write the titles in this language: ${language}.` : "Write the titles in the same language as the transcript.";
  return [
    {
      role: "system",
      content:
        "You write YouTube chapter lists. Chapters split a video into topics. The first chapter must start at 0 seconds, " +
        "chapters must be at least 10 seconds long, and titles are short, concrete and describe what the section covers.",
    },
    {
      role: "user",
      content:
        `Transcript of a ${Math.round(outDurationSec)} second video. Each line begins with its [mm:ss] position.\n\n${transcript}\n\n` +
        `Return ONLY JSON in exactly this shape: {"chapters":[{"start":<seconds as a number>,"title":"<at most 50 characters>"}]}\n` +
        `Give ${count}, ordered by start, with start values between 0 and ${Math.floor(outDurationSec)}. ${lang} ` +
        "Keep titles concise, with no numbering and no emojis.",
    },
  ];
}
