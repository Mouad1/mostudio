import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeWordTimings, readJson, writeJsonAtomic, writeOutputAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule, Word } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { buildAss } from "./ass.ts";
import { buildCues, toCutWords } from "./group.ts";
import type { CaptionStyle } from "./group.ts";
import { applyReplacements, parseReplacementsWithStats } from "./replace.ts";
import { buildReviewText, buildSrt } from "./srt.ts";

const ARABIC = /[\u0600-\u06FF]/;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const size = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

export const captions: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const styleParam = typeof ctx.params.style === "string" ? ctx.params.style : "long";
    if (styleParam !== "long" && styleParam !== "short") throw new Error(`unknown style "${styleParam}" (expected long or short)`);
    const style: CaptionStyle = styleParam;
    const font = typeof ctx.params.font === "string" && ctx.params.font !== "" ? ctx.params.font : "Arial";

    const ingest = await readJson<{ width?: number; height?: number }>(join(ctx.projectDir, "media", "ingest.json"));
    const width = size(ctx.params.width) ?? size(ingest?.width) ?? (style === "short" ? 1080 : 1920);
    const height = size(ctx.params.height) ?? size(ingest?.height) ?? (style === "short" ? 1920 : 1080);

    const tr = await readJson<{ words: Word[] }>(join(ctx.projectDir, "transcript", "words.json"));
    const edl = await readJson<{ keep: Range[] }>(join(ctx.projectDir, "cut", "edl.json"));
    if (!edl || !Array.isArray(edl.keep)) throw new Error("cut/edl.json has no keep list");
    const keep = edl.keep;
    // words.json from transcribe v2 is already normalized; this covers older files
    const source = normalizeWordTimings((tr?.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start));

    let repText = "";
    try {
      repText = await readFile(join(ctx.projectDir, "edits", "replacements.txt"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const { rules, ignored } = parseReplacementsWithStats(repText);
    const replaced = applyReplacements(source, rules);

    const cutWords = toCutWords(replaced.words, keep);
    let acc = 0;
    const segEnds = keep.map((k) => (acc += k.end - k.start));
    const cues = buildCues(cutWords, style, segEnds);

    const outDir = join(ctx.projectDir, "captions");
    await mkdir(outDir, { recursive: true });
    await writeJsonAtomic(join(outDir, "cues.json"), cues);
    await writeOutputAtomic(join(outDir, "captions.srt"), (tmp) => writeFile(tmp, buildSrt(cues)));
    await writeOutputAtomic(join(outDir, "captions.ass"), (tmp) => writeFile(tmp, buildAss(cues, style, { width, height, font })));
    await writeOutputAtomic(join(outDir, "captions.txt"), (tmp) => writeFile(tmp, buildReviewText(cues)));

    const speeds = cues.filter((c) => c.end - c.start >= 0.3).map((c) => c.text.length / (c.end - c.start));
    const metrics = {
      cueCount: cues.length,
      maxCharsPerLine: Math.max(0, ...cues.map((c) => c.text.length)),
      maxReadingSpeed: round1(Math.max(0, ...speeds)),
      replacementsApplied: replaced.applied,
      replacementRulesIgnored: ignored,
      arabicScriptPct: cutWords.length === 0 ? 0 : round1((100 * cutWords.filter((w) => ARABIC.test(w.w)).length) / cutWords.length),
      style,
    };
    ctx.log(`captions ${style}: ${cues.length} cues, ${replaced.applied} replacements, ${ignored} rules ignored`);
    return {
      metrics,
      artifacts: ["captions/cues.json", "captions/captions.srt", "captions/captions.ass", "captions/captions.txt"],
    };
  },
};

export default captions;
