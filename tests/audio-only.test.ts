import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry } from "../core/src/index.ts";
import { resolveFfmpeg, runStep, writeJsonAtomic } from "../core/src/index.ts";
import { defaultSteps } from "../steps/index.ts";

// An audio-only voice memo through ingest -> assemble -> qa. The AI steps in between (transcribe, cut, captions,
// mix) are stood in for by their output files, so this runs offline.

const config: Config = { billing: "free-only", projectsRoot: "/x", inspirationRoot: "/x", home: "/x" };
const providers: ProviderRegistry = {
  async pick() {
    throw new Error("no providers");
  },
  async recordUse() {},
  async markExhausted() {},
};
const assFfmpeg = await resolveFfmpeg(process.env, ["ass"]).catch(() => undefined);
const ffmpeg = assFfmpeg ?? (process.env.FFMPEG || "ffmpeg");
const ffprobe = process.env.FFPROBE || "ffprobe";
const ff = (...args: string[]): void => {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
};
const probe = (file: string, entries: string, stream = "v:0"): string =>
  execFileSync(ffprobe, ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "default=nw=1:nk=1", file]).toString().trim();

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "mostudio-audio-only-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("audio-only voice memo: ingest, assemble over a plain background with burned captions, qa", { skip: assFfmpeg ? false : "no ffmpeg build with the ass filter (libass)" }, async () => {
  const memo = join(root, "voice memo.mp4");
  ff("-f", "lavfi", "-i", "sine=f=330:d=6:sample_rate=48000,volume=2.4", "-c:a", "aac", "-f", "mp4", memo);
  const dir = join(root, "project");
  await mkdir(dir, { recursive: true });
  const logs: string[] = [];
  const opts = (params: Record<string, unknown>) => ({ params, config, providers, force: true, log: (l: string) => logs.push(l) });

  const ing = await runStep(dir, defaultSteps.ingest!, opts({ source: memo }));
  assert.equal(ing.status, "pass", JSON.stringify(ing));
  assert.equal(ing.metrics.hasVideo, false);
  assert.ok(logs.some((l) => l.includes("no picture in this file: the video will use a plain background")), logs.join("\n"));

  // stand-ins for cut, mix and captions (long style, 1920x1080 layout: the captions default for a file with no size)
  const keep = [{ start: 0.3, end: 2.3 }, { start: 3, end: 5.5 }];
  const out = 4.5;
  for (const d of ["cut", "audio", "captions"]) await mkdir(join(dir, d), { recursive: true });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: "media/voice memo.mp4", fadeSec: 0.01, keep, removed: [], outDurationSec: out });
  const graph = `${keep.map((k, i) => `[0:a]atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS[a${i}]`).join(";")};[a0][a1]concat=n=2:v=0:a=1[o]`;
  ff("-i", memo, "-filter_complex", graph, "-map", "[o]", "-ac", "2", "-c:a", "pcm_s16le", join(dir, "audio", "mix.wav"));
  await writeFile(
    join(dir, "captions", "captions.ass"),
    [
      "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
      "[V4+ Styles]",
      "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Outline,Shadow,Alignment,MarginL,MarginR,MarginV",
      "Style: Default,Arial,48,&H00FFFFFF,&H00000000,&H00000000,1,3,0,2,60,60,60", "",
      "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
      "Dialogue: 0,0:00:00.00,0:00:04.50,Default,,0,0,0,,HELLO FROM A VOICE MEMO", "",
    ].join("\n"),
  );
  await writeFile(join(dir, "captions", "captions.srt"), "1\n00:00:00,000 --> 00:00:04,500\nHELLO FROM A VOICE MEMO\n");
  await writeJsonAtomic(join(dir, "captions", "cues.json"), [{ start: 0, end: out, text: "HELLO FROM A VOICE MEMO", words: [] }]);

  const asm = await runStep(dir, defaultSteps.assemble!, opts({}));
  assert.equal(asm.status, "pass", JSON.stringify(asm));
  const m = asm.metrics as Record<string, number | string | boolean>;
  assert.equal(m.plainBackground, true);
  assert.equal(m.captionsRenderer, "ass");
  assert.equal(m.width, 1920);
  assert.equal(m.height, 1080);
  assert.equal(m.fps, 30);
  const final = join(dir, "renders", "final.mp4");
  const types = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", final]).toString().trim().split("\n");
  assert.deepEqual(types.sort(), ["audio", "video"]);
  assert.equal(probe(final, "stream=codec_name"), "h264");
  assert.equal(probe(final, "stream=codec_name", "a:0"), "aac");
  assert.ok(Math.abs(Number(probe(final, "format=duration")) - out) <= 0.05);
  const frames = Number(probe(final, "stream=nb_frames"));
  assert.ok(Math.abs(frames - Math.round(out * 30)) <= 1, `${frames} frames for ${out}s`);
  // black background: the bright pixels near the bottom are the burned caption
  const band = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", final, "-frames:v", "1", "-vf", "crop=1920:200:0:820,format=gray", "-f", "rawvideo", "-"]);
  assert.ok(band.filter((b) => b > 200).length > 500, "caption pixels in the bottom band");

  const q = await runStep(dir, defaultSteps.qa!, opts({}));
  assert.notEqual(q.status, "fail", JSON.stringify(q));
  assert.equal(q.metrics.blackChecked, false);
  assert.equal(q.metrics.blackStartSec, 0);
  assert.equal(q.metrics.hasAudio, true);
  assert.match(await readFile(join(dir, "renders", "qa.md"), "utf8"), /Black opening \(blackStartSec\) \| skipped/);
});
