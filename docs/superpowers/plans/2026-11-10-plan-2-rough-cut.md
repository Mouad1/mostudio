# Plan 2 — Rough-cut chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each step module is one moskills `modular-build` module; user acceptance is collected at the end (Ruling R9 pattern).

**Goal:** `mostudio run rough-cut --project <dir> --param ingest.source=<clip>` turns a 10–20 min raw facecam into `renders/final.mp4` with silences/fillers/retakes removed, burned captions, mixed audio at −14 LUFS, YouTube chapters and a QA report (spec goal G2).

**Architecture:** Each step reads and writes files in the project folder (contracts below). `cut` only produces an edit decision list (`cut/edl.json`); `mix` renders audio once and `assemble` renders video once from that list, so nothing is re-encoded twice. Provider calls (STT, LLM) go through one core helper that rotates free-tier providers and falls back on 429/errors. **Render split (ADR 0002 applied):** long videos (YouTube) burn captions with ffmpeg/libass because HyperFrames renders at ~2.6× real time (≈ 50 min for 20 min of video); short videos (≤ 3 min: shorts/reels/tiktok) render captions and overlays with **HyperFrames**, our own caption component, animated captions.

**Tech Stack:** Node ≥ 22.18 (type stripping), node:test, global `fetch`/`FormData`/`Blob`, ffmpeg/ffprobe (ffmpeg with libass for burned captions), whisper.cpp `whisper-cli`, Groq / Cloudflare Workers AI / Gemini free tiers.

**Spec:** `docs/superpowers/specs/2026-11-09-mostudio-design.md` (§2 G2/G5/G6, §4.3–4.5, §5, §5b). Plan 1 (done): `docs/superpowers/plans/2026-11-09-plan-1-foundation.md`. ADR 0002 (render path, accepted).

## Global Constraints

- License MIT; no copied third-party code or prose; ported tubemauto code gets a `docs/provenance.md` row.
- Zero runtime dependencies. New dependency = user approval first. Plan 2 needs none.
- Steps import core only through `core/src/index.ts` (boundaries test); steps never import each other — shared logic lives in core.
- Every step contract has `"version": "1"`; external binaries via core `runBin`/`resolveBin` (shell:false); binary paths come from `ctx.env` (`FFMPEG`, `FFPROBE`, `WHISPER_CLI`, `WHISPER_MODELS_DIR`).
- Media outputs are written with core `writeOutputAtomic`; JSON outputs with `writeJsonAtomic`.
- Keys only via `ctx.providers.pick` (never `ctx.env`); never logged; steps on user footage set `"private": true`.
- `billing: free-only`; paid calls never made.
- All times in JSON files are seconds (number, 3 decimals). Source timeline = times in the original clip; cut timeline = times in the edited output.
- Workflows are JSON (`workflows/<name>.json`).
- ffmpeg is resolved by capability, never assumed: `FFMPEG` env → `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` → `ffmpeg` on PATH; the first one that has the filters a step needs wins (default Homebrew ffmpeg lacks `ass`/`subtitles`/`drawtext`).
- Video encoder: `h264_videotoolbox` (Mac hardware, ~3× faster) when the chosen ffmpeg has it, else `libx264`. Intermediates `-q:v 70` (videotoolbox) / `crf 12` (x264); final `-q:v 60` / `crf 18`.
- HyperFrames is called as `npx hyperframes@0.9.26 …` (pinned, Apache 2.0, used as a tool, never copied). Our HyperFrames components use CSS animations / Web Animations API only: no GSAP, no CDN, so renders work offline and carry no extra license.

## Data contracts (project folder)

| File | Written by | Shape |
|---|---|---|
| `media/ingest.json` | ingest (Plan 1) | `{ file, durationSec, fps, width, height, rotation, hasAudio, sha256, sizeMB }` |
| `transcript/audio.wav` | transcribe | 16 kHz mono s16 PCM of the source |
| `transcript/words.json` | transcribe | `{ language: string, provider: {id, model}, durationSec, words: Word[], segments: {start,end,text}[] }`, `Word = { w: string, start: number, end: number, conf?: number }` (source timeline) |
| `cut/edl.json` | cut | `{ source: "media/<file>", fadeSec: number, keep: {start,end}[], removed: {start,end,reason:"silence"\|"filler"\|"retake"}[], outDurationSec: number }` (source timeline, keep sorted, non-overlapping) |
| `captions/cues.json`, `captions.srt`, `captions.ass`, `captions.txt` | captions | cue `{ start, end, text, words: {w,start,end}[] }` (cut timeline) |
| `edits/replacements.txt` | user (created empty by `mostudio new`) | lines `wrong => right` (case-insensitive, whole words, left side may be several words), `#` comments |
| `audio/mix.wav` | mix | 48 kHz stereo, cut timeline |
| `chapters/chapters.json`, `chapters/youtube.txt` | chapters | `[{ start, title }]` cut timeline; `00:00 Title` lines |
| `renders/final.mp4`, `renders/final.srt` | assemble | final video + captions copy |
| `renders/contact-sheet.jpg`, `renders/qa.md` | qa | contact sheet; rubric + measured checks |

## Review Focus

1. A 20-minute rush with 300+ kept segments must assemble without ffmpeg running out of memory → batching test in Task 8.
2. A clip with no speech (music only) must fail transcribe's gate with a clear reason, and cut must not crash on zero words → tests in Tasks 4 and 5.
3. Variable-frame-rate phone footage must not drift audio vs video → VFR fixture test in Task 8.
4. A provider answering 429 mid-run must fall back to the next provider without losing the run or double-counting quota → test in Task 2.
5. Project paths with spaces/accents must survive ffmpeg filter arguments (`ass=` and `subtitles=` paths need escaping) → test in Task 8.

---

### Task 1: core — optional params, timeline, audio envelope, edits folder

**Files:**
- Create: `core/src/timeline.ts`, `core/src/timeline.test.ts`, `core/src/audio/envelope.ts`, `core/src/audio/envelope.test.ts`
- Modify: `core/src/step.ts` (+ test), `core/src/project.ts` (+ test), `core/src/index.ts`

**Interfaces:**
- Produces:
  - StepContract `params` value may end with `?` (`"string?" | "number?" | "boolean?"`) = optional; absent optional params are omitted from `ctx.params`; an optional fileParam that is absent is skipped (not hashed, not required).
  - `type Range = { start: number; end: number }`
  - `mapToCut(t: number, keep: Range[]): number | undefined` — source time → cut time (undefined if `t` falls in a removed part)
  - `keepDuration(keep: Range[]): number`
  - `rmsEnvelope(wavPath: string, windowMs = 10): Promise<Float32Array>` — reads a 16-bit PCM WAV (any channel count, averaged), returns RMS per window in dBFS (silence floor −96)
  - `quietestPoint(env: Float32Array, windowMs: number, from: number, to: number): number` — time (s) of the lowest-RMS window in [from, to]
  - `createProject` also creates `edits/replacements.txt` containing `# wrong => right (one per line)\n`
  - `resolveFfmpeg(env: Record<string, string | undefined>, needs: string[]): Promise<string>` in `core/src/proc.ts` — tries `FFMPEG`, then `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`, then `ffmpeg`; returns the first whose `-filters` lists every name in `needs`; throws listing what each candidate lacks. Result cached per process.
  - `pickH264Encoder(ffmpeg: string): Promise<"h264_videotoolbox" | "libx264">` (from `-encoders`; `MOSTUDIO_ENCODER=libx264` forces software)

- [ ] **Step 1: Failing tests**

```ts
test("optional param may be absent", async () => { /* contract params {music:"string?"}; runStep without it → pass, ctx.params has no "music" */ });
test("optional fileParam absent is not required", async () => { /* fileParams ["music"], params {music:"string?"} */ });
test("mapToCut shifts by removed time", () => assert.equal(mapToCut(5, [{start:0,end:2},{start:4,end:6}]), 3));
test("mapToCut inside removed part is undefined", () => assert.equal(mapToCut(3, [{start:0,end:2},{start:4,end:6}]), undefined));
test("keepDuration sums ranges", () => assert.equal(keepDuration([{start:0,end:2},{start:4,end:6.5}]), 4.5));
test("rmsEnvelope finds a silent gap", async () => { /* ffmpeg: 1 s sine, 0.5 s anullsrc, 1 s sine → windows 100..149 below -60 dBFS */ });
test("quietestPoint picks the silent window", async () => { /* returns a time within [1.0, 1.5] */ });
test("new project has edits/replacements.txt", async () => {});
test("resolveFfmpeg skips a build missing a needed filter", async () => { /* fake ffmpeg scripts: first lacks ass, second has it */ });
test("resolveFfmpeg error names what each candidate lacks", async () => {});
test("pickH264Encoder falls back to libx264", async () => {});
```

- [ ] **Step 2: Run** `node --test core/src/` → FAIL. **Step 3: Implement** (WAV: parse RIFF header, find `fmt `/`data` chunks; stream the data chunk). **Step 4: Run** → PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(core): optional params, timeline mapping, audio envelope`

---

### Task 2: core — provider calls with fallback, OpenAI-compatible client

**Files:**
- Create: `core/src/providers/call.ts`, `core/src/providers/call.test.ts`, `core/src/providers/openai-compat.ts`, `core/src/providers/openai-compat.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `ProviderRegistry.pick/recordUse/markExhausted`, `PickedProvider`, `PickOptions`, `NoProviderError` (Plan 1).
- Produces:
  - `class ProviderHttpError extends Error { status: number; providerId: string }` (message never contains the key or request body)
  - `withProvider<T>(providers: ProviderRegistry, capability: Capability, fn: (p: PickedProvider) => Promise<T>, opts?: { prefer?: string; private?: boolean; maxAttempts?: number }): Promise<{ result: T; provider: { id: string; model: string }; attempts: { id: string; error: string }[] }>` — loop: pick (with `exclude` = already tried), call `fn`, on success `recordUse` and return; on `ProviderHttpError` 429 → `markExhausted` + next; on any other error → next; when `pick` throws `NoProviderError`, rethrow it with the attempts appended to the message. `maxAttempts` default 4.
  - `type FetchLike = typeof fetch`
  - `chatComplete(p: PickedProvider, messages: {role:"system"|"user";content:string}[], opts?: { json?: boolean; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<string>` — POST `${p.baseUrl}/chat/completions`, `Authorization: Bearer ${p.key.reveal()}`, model = `p.model`, `response_format: {type:"json_object"}` when `json`; returns `choices[0].message.content`.
  - `transcribeAudio(p: PickedProvider, audioPath: string, opts?: { language?: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<{ language: string; words: Word[]; segments: {start,end,text,avgLogprob?}[] }>` — multipart POST `${p.baseUrl}/audio/transcriptions` with `model`, `response_format=verbose_json`, `timestamp_granularities[]=word`, `timestamp_granularities[]=segment`; maps to Word (conf from the containing segment as `Math.exp(avgLogprob)`, clamped 0..1).
  - Export type `Word = { w: string; start: number; end: number; conf?: number }` from core.

- [ ] **Step 1: Failing tests** (fake registry + fake `fetchImpl`; no network)

```ts
test("withProvider falls back after 429 and marks exhausted", async () => { /* groq → 429, cloudflare → ok; markExhausted("groq") called once; recordUse("cloudflare") once; recordUse("groq") never */ });
test("withProvider falls back on network error", async () => {});
test("withProvider passes private to pick", async () => {});
test("all providers failing gives NoProviderError listing attempts", async () => {});
test("chatComplete sends bearer key and json mode", async () => { /* inspect fake request headers/body */ });
test("ProviderHttpError message has no key", async () => { /* 401 response body echoes the key → message lacks it */ });
test("transcribeAudio maps verbose_json words and confidence", async () => { /* fixture JSON → words with conf exp(-0.2) ≈ 0.819 */ });
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(core): provider calls with fallback and OpenAI-compatible client`

---

### Task 3: step — `transcribe`

**Files:**
- Create: `steps/transcribe/contract.json`, `steps/transcribe/src/transcribe.ts`, `steps/transcribe/src/whisper-cpp.ts`, `steps/transcribe/src/cloudflare.ts`, `steps/transcribe/src/chunk.ts`, `steps/transcribe/tests/*.test.ts`, `steps/transcribe/README.md`
- Modify: `steps/index.ts`, `docs/provenance.md` (whisper.cpp JSON parsing idea from tubemauto `packages/providers/src/whisper-cpp.ts`)

**Interfaces:**
- Consumes: `withProvider`, `transcribeAudio`, `rmsEnvelope`, `quietestPoint`, `runBin`, `resolveBin`, `writeOutputAtomic`, `writeJsonAtomic`, `Word`.
- Contract: `inputs ["media/ingest.json"]`, `outputs ["transcript/audio.wav","transcript/words.json"]`, `params { language: "string?", prefer: "string?" }`, `private: true`, gate: `pctTimestamped >= 95` fail, `meanConfidence >= 0.7` warn, `wordCount > 0` fail.
- Metrics: `wordCount, pctTimestamped, meanConfidence, language, chunks, runtimeSec, provider` (provider id string).
- Behavior:
  - Extract `transcript/audio.wav` (16 kHz mono) from `media/<file>`.
  - Chunks: ≤ 600 s each, split at `quietestPoint` within ±10 s of each 600 s mark; chunk files in `cache/transcribe/` encoded mp3 64 kb/s (under Groq's 25 MB limit); word times offset by chunk start.
  - Provider by capability `stt` via `withProvider` (default chain from providers.json: groq → cloudflare → whisper-cpp); `prefer` param forwards to it.
  - `whisper-cpp` (kind local): `whisper-cli -m $WHISPER_MODELS_DIR/ggml-<model>.bin -f <wav> -ml 1 -sow -oj -of <tmp> [-l <language>]`, parse `transcription[].offsets.from/to` (ms) + text into words; conf from token `p` if present else undefined.
  - `cloudflare` (kind native): POST `https://api.cloudflare.com/client/v4/accounts/${envValues.accountId}/ai/run/${model}` JSON `{ audio: <base64 mp3> }`, map `result.words`/`result.segments`.
  - Records the provider actually used in StepOutput.provider.

- [ ] **Step 1: Failing tests** (providers faked; whisper-cpp tested with a fake `WHISPER_CLI` script that writes a fixture JSON)

```ts
test("writes words.json from a fake stt provider", async () => {});
test("offsets words by chunk start", async () => { /* 2 chunks of a 1300 s fake duration: chunk 2 words shifted */ });
test("chunk boundary lands in the quietest window near 600 s", async () => {});
test("music-only clip: zero words fails the gate with wordCount", async () => {});
test("whisper-cpp output is parsed into words", async () => {});
test("cloudflare adapter builds the account URL", async () => {});
test("private flag reaches pick", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Manual:** `cli/bin/mostudio-bws step transcribe --project <p>` on the Marginol clip → pass, provider groq; again with `--param prefer=whisper-cpp` → pass. Record both in the report.
- [ ] **Step 6: Commit** `feat(transcribe): word-level transcript with provider fallback`

---

### Task 4: step — `cut`

**Files:**
- Create: `steps/cut/contract.json`, `steps/cut/src/cut.ts`, `steps/cut/src/detect.ts`, `steps/cut/fillers.json`, `steps/cut/tests/*.test.ts`, `steps/cut/README.md`
- Modify: `steps/index.ts`

**Interfaces:**
- Consumes: `rmsEnvelope`, `quietestPoint`, `keepDuration`, `Range`, `Word`.
- Contract: `inputs ["media/ingest.json","transcript/words.json","transcript/audio.wav"]`, `outputs ["cut/edl.json"]`, `params { pace: "string?", maxGap: "number?", pre: "number?", post: "number?", minKeep: "number?", retakes: "boolean?" }`, gate: `midWordCuts == 0` fail, `removedPct <= 60` warn.
- Pace presets (param `pace: "string?"`, default `natural`; explicit numeric params override): `natural` (YouTube, keeps breathing room) `maxGap 0.45`, `pre 0.10`, `post 0.15`; `tight` (shorts/reels) `maxGap 0.25`, `pre 0.05`, `post 0.08`. Both: `minKeep 0.30`, `fadeSec 0.010`, `retakes true`, retake window 20 s, retake match = first 3 normalized words. The evolvebook tunes these from real runs.
- `detect.ts` pure functions:
  - `fillerWords(words: Word[], fillers: string[]): number[]` (indices)
  - `retakeSpans(words: Word[], windowSec: number, k: number): Range[]` — phrases split at gaps > 0.6 s; if phrase j (within window) starts with the same k normalized words as an earlier phrase i, remove i … j-1 (keep the last take).
  - `keepRanges(words: Word[], removedIdx: Set<number>, opts): Range[]` — keep [first.start − pre, last.end + post] of runs of kept words, split runs at gaps > maxGap, then move each boundary to `quietestPoint` inside the gap, merge overlaps, drop keeps < minKeep, clamp to [0, duration].
  - `midWordCuts(keep: Range[], words: Word[]): number` — boundaries strictly inside a kept word.
- `fillers.json`: `["euh","heu","hum","hmm","um","uh","erm","ah","eh","bah"]`.
- Metrics: `removedPct, cutCount, midWordCuts, shortestKeepSec, fillersRemoved, retakesRemoved, outDurationSec`.

- [ ] **Step 1: Failing tests** (pure functions on synthetic words; one integration test with a generated wav)

```ts
test("gap above maxGap is removed", () => {});
test("tight pace removes a 0.3 s gap that natural keeps", () => {});
test("filler words are removed", () => {});
test("earlier take is dropped, last take kept", () => { /* "on va voir ... | on va voir comment" → first removed */ });
test("boundaries never land inside a word", () => {});
test("zero words keeps nothing and gives a clear error", async () => { /* step fails with error mentioning no words */ });
test("edl keep ranges sorted, non-overlapping, within duration", () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(cut): edit decision list for silences, fillers and retakes`

---

### Task 5: step — `captions`

**Files:**
- Create: `steps/captions/contract.json`, `steps/captions/src/captions.ts`, `steps/captions/src/group.ts`, `steps/captions/src/ass.ts`, `steps/captions/src/srt.ts`, `steps/captions/src/replace.ts`, `steps/captions/tests/*.test.ts`, `steps/captions/README.md`
- Modify: `steps/index.ts`, `docs/provenance.md` (ASS timestamp/escape helpers adapted from tubemauto `packages/media/src/captions.ts`)

**Interfaces:**
- Consumes: `mapToCut`, `Word`.
- Contract: `inputs ["transcript/words.json","cut/edl.json","edits/*"]`, `outputs ["captions/cues.json","captions/captions.srt","captions/captions.ass","captions/captions.txt"]`, `params { style: "string?", width: "number?", height: "number?", font: "string?" }`, `private: true`, gate: `maxCharsPerLine <= 42` fail, `maxReadingSpeed <= 17` warn, `arabicScriptPct == 0` warn.
- `style`: `"long"` (default; ≤ 42 chars per cue, one line, bottom, font size 48 on 1080 p, margin 60 px) or `"short"` (≤ 3 words per cue, font size 84 on 1080×1920, bottom margin 340 px, word highlight via ASS `\k` karaoke: base white, highlighted word `#FFD400`, outline 6 px black). `width/height` default from `media/ingest.json`.
- `parseReplacements(text: string): {from: string[]; to: string}[]`; `applyReplacements(words: Word[], rules): { words: Word[]; applied: number }` (multi-word `from` collapses into one word spanning the matched words' times).
- Cues: words mapped through `mapToCut` (dropped if in a removed part); never cross a removed part; min cue 0.5 s, max 5 s.
- `captions.txt`: `[mm:ss.cc → mm:ss.cc] text` per cue, for user review.
- Metrics: `cueCount, maxCharsPerLine, maxReadingSpeed, replacementsApplied, arabicScriptPct` (share of words containing Arabic-script letters, U+0600–U+06FF).
- Darija Latin rewriting is NOT in this plan (ruling: decided by S1 results); the `arabicScriptPct` warning tells the user.

- [ ] **Step 1: Failing tests**

```ts
test("long style keeps lines ≤ 42 chars", () => {});
test("short style ≤ 3 words with karaoke tags", () => {});
test("cue times are in the cut timeline", () => {});
test("replacement rule fixes a word and counts it", () => { /* "marginal => Marginol" */ });
test("multi-word replacement merges times", () => { /* "wa zane => Ouazzane" */ });
test("ass escapes braces and backslashes", () => {});
test("srt timestamps use comma milliseconds", () => {});
test("arabic-script words raise arabicScriptPct", () => {});
test("music-only edl (no keep) gives zero cues without crashing", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(captions): cues, SRT/ASS with replacements and karaoke style`

---

### Task 6: step — `mix`

**Files:**
- Create: `steps/mix/contract.json`, `steps/mix/src/mix.ts`, `steps/mix/tests/*.test.ts`, `steps/mix/README.md`, `core/src/audio/loudness.ts`, `core/src/audio/loudness.test.ts`
- Modify: `steps/index.ts`

**Interfaces:**
- Consumes: `runBin`, `resolveBin`, `writeOutputAtomic`, `keepDuration`.
- Produces: `measureLoudness(file: string, env: Record<string, string | undefined>): Promise<{ integratedLufs: number; truePeakDb: number }>` in `core/src/audio/loudness.ts`, exported from core (qa in Task 9 reuses it; steps can't import each other). Uses ffmpeg `loudnorm=print_format=json` (first pass) on stderr.
- Contract: `inputs ["media/ingest.json","cut/edl.json"]`, `outputs ["audio/mix.wav"]`, `params { music: "string?", musicDb: "number?", targetLufs: "number?" }`, `fileParams ["music"]`, gate: `integratedLufs between [-15,-13]` fail, `truePeakDb <= -1` fail.
- Behavior: voice = source audio cut by `edl.keep` with `afade` in/out of `edl.fadeSec` at every boundary, concatenated (batches of ≤ 80 segments rendered to `cache/mix/` then concatenated, same reason as Task 8); optional music looped/trimmed to length at `musicDb` (default −21) and ducked under voice with `sidechaincompress`; two-pass `loudnorm` to `targetLufs` (default −14), `TP=-1`, `linear=true`; output 48 kHz stereo.
- Metrics: `integratedLufs, truePeakDb, durationSec, segments, hasMusic`.

- [ ] **Step 1: Failing tests**

```ts
test("mix hits -14 LUFS ±1", async () => { /* generated speech-like tone, 3 keep ranges */ });
test("duration equals edl outDurationSec ±0.05", async () => {});
test("music is ducked under voice", async () => { /* music-only window louder than music-under-voice window by ≥ 6 dB */ });
test("200 segments mix without error (batching)", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(mix): voice cut with fades, optional ducked music, loudness normalization`

---

### Task 7: step — `chapters`

**Files:**
- Create: `steps/chapters/contract.json`, `steps/chapters/src/chapters.ts`, `steps/chapters/src/prompt.ts`, `steps/chapters/tests/*.test.ts`, `steps/chapters/README.md`
- Modify: `steps/index.ts`

**Interfaces:**
- Consumes: `withProvider`, `chatComplete`, `mapToCut`, `Word`.
- Contract: `inputs ["transcript/words.json","cut/edl.json"]`, `outputs ["chapters/chapters.json","chapters/youtube.txt"]`, `params { language: "string?", prefer: "string?" }`, `private: true`, gate: `firstAtZero == true` fail, `chapterCount >= 3` warn, `minChapterSec >= 10` fail.
- Behavior: cut-timeline transcript with `[mm:ss]` markers every ~30 s sent to `llm` via `withProvider` + `chatComplete(json: true)`; prompt (our own text in `prompt.ts`) asks for `{"chapters":[{"start":seconds,"title":"…"}]}` in the transcript's language, 4–10 chapters, titles ≤ 50 chars; result validated: first chapter forced to 0, sorted, snapped to the nearest sentence start, chapters < 10 s merged; `youtube.txt` lines `mm:ss Title` (`h:mm:ss` past 1 h).
- No-LLM fallback: when every `llm` provider fails, chapters are placed at the longest pauses (one per ~3 min, min 10 s apart) titled with the first 6 words after each pause; metric `fallback: true` and gate `fallback == false` warn — the step never blocks the workflow.
- Metrics: `chapterCount, minChapterSec, firstAtZero, provider, fallback`.

- [ ] **Step 1: Failing tests** (fake LLM)

```ts
test("chapters are sorted, first at 0, short ones merged", async () => {});
test("youtube.txt uses mm:ss and h:mm:ss past an hour", () => {});
test("invalid JSON from the model falls back to the next provider", async () => {});
test("no LLM available: pause-based chapters with fallback warn", async () => {});
test("transcript sent to the model is in the cut timeline", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(chapters): YouTube chapters from the cut transcript`

---

### Task 8: step — `assemble`

**Files:**
- Create: `steps/assemble/contract.json`, `steps/assemble/src/assemble.ts`, `steps/assemble/src/presets.ts`, `steps/assemble/src/filters.ts`, `steps/assemble/src/hyperframes.ts`, `components/captions-karaoke/index.html`, `components/captions-karaoke/captions.css`, `components/captions-karaoke/README.md`, `steps/assemble/tests/*.test.ts`, `steps/assemble/README.md`
- Modify: `steps/index.ts`

**Interfaces:**
- Consumes: `runBin`, `resolveBin`, `writeOutputAtomic`, `keepDuration`.
- Contract: `inputs ["media/ingest.json","cut/edl.json","audio/mix.wav","captions/captions.ass","captions/captions.srt"]`, `outputs ["renders/final.mp4","renders/final.srt"]`, `params { preset: "string?", burnCaptions: "boolean?", captionsRenderer: "string?" }`, gate: `avOffsetMs <= 40` fail (absolute value), `durationDeltaSec <= 0.5` fail (absolute value).
- Render split: param `captionsRenderer: "string?"` = `ass` | `hyperframes`; default `hyperframes` for `shorts`/`reels`/`tiktok` presets when the cut is ≤ 180 s, else `ass`.
- `hyperframes` path: the batched cut (video-only, preset size) is the background `<video>` of a generated composition in `scenes/captions/` (`index.html` + `hyperframes.json`) built from `captions/cues.json` with our component `components/captions-karaoke/` (word-by-word highlight `#FFD400`, white base, 6 px outline, bottom safe zone 340 px, CSS/Web Animations only); rendered with `npx hyperframes@0.9.26 lint` then `render --quality looks` to `cache/assemble/captioned.mp4`, then `audio/mix.wav` muxed. `ass` path as below.
- Presets (`presets.ts`): `youtube` 1920×1080, `shorts`/`reels`/`tiktok` 1080×1920, `source` (default: ingest width/height); scale to fit + pad black; `fps` = ingest fps rounded to 2 decimals, constant frame rate (`-fps_mode cfr`).
- Behavior: video-only segments from `edl.keep` rendered in batches of ≤ 60 (`trim`/`setpts` filter graphs) to `cache/assemble/batch-NNN.mp4` (libx264 crf 12 veryfast), concatenated with the concat demuxer (stream copy), then a final pass: preset scale/pad, `ass=` burn (if `burnCaptions`, default true), mux `audio/mix.wav` as AAC 192 kb/s, libx264 crf 18, `-movflags +faststart`; copy `captions.srt` to `renders/final.srt`.
- ffmpeg via `resolveFfmpeg(ctx.env, burn && renderer === "ass" ? ["ass"] : [])`; encoder via `pickH264Encoder`. If no candidate has `ass`, fail with the resolver's message plus the hint `brew install ffmpeg-full` (or use captionsRenderer=hyperframes).
- `filters.ts`: `escapeFilterPath(p: string): string` for `ass=` (escape `\ : ' [ ] , ;`).
- `MOSTUDIO_HYPERFRAMES_BIN` env overrides the `npx hyperframes@0.9.26` command (tests use a fake).
- Metrics: `durationSec, durationDeltaSec, avOffsetMs, width, height, fps, batches, captionsBurned, captionsRenderer, encoder, renderSec`.

- [ ] **Step 1: Failing tests** (ffmpeg fixtures; `FFMPEG` from env if set)

```ts
test("assembles a 1080x1920 shorts render with burned captions", async () => {});
test("150 keep ranges render in batches without error", async () => { /* batches === 3 */ });
test("VFR source does not drift: avOffsetMs ≤ 40", async () => { /* fixture made with mpdecimate → variable frame rate */ });
test("project path with spaces and accents works with ass=", async () => { /* "Vidéos à monter/l'essai" */ });
test("missing libass gives the install hint", async () => { /* fake ffmpeg candidates all lacking ass */ });
test("shorts preset ≤ 180 s defaults to hyperframes captions", async () => { /* renderer chosen; composition files written; npx call stubbed via MOSTUDIO_HYPERFRAMES_BIN fake */ });
test("hyperframes composition has one captions track and no external URLs", async () => { /* index.html contains data-track-kind="captions"; no http(s):// */ });
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(assemble): batched cut render, presets, burned captions, mixed audio`

---

### Task 9: step — `qa`

**Files:**
- Create: `steps/qa/contract.json`, `steps/qa/src/qa.ts`, `steps/qa/tests/qa.test.ts`, `steps/qa/README.md`
- Modify: `steps/index.ts`

**Interfaces:**
- Consumes: `measureLoudness` (Task 6), `runBin`, `resolveBin`.
- Contract: `inputs ["renders/final.mp4"]`, `outputs ["renders/contact-sheet.jpg","renders/qa.md"]`, gate: `blackStartSec <= 0.1` fail, `silentStartSec <= 0.5` fail, `integratedLufs between [-15,-13]` warn.
- Behavior: `blackdetect` on the first 2 s, `silencedetect=-50dB` on the first 1 s, loudness via `measureLoudness`; contact sheet: 12 frames evenly spaced, `tile=4x3`, width 1600; `qa.md`: measured checks table + rubric to fill (hook clear in 3 s, pacing, caption errors per minute, loudness auto-filled) per spec G6.
- Metrics: `blackStartSec, silentStartSec, integratedLufs, contactSheetFrames`.

- [ ] **Step 1: Failing tests**

```ts
test("detects a seeded black opening", async () => {});
test("detects a seeded silent opening", async () => {});
test("clean render passes and writes a 12-frame contact sheet", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(qa): black/silent opening checks, loudness, contact sheet`

---

### Task 10: workflow runner, approvals, CLI `run`/`approve`, `rough-cut` workflow

**Files:**
- Create: `core/src/workflow.ts`, `core/src/workflow.test.ts`, `workflows/rough-cut.json`
- Modify: `core/src/index.ts`, `cli/src/main.ts` (+ tests), `README.md`

**Interfaces:**
- Consumes: `runStep`, `readLedger`, `latest`, `writeJsonAtomic`, `readJson`.
- Produces:
  - `type Workflow = { name: string; steps: { step: string; params?: Record<string, unknown>; gate?: Threshold[]; approve?: boolean }[] }`; `parseWorkflow(json: unknown): Workflow` (throws naming the bad field).
  - `runWorkflow(projectDir, wf: Workflow, steps: Record<string, StepModule>, opts: RunStepOptions & { params?: Record<string, Record<string, unknown>>; force?: string[] }): Promise<{ status: "done" | "failed" | "awaiting-approval"; results: (StepResult & {cached: boolean})[]; stoppedAt?: string }>` — runs in order; stops on `fail`; after a step with `approve: true` stops with `awaiting-approval` unless `steps/approvals.json` holds that step's current `inputsHash`.
  - `approveStep(projectDir, step): Promise<void>` — records the latest result's `inputsHash` for `step` in `steps/approvals.json` (fails if the step has no passing/warn result).
  - CLI: `mostudio run <workflow> --project <dir> [--param <step>.<key>=<value>]… [--force <step>]… [--json]` (exit 0 done, 2 failed, 3 awaiting approval — prints which files to review: for captions `captions/captions.txt` and `edits/replacements.txt`); `mostudio approve <step> --project <dir>`.
  - Export `RunStepOptions` type from core (final-review minor).
- `workflows/rough-cut.json`: `ingest → transcribe → cut → captions (approve: true) → mix → chapters → assemble (params {preset:"youtube"}) → qa`.

- [ ] **Step 1: Failing tests** (fake steps)

```ts
test("runs steps in order and reports done", async () => {});
test("stops at the first fail", async () => {});
test("pauses after an approve step until approved", async () => {});
test("approval is invalidated when the step's inputs change", async () => {});
test("resume skips cached steps", async () => {});
test("CLI run maps --param step.key=value to that step", async () => {});
test("CLI exit 3 on awaiting approval names the review files", async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`; typecheck.
- [ ] **Step 5: Commit** `feat(workflow): runner with approvals and rough-cut workflow`

---

### Task 11: End-to-end on a real rush (controller + user)

- [ ] **Step 1:** User supplies a 10–20 min facecam (or the Marginol clip for a short smoke run).
- [ ] **Step 2:** `cli/bin/mostudio-bws new <slug>` then `cli/bin/mostudio-bws run rough-cut --project <p> --param ingest.source=<clip>`; time the user's own steps (G2: ≤ 30 min of user time).
- [ ] **Step 3:** At the captions pause, user reviews `captions/captions.txt`, adds fixes to `edits/replacements.txt`, re-runs, then `approve captions` and resumes.
- [ ] **Step 4:** Show `renders/final.mp4`, `renders/contact-sheet.jpg`, `renders/qa.md`, `chapters/youtube.txt`; user scores the rubric.
- [ ] **Step 5:** Record results and timings in `tasks/todo.md`, lessons in `tasks/lessons.md`, moskills evidence in `docs/moskills-value.md`; commit `docs: record first real rough cut`.
