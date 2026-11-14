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
