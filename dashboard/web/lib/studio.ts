export const MEDIA_EXTS: string[] = [
  ".mp4",
  ".mov",
  ".m4v",
  ".mkv",
  ".webm",
  ".avi",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
];

export function acceptsMedia(name: string): boolean {
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = name.slice(lastDot).toLowerCase();
  return MEDIA_EXTS.includes(ext);
}

export function slugFromFileName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  let base = lastDot > 0 ? name.slice(0, lastDot) : name;
  base = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "video";
  return slug;
}

/** A workflow's name in plain words: "Long video", "Short", else the workflow id. */
export function workflowLabel(name: string): string {
  if (name === "rough-cut") return "Long video";
  if (name === "short") return "Short";
  return name;
}

/** Why another workflow's card is unavailable on a project that already ran `made`. */
export function lockedWorkflowReason(made: string, other: string): string {
  return `This project made a ${workflowLabel(made)}. Start a new project for a ${workflowLabel(other)}.`;
}

export function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = n;
  while (val >= 1000 && idx < units.length - 1) {
    val /= 1000;
    idx++;
  }
  const formatted = val.toFixed(1).replace(/\.0$/, "");
  return `${formatted} ${units[idx]}`;
}

/** "1920x1080 · 91.8s", or "Audio only · 1:32" for a file with no picture. */
export function mediaSpecs(m: { width: number; height: number; durationSec: number; hasVideo?: boolean }): string {
  if (m.hasVideo === false || !m.width || !m.height) {
    const total = Math.round(Number.isFinite(m.durationSec) ? m.durationSec : 0);
    return `Audio only · ${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
  return `${m.width}x${m.height} · ${m.durationSec.toFixed(1)}s`;
}
