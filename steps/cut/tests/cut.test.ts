import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry } from "../../../core/src/index.ts";
import { runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { cut } from "../src/cut.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const registry: ProviderRegistry = {
  async pick() {
    throw new Error("no providers in cut");
  },
  async recordUse() {},
  async markExhausted() {},
};
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-cut-"));
  await mkdir(join(dir, "media"), { recursive: true });
  await mkdir(join(dir, "transcript"), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sineSilenceSine(out: string): void {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=16000",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=16000",
    "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ac", "1", "-c:a", "pcm_s16le", out,
  ]);
}

async function seed(words: { w: string; start: number; end: number }[], durationSec: number): Promise<void> {
  await writeJsonAtomic(join(dir, "media", "ingest.json"), { file: "media/clip.mp4", durationSec });
  await writeJsonAtomic(join(dir, "transcript", "words.json"), { language: "fr", provider: { id: "x", model: "y" }, durationSec, words, segments: [] });
}

const run = (params: Record<string, unknown> = {}) => runStep(dir, cut, { params, config, providers: registry });

test("silence between two speech blocks is cut at the quiet point", async () => {
  sineSilenceSine(join(dir, "transcript", "audio.wav"));
  await seed(
    [
      { w: "bonjour", start: 0.2, end: 0.8 },
      { w: "tout", start: 0.9, end: 1.9 },
      { w: "le", start: 3.6, end: 4.0 },
      { w: "monde", start: 4.1, end: 5.3 },
    ],
    5.5,
  );
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  const edl = JSON.parse(await readFile(join(dir, "cut", "edl.json"), "utf8"));
  assert.equal(edl.source, "media/clip.mp4");
  assert.equal(edl.fadeSec, 0.01);
  assert.equal(edl.keep.length, 2, JSON.stringify(edl));
  assert.ok(edl.keep[0].end > 1.9 && edl.keep[0].end <= 2.05, `keep0 end ${edl.keep[0].end}`);
  assert.ok(edl.keep[1].start >= 3.5 && edl.keep[1].start < 3.6, `keep1 start ${edl.keep[1].start}`);
  assert.equal(edl.removed.length, 3, "leading sliver, middle silence, trailing sliver");
  assert.ok(edl.removed.every((x: { reason: string }) => x.reason === "silence"));
  assert.equal(r.metrics.midWordCuts, 0);
  assert.equal(r.metrics.cutCount, 3);
  assert.ok(Math.abs((r.metrics.outDurationSec as number) - edl.outDurationSec) < 1e-6);
});

test("unknown pace fails with a clear error", async () => {
  const r = await run({ pace: "warp" });
  assert.equal(r.status, "fail");
  assert.match(JSON.stringify(r), /pace/);
});

test("zero words keeps nothing and gives a clear error", async () => {
  await seed([], 5.5);
  const r = await run();
  assert.equal(r.status, "fail");
  assert.match(JSON.stringify(r), /no words/);
});

test("end to end: filler, retake and long pause", async () => {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6.6:sample_rate=16000",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.9:sample_rate=16000",
    "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ac", "1", "-c:a", "pcm_s16le", join(dir, "transcript", "audio.wav"),
  ]);
  const w = (word: string, start: number, end: number) => ({ w: word, start, end });
  await seed(
    [
      w("bonjour", 0.5, 1.0), w("euh", 1.1, 1.6), w("à", 1.7, 1.9), w("tous", 1.95, 2.3),
      w("on", 3.2, 3.4), w("va", 3.4, 3.6), w("voir", 3.6, 4.0),
      w("on", 5.0, 5.2), w("va", 5.2, 5.4), w("voir", 5.4, 5.8), w("comment", 5.9, 6.4),
      w("zzz", 7.0, 6.9),
      w("ça", 8.8, 9.1), w("marche", 9.2, 9.8),
    ],
    10.5,
  );
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  const edl = JSON.parse(await readFile(join(dir, "cut", "edl.json"), "utf8"));
  const near = (a: number, b: number, tol = 0.1) => Math.abs(a - b) <= tol;
  assert.equal(edl.keep.length, 4, JSON.stringify(edl.keep));
  assert.deepEqual(edl.removed.map((x: { reason: string }) => x.reason), ["silence", "filler", "retake", "silence", "silence"]);
  assert.ok(near(edl.removed[1].start, 1.05) && near(edl.removed[1].end, 1.65), JSON.stringify(edl.removed[1]));
  assert.ok(near(edl.removed[2].start, 2.45) && near(edl.removed[2].end, 4.9), JSON.stringify(edl.removed[2]));
  assert.ok(near(edl.removed[3].start, 6.55) && near(edl.removed[3].end, 8.7), JSON.stringify(edl.removed[3]));
  assert.equal(r.metrics.fillersRemoved, 1);
  assert.equal(r.metrics.retakesRemoved, 1);
  assert.equal(r.metrics.retakePhrasesRemoved, 1);
  assert.equal(r.metrics.longestRetakeSec, 1.8);
  assert.equal(r.metrics.droppedWords, 0);
  assert.equal(r.metrics.midWordCuts, 0);
});
