import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getSecret } from "../config.ts";
import { NonRetryableError, ProviderHttpError } from "./call.ts";
import { withProvider } from "./call.ts";
import { chatComplete, transcribeAudio } from "./openai-compat.ts";
import type { FetchLike } from "./openai-compat.ts";
import type { PickedProvider } from "./registry.ts";

function provider(over: Partial<PickedProvider> = {}): PickedProvider {
  const key = getSecret("K", { K: "sk-secret-123" });
  assert.ok(key);
  return {
    id: "groq",
    capabilities: ["llm", "stt"],
    kind: "openai-compat",
    baseUrl: "https://api.example.com/v1",
    model: "m-1",
    keyEnv: "K",
    limits: {},
    reset: { tz: "UTC" },
    flags: { commercial_ok: true, trains_on_data: false, renewable: true },
    priority: {},
    key,
    envValues: {},
    ...over,
  };
}

function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { impl, seen };
}

test("chatComplete sends bearer key and json mode", async () => {
  const f = fakeFetch(200, { choices: [{ message: { content: "{\"a\":1}" } }] });
  const out = await chatComplete(provider(), [{ role: "user", content: "hi" }], { json: true, fetchImpl: f.impl });
  assert.equal(out, "{\"a\":1}");
  assert.equal(f.seen[0]?.url, "https://api.example.com/v1/chat/completions");
  const headers = new Headers(f.seen[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-secret-123");
  const body = JSON.parse(String(f.seen[0]?.init.body));
  assert.equal(body.model, "m-1");
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("chatComplete omits response_format without json", async () => {
  const f = fakeFetch(200, { choices: [{ message: { content: "x" } }] });
  await chatComplete(provider(), [{ role: "user", content: "hi" }], { fetchImpl: f.impl });
  assert.equal("response_format" in JSON.parse(String(f.seen[0]?.init.body)), false);
});

test("chatComplete requires key and baseUrl", async () => {
  const f = fakeFetch(200, {});
  await assert.rejects(chatComplete(provider({ key: undefined as never }), [], { fetchImpl: f.impl }), /key/);
  await assert.rejects(chatComplete(provider({ baseUrl: undefined as never }), [], { fetchImpl: f.impl }), /baseUrl/);
  assert.equal(f.seen.length, 0);
});

test("ProviderHttpError message has no key", async () => {
  const f = fakeFetch(401, "bad key sk-secret-123 rejected");
  await assert.rejects(chatComplete(provider(), [{ role: "user", content: "hi" }], { fetchImpl: f.impl }), (e: unknown) => {
    assert.ok(e instanceof ProviderHttpError);
    assert.equal(e.status, 401);
    assert.equal(e.providerId, "groq");
    assert.ok(!e.message.includes("sk-secret-123"));
    assert.match(e.message, /groq HTTP 401: bad key \[redacted\] rejected/);
    return true;
  });
});

test("transcribeAudio maps verbose_json words and confidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mostudio-oai-"));
  try {
    const wav = join(dir, "a.wav");
    await writeFile(wav, Buffer.from([1, 2, 3, 4]));
    const f = fakeFetch(200, {
      language: "english",
      words: [
        { word: " hello", start: 0.1234, end: 0.5 },
        { word: "world", start: 0.6, end: 0.9 },
        { word: "late", start: 5, end: 5.2 },
      ],
      segments: [{ start: 0, end: 1, text: " hello world", avg_logprob: -0.2 }],
    });
    const out = await transcribeAudio(provider(), wav, { language: "en", fetchImpl: f.impl });
    assert.equal(out.language, "english");
    assert.equal(out.words.length, 3);
    assert.equal(out.words[0]?.w, "hello");
    assert.equal(out.words[0]?.start, 0.123);
    assert.ok(Math.abs((out.words[0]?.conf ?? 0) - Math.exp(-0.2)) < 0.001);
    assert.equal(out.words[2]?.conf, undefined);
    assert.deepEqual(out.segments, [{ start: 0, end: 1, text: " hello world", avgLogprob: -0.2 }]);
    assert.equal(f.seen[0]?.url, "https://api.example.com/v1/audio/transcriptions");
    const form = f.seen[0]?.init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("model"), "m-1");
    assert.equal(form.get("response_format"), "verbose_json");
    assert.deepEqual(form.getAll("timestamp_granularities[]"), ["word", "segment"]);
    assert.equal(form.get("language"), "en");
    const file = form.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.size, 4);
    assert.equal(new Headers(f.seen[0]?.init.headers).get("authorization"), "Bearer sk-secret-123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcribeAudio falls back to opts.language / unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mostudio-oai-"));
  try {
    const wav = join(dir, "a.wav");
    await writeFile(wav, "x");
    const f = fakeFetch(200, { words: [], segments: [] });
    assert.equal((await transcribeAudio(provider(), wav, { fetchImpl: f.impl })).language, "unknown");
    assert.equal((await transcribeAudio(provider(), wav, { language: "fr", fetchImpl: f.impl })).language, "fr");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("key straddling the 200-char cut is fully redacted", async () => {
  const body = "x".repeat(195) + "sk-secret-123" + "y".repeat(50);
  const f = fakeFetch(401, body);
  await assert.rejects(chatComplete(provider(), [{ role: "user", content: "hi" }], { fetchImpl: f.impl }), (e: unknown) => {
    assert.ok(e instanceof ProviderHttpError);
    assert.ok(!e.message.includes("sk-secret"));
    assert.ok(!e.message.includes("sk-secre"));
    return true;
  });
});

test("empty key and missing baseUrl are ordinary (retryable) errors", async () => {
  const f = fakeFetch(200, {});
  const empty = { reveal: () => "", name: "K" } as unknown as PickedProvider["key"];
  await assert.rejects(chatComplete(provider({ key: empty }), [], { fetchImpl: f.impl }), (e: unknown) => e instanceof Error && !(e instanceof NonRetryableError) && /key/.test(e.message));
  await assert.rejects(
    chatComplete(provider({ baseUrl: undefined as never }), [], { fetchImpl: f.impl }),
    (e: unknown) => e instanceof Error && !(e instanceof NonRetryableError) && /baseUrl/.test(e.message),
  );
  assert.equal(f.seen.length, 0);
});

test("transcribeAudio missing file is NonRetryableError without HTTP", async () => {
  const f = fakeFetch(200, {});
  await assert.rejects(
    transcribeAudio(provider(), "/nonexistent/zzz.wav", { fetchImpl: f.impl }),
    (e: unknown) => e instanceof NonRetryableError && /cannot read audio file/.test(e.message),
  );
  assert.equal(f.seen.length, 0);
});

test("withProvider rotates past a provider with config error", async () => {
  const providers = [provider({ id: "a", baseUrl: undefined as never }), provider({ id: "b" })];
  const used: string[] = [];
  const exhausted: string[] = [];
  const registry = {
    async pick(_c: string, o?: { exclude?: string[] }) {
      const p = providers.find((x) => !o?.exclude?.includes(x.id));
      if (!p) throw new Error("none");
      return p;
    },
    async recordUse(id: string) {
      used.push(id);
    },
    async markExhausted(id: string) {
      exhausted.push(id);
    },
  };
  const f = fakeFetch(200, { choices: [{ message: { content: "hi" } }] });
  const out = await withProvider(registry, "llm", (p) => chatComplete(p, [{ role: "user", content: "x" }], { fetchImpl: f.impl }));
  assert.equal(out.result, "hi");
  assert.equal(out.provider.id, "b");
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0]?.id, "a");
  assert.match(out.attempts[0]?.error ?? "", /baseUrl/);
  assert.deepEqual(used, ["b"]);
  assert.deepEqual(exhausted, []);
});

test("429 carries retryAfterSec from the response headers", async () => {
  const impl: FetchLike = async () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } });
  await assert.rejects(chatComplete(provider(), [{ role: "user", content: "hi" }], { fetchImpl: impl }), (e: unknown) => {
    assert.ok(e instanceof ProviderHttpError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSec, 12);
    return true;
  });
});
