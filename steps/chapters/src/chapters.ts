import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatComplete, clampKeeps, durationBound, keepDuration, mapToCut, NoProviderError, normalizeWordTimings, readJson, unitsToWords, withProvider, writeJsonAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule, Unit, Word } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { buildMessages, buildTranscript, mmss } from "./prompt.ts";

export type Chapter = { start: number; title: string };

const MIN_GAP_SEC = 10;
const SNAP_SEC = 10;
const SENTENCE_GAP_SEC = 0.6;
const MAX_TITLE = 50;
const LLM_TIMEOUT_MS = 45_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Source words (transcript order, normalized timings) -> cut timeline (a word is kept when its midpoint is inside a keep). Never sorts by start: that reorders the text. */
function toCut(words: Word[], keep: Range[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const k = keep.find((r) => mid >= r.start && mid <= r.end);
    if (!k) continue;
    const start = mapToCut(Math.min(Math.max(w.start, k.start), k.end), keep);
    const end = mapToCut(Math.min(Math.max(w.end, k.start), k.end), keep);
    if (start === undefined || end === undefined) continue;
    out.push({ w: w.w, start: round3(start), end: round3(end) });
  }
  return out;
}

/** Title language for a localize lang; undefined for `source` (titles follow the transcript). */
export function titleLanguage(lang: string | undefined): string | undefined {
  if (lang === "arabizi") return "Moroccan Darija written in Arabizi (Latin letters)";
  if (lang === "fr") return "French";
  if (lang === "en") return "English";
  return undefined;
}

export function formatYoutube(chs: Chapter[]): string {
  return chs
    .map((c) => {
      const s = Math.floor(c.start);
      const stamp = s >= 3600 ? `${Math.floor(s / 3600)}:${mmss(s % 3600)}` : mmss(s);
      return `${stamp} ${c.title}`;
    })
    .join("\n") + "\n";
}

/** Seconds from a number, a numeric string, or `m:ss` / `mm:ss` / `h:mm:ss`; NaN otherwise. */
function toSeconds(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number.NaN;
}

/** Parse + validate the model's reply; throws so withProvider rotates to the next provider. */
export function parseChapters(raw: string, outDurationSec: number): Chapter[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    try {
      if (a < 0 || b <= a) throw new Error("none");
      data = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new Error("model reply is not valid JSON");
    }
  }
  const list = Array.isArray(data) ? data : (data as { chapters?: unknown } | null)?.chapters;
  if (!Array.isArray(list) || list.length === 0) throw new Error("model reply has no chapters");
  return list.map((c, i) => {
    const { start: rawStart, title } = (c ?? {}) as { start?: unknown; title?: unknown };
    const start = toSeconds(rawStart);
    if (!Number.isFinite(start) || start < 0 || start >= outDurationSec) throw new Error(`chapter ${i}: start out of range`);
    if (typeof title !== "string" || title.trim() === "") throw new Error(`chapter ${i}: empty title`);
    return { start, title: title.trim() };
  });
}

function trimTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut.slice(0, MAX_TITLE)).trim();
}

/** Sort, force first at 0, snap to sentence starts, merge chapters closer than 10 s, trim titles. */
export function postProcess(input: Chapter[], cutWords: Word[], outDurationSec: number): Chapter[] {
  const sentenceStarts = cutWords.filter((w, i) => i === 0 || w.start - cutWords[i - 1].end > SENTENCE_GAP_SEC).map((w) => w.start);
  const sorted = [...input].sort((a, b) => a.start - b.start);
  const out: Chapter[] = [];
  for (const [i, c] of sorted.entries()) {
    let start = i === 0 ? 0 : c.start;
    if (i > 0) {
      let best = start;
      let bestD = SNAP_SEC + 1e-9;
      for (const s of sentenceStarts) {
        const d = Math.abs(s - c.start);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      start = best;
    }
    const prev = out[out.length - 1];
    if (prev && start - prev.start < MIN_GAP_SEC) continue;
    out.push({ start: round1(start), title: trimTitle(c.title) });
  }
  const last = out[out.length - 1];
  if (out.length > 1 && outDurationSec - last.start < MIN_GAP_SEC) out.pop();
  return out;
}

const firstWords = (words: Word[], from: number, n = 6): string => {
  const t = words.filter((w) => w.start >= from - 1e-9).slice(0, n).map((w) => w.w).join(" ");
  return trimTitle(t) || "Intro";
};

/** Chapters at the longest pauses; no model involved. */
export function fallbackChapters(words: Word[], outDurationSec: number): Chapter[] {
  const target = Math.max(2, Math.round(outDurationSec / 180));
  const gaps = words.slice(1).map((w, i) => ({ at: w.start, gap: w.start - words[i].end })).sort((a, b) => b.gap - a.gap);
  const starts = [0];
  for (const g of gaps) {
    if (starts.length >= target) break;
    if (g.at < MIN_GAP_SEC || outDurationSec - g.at < MIN_GAP_SEC) continue;
    if (starts.some((s) => Math.abs(s - g.at) < MIN_GAP_SEC)) continue;
    starts.push(g.at);
  }
  starts.sort((a, b) => a - b);
  return starts.map((s) => ({ start: round1(s), title: firstWords(words, s) }));
}

export const chapters: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const tr = await readJson<{ language?: string; words: Word[] }>(join(ctx.projectDir, "transcript", "words.json"));
    const edl = await readJson<{ keep: Range[]; outDurationSec: number; sourceDurationSec?: number }>(join(ctx.projectDir, "cut", "edl.json"));
    if (!edl || !Array.isArray(edl.keep)) throw new Error("cut/edl.json has no keep list");
    // same clamp as mix/assemble: chapter times must fit the rendered length
    const keep = clampKeeps(edl.keep, durationBound(edl.sourceDurationSec)).keep;
    const outDur = Math.min(durationBound(edl.outDurationSec), keepDuration(keep));
    // words.json from transcribe v2 is already normalized; this covers older files
    const source = normalizeWordTimings((tr?.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start));
    const loc = await readJson<{ lang?: string; units?: Unit[] }>(join(ctx.projectDir, "localize", "units.json"));
    const localized = loc?.lang !== undefined && loc.lang !== "source";
    // localized units are already on the cut timeline
    const words = localized ? unitsToWords(loc.units ?? []) : toCut(source, keep);
    const language =
      typeof ctx.params.language === "string" && ctx.params.language !== "" ? ctx.params.language : localized ? titleLanguage(loc.lang) : undefined;
    const prefer = typeof ctx.params.prefer === "string" && ctx.params.prefer !== "" ? ctx.params.prefer : undefined;

    let list: Chapter[];
    let providerId = "none";
    let fallback = false;
    let provider: { id: string; model: string } | undefined;
    if (outDur < 30) {
      list = [{ start: 0, title: firstWords(words, 0) }];
    } else if (words.length === 0) {
      list = [{ start: 0, title: "Intro" }];
      fallback = true;
    } else {
      const messages = buildMessages(buildTranscript(words), outDur, language);
      try {
        const elapsed = new Map<string, number>();
        const r = await withProvider(
          ctx.providers,
          "llm",
          async (p) => {
            const t0 = Date.now();
            try {
              return parseChapters(await chatComplete(p, messages, { json: true, timeoutMs: LLM_TIMEOUT_MS }), outDur);
            } finally {
              elapsed.set(p.id, Date.now() - t0);
            }
          },
          { prefer, private: true },
        );
        for (const a of r.attempts) ctx.log(`chapters: ${a.id} failed: ${a.error} (${elapsed.get(a.id) ?? 0} ms)`);
        list = postProcess(r.result, words, outDur);
        provider = r.provider;
        providerId = r.provider.id;
      } catch (err) {
        if (!(err instanceof NoProviderError)) throw err;
        ctx.log(`chapters: no LLM available (${err.message}); using pause-based chapters`);
        list = fallbackChapters(words, outDur);
        fallback = true;
      }
    }

    const outDir = join(ctx.projectDir, "chapters");
    await mkdir(outDir, { recursive: true });
    await writeJsonAtomic(join(outDir, "chapters.json"), list);
    await writeFile(join(outDir, "youtube.txt"), formatYoutube(list));

    const gaps = list.map((c, i) => (i + 1 < list.length ? list[i + 1].start : outDur) - c.start);
    const metrics = {
      chapterCount: list.length,
      minChapterSec: round1(Math.min(...gaps)),
      firstAtZero: list[0]?.start === 0,
      provider: providerId,
      fallback,
    };
    ctx.log(`chapters: ${list.length} via ${providerId}${fallback ? " (fallback)" : ""}`);
    return { metrics, artifacts: ["chapters/chapters.json", "chapters/youtube.txt"], ...(provider ? { provider } : {}) };
  },
};

export default chapters;
