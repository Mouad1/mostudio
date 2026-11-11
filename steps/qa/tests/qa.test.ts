import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config, ProviderRegistry } from "../../../core/src/index.ts";
import { runStep } from "../../../core/src/index.ts";
import { qa } from "../src/qa.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const registry: ProviderRegistry = {
  async pick() {
    throw new Error("no providers in qa");
  },
  async recordUse() {},
  async markExhausted() {},
};
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-qa-"));
  await mkdir(join(dir, "renders"), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ff = (...args: string[]): void => {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
};
const COMMON = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join("x")];

/** 6 s render: video = `blackSec` black then testsrc2; audio = `silentSec` silence then a ~-14 LUFS 1 kHz tone. */
function makeRender(blackSec: number, silentSec: number): void {
  const out = join(dir, "renders", "final.mp4");
  const v = blackSec > 0
    ? `color=c=black:s=640x360:r=25:d=${blackSec}[b];testsrc2=s=640x360:r=25:d=${6 - blackSec}[t];[b][t]concat=n=2:v=1:a=0[v]`
    : "testsrc2=s=640x360:r=25:d=6[v]";
  const a = silentSec > 0
    ? `anullsrc=r=48000:cl=stereo:d=${silentSec}[s];sine=f=1000:r=48000:d=${6 - silentSec},volume=2.4,aformat=channel_layouts=stereo[t];[s][t]concat=n=2:v=0:a=1[a]`
    : "sine=f=1000:r=48000:d=6,volume=2.4,aformat=channel_layouts=stereo[a]";
  ff("-filter_complex", `${v};${a}`, "-map", "[v]", "-map", "[a]", ...COMMON.slice(0, -1), out);
}

const run = () => runStep(dir, qa, { params: {}, config, providers: registry, force: true });
const m = (r: Awaited<ReturnType<typeof run>>) => r.metrics as Record<string, number>;

test("detects a seeded black opening", async () => {
  makeRender(0.5, 0);
  const r = await run();
  assert.equal(r.status, "fail", JSON.stringify(r));
  assert.ok(m(r).blackStartSec >= 0.4 && m(r).blackStartSec <= 0.6, String(m(r).blackStartSec));
  assert.equal(m(r).silentStartSec, 0);
});

test("detects a seeded silent opening", async () => {
  makeRender(0, 0.8);
  const r = await run();
  assert.equal(r.status, "fail", JSON.stringify(r));
  assert.ok(m(r).silentStartSec >= 0.7 && m(r).silentStartSec <= 0.9, String(m(r).silentStartSec));
  assert.equal(m(r).blackStartSec, 0);
});

test("clean render passes and writes a 12-frame contact sheet", async () => {
  makeRender(0, 0);
  const r = await run();
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(m(r).blackStartSec, 0);
  assert.equal(m(r).silentStartSec, 0);
  assert.equal(m(r).contactSheetFrames, 12);
  assert.ok(Math.abs(m(r).integratedLufs + 14) <= 1, String(m(r).integratedLufs));
  assert.ok(Math.abs(m(r).durationSec - 6) < 0.2);
  const sheet = join(dir, "renders", "contact-sheet.jpg");
  assert.ok((await stat(sheet)).size > 1000);
  const w = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", sheet]).toString().trim();
  assert.equal(w, "1600");
  // all 12 tiles are filled: the bottom-right tile is not black padding
  const h = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", sheet]).toString().trim());
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", sheet, "-vf", `crop=400:${h / 3}:1200:${(h * 2) / 3},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  assert.ok((px[0] ?? 0) > 30, `last tile is black (${px[0]})`);
  const md = await readFile(join(dir, "renders", "qa.md"), "utf8");
  for (const h of ["Measured", "Rubric (fill in)", "Hook clear in 3 s", "Pacing", "Caption errors per minute", "Loudness", "Notes", "contact-sheet.jpg"]) {
    assert.ok(md.includes(h), `qa.md lacks ${h}`);
  }
});

test("video shorter than 2 s still runs", async () => {
  ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1.2", "-f", "lavfi", "-i", "sine=f=1000:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "renders", "final.mp4"));
  const r = await run();
  assert.equal(m(r).contactSheetFrames, 12);
  assert.equal(m(r).blackStartSec, 0);
});
