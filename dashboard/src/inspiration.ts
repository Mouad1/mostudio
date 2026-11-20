import { extname } from "node:path";
import { HttpError } from "./http.ts";
import type {
  InspirationFile,
  InspirationKind,
  InspirationLink,
  InspirationShelf,
} from "./types.ts";

export type {
  InspirationFile,
  InspirationKind,
  InspirationLink,
  InspirationShelf,
};

const MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".mp3",
  ".wav",
  ".m4a",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
]);

const NOTE_EXTS = new Set([".md", ".txt"]);

/**
 * Normalizes hostname by stripping www., m., vm. prefixes.
 */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.|vm\.)+/, "");
}

/**
 * Classifies a URL into short-form or long-form based on host and path.
 */
export function classifyLink(url: string): InspirationKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "long";
  }
  const host = normalizeHost(u.hostname);
  const path = u.pathname;
  if (host === "youtube.com" && /^\/shorts(?:\/|$)/.test(path)) {
    return "shorts";
  }
  if (host === "instagram.com" && /^\/reels?(?:\/|$)/.test(path)) {
    return "shorts";
  }
  if (host === "tiktok.com") {
    return "shorts";
  }
  return "long";
}

/**
 * Identifies the platform of a URL.
 */
export function platformOf(url: string): InspirationLink["platform"] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = normalizeHost(u.hostname);
  if (host === "youtube.com" || host === "youtu.be") {
    return "youtube";
  }
  if (host === "instagram.com") {
    return "instagram";
  }
  if (host === "tiktok.com") {
    return "tiktok";
  }
  if (host === "x.com" || host === "twitter.com") {
    return "x";
  }
  if (host === "facebook.com" || host === "fb.watch" || host === "fb.com") {
    return "facebook";
  }
  return "other";
}

/**
 * Parses links.txt: ignores comments and blank lines, extracts URL and optional note.
 */
export function listLinks(text: string): InspirationLink[] {
  const links: InspirationLink[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const sepMatch = trimmed.match(/^(.*?)(?:\s+#\s*|#\s+)(.*)$/);
    let url: string;
    let note: string | undefined;
    if (sepMatch) {
      url = sepMatch[1]!.trim();
      note = sepMatch[2]!.trim() || undefined;
    } else {
      url = trimmed;
      note = undefined;
    }
    if (url) {
      links.push({
        url,
        note,
        platform: platformOf(url),
      });
    }
  }
  return links;
}

/**
 * Deduplicates by URL; appends `${url}${note ? `  # ${note}` : ""}\n`.
 */
export function addLink(text: string, url: string, note?: string): string {
  const existing = listLinks(text);
  if (existing.some((l) => l.url === url)) {
    return text;
  }
  const cleanNote = note?.trim();
  const noteSuffix = cleanNote ? `  # ${cleanNote}` : "";
  const entry = `${url}${noteSuffix}\n`;
  if (!text) {
    return entry;
  }
  return text.endsWith("\n") ? `${text}${entry}` : `${text}\n${entry}`;
}

/**
 * Removes the line containing the given URL, preserving all other lines and comments.
 */
export function removeLink(text: string, url: string): string {
  const lines = text.split("\n");
  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === lines.length - 1 && line === "") {
      filtered.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      filtered.push(line);
      continue;
    }
    const sepMatch = trimmed.match(/^(.*?)(?:\s+#\s*|#\s+)(.*)$/);
    const lineUrl = (sepMatch ? sepMatch[1] : trimmed)!.trim();
    if (lineUrl === url) {
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n");
}

/**
 * Validates file extension and routes to kind/media/<name> or kind/<name>.
 */
export function routeInspirationFile(kind: InspirationKind, name: string): string {
  if (name.toLowerCase() === "links.txt") {
    throw new HttpError(409, "links.txt is managed by the link list");
  }
  const ext = extname(name).toLowerCase();
  if (MEDIA_EXTS.has(ext)) {
    return `${kind}/media/${name}`;
  }
  if (NOTE_EXTS.has(ext)) {
    return `${kind}/${name}`;
  }
  throw new HttpError(415, `This file type can't be added here (.${ext.replace(/^\./, "")})`);
}
