import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnvFile, loadProvidersFile, PACKAGE_ROOT } from "../../core/src/index.ts";
import { readSettings, settingsSchema, writeSettings } from "./settings.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mostudio-settings-test-"));
}

test("schema: stt/llm keys plus whisper models dir; no binary paths, no stock keys", async () => {
  const realEntries = await loadProvidersFile(PACKAGE_ROOT);
  const schema = settingsSchema(realEntries);
  const names = schema.map((f) => f.name);

  for (const n of [
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "WHISPER_MODELS_DIR",
  ]) {
    assert.ok(names.includes(n), "expected " + n + " in schema");
  }

  for (const n of ["FFMPEG", "FFPROBE", "WHISPER_CLI", "PEXELS_API_KEY", "PIXABAY_API_KEY"]) {
    assert.ok(!names.includes(n), "expected " + n + " NOT in schema");
  }

  // Schema should be sorted by name
  const sortedNames = [...names].sort();
  assert.deepEqual(names, sortedNames);

  // Check specific metadata
  const groq = schema.find((f) => f.name === "GROQ_API_KEY")!;
  assert.equal(groq.label, "Groq key");
  assert.equal(groq.getKeyUrl, "https://console.groq.com/keys");
  assert.equal(groq.recommended, true);
  assert.equal(groq.help, "Free. Used for transcription and AI steps.");
  assert.deepEqual(groq.providers, ["groq"]);
  assert.equal(groq.kind, "secret");

  const gemini = schema.find((f) => f.name === "GEMINI_API_KEY")!;
  assert.equal(gemini.label, "Google Gemini key");
  assert.equal(gemini.getKeyUrl, "https://aistudio.google.com/apikey");
  assert.equal(gemini.recommended, true);
  assert.equal(gemini.help, "Free. Used for AI steps.");
  assert.deepEqual(gemini.providers, ["gemini"]);

  const cfToken = schema.find((f) => f.name === "CLOUDFLARE_API_TOKEN")!;
  assert.equal(cfToken.label, "Cloudflare key");
  assert.equal(cfToken.help, "Optional backup provider.");

  const cfAccount = schema.find((f) => f.name === "CLOUDFLARE_ACCOUNT_ID")!;
  assert.equal(cfAccount.label, "Cloudflare account ID");
  assert.equal(cfAccount.help, "Required for Cloudflare AI.");
  assert.equal(cfAccount.kind, "text");
  assert.deepEqual(cfAccount.providers, ["cloudflare"]);

  const whisper = schema.find((f) => f.name === "WHISPER_MODELS_DIR")!;
  assert.equal(whisper.label, "Whisper models directory");
  assert.equal(whisper.help, "Directory containing ggml-*.bin models for local Whisper.");
  assert.equal(whisper.kind, "path");
  assert.deepEqual(whisper.providers, ["whisper-cpp"]);
});

test("read masks and reports the layer", async () => {
  const realEntries = await loadProvidersFile(PACKAGE_ROOT);
  const home = tmpDir();
  const ws = tmpDir();
  try {
    writeFileSync(join(home, ".env"), "GROQ_API_KEY=gsk_abcdefgh1234\n");
    writeFileSync(join(ws, ".env.local"), "MISTRAL_API_KEY=mistral12345678\n");

    const pick = (list: ReturnType<typeof readSettings>, name: string) => {
      const x = list.find((f) => f.name === name);
      return x ? { source: x.source, masked: x.masked } : undefined;
    };

    const f = readSettings({
      home,
      root: ws,
      processEnv: { GEMINI_API_KEY: "AIzaXXXXXXXX9999" },
      entries: realEntries,
    });

    assert.deepEqual(pick(f, "GROQ_API_KEY"), { source: "app", masked: "gsk…1234" });
    assert.deepEqual(pick(f, "MISTRAL_API_KEY"), { source: "workspace", masked: "mis…5678" });
    assert.deepEqual(pick(f, "GEMINI_API_KEY"), { source: "process", masked: "AIz…9999" });

    // Unset fields have source unset and masked ""
    assert.deepEqual(pick(f, "OPENROUTER_API_KEY"), { source: "unset", masked: "" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("write goes to ~/.mostudio/.env and refuses unknown names", async () => {
  const realEntries = await loadProvidersFile(PACKAGE_ROOT);
  const home = tmpDir();
  try {
    await writeSettings(home, { GROQ_API_KEY: "gsk_x_123456" }, realEntries);
    assert.equal(loadEnvFile(join(home, ".env")).GROQ_API_KEY, "gsk_x_123456");

    await assert.rejects(
      writeSettings(home, { NODE_OPTIONS: "--inspect" }, realEntries),
      /unknown setting: NODE_OPTIONS/,
    );
    await assert.rejects(
      writeSettings(home, { WHISPER_CLI: "/bin/sh" }, realEntries),
      /unknown setting: WHISPER_CLI/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
