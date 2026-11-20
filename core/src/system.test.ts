import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSystem, versionAtLeast } from "./system.ts";

test("versionAtLeast", () => {
  assert.equal(versionAtLeast("v22.18.0", "22.18"), true);
  assert.equal(versionAtLeast("v22.9.1", "22.18"), false);
  assert.equal(versionAtLeast("v24.0.0", "22.18"), true);
  assert.equal(versionAtLeast("22.18", "22.18"), true);
  assert.equal(versionAtLeast("v22.18.1", "22.18"), true);
  assert.equal(versionAtLeast("v22.17.9", "22.18"), false);
});

test("ffmpeg without libass fails captions-burn with the source fix", async () => {
  const checks = await checkSystem(
    {},
    {
      nodeVersion: "v22.23.3",
      packaged: false,
      listDir: () => [],
      run: async (_b, args) =>
        args.includes("-filters") ? " scale V->V" : "ffmpeg version 7.1",
    },
  );
  const c = checks.find((x) => x.name === "captions-burn")!;
  assert.deepEqual([c.ok, c.required, c.fix], [false, true, "brew install ffmpeg-full"]);
  assert.equal(c.detail, "captions burn needs libass; HyperFrames captions still work");
  assert.deepEqual(
    checks.map((x) => x.name),
    ["node", "ffmpeg", "ffprobe", "captions-burn", "whisper", "animated-captions"],
  );
});

test("packaged fix text never mentions brew", async () => {
  const checks = await checkSystem(
    { MOSTUDIO_PACKAGED: "1" },
    {
      nodeVersion: "v20.0.0",
      run: async () => {
        throw new Error("binary not found");
      },
      listDir: () => [],
    },
  );

  for (const c of checks) {
    if (c.fix) {
      assert.ok(!c.fix.includes("brew"), `fix for ${c.name} mentions brew: ${c.fix}`);
    }
  }

  assert.equal(
    checks.find((x) => x.name === "node")?.fix,
    "Reinstall mostudio: download the latest zip and replace the folder.",
  );
  assert.equal(
    checks.find((x) => x.name === "ffmpeg")?.fix,
    "Reinstall mostudio: download the latest zip and replace the folder.",
  );
  assert.equal(
    checks.find((x) => x.name === "ffprobe")?.fix,
    "Reinstall mostudio: download the latest zip and replace the folder.",
  );
  assert.equal(
    checks.find((x) => x.name === "captions-burn")?.fix,
    "Reinstall mostudio: download the latest zip and replace the folder.",
  );
  assert.equal(
    checks.find((x) => x.name === "whisper")?.fix,
    "Optional. Cloud transcription works without it.",
  );
});

test("FFMPEG env override is probed; whisper optional", async () => {
  const called: string[] = [];
  const checks = await checkSystem(
    { FFMPEG: "/opt/ff" },
    {
      nodeVersion: "v22.18.0",
      run: async (bin) => {
        called.push(bin);
        return "ffmpeg version 7.1 ass ";
      },
      listDir: () => [],
    },
  );

  assert.ok(called.includes("/opt/ff"));
  const whisper = checks.find((x) => x.name === "whisper")!;
  assert.equal(whisper.required, false);
});

test("all checks pass on a fully equipped environment", async () => {
  const checks = await checkSystem(
    { WHISPER_MODELS_DIR: "/models" },
    {
      nodeVersion: "v22.18.0",
      packaged: false,
      listDir: (p) => (p === "/models" ? ["ggml-base.bin", "other.txt"] : []),
      run: async (_bin, args) => {
        if (args.includes("-filters")) return " .. ass .. ";
        if (args.includes("-version")) return "version 7.1.0\nextra info";
        if (args.includes("--help")) return "usage: whisper-cli ...";
        if (args.includes("--version")) return "10.8.2";
        return "";
      },
    },
  );

  assert.equal(checks.length, 6);
  for (const c of checks) {
    assert.equal(c.ok, true, `check ${c.name} expected ok: true`);
    assert.equal(c.fix, undefined, `check ${c.name} expected fix: undefined`);
  }

  assert.equal(checks.find((x) => x.name === "captions-burn")?.detail, "libass filter available");
  assert.equal(
    checks.find((x) => x.name === "animated-captions")?.detail,
    "downloads its renderer the first time; needs internet",
  );
});

test("whisper check details when missing models dir or models", async () => {
  const noDirChecks = await checkSystem(
    {},
    {
      run: async () => "whisper-cli help",
    },
  );
  const whisper1 = noDirChecks.find((x) => x.name === "whisper")!;
  assert.equal(whisper1.ok, false);
  assert.equal(whisper1.detail, "WHISPER_MODELS_DIR not set");
  assert.equal(whisper1.fix, "Optional. Cloud transcription works without it.");

  const emptyDirChecks = await checkSystem(
    { WHISPER_MODELS_DIR: "/empty" },
    {
      run: async () => "whisper-cli help",
      listDir: () => ["not-a-model.txt"],
    },
  );
  const whisper2 = emptyDirChecks.find((x) => x.name === "whisper")!;
  assert.equal(whisper2.ok, false);
  assert.ok(whisper2.detail.includes("no ggml-*.bin models"));
});

test("source fix messages when unpackaged tools are missing", async () => {
  const checks = await checkSystem(
    {},
    {
      nodeVersion: "v20.0.0",
      packaged: false,
      run: async () => {
        throw new Error("ENOENT");
      },
      listDir: () => [],
    },
  );

  assert.equal(checks.find((x) => x.name === "node")?.fix, "install Node 22.18 or newer from nodejs.org");
  assert.equal(checks.find((x) => x.name === "ffmpeg")?.fix, "brew install ffmpeg");
  assert.equal(checks.find((x) => x.name === "ffprobe")?.fix, "brew install ffmpeg");
  assert.equal(checks.find((x) => x.name === "captions-burn")?.fix, "brew install ffmpeg-full");
});
