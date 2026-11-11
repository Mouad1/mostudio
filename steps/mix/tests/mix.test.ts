import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry } from "../../../core/src/index.ts";
import { measureLoudness, rmsEnvelope, runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { mix } from "../src/mix.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const registry: ProviderRegistry = {
  async pick() {
    throw new Error("no providers in mix");
  },
  async recordUse() {},
  async markExhausted() {},
};
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-mix-"));
  await mkdir(join(dir, "media"), { recursive: true });
  await mkdir(join(dir, "cut"), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ff = (...args: string[]): void => {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
};

/** Speech-like source: 220 Hz tone gated on/off at 4 Hz (50% duty), `sec` long. */
function makeVoice(out: string, sec: number): void {
  ff("-f", "lavfi", "-i", `aevalsrc=0.5*sin(2*PI*220*t)*gt(sin(2*PI*4*t)\\,0):d=${sec}:s=48000`, "-ac", "2", out);
}

async function seed(keep: { start: number; end: number }[], file = "media/clip.wav", hasAudio = true): Promise<number> {
  const out = Math.round(keep.reduce((a, k) => a + k.end - k.start, 0) * 1000) / 1000;
  await writeJsonAtomic(join(dir, "media", "ingest.json"), { file, durationSec: 30, hasAudio });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: file, fadeSec: 0.01, keep, removed: [], outDurationSec: out });
  return out;
}

const run = (params: Record<string, unknown> = {}) => runStep(dir, mix, { params, config, providers: registry, force: true });

test("mix hits -14 LUFS +-1 and duration equals outDurationSec", async () => {
  makeVoice(join(dir, "media", "clip.wav"), 12);
  const out = await seed([{ start: 0.5, end: 3 }, { start: 4, end: 6.5 }, { start: 8, end: 10 }]);
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | boolean>;
  assert.ok(Math.abs((m.integratedLufs as number) + 14) <= 1, String(m.integratedLufs));
  assert.ok((m.truePeakDb as number) <= -1, String(m.truePeakDb));
  assert.ok(Math.abs((m.durationSec as number) - out) <= 0.05, `${m.durationSec} vs ${out}`);
  assert.equal(m.segments, 3);
  assert.equal(m.hasMusic, false);
  const l = await measureLoudness(join(dir, "audio", "mix.wav"), process.env);
  assert.ok(Math.abs(l.integratedLufs - (m.integratedLufs as number)) < 0.15);
});

test("200 segments mix without error (batching)", async () => {
  makeVoice(join(dir, "media", "clip.wav"), 25);
  const keep = Array.from({ length: 200 }, (_, i) => ({ start: i * 0.12, end: i * 0.12 + 0.1 }));
  const out = await seed(keep);
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  const m = r.metrics as Record<string, number | boolean>;
  assert.equal(m.segments, 200);
  assert.equal(m.batches, 3);
  assert.ok(Math.abs((m.durationSec as number) - out) <= 0.05, `${m.durationSec} vs ${out}`);
});

test("music is ducked under voice by >= 6 dB", async () => {
  // voice: 0..4 s silent, then a steady tone (rms ~0.35) 4..8 s; music: constant 1 kHz
  ff(
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=4",
    "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=48000",
    "-filter_complex", "[1]volume=4,aformat=channel_layouts=stereo[b];[0][b]concat=n=2:v=0:a=1", join(dir, "media", "clip.wav"),
  );
  ff("-f", "lavfi", "-i", "sine=f=1000:d=3:sample_rate=48000", "-ac", "2", join(dir, "music.wav"));
  await seed([{ start: 0, end: 8 }]);
  const r = await run({ music: join(dir, "music.wav") });
  // loudness gate may legitimately report on this synthetic mix; only the ducking is asserted here
  assert.ok(r.metrics, JSON.stringify(r));
  assert.equal((r.metrics as Record<string, unknown>).hasMusic, true);
  // isolate the 1 kHz music component by band-passing the mix, then compare windows
  ff("-i", join(dir, "audio", "mix.wav"), "-af", "highpass=f=900,highpass=f=900,highpass=f=900,lowpass=f=1100,lowpass=f=1100,lowpass=f=1100", "-ar", "16000", "-ac", "1", join(dir, "band.wav"));
  const env = await rmsEnvelope(join(dir, "band.wav"), 100);
  const avg = (a: number, b: number): number => {
    let s = 0;
    for (let i = a; i < b; i++) s += 10 ** ((env[i] ?? -96) / 10);
    return 10 * Math.log10(s / (b - a));
  };
  const musicOnly = avg(10, 35); // 1.0-3.5 s
  const underVoice = avg(55, 78); // 5.5-7.8 s (past attack/release)
  assert.ok(musicOnly - underVoice >= 6, `music-only ${musicOnly.toFixed(1)} dB vs under voice ${underVoice.toFixed(1)} dB`);
});

test("source without audio fails clearly", async () => {
  await seed([{ start: 0, end: 1 }], "media/clip.wav", false);
  const r = await run();
  assert.equal(r.status, "fail");
  assert.match(JSON.stringify(r), /source has no audio track/);
});

test("edl.json is read-only input (unchanged)", async () => {
  makeVoice(join(dir, "media", "clip.wav"), 12);
  await seed([{ start: 0, end: 2 }]);
  const before = await readFile(join(dir, "cut", "edl.json"), "utf8");
  await run();
  assert.equal(await readFile(join(dir, "cut", "edl.json"), "utf8"), before);
});
