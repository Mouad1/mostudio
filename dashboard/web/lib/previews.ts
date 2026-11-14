import type { ProjectStatus } from "../../src/types.ts";

export type PreviewKind =
  | "media-info"
  | "video"
  | "audio"
  | "words"
  | "edl"
  | "units"
  | "captions"
  | "text"
  | "image"
  | "report";

export type Preview = {
  kind: PreviewKind;
  path: string;
  label: string;
};

export function previewsFor(step: string, status: ProjectStatus): Preview[] {
  const stepResult = status.steps[step];
  if (!stepResult || (stepResult.status !== "pass" && stepResult.status !== "warn")) {
    return [];
  }

  switch (step) {
    case "ingest": {
      const previews: Preview[] = [
        { kind: "media-info", path: "media/ingest.json", label: "Your video" },
      ];
      if (status.media?.file) {
        previews.push({ kind: "video", path: status.media.file, label: "Your video" });
      }
      return previews;
    }
    case "transcribe":
      return [{ kind: "words", path: "transcript/words.json", label: "What was said" }];
    case "cut":
      return [{ kind: "edl", path: "cut/edl.json", label: "What was cut" }];
    case "localize":
      return [{ kind: "units", path: "localize/units.json", label: "Subtitle lines" }];
    case "captions":
      return [{ kind: "captions", path: "captions/captions.txt", label: "Captions" }];
    case "mix":
      return [{ kind: "audio", path: "audio/mix.wav", label: "Sound" }];
    case "chapters":
      return [{ kind: "text", path: "chapters/youtube.txt", label: "Chapters" }];
    case "assemble":
      return [{ kind: "video", path: "renders/final.mp4", label: "Your video" }];
    case "qa":
      return [
        { kind: "image", path: "renders/contact-sheet.jpg", label: "Contact sheet" },
        { kind: "report", path: "renders/qa.md", label: "QA Report" },
      ];
    default:
      return [];
  }
}

export type EdlSegment = {
  left: number;
  width: number;
  kind: "keep" | "silence" | "filler" | "retake";
};

export function edlBar(
  edl: {
    keep: { start: number; end: number }[];
    removed: { start: number; end: number; reason: string }[];
  },
  total: number
): EdlSegment[] {
  if (total <= 0) {
    return [];
  }

  const segments: EdlSegment[] = [];

  for (const k of edl.keep) {
    const left = (k.start / total) * 100;
    const width = ((k.end - k.start) / total) * 100;
    segments.push({ left, width, kind: "keep" });
  }

  for (const r of edl.removed) {
    const left = (r.start / total) * 100;
    const width = ((r.end - r.start) / total) * 100;
    const kind: EdlSegment["kind"] =
      r.reason === "filler" ? "filler" : r.reason === "retake" ? "retake" : "silence";
    segments.push({ left, width, kind });
  }

  return segments.sort((a, b) => a.left - b.left);
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    sec = 0;
  }
  const totalCentiseconds = Math.round(sec * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);

  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const cc = String(centiseconds).padStart(2, "0");

  return `${mm}:${ss}.${cc}`;
}
