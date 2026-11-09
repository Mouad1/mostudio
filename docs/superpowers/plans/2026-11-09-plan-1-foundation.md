# Plan 1 — Foundation (spikes, core, ingest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each module (S1, S2, core, ingest) is one moskills `modular-build` run with user acceptance before the next.

**Goal:** Prove the two risky assumptions (Darija speech-to-text, HyperFrames → ffmpeg assembly), then build the shared core and the first step module (`ingest`), runnable as `mostudio new|step|status`.

**Architecture:** One root package, Node 22 running TypeScript directly (type stripping), zero runtime dependencies, `node:test` for tests. Modules are folders: `core/` is shared; each `steps/<name>/` talks to core only through `core/src/index.ts` and to other steps only through files in the project folder.

**Tech Stack:** Node ≥ 22.18 (type stripping), TypeScript (typecheck only), node:test, ffmpeg/ffprobe, whisper.cpp (`whisper-cli`), Groq API, HyperFrames CLI (via npx, spike only).

**Spec:** `docs/superpowers/specs/2026-11-09-mostudio-design.md`

**Later plans:** Plan 2 rough-cut chain (transcribe, cut, captions, mix, assemble, qa, workflow runner, `rough-cut` workflow). Plan 3 reel chain (script, storyboard, voice, assets, scenes, `concept-reel`). Plan 4 learn + skill + export. Each is written after the previous plan's modules are accepted, using the spike results.

## Global Constraints

- License MIT; owner Mouad Belghiti. No copied third-party code or prose; ported tubemauto code is the user's own and gets a `docs/provenance.md` entry.
- Every new dependency needs user approval before install. Plan 1 asks for: `typescript`, `@types/node` (dev only).
- Keys only in `.env.local` (gitignored); never printed, logged, or written to the ledger.
- `billing: free-only` is the default; a provider flagged `commercial_ok: false` is never selected; a step with `private: true` never uses a provider flagged `trains_on_data: true`.
- Every step writes `steps/<step>.json` and a ledger entry with status `pass | warn | fail`, metrics, artifacts, provider + model used, timings.
- Steps are idempotent and cached by input hash; a step runs alone with `mostudio step <name> --project <dir>`.
- Project folder layout: `projects/<YYYY-MM-DD-slug>/{brief.md, storyboard.json, run.json, media/, cache/, scenes/, renders/, steps/}`.
- Imports use explicit `.ts` extensions; no `enum`, no `namespace`, no parameter properties (type stripping only erases syntax).
- External binaries are spawned with `shell: false` and argument arrays.
- Workflows are stored as JSON (`workflows/<name>.json`), not YAML, to keep zero runtime dependencies. (Builder's call; spec §4.4 updated.)

## Review Focus

1. Paths with spaces and accents (`Vidéo finale.mov`, project under `/Volumes/1TBT705CRUCIAL/…`) must work everywhere → test in Task 7 (ingest) and Task 5 (runStep).
2. A crash or Ctrl-C in the middle of a step must not corrupt `run.json`; the step re-runs next time → atomic-write test in Task 2.
3. Phone footage with rotation metadata reports displayed width/height, not stored ones (a vertical iPhone clip is 1080×1920, not 1920×1080) → test in Task 7.
4. All providers for a capability exhausted or missing keys → one clear error naming each provider and why (no key / exhausted until <time> / excluded by flag) → test in Task 4.
5. Quota reset across midnight Pacific including the DST change day → test in Task 4.

---

### Task 0: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `LICENSE`, `README.md`, `.env.example`, `docs/provenance.md`, `core/src/index.ts`, `tests/scaffold.test.ts`, `tests/boundaries.test.ts`
- Modify: `.gitignore`, `docs/superpowers/specs/2026-11-09-mostudio-design.md` (§4.4: workflows are JSON)

**Interfaces:**
- Produces: `npm test` → `node --test "**/*.test.ts"`; `npm run typecheck` → `tsc --noEmit`; `bin.mostudio` → `cli/bin/mostudio.ts` (file created in Task 6).

- [ ] **Step 1: Ask the user to approve dev dependencies `typescript` and `@types/node`.** Do not continue without a yes.
- [ ] **Step 2: Write `package.json`** — `"type": "module"`, `"engines": {"node": ">=22.18"}`, `"license": "MIT"`, scripts `test`, `typecheck` as above, no `dependencies` key.
- [ ] **Step 3: Write `tsconfig.json`** — `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `module: nodenext`, `target: es2023`, include `core cli steps spikes tests`.
- [ ] **Step 4: Update spec §4.4** so the workflow runner reads `workflows/<name>.json` (was `.yaml`), and record the reason (zero runtime dependencies) in spec §13.
- [ ] **Step 4b: `.gitignore` adds** `projects/`, `.env.local`, `**/cache/`, `spikes/**/media/`, `node_modules/`. `.env.example` lists `GROQ_API_KEY=`, `GEMINI_API_KEY=`, `WHISPER_CLI=whisper-cli`, `WHISPER_MODELS_DIR=/Volumes/1TBT705CRUCIAL/ai-cache/whisper` (models live on the external SSD); key values empty. Keys are stored in Bitwarden as source of truth and copied by the user into `.env.local`.
- [ ] **Step 5: Write failing tests**

```ts
// tests/scaffold.test.ts
test("package has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.dependencies, undefined);
});
// tests/boundaries.test.ts
test("steps import core only through core/src/index.ts", () => {
  // scan steps/**/src/*.ts: any import of "../../../core/..." must end with "core/src/index.ts";
  // any import of another steps/<x>/ folder fails
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 6: Run** `npm test` → both pass (boundaries passes with no steps yet). `npm run typecheck` → exit 0.
- [ ] **Step 7: `docs/provenance.md`** with a table header `| Part | Source | License | How used | Date |`. MIT `LICENSE` with "Copyright (c) 2026 Mouad Belghiti".
- [ ] **Step 8: Commit** `chore: scaffold zero-dependency TypeScript workspace`

---

### Task S1: Spike — speech-to-text on Darija/FR/EN

Throwaway spike except `core/src/metrics/wer.ts`, which later steps reuse.

**Files:**
- Create: `core/src/metrics/wer.ts`, `core/src/metrics/wer.test.ts`, `spikes/s1-stt/run.ts`, `spikes/s1-stt/README.md`, `spikes/s1-stt/report.md` (generated), `docs/adr/0001-stt-chain.md`
- Input from user (not committed): `spikes/s1-stt/media/<clip>.{mp4,m4a}` ×3 (1–2 min each: Darija-heavy, FR/Darija mix, EN/Darija mix) and `spikes/s1-stt/media/<clip>.ref.txt` (hand-corrected transcript, Darija in Latin script) and `<clip>.anchors.json` (10 words with true start time in seconds, marked by the user while listening)

**Interfaces:**
- Produces: `normalizeForWer(text: string): string[]` (lowercase, strip punctuation except digits, collapse spaces, keep 3/7/9 inside words); `wordErrorRate(reference: string, hypothesis: string): { wer: number; substitutions: number; deletions: number; insertions: number; refWords: number }`.

- [ ] **Step 1: Write failing tests for WER**

```ts
test("identical text has wer 0", () => assert.equal(wordErrorRate("salam 3likom", "salam 3likom").wer, 0));
test("digits inside Darija words are kept", () => assert.deepEqual(normalizeForWer("Wach 3ndek, l-9raya?"), ["wach", "3ndek", "l-9raya"]));
test("one substitution in four words is 0.25", () => assert.equal(wordErrorRate("ana ghadi l dar", "ana ghadi l bit").wer, 0.25));
test("empty hypothesis counts all deletions", () => assert.equal(wordErrorRate("a b c", "").deletions, 3));
```

- [ ] **Step 2: Run** `node --test core/src/metrics/wer.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `wer.ts` with word-level Levenshtein (dynamic programming, backtrack counts S/D/I).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Ask the user** for the 3 clips + reference files, a `GROQ_API_KEY` in `.env.local`, and approval to download `ggml-large-v3-turbo.bin` (~1.6 GB) and `ggml-large-v3.bin` (~3.1 GB) from the whisper.cpp Hugging Face repo into `WHISPER_MODELS_DIR`. (Done 2026-11-09: both models in `/Volumes/1TBT705CRUCIAL/ai-cache/whisper`.)
- [ ] **Step 6: Write `spikes/s1-stt/run.ts`** — for each clip × engine in `[groq:whisper-large-v3, whisper.cpp:large-v3, whisper.cpp:large-v3-turbo, whisper.cpp:base]`: extract 16 kHz mono WAV with ffmpeg; transcribe with word timestamps (whisper.cpp `-ojf` full JSON with token timings; Groq `response_format=verbose_json`, `timestamp_granularities[]=word`, language unset and also `fr`); compute WER vs `.ref.txt`; compute timestamp error = mean |predicted − true| over the 10 anchors (match by nearest normalized word); record runtime. Port the spawn/timeout pattern from tubemauto `packages/providers/src/whisper-cpp.ts` (user's code; add provenance row).
- [ ] **Step 7: Run** `node spikes/s1-stt/run.ts` → writes `report.md` with a table `clip | engine | language hint | WER | timestamp error ms | runtime s | script of output (latin/arabic/mixed)`.
- [ ] **Step 8: Write `docs/adr/0001-stt-chain.md`** (with a Mermaid diagram): chosen chain order, chosen language hint, whether a Latin-script normalization pass is needed, correction rule for captions. Decision rule: pick the lowest mean WER engine as primary if its timestamp error ≤ 150 ms; otherwise the lowest-timestamp-error engine with WER within 5 points.
- [ ] **Step 9: Show the user the report + ADR; get acceptance.**
- [ ] **Step 10: Commit** `feat(spike): measure STT engines on Darija clips; ADR 0001`

---

### Task S2: Spike — HyperFrames scene → clip → ffmpeg assembly

**Files:**
- Create: `spikes/s2-render/scene/index.html`, `spikes/s2-render/scene/hyperframes.json`, `spikes/s2-render/run.ts`, `spikes/s2-render/report.md` (generated), `docs/adr/0002-render-path.md`

**Interfaces:**
- Produces (knowledge for Plan 3): exact HyperFrames render command and flags that produce a 1080×1920 30 fps clip; measured render time; whether alpha/transparent clips are possible for overlays.

- [ ] **Step 1: Ask the user to approve** running `npx hyperframes` (fetches the package into the npx cache; HyperFrames is Apache 2.0).
- [ ] **Step 2: Write the scene** — 5 s, 1080×1920: title text that slides in over 0.4 s, a lower-third, background color #0a0a0a, accent #6366f1. Our own HTML/CSS, no copied blocks.
- [ ] **Step 3: Write `run.ts`** — (a) render the scene with `npx hyperframes render` to `renders/scene.mp4`, timing it; (b) generate a 5 s test voice with ffmpeg `sine` + a 10 s `testsrc2` talking-head stand-in; (c) ffmpeg: concat stand-in + scene clip, burn an ASS caption line, mix audio to −14 LUFS with `loudnorm`; (d) ffprobe the result.
- [ ] **Step 4: Run** `node spikes/s2-render/run.ts` → report lists: render time (s), output width×height, fps, duration, integrated LUFS, A/V start offset (ms).
- [ ] **Step 5: Expected:** 1080×1920, 30 fps, duration 15 s ± 0.1, LUFS −14 ± 1, A/V offset < 40 ms. If HyperFrames cannot render headless on this Mac, record it and the fallback (record with Playwright) in the ADR.
- [ ] **Step 6: Write `docs/adr/0002-render-path.md`** (Mermaid diagram) with the exact commands; get user acceptance.
- [ ] **Step 7: Commit** `feat(spike): prove HyperFrames scene to ffmpeg assembly; ADR 0002`

---

### Task 1: core — types and atomic JSON files

**Files:**
- Create: `core/src/types.ts`, `core/src/fs/atomic.ts`, `core/src/fs/atomic.test.ts`, `core/src/hash.ts`, `core/src/hash.test.ts`
- Modify: `core/src/index.ts` (re-export)

**Interfaces:**
- Produces:
  - `type StepStatus = "pass" | "warn" | "fail"`
  - `type MetricValue = number | string | boolean`
  - `type Metrics = Record<string, MetricValue>`
  - `type GateLevel = "warn" | "fail"`
  - `type Threshold = { metric: string; op: "<" | "<=" | ">" | ">=" | "==" | "between"; value: number | [number, number] | string | boolean; level: GateLevel }`
  - `type Verdict = { metric: string; actual: MetricValue | undefined; threshold: Threshold; ok: boolean }`
  - `type StepResult = { step: string; status: StepStatus; startedAt: string; endedAt: string; durationMs: number; inputsHash: string; metrics: Metrics; verdicts: Verdict[]; artifacts: string[]; provider?: { id: string; model: string }; quota?: Record<string, number>; error?: string }`
  - `writeJsonAtomic(path: string, data: unknown): Promise<void>`; `readJson<T>(path: string): Promise<T | undefined>` (undefined if missing)
  - `hashFiles(paths: string[], params: unknown): Promise<string>` (sha256 over sorted path names, file bytes streamed, and canonical JSON of params)

- [ ] **Step 1: Failing tests**

```ts
test("writeJsonAtomic leaves no partial file when the process dies mid-write", async () => {
  // write a big object, simulate failure by making rename throw (inject fs) → original file unchanged and no *.tmp left
});
test("readJson returns undefined for a missing file", async () => assert.equal(await readJson(join(dir, "nope.json")), undefined));
test("hashFiles changes when params change", async () => assert.notEqual(await hashFiles([f], { a: 1 }), await hashFiles([f], { a: 2 })));
test("hashFiles ignores param key order", async () => assert.equal(await hashFiles([f], { a: 1, b: 2 }), await hashFiles([f], { b: 2, a: 1 })));
```

- [ ] **Step 2: Run** `node --test core/src/` → FAIL.
- [ ] **Step 3: Implement** — atomic write = write `<path>.<pid>.tmp`, `fsync`, `rename`; accept an optional injected `fs` for the failure test. Canonical JSON = recursively sorted keys.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → 0.
- [ ] **Step 5: Commit** `feat(core): shared types, atomic JSON, input hashing`

---

### Task 2: core — project folder and run ledger

**Files:**
- Create: `core/src/project.ts`, `core/src/project.test.ts`, `core/src/ledger.ts`, `core/src/ledger.test.ts`, `schemas/run.schema.json`, `schemas/step-result.schema.json`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `readJson`, `StepResult` (Task 1).
- Produces:
  - `createProject(root: string, slug: string, opts?: { date?: Date; brief?: string }): Promise<string>` → returns `<root>/<YYYY-MM-DD>-<slug>`; creates `media/ cache/ scenes/ renders/ steps/` and `brief.md`; throws if slug is not `^[a-z0-9]+(?:-[a-z0-9]+)*$` or the folder exists.
  - `type Ledger = { version: 1; project: string; createdAt: string; steps: Record<string, StepResult[]> }` (history per step, newest last)
  - `readLedger(projectDir: string): Promise<Ledger>` (creates empty ledger if missing)
  - `recordStep(projectDir: string, result: StepResult): Promise<void>` → appends to ledger and writes `steps/<step>.json` (latest result), both atomically
  - `latest(ledger: Ledger, step: string): StepResult | undefined`

- [ ] **Step 1: Failing tests**

```ts
test("createProject builds the spec layout", async () => {
  const dir = await createProject(tmp, "darija-harness", { date: new Date("2026-11-09T10:00:00Z") });
  assert.equal(basename(dir), "2026-11-09-darija-harness");
  for (const d of ["media", "cache", "scenes", "renders", "steps"]) assert.ok(statSync(join(dir, d)).isDirectory());
});
test("createProject rejects bad slugs", async () => await assert.rejects(createProject(tmp, "Mon Projet")));
test("createProject works under a path with spaces and accents", async () => { /* root = join(tmp, "Vidéos à monter") */ });
test("recordStep keeps history and writes latest", async () => {
  await recordStep(dir, r1); await recordStep(dir, r2);
  assert.equal((await readLedger(dir)).steps.ingest.length, 2);
  assert.deepEqual(await readJson(join(dir, "steps/ingest.json")), r2);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Write the two JSON Schemas** matching the types (documentation for other agents; not validated at runtime in Plan 1).
- [ ] **Step 6: Commit** `feat(core): project folder and run ledger`

---

### Task 3: core — gate engine

**Files:**
- Create: `core/src/gate.ts`, `core/src/gate.test.ts`

**Interfaces:**
- Consumes: `Metrics`, `Threshold`, `Verdict`, `StepStatus` (Task 1).
- Produces: `evaluateGate(metrics: Metrics, thresholds: Threshold[]): { status: StepStatus; verdicts: Verdict[] }`; `mergeThresholds(base: Threshold[], overrides: Threshold[]): Threshold[]` (override replaces base entries with the same `metric` + `level`).

- [ ] **Step 1: Failing tests**

```ts
const lufs: Threshold = { metric: "integratedLufs", op: "between", value: [-15, -13], level: "fail" };
test("inside range passes", () => assert.equal(evaluateGate({ integratedLufs: -14.2 }, [lufs]).status, "pass"));
test("outside range fails", () => assert.equal(evaluateGate({ integratedLufs: -11 }, [lufs]).status, "fail"));
test("warn-only breach gives warn", () => assert.equal(evaluateGate({ readingSpeed: 19 }, [{ metric: "readingSpeed", op: "<=", value: 17, level: "warn" }]).status, "warn"));
test("a missing metric fails its threshold", () => assert.equal(evaluateGate({}, [lufs]).verdicts[0].ok, false));
test("fail wins over warn", () => { /* one warn breach + one fail breach → "fail" */ });
test("mergeThresholds overrides by metric+level", () => { /* override lufs fail range to [-16,-12] → single entry with new value */ });
```

- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(core): gate engine with pass/warn/fail`

---

### Task 4: core — config, secrets, provider registry, quotas

**Files:**
- Create: `core/src/config.ts`, `core/src/config.test.ts`, `core/src/providers/registry.ts`, `core/src/providers/registry.test.ts`, `core/src/providers/quota.ts`, `core/src/providers/quota.test.ts`, `providers.json`, `mostudio.config.json`

**Interfaces:**
- Produces:
  - `type Config = { billing: "free-only" | "allow-paid"; projectsRoot: string; home: string }` — `loadConfig(repoRoot: string, env = process.env): Promise<Config>`; `home` = `env.MOSTUDIO_HOME ?? ~/.mostudio`.
  - `loadEnvFile(path: string): Record<string, string>` (supports `KEY=value`, quotes, `#` comments, blank lines; no variable expansion).
  - `type Secret = { readonly name: string; reveal(): string }` whose `toString()` and `toJSON()` return `"[secret:<name>]"`; `getSecret(name: string, env: Record<string, string>): Secret | undefined`.
  - `type ProviderEntry = { id: string; capabilities: ("stt" | "llm" | "vision" | "tts" | "image" | "stock")[]; kind: "openai-compat" | "native" | "local"; baseUrl?: string; model: string; keyEnv?: string; limits: { rpm?: number; rpd?: number }; reset: { tz: "America/Los_Angeles" | "UTC" }; flags: { commercial_ok: boolean; trains_on_data: boolean; renewable: boolean }; priority: Record<string, number> }`
  - `type ProviderRegistry = { pick(capability: string, opts?: { private?: boolean; now?: Date }): Promise<ProviderEntry & { key?: Secret }>; recordUse(id: string, now?: Date): Promise<void>; markExhausted(id: string, now?: Date): Promise<void> }`
  - `createRegistry(entries: ProviderEntry[], env: Record<string, string>, quotaStorePath: string, billing: Config["billing"]): ProviderRegistry`
  - `class NoProviderError extends Error { reasons: { id: string; reason: "no-key" | "exhausted" | "excluded-flag" | "rate-limited"; until?: string }[] }`
  - `nextReset(tz: "America/Los_Angeles" | "UTC", now: Date): Date`
- `providers.json` seeded with spec §5b chains: groq (stt+llm), cloudflare (stt+image), whisper-cpp (stt, local, no key), gemini (llm+vision+tts+image), zai (llm+vision), openrouter (llm), nvidia (llm, `renewable: false`, lowest priority), mistral (llm, `trains_on_data: true`), pexels/pixabay (stock). Cohere omitted (non-commercial). Limits from the user's Oct 2026 list (Groq Whisper rpm 20 / rpd 2000; OpenRouter `:free` rpm 20 / rpd 50; Cloudflare reset UTC; Gemini reset Pacific).

Behavior of `pick`: candidates with the capability, sorted by `priority[capability]` (lower first); skip if `commercial_ok` false; skip if `private` and `trains_on_data`; skip if `keyEnv` set and key missing; skip if `rpd` reached since last reset or exhausted-until in the future; skip if `rpm` reached in the last 60 s; first remaining wins; none → `NoProviderError` with one reason per candidate. Quota store is a JSON file in `config.home` written atomically.

- [ ] **Step 1: Failing tests**

```ts
test("env file parses quotes and comments", () => assert.deepEqual(loadEnvFile(f), { A: "x y", B: "z" }));
test("secret never serializes its value", () => assert.equal(JSON.stringify({ k: getSecret("GROQ_API_KEY", { GROQ_API_KEY: "abc" }) }), '{"k":"[secret:GROQ_API_KEY]"}'));
test("picks highest priority with key", async () => assert.equal((await reg.pick("stt")).id, "groq"));
test("skips provider without key", async () => { /* no GROQ key → cloudflare or whisper-cpp */ });
test("private step skips trains_on_data", async () => { /* only mistral has llm quota → NoProviderError with excluded-flag */ });
test("daily limit exhausts then resets at next midnight Pacific", async () => { /* 2000 recordUse → skip; now = next day 00:01 PT → picked again */ });
test("nextReset handles the DST change day", () => assert.equal(nextReset("America/Los_Angeles", new Date("2026-11-01T12:00:00Z")).toISOString(), "2026-11-02T08:00:00.000Z"));
test("all exhausted gives one reason per provider", async () => { /* error.reasons.length === candidates */ });
test("markExhausted skips provider until reset", async () => {});
```

- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(core): config, secrets, provider registry with free-tier quotas`

---

### Task 5: core — step contract and single-step runner

**Files:**
- Create: `core/src/step.ts`, `core/src/step.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `type StepContract = { name: string; inputs: string[]; outputs: string[]; params?: Record<string, "string" | "number" | "boolean">; fileParams?: string[]; gate: Threshold[]; private?: boolean }` (paths relative to the project folder; inputs may use a glob only of the form `media/*`; `fileParams` names params that hold absolute file paths: they must exist and their bytes are part of the input hash)
  - `type StepContext = { projectDir: string; params: Record<string, unknown>; config: Config; providers: ProviderRegistry; log: (msg: string) => void }` (`Config`, `ProviderRegistry` from Task 4)
  - `type StepOutput = { metrics: Metrics; artifacts: string[]; provider?: { id: string; model: string }; quota?: Record<string, number> }`
  - `type StepModule = { contract: StepContract; run: (ctx: StepContext) => Promise<StepOutput> }`
  - `runStep(projectDir: string, mod: StepModule, opts: { params?: Record<string, unknown>; gateOverrides?: Threshold[]; force?: boolean; config: Config; providers: ProviderRegistry }): Promise<StepResult & { cached: boolean }>`

Behavior: validate params types, that every declared input exists and every `fileParams` file exists (else `fail` with `error`); compute `inputsHash`; if latest result for this step has the same hash and status `pass|warn` and all outputs exist and not `force` → return it with `cached: true`; else run, check every declared output exists (missing → `fail`), evaluate gate, `recordStep`, return. A thrown error is recorded as `fail` with `error` message (never with secrets).

- [ ] **Step 1: Failing tests** (fake step module that writes `renders/out.txt` and returns `{ metrics: { n: 3 } }`)

```ts
test("runs, gates, records", async () => { const r = await runStep(dir, fake, base); assert.equal(r.status, "pass"); assert.equal(r.cached, false); });
test("second run with same inputs is cached", async () => { await runStep(dir, fake, base); assert.equal((await runStep(dir, fake, base)).cached, true); });
test("changed fileParams file invalidates cache", async () => { /* step with fileParams ["source"]; edit the source file → cached false */ });
test("changed input file invalidates cache", async () => { /* edit media/in.txt → cached false */ });
test("missing declared output fails", async () => { /* step that writes nothing → status fail, error mentions renders/out.txt */ });
test("thrown error is recorded as fail", async () => { /* run throws → status fail, ledger has error */ });
test("missing input fails before running", async () => { /* run() spy not called */ });
test("works when projectDir contains spaces and accents", async () => {});
```

- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(core): step contract and cached single-step runner`

---

### Task 6: CLI — `new`, `step`, `status`

**Files:**
- Create: `cli/bin/mostudio.ts`, `cli/src/main.ts`, `cli/src/main.test.ts`, `steps/index.ts` (step registry: name → `StepModule`)

**Interfaces:**
- Consumes: `createProject`, `readLedger`, `latest`, `runStep`, `loadConfig`, `createRegistry` (Tasks 2–5).
- Produces:
  - `main(argv: string[], io: { stdout: (s: string) => void; stderr: (s: string) => void; cwd: string; env: Record<string, string> }): Promise<number>` (exit code)
  - Commands: `mostudio new <slug> [--brief <file>]` → prints project path; `mostudio step <name> --project <dir> [--param k=v]… [--force] [--json]` → prints status line `ingest  pass  1.2s  duration=62.4 fps=30 …` or JSON StepResult; exit 0 on pass/warn, 2 on fail; `mostudio status --project <dir> [--json]` → one line per step (latest result) with metrics; unknown command → usage, exit 64.
  - `cli/bin/mostudio.ts` starts with `#!/usr/bin/env node` and calls `main(process.argv.slice(2), …)`.

- [ ] **Step 1: Failing tests** (call `main` with captured io; fake step registered for tests)

```ts
test("new creates a project and prints its path", async () => { assert.equal(await main(["new", "demo"], io), 0); assert.match(out(), /\d{4}-\d{2}-\d{2}-demo$/m); });
test("step returns 2 on fail", async () => assert.equal(await main(["step", "fake-fail", "--project", dir], io), 2));
test("status --json lists latest results", async () => { /* parse JSON, has key "fake" with status */ });
test("unknown command prints usage and exits 64", async () => assert.equal(await main(["dance"], io), 64));
test("output never contains a secret value", async () => { /* env GROQ_API_KEY=sekret → out() and err() never include "sekret" */ });
```

- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Manual check:** `node cli/bin/mostudio.ts new smoke-test` then `node cli/bin/mostudio.ts status --project <printed path>` → prints "no steps yet".
- [ ] **Step 6: Commit** `feat(cli): new, step and status commands`
- [ ] **Step 7: Module gate (core):** moskills gatekeeper on Tasks 1–6, show the user `npm test` output and the manual check; get acceptance.

---

### Task 7: Step module — `ingest`

**Files:**
- Create: `steps/ingest/contract.json`, `steps/ingest/src/ingest.ts`, `steps/ingest/src/probe.ts`, `steps/ingest/tests/ingest.test.ts`, `steps/ingest/tests/fixtures.ts`, `steps/ingest/README.md`
- Modify: `steps/index.ts` (register `ingest`), `docs/provenance.md` (ffmpeg spawn pattern from tubemauto `packages/media/src/ffmpeg.ts`)

**Interfaces:**
- Consumes: `StepModule`, `StepContext`, `StepOutput` (Task 5) via `core/src/index.ts`.
- Produces:
  - `probe(file: string): Promise<{ durationSec: number; fps: number; width: number; height: number; rotation: number; hasAudio: boolean; audioChannels: number; videoCodec: string; audioCodec?: string }>` (width/height are **displayed** dimensions after rotation)
  - Contract: inputs `[]`; `fileParams: ["source"]`; outputs `media/ingest.json`; params `{ source: "string" }` (absolute path to the user's file; copied into `media/` with its original name, not moved); gate: `hasAudio == true` (fail), `durationSec > 0` (fail).
  - Metrics: `durationSec`, `fps`, `width`, `height`, `rotation`, `hasAudio`, `sha256`, `sizeMB`.
  - `media/ingest.json` = `{ file: "media/<name>", ...probe, sha256 }` — the input later steps read.

- [ ] **Step 1: Fixture generator** `fixtures.ts`: `makeClip(dir, { seconds, width, height, audio: boolean, rotation?: 90, name? }): Promise<string>` using `ffmpeg -f lavfi testsrc2` + `sine`, rotation via `-display_rotation` (or `-metadata:s:v rotate=90` if the ffmpeg build lacks it). No binary fixtures committed.
- [ ] **Step 2: Failing tests**

```ts
test("probes a 3 s 1920x1080 clip with audio", async () => { const r = await runStep(dir, ingest, { params: { source: clip } , ...base }); assert.equal(r.status, "pass"); assert.equal(r.metrics.width, 1920); assert.ok(Math.abs((r.metrics.durationSec as number) - 3) < 0.1); });
test("clip without audio fails the gate", async () => assert.equal((await runStep(dir, ingest, noAudio)).status, "fail"));
test("rotated phone clip reports displayed size 1080x1920", async () => { /* stored 1920x1080, rotation 90 → width 1080, height 1920 */ });
test("source path with spaces and accents works", async () => { /* name "Vidéo finale.mov" */ });
test("re-run with same source is cached", async () => {});
test("source file is copied, original untouched", async () => {});
```

- [ ] **Step 3: Run** `node --test steps/ingest/` → FAIL.
- [ ] **Step 4: Implement** `probe` with `ffprobe -v error -print_format json -show_streams -show_format`; rotation from `side_data_list[].rotation` or `tags.rotate`; fps from `avg_frame_rate`; sha256 streamed.
- [ ] **Step 5: Run** → PASS; `npm test` all green; `npm run typecheck` → 0.
- [ ] **Step 6: `README.md`** for the module: what it does, inputs/outputs, metrics, gate, example `mostudio step ingest --project <dir> --param source=/path/clip.mov`.
- [ ] **Step 7: Manual check on a real phone clip** from the user: `mostudio step ingest …` then `mostudio status` → metrics shown.
- [ ] **Step 8: Commit** `feat(ingest): probe and import media with gate`
- [ ] **Step 9: Module gate (ingest):** gatekeeper + user acceptance. Update `tasks/todo.md` Modules list and `docs/moskills-value.md` evidence log.
