import assert from "node:assert/strict";
import { test } from "node:test";
import { CancelledError, currentSignal, resolveBin, runBin, runBinCapture, runWithSignal } from "./proc.ts";

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

// --- resolveFfmpeg / pickH264Encoder (fake ffmpeg scripts) ---
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { _resetFfmpegCache, pickH264Encoder, resolveFfmpeg } from "./proc.ts";

let fakeDir: string;
before(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "mostudio-fakeff-"));
});
after(async () => {
  await rm(fakeDir, { recursive: true, force: true });
});

async function fake(name: string, filters: string[], encoders: string[] = []): Promise<string> {
  const p = join(fakeDir, name);
  const fl = filters.map((f) => ` T.. ${f.padEnd(16)} A->A       desc`).join("\n");
  const en = encoders.map((e) => ` V....D ${e.padEnd(18)} encoder`).join("\n");
  await writeFile(
    p,
    `#!/bin/sh\ncase "$*" in\n*-filters*) cat <<'EOT'\nFilters:\n  T.. = Timeline support\n ---\n${fl}\nEOT\n;;\n*-encoders*) cat <<'EOT'\nEncoders:\n ------\n${en}\nEOT\n;;\nesac\n`,
  );
  await chmod(p, 0o755);
  return p;
}

test("resolveFfmpeg skips a build missing a needed filter", async () => {
  _resetFfmpegCache();
  const a = await fake("ff-a", ["scale", "overlay"]);
  const b = await fake("ff-b", ["scale", "overlay", "ass"]);
  assert.equal(await resolveFfmpeg({ FFMPEG: a }, ["ass", "scale"], [b]), b);
});

test("resolveFfmpeg prefers env FFMPEG when it satisfies needs", async () => {
  _resetFfmpegCache();
  const a = await fake("ff-c", ["ass"]);
  const b = await fake("ff-d", ["ass"]);
  assert.equal(await resolveFfmpeg({ FFMPEG: a }, ["ass"], [b]), a);
  assert.equal(await resolveFfmpeg({ FFMPEG: "" }, ["ass"], [b]), b);
});

test("resolveFfmpeg error names what each candidate lacks", async () => {
  _resetFfmpegCache();
  const a = await fake("ff-e", ["scale"]);
  const missing = join(fakeDir, "does-not-exist");
  await assert.rejects(resolveFfmpeg({ FFMPEG: a }, ["ass", "drawtext"], [missing]), (e: Error) => {
    assert.ok(e.message.includes(a) && e.message.includes("ass") && e.message.includes("drawtext"));
    assert.ok(e.message.includes(missing) && e.message.includes("not found"));
    return true;
  });
});

test("pickH264Encoder prefers videotoolbox, falls back to libx264, env forces software", async () => {
  const hw = await fake("ff-hw", [], ["libx264", "h264_videotoolbox"]);
  const sw = await fake("ff-sw", [], ["libx264"]);
  assert.equal(await pickH264Encoder(hw, {}), "h264_videotoolbox");
  assert.equal(await pickH264Encoder(sw, {}), "libx264");
  assert.equal(await pickH264Encoder(hw, { MOSTUDIO_ENCODER: "libx264" }), "libx264");
});

test("runBinCapture returns stdout and stderr", async () => {
  const r = await runBinCapture(process.execPath, ["-e", "process.stdout.write('o');process.stderr.write('e')"]);
  assert.deepEqual(r, { stdout: "o", stderr: "e" });
});

test("currentSignal returns active signal within runWithSignal", async () => {
  assert.equal(currentSignal(), undefined);
  const ac = new AbortController();
  await runWithSignal(ac.signal, async () => {
    assert.equal(currentSignal(), ac.signal);
  });
  assert.equal(currentSignal(), undefined);
});

test("already-aborted signal rejects immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    runWithSignal(ac.signal, () => runBin("sleep", ["30"])),
    (err: unknown) => err instanceof CancelledError,
  );
});

test("aborting kills the child quickly", async () => {
  const ac = new AbortController();
  const start = Date.now();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    runWithSignal(ac.signal, () => runBin("sleep", ["30"])),
    (err: unknown) => err instanceof CancelledError,
  );
  const duration = Date.now() - start;
  assert.ok(duration < 2000, `expected duration < 2000ms, got ${duration}ms`);
});
