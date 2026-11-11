import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { keepDuration, normalizeWordTimings, readJson, rmsEnvelope, writeJsonAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule, Word } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import fillers from "../fillers.json" with { type: "json" };
import type { FillerList } from "./detect.ts";
import { fillerWords, keepRanges, midWordCuts, retakeEvents } from "./detect.ts";

const WINDOW_MS = 10;
const FADE_SEC = 0.01;
const RETAKE_K = 3;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const PACES: Record<string, { maxGap: number; pre: number; post: number }> = {
  natural: { maxGap: 0.45, pre: 0.1, post: 0.15 },
  tight: { maxGap: 0.25, pre: 0.05, post: 0.08 },
};

type Reason = "silence" | "filler" | "retake";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export const cut: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const pace = typeof ctx.params.pace === "string" ? ctx.params.pace : "natural";
    const preset = PACES[pace];
    if (!preset) throw new Error(`unknown pace "${pace}" (expected ${Object.keys(PACES).join(" or ")})`);
    const maxGap = num(ctx.params.maxGap, preset.maxGap);
    const pre = num(ctx.params.pre, preset.pre);
    const post = num(ctx.params.post, preset.post);
    const minKeep = num(ctx.params.minKeep, 0.3);
    const maxRetakeSec = num(ctx.params.maxRetakeSec, 8);
    const retakes = typeof ctx.params.retakes === "boolean" ? ctx.params.retakes : true;

    const ingest = await readJson<{ file: string; durationSec: number }>(join(ctx.projectDir, "media", "ingest.json"));
    if (!ingest?.file) throw new Error("media/ingest.json has no file");
    const tr = await readJson<{ words: Word[] }>(join(ctx.projectDir, "transcript", "words.json"));
    // transcript order is trusted; sorting by start would reorder the text when an ASR word starts early
    const raw = (tr?.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
    const words = normalizeWordTimings(raw); // transcribe v2 already writes normalized words; this covers older words.json
    if (words.length === 0) throw new Error("no words in transcript/words.json: nothing to cut (is the clip silent or music-only?)");

    const env = await rmsEnvelope(join(ctx.projectDir, "transcript", "audio.wav"), WINDOW_MS);
    const durationSec = ingest.durationSec > 0 ? ingest.durationSec : round3((env.length * WINDOW_MS) / 1000);

    const fillerIdx = new Set(fillerWords(words, fillers as FillerList));
    const retakeIdx = new Set<number>();
    let retakesRemoved = 0;
    let retakePhrasesRemoved = 0;
    let longestRetakeSec = 0;
    if (retakes) {
      const spans = retakeEvents(words, maxRetakeSec, RETAKE_K);
      retakesRemoved = spans.length;
      retakePhrasesRemoved = spans.reduce((n, e) => n + e.phrases, 0);
      longestRetakeSec = round3(Math.max(0, ...spans.map((e) => e.sec)));
      const eps = 1e-6;
      words.forEach((w, i) => {
        if (spans.some((s) => w.start >= s.start - eps && w.end <= s.end + eps)) retakeIdx.add(i);
      });
    }
    const removedIdx = new Set<number>([...fillerIdx, ...retakeIdx]);
    const fillersRemoved = [...fillerIdx].filter((i) => !retakeIdx.has(i)).length;

    const keep = keepRanges(words, removedIdx, { maxGap, pre, post, minKeep, durationSec, env });

    // complement of keep, each span tagged with its dominant reason (retake > filler > silence)
    const gaps: Range[] = [];
    let at = 0;
    for (const k of keep) {
      if (k.start > at) gaps.push({ start: at, end: k.start });
      at = k.end;
    }
    if (at < durationSec) gaps.push({ start: at, end: durationSec });
    const removed = gaps
      .filter((g) => g.end - g.start > 1e-6)
      .map((g) => {
        let reason: Reason = "silence";
        words.forEach((w, i) => {
          const mid = (w.start + w.end) / 2;
          if (mid < g.start || mid > g.end) return;
          if (retakeIdx.has(i)) reason = "retake";
          else if (fillerIdx.has(i) && reason !== "retake") reason = "filler";
        });
        return { start: round3(g.start), end: round3(g.end), reason };
      });

    const outDurationSec = round3(keepDuration(keep));
    await mkdir(join(ctx.projectDir, "cut"), { recursive: true });
    await writeJsonAtomic(join(ctx.projectDir, "cut", "edl.json"), {
      source: ingest.file,
      fadeSec: FADE_SEC,
      keep,
      removed,
      outDurationSec,
    });

    const removedPct = Math.round(100 * (1 - keepDuration(keep) / durationSec) * 10) / 10;
    const metrics = {
      removedPct,
      cutCount: removed.length,
      // gates check words.json's own timestamps (same indices as `words`): strictest available, and catches overlaps in pre-v2 transcripts
      midWordCuts: midWordCuts(keep, raw, removedIdx),
      shortestKeepSec: keep.length === 0 ? 0 : round3(Math.min(...keep.map((k) => k.end - k.start))),
      fillersRemoved,
      droppedWords: raw.filter((w, i) => !removedIdx.has(i) && !keep.some((k) => (w.start + w.end) / 2 >= k.start && (w.start + w.end) / 2 <= k.end)).length,
      retakePhrasesRemoved,
      longestRetakeSec,
      retakesRemoved,
      outDurationSec,
      pace,
    };
    ctx.log(`cut ${pace}: keep ${keep.length}, removed ${removed.length} (${removedPct}%), fillers ${fillersRemoved}, retakes ${retakesRemoved}`);
    return { metrics, artifacts: ["cut/edl.json"] };
  },
};

export default cut;
