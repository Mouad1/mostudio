# Plan 3 — Guided setup + local dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User rule: every `git commit` step needs the user's go-ahead first; each Part ships on its own branch.

**Goal:** A person who just installed mostudio runs `mostudio init` to get their own folders, a system check and their API keys set up, then runs `mostudio ui` to drop inspirations into the right folders, upload a video, watch every pipeline step live with its output, approve steps by hand or let the run go end to end, try single tools, and manage their keys.

**Architecture:** Two front doors on top of the existing engine. (1) `mostudio init`: a terminal wizard that scaffolds a *workspace* (the folder holding `mostudio.config.json`, `projects/`, `inspiration/`, `.env.local`), checks binaries and writes keys. (2) `mostudio ui`: a `node:http` server bound to 127.0.0.1, guarded by a per-launch token, exposing a JSON API, Server-Sent Events for live runs, streamed uploads and Range file serving; the browser app is plain TypeScript modules served after `module.stripTypeScriptTypes` (no bundler, no dependency). Runs go through the existing `runWorkflow`/`runStep`; "Auto E2E" is a new `autoApprove` option on `runWorkflow` (also exposed as `mostudio run --auto`).

**Tech Stack:** Node ≥ 22.18 (type stripping, `node:http`, `node:module.stripTypeScriptTypes`, global `fetch`), node:test, vanilla DOM + `EventSource` + `XMLHttpRequest` (upload progress) + Web Audio (waveform) in the browser. No new dependencies.

**Spec:** this plan's *Requirements* section (user request of 2026-11-13, no separate spec doc). Base design: `docs/superpowers/specs/2026-11-09-mostudio-design.md` (§3 constraints, §4.3 project folder, §4.5 layout). Prior plans: `docs/superpowers/plans/2026-11-09-plan-1-foundation.md`, `docs/superpowers/plans/2026-11-10-plan-2-rough-cut.md`.

## Requirements (from the user, condensed)

- R1 After installing, the user follows on-screen indications that create *their* folders, which the app then reads (`mostudio init`).
- R2 Dashboard: see where each kind of inspiration goes and upload it so it lands in the right folder.
- R3 Upload a video and watch the work live, step by step, with each step's output.
- R4 Choose per run: validate steps by hand, or auto creation that bypasses step validation and goes end to end.
- R5 See available tools and apply a specific one.
- R6 Settings page for BYOK keys, with a per-provider connection test.

Name mapping: the request says `edits`; the real step is `cut` (silence/filler/retake removal → `cut/edl.json`). Real chains: `short` = ingest → transcribe → cut → localize → captions(approve) → mix → assemble → qa; `rough-cut` adds chapters before assemble.

"Bypass step validation" means **human approval gates** (`"approve": true`). Metric gates (`level: "fail"`) still stop an auto run: a failed step never produces a "final" video silently. The UI says so next to the toggle.

## Global Constraints

- Node `>=22.18`; zero runtime dependencies; no new dev dependency. Plan 3 needs none.
- Steps import core only through `core/src/index.ts`; `dashboard/src` imports core only through `core/src/index.ts` and steps only through `steps/index.ts`.
- Keys live only in `<workspace>/.env.local` (mode `0o600`, gitignored); never logged, never in URLs we build except Pixabay's required `key=` query (redacted in every message); masked in API responses unless the user clicks Reveal.
- Server listens on `127.0.0.1` only. Default port `4317`. Every `/api/*` call needs the launch token (`x-mostudio-token` header or `t` query param); `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; a present `Origin` must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- Uploads stream to disk (never buffered whole in memory) via a temp file + rename (`writeOutputAtomic`).
- Precedence of env stays as the CLI does it: process env wins over `.env.local` (so `mostudio-bws` keeps working). Env is re-read from disk for every run so saved keys apply without restart.
- Inspiration media stays local and gitignored (`inspiration/**/media/`) and is never reused in outputs (CLAUDE.md constraint 5).
- UI copy in English, sentence case. Frontend tasks end with an `impeccable` audit (user rule).
- Every step contract stays unchanged; `approvals.json`, `workflow-params.json`, `run.json` shapes stay unchanged.
- Branches: Part A `feat/init-wizard` (Tasks 1–6), Part B `feat/dashboard-server` (Tasks 7–15), Part C `feat/dashboard-ui` (Tasks 16–23). Start Part A from `main` after `feat/darija-caption-lang` is merged (it has uncommitted work today).

## Review Focus

1. A web page on another site (or a DNS-rebinding host) calls `http://127.0.0.1:4317/api/settings/reveal` → must get 401/403, never a key → tests in Task 7.
2. A 4 GB upload whose browser tab is closed halfway → no partial file in `uploads/`, memory flat → abort test in Task 10.
3. Refreshing the page or opening a second tab mid-run → sees the steps already done (event replay) and cannot start a second run on the same project (409) → tests in Tasks 11 and 12.
4. Dashboard killed while `transcribe` was running → reopening shows the step as interrupted (leftover `steps/<step>.running`), not "running forever" → test in Task 10.
5. Saving one key from Settings on a hand-edited `.env.local` (comments, quotes, `export`, unknown keys, a value with `#` or spaces) → every other line survives byte-for-byte and the new value round-trips through `loadEnvFile` → tests in Task 1.

## File map

| File | Responsibility |
|---|---|
| `core/src/envfile.ts` | `updateEnvFile`, `maskSecret`, `formatEnvValue` |
| `core/src/workspace.ts` | `findWorkspace`, `PACKAGE_ROOT`, `resolveShared`, `loadProvidersFile` |
| `core/src/config.ts` (mod) | `Config.inspirationRoot` |
| `core/src/workflow.ts` (mod) | `autoApprove`, `onStepStart`, `onApprove` options |
| `cli/src/system.ts` | `checkSystem` dependency probe + fix hints |
| `cli/src/scaffold.ts` | `scaffoldWorkspace` (idempotent folders + indications) |
| `cli/src/prompt.ts` | `Prompt` type, `createTtyPrompt`, `defaultsPrompt` |
| `cli/src/init.ts` | `runInit` wizard |
| `cli/src/main.ts` (mod) | `init`, `ui`/`dashboard`, `run --auto`, workspace resolution |
| `dashboard/src/types.ts` | API/event types shared with the browser |
| `dashboard/src/http.ts` | `matchRoute`, `Router`, `sendJson`, `readJsonBody`, `checkAccess` |
| `dashboard/src/static.ts` | `serveWeb` (TS stripping + cache), `serveFile` (Range), `contentType` |
| `dashboard/src/files.ts` | `safeFileName`, `uniquePath`, `saveStream`, `insideDir` |
| `dashboard/src/inspiration.ts` | links.txt edit functions, `classifyLink`, `routeInspirationFile` |
| `dashboard/src/jobs.ts` | `JobManager` (one job per project, event log, subscribers) |
| `dashboard/src/catalog.ts` + `knobs.ts` | tools catalog from contracts + param metadata |
| `dashboard/src/settings.ts` + `probes.ts` | settings schema/read/write, connection tests |
| `dashboard/src/routes/*.ts` | route registration per area |
| `dashboard/src/server.ts` | `startDashboard` |
| `dashboard/web/**` | browser app (index.html, styles.css, app.ts, lib/, views/) |

---

## Part A — Workspace and `mostudio init` (branch `feat/init-wizard`)

### Task 1: core — `.env.local` writer and secret masking

**Files:**
- Create: `core/src/envfile.ts`, `core/src/envfile.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `loadEnvFile(path)` from `core/src/config.ts` (reader, unchanged).
- Produces:
  - `updateEnvFile(path: string, updates: Record<string, string | null>): Promise<void>` — `null` or `""` removes the key.
  - `formatEnvValue(value: string): string`
  - `maskSecret(value: string): string`

- [ ] **Step 1: Write the failing tests** in `core/src/envfile.test.ts`

```ts
test("updateEnvFile replaces in place and keeps every other line byte-for-byte", async () => {
  const p = tmpFile("# keys\nexport GROQ_API_KEY=old # mine\nOTHER='x y'\n\nZZZ=1\n");
  await updateEnvFile(p, { GROQ_API_KEY: "gsk_new" });
  assert.equal(readFileSync(p, "utf8"), "# keys\nGROQ_API_KEY=gsk_new\nOTHER='x y'\n\nZZZ=1\n");
});
test("appends new keys at the end with one trailing newline", async () => {
  const p = tmpFile("A=1"); // no trailing newline
  await updateEnvFile(p, { B: "2" });
  assert.equal(readFileSync(p, "utf8"), "A=1\nB=2\n");
});
test("null and empty string remove the key line", async () => {
  const p = tmpFile("A=1\nB=2\n");
  await updateEnvFile(p, { A: null, B: "" });
  assert.equal(readFileSync(p, "utf8"), "");
});
test("values with spaces, # or quotes round-trip through loadEnvFile", async () => {
  const p = tmpFile("");
  const tricky = { S: "a b", H: "pa#ss", Q: `say "x"`, A: "it's", E: "=lead" };
  await updateEnvFile(p, tricky);
  assert.deepEqual(loadEnvFile(p), tricky);
});
test("creates a missing file with mode 0600", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "env-")), ".env.local");
  await updateEnvFile(p, { A: "1" });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});
test("rejects invalid key names and newlines in values", async () => {
  const p = tmpFile("");
  await assert.rejects(updateEnvFile(p, { "BAD-NAME": "1" }), /invalid env name/);
  await assert.rejects(updateEnvFile(p, { A: "x\ny" }), /newline/);
  await assert.rejects(updateEnvFile(p, { A: `it's "x"` }), /both quote kinds/);
});
test("maskSecret", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("short123"), "••••");          // <= 8 chars
  assert.equal(maskSecret("gsk_abcdefgh1234"), "gsk…1234"); // first 3 + … + last 4
});
```

- [ ] **Step 2: Run to verify failure** — `node --test core/src/envfile.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `core/src/envfile.ts`**

Rules the tests pin: a line "owns" key K when it matches the same regex as `loadEnvFile` (`/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/`); the first owning line is rewritten as `K=<formatEnvValue(v)>` (the `export` prefix and inline comment are dropped), later duplicates are removed; removals delete owning lines; new keys are appended in insertion order. `formatEnvValue`: bare when it matches `/^[A-Za-z0-9_./:@+,-]*$/` (and not empty-after-trim issues), else single-quoted when it has no `'`, else double-quoted when it has no `"`, else throw `cannot store value with both quote kinds`. Names must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (`invalid env name: X`), values must not contain `\n`/`\r` (`newline in value of X`). Write with `writeFile(tmp, text, { mode: 0o600 })` + `chmod(path,0o600)` after rename (tmp `<path>.<pid>.tmp`, rename). Output ends with exactly one `\n` unless empty.

- [ ] **Step 4: Export** `updateEnvFile, formatEnvValue, maskSecret` from `core/src/index.ts`.

- [ ] **Step 5: Run** `node --test core/src/envfile.test.ts && npm run typecheck` → all PASS.

- [ ] **Step 6: Commit** (after user OK)

```bash
git add core/src/envfile.ts core/src/envfile.test.ts core/src/index.ts
git commit -m "feat(core): .env.local writer that keeps hand edits, secret masking"
```

### Task 2: core — workspace resolution and `inspirationRoot`

**Files:**
- Create: `core/src/workspace.ts`, `core/src/workspace.test.ts`
- Modify: `core/src/config.ts` (+ `core/src/config.test.ts`), `core/src/index.ts`, `cli/src/main.ts` (`rootOf`, `loadProviders`, `listWorkflows`, workflow reads)

**Interfaces:**
- Produces:
  - `PACKAGE_ROOT: string` — repo/package dir (`resolve(import.meta.dirname, "..", "..")`).
  - `findWorkspace(start: string): string | undefined` — nearest ancestor (inclusive) holding `mostudio.config.json`.
  - `resolveShared(root: string, rel: string): string` — `join(root, rel)` when it exists, else `join(PACKAGE_ROOT, rel)` (for `providers.json`, `workflows`).
  - `loadProvidersFile(root: string): Promise<ProviderEntry[]>` — moved from `cli/src/main.ts#loadProviders`, same error texts, reads `resolveShared(root, "providers.json")`.
  - `Config.inspirationRoot: string` — absolute; `mostudio.config.json` key `inspirationRoot`, default `"inspiration"`; non-string → `mostudio.config.json: inspirationRoot must be a string`.
  - `rootOf(io)` new order: `io.root` → `MOSTUDIO_ROOT` → `findWorkspace(io.cwd)` → `PACKAGE_ROOT`.

- [ ] **Step 1: Write failing tests**

```ts
// core/src/workspace.test.ts
test("findWorkspace walks up to the folder with mostudio.config.json", () => {
  const ws = tmpDir(); writeFileSync(join(ws, "mostudio.config.json"), "{}");
  mkdirSync(join(ws, "projects", "a"), { recursive: true });
  assert.equal(findWorkspace(join(ws, "projects", "a")), ws);
  assert.equal(findWorkspace(tmpDir()), undefined);
});
test("resolveShared prefers the workspace copy, falls back to the package", () => {
  const ws = tmpDir();
  assert.equal(resolveShared(ws, "providers.json"), join(PACKAGE_ROOT, "providers.json"));
  writeFileSync(join(ws, "providers.json"), "[]");
  assert.equal(resolveShared(ws, "providers.json"), join(ws, "providers.json"));
});
test("loadProvidersFile reads the package providers.json for an empty workspace", async () => {
  const entries = await loadProvidersFile(tmpDir());
  assert.ok(entries.some((e) => e.id === "groq"));
});
// core/src/config.test.ts (add)
test("inspirationRoot defaults to <root>/inspiration and resolves relative paths", async () => {
  const ws = tmpDir(); writeFileSync(join(ws, "mostudio.config.json"), "{}");
  assert.equal((await loadConfig(ws, {})).inspirationRoot, join(ws, "inspiration"));
  writeFileSync(join(ws, "mostudio.config.json"), JSON.stringify({ inspirationRoot: "refs" }));
  assert.equal((await loadConfig(ws, {})).inspirationRoot, join(ws, "refs"));
});
// cli/src/main.test.ts (add)
test("run finds workflows in the package when the workspace has none", async () => { /* temp workspace without workflows/: `run short` reaches the project check, not "unknown workflow" */ });
```

- [ ] **Step 2: Run** `node --test core/src/workspace.test.ts core/src/config.test.ts cli/src/main.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement** `core/src/workspace.ts`, extend `loadConfig`, rewire `cli/src/main.ts` (`listWorkflows` reads `resolveShared(root,"workflows")`; `rootOf` per order above; delete local `loadProviders`).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS (existing CLI tests unchanged: they pass `io.root`).
- [ ] **Step 5: Commit** `feat(core): workspace lookup, package fallback for providers and workflows`

### Task 3: cli — system check with fix hints

**Files:**
- Create: `cli/src/system.ts`, `cli/src/system.test.ts`

**Interfaces:**
- Consumes: `resolveBin`, `runBin` (core).
- Produces:
  ```ts
  export type Check = { name: "node" | "ffmpeg" | "ffprobe" | "libass" | "whisper-cli" | "whisper-models";
    ok: boolean; required: boolean; detail: string; fix?: string };
  export type SystemDeps = { nodeVersion: string; platform: NodeJS.Platform;
    run: (bin: string, args: string[]) => Promise<string>; exists: (path: string) => boolean;
    listDir: (path: string) => string[] };
  export function checkSystem(env: Record<string, string | undefined>, deps?: Partial<SystemDeps>): Promise<Check[]>;
  export function versionAtLeast(actual: string, min: string): boolean;
  ```
  Order of result: node, ffmpeg, ffprobe, libass, whisper-cli, whisper-models. Required: node, ffmpeg, ffprobe. Probes: `<bin> -version` (first line → `detail`), libass = `ffmpeg -hide_banner -filters` contains ` ass ` (detail when missing: `captions burn needs libass; HyperFrames captions still work`), whisper-cli `--help`, models = `WHISPER_MODELS_DIR` has a `ggml-*.bin`.
  Fix hints: darwin `brew install ffmpeg` / libass `brew install ffmpeg-full` / whisper `brew install whisper-cpp`; linux `sudo apt install ffmpeg` / whisper `see https://github.com/ggml-org/whisper.cpp`; win32 `winget install Gyan.FFmpeg`. Node: `install Node 22.18 or newer (https://nodejs.org)`. Models: `download ggml-large-v3.bin into WHISPER_MODELS_DIR`.

- [ ] **Step 1: Write failing tests**

```ts
test("versionAtLeast", () => {
  assert.equal(versionAtLeast("v22.18.0", "22.18"), true);
  assert.equal(versionAtLeast("v22.9.1", "22.18"), false);
  assert.equal(versionAtLeast("v24.0.0", "22.18"), true);
});
test("missing ffmpeg is a required failure with the platform's fix", async () => {
  const checks = await checkSystem({}, { nodeVersion: "v22.18.0", platform: "darwin",
    run: async (bin) => { if (bin === "ffmpeg") throw new Error("ffmpeg not found"); return "x version 1"; },
    exists: () => false, listDir: () => [] });
  const ff = checks.find((c) => c.name === "ffmpeg")!;
  assert.deepEqual([ff.ok, ff.required, ff.fix], [false, true, "brew install ffmpeg"]);
  assert.deepEqual(checks.map((c) => c.name), ["node", "ffmpeg", "ffprobe", "libass", "whisper-cli", "whisper-models"]);
});
test("whisper is optional; FFMPEG env override is the probed binary", async () => {
  const seen: string[] = [];
  const checks = await checkSystem({ FFMPEG: "/opt/ff" }, { nodeVersion: "v22.18.0", platform: "linux",
    run: async (bin, args) => { seen.push(bin); if (bin === "whisper-cli") throw new Error("nope");
      return args.includes("-filters") ? " ass  V->V  Render ASS" : "ffmpeg version 7"; },
    exists: () => false, listDir: () => [] });
  assert.ok(seen.includes("/opt/ff"));
  assert.equal(checks.find((c) => c.name === "whisper-cli")!.required, false);
  assert.equal(checks.find((c) => c.name === "libass")!.ok, true);
});
```

- [ ] **Step 2: Run** `node --test cli/src/system.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cli/src/system.ts` (default deps: `process.version`, `process.platform`, `runBin` with 15 s timeout, `existsSync`, `readdirSync` guarded).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): system check for node, ffmpeg, libass, whisper with fix hints`

### Task 4: cli — workspace scaffold with on-disk indications

**Files:**
- Create: `cli/src/scaffold.ts`, `cli/src/scaffold.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScaffoldEntry = { path: string; status: "created" | "kept"; purpose: string };
  export function scaffoldWorkspace(dir: string): Promise<ScaffoldEntry[]>;
  ```
  Creates (only when absent; never overwrites), in this order, with these `purpose` strings:
  | path | purpose |
  |---|---|
  | `mostudio.config.json` (`{"billing":"free-only","projectsRoot":"projects","inspirationRoot":"inspiration"}`) | `settings for this workspace` |
  | `projects/README.md` | `your video projects (one folder per video)` |
  | `inspiration/shorts/links.txt`, `inspiration/shorts/media/`, `inspiration/shorts/README.md` | `vertical references: Reels, Shorts, TikToks` |
  | `inspiration/long/links.txt`, `inspiration/long/media/`, `inspiration/long/README.md` | `landscape references: YouTube, podcasts` |
  | `examples/README.md` (copy of `PACKAGE_ROOT/examples/README.md`) | `how projects are laid out` |
  | `.gitignore` | `keeps keys, footage and renders out of git` |
  `.gitignore` when present gets only missing lines appended from: `.env.local`, `projects/`, `inspiration/**/media/`, `*.mp4`, `*.mov` (status `kept` if nothing was missing).
  `links.txt` header lines (exact, per kind): shorts `# Shorts I like: one URL per line. Add a note after the URL with " # ". Lines starting with # are notes.`; long `# Long videos I like: one URL per line. Add a note after the URL with " # ". Lines starting with # are notes.`
  `inspiration/<kind>/README.md` body (exact, `<Kind>` = `Shorts`/`Long videos`):
  ```
  # <Kind> inspiration

  - Links: add one per line to links.txt (or drop them in the dashboard, Inspiration tab).
  - Clips and screenshots: put them in media/. They stay on this computer, are never committed and never reused in your videos.
  - Notes: any .md or .txt file next to links.txt (hook ideas, pacing, style).
  ```
  `projects/README.md`: `# Projects\n\nOne folder per video. Create one with \`mostudio new <slug>\` or from the dashboard (Studio tab). Your raw footage is copied into <project>/media/ when the run starts.\n`

- [ ] **Step 1: Write failing tests**

```ts
test("scaffold creates every folder and file once", async () => {
  const ws = tmpDir();
  const first = await scaffoldWorkspace(ws);
  assert.ok(first.every((e) => e.status === "created"));
  assert.ok(existsSync(join(ws, "inspiration/shorts/media")));
  assert.match(readFileSync(join(ws, "inspiration/long/links.txt"), "utf8"), /^# Long videos I like/);
  const second = await scaffoldWorkspace(ws);
  assert.ok(second.every((e) => e.status === "kept"));
});
test("existing links.txt and config are never overwritten", async () => {
  const ws = tmpDir(); mkdirSync(join(ws, "inspiration/shorts"), { recursive: true });
  writeFileSync(join(ws, "inspiration/shorts/links.txt"), "https://x.test/a\n");
  writeFileSync(join(ws, "mostudio.config.json"), '{"billing":"allow-paid"}');
  await scaffoldWorkspace(ws);
  assert.equal(readFileSync(join(ws, "inspiration/shorts/links.txt"), "utf8"), "https://x.test/a\n");
  assert.equal(readFileSync(join(ws, "mostudio.config.json"), "utf8"), '{"billing":"allow-paid"}');
});
test(".gitignore gets only the missing lines", async () => {
  const ws = tmpDir(); writeFileSync(join(ws, ".gitignore"), "node_modules/\n.env.local\n");
  await scaffoldWorkspace(ws);
  const lines = readFileSync(join(ws, ".gitignore"), "utf8").trim().split("\n");
  assert.equal(lines.filter((l) => l === ".env.local").length, 1);
  assert.ok(lines.includes("projects/") && lines.includes("inspiration/**/media/"));
});
```

- [ ] **Step 2: Run** `node --test cli/src/scaffold.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cli/src/scaffold.ts` (`writeFile(path, text, { flag: "wx" })` and treat `EEXIST` as `kept`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): scaffold a user workspace with folder indications`

### Task 5: cli — `mostudio init` wizard

**Files:**
- Create: `cli/src/prompt.ts`, `cli/src/init.ts`, `cli/src/init.test.ts`
- Modify: `cli/src/main.ts` (command, `--dir`, `--yes`, `Io.prompt`, USAGE, no-workspace hint), `cli/bin/mostudio.ts` (pass TTY prompt)

**Interfaces:**
- Consumes: `scaffoldWorkspace` (Task 4), `checkSystem` (Task 3), `updateEnvFile`, `maskSecret`, `loadEnvFile`, `loadProvidersFile` (Tasks 1–2).
- Produces:
  ```ts
  // cli/src/prompt.ts
  export type Prompt = { ask(q: string, def?: string): Promise<string>; secret(q: string): Promise<string>;
    confirm(q: string, def: boolean): Promise<boolean>; close(): void };
  export function createTtyPrompt(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Prompt; // secret(): raw mode, echoes "•"
  export function defaultsPrompt(): Prompt; // ask → def ?? "", secret → "", confirm → def
  // cli/src/init.ts
  export type InitOptions = { dir: string; prompt: Prompt; out: (s: string) => void; env: Record<string, string>;
    system?: Parameters<typeof checkSystem>[1] };
  export function runInit(opts: InitOptions): Promise<number>; // 0 always unless a write fails (then throw)
  // cli/src/main.ts
  Io.prompt?: Prompt   // absent or --yes → defaultsPrompt()
  ```
  Flow and exact headings: `mostudio init: set up your workspace` → `1/3 Folders in <dir>` (one line per entry: `  + <path padded to 24> <purpose>` for created, `  = <path> (kept)` for kept) → `2/3 System check` (`  ✓ <name> <detail>` / `  ✗ <name> <detail>` + next line `      fix: <fix>`; a required failure adds `  Required tools are missing: runs will fail until they are installed.`) → `3/3 API keys (BYOK), saved to <dir>/.env.local` → `confirm("Set up API keys now?", true)`; for each distinct `keyEnv` in providers (sorted) plus `CLOUDFLARE_ACCOUNT_ID`, `WHISPER_MODELS_DIR`: if already set print `  = NAME (set: <maskSecret>)` and skip unless `confirm("Replace NAME?", false)`; else `secret("NAME (Enter to skip)")` for secret names, `ask` for the two non-secret ones; non-empty answers are collected and written with one `updateEnvFile` call. Ends with `Next: mostudio ui   (opens the dashboard: inspiration, uploads, live runs, settings)`.
  Directory: `--dir` resolved against `io.cwd`, default `io.cwd`; if the dir is not empty and has no `mostudio.config.json`, `confirm("Use <dir> as your workspace?", true)` first (false → print `Cancelled.` and return 1).
  Main: `mostudio` with no args and no workspace found (`findWorkspace(cwd)` undefined and no `MOSTUDIO_ROOT`) prints USAGE plus `First time? Run: mostudio init`.

- [ ] **Step 1: Write failing tests** (`cli/src/init.test.ts`, scripted prompt)

```ts
const scripted = (answers: Record<string, string | boolean>): Prompt => ({
  ask: async (q, d) => String(answers[q] ?? d ?? ""), secret: async (q) => String(answers[q] ?? ""),
  confirm: async (q, d) => (q in answers ? Boolean(answers[q]) : d), close() {},
});
const okSystem = { nodeVersion: "v22.18.0", platform: "darwin" as const, run: async () => "v 1", exists: () => true, listDir: () => ["ggml-large-v3.bin"] };
test("init scaffolds, checks and writes only the keys the user typed", async () => {
  const ws = tmpDir(); const out: string[] = [];
  const code = await runInit({ dir: ws, out: (s) => out.push(s), env: {}, system: okSystem,
    prompt: scripted({ "GROQ_API_KEY (Enter to skip)": "gsk_live_123456" }) });
  assert.equal(code, 0);
  assert.deepEqual(loadEnvFile(join(ws, ".env.local")), { GROQ_API_KEY: "gsk_live_123456" });
  const text = out.join("");
  assert.match(text, /1\/3 Folders in/); assert.match(text, /2\/3 System check/); assert.match(text, /Next: mostudio ui/);
  assert.doesNotMatch(text, /gsk_live_123456/);
});
test("an existing key is shown masked and kept unless replaced", async () => {
  const ws = tmpDir(); writeFileSync(join(ws, ".env.local"), "GROQ_API_KEY=gsk_old_abcdef\n");
  const out: string[] = [];
  await runInit({ dir: ws, out: (s) => out.push(s), env: {}, system: okSystem, prompt: scripted({}) });
  assert.match(out.join(""), /= GROQ_API_KEY \(set: gsk…cdef\)/);
  assert.equal(loadEnvFile(join(ws, ".env.local")).GROQ_API_KEY, "gsk_old_abcdef");
});
test("main: init --yes in a fresh folder is non-interactive", async () => { /* main(["init","--dir",ws,"--yes"], io) → 0, ws/mostudio.config.json exists, no .env.local */ });
test("main: missing ffmpeg still exits 0 and prints the fix", async () => { /* system stub with ffmpeg throwing → output contains "fix: brew install ffmpeg" */ });
```

- [ ] **Step 2: Run** `node --test cli/src/init.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cli/src/prompt.ts` (readline/promises for `ask`/`confirm` with `[Y/n]`; `secret` via `input.setRawMode(true)`, handle Enter, Backspace, Ctrl-C → throw `Cancelled`), `cli/src/init.ts`, wire `init` into `main.ts` (`main` injects `io.prompt ?? defaultsPrompt()`; `--yes` forces defaults), bin passes `createTtyPrompt(process.stdin, process.stdout)` when `process.stdin.isTTY`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Manual check** — `node cli/bin/mostudio.ts init --dir "$(mktemp -d)/my studio"` in a real terminal: folders created, typing a key echoes `•`, Enter skips.
- [ ] **Step 6: Commit** `feat(cli): mostudio init guided setup (folders, system check, keys)`

### Task 6: core — auto-approve runs (`mostudio run --auto`)

**Files:**
- Modify: `core/src/workflow.ts`, `core/src/workflow.test.ts`, `cli/src/main.ts` (+ `cli/src/main.test.ts`), `README.md` (usage line)

**Interfaces:**
- Produces (added to `RunWorkflowOptions`):
  ```ts
  autoApprove?: boolean;                                  // approve gates are recorded as approved and the run continues
  onStepStart?: (step: string) => void;                   // before runStep for each entry
  onApprove?: (step: string, auto: boolean) => void;      // called after approveStep in auto mode
  ```
  CLI: `mostudio run <workflow> ... --auto` (USAGE line gets `[--auto]`); prints `auto-approved <step>` to stderr per auto approval.
  Semantics: at an `approve: true` entry whose latest result is not approved, `autoApprove` calls `approveStep(projectDir, step)`, then `onApprove(step, true)`, and continues. A `fail` result still returns `{ status: "failed" }`.

- [ ] **Step 1: Write failing tests** (`core/src/workflow.test.ts`)

```ts
test("autoApprove records the approval and runs to the end", async () => {
  const approved: string[] = []; const started: string[] = [];
  const r = await runWorkflow(dir, wf([{ step: "a" }, { step: "b", approve: true }, { step: "c" }]), fakeSteps,
    { ...opts, autoApprove: true, onApprove: (s, auto) => approved.push(`${s}:${auto}`), onStepStart: (s) => started.push(s) });
  assert.equal(r.status, "done");
  assert.deepEqual(approved, ["b:true"]);
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.equal((await readJson<Record<string, string>>(join(dir, "steps/approvals.json")))!.b, r.results[1]!.inputsHash);
});
test("autoApprove never skips a failing metric gate", async () => {
  const r = await runWorkflow(dir, wf([{ step: "failing" }, { step: "c" }]), fakeSteps, { ...opts, autoApprove: true });
  assert.deepEqual([r.status, r.stoppedAt], ["failed", "failing"]);
});
// cli/src/main.test.ts
test("run --auto exits 0 past an approve step and logs auto-approved", async () => { /* workflows/t.json with captions approve:true → exit 0, err() matches /auto-approved captions/ */ });
```

- [ ] **Step 2: Run** `node --test core/src/workflow.test.ts cli/src/main.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `runWorkflow` (call `onStepStart?.(entry.step)` before `runStep`; replace the final approval check with the auto branch) and parse `--auto` (run only) in `parseArgs`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(workflow): autoApprove option and run --auto`

---

## Part B — Dashboard server (branch `feat/dashboard-server`)

All server tests start a real server on port 0 against a temp workspace (`mostudio.config.json`, `providers.json` `[]`, `workflows/t.json`) with fake steps like `cli/src/main.test.ts`, and call it with global `fetch`. Shared helper `dashboard/src/testkit.ts` exports `startTestDashboard(opts?: { steps?: Record<string, StepModule>; fetch?: typeof fetch; env?: Record<string,string> }): Promise<{ base: string; token: string; ws: string; api: (path: string, init?: RequestInit) => Promise<Response>; close(): Promise<void> }>` (`api` adds the token header). Task 7 creates it.

### Task 7: server core — router, JSON helpers, access guard, `startDashboard`

**Files:**
- Create: `dashboard/src/types.ts`, `dashboard/src/http.ts`, `dashboard/src/http.test.ts`, `dashboard/src/context.ts`, `dashboard/src/server.ts`, `dashboard/src/server.test.ts`, `dashboard/src/testkit.ts`
- Modify: `tsconfig.json` (`include` += `"dashboard/src"`)

**Interfaces:**
- Produces:
  ```ts
  // http.ts
  export type Req = IncomingMessage; export type Res = ServerResponse;
  export type Handler = (req: Req, res: Res, params: Record<string, string>, url: URL) => Promise<void> | void;
  export function matchRoute(pattern: string, path: string): Record<string, string> | undefined; // ":name" = one decoded segment, trailing "*" = rest as params["*"]
  export class Router { add(method: string, pattern: string, h: Handler): void; handle(req: Req, res: Res, url: URL): Promise<boolean> }
  export class HttpError extends Error { constructor(public status: number, message: string) }
  export function sendJson(res: Res, status: number, body: unknown): void;
  export function readJsonBody<T>(req: Req, maxBytes?: number /* 1 MiB */): Promise<T>; // 400 invalid JSON, 413 too large
  export function checkAccess(req: Req, url: URL, port: number, token: string): void; // throws HttpError 403 (host/origin) or 401 (token)
  // context.ts
  export type DashboardContext = { root: string; port: number; token: string; steps: Record<string, StepModule>;
    processEnv: Record<string, string>; fetch: typeof fetch };   // Task 11 adds `jobs: JobManager`
  export function runtime(ctx: DashboardContext): Promise<{ config: Config; env: Record<string, string>; providers: ProviderRegistry }>;
     // env = { ...loadEnvFile(root/.env.local), ...processEnv } re-read each call
  // server.ts
  export type DashboardOptions = { root: string; port?: number; steps?: Record<string, StepModule>;
    processEnv?: Record<string, string>; fetch?: typeof fetch; token?: string };
  export function startDashboard(o: DashboardOptions): Promise<{ url: string; port: number; token: string; close(): Promise<void> }>;
     // url = `http://127.0.0.1:${port}/?t=${token}`; token default randomBytes(18).toString("base64url")
  // types.ts — see each task; starts with:
  export type ApiError = { error: string };
  ```
  Errors: unhandled `HttpError` → `sendJson(status, { error })`; anything else → 500 `{ error: <redacted message> }` (redactor over `processEnv` + `.env.local`). Unknown `/api/*` → 404 `{ error: "not found" }`. `GET /api/health` → `{ ok: true, root }`.

- [ ] **Step 1: Write failing tests**

```ts
// http.test.ts
test("matchRoute", () => {
  assert.deepEqual(matchRoute("/api/projects/:id", "/api/projects/2026-a"), { id: "2026-a" });
  assert.deepEqual(matchRoute("/api/projects/:id/files/*", "/api/projects/p/files/a/b%20c.mp4"), { id: "p", "*": "a/b c.mp4" });
  assert.equal(matchRoute("/api/projects/:id", "/api/projects/a/b"), undefined);
});
// server.test.ts
test("api needs the token", async () => {
  const d = await startTestDashboard();
  assert.equal((await fetch(`${d.base}/api/health`)).status, 401);
  assert.equal((await d.api("/api/health")).status, 200);
  assert.equal((await fetch(`${d.base}/api/health?t=${d.token}`)).status, 200);
  await d.close();
});
test("foreign Host or Origin is refused even with the token", async () => {
  const d = await startTestDashboard();
  const port = new URL(d.base).port;
  const viaHost = await rawGet(port, "/api/health", { host: `evil.test:${port}`, "x-mostudio-token": d.token });
  assert.equal(viaHost, 403);
  assert.equal((await d.api("/api/health", { headers: { origin: "https://evil.test" } })).status, 403);
  await d.close();
});
test("server binds 127.0.0.1 only", async () => { /* d.base host === "127.0.0.1" and server.address().address === "127.0.0.1" */ });
test("errors never leak a key", async () => { /* a route that throws Error("bad gsk_secret_123456") with processEnv {GROQ_API_KEY:"gsk_secret_123456"} → body.error has "[redacted]" */ });
```
(`rawGet` uses `node:http.request` so the `host` header can be forged; global `fetch` forbids it.)

- [ ] **Step 2: Run** `node --test dashboard/src/http.test.ts dashboard/src/server.test.ts` → FAIL.
- [ ] **Step 3: Implement** the files above (`createServer`, `server.listen(port ?? 4317, "127.0.0.1")`; guard only `/api/*`).
- [ ] **Step 4: Run** → PASS; `npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat(dashboard): local http server with token and host/origin guard`

### Task 8: static web serving (TS stripping) and Range file serving

**Files:**
- Create: `dashboard/src/static.ts`, `dashboard/src/static.test.ts`, `dashboard/src/files.ts`, `dashboard/src/files.test.ts`, `dashboard/web/index.html` (placeholder `<title>mostudio</title><script type="module" src="/app.ts"></script>`), `dashboard/web/app.ts` (placeholder `export {};`)
- Modify: `dashboard/src/server.ts`

**Interfaces:**
- Produces:
  ```ts
  // static.ts
  export const WEB_ROOT: string; // join(PACKAGE_ROOT, "dashboard", "web")
  export function contentType(path: string): string; // .html text/html; .ts/.js text/javascript; .css text/css; .json application/json; .mp4 video/mp4; .mov video/quicktime; .webm video/webm; .wav audio/wav; .mp3 audio/mpeg; .m4a audio/mp4; .jpg/.jpeg image/jpeg; .png image/png; .webp image/webp; .svg image/svg+xml; .srt/.ass/.txt/.md text/plain; charset=utf-8; else application/octet-stream
  export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined;
  export function serveWeb(req: Req, res: Res, url: URL): Promise<boolean>; // GET non-/api paths; "/" → index.html; .ts → stripTypeScriptTypes(source, { mode: "strip" }) cached by mtime
  export function serveFile(req: Req, res: Res, absPath: string): Promise<void>; // 200 full or 206 single range, Accept-Ranges: bytes, 416 invalid
  // files.ts
  export function insideDir(dir: string, rel: string): string; // resolved abs path; throws HttpError(400,"path escapes folder") for "..", absolute, NUL, or symlink target outside (realpath)
  export function safeFileName(name: string): string; // basename, strip control chars and leading dots, trim, max 120 chars keeping extension; "" → HttpError(400,"bad file name")
  export function uniquePath(dir: string, name: string): Promise<string>; // "a.mov" → "a (2).mov" → "a (3).mov"
  export function saveStream(req: Req, finalPath: string, maxBytes?: number): Promise<number>; // pipeline(req, createWriteStream(tmp)) inside writeOutputAtomic; returns bytes; aborted/oversize → tmp removed, HttpError(400|413)
  ```
  `parseRange`: `bytes=a-b`, `bytes=a-`, `bytes=-n`; multi-range or out of bounds → `"invalid"`; absent → `undefined`.
  Stripping warning: do not silence process warnings; call `stripTypeScriptTypes("")` once in `startDashboard` so Node's single ExperimentalWarning prints at launch, not mid-session.

- [ ] **Step 1: Write failing tests**

```ts
test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseRange("bytes=0-1,5-6", 1000), "invalid");
  assert.equal(parseRange("bytes=1000-", 1000), "invalid");
  assert.equal(parseRange(undefined, 1000), undefined);
});
test("insideDir refuses escapes", () => {
  assert.throws(() => insideDir("/w/p", "../x"), /escapes/);
  assert.throws(() => insideDir("/w/p", "/etc/passwd"), /escapes/);
  assert.equal(insideDir("/w/p", "renders/final.mp4"), "/w/p/renders/final.mp4");
});
test("safeFileName and uniquePath", async () => {
  assert.equal(safeFileName("../../My clip été.MOV"), "My clip été.MOV");
  assert.equal(safeFileName("\u0000.hidden"), "hidden");
  assert.throws(() => safeFileName("..."), /bad file name/);
  const d = tmpDir(); writeFileSync(join(d, "a.mov"), "");
  assert.equal(await uniquePath(d, "a.mov"), join(d, "a (2).mov"));
});
test("web .ts modules are served as JavaScript without types", async () => {
  const d = await startTestDashboard();
  const res = await fetch(`${d.base}/app.ts`);
  assert.equal(res.headers.get("content-type"), "text/javascript");
  assert.doesNotMatch(await res.text(), /:\s*(string|number)\b/);
  assert.equal((await fetch(`${d.base}/`)).headers.get("content-type"), "text/html");
  assert.equal((await fetch(`${d.base}/../package.json`)).status, 404);
  await d.close();
});
```

- [ ] **Step 2: Run** `node --test dashboard/src/static.test.ts dashboard/src/files.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules; register `serveWeb` as the fallback for non-`/api` GETs in `server.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): serve web modules (type-stripped) and media with Range`

### Task 9: inspiration API

**Files:**
- Create: `dashboard/src/inspiration.ts`, `dashboard/src/inspiration.test.ts`, `dashboard/src/routes/inspiration.ts`, `dashboard/src/routes/inspiration.test.ts`
- Modify: `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type InspirationKind = "shorts" | "long";
  export type InspirationLink = { url: string; note?: string; platform: "youtube" | "instagram" | "tiktok" | "x" | "facebook" | "other" };
  export type InspirationFile = { name: string; path: string /* relative to inspirationRoot */; sizeBytes: number; kind: "media" | "note" };
  export type InspirationShelf = { kind: InspirationKind; folder: string /* absolute */; links: InspirationLink[]; files: InspirationFile[] };
  // inspiration.ts (pure)
  export function listLinks(text: string): InspirationLink[];                 // non-# lines with http(s) URL; " # note" suffix → note
  export function addLink(text: string, url: string, note?: string): string; // dedupes by URL (returns text unchanged), appends `${url}${note ? `  # ${note}` : ""}\n`
  export function removeLink(text: string, url: string): string;             // drops lines whose URL equals url; keeps comments
  export function classifyLink(url: string): InspirationKind;
  export function platformOf(url: string): InspirationLink["platform"];
  export function routeInspirationFile(kind: InspirationKind, name: string): string; // "<kind>/media/<name>" | "<kind>/<name>"; throws HttpError(415, "unsupported file type: .<ext>")
  ```
  `classifyLink` rules (host without `www.`/`m.`): `youtube.com/shorts/…` → shorts; `instagram.com/reel/…`, `instagram.com/reels/…` → shorts; `tiktok.com` → shorts; `youtube.com/watch`, `youtu.be` → long; everything else → long.
  `routeInspirationFile`: media exts `.mp4 .mov .m4v .webm .mkv .mp3 .wav .m4a .jpg .jpeg .png .webp .gif` → `media/`; note exts `.md .txt` → kind root (but `links.txt` → HttpError 409 `links.txt is managed by the link list`).
  Routes:
  - `GET /api/inspiration` → `{ shelves: InspirationShelf[] }` (both kinds; creates missing folders).
  - `POST /api/inspiration/links` body `{ url: string; note?: string; kind?: InspirationKind }` → `{ kind, link }` (kind defaults to `classifyLink(url)`); non-http(s) URL → 400 `only http(s) links`.
  - `DELETE /api/inspiration/links` body `{ url, kind }` → `{ ok: true }`.
  - `PUT /api/inspiration/:kind/files?name=<file>` (raw body) → `InspirationFile` (saved via `saveStream` + `uniquePath`).
  - `DELETE /api/inspiration/files` body `{ path }` (relative to inspirationRoot, via `insideDir`) → `{ ok: true }`; `links.txt` → 409.

- [ ] **Step 1: Write failing tests**

```ts
test("classifyLink routes shorts vs long", () => {
  assert.equal(classifyLink("https://www.youtube.com/shorts/abc"), "shorts");
  assert.equal(classifyLink("https://www.instagram.com/reel/DaiCxAkOpNb/"), "shorts");
  assert.equal(classifyLink("https://vm.tiktok.com/x"), "shorts");
  assert.equal(classifyLink("https://youtu.be/xyz"), "long");
  assert.equal(classifyLink("https://example.com/v"), "long");
});
test("links round-trip with notes and keep comments", () => {
  const base = "# header\nhttps://a.test/1\n";
  const t = addLink(base, "https://b.test/2", "great hook");
  assert.equal(t, "# header\nhttps://a.test/1\nhttps://b.test/2  # great hook\n");
  assert.equal(addLink(t, "https://b.test/2"), t);
  assert.deepEqual(listLinks(t).map((l) => [l.url, l.note]), [["https://a.test/1", undefined], ["https://b.test/2", "great hook"]]);
  assert.equal(removeLink(t, "https://a.test/1"), "# header\nhttps://b.test/2  # great hook\n");
});
test("routeInspirationFile", () => {
  assert.equal(routeInspirationFile("shorts", "clip.MOV"), "shorts/media/clip.MOV");
  assert.equal(routeInspirationFile("long", "pacing.md"), "long/pacing.md");
  assert.throws(() => routeInspirationFile("long", "x.exe"), /unsupported file type: \.exe/);
});
// routes
test("POST a reel link lands in shorts/links.txt", async () => {
  const d = await startTestDashboard();
  const r = await d.api("/api/inspiration/links", { method: "POST", body: JSON.stringify({ url: "https://www.instagram.com/reel/X/" }) });
  assert.equal((await r.json()).kind, "shorts");
  assert.match(readFileSync(join(d.ws, "inspiration/shorts/links.txt"), "utf8"), /instagram\.com\/reel\/X\//);
  await d.close();
});
test("PUT a clip lands in <kind>/media and is listed", async () => { /* PUT /api/inspiration/long/files?name=a.mp4 body "xx" → path "long/media/a.mp4"; GET lists it */ });
```

- [ ] **Step 2: Run** `node --test dashboard/src/inspiration.test.ts dashboard/src/routes/inspiration.test.ts` → FAIL.
- [ ] **Step 3: Implement** (folder from `runtime(ctx).config.inspirationRoot`; read/modify/write `links.txt` atomically).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): inspiration API that files links and clips in the right folder`

### Task 10: projects API — list, create, status, upload, files, replacements

**Files:**
- Create: `dashboard/src/routes/projects.ts`, `dashboard/src/routes/projects.test.ts`
- Modify: `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Consumes: `createProject`, `readLedger`, `latest`, `pendingApprovals`, `readProjectWorkflow`, `parseWorkflow`, `readJson`, `resolveShared` (core); `insideDir`, `safeFileName`, `uniquePath`, `saveStream`, `serveFile` (Task 8).
- Produces:
  ```ts
  export type StepView = StepResult & { cached?: boolean; awaitingApproval?: true };
  export type ProjectSummary = { id: string; workflow?: string; updatedAt?: string; lastStatus?: "done" | "failed" | "awaiting-approval" | "running" | "new" };
  export type ProjectStatus = { id: string; dir: string; workflow?: string; steps: Record<string, StepView>;
    pending: string[]; running: boolean; interrupted: string[]; uploads: string[]; media?: Record<string, unknown> };
  export type WorkflowInfo = { name: string; steps: { step: string; approve: boolean }[] };
  export const PROJECT_ID_RE: RegExp; // /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/
  export function projectDir(ctx: DashboardContext, id: string): Promise<string>; // 400 bad id, 404 missing
  ```
  Routes:
  - `GET /api/workflows` → `{ workflows: WorkflowInfo[] }` (from `resolveShared(root,"workflows")`).
  - `GET /api/projects` → `{ projects: ProjectSummary[] }` newest first (folder name sort desc).
  - `POST /api/projects` `{ slug: string; brief?: string }` → `ProjectStatus` (201); bad slug → 400 with core's message; exists → 409.
  - `GET /api/projects/:id` → `ProjectStatus`. `running` = `ctx.jobs.isRunning(id)` (false until Task 11); `interrupted` = steps with a `steps/<step>.running` file while not running; `uploads` = files in `uploads/`; `media` = `media/ingest.json` if present.
  - `PUT /api/projects/:id/uploads?name=<file>` raw body → `{ path: "uploads/<name>", sizeBytes }`. Allowed exts: `.mp4 .mov .m4v .mkv .webm .avi .mp3 .wav .m4a .aac .flac` (else 415).
  - `GET /api/projects/:id/files/*` → `serveFile` (via `insideDir`).
  - `GET|PUT /api/projects/:id/replacements` → text/plain of `edits/replacements.txt` (PUT max 256 KiB, written atomically).

- [ ] **Step 1: Write failing tests**

```ts
test("create, upload and status", async () => {
  const d = await startTestDashboard();
  const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "demo" }) })).json();
  assert.match(p.id, /^\d{4}-\d{2}-\d{2}-demo$/);
  const up = await (await d.api(`/api/projects/${p.id}/uploads?name=${encodeURIComponent("my clip.mov")}`, { method: "PUT", body: "bytes" })).json();
  assert.deepEqual(up, { path: "uploads/my clip.mov", sizeBytes: 5 });
  const s = await (await d.api(`/api/projects/${p.id}`)).json();
  assert.deepEqual([s.uploads, s.running, s.interrupted], [["my clip.mov"], false, []]);
  await d.close();
});
test("an aborted upload leaves nothing behind", async () => {
  // node:http.request PUT with content-length 10_000_000, write 64 KiB, then req.destroy();
  // wait for the server to settle (poll 50 ms up to 2 s) → readdirSync(join(projDir,"uploads")) has no entries (no *.tmp either)
});
test("leftover .running marker shows as interrupted", async () => {
  // writeFileSync(join(projDir,"steps","transcribe.running"), "{}") → status.interrupted deepEquals ["transcribe"]
});
test("files route serves ranges and refuses traversal", async () => {
  // write renders/final.mp4 = "0123456789"; GET with Range bytes=2-4 → 206 "234"; GET files/..%2F..%2Fmostudio.config.json → 400
});
test("rejects unknown upload types and bad ids", async () => { /* name=x.exe → 415; GET /api/projects/..%2Fx → 400 */ });
```

- [ ] **Step 2: Run** `node --test dashboard/src/routes/projects.test.ts` → FAIL.
- [ ] **Step 3: Implement** `dashboard/src/routes/projects.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): projects API with streamed uploads and artifact serving`

### Task 11: job manager and live events (SSE)

**Files:**
- Create: `dashboard/src/jobs.ts`, `dashboard/src/jobs.test.ts`, `dashboard/src/routes/events.ts`, `dashboard/src/routes/events.test.ts`
- Modify: `dashboard/src/context.ts` (`jobs`), `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type RunMode = "manual" | "auto";
  export type RunEventBody =
    | { type: "run-start"; kind: "workflow" | "step"; name: string; mode: RunMode }
    | { type: "step-start"; step: string }
    | { type: "log"; step?: string; message: string }
    | { type: "step-end"; result: StepView }
    | { type: "approved"; step: string; auto: boolean }
    | { type: "run-end"; status: "done" | "failed" | "awaiting-approval"; stoppedAt?: string; error?: string };
  export type RunEvent = RunEventBody & { id: number; at: string };
  // jobs.ts
  export type Emit = (e: RunEventBody) => void;
  export class JobManager {
    constructor(opts?: { keepEvents?: number /* 2000 per project */ });
    isRunning(projectId: string): boolean;
    start(projectId: string, work: (emit: Emit) => Promise<void>): void; // throws HttpError(409, "a run is already in progress for this project")
    events(projectId: string, afterId?: number): RunEvent[];             // buffered history after id
    subscribe(projectId: string, fn: (e: RunEvent) => void): () => void;
    idle(projectId: string): Promise<void>;                              // resolves when the current job ends (tests)
  }
  ```
  Ids increase per project from 1 and survive across runs while the server lives. A thrown `work` emits `run-end { status: "failed", error }` (message redacted by caller) and frees the slot. Log `message` comes already redacted (runStep redacts).
  Route `GET /api/projects/:id/events` (token via `t` query because `EventSource` cannot send headers): headers `content-type: text/event-stream`, `cache-control: no-store`, `connection: keep-alive`; first replays `events(id, Number(lastEventId ?? 0))`, then streams live; frames are `id: <id>\nevent: <type>\ndata: <json>\n\n`; `: ping\n\n` every 15 s; unsubscribes on `close`. `Last-Event-ID` header or `since` query param sets `afterId`.

- [ ] **Step 1: Write failing tests**

```ts
test("one job per project; events buffered with increasing ids", async () => {
  const jm = new JobManager(); let release!: () => void;
  jm.start("p", async (emit) => { emit({ type: "log", message: "a" }); await new Promise<void>((r) => (release = r)); });
  assert.throws(() => jm.start("p", async () => {}), /already in progress/);
  assert.equal(jm.isRunning("p"), true);
  release(); await jm.idle("p");
  assert.equal(jm.isRunning("p"), false);
  assert.deepEqual(jm.events("p").map((e) => e.id), [1]);
  assert.deepEqual(jm.events("p", 1), []);
});
test("a throwing job ends with run-end failed", async () => {
  const jm = new JobManager();
  jm.start("p", async () => { throw new Error("boom"); }); await jm.idle("p");
  const last = jm.events("p").at(-1)!;
  assert.deepEqual([last.type, (last as any).status, (last as any).error], ["run-end", "failed", "boom"]);
});
test("SSE replays history then streams live, honoring Last-Event-ID", async () => {
  // push 3 events via ctx.jobs, connect with fetch(`${base}/api/projects/${id}/events?t=${token}`, { headers: { "last-event-id": "1" } }),
  // read the body stream until 2 frames → ids 2 and 3; emit a 4th → frame id 4 arrives; abort the fetch → subscriber count back to 0
});
```

- [ ] **Step 2: Run** `node --test dashboard/src/jobs.test.ts dashboard/src/routes/events.test.ts` → FAIL.
- [ ] **Step 3: Implement** `jobs.ts` and the events route.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): job manager with replayable live events over SSE`

### Task 12: run, approve and single-step routes (manual vs auto)

**Files:**
- Create: `dashboard/src/routes/runs.ts`, `dashboard/src/routes/runs.test.ts`
- Modify: `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Consumes: `runWorkflow` with `autoApprove`/`onStepStart`/`onApprove`/`onStep`/`log` (Task 6), `runStep`, `approveStep`, `parseWorkflow` (core); `JobManager` (Task 11); `runtime(ctx)` (Task 7); `projectDir` (Task 10).
- Produces:
  ```ts
  export type RunRequest = { workflow: string; mode: RunMode; source?: string /* project-relative, e.g. "uploads/x.mov" */;
    params?: Record<string, Record<string, string | number | boolean>>; force?: string[] };
  export type StepRequest = { params?: Record<string, string | number | boolean>; force?: boolean };
  export type ApproveRequest = { step: string; continue?: boolean; mode?: RunMode };
  ```
  Routes (all return 202 `{ started: true }` when a job starts):
  - `POST /api/projects/:id/run` `RunRequest`. `source` → `params.ingest.source = insideDir(projectDir, source)`. Each step entry whose contract lists a key in `fileParams` gets the same `insideDir` treatment (so only files inside the project can be used, e.g. uploaded music). Unknown workflow → 404; `WorkflowParamError`/`WorkflowMismatchError` → 400 with message — validated **before** responding by calling `parseWorkflow` + the core param check synchronously; mismatch errors raised inside the job surface as `run-end failed` with the message. Emits `run-start {kind:"workflow"}`, `step-start`, `log` (strip the `[step] ` prefix into `step`), `step-end`, `approved`, `run-end`.
  - `POST /api/projects/:id/approve` `ApproveRequest` → `approveStep`; emits `approved {auto:false}`; with `continue: true` immediately starts the project's workflow (`readProjectWorkflow`) in `mode ?? "manual"` and returns 202, else 200 `{ ok: true }`. No passing result → 409 with core's message.
  - `POST /api/projects/:id/steps/:name` `StepRequest` → `runStep` as a job (`run-start {kind:"step"}` … `run-end` with `done`/`failed`); unknown step → 404.

- [ ] **Step 1: Write failing tests** (fake steps `a`, `b` (approve in `workflows/t.json`), `c`, `fail`; `await ctx.jobs.idle(id)` after each 202)

```ts
test("manual mode stops at the approve step; approve+continue finishes", async () => {
  const d = await startTestDashboard({ steps }); const id = await newProject(d);
  assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
  await d.idle(id);
  assert.deepEqual(lastRunEnd(d, id), { status: "awaiting-approval", stoppedAt: "b" });
  assert.equal((await d.api(`/api/projects/${id}/approve`, post({ step: "b", continue: true }))).status, 202);
  await d.idle(id);
  assert.equal(lastRunEnd(d, id).status, "done");
});
test("auto mode runs end to end and emits approved{auto:true}", async () => {
  // run mode:"auto" → events contain {type:"approved",step:"b",auto:true} and run-end done; order: step-start a, step-end a, step-start b, step-end b, approved b, step-start c ...
});
test("second run while running → 409", async () => { /* slow fake step awaiting a promise; second POST → 409 */ });
test("source outside the project is refused", async () => { /* source "../../etc/hosts" → 400 "path escapes folder" */ });
test("unknown workflow 404, bad param 400 before any job starts", async () => { /* params {a:{nope:1}} → 400 /undeclared params: nope/; isRunning false */ });
test("single step job", async () => { /* POST /steps/a {params:{}} → run-end done, step-end result.step === "a" */ });
```
(`testkit` gains `idle(id)` and `events(id)` passthroughs to `ctx.jobs` for tests.)

- [ ] **Step 2: Run** `node --test dashboard/src/routes/runs.test.ts` → FAIL.
- [ ] **Step 3: Implement** `dashboard/src/routes/runs.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): run workflows in manual or auto mode, approve and continue, single steps`

### Task 13: tools catalog

**Files:**
- Create: `dashboard/src/knobs.ts`, `dashboard/src/catalog.ts`, `dashboard/src/catalog.test.ts`
- Modify: `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Knob = { label: string; help: string; choices?: string[]; input?: "text" | "textarea" | "number" | "toggle" | "file" | "provider" };
  export const KNOBS: Record<string, Record<string, Knob>>; // step -> param -> knob
  export type ToolParam = { name: string; type: "string" | "number" | "boolean"; optional: boolean } & Knob;
  export type ToolInfo = { name: string; title: string; summary: string; version: string; inputs: string[]; outputs: string[];
    params: ToolParam[]; gate: Threshold[]; workflows: string[]; capability?: Capability };
  export function buildCatalog(steps: Record<string, StepModule>, workflows: WorkflowInfo[], readme: (step: string) => string): ToolInfo[];
  ```
  `summary` = first paragraph after the `# title` line of `steps/<name>/README.md` (missing README → `""`). `title` (fixed): ingest `Import media`, transcribe `Transcribe`, cut `Silence and retake cut`, localize `Darija / Arabizi localizer`, captions `Captions`, chapters `YouTube chapters`, mix `Loudness mix and music`, assemble `Render (HyperFrames or ffmpeg captions)`, qa `Quality check`. `capability`: transcribe `stt`; localize, chapters `llm`.
  `KNOBS` (choices verbatim from the step READMEs):
  - transcribe: `language` text "ISO code, e.g. en, fr. Leave empty for auto."; `dialect` choices `["darija"]` "Moroccan Darija mode (cannot be combined with language)"; `prompt` textarea "Names and tech terms the model should spell right"; `prefer` provider "Provider tried first".
  - cut: `pace` `["natural","tight"]`; `maxGap`, `pre`, `post`, `minKeep`, `maxRetakeSec` number (seconds); `retakes` toggle "Remove earlier takes of a repeated sentence".
  - localize: `lang` `["source","arabizi","fr","en"]` "Subtitle language. arabizi = Darija in Latin letters"; `prefer` provider.
  - captions: `style` `["long","short"]`; `width`, `height` number; `font` text.
  - mix: `music` file "Background music (uploaded into the project)"; `musicDb` number (default -21); `targetLufs` number (default -14).
  - chapters: `language` text; `prefer` provider.
  - assemble: `preset` `["source","youtube","shorts","reels","tiktok"]`; `burnCaptions` toggle; `captionsRenderer` `["ass","hyperframes"]` "hyperframes = animated karaoke captions".
  - ingest: `source` file "Video or audio file".
  Route `GET /api/tools` → `{ tools: ToolInfo[] }` in `defaultSteps` order.

- [ ] **Step 1: Write failing tests**

```ts
test("every contract param has a knob and every knob names a real param", () => {
  for (const [name, mod] of Object.entries(defaultSteps)) {
    const params = Object.keys(mod.contract.params ?? {}).sort();
    assert.deepEqual(Object.keys(KNOBS[name] ?? {}).sort(), params, name);
  }
});
test("catalog lists workflows each tool belongs to and README summaries", () => {
  const cat = buildCatalog(defaultSteps, [{ name: "short", steps: [{ step: "cut", approve: false }] }], (s) => `# ${s}\n\nDoes ${s}.\n\nMore.`);
  const cut = cat.find((t) => t.name === "cut")!;
  assert.deepEqual([cut.title, cut.summary, cut.workflows], ["Silence and retake cut", "Does cut.", ["short"]]);
  assert.deepEqual(cut.params.find((p) => p.name === "pace")!.choices, ["natural", "tight"]);
});
```

- [ ] **Step 2: Run** `node --test dashboard/src/catalog.test.ts` → FAIL.
- [ ] **Step 3: Implement** `knobs.ts`, `catalog.ts`, the route.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): tools catalog built from step contracts`

### Task 14: BYOK settings and connection tests

**Files:**
- Create: `dashboard/src/settings.ts`, `dashboard/src/probes.ts`, `dashboard/src/settings.test.ts`, `dashboard/src/probes.test.ts`, `dashboard/src/routes/settings.ts`
- Modify: `dashboard/src/server.ts`, `dashboard/src/types.ts`

**Interfaces:**
- Consumes: `updateEnvFile`, `maskSecret`, `loadEnvFile`, `loadProvidersFile`, `createRedactor`, `resolveBin`, `runBin` (core).
- Produces:
  ```ts
  export type SettingField = { name: string; kind: "secret" | "text" | "path"; providers: string[]; help: string;
    source: "file" | "process" | "unset"; masked: string /* secrets: maskSecret; others: the value */ };
  export type ProbeResult = { provider: string; ok: boolean; verified: boolean; status?: number; message: string; ms: number };
  // settings.ts
  export function settingsSchema(entries: ProviderEntry[]): Omit<SettingField, "source" | "masked">[];
  export function readSettings(root: string, processEnv: Record<string, string>, entries: ProviderEntry[]): SettingField[];
  export function writeSettings(root: string, values: Record<string, string>, entries: ProviderEntry[]): Promise<void>; // 400 "unknown setting: X" for names outside the schema
  // probes.ts
  export function probeProvider(entry: ProviderEntry, env: Record<string, string | undefined>, deps: { fetch: typeof fetch; run?: (bin: string, args: string[]) => Promise<string>; listDir?: (p: string) => string[] }): Promise<ProbeResult>;
  ```
  Schema = each distinct `keyEnv` (kind `secret`, providers = ids using it) + each `env` map value (e.g. `CLOUDFLARE_ACCOUNT_ID`, kind `text`) + `WHISPER_CLI` (path), `WHISPER_MODELS_DIR` (path), `FFMPEG` (path), `FFPROBE` (path); sorted by name. `help` for secrets: `Key for <ids joined by ", ">`.
  `source`: `"process"` when `processEnv[name]` is set (UI shows: `Set outside .env.local (e.g. mostudio-bws). Saving here will not override it.`), else `"file"` when in `.env.local`, else `"unset"`.
  Probe table (timeout 10 s via `AbortSignal.timeout`; 401/403 → `ok:false message "key rejected (<status>)"`; network error → `ok:false message "cannot reach <host>"`; missing key → `ok:false, message "<KEYENV> is not set"` without a request):
  | provider | request | verified |
  |---|---|---|
  | `kind: "openai-compat"` (groq, zai, mistral) | `GET {baseUrl}/models`, `Authorization: Bearer <key>` | true |
  | nvidia | same | **false** (models list is public) → message `reachable; this endpoint does not check the key` |
  | openrouter | `GET https://openrouter.ai/api/v1/key`, Bearer | true |
  | gemini | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, `x-goog-api-key: <key>` | true |
  | cloudflare | needs `CLOUDFLARE_ACCOUNT_ID` (else `CLOUDFLARE_ACCOUNT_ID is not set`); `GET https://api.cloudflare.com/client/v4/accounts/<id>/ai/models/search?per_page=1`, Bearer | true |
  | pexels | `GET https://api.pexels.com/v1/search?query=nature&per_page=1`, `Authorization: <key>` | true |
  | pixabay | `GET https://pixabay.com/api/?key=<key>&q=nature&per_page=3`; every message passed through a redactor holding the key | true |
  | whisper-cpp (`kind: "local"`) | `run(resolveBin("whisper-cli", env), ["--help"])` + `WHISPER_MODELS_DIR` has `ggml-*.bin` | true; message `whisper-cli ok, models: <names>` |
  Success message: `connected (<status>, <ms> ms)`.
  Routes:
  - `GET /api/settings` → `{ envFile: "<root>/.env.local", fields: SettingField[] }`.
  - `PUT /api/settings` `{ values: Record<string,string> }` (empty = remove) → `{ fields }`.
  - `POST /api/settings/reveal` `{ name }` → `{ value }` (404 if unset; only schema names).
  - `POST /api/settings/test` `{ provider: string; values?: Record<string,string> }` → `ProbeResult` (`values` override the stored env for this call only, so a key can be tested before saving).

- [ ] **Step 1: Write failing tests**

```ts
test("schema comes from providers.json plus binary paths", () => {
  const names = settingsSchema(realEntries).map((f) => f.name);
  for (const n of ["GROQ_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY", "WHISPER_CLI", "WHISPER_MODELS_DIR"]) assert.ok(names.includes(n), n);
});
test("read masks secrets and reports the source", () => {
  const ws = tmpDir(); writeFileSync(join(ws, ".env.local"), "GROQ_API_KEY=gsk_abcdefgh1234\n");
  const f = readSettings(ws, { GEMINI_API_KEY: "AIzaXXXXXXXX9999" }, realEntries);
  assert.deepEqual(pick(f, "GROQ_API_KEY"), { source: "file", masked: "gsk…1234" });
  assert.deepEqual(pick(f, "GEMINI_API_KEY"), { source: "process", masked: "AIz…9999" });
  assert.deepEqual(pick(f, "MISTRAL_API_KEY"), { source: "unset", masked: "" });
});
test("write refuses names outside the schema", async () => {
  await assert.rejects(writeSettings(tmpDir(), { NODE_OPTIONS: "--inspect" }, realEntries), /unknown setting: NODE_OPTIONS/);
});
test("probe: 401 means key rejected; key never in the message", async () => {
  const fetch401 = (async () => new Response("no", { status: 401 })) as typeof fetch;
  const r = await probeProvider(groq, { GROQ_API_KEY: "gsk_secret_999999" }, { fetch: fetch401 });
  assert.deepEqual([r.ok, r.verified, r.status, r.message], [false, true, 401, "key rejected (401)"]);
});
test("probe: pixabay network error message is redacted", async () => {
  const boom = (async (u: string) => { throw new Error(`fetch failed for ${u}`); }) as unknown as typeof fetch;
  const r = await probeProvider(pixabay, { PIXABAY_API_KEY: "pixkey123456" }, { fetch: boom });
  assert.equal(r.ok, false); assert.doesNotMatch(r.message, /pixkey123456/);
});
test("probe: missing key does not call fetch", async () => { /* fetch that throws if called; message "GROQ_API_KEY is not set" */ });
test("probe: gemini sends the key in x-goog-api-key, not the URL", async () => { /* capture request; url has no key; header equals key */ });
test("routes: PUT then GET shows masked; reveal returns the value; test uses unsaved values", async () => { /* via startTestDashboard with fetch stub */ });
```

- [ ] **Step 2: Run** `node --test dashboard/src/settings.test.ts dashboard/src/probes.test.ts` → FAIL.
- [ ] **Step 3: Implement** `settings.ts`, `probes.ts`, `routes/settings.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): BYOK settings API with masked keys and provider connection tests`

### Task 15: `mostudio ui` command

**Files:**
- Modify: `cli/src/main.ts` (+ `cli/src/main.test.ts`), `README.md`

**Interfaces:**
- Consumes: `startDashboard` (Task 7).
- Produces: `mostudio ui [--port <n>]` (alias `mostudio dashboard`). Prints exactly:
  ```
  mostudio dashboard: http://127.0.0.1:<port>/?t=<token>
  workspace: <root>
  Press Ctrl+C to stop.
  ```
  Keeps running until SIGINT/SIGTERM, then `close()` and return 0. Port in use → stderr `port <n> is busy; try mostudio ui --port <n+1>` and exit 1. `main` gets an optional `io.signal?: AbortSignal` so tests can stop it.

- [ ] **Step 1: Write failing tests**

```ts
test("ui starts, prints the tokened URL, and stops on abort", async () => {
  const ac = new AbortController(); reset();
  const p = main(["ui", "--port", "0"], { ...mk(), signal: ac.signal }, steps);
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(out()));
  const url = /http:\S+/.exec(out())![0];
  assert.equal((await fetch(url.replace("/?t=", "/api/health?t="))).status, 200);
  ac.abort(); assert.equal(await p, 0);
});
test("busy port exits 1 with a hint", async () => { /* occupy a port with net.createServer, run ui --port <it> → 1, err() matches /is busy; try mostudio ui --port/ */ });
```

- [ ] **Step 2: Run** `node --test cli/src/main.test.ts` → FAIL.
- [ ] **Step 3: Implement** (`--port` flag in `parseArgs`; bin wires an AbortController to SIGINT/SIGTERM).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS; manual: `node cli/bin/mostudio.ts ui`, open the URL, `/api/health` answers.
- [ ] **Step 5: Commit** `feat(cli): mostudio ui starts the local dashboard`

---

## Part C — Dashboard UI (branch `feat/dashboard-ui`)

Browser code is TypeScript in `dashboard/web/`, type-checked by its own `dashboard/web/tsconfig.json` (`lib: ["es2023","dom","dom.iterable"]`, `types: ["node"]` for its tests, same strict flags as root, `include: ["**/*.ts", "../src/types.ts"]`); root `tsconfig.json` does not include it. `package.json` `typecheck` becomes `tsc --noEmit && tsc --noEmit -p dashboard/web`. Pure logic lives in `dashboard/web/lib/*.ts` with node tests beside it; views in `dashboard/web/views/*.ts` touch the DOM and are covered by typecheck plus the manual check in Task 23. Web modules only `import type` from `../src/types.ts` (erased by stripping, so the browser never fetches it).

Design direction (refined in Task 23 with `impeccable`): a calm editing-room UI — dark-first neutral surfaces with one accent (`--accent: #FFD400`, the caption highlight colour already used by the karaoke component), monospace for timestamps and logs, 4 tabs in a left rail (Studio, Inspiration, Tools, Settings), responsive to 360 px. Colour tokens on `:root` with `prefers-color-scheme` light override. Check 21st.dev community components for dropzone/stepper patterns before building (reference only, no code copied).

### Task 16: app shell, API client, typecheck split

**Files:**
- Create: `dashboard/web/tsconfig.json`, `dashboard/web/styles.css`, `dashboard/web/lib/api.ts`, `dashboard/web/lib/api.test.ts`, `dashboard/web/lib/dom.ts`
- Modify: `dashboard/web/index.html`, `dashboard/web/app.ts`, `package.json` (`typecheck`), `dashboard/src/static.test.ts` (every web module serves 200)

**Interfaces:**
- Produces:
  ```ts
  // lib/api.ts
  export function readToken(loc: { search: string }, store: Pick<Storage, "getItem" | "setItem">): string; // ?t= wins and is saved in sessionStorage key "mostudio.token"; history.replaceState drops it from the URL (in app.ts)
  export function withToken(path: string, token: string): string; // appends t= with ? or &
  export function createApi(token: string, f?: typeof fetch): {
    get<T>(path: string): Promise<T>; send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
    text(path: string): Promise<string>; putText(path: string, text: string): Promise<void>;
    upload<T>(path: string, file: Blob, onProgress: (fraction: number) => void): Promise<T>; // XMLHttpRequest PUT, header x-mostudio-token
    events(projectId: string, onEvent: (e: RunEvent) => void): () => void; // EventSource(withToken(...)), listens to all RunEvent types
    fileUrl(projectId: string, rel: string): string; };
  export class ApiFailure extends Error { constructor(public status: number, message: string) } // message = body.error
  // lib/dom.ts
  export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string | boolean | EventListener>, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K];
  // app.ts: hash router "#studio" (default) | "#inspiration" | "#tools" | "#settings"; each view module exports `mount(root: HTMLElement, api: Api): () => void` (returns unmount)
  ```
  Missing token → full-page message: `Open the link printed by "mostudio ui" (it contains your access token).`

- [ ] **Step 1: Write failing tests**

```ts
test("readToken prefers the URL and remembers it", () => {
  const store = new Map<string, string>(); const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(readToken({ search: "?t=abc" }, s), "abc");
  assert.equal(readToken({ search: "" }, s), "abc");
});
test("withToken", () => {
  assert.equal(withToken("/api/x", "T"), "/api/x?t=T");
  assert.equal(withToken("/api/x?since=3", "T"), "/api/x?since=3&t=T");
});
test("api surfaces server error text", async () => {
  const f = (async () => new Response(JSON.stringify({ error: "a run is already in progress for this project" }), { status: 409 })) as typeof fetch;
  await assert.rejects(createApi("T", f).send("POST", "/api/projects/p/run", {}), (e: ApiFailure) => e.status === 409 && /already in progress/.test(e.message));
});
// static.test.ts
test("every web module is served and strips cleanly", async () => { /* walk dashboard/web/**/*.ts excluding *.test.ts, GET each → 200 text/javascript */ });
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/api.test.ts dashboard/src/static.test.ts` → FAIL.
- [ ] **Step 3: Implement** shell (`index.html` with rail + `<main id="view">`, `styles.css` tokens + layout), `api.ts`, `dom.ts`, `app.ts` router with four empty views.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): dashboard shell, token-aware API client`

### Task 17: pipeline state and live stepper

**Files:**
- Create: `dashboard/web/lib/pipeline.ts`, `dashboard/web/lib/pipeline.test.ts`, `dashboard/web/views/stepper.ts`

**Interfaces:**
- Consumes: `RunEvent`, `ProjectStatus`, `WorkflowInfo`, `StepView` types.
- Produces:
  ```ts
  export type StepState = "idle" | "running" | "pass" | "warn" | "fail" | "cached" | "awaiting" | "interrupted";
  export type StepCard = { step: string; approve: boolean; state: StepState; startedAt?: number; durationMs?: number; result?: StepView; logs: string[] };
  export type PipelineState = { workflow?: string; mode: RunMode; running: boolean; cards: StepCard[]; lastEventId: number; error?: string };
  export function initialState(wf: WorkflowInfo, status: ProjectStatus): PipelineState; // cards from status.steps (pass/warn/fail/cached), pending → "awaiting", interrupted → "interrupted"
  export function applyEvent(s: PipelineState, e: RunEvent): PipelineState;           // pure; ignores e.id <= s.lastEventId (replay dedupe)
  export function elapsed(card: StepCard, now: number): string;                          // "m:ss" while running, durationMs when done, "" idle
  export const MAX_LOG_LINES = 400;                                                       // per card, oldest dropped
  // views/stepper.ts
  export function renderStepper(s: PipelineState, opts: { onSelect(step: string): void; selected?: string }): HTMLElement;
  ```
  `applyEvent` rules: `run-start` → running true, mode; `step-start` → card running, `startedAt = Date.parse(e.at)`, logs cleared; `log` → push to its card (or last running card); `step-end` → state from `result.status` (`cached` when `result.cached` and not fail), `durationMs`; `approved` → card state back to its result status; `run-end` → running false; `awaiting-approval` sets `stoppedAt` card to `awaiting`; `failed` with `error` and no step-end → `error` set. Steps not in the workflow (single tool runs) are appended as cards.

- [ ] **Step 1: Write failing tests**

```ts
test("live run: start, logs, end, awaiting approval", () => {
  let s = initialState(wf(["ingest", "captions*"]), emptyStatus);
  s = reduce(s, [ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }),
    ev(2, { type: "step-start", step: "ingest" }), ev(3, { type: "log", step: "ingest", message: "copied a.mov" }),
    ev(4, { type: "step-end", result: res("ingest", "pass") }), ev(5, { type: "step-start", step: "captions" }),
    ev(6, { type: "step-end", result: res("captions", "warn") }), ev(7, { type: "run-end", status: "awaiting-approval", stoppedAt: "captions" })]);
  assert.deepEqual(s.cards.map((c) => c.state), ["pass", "awaiting"]);
  assert.deepEqual(s.cards[0]!.logs, ["copied a.mov"]);
  assert.equal(s.running, false);
});
test("replayed events are ignored", () => { /* apply same id twice → logs length 1 */ });
test("approved returns the card to its result state", () => { /* awaiting + approved{captions} → "warn" */ });
test("interrupted and pending come from status", () => { /* status.interrupted ["transcribe"], pending ["captions"] → states */ });
test("elapsed", () => {
  assert.equal(elapsed({ state: "running", startedAt: 0 } as StepCard, 65_000), "1:05");
  assert.equal(elapsed({ state: "pass", durationMs: 4200 } as StepCard, 0), "0:04");
});
test("logs are capped", () => { /* 450 log events → 400 kept, last one present */ });
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/pipeline.test.ts` → FAIL.
- [ ] **Step 3: Implement** `pipeline.ts` and `views/stepper.ts` (horizontal stepper ≥ 900 px, vertical below; each card: name, state badge with text not colour alone, elapsed ticking via `requestAnimationFrame`-free 1 s interval owned by the Studio view, gate verdicts on fail/warn, "Approval needed" chip on approve steps).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): live pipeline state and stepper`

### Task 18: step output previews

**Files:**
- Create: `dashboard/web/lib/previews.ts`, `dashboard/web/lib/previews.test.ts`, `dashboard/web/views/previews.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PreviewKind = "media-info" | "video" | "audio" | "words" | "edl" | "units" | "captions" | "text" | "image" | "markdown";
  export type Preview = { kind: PreviewKind; path: string; label: string };
  export function previewsFor(step: string, status: ProjectStatus): Preview[];
  export function edlBar(edl: { keep: { start: number; end: number }[]; removed: { start: number; end: number; reason: string }[] }, total: number): { left: number; width: number; kind: "keep" | "silence" | "filler" | "retake" }[]; // percentages, sorted by left
  export function peaks(samples: Float32Array, buckets: number): Float32Array; // max |sample| per bucket, length = buckets
  export function formatTime(sec: number): string; // "mm:ss.cc"
  // views/previews.ts
  export function renderPreview(p: Preview, api: Api, projectId: string): Promise<HTMLElement>;
  ```
  Map (paths are project-relative; `media/<file>` comes from `status.media.file`):
  | step | previews |
  |---|---|
  | ingest | `media-info` `media/ingest.json`; `video` `media/<file>` |
  | transcribe | `words` `transcript/words.json` (first 300 words, `[mm:ss.cc] word`, low-confidence words (< 0.6) underlined) |
  | cut | `edl` `cut/edl.json` (bar: keep vs removed by reason + counts + `outDurationSec`) |
  | localize | `units` `localize/units.json` |
  | captions | `captions` `captions/captions.txt` + replacements editor (Task 19) |
  | mix | `audio` `audio/mix.wav` (player + canvas waveform from `peaks`) |
  | chapters | `text` `chapters/youtube.txt` |
  | assemble | `video` `renders/final.mp4` |
  | qa | `image` `renders/contact-sheet.jpg`; `markdown` `renders/qa.md` (rendered as preformatted text, no HTML injection) |
  Only steps whose latest result is pass/warn get previews. All text goes through `textContent` (never `innerHTML`).

- [ ] **Step 1: Write failing tests**

```ts
test("previewsFor maps steps to artifacts and skips failed steps", () => {
  const st = status({ ingest: "pass", cut: "fail", assemble: "warn" }, { file: "media/a.mov" });
  assert.deepEqual(previewsFor("ingest", st).map((p) => [p.kind, p.path]), [["media-info", "media/ingest.json"], ["video", "media/a.mov"]]);
  assert.deepEqual(previewsFor("cut", st), []);
  assert.deepEqual(previewsFor("assemble", st).map((p) => p.path), ["renders/final.mp4"]);
});
test("edlBar", () => {
  const bars = edlBar({ keep: [{ start: 0, end: 5 }], removed: [{ start: 5, end: 10, reason: "silence" }] }, 10);
  assert.deepEqual(bars, [{ left: 0, width: 50, kind: "keep" }, { left: 50, width: 50, kind: "silence" }]);
});
test("peaks", () => {
  assert.deepEqual([...peaks(new Float32Array([0.1, -0.5, 0.2, 0.3]), 2)].map((v) => +v.toFixed(2)), [0.5, 0.3]);
});
test("formatTime", () => { assert.equal(formatTime(65.239), "01:05.24"); });
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/previews.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules (`audio`: `fetch` → `AudioContext.decodeAudioData` → first channel → `peaks(…, canvas.width)`; video/audio elements use `api.fileUrl` so Range works).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): per-step output previews (transcript, cut bar, captions, waveform, render)`

### Task 19: Studio view — projects, upload, mode, run, approve

**Files:**
- Create: `dashboard/web/views/studio.ts`, `dashboard/web/lib/studio.ts`, `dashboard/web/lib/studio.test.ts`

**Interfaces:**
- Consumes: `createApi` (16), `initialState/applyEvent/renderStepper` (17), `previewsFor/renderPreview` (18); routes from Tasks 10–12.
- Produces:
  ```ts
  // lib/studio.ts (pure)
  export const MEDIA_EXTS: string[]; // same list as the server upload allow-list (Task 10)
  export function acceptsMedia(name: string): boolean;
  export function slugFromFileName(name: string): string; // "My Clip (final) 2.MOV" → "my-clip-final-2"; empty → "video"
  export function buildRunRequest(o: { workflow: string; mode: RunMode; source?: string; params: Record<string, Record<string, string>> }): RunRequest; // drops empty strings
  export function modeLabel(mode: RunMode): { title: string; help: string };
  ```
  `modeLabel` copy (exact): manual → `{ title: "Review each step", help: "The run pauses at review steps (captions) so you can check and fix before it continues." }`; auto → `{ title: "Auto: end to end", help: "Skips the review pauses and renders straight to the final video. A step that fails its quality check still stops the run." }`.
  View layout: left column project list + "New project" (slug input) ; main: (1) dropzone "Drop your video or audio here" (also a file button; rejects non-media with the server's message; upload progress bar from `api.upload`; a dropped file with no project selected creates one from `slugFromFileName`), (2) workflow select (`/api/workflows`), mode segmented control with `modeLabel` help text, "Start" button (disabled while running or without a source/ingested media), (3) stepper, (4) selected step panel: live logs (monospace, auto-scroll unless the user scrolled up), metrics table, gate verdicts, previews; for an `awaiting` step: replacements editor (`GET/PUT /replacements`) + buttons "Re-run captions" (`POST /steps/captions {force:true}`) and "Approve & continue" (`POST /approve {step, continue:true, mode}`). Subscribes to events on project select; unsubscribes on switch/unmount. Re-fetches `ProjectStatus` on every `run-end`.

- [ ] **Step 1: Write failing tests**

```ts
test("slugFromFileName", () => {
  assert.equal(slugFromFileName("My Clip (final) 2.MOV"), "my-clip-final-2");
  assert.equal(slugFromFileName("été à Fès.mp4"), "ete-a-fes");
  assert.equal(slugFromFileName("..."), "video");
});
test("acceptsMedia", () => { assert.equal(acceptsMedia("a.MOV"), true); assert.equal(acceptsMedia("a.pdf"), false); });
test("buildRunRequest drops empty params", () => {
  assert.deepEqual(buildRunRequest({ workflow: "short", mode: "auto", source: "uploads/a.mov", params: { localize: { lang: "arabizi", prefer: "" }, cut: { pace: "" } } }),
    { workflow: "short", mode: "auto", source: "uploads/a.mov", params: { localize: { lang: "arabizi" } } });
});
test("MEDIA_EXTS matches the server allow-list", async () => { /* import the server constant from dashboard/src/routes/projects.ts (export UPLOAD_EXTS there) and deepEqual sorted */ });
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/studio.test.ts` → FAIL.
- [ ] **Step 3: Implement** `lib/studio.ts` and `views/studio.ts` (export `UPLOAD_EXTS` from `dashboard/src/routes/projects.ts` for the parity test).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Manual check** with `node cli/bin/mostudio.ts ui` on a short real clip: upload shows progress; manual run pauses at captions; editing replacements + "Re-run captions" changes `captions.txt`; "Approve & continue" reaches qa; a second project in auto mode reaches `renders/final.mp4` without pausing; refresh mid-run keeps the stepper state.
- [ ] **Step 6: Commit** `feat(web): studio view with uploads, review/auto modes and live run`

### Task 20: Inspiration view

**Files:**
- Create: `dashboard/web/views/inspiration.ts`, `dashboard/web/lib/inspiration.ts`, `dashboard/web/lib/inspiration.test.ts`

**Interfaces:**
- Consumes: Task 9 routes.
- Produces:
  ```ts
  export function extractUrls(text: string): string[]; // every http(s) URL in pasted text, deduped, order kept
  export function shelfCopy(kind: InspirationKind): { title: string; where: string; accepts: string };
  ```
  `shelfCopy` (exact): shorts → `{ title: "Short-form (vertical)", where: "inspiration/shorts/", accepts: "Reels, Shorts, TikToks: links, clips, screenshots, notes" }`; long → `{ title: "Long-form (landscape)", where: "inspiration/long/", accepts: "YouTube videos, podcasts, interviews: links, clips, notes" }`.
  View: a paste box "Paste one or more links" → each URL `POST /api/inspiration/links` (auto-classified; the toast says `Added to Short-form` / `Added to Long-form` with an "Move" action that deletes + re-adds to the other kind); two shelves side by side (stacked < 900 px), each a dropzone showing `where` (absolute folder from `shelf.folder`, with a copy button) and `accepts`; lists links (platform label, note, remove) and files (name, size, remove). Unsupported file → inline error with the server message.

- [ ] **Step 1: Write failing tests**

```ts
test("extractUrls", () => {
  assert.deepEqual(extractUrls("look https://youtu.be/a and\nhttps://www.instagram.com/reel/X/ https://youtu.be/a"),
    ["https://youtu.be/a", "https://www.instagram.com/reel/X/"]);
  assert.deepEqual(extractUrls("no links"), []);
});
test("shelfCopy names the folder", () => { assert.equal(shelfCopy("long").where, "inspiration/long/"); });
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/inspiration.test.ts` → FAIL.
- [ ] **Step 3: Implement** lib + view.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS; manual: paste a reel link → appears under Short-form and in `inspiration/shorts/links.txt`; drop a `.mov` on Long-form → in `inspiration/long/media/`.
- [ ] **Step 5: Commit** `feat(web): inspiration view with auto-routed links and dropzones`

### Task 21: Tools view

**Files:**
- Create: `dashboard/web/views/tools.ts`, `dashboard/web/lib/tools.ts`, `dashboard/web/lib/tools.test.ts`

**Interfaces:**
- Consumes: `GET /api/tools` (13), `GET /api/projects` (10), `POST /api/projects/:id/steps/:name` (12), events (11).
- Produces:
  ```ts
  export function formToParams(params: ToolParam[], values: Record<string, string | boolean>): Record<string, string | number | boolean>; // numbers parsed, empty optional dropped, toggles as boolean, throws "<label> must be a number"
  export function missingInputs(tool: ToolInfo, status: ProjectStatus): string[]; // outputs of earlier steps the tool needs that the project lacks, by producing step name (e.g. ["transcribe"])
  ```
  `missingInputs`: a tool input path is satisfied when some step whose contract outputs that path has a pass/warn result in `status.steps`; `edits/*` is always satisfied. Output = unique producing step names in catalog order.
  View: card grid (title, summary, workflows chips, capability chip); card opens a panel with contract inputs/outputs, gate thresholds (`metric op value · level`), a param form generated from `ToolParam` (`choices` → select, `toggle` → checkbox, `file` → select of project uploads, `provider` → select of provider ids with that capability, from `/api/settings` field `providers`), project select, "Run on project" (disabled with text `Run <steps> first` when `missingInputs` is not empty; `force` checkbox "Re-run even if cached"), and a live log + result + previews (reuses Task 17/18 renderers).

- [ ] **Step 1: Write failing tests**

```ts
test("formToParams", () => {
  const ps = [p("pace", "string", true), p("maxGap", "number", true), p("retakes", "boolean", true)];
  assert.deepEqual(formToParams(ps, { pace: "tight", maxGap: "0.3", retakes: false }), { pace: "tight", maxGap: 0.3, retakes: false });
  assert.deepEqual(formToParams(ps, { pace: "", maxGap: "" }), {});
  assert.throws(() => formToParams(ps, { maxGap: "abc" }), /must be a number/);
});
test("missingInputs names the steps to run first", () => {
  assert.deepEqual(missingInputs(tool("captions"), status({ ingest: "pass", transcribe: "pass" })), ["cut", "localize"]);
  assert.deepEqual(missingInputs(tool("ingest"), status({})), []);
});
```
(`tool(name)` builds from the real catalog via `buildCatalog(defaultSteps, [], () => "")` imported from `dashboard/src/catalog.ts`.)

- [ ] **Step 2: Run** `node --test dashboard/web/lib/tools.test.ts` → FAIL.
- [ ] **Step 3: Implement** lib + view.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS; manual: run `localize` with `lang=arabizi` on an existing project → result card + units preview.
- [ ] **Step 5: Commit** `feat(web): tools catalog with per-step forms and single-step runs`

### Task 22: Settings view

**Files:**
- Create: `dashboard/web/views/settings.ts`, `dashboard/web/lib/settings.ts`, `dashboard/web/lib/settings.test.ts`

**Interfaces:**
- Consumes: Task 14 routes.
- Produces:
  ```ts
  export type ProviderGroup = { id: string; fields: SettingField[] };
  export function groupByProvider(fields: SettingField[]): { providers: ProviderGroup[]; paths: SettingField[] }; // secret/text fields grouped by first provider id (alphabetical), path fields separate
  export function dirtyValues(original: SettingField[], edits: Record<string, string>): Record<string, string>; // only changed names; "" = remove
  export function probeLabel(r: ProbeResult): { tone: "ok" | "warn" | "error"; text: string }; // ok&&verified → ok; ok&&!verified → warn; else error; text = r.message
  ```
  View: header shows `Keys are saved to <envFile> on this computer (git-ignored).` One card per provider: field rows with masked value (`gsk…1234`) or `Not set`, buttons "Reveal" (calls `/reveal`, shows plain text for 30 s then re-masks), "Edit" (password input with show/hide toggle), source badge (`.env.local` / `from environment` with the Task 14 explanation / `not set`); card footer "Test connection" (sends current unsaved edits for that provider's fields as `values`) with result line from `probeLabel` and the round-trip ms. A "Local tools" card holds path fields (WHISPER_CLI, WHISPER_MODELS_DIR, FFMPEG, FFPROBE) with a "Test whisper" button (provider `whisper-cpp`). Sticky "Save changes" bar appears when `dirtyValues` is non-empty. Inputs: `autocomplete="off"`, `spellcheck="false"`.

- [ ] **Step 1: Write failing tests**

```ts
test("groupByProvider", () => {
  const g = groupByProvider([f("GROQ_API_KEY", "secret", ["groq"]), f("CLOUDFLARE_ACCOUNT_ID", "text", ["cloudflare"]), f("CLOUDFLARE_API_TOKEN", "secret", ["cloudflare"]), f("WHISPER_CLI", "path", [])]);
  assert.deepEqual(g.providers.map((p) => [p.id, p.fields.map((x) => x.name)]), [["cloudflare", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]], ["groq", ["GROQ_API_KEY"]]]);
  assert.deepEqual(g.paths.map((x) => x.name), ["WHISPER_CLI"]);
});
test("dirtyValues", () => {
  assert.deepEqual(dirtyValues([f("A", "secret", [])], { A: "new", }), { A: "new" });
  assert.deepEqual(dirtyValues([f("A", "secret", [])], {}), {});
});
test("probeLabel", () => {
  assert.equal(probeLabel({ provider: "nvidia", ok: true, verified: false, message: "reachable; this endpoint does not check the key", ms: 80 }).tone, "warn");
  assert.equal(probeLabel({ provider: "groq", ok: false, verified: true, status: 401, message: "key rejected (401)", ms: 90 }).tone, "error");
});
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/settings.test.ts` → FAIL.
- [ ] **Step 3: Implement** lib + view.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS; manual: paste a wrong Groq key → Test → "key rejected (401)"; correct key → "connected"; Save → `.env.local` updated, other lines untouched (`git diff --no-index` against a copy).
- [ ] **Step 5: Commit** `feat(web): BYOK settings with reveal, edit and connection tests`

### Task 23: design QA, docs, end-to-end verification

**Files:**
- Modify: `dashboard/web/styles.css`, views as the audit requires; `README.md` (Getting started: `mostudio init` → `mostudio ui`; dashboard tabs; `run --auto`), `examples/README.md` (fix the wrong `mostudio new --project` example to `mostudio new <slug>`), `tasks/todo.md` (review section), `docs/moskills-value.md` (entry)

- [ ] **Step 1: Design audit** — invoke `/impeccable audit` then `/impeccable polish` on `dashboard/web/` (user rule). Fix every P0/P1: keyboard focus visible on all controls, dropzones operable by keyboard (Enter opens file picker), states not conveyed by colour alone, contrast ≥ 4.5:1 in both themes, layout works at 360 px with no horizontal scroll, `prefers-reduced-motion` respected.
- [ ] **Step 2: Full test + typecheck** — `npm test && npm run typecheck` → all PASS (paste the summary line into `tasks/todo.md`).
- [ ] **Step 3: End-to-end in a fresh workspace** (real terminal + browser):
  1. `node cli/bin/mostudio.ts init --dir /tmp/mostudio-e2e` → folders, checks, one key.
  2. `cd /tmp/mostudio-e2e && node <repo>/cli/bin/mostudio.ts ui` → open URL.
  3. Inspiration: paste a YouTube Shorts link and a long YouTube link → each in the right `links.txt`.
  4. Studio: drop a 30–60 s clip → manual `short` run pauses at captions → approve → `renders/final.mp4` plays in the browser.
  5. Same clip, new project, Auto → finishes without pause; stepper shows "approved (auto)" on captions.
  6. Kill the server during transcribe, restart → step shows interrupted; Start again recovers.
  7. Settings: test Groq, Gemini, Cloudflare; Reveal; Save.
  8. From another origin (`curl -H "Origin: https://evil.test" -H "x-mostudio-token: <t>" http://127.0.0.1:4317/api/settings`) → 403.
- [ ] **Step 4: Record** results in `tasks/todo.md` (review section) and a `docs/moskills-value.md` line.
- [ ] **Step 5: Commit** (separate commits: `style(web): impeccable audit fixes`, `docs: getting started with init and the dashboard`)

---

## Self-review record

- **Spec coverage:** R1 → Tasks 2, 4, 5 (workspace, indications on disk and on screen); R2 → 9, 20; R3 → 10, 11, 12, 17, 18, 19; R4 → 6, 12, 19 (`autoApprove`, mode toggle with honest copy); R5 → 13, 21; R6 → 1, 14, 22; system deps → 3; launch → 15; QA/docs → 23. `.env.example` keys all appear in the Task 14 schema test (ZAI and NVIDIA come from providers.json too).
- **Placeholder scan:** test bodies written as `/* … */` are one-line scenarios with their exact inputs and expected outputs; no TBD/“handle errors” lines.
- **Type consistency:** `RunMode`, `RunEvent(Body)`, `StepView`, `ProjectStatus`, `WorkflowInfo`, `ToolInfo/ToolParam/Knob`, `SettingField`, `ProbeResult`, `InspirationKind/Link/File/Shelf`, `RunRequest/StepRequest/ApproveRequest` are all defined in `dashboard/src/types.ts` and used with the same names in Part C. `updateEnvFile`/`maskSecret` (T1) used by T5/T14; `resolveShared`/`loadProvidersFile`/`findWorkspace` (T2) used by T5/T10/T14/T15; `UPLOAD_EXTS` exported in T19 from T10's file.
- **Review Focus:** each line has its test (T7 host/origin/token, T10 abort + interrupted, T11/T12 replay + 409, T1 env round-trip).
- **Known limits (accepted):** an upload is copied again by `ingest` into `media/` (2× disk for the source while the project lives); a CLI run and a dashboard run on the same project at the same time are not coordinated beyond the existing `.running` markers; NVIDIA key cannot be verified without spending its non-renewable credits.
