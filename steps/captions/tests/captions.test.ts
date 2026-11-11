import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry, Word } from "../../../core/src/index.ts";
import { runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { assDialogueText, buildAss, escapeAssText, formatAssTimestamp } from "../src/ass.ts";
import { captions } from "../src/captions.ts";
import { buildCues, toCutWords } from "../src/group.ts";
import { applyReplacements, parseReplacements } from "../src/replace.ts";
import { buildSrt, formatSrtTimestamp } from "../src/srt.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const registry: ProviderRegistry = {
  async pick() {
    throw new Error("no providers in captions");
  },
  async recordUse() {},
  async markExhausted() {},
};
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-captions-"));
  for (const d of ["media", "transcript", "cut", "edits"]) await mkdir(join(dir, d), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const W = (w: string, start: number, end: number): Word => ({ w, start, end });
/** n words of 0.3 s each, back to back from t0 */
function seq(texts: string[], t0 = 0, step = 0.3): Word[] {
  return texts.map((t, i) => W(t, t0 + i * step, t0 + (i + 1) * step));
}
async function seed(words: Word[], keep: { start: number; end: number }[], rep = "", ingest: object = { width: 1920, height: 1080 }) {
  await writeJsonAtomic(join(dir, "media", "ingest.json"), { file: "media/c.mp4", durationSec: 60, ...ingest });
  await writeJsonAtomic(join(dir, "transcript", "words.json"), { language: "en", words });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: "media/c.mp4", fadeSec: 0.01, keep, removed: [], outDurationSec: keep.reduce((s, k) => s + k.end - k.start, 0) });
  await (await import("node:fs/promises")).writeFile(join(dir, "edits", "replacements.txt"), rep);
}
const run = (params: Record<string, unknown> = {}) => runStep(dir, captions, { params, config, providers: registry });

test("long style keeps lines ≤ 42 chars", () => {
  const words = seq("the quick brown fox jumps over the lazy dog while another quick brown fox watches from afar today".split(" "));
  const cues = buildCues(toCutWords(words, [{ start: 0, end: 100 }]), "long");
  assert.ok(cues.length > 1);
  for (const c of cues) assert.ok(c.text.length <= 42, c.text);
  assert.equal(cues.map((c) => c.text).join(" "), words.map((w) => w.w).join(" "));
});

test("long style splits on a gap > 0.6 s and on 5 s", () => {
  const gap = buildCues(toCutWords([W("a", 0, 0.3), W("b", 1.0, 1.3)], [{ start: 0, end: 10 }]), "long");
  assert.equal(gap.length, 2);
  const slow = buildCues(toCutWords(seq(["a", "b", "c", "d", "e", "f"], 0, 1.0), [{ start: 0, end: 10 }]), "long");
  for (const c of slow) assert.ok(c.end - c.start <= 5 + 1e-9);
  assert.ok(slow.length >= 2);
});

test("short style ≤ 3 words with karaoke tags", () => {
  const words = seq(["one", "two", "three", "four", "five"]);
  const cues = buildCues(toCutWords(words, [{ start: 0, end: 10 }]), "short");
  assert.deepEqual(cues.map((c) => c.words.length), [3, 2]);
  const text = assDialogueText(cues[0], "short");
  assert.match(text, /^\{\\k30\}one \{\\k30\}two \{\\k30\}three$/);
  const ass = buildAss(cues, "short", { width: 1080, height: 1920, font: "Arial" });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Default,Arial,84,&H00FFFFFF,&H0000D4FF,&H00000000/);
  assert.match(ass, /,6,0,2,\d+,\d+,340,1/);
});

test("cue times are in the cut timeline and never cross a cut", () => {
  const words = [W("a", 1, 1.3), W("b", 1.3, 1.6), W("gone", 3, 3.4), W("c", 5, 5.3), W("d", 5.3, 5.6)];
  const keep = [{ start: 0.9, end: 2 }, { start: 4.9, end: 6 }];
  const cw = toCutWords(words, keep);
  assert.equal(cw.length, 4);
  const cues = buildCues(cw, "long");
  assert.equal(cues.length, 2);
  assert.deepEqual([cues[0].text, cues[1].text], ["a b", "c d"]);
  const off = 2 - 0.9;
  assert.ok(Math.abs(cues[0].start - 0.1) < 1e-9);
  assert.ok(Math.abs(cues[1].start - (off + 0.1)) < 1e-9);
});

test("word partly trimmed by padding is clamped into its keep", () => {
  const cw = toCutWords([W("edge", 0.9, 1.3)], [{ start: 1.0, end: 2 }]);
  assert.equal(cw.length, 1);
  assert.equal(cw[0].start, 0);
  assert.ok(Math.abs(cw[0].end - 0.3) < 1e-9);
});

test("min cue length 0.5 s without overlapping the next cue", () => {
  const cues = buildCues(toCutWords([W("a", 0, 0.1), W("b", 0.9, 1.0), W("c", 2, 2.1)], [{ start: 0, end: 10 }]), "long");
  assert.equal(cues.length, 3);
  assert.ok(cues[0].end - cues[0].start >= 0.5 - 1e-9);
  assert.ok(cues[0].end <= cues[1].start + 1e-9);
  assert.ok(cues[1].end - cues[1].start >= 0.5 - 1e-9);
});

test("replacement rule fixes a word and counts it", () => {
  const rules = parseReplacements("# note\nmarginal => Marginol\n");
  const r = applyReplacements([W("The", 0, 1), W("Marginal,", 1, 2), W("marginally", 2, 3)], rules);
  assert.deepEqual(r.words.map((w) => w.w), ["The", "Marginol,", "marginally"]);
  assert.equal(r.applied, 1);
});

test("multi-word replacement merges times", () => {
  const rules = parseReplacements("wa zane => Ouazzane");
  const r = applyReplacements([W("hi", 0, 1), W("Wa", 1, 1.5), W("Zane.", 1.6, 2.2), W("ok", 3, 4)], rules);
  assert.deepEqual(r.words.map((w) => w.w), ["hi", "Ouazzane.", "ok"]);
  assert.equal(r.words[1].start, 1);
  assert.equal(r.words[1].end, 2.2);
  assert.equal(r.applied, 1);
});

test("parseReplacements ignores comments and malformed lines", () => {
  const rules = parseReplacements("# c\n\nfoo => bar\nno arrow here\n => x\ny => \n");
  assert.deepEqual(rules, [{ from: ["foo"], to: "bar" }]);
});

test("ass escapes braces and backslashes", () => {
  assert.equal(escapeAssText("a{b}c\\d\ne"), "a\\{b\\}c\\\\d\\Ne");
  assert.equal(formatAssTimestamp(3661.239), "1:01:01.24");
});

test("srt timestamps use comma milliseconds", () => {
  assert.equal(formatSrtTimestamp(3661.5), "01:01:01,500");
  assert.equal(formatSrtTimestamp(0.0004), "00:00:00,000");
  const srt = buildSrt([{ start: 0, end: 1.25, text: "hi", words: [] }, { start: 2, end: 3, text: "yo", words: [] }]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,250\nhi\n\n2\n00:00:02,000 --> 00:00:03,000\nyo\n\n");
});

test("step writes cues, srt, ass, txt and metrics with replacements", async () => {
  await seed(seq(["this", "is", "marginal", "labs", "speaking"], 1, 0.5), [{ start: 0, end: 10 }], "marginal => Marginol\nbroken line\n");
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.cueCount, 1);
  assert.equal(r.metrics.replacementsApplied, 1);
  assert.equal(r.metrics.replacementRulesIgnored, 1);
  assert.equal(r.metrics.arabicScriptPct, 0);
  const txt = await readFile(join(dir, "captions", "captions.txt"), "utf8");
  assert.equal(txt, "[00:01.00 → 00:03.50] this is Marginol labs speaking\n");
  const cues = JSON.parse(await readFile(join(dir, "captions", "cues.json"), "utf8"));
  assert.equal(cues[0].words.length, 5);
  assert.match(await readFile(join(dir, "captions", "captions.srt"), "utf8"), /^1\n00:00:01,000 --> 00:00:03,500\n/);
  assert.match(await readFile(join(dir, "captions", "captions.ass"), "utf8"), /PlayResX: 1920[\s\S]*Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,this is Marginol labs speaking/);
});

test("arabic-script words raise arabicScriptPct", async () => {
  await seed(seq(["salam", "مرحبا", "x", "y"]), [{ start: 0, end: 10 }]);
  const r = await run();
  assert.equal(r.metrics.arabicScriptPct, 25);
  assert.equal(r.status, "warn");
});

test("music-only edl (no keep) gives zero cues without crashing", async () => {
  await seed([], []);
  const r = await run();
  assert.equal(r.metrics.cueCount, 0);
  assert.equal(r.status, "warn");
  assert.equal(await readFile(join(dir, "captions", "captions.srt"), "utf8"), "");
  assert.match(await readFile(join(dir, "captions", "captions.ass"), "utf8"), /\[Events\]/);
  assert.equal(JSON.parse(await readFile(join(dir, "captions", "cues.json"), "utf8")).length, 0);
});

test("unknown style fails", async () => {
  await seed(seq(["a"]), [{ start: 0, end: 10 }]);
  const r = await run({ style: "huge" });
  assert.equal(r.status, "fail");
});

test("short style defaults to 1080x1920 without ingest size override", async () => {
  await seed(seq(["a", "b", "c", "d"]), [{ start: 0, end: 10 }], "", { width: 640, height: 360 });
  const r = await run({ style: "short", width: 1080, height: 1920 });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.cueCount, 2);
  assert.match(await readFile(join(dir, "captions", "captions.ass"), "utf8"), /PlayResY: 1920/);
});
