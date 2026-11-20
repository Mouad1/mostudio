import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureLoudness, parseLoudnorm } from "./loudness.ts";

test("parseLoudnorm reads the JSON block at the end of stderr", () => {
  const err = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-20.12",\n\t"input_tp" : "-3.40",\n\t"input_lra" : "1.20",\n\t"input_thresh" : "-30.50",\n\t"output_i" : "-14.0",\n\t"output_tp" : "-1.0",\n\t"output_lra" : "0.0",\n\t"output_thresh" : "-24.0",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.02"\n}\n`;
  const s = parseLoudnorm(err);
  assert.equal(s.input_i, -20.12);
  assert.equal(s.input_tp, -3.4);
  assert.equal(s.target_offset, 0.02);
});

test("parseLoudnorm fails without a JSON block", () => {
  assert.throws(() => parseLoudnorm("nothing here"), /loudnorm/);
});

test("measureLoudness: a quiet sine with finite peak", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mostudio-loud-"));
  try {
    const f = join(dir, "t.wav");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3:sample_rate=48000", "-af", "volume=-2dB", f]);
    const r = await measureLoudness(f, process.env);
    assert.ok(r.integratedLufs < -20 && r.integratedLufs > -26, String(r.integratedLufs));
    assert.ok(r.truePeakDb < -18 && r.truePeakDb > -22, String(r.truePeakDb));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
