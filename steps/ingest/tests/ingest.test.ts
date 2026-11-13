import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { Config, ProviderRegistry } from "../../../core/src/index.ts";
import { resolveBin, runBin, runStep } from "../../../core/src/index.ts";
import { ingest } from "../src/ingest.ts";
import { probe, snapFps } from "../src/probe.ts";
import { makeClip } from "./fixtures.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", inspirationRoot: "/x", home: "/x" };
const base = { config, providers: {} as ProviderRegistry, log: () => {} };

let tmp: string;
let dir: string;
let n = 0;
let clip: string;
let silent: string;
let rotated: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-ingest-"));
  const src = join(tmp, "src");
  await mkdir(src);
  clip = await makeClip(src, { seconds: 3, width: 1920, height: 1080, audio: true, name: "clip.mp4" });
  silent = await makeClip(src, { seconds: 1, width: 320, height: 180, audio: false, name: "silent.mp4" });
  rotated = await makeClip(src, { seconds: 1, width: 320, height: 180, audio: true, rotation: 90, name: "phone.mp4" });
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = join(tmp, `proj ${n++}`);
  await mkdir(dir, { recursive: true });
});

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

test("probes a 3 s 1920x1080 clip with audio", async () => {
  const r = await runStep(dir, ingest, { params: { source: clip }, ...base });
  assert.equal(r.status, "pass");
  assert.equal(r.metrics.width, 1920);
  assert.equal(r.metrics.height, 1080);
  assert.equal(r.metrics.fps, 30);
  assert.ok(Math.abs((r.metrics.durationSec as number) - 3) < 0.1);
  assert.equal(r.metrics.hasAudio, true);
  assert.deepEqual(r.artifacts, ["media/clip.mp4", "media/ingest.json"]);
  const j = JSON.parse(readFileSync(join(dir, "media", "ingest.json"), "utf8"));
  assert.equal(j.file, "media/clip.mp4");
  assert.equal(j.sha256, r.metrics.sha256);
  assert.equal(j.videoCodec, "h264");
});

test("clip without audio fails the gate", async () => {
  const r = await runStep(dir, ingest, { params: { source: silent }, ...base });
  assert.equal(r.status, "fail");
  assert.equal(r.metrics.hasAudio, false);
});

test("rotated phone clip reports displayed size", async () => {
  const r = await runStep(dir, ingest, { params: { source: rotated }, ...base });
  assert.equal(r.metrics.rotation, 90);
  assert.equal(r.metrics.width, 180);
  assert.equal(r.metrics.height, 320);
});

test("source path with spaces and accents works", async () => {
  const src = join(tmp, "Mes vidéos");
  await mkdir(src, { recursive: true });
  const f = await makeClip(src, { seconds: 1, width: 160, height: 90, audio: true, name: "Vidéo finale.mov" });
  const r = await runStep(dir, ingest, { params: { source: f }, ...base });
  assert.equal(r.status, "pass");
  assert.ok(existsSync(join(dir, "media", "Vidéo finale.mov")));
});

test("re-run with same source is cached", async () => {
  await runStep(dir, ingest, { params: { source: rotated }, ...base });
  const again = await runStep(dir, ingest, { params: { source: rotated }, ...base });
  assert.equal(again.cached, true);
});

test("source file is copied, original untouched", async () => {
  const before = { sha: sha(clip), mtime: statSync(clip).mtimeMs };
  await runStep(dir, ingest, { params: { source: clip }, ...base });
  assert.equal(sha(clip), before.sha);
  assert.equal(statSync(clip).mtimeMs, before.mtime);
  assert.equal(sha(join(dir, "media", "clip.mp4")), before.sha);
});

test("probe parses fractional fps and audio-only files", async () => {
  const f = join(tmp, "src", "a.m4a");
  await runBin(resolveBin("ffmpeg", process.env), ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", f]);
  const p = await probe(f, process.env);
  assert.equal(p.hasAudio, true);
  assert.equal(p.width, 0);
  assert.equal(p.fps, 0);
  assert.equal(p.rotation, 0);
});

test("missing binary gives a clear error", async () => {
  await assert.rejects(probe(clip, { FFPROBE: "no-such-ffprobe" }), /no-such-ffprobe not found/);
});

test("ingest resolves ffprobe from ctx.env", async () => {
  const r = await runStep(dir, ingest, { params: { source: clip }, ...base, env: { FFPROBE: "no-such-ffprobe" } });
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /no-such-ffprobe not found/);
});

test("unparseable ffprobe output names the binary", async () => {
  await assert.rejects(probe(clip, { FFPROBE: "/bin/echo" }), /\/bin\/echo returned invalid JSON/);
});

test("HLG-tagged clip records colorTransfer and hdr", async () => {
  const f = await makeClip(join(tmp, "src"), { seconds: 1, width: 320, height: 180, audio: true, hlg: true, name: "hlg.mp4" });
  const r = await runStep(dir, ingest, { params: { source: f }, ...base });
  assert.equal(r.status, "pass");
  assert.equal(r.metrics.hdr, true);
  const j = JSON.parse(readFileSync(join(dir, "media", "ingest.json"), "utf8"));
  assert.equal(j.colorTransfer, "arib-std-b67");
  assert.equal(j.hdr, true);
});

test("SDR clip is not hdr", async () => {
  const r = await runStep(dir, ingest, { params: { source: clip }, ...base });
  assert.equal(r.metrics.hdr, false);
});

test("snapFps snaps to a standard rate within 0.5%, else keeps the raw rate", () => {
  assert.equal(snapFps(29.97002997), 29.97);
  assert.equal(snapFps(29.94), 29.97);
  assert.equal(snapFps(23.98), 23.976);
  assert.equal(snapFps(59.8), 59.94);
  assert.equal(snapFps(25.1), 25);
  assert.equal(snapFps(27.5), 27.5);
  assert.equal(snapFps(0), 0);
});

test("ingest records fps snapped and fpsRaw", async () => {
  const f = join(tmp, "src", "ntsc.mp4");
  await runBin(resolveBin("ffmpeg", process.env), [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30000/1001:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f,
  ]);
  const r = await runStep(dir, ingest, { params: { source: f }, ...base });
  assert.equal(r.metrics.fps, 29.97);
  const j = JSON.parse(readFileSync(join(dir, "media", "ingest.json"), "utf8"));
  assert.equal(j.fps, 29.97);
  assert.ok(Math.abs(j.fpsRaw - 29.97) < 0.01, String(j.fpsRaw));
});
