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
import { choosePass, DARIJA_PROMPT, darijaPrompt, isFrenchOrEnglish, msaScore, normalizeArabic } from "../src/darija.ts";
import { dropHallucinations, isHallucination, normalizeText } from "../src/hallucinations.ts";
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

test("overlapping provider words are written in transcript order with monotonic timings", async () => {
  await seed("ov.wav", "sine=frequency=440:duration=3", 3);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  // Groq pattern: "with" starts before "skin" and spans past it; "while" overlaps "margins"
  const step = createTranscribe({
    fetchImpl: async () => verbose([["the", 0.92, 1.1], ["skin", 1.1, 1.38], ["with", 0.9, 1.98], ["a", 1.98, 2.12], ["margins", 2.12, 2.6], ["while", 2.4, 2.8]]),
  });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r.verdicts));
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words.map((w: { w: string }) => w.w), ["the", "skin", "with", "a", "margins", "while"]);
  assert.deepEqual([j.words[2].start, j.words[2].end], [1.38, 1.98]);
  assert.deepEqual([j.words[5].start, j.words[5].end], [2.6, 2.8]);
  for (let i = 1; i < j.words.length; i++) assert.ok(j.words[i].start >= j.words[i - 1].end, `word ${i}`);
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

test("a provider that hit 429 or an auth error is skipped for later chunks", async () => {
  await seed("long2.wav", "sine=frequency=440:duration=1300", 1300);
  const { registry, picks } = fakeRegistry([entry("groq", "openai-compat"), entry("cloudflare", "native", { envValues: { accountId: "acc" } })]);
  let groqCalls = 0;
  const step = createTranscribe({
    fetchImpl: async (url) => {
      if (String(url).includes("fake.test")) {
        groqCalls++;
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ success: true, result: { text: "hi", words: [{ word: " hi", start: 0, end: 0.3 }] } }), { status: 200 });
    },
  });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.chunks, 3);
  assert.equal(groqCalls, 1);
  assert.equal(picks.length, 4); // chunk 1: groq then cloudflare; chunks 2 and 3: cloudflare directly
  assert.deepEqual(picks[2]?.exclude, ["groq"]);
  assert.deepEqual(picks[3]?.exclude, ["groq"]);
});

test("bracketed non-speech tokens and music symbols are dropped", async () => {
  await seed("ns.wav", "sine=frequency=440:duration=3", 3);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const step = createTranscribe({
    fetchImpl: async () =>
      verbose([["(music)", 0, 0.3], ["[Music]", 0.3, 0.5], ["♪", 0.5, 0.6], ["Hello", 0.6, 0.9], ["(applause).", 0.9, 1.1], ["♪♪", 1.1, 1.2], ["world", 1.2, 1.5], ["(really)?", 1.5, 1.6]]),
  });
  const r = await runStep(dir, step, { params: {}, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r.verdicts));
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words.map((w: { w: string }) => w.w), ["Hello", "world"]);
  assert.equal(r.metrics.nonSpeechDropped, 6);
});

test("planChunks with 30 s windows cuts at the quietest point within +-5 s, 600 s default unchanged", () => {
  const env = new Float32Array(7_000).fill(-30); // 70 s at 10 ms
  for (let i = 2_700; i < 2_720; i++) env[i] = -90; // quiet 27.0..27.2 s
  const w = planChunks(70, env, 10, 30, 5);
  assert.equal(w.length, 3);
  assert.ok((w[0]?.end as number) >= 27 && (w[0]?.end as number) <= 27.2, String(w[0]?.end));
  assert.ok((w[1]?.end as number) >= 55 && (w[1]?.end as number) <= 65);
  assert.equal(w[2]?.end, 70);
  assert.deepEqual(planChunks(34, env, 10, 30, 5), [{ start: 0, end: 34 }]);
  assert.deepEqual(planChunks(70, env, 10), [{ start: 0, end: 70 }]);
});

test("normalizeArabic folds alef/hamza variants and strips harakat", () => {
  assert.equal(normalizeArabic("أيضاً إلى آخر"), "ايضا الي اخر");
});

test("msaScore: MSA markers minus Darija markers", () => {
  assert.equal(msaScore("سوف نريك الكثير من المشاهدين الذين يتابعون"), 2);
  assert.equal(msaScore("دابا غادي نشرح ليكم كيفاش كنخدم"), -3);
  assert.equal(msaScore("وسوف نحن، ايضا!"), 3);
  assert.equal(msaScore("bonjour"), 0);
  assert.equal(msaScore("سوف ديال"), 0);
});

test("isFrenchOrEnglish accepts names and codes in any case", () => {
  for (const l of ["french", "FR", "English", "en"]) assert.equal(isFrenchOrEnglish(l), true, l);
  for (const l of ["arabic", "ar", "", undefined]) assert.equal(isFrenchOrEnglish(l), false, String(l));
});

test("choosePass picks B only for French/English auto when A reads as MSA", () => {
  assert.equal(choosePass("سوف نشرح لكم", "french"), "B");
  assert.equal(choosePass("سوف نشرح لكم", "arabic"), "A");
  assert.equal(choosePass("دابا غادي نشرح", "french"), "A");
  assert.equal(choosePass("", "english"), "A");
});

test("darijaPrompt appends the user's prompt", () => {
  assert.equal(darijaPrompt(), DARIJA_PROMPT);
  assert.equal(darijaPrompt("  "), DARIJA_PROMPT);
  assert.equal(darijaPrompt("mostudio, Groq"), `${DARIJA_PROMPT} mostudio, Groq`);
  assert.match(DARIJA_PROMPT, /دابا/);
});

test("normalizeText strips punctuation and diacritics, lowercases, collapses spaces", () => {
  assert.equal(normalizeText("  Sous-titres réalisés par la communauté d'Amara.org  "), "sous titres realises par la communaute d amara org");
  assert.equal(normalizeText("اشتركوا   في القناةَ!"), "اشتركوا في القناة");
});

test("isHallucination: equal to, or whole words inside, a blocklisted line", () => {
  assert.equal(isHallucination("اشتركوا في القناة."), true);
  assert.equal(isHallucination("Thanks for watching!"), true);
  assert.equal(isHallucination("thanks for"), true);
  assert.equal(isHallucination("Subtitles by the Amara.org community"), true);
  assert.equal(isHallucination("thanks for watching my video about montage"), false);
  assert.equal(isHallucination("than"), false);
  assert.equal(isHallucination(" ... "), false);
});

test("dropHallucinations removes the segment and the words whose midpoint is inside it", () => {
  const words = [
    { w: "اشتركوا", start: 0, end: 5 },
    { w: "في", start: 5, end: 10 },
    { w: "القناة", start: 10, end: 15.2 },
    { w: "دابا", start: 15.5, end: 16 },
  ];
  const segments = [
    { start: 0, end: 15, text: " اشتركوا في القناة" },
    { start: 15.5, end: 16, text: " دابا" },
  ];
  const out = dropHallucinations(words, segments);
  assert.equal(out.dropped, 1);
  assert.deepEqual(out.words.map((w) => w.w), ["دابا"]);
  assert.deepEqual(out.segments, [segments[1]]);
  assert.deepEqual(dropHallucinations(words.slice(3), segments.slice(1)), { words: words.slice(3), segments: segments.slice(1), dropped: 0 });
});

/** verbose_json reply whose language is `language`. */
const reply = (language: string, words: [string, number, number][]) =>
  new Response(
    JSON.stringify({
      language,
      words: words.map(([word, start, end]) => ({ word, start, end })),
      segments: words.length ? [{ start: words[0]?.[1], end: words.at(-1)?.[2], text: words.map((w) => w[0]).join(" "), avg_logprob: -0.1 }] : [],
    }),
    { status: 200 },
  );

test("darija: forced-ar pass by default, auto pass only for French speech that A turned into MSA", async () => {
  await seed("d.wav", "sine=frequency=440:duration=70", 70);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const calls: { file: string; language: unknown; prompt: unknown }[] = [];
  const logs: string[] = [];
  const step = createTranscribe({
    fetchImpl: async (_u, init) => {
      const form = init?.body as FormData;
      const file = (form.get("file") as File).name;
      const language = form.get("language");
      calls.push({ file, language, prompt: form.get("prompt") });
      const win = Number(/chunk-(\d+)/.exec(file)?.[1]);
      if (language === "ar") {
        if (win === 0) return reply("arabic", [["دابا", 1, 1.5], ["غادي", 1.5, 2], ["نشرح", 2, 2.5]]);
        return reply("arabic", [["سوف", 1, 1.5], ["نشرح", 1.5, 2], ["الذي", 2, 2.5]]);
      }
      if (win === 1) return reply("french", [["bonjour", 1, 1.5], ["tout", 1.5, 2], ["le", 2, 2.2], ["monde", 2.2, 2.6]]);
      return reply("arabic", [["سوف", 1, 1.5]]);
    },
  });
  const r = await runStep(dir, step, {
    params: { dialect: "darija", prompt: "mostudio" },
    ...ctxBase(registry),
    log: (m: string) => logs.push(m),
  });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.windows, 3);
  assert.equal(r.metrics.autoWindows, 1);
  assert.equal(r.metrics.chunks, 3);
  // window 0: A only (Darija); windows 1 and 2: A then B
  assert.deepEqual(calls.map((c) => [c.file.slice(-7, -4), c.language]), [["000", "ar"], ["001", "ar"], ["001", null], ["002", "ar"], ["002", null]]);
  for (const c of calls.filter((x) => x.language === "ar")) assert.equal(c.prompt, `${DARIJA_PROMPT} mostudio`);
  for (const c of calls.filter((x) => x.language === null)) assert.equal(c.prompt, null);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words.map((w: { w: string }) => w.w), ["دابا", "غادي", "نشرح", "bonjour", "tout", "le", "monde", "سوف", "نشرح", "الذي"]);
  assert.ok(j.words[3].start > 25, String(j.words[3].start));
  assert.ok(logs.some((l) => /window 2: pass B/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /window 1: pass A/.test(l)), logs.join("\n"));
});

test("darija: a failing auto pass keeps pass A", async () => {
  await seed("d2.wav", "sine=frequency=440:duration=10", 10);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const step = createTranscribe({
    fetchImpl: async (_u, init) => {
      const form = init?.body as FormData;
      if (form.get("language") === "ar") return reply("arabic", [["سوف", 1, 1.5], ["نشرح", 1.5, 2]]);
      return new Response("boom", { status: 500 });
    },
  });
  const r = await runStep(dir, step, { params: { dialect: "darija" }, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.autoWindows, 0);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words.map((w: { w: string }) => w.w), ["سوف", "نشرح"]);
});

test("unknown dialect fails listing the supported one", async () => {
  await seed("a.wav", "sine=frequency=440:duration=2", 2);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  const r = await runStep(dir, createTranscribe({ fetchImpl: async () => verbose([["a", 0, 0.2]]) }), { params: { dialect: "egyptian" }, ...ctxBase(registry) });
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /unknown dialect "egyptian" \(supported: darija\)/);
});

test("without dialect the prompt param is forwarded and hallucinated segments are dropped", async () => {
  await seed("h.wav", "sine=frequency=440:duration=20", 20);
  const { registry } = fakeRegistry([entry("groq", "openai-compat")]);
  let prompt: unknown;
  const step = createTranscribe({
    fetchImpl: async (_u, init) => {
      prompt = (init?.body as FormData).get("prompt");
      return new Response(
        JSON.stringify({
          language: "arabic",
          words: [
            { word: "اشتركوا", start: 0, end: 5 },
            { word: "في", start: 5, end: 10 },
            { word: "القناة", start: 10, end: 15 },
            { word: "مرحبا", start: 16, end: 17 },
          ],
          segments: [
            { start: 0, end: 15, text: " اشتركوا في القناة", avg_logprob: -0.1 },
            { start: 16, end: 17, text: " مرحبا", avg_logprob: -0.1 },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const r = await runStep(dir, step, { params: { prompt: "Groq, ffmpeg" }, ...ctxBase(registry) });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(prompt, "Groq, ffmpeg");
  assert.equal(r.metrics.hallucinationsDropped, 1);
  assert.equal(r.metrics.windows, undefined);
  const j = JSON.parse(readFileSync(join(dir, "transcript", "words.json"), "utf8"));
  assert.deepEqual(j.words.map((w: { w: string }) => w.w), ["مرحبا"]);
  assert.equal(j.segments.length, 1);
});

test("cloudflare adapter sends the prompt as initial_prompt", async () => {
  const mp3 = join(tmp, "c3.mp3");
  writeFileSync(mp3, "x");
  let body: Record<string, string> = {};
  await transcribeCloudflare(entry("cloudflare", "native", { envValues: { accountId: "a" } }), mp3, {
    language: "ar",
    prompt: "دابا",
    fetchImpl: async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { words: [] } }), { status: 200 });
    },
  });
  assert.equal(body.initial_prompt, "دابا");
  assert.equal(body.language, "ar");
});
