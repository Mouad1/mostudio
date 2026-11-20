import type { Cue } from "./group.ts";

export function formatSrtTimestamp(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number, l = 2): string => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** 1-based index, timing line, text, blank line. Empty string when there are no cues. */
export function buildSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}\n\n`).join("");
}

/** `[mm:ss.cc → mm:ss.cc] text` per cue, for review. */
export function buildReviewText(cues: Cue[]): string {
  const ts = (sec: number): string => {
    const cs = Math.max(0, Math.round(sec * 100));
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(Math.floor(cs / 6000))}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
  };
  return cues.map((c) => `[${ts(c.start)} → ${ts(c.end)}] ${c.text}\n`).join("");
}
