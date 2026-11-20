import type { InspirationKind } from "../../src/types.ts";

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s]+/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }
  return result;
}

export function shelfCopy(kind: InspirationKind): { title: string; accepts: string } {
  if (kind === "shorts") {
    return {
      title: "Short-form (vertical)",
      accepts: "Reels, Shorts, TikToks: links, clips, screenshots, notes",
    };
  }
  return {
    title: "Long-form (landscape)",
    accepts: "YouTube videos, podcasts, interviews: links, clips, notes",
  };
}
