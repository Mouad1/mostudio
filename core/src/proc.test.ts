import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBin, runBin } from "./proc.ts";

test("resolveBin defaults to the binary name", () => {
  assert.equal(resolveBin("ffmpeg", {}), "ffmpeg");
  assert.equal(resolveBin("ffprobe", {}), "ffprobe");
  assert.equal(resolveBin("whisper-cli", {}), "whisper-cli");
});

test("resolveBin honours FFMPEG/FFPROBE/WHISPER_CLI; empty means unset", () => {
  const env = { FFMPEG: "/opt/ffmpeg", FFPROBE: "", WHISPER_CLI: "/w/whisper-cli" };
  assert.equal(resolveBin("ffmpeg", env), "/opt/ffmpeg");
  assert.equal(resolveBin("ffprobe", env), "ffprobe");
  assert.equal(resolveBin("whisper-cli", env), "/w/whisper-cli");
});

test("runBin passes arguments without a shell", async () => {
  const arg = "a; echo injected $(whoami)";
  const out = await runBin(process.execPath, ["-e", "process.stdout.write(process.argv[1])", arg]);
  assert.equal(out, arg);
});

test("runBin names a missing binary", async () => {
  await assert.rejects(runBin("no-such-bin-xyz", []), /no-such-bin-xyz not found/);
});

test("runBin reports a non-zero exit with stderr tail", async () => {
  await assert.rejects(
    runBin(process.execPath, ["-e", "process.stderr.write('bad thing'); process.exit(3)"]),
    /failed: bad thing/,
  );
});
