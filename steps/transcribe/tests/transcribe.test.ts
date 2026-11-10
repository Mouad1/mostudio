import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { Config, PickedProvider, PickOptions, ProviderRegistry } from "../../../core/src/index.ts";
import { NoProviderError, resolveBin, runBin, runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { buildSegments, parseWhisperCpp } from "../src/whisper-cpp.ts";
import { transcribeCloudflare } from "../src/cloudflare.ts";
import { planChunks } from "../src/chunk.ts";
import { createTranscribe } from "../src/transcribe.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const ffmpeg = resolveBin("ffmpeg", process.env);

function entry(id: string, kind: PickedProvider["kind"], extra: Partial<PickedProvider> = {}): PickedProvider {
  return {
    id,
    model: `${id}-model`,
    capabilities: ["stt"],
    kind,
    limits: {},
    reset: { tz: "UTC" },
    flags: { commercial_ok: true, trains_on_data: false, renewable: true },
    priority: {},
    envValues: {},
    baseUrl: "https://fake.test/v1",
    key: { name: "K", reveal: () => "secret-key" } as PickedProvider["key"],
    ...extra,
  } as PickedProvider;
}

function fakeRegistry(entries: PickedProvider[]) {
  const picks: (PickOptions | undefined)[] = [];
  const used: string[] = [];
  const registry: ProviderRegistry = {
    async pick(cap, opts) {
      picks.push(opts);
      const e = entries.find((x) => !opts?.exclude?.includes(x.id) && (!opts?.prefer || x.id === opts.prefer));
      const any = e ?? entries.find((x) => !opts?.exclude?.includes(x.id));
      if (!any) throw new NoProviderError(cap, []);
      return any;
    },
    async recordUse(id) {
      used.push(id);
    },
    async markExhausted() {},
  };
  return { registry, picks, used };
}

const verbose = (words: [string, number, number][]) =>
  new Response(
    JSON.stringify({
      language: "en",
      words: words.map(([word, start, end]) => ({ word, start, end })),
      segments: [{ start: words[0]?.[1] ?? 0, end: words.at(-1)?.[2] ?? 0, text: words.map((w) => w[0]).join(" "), avg_logprob: -0.1 }],
    }),
    { status: 200 },
  );

let tmp: string;
let dir: string;
let n = 0;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-transcribe-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = join(tmp, `proj ${n++}`);
  await mkdir(join(dir, "media"), { recursive: true });
});

/** Put a generated audio file into the project plus a matching ingest.json. */
async function seed(name: string, lavfi: string, seconds: number): Promise<void> {
  await runBin(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", lavfi, "-t", String(seconds), "-ac", "1", "-ar", "16000", join(dir, "media", name)]);
  await writeJsonAtomic(join(dir, "media", "ingest.json"), { file: `media/${name}`, durationSec: seconds, hasAudio: true });
}

function ctxBase(registry: ProviderRegistry, env: Record<string, string | undefined> = {}) {
  return { config, providers: registry, log: () => {}, env: { FFMPEG: process.env.FFMPEG, ...env } };
}

test("writes words.json from a fake stt provider", async () => {
  await seed("a.wav", "sine=frequency=440:duration=3", 3);
  const { registry, used } = fakeRegistry([entry("groq", "openai-compat")]);
  const step = createTranscribe({ fetchImpl: async () => verbose([["Hello", 0.1, 0.5], ["world", 0.6, 1.0]]) });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r.verdicts));
  assert.equal(r.metrics.wordCount, 2);
  assert.equal(r.metrics.pctTimestamped, 100);
  assert.equal(r.metrics.chunks, 1);
  assert.equal(r.metrics.provider, "groq");
  assert.equal(r.metrics.language, "en");
  assert.deepEqual(r.provider, { id: "groq", model: "groq-model" });
  assert.deepEqual(used, ["groq"]);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.equal(j.words.length, 2);
  assert.equal(j.words[0].w, "Hello");
  assert.deepEqual(j.provider, { id: "groq", model: "groq-model" });
  assert.ok(Math.abs(j.durationSec - 3) < 0.05);
  assert.equal(j.segments.length, 1);
  assert.ok(existsSync(join(dir, "transcript", "audio.wav")));
});

test("planChunks: no split at or under 600 s", () => {
  const env = new Float32Array(60_000).fill(-30);
  assert.deepEqual(planChunks(600, env, 10), [{ start: 0, end: 600 }]);
});

test("chunk boundary lands in the quietest window near 600 s", () => {
  const env = new Float32Array(130_000).fill(-30); // 1300 s at 10 ms
  for (let i = 59_500; i < 59_550; i++) env[i] = -96; // quiet 595.0..595.5 s
  for (let i = 60_100; i < 60_120; i++) env[i] = -80; // less quiet 601.0..601.2 s
  const chunks = planChunks(1300, env, 10);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.start, 0);
  assert.ok((chunks[0]?.end as number) >= 595 && (chunks[0]?.end as number) <= 595.5, String(chunks[0]?.end));
  assert.equal(chunks[0]?.end, chunks[1]?.start);
  assert.equal(chunks[2]?.end, 1300);
});

test("offsets words by chunk start", async () => {
  // 1300 s tone with a short silence at ~604 s
  await seed("long.wav", "sine=frequency=440:duration=1300,volume='if(between(t,604,604.5),0,1)':eval=frame", 1300);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const step = createTranscribe({ fetchImpl: async () => verbose([["hi", 1, 1.5]]) });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass");
  assert.equal(r.metrics.chunks, 3);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.equal(j.words.length, 3);
  assert.equal(j.words[0].start, 1);
  const start2 = j.words[1].start - 1;
  assert.ok(start2 >= 604 && start2 <= 604.5, String(start2));
  assert.ok(j.words[2].start > start2 + 580);
  assert.ok(j.words[1].start > j.words[0].end);
});

test("music-only clip: zero words fails the gate with wordCount", async () => {
  await seed("m.wav", "sine=frequency=440:duration=2", 2);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const step = createTranscribe({
    fetchImpl: async () => new Response(JSON.stringify({ language: "en", words: [], segments: [] }), { status: 200 }),
  });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "fail");
  assert.equal(r.metrics.wordCount, 0);
  const bad = r.verdicts.filter((v) => !v.ok).map((v) => v.metric);
  assert.deepEqual(bad, ["wordCount"]);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words, []);
});

test("private flag reaches pick, language and prefer forwarded", async () => {
  await seed("a.wav", "sine=frequency=440:duration=2", 2);
  const { registry, picks } = fakeRegistry([entry("groq", "openai-compat"), entry("cloudflare", "native", { envValues: { accountId: "acc" } })]);
  let lang: unknown;
  const step = createTranscribe({
    fetchImpl: async (_u, init) => {
      lang = (init?.body as FormData).get("language");
      return verbose([["a", 0, 0.2]]);
    },
  });
  await runStep(dir, step, { params: { language: "fr", prefer: "groq" }, ...ctxBase(registry) });
  assert.equal(picks[0]?.private, true);
  assert.equal(picks[0]?.prefer, "groq");
  assert.equal(lang, "fr");
});

test("falls back to cloudflare when groq fails, provider recorded", async () => {
  await seed("a.wav", "sine=frequency=440:duration=2", 2);
  const { registry } = fakeRegistry([entry("groq", "openai-compat"), entry("cloudflare", "native", { envValues: { accountId: "acc" } })]);
  const step = createTranscribe({
    fetchImpl: async (url) => {
      if (String(url).includes("fake.test")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ success: true, result: { text: "hi", words: [{ word: " hi", start: 0, end: 0.3 }] } }), { status: 200 });
    },
  });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass");
  assert.equal(r.metrics.provider, "cloudflare");
});

function fakeWhisper(path: string, fixture: unknown): void {
  const fx = `${path}.fixture.json`;
  writeFileSync(fx, JSON.stringify(fixture));
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then of="$2"; fi; shift; done\ncp "${fx}" "$of.json"\n`,
  );
  chmodSync(path, 0o755);
}

const whisperFixture = {
  result: { language: "en" },
  transcription: [
    { offsets: { from: 0, to: 300 }, text: " Hello" },
    { offsets: { from: 300, to: 300 }, text: " ," },
    { offsets: { from: 320, to: 900 }, text: " world." },
    { offsets: { from: 900, to: 1000 }, text: "  " },
  ],
};

test("whisper-cpp output is parsed into words", () => {
  const words = parseWhisperCpp(whisperFixture);
  assert.deepEqual(words, [
    { w: "Hello", start: 0, end: 0.3 },
    { w: "world.", start: 0.32, end: 0.9 },
  ]);
});

test("whisper-cpp step run: args, wav chunks, meanConfidence 1 without conf", async () => {
  await seed("a.wav", "sine=frequency=440:duration=2", 2);
  const cli = join(tmp, `whisper-${n}.sh`);
  fakeWhisper(cli, whisperFixture);
  const { registry } = fakeRegistry([entry("whisper-cpp", "local", { baseUrl: undefined, key: undefined, model: "large-v3" })]);
  const step = createTranscribe({});
  const r = await runStep(dir, step, {
    params: { language: "en" },
    ...ctxBase(registry, { WHISPER_CLI: cli, WHISPER_MODELS_DIR: "/models" }),
  });
  assert.equal(r.status, "pass", JSON.stringify(r.verdicts));
  assert.equal(r.metrics.provider, "whisper-cpp");
  assert.equal(r.metrics.meanConfidence, 1);
  assert.equal(r.metrics.confidenceKnown, false);
  const args = readFileSync(`${cli}.args`, "utf8").split("\n");
  assert.equal(args[args.indexOf("-m") + 1], "/models/ggml-large-v3.bin");
  assert.ok((args[args.indexOf("-f") + 1] as string).endsWith(".wav"));
  for (const f of ["-ml", "-sow", "-oj", "-np"]) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf("-l") + 1], "en");
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.equal(j.words.length, 2);
});

test("whisper-cpp without WHISPER_MODELS_DIR fails with a clear message", async () => {
  await seed("a.wav", "sine=frequency=440:duration=2", 2);
  const { registry } = fakeRegistry([entry("whisper-cpp", "local", { baseUrl: undefined, key: undefined, model: "large-v3" })]);
  const r = await runStep(dir, createTranscribe({}), { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /WHISPER_MODELS_DIR/);
});

test("cloudflare adapter builds the account URL", async () => {
  const mp3 = join(tmp, "c.mp3");
  writeFileSync(mp3, Buffer.from([1, 2, 3]));
  let seen: { url: string; init: RequestInit } | undefined;
  const p = entry("cloudflare", "native", { model: "@cf/openai/whisper-large-v3-turbo", envValues: { accountId: "acc123" } });
  const out = await transcribeCloudflare(p, mp3, {
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(JSON.stringify({ success: true, result: { text: "hi", words: [{ word: " hi", start: 0, end: 0.4 }] } }), { status: 200 });
    },
  });
  assert.equal(seen?.url, "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/openai/whisper-large-v3-turbo");
  assert.equal((seen?.init.headers as Record<string, string>).authorization, "Bearer secret-key");
  assert.deepEqual(JSON.parse(seen?.init.body as string), { audio: Buffer.from([1, 2, 3]).toString("base64") });
  assert.deepEqual(out.words, [{ w: "hi", start: 0, end: 0.4 }]);
});

test("cloudflare adapter: missing accountId is a plain error", async () => {
  const mp3 = join(tmp, "c2.mp3");
  writeFileSync(mp3, "x");
  await assert.rejects(
    transcribeCloudflare(entry("cloudflare", "native"), mp3, { fetchImpl: async () => new Response("{}") }),
    /accountId/,
  );
});

test("buildSegments splits at gaps over 0.6 s", () => {
  const segs = buildSegments([
    { w: "a", start: 0, end: 0.5 },
    { w: "b", start: 0.6, end: 1 },
    { w: "c", start: 2, end: 2.4 },
  ]);
  assert.deepEqual(segs, [
    { start: 0, end: 1, text: "a b" },
    { start: 2, end: 2.4, text: "c" },
  ]);
});
