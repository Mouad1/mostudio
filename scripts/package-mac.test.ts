import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root from this file's location, so the tests run on any machine. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpdir } from "node:os";
import {
  appFiles,
  ffmpegCapsOk,
  readControlledFfmpeg,
  verifySha256,
  type RuntimeLock
} from "./package-mac.ts";

test("appFiles never ships secrets, footage or dev folders", async () => {
  const files = await appFiles(repoRoot);
  for (const f of files) {
    assert.doesNotMatch(
      f,
      /(^|\/)\.env|^projects\/|^inspiration\/|^\.claude\/|^\.agents\/|^\.superpowers\/|^spikes\/|^docs\/|^tasks\/|\.test\.ts$|\/tests\/|testkit\.ts$|fixture-typed\.ts$|mostudio\.config\.json$|^node_modules\//,
      f
    );
  }
  for (const must of [
    "cli/bin/mostudio.ts",
    "core/src/index.ts",
    "dashboard/web/index.html",
    "workflows/short.json",
    "providers.json"
  ]) {
    assert.ok(files.includes(must), `expected ${must} in appFiles`);
  }
});

test("ffmpegCapsOk", () => {
  assert.deepEqual(ffmpegCapsOk(" ass  V->V", " h264_videotoolbox x\n aac y"), { ok: true, missing: [] });
  assert.deepEqual(ffmpegCapsOk(" scale", " libx264"), { ok: false, missing: ["ass", "h264_videotoolbox", "aac"] });
  assert.deepEqual(ffmpegCapsOk(" ass", " aac"), { ok: false, missing: ["h264_videotoolbox"] });
});

test("verifySha256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sha-test-"));
  const f = join(dir, "abc.txt");
  writeFileSync(f, "abc", "utf8");
  // sha256 for "abc" is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  await verifySha256(f, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await assert.rejects(
    async () => verifySha256(f, "0000000000000000000000000000000000000000000000000000000000000000"),
    /checksum mismatch/
  );
  rmSync(dir, { recursive: true, force: true });
});

test("controlled runtime verifies binaries, notices, and corresponding source", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-ffmpeg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    "bin/ffmpeg": "ffmpeg fixture",
    "bin/ffprobe": "ffprobe fixture",
    "LICENSES/ffmpeg-COPYING.GPLv3": "license fixture",
    "ffmpeg-corresponding-source.tar.gz": "source fixture",
  };
  const manifest = Object.entries(files).map(([name, content]) => {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return `${createHash("sha256").update(content).digest("hex")}  ${name}`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), manifest.join("\n") + "\n");
  const staged = join(dir, "staged");
  assert.deepEqual(await readControlledFfmpeg(dir, staged), ["LICENSES/ffmpeg-COPYING.GPLv3"]);
  writeFileSync(join(dir, "ffmpeg-corresponding-source.tar.gz"), "changed after build");
  assert.equal(readFileSync(join(staged, "ffmpeg-corresponding-source.tar.gz"), "utf8"), "source fixture");
  await assert.rejects(readControlledFfmpeg(dir), /checksum mismatch/);
});

test("launcher is executable and uses the bundled runtime", () => {
  const p = join(repoRoot, "packaging", "Start mostudio.command");
  const text = readFileSync(p, "utf8");
  assert.ok(statSync(p).mode & 0o111, "launcher should be executable");
  assert.match(text, /MOSTUDIO_PACKAGED=1/);
  assert.match(text, /runtime\/node\/bin\/node/);
  assert.match(text, /ui --open/);
  assert.doesNotMatch(text, /com\.apple\.quarantine/);
});

test("lock file is complete", () => {
  const p = join(repoRoot, "packaging", "runtime.lock.json");
  const lock = JSON.parse(readFileSync(p, "utf8")) as RuntimeLock;
  const shaRegex = /^[0-9a-f]{64}$/;

  assert.match(lock.node.arm64.url, /^https:\/\//);
  assert.match(lock.node.arm64.sha256, shaRegex);
  assert.match(lock.node.x64.url, /^https:\/\//);
  assert.match(lock.node.x64.sha256, shaRegex);

  assert.match(lock.ffmpeg.sourceTarball.url, /^https:\/\//);
  assert.match(lock.ffmpeg.sourceTarball.sha256, shaRegex);

  assert.match(lock.ffmpeg.arm64.ffmpeg.url, /^https:\/\//);
  assert.match(lock.ffmpeg.arm64.ffmpeg.sha256, shaRegex);
  assert.match(lock.ffmpeg.arm64.ffprobe.url, /^https:\/\//);
  assert.match(lock.ffmpeg.arm64.ffprobe.sha256, shaRegex);

  assert.match(lock.ffmpeg.x64.ffmpeg.url, /^https:\/\//);
  assert.match(lock.ffmpeg.x64.ffmpeg.sha256, shaRegex);
  assert.match(lock.ffmpeg.x64.ffprobe.url, /^https:\/\//);
  assert.match(lock.ffmpeg.x64.ffprobe.sha256, shaRegex);
});

test("first-open guide contains required macOS Gatekeeper steps and safe punctuation", () => {
  const p = join(repoRoot, "packaging", "How to open mostudio.txt");
  const text = readFileSync(p, "utf8");
  assert.match(text, /Open Anyway/);
  assert.match(text, /Privacy & Security/);
  assert.match(text, /Movies\/mostudio/);
  assert.doesNotMatch(text, /--/);
});
