import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveBin, runBin } from "../../../core/src/index.ts";
import type { PickedProvider, Word } from "../../../core/src/index.ts";

export type Segment = { start: number; end: number; text: string };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const GAP_SEC = 0.6;

type WhisperJson = {
  result?: { language?: string };
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
};

/** whisper.cpp `-oj` output (one entry per word with `-ml 1 -sow`) to words; offsets are ms. */
export function parseWhisperCpp(json: unknown): Word[] {
  const items = (json as WhisperJson).transcription;
  if (!Array.isArray(items)) throw new Error("whisper-cli JSON has no transcription array");
  const words: Word[] = [];
  for (const it of items) {
    const text = (it.text ?? "").trim();
    if (!text || /^[\p{P}\p{S}\s]+$/u.test(text) || /^\[.*\]$/.test(text)) continue;
    const from = it.offsets?.from;
    const to = it.offsets?.to;
    if (typeof from !== "number" || typeof to !== "number") continue;
    words.push({ w: text, start: round3(from / 1000), end: round3(to / 1000) });
  }
  return words;
}

/** Group words into segments, starting a new one whenever the silence between words exceeds 0.6 s. */
export function buildSegments(words: Word[]): Segment[] {
  const segs: Segment[] = [];
  let cur: { start: number; end: number; ws: string[] } | undefined;
  for (const w of words) {
    if (cur && w.start - cur.end <= GAP_SEC) {
      cur.end = w.end;
      cur.ws.push(w.w);
    } else {
      if (cur) segs.push({ start: cur.start, end: cur.end, text: cur.ws.join(" ") });
      cur = { start: w.start, end: w.end, ws: [w.w] };
    }
  }
  if (cur) segs.push({ start: cur.start, end: cur.end, text: cur.ws.join(" ") });
  return segs;
}

/** Run whisper-cli on a 16 kHz WAV and parse its word-level JSON. */
export async function transcribeWhisperCpp(
  p: PickedProvider,
  wavPath: string,
  opts: { language?: string; env: Record<string, string | undefined>; workDir: string; timeoutMs?: number },
): Promise<{ language: string; words: Word[]; segments: Segment[] }> {
  const modelsDir = opts.env.WHISPER_MODELS_DIR;
  if (!modelsDir) throw new Error("whisper-cpp needs WHISPER_MODELS_DIR (folder holding ggml-<model>.bin); set it in .env.local");
  const prefix = join(opts.workDir, `whisper-${process.pid}-${Date.now()}`);
  const args = [
    "-m", join(modelsDir, `ggml-${p.model}.bin`),
    "-f", wavPath,
    "-ml", "1", "-sow", "-oj", "-of", prefix, "-np",
    "-l", opts.language ?? "auto",
  ];
  try {
    await runBin(resolveBin("whisper-cli", opts.env), args, opts.timeoutMs ?? 3_600_000);
    const json = JSON.parse(await readFile(`${prefix}.json`, "utf8")) as WhisperJson;
    const words = parseWhisperCpp(json);
    return { language: json.result?.language ?? opts.language ?? "unknown", words, segments: buildSegments(words) };
  } finally {
    await rm(`${prefix}.json`, { force: true });
  }
}
