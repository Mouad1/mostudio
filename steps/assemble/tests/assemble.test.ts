import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry } from "../../../core/src/index.ts";
import { resolveFfmpeg, runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { assemble } from "../src/assemble.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const registry: ProviderRegistry = {
  async pick() {
    throw new Error("no providers in assemble");
  },
  async recordUse() {},
  async markExhausted() {},
};

let root: string;
let ffmpeg: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "mostudio-assemble-"));
  ffmpeg = await resolveFfmpeg(process.env, ["ass"]).catch(() => process.env.FFMPEG || "ffmpeg");
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const ff = (...args: string[]): void => {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
};
const ffprobe = process.env.FFPROBE || "ffprobe";
const probe = (file: string, entries: string, stream = "v:0"): string =>
  execFileSync(ffprobe, ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "default=nw=1:nk=1", file]).toString().trim();

type Keep = { start: number; end: number };

/** Seed a project: source video (lavfi testsrc2 + tone), edl, mix.wav of the cut length, captions files. */
async function seed(dir: string, keep: Keep[], opts: { src?: string; w?: number; h?: number; srcSec?: number } = {}): Promise<number> {
  const w = opts.w ?? 320;
  const h = opts.h ?? 240;
  const srcSec = opts.srcSec ?? 10;
  for (const d of ["media", "cut", "audio", "captions"]) await mkdir(join(dir, d), { recursive: true });
  const file = "media/clip.mp4";
  if (opts.src) {
    execFileSync("cp", [opts.src, join(dir, file)]);
  } else {
    ff(
      "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30:duration=${srcSec}`,
      "-f", "lavfi", "-i", `sine=f=440:d=${srcSec}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, file),
    );
  }
  const out = Math.round(keep.reduce((a, k) => a + k.end - k.start, 0) * 1000) / 1000;
  await writeJsonAtomic(join(dir, "media", "ingest.json"), { file, durationSec: srcSec, fps: 30, width: w, height: h, rotation: 0, hasAudio: true });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: file, fadeSec: 0.01, keep, removed: [], outDurationSec: out });
  ff("-f", "lavfi", "-i", `sine=f=220:d=${out}:sample_rate=48000`, "-ac", "2", "-c:a", "pcm_s16le", join(dir, "audio", "mix.wav"));
  const ass = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Outline,Shadow,Alignment,MarginL,MarginR,MarginV",
    "Style: Default,Arial,90,&H00FFFFFF,&H00000000,&H00000000,1,6,0,2,60,60,340", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,0:00:00.00,0:00:${String(Math.floor(out)).padStart(2, "0")}.00,Default,,0,0,0,,HELLO WORLD`, "",
  ].join("\n");
  await writeFile(join(dir, "captions", "captions.ass"), ass);
  await writeFile(join(dir, "captions", "captions.srt"), `1\n00:00:00,000 --> 00:00:01,000\nHELLO WORLD\n`);
  await writeJsonAtomic(join(dir, "captions", "cues.json"), [
    { start: 0.1, end: Math.min(out, 1.5), text: "HELLO WORLD", words: [{ w: "HELLO", start: 0.1, end: 0.7 }, { w: "WORLD", start: 0.7, end: Math.min(out, 1.5) }] },
  ]);
  return out;
}

async function project(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

const run = (dir: string, params: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env) =>
  runStep(dir, assemble, { params, config, providers: registry, force: true, env });

/** Bytes of a gray crop of the frame at `t`. */
function grayCrop(file: string, t: number, crop: string): Buffer {
  return execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=${crop},format=gray`, "-f", "rawvideo", "-"]);
}

test("assembles a 1080x1920 shorts render with burned captions", async () => {
  const dir = await project("shorts");
  const out = await seed(dir, [{ start: 0.5, end: 2.5 }, { start: 4, end: 6 }]);
  const r = await run(dir, { preset: "shorts", captionsRenderer: "ass" });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | string | boolean>;
  assert.equal(m.width, 1080);
  assert.equal(m.height, 1920);
  assert.equal(m.fps, 30);
  assert.equal(m.captionsBurned, true);
  assert.equal(m.captionsRenderer, "ass");
  assert.equal(m.batches, 1);
  assert.ok((m.durationDeltaSec as number) <= 0.05, String(m.durationDeltaSec));
  const final = join(dir, "renders", "final.mp4");
  assert.equal(probe(final, "stream=pix_fmt"), "yuv420p");
  assert.equal(probe(final, "stream=codec_name", "a:0"), "aac");
  assert.ok(Math.abs(Number(probe(final, "format=duration")) - out) <= 0.05);
  // the 320x240 source fills 1080x810 in the middle: the bottom band is black pad, except for the caption
  const band = grayCrop(final, 1, "1080:300:0:1350");
  const bright = band.filter((b) => b > 200).length;
  assert.ok(bright > 500, `caption pixels in the pad band: ${bright}`);
  assert.equal(await readFile(join(dir, "renders", "final.srt"), "utf8"), await readFile(join(dir, "captions", "captions.srt"), "utf8"));
  assert.equal(existsSync(join(dir, "cache", "assemble")), false);
});

test("150 keep ranges render in batches without error", async () => {
  const dir = await project("batches");
  const keep = Array.from({ length: 150 }, (_, i) => ({ start: i * 0.15, end: i * 0.15 + 0.1 }));
  const out = await seed(dir, keep, { w: 160, h: 120, srcSec: 23 });
  const r = await run(dir, { burnCaptions: false });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | string | boolean>;
  assert.equal(m.batches, 3);
  assert.equal(m.captionsRenderer, "none");
  assert.equal(m.captionsBurned, false);
  assert.equal(m.width, 160);
  assert.equal(m.height, 120);
  assert.ok(Math.abs((m.durationSec as number) - out) <= 0.05, `${m.durationSec} vs ${out}`);
  const frames = Number(probe(join(dir, "renders", "final.mp4"), "stream=nb_frames"));
  assert.ok(Math.abs(frames - Math.round(out * 30)) <= 1, `${frames} frames for ${out}s`);
});

test("VFR source does not drift: avOffsetMs ≤ 40", async () => {
  const dir = await project("vfr");
  // moving 3 s, frozen 3 s, moving 3 s; mpdecimate drops the frozen frames -> variable frame rate
  const raw = join(root, "vfr-raw.mp4");
  ff(
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
    "-f", "lavfi", "-i", "color=c=gray:size=320x240:rate=30:duration=3",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=f=440:d=9:sample_rate=48000",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,mpdecimate[v]",
    "-map", "[v]", "-map", "3:a", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", raw,
  );
  const nb = Number(probe(raw, "stream=nb_frames"));
  assert.ok(nb < 9 * 30 - 30, `fixture should be VFR, has ${nb} frames`);
  const out = await seed(dir, [{ start: 0.5, end: 2.5 }, { start: 3.5, end: 5.5 }, { start: 6.2, end: 8.6 }], { src: raw, srcSec: 9 });
  const r = await run(dir, { burnCaptions: false });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number>;
  assert.ok(Math.abs(m.avOffsetMs as number) <= 40, String(m.avOffsetMs));
  assert.ok((m.durationDeltaSec as number) <= 0.5, String(m.durationDeltaSec));
  const frames = Number(probe(join(dir, "renders", "final.mp4"), "stream=nb_frames"));
  assert.ok(Math.abs(frames - Math.round(out * 30)) <= 1, `${frames} frames for ${out}s (CFR)`);
});

test("project path with spaces and accents works with ass=", async () => {
  const dir = join(root, "Vidéos à monter", "l'essai");
  await mkdir(dir, { recursive: true });
  await seed(dir, [{ start: 0, end: 2 }]);
  const r = await run(dir, { preset: "youtube" });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | string | boolean>;
  assert.equal(m.captionsRenderer, "ass");
  assert.equal(m.captionsBurned, true);
  assert.equal(m.width, 1920);
  assert.equal(m.height, 1080);
});

/** Fake HyperFrames CLI: logs its args; `render` copies the background video to -o (`short`: only 0.5 s of it). */
async function fakeHyperframes(short = false): Promise<{ bin: string; log: string }> {
  const log = join(root, short ? "hf-short-log.jsonl" : "hf-log.jsonl");
  const bin = join(root, short ? "fake-hf-short.ts" : "fake-hf.ts");
  await writeFile(
    bin,
    `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "render") {
  const out = args[args.indexOf("-o") + 1];
  const src = join(args[1], "assets", "cut.mp4");
  const extra = ${short ? '["-t", "0.5"]' : "[]"};
  execFileSync(${JSON.stringify(ffmpeg)}, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, ...extra, "-c", "copy", out]);
}
`,
  );
  return { bin: `${process.execPath} ${bin}`, log };
}

test("shorts preset ≤ 180 s defaults to hyperframes captions", async () => {
  const dir = await project("hf");
  const out = await seed(dir, [{ start: 0.5, end: 2.5 }, { start: 4, end: 5 }]);
  const { bin, log } = await fakeHyperframes();
  const r = await run(dir, { preset: "shorts" }, { ...process.env, MOSTUDIO_HYPERFRAMES_BIN: bin });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | string | boolean>;
  assert.equal(m.captionsRenderer, "hyperframes");
  assert.equal(m.captionsBurned, true);
  assert.equal(m.width, 1080);
  assert.equal(m.height, 1920);
  assert.ok(Math.abs((m.durationSec as number) - out) <= 0.05);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const scene = join(dir, "scenes", "captions");
  assert.deepEqual(calls[0], ["lint", scene]);
  assert.equal(calls[1]?.[0], "render");
  assert.equal(calls[1]?.[1], scene);
  assert.ok(calls[1]?.includes("--quality") && calls[1][calls[1].indexOf("--quality") + 1] === "looks");
  assert.equal(calls[1]?.[calls[1].indexOf("-o") + 1], join(dir, "cache", "assemble", "captioned.mp4"));
  const index = await readFile(join(scene, "index.html"), "utf8");
  assert.equal(index.match(/data-track-kind="captions"/g)?.length, 1);
  assert.doesNotMatch(index, /https?:\/\//);
  assert.ok(existsSync(join(scene, "hyperframes.json")));
  assert.ok(existsSync(join(scene, "compositions", "captions.html")));
  assert.equal(probe(join(scene, "assets", "cut.mp4"), "stream=width"), "1080");
  assert.equal(probe(join(dir, "renders", "final.mp4"), "stream=codec_name", "a:0"), "aac");
});

test("hyperframes render of the wrong length fails clearly", async () => {
  const dir = await project("hf-short");
  await seed(dir, [{ start: 0.5, end: 3 }]);
  const { bin } = await fakeHyperframes(true);
  const r = await run(dir, { preset: "reels" }, { ...process.env, MOSTUDIO_HYPERFRAMES_BIN: bin });
  assert.equal(r.status, "fail");
  assert.match(JSON.stringify(r), /HyperFrames render is [\d.]+ s, expected 2.5 s/);
});

test("cuts keep picture and sound in sync (flash frames line up with beeps)", async () => {
  const dir = await project("sync");
  await mkdir(join(dir, "media"), { recursive: true });
  // a one-frame white flash and a 30 ms beep at t = k + 0.5 s
  ff(
    "-f", "lavfi", "-i", "color=c=black:size=160x120:rate=30:duration=10",
    "-f", "lavfi", "-i", "aevalsrc=0.8*sin(2*PI*1000*t)*lt(mod(t-0.5\\,1)\\,0.03)*gte(t\\,0.5):d=10:s=48000",
    "-vf", "geq=lum='if(eq(mod(N-15\\,30)\\,0)*gte(N\\,15)\\,255\\,16)':cb=128:cr=128",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "sync-src.mp4"),
  );
  const keep = [{ start: 0.2, end: 2.31 }, { start: 3.13, end: 5.77 }, { start: 6.41, end: 9.6 }];
  await seed(dir, keep, { src: join(root, "sync-src.mp4"), w: 160, h: 120, srcSec: 10 });
  // mix.wav cut from the source audio exactly like the mix step (re-zeroed audio clock)
  const graph = keep.map((k, i) => `[0:a]asetpts=PTS-STARTPTS,atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS[a${i}]`).join(";") +
    `;${keep.map((_, i) => `[a${i}]`).join("")}concat=n=${keep.length}:v=0:a=1[out]`;
  ff("-i", join(dir, "media", "clip.mp4"), "-filter_complex", graph, "-map", "[out]", "-ac", "2", "-c:a", "pcm_s16le", join(dir, "audio", "mix.wav"));
  const r = await run(dir, { burnCaptions: false });
  assert.equal(r.status, "pass", JSON.stringify(r));
  const final = join(dir, "renders", "final.mp4");
  const luma = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", final, "-vf", "scale=4:4,format=gray", "-f", "rawvideo", "-"]);
  const flashes: number[] = [];
  for (let i = 0; i * 16 < luma.length; i++) if ((luma[i * 16 + 5] ?? 0) > 128) flashes.push(i / 30);
  const pcm = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", final, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  const beeps: number[] = [];
  let last = -1;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > 8000) {
      const s = i / 2 / 48000;
      if (s - last > 0.3) beeps.push(s);
      last = s;
    }
  }
  assert.ok(flashes.length >= 6, `flashes ${flashes}`);
  assert.equal(flashes.length, beeps.length, `flashes ${flashes} vs beeps ${beeps}`);
  flashes.forEach((f, i) => assert.ok(Math.abs(f - (beeps[i] ?? -1)) <= 0.04, `flash ${f.toFixed(3)} vs beep ${beeps[i]?.toFixed(3)}`));
});
