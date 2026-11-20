import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { quietestPoint, rmsEnvelope } from "./envelope.ts";

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-env-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

async function gapWav(): Promise<string> {
  const out = join(tmp, "gap.wav");
  ff([
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=16000",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=16000",
    "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1",
    "-ac", "1", "-c:a", "pcm_s16le", out,
  ]);
  return out;
}

test("rmsEnvelope finds a silent gap", async () => {
  const env = await rmsEnvelope(await gapWav(), 10);
  assert.ok(env.length >= 249 && env.length <= 251, `length ${env.length}`);
  for (let i = 100; i < 150; i++) assert.ok((env[i] as number) < -60, `window ${i} = ${env[i]}`);
  assert.ok((env[50] as number) > -30);
  assert.ok((env[200] as number) > -30);
});

test("rmsEnvelope averages stereo channels", async () => {
  const out = join(tmp, "stereo.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.5:sample_rate=16000", "-ac", "2", "-c:a", "pcm_s16le", out]);
  const env = await rmsEnvelope(out, 10);
  assert.ok(env.length >= 49 && env.length <= 51);
  assert.ok((env[10] as number) > -30);
});

test("rmsEnvelope rejects non-16-bit PCM", async () => {
  const out = join(tmp, "f32.wav");
  ff(["-f", "lavfi", "-i", "sine=duration=0.2:sample_rate=16000", "-c:a", "pcm_f32le", out]);
  await assert.rejects(rmsEnvelope(out), /16-bit PCM/);
});

test("rmsEnvelope rejects a non-WAV file", async () => {
  const p = join(tmp, "x.wav");
  await writeFile(p, "not a wav file at all, definitely");
  await assert.rejects(rmsEnvelope(p), /WAV/);
});

test("quietestPoint picks the silent window", async () => {
  const env = await rmsEnvelope(await gapWav(), 10);
  const t = quietestPoint(env, 10, 0.5, 2);
  assert.ok(t >= 1.0 && t <= 1.5, `t = ${t}`);
});

test("quietestPoint clamps to bounds and ties go earliest", () => {
  const env = new Float32Array([-10, -96, -96, -50]);
  assert.equal(quietestPoint(env, 10, -5, 99), 0.015);
  assert.equal(quietestPoint(env, 10, 0.02, 99), 0.025);
});
