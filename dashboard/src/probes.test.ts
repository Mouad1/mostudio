import assert from "node:assert/strict";
import test from "node:test";
import { loadProvidersFile, PACKAGE_ROOT, type ProviderEntry } from "../../core/src/index.ts";
import { probeProvider } from "./probes.ts";

test("probe 401 → friendly refusal, key never echoed", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const groq = entries.find((e) => e.id === "groq")!;

  let calledUrl = "";
  let calledHeaders: HeadersInit | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    calledUrl = String(url);
    calledHeaders = init?.headers;
    return new Response("Unauthorized", { status: 401 });
  };

  const r = await probeProvider(groq, { GROQ_API_KEY: "gsk_secret_999999" }, { fetch: mockFetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.message, /refused/);
  assert.match(r.message, /api\.groq\.com/);
  assert.doesNotMatch(r.message, /gsk_secret/);
  assert.equal(calledUrl, "https://api.groq.com/openai/v1/models");
  assert.equal(new Headers(calledHeaders).get("authorization"), "Bearer gsk_secret_999999");
});

test("probe 403 → friendly refusal", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const mistral = entries.find((e) => e.id === "mistral")!;

  const mockFetch: typeof fetch = async () => new Response("Forbidden", { status: 403 });
  const r = await probeProvider(mistral, { MISTRAL_API_KEY: "mis_secret_12345" }, { fetch: mockFetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.message, /refused/);
  assert.match(r.message, /api\.mistral\.ai/);
  assert.doesNotMatch(r.message, /mis_secret/);
});

test("probe without key makes no request", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const groq = entries.find((e) => e.id === "groq")!;

  let called = false;
  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response("ok");
  };

  const r = await probeProvider(groq, {}, { fetch: mockFetch });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.equal(r.ms, 0);
  assert.equal(r.message, "Add your Groq key first");
});

test("probe cloudflare requires account ID", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const cf = entries.find((e) => e.id === "cloudflare")!;

  let called = false;
  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response("ok");
  };

  // Missing token
  const r1 = await probeProvider(cf, {}, { fetch: mockFetch });
  assert.equal(called, false);
  assert.equal(r1.ok, false);
  assert.equal(r1.message, "Add your Cloudflare key first");

  // Missing account ID
  const r2 = await probeProvider(cf, { CLOUDFLARE_API_TOKEN: "cftoken123" }, { fetch: mockFetch });
  assert.equal(called, false);
  assert.equal(r2.ok, false);
  assert.equal(r2.message, "Add your Cloudflare account ID first");

  // With both
  let calledUrl = "";
  const r3 = await probeProvider(
    cf,
    { CLOUDFLARE_API_TOKEN: "cftoken123", CLOUDFLARE_ACCOUNT_ID: "cfacc456" },
    {
      fetch: async (url) => {
        calledUrl = String(url);
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(r3.ok, true);
  assert.match(r3.message, /Connected/);
  assert.equal(calledUrl, "https://api.cloudflare.com/client/v4/accounts/cfacc456/ai/models/search?per_page=1");
});

test("gemini key goes in header, not URL", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const gemini = entries.find((e) => e.id === "gemini")!;

  let calledUrl = "";
  let calledHeaders: HeadersInit | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    calledUrl = String(url);
    calledHeaders = init?.headers;
    return new Response("{}", { status: 200 });
  };

  const r = await probeProvider(gemini, { GEMINI_API_KEY: "AIzaTestSecretKey" }, { fetch: mockFetch });
  assert.equal(r.ok, true);
  assert.doesNotMatch(calledUrl, /AIza/);
  assert.equal(calledUrl, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
  assert.equal(new Headers(calledHeaders).get("x-goog-api-key"), "AIzaTestSecretKey");
});

test("openrouter calls /api/v1/key", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const openrouter = entries.find((e) => e.id === "openrouter")!;

  let calledUrl = "";
  const mockFetch: typeof fetch = async (url) => {
    calledUrl = String(url);
    return new Response("{}", { status: 200 });
  };

  const r = await probeProvider(openrouter, { OPENROUTER_API_KEY: "sk-or-v1-test" }, { fetch: mockFetch });
  assert.equal(r.ok, true);
  assert.equal(calledUrl, "https://openrouter.ai/api/v1/key");
});

test("nvidia returns special reachable message on 200", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const nvidia = entries.find((e) => e.id === "nvidia")!;

  const mockFetch: typeof fetch = async () => new Response("{}", { status: 200 });
  const r = await probeProvider(nvidia, { NVIDIA_API_KEY: "nvapi-test" }, { fetch: mockFetch });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.message, "Reachable. This service can't confirm the key without using credits.");
});

test("whisper-cpp probe checks whisper-cli and models in WHISPER_MODELS_DIR", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const whisper = entries.find((e) => e.id === "whisper-cpp")!;

  // Missing models dir
  const r1 = await probeProvider(whisper, {}, { fetch: fetch });
  assert.equal(r1.ok, false);
  assert.equal(r1.message, "Add your Whisper models directory first");

  // Empty models dir
  const r2 = await probeProvider(
    whisper,
    { WHISPER_MODELS_DIR: "/fake/empty" },
    { fetch: fetch, listDir: () => ["other.txt"] },
  );
  assert.equal(r2.ok, false);
  assert.match(r2.message, /No ggml-\*.bin models found/);

  // Success with models
  let ranBin = "";
  let ranArgs: string[] = [];
  const r3 = await probeProvider(
    whisper,
    { WHISPER_MODELS_DIR: "/fake/models" },
    {
      fetch: fetch,
      listDir: () => ["ggml-base.bin", "ggml-large-v3.bin", "random.txt"],
      run: async (bin, args) => {
        ranBin = bin;
        ranArgs = args;
        return "usage: whisper-cli ...";
      },
    },
  );
  assert.equal(r3.ok, true);
  assert.equal(r3.message, "Ready (models: base, large-v3)");
  assert.equal(ranBin, "whisper-cli");
  assert.deepEqual(ranArgs, ["--help"]);
});

test("network error produces friendly message", async () => {
  const entries = await loadProvidersFile(PACKAGE_ROOT);
  const groq = entries.find((e) => e.id === "groq")!;

  const mockFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const r = await probeProvider(groq, { GROQ_API_KEY: "gsk_test" }, { fetch: mockFetch });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Can't reach api.groq.com. Check your internet connection.");
});
