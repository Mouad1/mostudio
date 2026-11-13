# Plan 3 — Portable mostudio app for macOS (guided setup + local dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User rules: every `git commit` step needs the user's go-ahead first; each Part ships on its own branch; no new dependency without asking.

**Goal:** A non-technical person on a Mac downloads one zip, double-clicks **Start mostudio**, and a browser page walks them through choosing where their videos live and pasting one free API key; then they drop inspirations into the right folders, upload a video, watch every step live with its output, review steps by hand or let the run go end to end, stop a run, try single tools, and manage their keys — without ever typing a command.

**Architecture:** Four layers on top of the existing engine. (A) Core: per-user app home `~/.mostudio/` (keys, remembered workspace, preferences), workspace lookup, layered env, auto-approve, and cancellation (one `AsyncLocalStorage` signal that every child process and provider call obeys). (B) A `node:http` server bound to 127.0.0.1 behind a launch-token cookie: JSON API, Server-Sent Events for live runs, streamed uploads, Range file serving, first-run setup API. (C) A browser app in plain TypeScript modules served through `module.stripTypeScriptTypes` (no bundler). (D) A packaging script that builds `mostudio-mac-arm64.zip` and `mostudio-mac-x64.zip`, each carrying a pinned official Node runtime, a pinned static ffmpeg/ffprobe, the app source and a double-click launcher.

**Tech Stack:** Node 22.23.3 (bundled; type stripping, `node:http`, `AsyncLocalStorage`, `stripTypeScriptTypes`, global `fetch`, `fs.statfs`), node:test, vanilla DOM + `EventSource` + `XMLHttpRequest` (upload progress), macOS `open`, `tar`, `ditto`, `codesign`, `xattr`. No new npm dependencies.

**Spec:** this plan's *Requirements* and *Decisions* sections (user request and answers of 2026-11-13; no separate spec doc). Base design: `docs/superpowers/specs/2026-11-09-mostudio-design.md` (§3 constraints, §4.3 project folder, §4.5 layout). Prior plans: `docs/superpowers/plans/2026-11-09-plan-1-foundation.md`, `docs/superpowers/plans/2026-11-10-plan-2-rough-cut.md`. Red-team review of v1 of this plan by Claude Fable 5.2 (findings F1–F26) is folded in; the *Review record* at the end maps each finding to its task.

## Requirements (from the user, condensed)

- R0 **Portable, usable by non-technical people** (top priority).
- R1 After installing, the user follows indications that create *their* folders, which the app then uses.
- R2 Dashboard: see where each kind of inspiration goes and upload it so it lands in the right folder.
- R3 Upload a video and watch the work live, step by step, with each step's output.
- R4 Per run: validate steps by hand, or auto creation that bypasses step validation and goes end to end.
- R5 See available tools and apply a specific one.
- R6 Settings page for BYOK keys, with a per-provider connection test.

## Decisions (user, 2026-11-13)

- D1 Distribution: **portable zip** with Node and ffmpeg bundled. Approved: bundling the official Node binary (MIT) and a static ffmpeg build (GPL allowed; ship license text, build config and the matching source).
- D2 Platform: **macOS only** for v1 (arm64 and x64 zips). Windows/Linux are a later plan.
- D3 **Unsigned** app plus an exact "how to open" guide; no Apple Developer ID yet.
- D4 Keys live in **`~/.mostudio/.env`** by default; a workspace `.env.local` still overrides it; process env (e.g. `mostudio-bws`) overrides both.

Interpretations fixed by this plan:
- "Bypass step validation" = skip **human review pauses** (`"approve": true`, today only captions). A step that fails its quality gate (`level: "fail"`) still stops an auto run; the UI says so next to the toggle.
- The request's `edits` step is the real `cut` step (silence/filler/retake removal → `cut/edl.json`).
- Inspirations are **filed for reference only**: no step reads `inspiration/` yet. The UI says so (F25). A step that consumes them is a later plan.
- Animated HyperFrames captions need `npx` + internet + a headless browser download on first use, so in the packaged app they are an **opt-in** setting ("Animated captions"), default off → captions burn with ffmpeg/libass (bundled ffmpeg must have `ass`). Running from source keeps today's behaviour.

## Global Constraints

- Zero runtime npm dependencies; no new dev dependency. Bundled binaries limited to D1.
- macOS only (D2): code may use `open`, `xattr`, `codesign`, `ditto`, `statfs`; keep paths built with `node:path`.
- Steps import core only through `core/src/index.ts`; `dashboard/src` imports core only through `core/src/index.ts` and steps only through `steps/index.ts`.
- App home = `Config.home` (`MOSTUDIO_HOME` or `~/.mostudio`). Files there: `.env` (keys, mode `0o600`), `settings.json` (`{ workspace?: string; animatedCaptions?: boolean }`), `quota.json` (existing).
- Env precedence (low → high): `~/.mostudio/.env` < `<workspace>/.env.local` < process env. Re-read from disk for every run, so saved keys apply without restart.
- Default workspace: `~/Movies/mostudio`. The app never writes keys, projects or inspirations into its own folder.
- Server listens on `127.0.0.1` only; ports tried `4317…4327`, then any free port. Access: launch URL `/?t=<token>` sets cookie `mostudio_session=<token>; HttpOnly; SameSite=Strict; Path=/` and redirects to `/`; every `/api/*` call needs that cookie or header `x-mostudio-token` (no query-param token). `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. Mutating methods (POST/PUT/DELETE) require `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>` (absent allowed only when the header token is used). Token compare with `timingSafeEqual`.
- Every response: `x-content-type-options: nosniff`; HTML gets `content-security-policy: default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`. Project files with `.svg`/`.html` are served `content-disposition: attachment`.
- Uploads stream to disk via temp file + rename (`writeOutputAtomic`); free space must be ≥ 2.2 × `content-length` (upload + ingest copy) or 507.
- User-facing copy: English, sentence case, no CLI flags, env names only on the Settings page. Raw engine errors appear only under a "Details" disclosure (F12).
- Never use TypeScript parameter properties (`constructor(public x)`): `erasableSyntaxOnly` forbids them and Node refuses them (F3).
- Frontend tasks end with an `impeccable` audit (user rule).
- Unchanged: step contracts, `approvals.json`, `workflow-params.json`, `run.json`, the CLI commands that exist today.
- Branches: Part A `feat/app-foundations` (Tasks 1–6), Part B `feat/dashboard-server` (7–16), Part C `feat/dashboard-ui` (17–25), Part D `feat/mac-portable` (26–28). Start Part A from `main` after `feat/darija-caption-lang` is merged (it has uncommitted work today).

## Review Focus

1. A web page on another site (or a DNS-rebinding host) calls the local server → 401/403, never a key or a run → tests in Task 7.
2. The release zip must never contain the developer's `.env.local`, `projects/`, `inspiration/` or `.claude/` → test in Task 26.
3. Browser tab closed halfway through a 4 GB upload → no partial file, memory flat; disk too small → refused before writing → tests in Task 10.
4. Stop pressed during a 20-minute transcribe/assemble → ffmpeg/whisper children die within 2 s, step recorded as `cancelled by user`, project usable for the next run → tests in Tasks 4 and 12.
5. Page refresh / second tab mid-run → same live state (cookie + event replay), second Start refused (409); app quit mid-step → reopened project shows the step as interrupted, not running → tests in Tasks 10, 11, 12.

## File map

| File | Responsibility |
|---|---|
| `core/src/envfile.ts` | `updateEnvFile`, `formatEnvValue`, `maskSecret` |
| `core/src/workspace.ts` | `PACKAGE_ROOT`, `findWorkspace`, `resolveShared`, `listWorkflowFiles`, `loadProvidersFile`, `readAppSettings`, `writeAppSettings`, `loadLayeredEnv`, `defaultWorkspace` |
| `core/src/config.ts` (mod) | `Config.inspirationRoot` |
| `core/src/workflow.ts` (mod) | `autoApprove`, `onStepStart`, `onApprove`, `signal`, `stepParams` |
| `core/src/proc.ts` (mod) | `runWithSignal`, `currentSignal`, `CancelledError`; children killed on abort |
| `core/src/system.ts` | `checkSystem` |
| `core/src/scaffold.ts` | `scaffoldWorkspace` (folders + on-disk indications) |
| `cli/src/main.ts` (mod) | `init`, `ui`, `run --auto`, layered env, workspace lookup |
| `dashboard/src/*.ts` | server (see each task) |
| `dashboard/web/**` | browser app |
| `scripts/package-mac.ts`, `packaging/**` | release zips, launcher, guide, lock file, licenses |

---

## Part A — Core foundations (branch `feat/app-foundations`)

### Task 1: core — env file writer and secret masking

**Files:** Create `core/src/envfile.ts`, `core/src/envfile.test.ts`; Modify `core/src/index.ts`.

**Interfaces:**
- Consumes: `loadEnvFile(path)` (`core/src/config.ts`, unchanged).
- Produces:
  - `updateEnvFile(path: string, updates: Record<string, string | null>): Promise<void>` — `null` or `""` removes; creates parent dir and file (mode `0o600`).
  - `formatEnvValue(value: string): string`
  - `maskSecret(value: string): string`

- [ ] **Step 1: Write the failing tests** in `core/src/envfile.test.ts`

```ts
test("replaces in place and keeps every other line byte-for-byte", async () => {
  const p = tmpFile("# keys\nexport GROQ_API_KEY=old # mine\nOTHER='x y'\n\nZZZ=1\n");
  await updateEnvFile(p, { GROQ_API_KEY: "gsk_new" });
  assert.equal(readFileSync(p, "utf8"), "# keys\nGROQ_API_KEY=gsk_new\nOTHER='x y'\n\nZZZ=1\n");
});
test("appends new keys with one trailing newline", async () => {
  const p = tmpFile("A=1");
  await updateEnvFile(p, { B: "2" });
  assert.equal(readFileSync(p, "utf8"), "A=1\nB=2\n");
});
test("null and empty string remove the key; duplicates collapse to the first", async () => {
  const p = tmpFile("A=1\nB=2\nA=3\n");
  await updateEnvFile(p, { B: "", A: "9" });
  assert.equal(readFileSync(p, "utf8"), "A=9\n");
});
test("tricky values round-trip through loadEnvFile", async () => {
  const p = tmpFile("");
  const tricky = { S: "a b", H: "pa#ss", Q: `say "x"`, A: "it's", E: "=lead" };
  await updateEnvFile(p, tricky);
  assert.deepEqual(loadEnvFile(p), tricky);
});
test("creates a missing file (and folder) with mode 0600", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "env-")), "home", ".env");
  await updateEnvFile(p, { A: "1" });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});
test("rejects bad names, newlines and values with both quote kinds", async () => {
  const p = tmpFile("");
  await assert.rejects(updateEnvFile(p, { "BAD-NAME": "1" }), /invalid env name: BAD-NAME/);
  await assert.rejects(updateEnvFile(p, { A: "x\ny" }), /newline in value of A/);
  await assert.rejects(updateEnvFile(p, { A: `it's "x"` }), /both quote kinds/);
});
test("maskSecret", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("short123"), "••••");
  assert.equal(maskSecret("gsk_abcdefgh1234"), "gsk…1234");
});
```

- [ ] **Step 2: Run** `node --test core/src/envfile.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `core/src/envfile.ts`.** A line owns key K when it matches `loadEnvFile`'s regex `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/`. First owning line → `K=<formatEnvValue(v)>` (drops `export` and inline comment), later owning lines removed; removals delete all owning lines; new keys appended in insertion order. `formatEnvValue`: bare if `/^[A-Za-z0-9_./:@+,-]+$/`; else `'…'` if no `'`; else `"…"` if no `"`; else throw `cannot store a value with both quote kinds`. Names `/^[A-Za-z_][A-Za-z0-9_]*$/`, values without `\r`/`\n`. Write `<path>.<pid>.tmp` with `{ mode: 0o600 }`, rename, `chmod 0o600`. Output ends with one `\n` unless empty.
- [ ] **Step 4: Export** the three functions from `core/src/index.ts`.
- [ ] **Step 5: Run** `node --test core/src/envfile.test.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(core): env file writer that keeps hand edits, secret masking`

### Task 2: core — app home, workspace lookup, layered env

**Files:** Create `core/src/workspace.ts`, `core/src/workspace.test.ts`; Modify `core/src/config.ts` (+ test), `core/src/index.ts`, `cli/src/main.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  export const PACKAGE_ROOT: string;                                   // resolve(import.meta.dirname, "..", "..")
  export function findWorkspace(start: string): string | undefined;    // nearest ancestor (inclusive) with mostudio.config.json
  export function defaultWorkspace(): string;                          // join(homedir(), "Movies", "mostudio")
  export function resolveShared(root: string | undefined, rel: string): string; // workspace copy if it exists, else PACKAGE_ROOT copy
  export function listWorkflowFiles(root: string | undefined): Promise<Record<string, string>>; // name -> abs path; package files, then workspace files override per name (F21)
  export function loadProvidersFile(root: string | undefined): Promise<ProviderEntry[]>; // moved from cli/src/main.ts#loadProviders, same error texts
  export type AppSettings = { workspace?: string; animatedCaptions?: boolean };
  export function readAppSettings(home: string): Promise<AppSettings>;            // {} when missing
  export function writeAppSettings(home: string, patch: Partial<AppSettings>): Promise<AppSettings>; // merge + writeJsonAtomic
  export function loadLayeredEnv(o: { home: string; root?: string; processEnv: Record<string, string> }):
    { env: Record<string, string>; sources: Record<string, "app" | "workspace" | "process"> };
  ```
  `Config.inspirationRoot` (absolute; key `inspirationRoot`, default `"inspiration"`; non-string → `mostudio.config.json: inspirationRoot must be a string`).
  CLI: `rootOf(io): Promise<string | undefined>` = `io.root` → `MOSTUDIO_ROOT` → `findWorkspace(io.cwd)` → `readAppSettings(home).workspace` (if it still has `mostudio.config.json`) → `undefined`. Commands that need a workspace and get `undefined` exit 1 with `No workspace yet. Open the mostudio app (or run: mostudio init).` The CLI env becomes `loadLayeredEnv(...).env`; the redactor gets all three layers. `PACKAGE_ROOT` is never a workspace unless it holds `mostudio.config.json` (true in the dev repo, false in the zip) (F4).

- [ ] **Step 1: Write failing tests**

```ts
test("findWorkspace walks up; undefined outside any workspace", () => {
  const ws = tmpDir(); writeFileSync(join(ws, "mostudio.config.json"), "{}");
  mkdirSync(join(ws, "projects", "a"), { recursive: true });
  assert.equal(findWorkspace(join(ws, "projects", "a")), ws);
  assert.equal(findWorkspace(tmpDir()), undefined);
});
test("workflows merge per file, workspace wins by name", async () => {
  const ws = tmpDir(); mkdirSync(join(ws, "workflows"));
  writeFileSync(join(ws, "workflows", "short.json"), "{}");
  writeFileSync(join(ws, "workflows", "mine.json"), "{}");
  const files = await listWorkflowFiles(ws);
  assert.equal(files.short, join(ws, "workflows", "short.json"));
  assert.equal(files["rough-cut"], join(PACKAGE_ROOT, "workflows", "rough-cut.json"));
  assert.ok(files.mine);
});
test("layered env: app < workspace < process, with sources", () => {
  const home = tmpDir(), ws = tmpDir();
  writeFileSync(join(home, ".env"), "A=app\nB=app\nC=app\n");
  writeFileSync(join(ws, ".env.local"), "B=ws\nC=ws\n");
  const { env, sources } = loadLayeredEnv({ home, root: ws, processEnv: { C: "proc" } });
  assert.deepEqual([env.A, env.B, env.C], ["app", "ws", "proc"]);
  assert.deepEqual([sources.A, sources.B, sources.C], ["app", "workspace", "process"]);
});
test("app settings merge and persist", async () => {
  const home = tmpDir();
  await writeAppSettings(home, { workspace: "/w" });
  assert.deepEqual(await writeAppSettings(home, { animatedCaptions: true }), { workspace: "/w", animatedCaptions: true });
});
test("inspirationRoot default and override", async () => { /* {} → <ws>/inspiration; {"inspirationRoot":"refs"} → <ws>/refs */ });
// cli/src/main.test.ts
test("a command outside any workspace explains how to start", async () => { /* io.root undefined, cwd empty tmp, empty MOSTUDIO_HOME → `status --project x` exits 1; err() matches /No workspace yet\. Open the mostudio app/ */ });
test("keys in ~/.mostudio/.env are known to the redactor", async () => { /* MOSTUDIO_HOME/.env has GROQ_API_KEY=gsk_home_123456; fake-throw step echoes it → err() contains [redacted], not the key */ });
```

- [ ] **Step 2: Run** `node --test core/src/workspace.test.ts core/src/config.test.ts cli/src/main.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement** `workspace.ts`, `loadConfig` change, CLI rewiring (`listWorkflows` → `listWorkflowFiles`; workflow reads use its paths; `loadEnvFile(root/.env.local)` → `loadLayeredEnv`).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS (existing tests pass `io.root`).
- [ ] **Step 5: Commit** `feat(core): per-user app home, workspace lookup, layered env`

### Task 3: core — auto-approve, step hooks, effective params

**Files:** Modify `core/src/workflow.ts` (+ `core/src/workflow.test.ts`), `core/src/index.ts`, `cli/src/main.ts` (+ test), `README.md` (usage).

**Interfaces:**
- Produces (on `RunWorkflowOptions`): `autoApprove?: boolean`, `onStepStart?: (step: string) => void`, `onApprove?: (step: string, auto: boolean) => void`.
  - `export function stepParams(projectDir: string, wf: Workflow, step: string): Promise<Record<string, unknown>>` — workflow entry params merged with remembered params (same merge `runWorkflow` uses; `{}` if the step is not in `wf`).
  - Export `checkParams` from `core/src/index.ts` (F16).
  - CLI: `mostudio run … --auto` (prints `auto-approved <step>` to stderr).
  Semantics: at an `approve: true` entry not yet approved for the result's `inputsHash`, `autoApprove` calls `approveStep`, then `onApprove(step, true)`, and continues. A `fail` result still returns `{ status: "failed" }`. `onStepStart` fires before each `runStep`.

- [ ] **Step 1: Write failing tests** (use the file's existing helpers `base()` and `fake(name, over)`)

```ts
test("autoApprove records approval and runs to the end", async () => {
  const approved: string[] = [], started: string[] = [];
  const wf = { name: "t", steps: [{ step: "a" }, { step: "b", approve: true }, { step: "c" }] };
  const r = await runWorkflow(dir, wf, { a: fake("a"), b: fake("b"), c: fake("c") },
    { ...base(), autoApprove: true, onApprove: (s, auto) => approved.push(`${s}:${auto}`), onStepStart: (s) => started.push(s) });
  assert.equal(r.status, "done");
  assert.deepEqual(approved, ["b:true"]);
  assert.deepEqual(started, ["a", "b", "c"]);
});
test("autoApprove never skips a failing gate", async () => {
  const wf = { name: "t", steps: [{ step: "x" }, { step: "c" }] };
  const r = await runWorkflow(dir, wf, { x: fake("x", { fail: true }), c: fake("c") }, { ...base(), autoApprove: true });
  assert.deepEqual([r.status, r.stoppedAt], ["failed", "x"]);
});
test("stepParams merges workflow entry and remembered params", async () => {
  // wf entry b has params {style:"short"}; run once with cliParams {b:{n:"2"}} → stepParams(dir, wf, "b") deepEquals {style:"short", n:"2"}
});
// cli/src/main.test.ts
test("run --auto passes the approve step and logs it", async () => { /* workflows/t.json with captions approve:true → exit 0; err() matches /auto-approved captions/ */ });
```

- [ ] **Step 2: Run** `node --test core/src/workflow.test.ts cli/src/main.test.ts` → FAIL.
- [ ] **Step 3: Implement** (factor the remembered-params merge into one internal function used by both `runWorkflow` and `stepParams`).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(workflow): auto-approve runs, step hooks, effective step params`

### Task 4: core — cancellation that reaches every child process

**Files:** Modify `core/src/proc.ts` (+ `core/src/proc.test.ts`), `core/src/providers/openai-compat.ts` (+ test), `core/src/providers/call.ts` (+ test), `core/src/step.ts` (+ test), `core/src/workflow.ts` (+ test), `core/src/index.ts`.

**Interfaces:**
- Produces:
  ```ts
  // proc.ts
  export class CancelledError extends Error { constructor() { super("cancelled by user"); this.name = "CancelledError"; } }
  export function runWithSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>; // AsyncLocalStorage scope
  export function currentSignal(): AbortSignal | undefined;
  // RunStepOptions.signal?: AbortSignal   RunWorkflowOptions.signal?: AbortSignal
  ```
  Behaviour: `execCapture` passes `signal: currentSignal()` to `execFile` (`killSignal: "SIGTERM"`, then `SIGKILL` after 1.5 s if still alive) and maps the abort to `CancelledError`. Provider requests use `AbortSignal.any([AbortSignal.timeout(ms), currentSignal()].filter(Boolean))`; an abort maps to `CancelledError`, which `withProvider` rethrows unchanged (no retry, no rotation, no quota use). `runStep` wraps `mod.run` in `runWithSignal(opts.signal)` when given; a `CancelledError` records `status: "fail"`, `error: "cancelled by user"` and removes the `.running` marker. `runWorkflow` checks `signal.aborted` before each step and returns `{ status: "failed", stoppedAt: <next step> }` with a recorded cancel result. Steps need no change: they spawn only through `core/src/proc.ts` (verified: the only `child_process` importer).

- [ ] **Step 1: Write failing tests**

```ts
test("aborting kills the child quickly", async () => {
  const ac = new AbortController(); const t0 = Date.now();
  const p = runWithSignal(ac.signal, () => runBin("sleep", ["30"]));
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, CancelledError);
  assert.ok(Date.now() - t0 < 2000);
});
test("provider calls stop on abort and are not rotated", async () => { /* fetch stub resolves only when its signal aborts → rejects CancelledError; withProvider over 2 providers calls fetch once */ });
test("runStep records cancelled by user and clears the marker", async () => {
  // fake step runs runBin("sleep",["30"]); abort after 100 ms → status "fail", error "cancelled by user", no steps/<name>.running
});
test("runWorkflow stops before the next step once aborted", async () => { /* abort in onStep of a → onStepStart never called for b */ });
```

- [ ] **Step 2: Run** `node --test core/src/proc.test.ts core/src/step.test.ts core/src/workflow.test.ts core/src/providers/call.test.ts core/src/providers/openai-compat.test.ts` → FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(core): cancel runs; abort reaches ffmpeg, whisper and provider calls`

### Task 5: core — system check

**Files:** Create `core/src/system.ts`, `core/src/system.test.ts`; Modify `core/src/index.ts`.

**Interfaces:**
- Consumes: `resolveBin`, `runBin` (core).
- Produces:
  ```ts
  export type CheckName = "node" | "ffmpeg" | "ffprobe" | "captions-burn" | "whisper" | "animated-captions";
  export type Check = { name: CheckName; label: string; ok: boolean; required: boolean; detail: string; fix?: string };
  export type SystemDeps = { nodeVersion: string; packaged: boolean;
    run: (bin: string, args: string[]) => Promise<string>; listDir: (path: string) => string[] };
  export function checkSystem(env: Record<string, string | undefined>, deps?: Partial<SystemDeps>): Promise<Check[]>;
  export function versionAtLeast(actual: string, min: string): boolean;
  ```
  Order and labels: node `App runtime`, ffmpeg `Video engine (ffmpeg)`, ffprobe `Media reader (ffprobe)`, captions-burn `Caption burn-in`, whisper `Offline transcription (optional)`, animated-captions `Animated captions (optional)`. Required: node (≥ 22.18), ffmpeg, ffprobe, captions-burn (`ffmpeg -hide_banner -filters` lists ` ass `). Optional: whisper (`whisper-cli --help` ok and `WHISPER_MODELS_DIR` has `ggml-*.bin`), animated-captions (`npx --version` ok; detail `downloads its renderer the first time; needs internet`).
  `fix`: packaged → `Reinstall mostudio: download the latest zip and replace the folder.` for node/ffmpeg/ffprobe/captions-burn; source → `install Node 22.18 or newer from nodejs.org` / `brew install ffmpeg` / `brew install ffmpeg-full` (captions-burn). whisper → `Optional. Cloud transcription works without it.`. `packaged` default = `env.MOSTUDIO_PACKAGED === "1"`. ffmpeg/ffprobe binaries come from `resolveBin(name, env)`.

- [ ] **Step 1: Write failing tests**

```ts
test("versionAtLeast", () => {
  assert.equal(versionAtLeast("v22.18.0", "22.18"), true);
  assert.equal(versionAtLeast("v22.9.1", "22.18"), false);
  assert.equal(versionAtLeast("v24.0.0", "22.18"), true);
});
test("ffmpeg without libass fails captions-burn with the source fix", async () => {
  const checks = await checkSystem({}, { nodeVersion: "v22.23.3", packaged: false, listDir: () => [],
    run: async (_b, args) => (args.includes("-filters") ? " scale V->V" : "ffmpeg version 7.1") });
  const c = checks.find((x) => x.name === "captions-burn")!;
  assert.deepEqual([c.ok, c.required, c.fix], [false, true, "brew install ffmpeg-full"]);
  assert.deepEqual(checks.map((x) => x.name), ["node", "ffmpeg", "ffprobe", "captions-burn", "whisper", "animated-captions"]);
});
test("packaged fix text never mentions brew", async () => { /* ffmpeg run throws → fix === "Reinstall mostudio: download the latest zip and replace the folder." */ });
test("FFMPEG env override is probed; whisper optional", async () => { /* env {FFMPEG:"/opt/ff"} → run called with "/opt/ff"; whisper.required === false */ });
```

- [ ] **Step 2: Run** `node --test core/src/system.test.ts` → FAIL.
- [ ] **Step 3: Implement** (15 s timeout per probe; probes in parallel).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core): system check with plain-language labels and fixes`

### Task 6: core — workspace scaffold + `mostudio init`

**Files:** Create `core/src/scaffold.ts`, `core/src/scaffold.test.ts`; Modify `core/src/index.ts`, `cli/src/main.ts` (+ test), `examples/README.md` (fix `mostudio new --project …` → `mostudio new <slug>`; `ingest/source.mp4` → `media/<file>`; `transcribe/` → `transcript/`) (F20).

**Interfaces:**
- Produces:
  ```ts
  export type ScaffoldEntry = { path: string; status: "created" | "kept"; purpose: string };
  export function scaffoldWorkspace(dir: string): Promise<ScaffoldEntry[]>;
  ```
  Creates only when absent (`flag: "wx"`, `EEXIST` → kept), in order:
  | path | purpose |
  |---|---|
  | `mostudio.config.json` = `{"billing":"free-only","projectsRoot":"projects","inspirationRoot":"inspiration"}` | `settings for this workspace` |
  | `projects/README.md` | `your video projects, one folder per video` |
  | `inspiration/shorts/links.txt`, `inspiration/shorts/media/`, `inspiration/shorts/README.md` | `vertical references: Reels, Shorts, TikToks` |
  | `inspiration/long/links.txt`, `inspiration/long/media/`, `inspiration/long/README.md` | `landscape references: YouTube, podcasts` |
  | `.gitignore` (only when `dir/.git` exists; append missing lines `.env.local`, `projects/`, `inspiration/**/media/`) | `keeps keys and footage out of git` |
  `links.txt` header: shorts `# Shorts I like: one link per line. Add a note after the link with " # ".`; long `# Long videos I like: one link per line. Add a note after the link with " # ".`
  `inspiration/<kind>/README.md` (exact; `<Kind>` = `Short-form` / `Long-form`):
  ```
  # <Kind> inspiration

  - Links: one per line in links.txt, or paste them in the mostudio app (Inspiration).
  - Clips and screenshots: put them in the media folder. They stay on this computer and are never used inside your videos.
  - Notes: any .md or .txt file next to links.txt (hook ideas, pacing, style).

  mostudio keeps these for your reference; it does not read them automatically yet.
  ```
  `projects/README.md`: `# Projects\n\nOne folder per video. Create one in the mostudio app (Studio) or with \`mostudio new <slug>\`. Your footage is copied into <project>/media/ when a run starts.\n`
  CLI: `mostudio init [--dir <path>]` (non-interactive; default `defaultWorkspace()`), prints one line per entry (`  + <path padded to 24> <purpose>` or `  = <path> (kept)`), then `checkSystem` lines (`  ✓ <label>` / `  ✗ <label>: <detail>` + `      fix: <fix>`), saves `workspace` into app settings, ends with `Next: mostudio ui`. Exit 0 unless a write fails. Tests inject check deps via optional `io.system?: Partial<SystemDeps>`.

- [ ] **Step 1: Write failing tests**

```ts
test("scaffold creates once, then keeps", async () => {
  const ws = tmpDir();
  assert.ok((await scaffoldWorkspace(ws)).every((e) => e.status === "created"));
  assert.ok(existsSync(join(ws, "inspiration/shorts/media")));
  assert.match(readFileSync(join(ws, "inspiration/long/README.md"), "utf8"), /does not read them automatically yet/);
  assert.ok((await scaffoldWorkspace(ws)).every((e) => e.status === "kept"));
});
test("never overwrites existing links or config", async () => { /* pre-write links.txt + config → bytes unchanged */ });
test("no .gitignore outside a git repo; only missing lines inside one", async () => { /* no .git → no file; .git + ".env.local\n" → .env.local once, projects/ added */ });
test("path with spaces and accents", async () => { /* join(tmp, "Mes vidéos été") → config exists */ });
// cli
test("init --dir scaffolds, remembers the workspace, prints next step", async () => { /* exit 0; readAppSettings(home).workspace === dir; out() matches /Next: mostudio ui/ */ });
```

- [ ] **Step 2: Run** `node --test core/src/scaffold.test.ts cli/src/main.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: workspace scaffold with folder indications, mostudio init`

---

## Part B — Dashboard server (branch `feat/dashboard-server`)

Tests start a real server on port 0 against temp `home` + workspace (`mostudio.config.json`, `workflows/t.json`) with fake steps, and call it with global `fetch`. `dashboard/src/testkit.ts` (Task 7, extended by later tasks) exports `startTestDashboard(o?: { steps?; fetch?; processEnv?; noWorkspace?: boolean; packaged?: boolean }): Promise<{ base; token; ws; home; api(path, init?): Promise<Response>; idle(id): Promise<void>; events(id): RunEvent[]; close(): Promise<void> }>` (`api` sends `x-mostudio-token` and `origin: base`).

### Task 7: server core — router, guard, cookie session, lifecycle

**Files:** Create `dashboard/src/types.ts`, `dashboard/src/http.ts` (+ test), `dashboard/src/context.ts`, `dashboard/src/server.ts` (+ test), `dashboard/src/testkit.ts`; Modify `tsconfig.json` (`include` += `"dashboard/src"`).

**Interfaces:**
- Produces:
  ```ts
  // http.ts
  export type Req = IncomingMessage; export type Res = ServerResponse;
  export type Handler = (req: Req, res: Res, params: Record<string, string>, url: URL) => Promise<void> | void;
  export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
  export function matchRoute(pattern: string, path: string): Record<string, string> | undefined; // ":x" one segment; trailing "*" rest; bad % escape → HttpError 400
  export class Router { add(method: string, pattern: string, h: Handler): void; handle(req: Req, res: Res, url: URL): Promise<boolean> }
  export function sendJson(res: Res, status: number, body: unknown): void;
  export function readJsonBody<T>(req: Req, maxBytes?: number): Promise<T>; // default 1 MiB; 400 invalid, 413 too large
  export function checkAccess(req: Req, port: number, token: string): void; // Global Constraints; 403 host/origin, 401 token
  export function sessionCookie(token: string): string;
  // context.ts
  export type DashboardContext = { home: string; root: string | undefined; port: number; token: string; packaged: boolean; version: string;
    steps: Record<string, StepModule>; processEnv: Record<string, string>; fetch: typeof fetch;
    openPath: (p: string, reveal: boolean) => Promise<void> };            // default: runBin("open", reveal ? ["-R", p] : [p])
  export function requireRoot(ctx: DashboardContext): string;            // HttpError(409, "setup needed")
  export function runtime(ctx: DashboardContext): Promise<{ root: string; config: Config; env: Record<string, string>;
    sources: Record<string, "app" | "workspace" | "process">; providers: ProviderRegistry }>;
  // server.ts
  export type DashboardOptions = { home?: string; root?: string; port?: number; steps?: Record<string, StepModule>;
    processEnv?: Record<string, string>; fetch?: typeof fetch; token?: string; packaged?: boolean;
    openPath?: DashboardContext["openPath"] };
  export function startDashboard(o: DashboardOptions): Promise<{ url: string; port: number; token: string; ctx: DashboardContext; close(): Promise<void> }>;
  ```
  `GET /?t=<token>` valid → 302 to `/` + `Set-Cookie: sessionCookie(token)`; invalid → 401 page `This link has expired. Close this tab and start mostudio again.` `GET /api/health` → `{ ok: true, version, root: string | null }`. Unknown `/api/*` → 404 `{ error: "not found" }`. Non-`HttpError` → 500 `{ error: redacted }` (redactor over all env layers). Port: `o.port` given → only that port (busy → reject `EADDRINUSE`); else 4317…4327 then 0 (F11). `close()` aborts running jobs (Task 11 hook), `server.closeAllConnections()`, resolves when closed (F10). `startDashboard` calls `stripTypeScriptTypes("")` once so any experimental warning prints at launch. `version` from `PACKAGE_ROOT/package.json`.

- [ ] **Step 1: Write failing tests**

```ts
test("matchRoute", () => {
  assert.deepEqual(matchRoute("/api/projects/:id", "/api/projects/2026-a"), { id: "2026-a" });
  assert.deepEqual(matchRoute("/api/projects/:id/files/*", "/api/projects/p/files/a/b%20c.mp4"), { id: "p", "*": "a/b c.mp4" });
  assert.equal(matchRoute("/api/projects/:id", "/api/projects/a/b"), undefined);
  assert.throws(() => matchRoute("/api/projects/:id", "/api/projects/%E0%A4%A"), (e: HttpError) => e.status === 400);
});
test("launch link sets the session cookie; API accepts the cookie, not a query token", async () => {
  const d = await startTestDashboard();
  const r = await fetch(`${d.base}/?t=${d.token}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /mostudio_session=.+; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await fetch(`${d.base}/api/health`, { headers: { cookie: cookie.split(";")[0]! } })).status, 200);
  assert.equal((await fetch(`${d.base}/api/health`)).status, 401);
  assert.equal((await fetch(`${d.base}/api/health?t=${d.token}`)).status, 401);
  await d.close();
});
test("foreign Host or Origin is refused even with the token", async () => {
  const d = await startTestDashboard(); const port = new URL(d.base).port;
  assert.equal(await rawRequest(port, "GET", "/api/health", { host: `evil.test:${port}`, "x-mostudio-token": d.token }), 403);
  assert.equal((await d.api("/api/health", { method: "POST", headers: { origin: "https://evil.test" } })).status, 403);
  await d.close();
});
test("binds 127.0.0.1 and falls back when 4317 is busy", async () => { /* occupy 4317 → startDashboard({}) gets another port; server address === "127.0.0.1" */ });
test("close() returns while a client holds a streaming response", async () => { /* test-only route that never ends; close() resolves < 1 s */ });
test("errors never leak a key", async () => { /* processEnv {GROQ_API_KEY:"gsk_secret_123456"}; route throws with it → body.error contains "[redacted]" */ });
```
(`rawRequest` uses `node:http.request` because `fetch` forbids setting `host`.)

- [ ] **Step 2: Run** `node --test dashboard/src/http.test.ts dashboard/src/server.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat(dashboard): local server with session cookie and host/origin guard`

### Task 8: static web serving, Range files, safe paths

**Files:** Create `dashboard/src/static.ts` (+ test), `dashboard/src/files.ts` (+ test), `dashboard/web/index.html`, `dashboard/web/app.ts`, `dashboard/web/lib/fixture-typed.ts` (`export const n: number = 1; export function f(a: string): string { return a; }`); Modify `dashboard/src/server.ts`.

**Interfaces:**
- Produces:
  ```ts
  // static.ts
  export const WEB_ROOT: string; // join(PACKAGE_ROOT, "dashboard", "web")
  export function contentType(path: string): string; // .html text/html; charset=utf-8 · .ts/.js text/javascript · .css text/css · .json application/json · .mp4 video/mp4 · .mov video/quicktime · .webm video/webm · .wav audio/wav · .mp3 audio/mpeg · .m4a audio/mp4 · .jpg/.jpeg image/jpeg · .png image/png · .webp image/webp · .srt/.ass/.txt/.md text/plain; charset=utf-8 · else application/octet-stream
  export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined;
  export function serveWeb(req: Req, res: Res, url: URL): Promise<boolean>; // "/" → index.html; .ts stripped (mode "strip"), cached by mtime; *.test.ts → 404
  export function serveFile(req: Req, res: Res, absPath: string): Promise<void>; // 200 / 206 single range / 416; Accept-Ranges; .svg/.html → attachment
  // files.ts
  export function insideDir(dir: string, rel: string): Promise<string>; // rejects "..", absolute, NUL; realpath of deepest existing ancestor must stay inside realpath(dir); HttpError(400,"path escapes folder")
  export function safeFileName(name: string): string;                  // basename, strip control chars + leading dots, trim, ≤120 chars keeping extension; "" → HttpError(400,"bad file name")
  export function uniquePath(dir: string, name: string): Promise<string>; // "a.mov" → "a (2).mov" → "a (3).mov"
  export function ensureSpace(dir: string, bytes: number): Promise<void>; // statfs; bavail*bsize < bytes → HttpError(507,"Not enough free disk space: need <X> GB, have <Y> GB")
  export function saveStream(req: Req, finalPath: string): Promise<number>; // needs content-length (else 411); ensureSpace(dir, 2.2×len); pipeline into writeOutputAtomic tmp; abort → tmp removed, HttpError(400,"upload interrupted")
  ```
  Security headers per Global Constraints on every response.

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
test("insideDir refuses escapes, including through a symlink", async () => {
  const d = tmpDir(); symlinkSync("/etc", join(d, "link"));
  await assert.rejects(insideDir(d, "../x"), /escapes/);
  await assert.rejects(insideDir(d, "/etc/passwd"), /escapes/);
  await assert.rejects(insideDir(d, "link/hosts"), /escapes/);
  assert.equal(await insideDir(d, "renders/new.mp4"), join(realpathSync(d), "renders/new.mp4"));
});
test("safeFileName and uniquePath", async () => {
  assert.equal(safeFileName("../../My clip été.MOV"), "My clip été.MOV");
  assert.equal(safeFileName("\u0000.hidden"), "hidden");
  assert.throws(() => safeFileName("..."), /bad file name/);
  const d = tmpDir(); writeFileSync(join(d, "a.mov"), "");
  assert.equal(await uniquePath(d, "a.mov"), join(d, "a (2).mov"));
});
test("typed web modules are served as JavaScript without types, with security headers", async () => {
  const d = await startTestDashboard();
  const r = await fetch(`${d.base}/lib/fixture-typed.ts`);
  assert.equal(r.headers.get("content-type"), "text/javascript");
  assert.doesNotMatch(await r.text(), /:\s*(string|number)\b/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match((await fetch(`${d.base}/`)).headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal((await fetch(`${d.base}/../package.json`)).status, 404);
  await d.close();
});
```

- [ ] **Step 2: Run** `node --test dashboard/src/static.test.ts dashboard/src/files.test.ts` → FAIL.
- [ ] **Step 3: Implement**; register `serveWeb` as the fallback for non-`/api` GETs.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): serve web modules and media safely (Range, CSP, path checks)`

### Task 9: inspiration API + Show in Finder

**Files:** Create `dashboard/src/inspiration.ts` (+ test), `dashboard/src/routes/inspiration.ts` (+ test), `dashboard/src/routes/finder.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/types.ts`.

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type InspirationKind = "shorts" | "long";
  export type InspirationLink = { url: string; note?: string; platform: "youtube" | "instagram" | "tiktok" | "x" | "facebook" | "other" };
  export type InspirationFile = { name: string; path: string /* relative to inspirationRoot */; sizeBytes: number; kind: "media" | "note" };
  export type InspirationShelf = { kind: InspirationKind; folder: string; links: InspirationLink[]; files: InspirationFile[] };
  // inspiration.ts (pure)
  export function listLinks(text: string): InspirationLink[];
  export function addLink(text: string, url: string, note?: string): string;   // dedupe by URL; appends `${url}${note ? `  # ${note}` : ""}\n`
  export function removeLink(text: string, url: string): string;
  export function classifyLink(url: string): InspirationKind;
  export function platformOf(url: string): InspirationLink["platform"];
  export function routeInspirationFile(kind: InspirationKind, name: string): string; // "<kind>/media/<name>" | "<kind>/<name>"
  ```
  `classifyLink` (host without `www.`/`m.`/`vm.`): `youtube.com/shorts/…`, `instagram.com/reel(s)/…`, `tiktok.com/…` → shorts; else long. Media exts `.mp4 .mov .m4v .webm .mkv .mp3 .wav .m4a .jpg .jpeg .png .webp .gif` → `media/`; `.md .txt` → kind root; `links.txt` → HttpError 409 `links.txt is managed by the link list`; else HttpError 415 `This file type can't be added here (.<ext>)`.
  Routes: `GET /api/inspiration` → `{ shelves: InspirationShelf[] }`; `POST /api/inspiration/links` `{ url; note?; kind? }` → `{ kind, link }` (non-http(s) → 400 `Only web links (http or https) can be added`); `DELETE /api/inspiration/links` `{ url, kind }`; `PUT /api/inspiration/:kind/files?name=` (raw body, `saveStream` + `uniquePath`) → `InspirationFile`; `DELETE /api/inspiration/files` `{ path }`.
  `POST /api/show-in-finder` `{ path: string }` (absolute) → `ctx.openPath(path, isFile)` only when `path` is inside the workspace root (via `insideDir(root, relative(root, path))`), else 400. Used by Setup, Studio and Inspiration.

- [ ] **Step 1: Write failing tests**

```ts
test("classifyLink", () => {
  assert.equal(classifyLink("https://www.youtube.com/shorts/abc"), "shorts");
  assert.equal(classifyLink("https://www.instagram.com/reel/DaiCxAkOpNb/"), "shorts");
  assert.equal(classifyLink("https://vm.tiktok.com/x"), "shorts");
  assert.equal(classifyLink("https://youtu.be/xyz"), "long");
  assert.equal(classifyLink("https://example.com/v"), "long");
});
test("links round-trip with notes and keep comments", () => {
  const t = addLink("# header\nhttps://a.test/1\n", "https://b.test/2", "great hook");
  assert.equal(t, "# header\nhttps://a.test/1\nhttps://b.test/2  # great hook\n");
  assert.equal(addLink(t, "https://b.test/2"), t);
  assert.deepEqual(listLinks(t).map((l) => [l.url, l.note]), [["https://a.test/1", undefined], ["https://b.test/2", "great hook"]]);
  assert.equal(removeLink(t, "https://a.test/1"), "# header\nhttps://b.test/2  # great hook\n");
});
test("routeInspirationFile", () => {
  assert.equal(routeInspirationFile("shorts", "clip.MOV"), "shorts/media/clip.MOV");
  assert.equal(routeInspirationFile("long", "pacing.md"), "long/pacing.md");
  assert.throws(() => routeInspirationFile("long", "x.exe"), /can't be added here \(\.exe\)/);
});
test("a reel link lands in shorts/links.txt", async () => { /* POST → kind "shorts"; file contains the URL */ });
test("a clip lands in long/media and is listed", async () => { /* PUT /api/inspiration/long/files?name=a.mp4 → path "long/media/a.mp4"; GET lists it */ });
test("show-in-finder refuses paths outside the workspace", async () => { /* {path:"/etc"} → 400, openPath stub not called; inside → called once */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): inspiration API that files links and clips in the right folder`

### Task 10: projects API — list, create, status, upload, files, replacements, peaks

**Files:** Create `dashboard/src/routes/projects.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/types.ts`.

**Interfaces:**
- Consumes: `createProject`, `readLedger`, `latest`, `pendingApprovals`, `readProjectWorkflow`, `parseWorkflow`, `readJson`, `listWorkflowFiles`, `rmsEnvelope` (core); Task 8 helpers.
- Produces:
  ```ts
  export type StepView = StepResult & { cached?: boolean; awaitingApproval?: true };
  export type ProjectSummary = { id: string; workflow?: string; lastStatus: "new" | "running" | "done" | "failed" | "awaiting-approval" | "interrupted" };
  export type ProjectStatus = { id: string; dir: string; workflow?: string; steps: Record<string, StepView>; pending: string[];
    running: boolean; interrupted: string[]; uploads: string[]; media?: { file: string; durationSec: number; width: number; height: number } };
  export type WorkflowInfo = { name: string; title: string; steps: { step: string; approve: boolean }[] };
  export const PROJECT_ID_RE: RegExp; // /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/
  export const UPLOAD_EXTS: string[]; // .mp4 .mov .m4v .mkv .webm .avi .mp3 .wav .m4a .aac .flac
  export function projectDir(ctx: DashboardContext, id: string): Promise<string>; // 400 bad id, 404 missing
  ```
  Workflow titles: `short` → `Short vertical video (Reels, Shorts, TikTok)`, `rough-cut` → `Long video (YouTube)`, other → its name.
  Routes: `GET /api/workflows`; `GET /api/projects` (newest first); `POST /api/projects` `{ slug; brief? }` → 201 `ProjectStatus` (bad slug 400, exists 409); `GET /api/projects/:id` (`running` from jobs — `false` until Task 11; `interrupted` = `steps/<s>.running` files whose JSON `pid` is not alive (`process.kill(pid, 0)` throws `ESRCH`) and no job running (F19)); `PUT /api/projects/:id/uploads?name=` → `{ path: "uploads/<name>", sizeBytes }` (ext not in `UPLOAD_EXTS` → 415 `mostudio can't use this file type (.<ext>). Use a video or audio file.`); `GET /api/projects/:id/files/*`; `GET|PUT /api/projects/:id/replacements` (text, ≤ 256 KiB, atomic write); `GET /api/projects/:id/peaks?path=<rel .wav>&buckets=<n ≤ 2000>` → `{ peaks: number[] }` (`rmsEnvelope(abs, 10)` max-pooled into `buckets`, normalised 0..1) (F14).

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
  // node:http PUT, content-length 10_000_000, write 64 KiB, destroy; poll ≤ 2 s → uploads/ has no entries (no *.tmp)
});
test("not enough disk space is refused before writing", async () => { /* content-length 10^15 → 507 /Not enough free disk space/; nothing created */ });
test("dead-pid marker shows as interrupted; live-pid marker does not", async () => {
  // steps/transcribe.running {pid: 999999} → interrupted ["transcribe"]; {pid: process.pid} → []
});
test("files: Range works, traversal refused", async () => { /* renders/final.mp4 "0123456789", Range bytes=2-4 → 206 "234"; files/..%2F..%2Fmostudio.config.json → 400 */ });
test("peaks of a wav", async () => { /* write a 1 s 48 kHz stereo sine wav to audio/mix.wav; buckets=10 → 10 numbers, max === 1 */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): projects API with safe uploads, artifacts and waveform peaks`

### Task 11: job manager, cancel, live events (SSE)

**Files:** Create `dashboard/src/jobs.ts` (+ test), `dashboard/src/routes/events.ts` (+ test); Modify `dashboard/src/context.ts` (`jobs: JobManager`), `dashboard/src/server.ts` (`close` → `jobs.abortAll()`), `dashboard/src/routes/projects.ts` (`running`), `dashboard/src/types.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type RunMode = "manual" | "auto";
  export type RunEventBody =
    | { type: "run-start"; kind: "workflow" | "step"; name: string; mode: RunMode }
    | { type: "step-start"; step: string }
    | { type: "log"; step?: string; message: string }
    | { type: "step-end"; result: StepView }
    | { type: "approved"; step: string; auto: boolean }
    | { type: "run-end"; status: "done" | "failed" | "awaiting-approval" | "cancelled"; stoppedAt?: string; error?: string };
  export type RunEvent = RunEventBody & { id: number; at: string };
  export type Emit = (e: RunEventBody) => void;
  export class JobManager {
    constructor(opts?: { keepEvents?: number /* 2000 per project */ });
    isRunning(id: string): boolean;
    start(id: string, work: (emit: Emit, signal: AbortSignal) => Promise<void>): void; // HttpError 409 "This project is already running."
    cancel(id: string): boolean;
    abortAll(): Promise<void>;                                                           // abort every job, wait ≤ 3 s
    events(id: string, afterId?: number): RunEvent[];
    subscribe(id: string, fn: (e: RunEvent) => void): () => void;
    idle(id: string): Promise<void>;
  }
  ```
  Ids increase per project from 1 for the server's lifetime. A thrown `work` emits `run-end failed` with its message (callers redact), or `run-end cancelled` when the signal was aborted. `GET /api/projects/:id/events`: `text/event-stream`, `cache-control: no-store`; replays `events(id, Number(Last-Event-ID ?? since ?? 0))`, then live; frames `id: <id>\nevent: <type>\ndata: <json>\n\n`; `: ping\n\n` every 15 s; unsubscribe on close. `POST /api/projects/:id/cancel` → `{ cancelled: boolean }`.

- [ ] **Step 1: Write failing tests**

```ts
test("one job per project; ids increase", async () => {
  const jm = new JobManager(); let release!: () => void;
  jm.start("p", async (emit) => { emit({ type: "log", message: "a" }); await new Promise<void>((r) => (release = r)); });
  assert.throws(() => jm.start("p", async () => {}), /already running/);
  release(); await jm.idle("p");
  assert.deepEqual(jm.events("p").map((e) => e.id), [1]);
});
test("cancel aborts the job signal and ends cancelled", async () => {
  const jm = new JobManager();
  jm.start("p", (_e, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("x")))));
  assert.equal(jm.cancel("p"), true); await jm.idle("p");
  assert.equal((jm.events("p").at(-1) as { status?: string }).status, "cancelled");
});
test("SSE replays after Last-Event-ID then streams live", async () => { /* 3 events; connect with last-event-id 1 → ids 2,3; emit 4th → arrives; abort fetch → 0 subscribers */ });
test("server close aborts running jobs", async () => { /* job waiting on signal; d.close() resolves < 3 s; last event cancelled */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): job manager with cancel and replayable live events`

### Task 12: run, approve, re-run, single-step routes

**Files:** Create `dashboard/src/routes/runs.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/types.ts`.

**Interfaces:**
- Consumes: `runWorkflow` (`autoApprove`, `onStepStart`, `onApprove`, `onStep`, `log`, `signal`), `runStep` (`signal`), `stepParams`, `checkParams`, `approveStep`, `readProjectWorkflow`, `parseWorkflow`, `readAppSettings` (core); `JobManager`, `projectDir`, `insideDir`, `runtime`.
- Produces:
  ```ts
  export type RunRequest = { workflow: string; mode: RunMode; source?: string; params?: Record<string, Record<string, string | number | boolean>>; force?: string[] };
  export type StepRequest = { params?: Record<string, string | number | boolean>; force?: boolean };
  export type ApproveRequest = { step: string; continue?: boolean; mode?: RunMode };
  ```
  - `POST /api/projects/:id/run` (`RunRequest`) → 202 `{ started: true }`. Checked before starting: workflow exists (404 `Unknown workflow`); the project's recorded workflow matches (409 `This project already made a <title>. Start a new project for a different kind of video.`) (F16); each param passes `checkParams` (400); `source` and every `fileParams` value → `insideDir(projectDir, v)`. When the workflow contains `assemble`, the request has no `assemble.captionsRenderer` and `ctx.packaged` is true, inject `captionsRenderer: "ass"`, or `"hyperframes"` when app setting `animatedCaptions === true`. Emits `run-start`, `step-start`, `log` (the `[step] ` prefix moves into `step`), `step-end`, `approved`, `run-end`.
  - `POST /api/projects/:id/approve` (`ApproveRequest`) → `approveStep`, emit `approved {auto:false}`; `continue: true` starts the project's workflow in `mode ?? "manual"` → 202; else 200 `{ ok: true }`. No passing result → 409 with the core message.
  - `POST /api/projects/:id/rerun` `{ step: string }` → starts the project's workflow with `force: [step]` in manual mode, so workflow params (e.g. `style: short`) apply and the approval resets (F5).
  - `POST /api/projects/:id/steps/:name` (`StepRequest`) → `runStep` as a job with params = `stepParams(projectDir, wf, name)` (when the project has a workflow) overlaid by request params (F5). Unknown step → 404.

- [ ] **Step 1: Write failing tests** (fake steps `a`, `b` (approve in `workflows/t.json`, entry params `{ n: 7 }`), `c`, `x` (fails), `slow` (`runBin("sleep",["30"])`); `await d.idle(id)` after each 202)

```ts
test("manual stops at review; approve+continue finishes", async () => {
  assert.equal((await d.api(`/api/projects/${id}/run`, post({ workflow: "t", mode: "manual" }))).status, 202);
  await d.idle(id);
  assert.deepEqual(lastRunEnd(d, id), { status: "awaiting-approval", stoppedAt: "b" });
  assert.equal((await d.api(`/api/projects/${id}/approve`, post({ step: "b", continue: true }))).status, 202);
  await d.idle(id);
  assert.equal(lastRunEnd(d, id).status, "done");
});
test("auto runs end to end; approved{auto:true} right after b's step-end", async () => { /* types in order: run-start, step-start, step-end, step-start, step-end, approved, step-start, step-end, run-end(done) */ });
test("auto still stops at a failing gate", async () => { /* wf with x → run-end failed, stoppedAt x */ });
test("cancel during a slow step kills it and ends cancelled", async () => { /* after step-start POST /cancel → run-end cancelled within 2 s; ledger slow error "cancelled by user" */ });
test("second run while running → 409", async () => {});
test("rerun and single step use workflow params", async () => { /* POST /rerun {step:"b"} → step-end b metrics.n === 7; POST /steps/b {} → metrics.n === 7 */ });
test("mismatched workflow → 409 friendly; source outside project → 400; bad param → 400", async () => {});
test("packaged app defaults assemble captions to ass, opt-in hyperframes", async () => { /* packaged:true; fake assemble records ctx.params.captionsRenderer → "ass"; after PUT animatedCaptions true → "hyperframes" */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): runs in review or auto mode, approve, re-run, cancel, single steps`

### Task 13: tools catalog

**Files:** Create `dashboard/src/knobs.ts`, `dashboard/src/catalog.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/types.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type Knob = { label: string; help: string; choices?: { value: string; label: string }[]; input?: "text" | "textarea" | "number" | "toggle" | "file" | "provider"; advanced?: boolean };
  export const KNOBS: Record<string, Record<string, Knob>>;
  export type ToolParam = { name: string; type: "string" | "number" | "boolean"; optional: boolean } & Knob;
  export type ToolInfo = { name: string; title: string; summary: string; inputs: string[]; outputs: string[];
    params: ToolParam[]; gate: Threshold[]; workflows: string[]; capability?: Capability };
  export function buildCatalog(steps: Record<string, StepModule>, workflows: WorkflowInfo[], readme: (step: string) => string): ToolInfo[];
  ```
  `summary` = first paragraph after the README `# title` (missing → `""`). Titles: ingest `Import media`, transcribe `Transcribe speech`, cut `Remove silences and retakes`, localize `Darija / Arabizi subtitles`, captions `Captions`, chapters `YouTube chapters`, mix `Sound: loudness and music`, assemble `Render the video`, qa `Quality check`. `capability`: transcribe `stt`; localize, chapters `llm`.
  `KNOBS` (values verbatim from the step READMEs; `advanced: true` → behind "More options"):
  - transcribe: `language` text "Language code, e.g. en or fr. Leave empty to detect."; `dialect` `[{darija, "Moroccan Darija"}]` "Better results for Darija mixed with French/English (don't set a language with it)"; `prompt` textarea "Names and words to spell right"; `prefer` provider advanced.
  - cut: `pace` `natural` "Natural" / `tight` "Tight (fast-paced)"; `retakes` toggle "Remove earlier takes of a repeated sentence"; `maxGap`, `pre`, `post`, `minKeep`, `maxRetakeSec` number advanced (seconds).
  - localize: `lang` `source` "As spoken" / `arabizi` "Darija in Latin letters (Arabizi)" / `fr` "French" / `en` "English"; `prefer` provider advanced.
  - captions: `style` `long` "One line (long videos)" / `short` "Big words (shorts)"; `font` text advanced; `width`, `height` number advanced.
  - mix: `music` file "Background music (upload it into the project)"; `musicDb` number "Music volume (dB)" advanced; `targetLufs` number "Loudness target (LUFS)" advanced.
  - chapters: `language` text "Title language"; `prefer` provider advanced.
  - assemble: `preset` `source` "Same as the video" / `youtube` "YouTube 16:9" / `shorts` `reels` `tiktok` "Vertical 9:16"; `burnCaptions` toggle "Show captions on the video"; `captionsRenderer` `ass` "Simple captions" / `hyperframes` "Animated captions (needs internet the first time)".
  - ingest: `source` file "Video or audio file".
  Route `GET /api/tools` → `{ tools: ToolInfo[] }` in `defaultSteps` order.

- [ ] **Step 1: Write failing tests**

```ts
test("every contract param has a knob and every knob names a real param", () => {
  for (const [name, mod] of Object.entries(defaultSteps)) {
    assert.deepEqual(Object.keys(KNOBS[name] ?? {}).sort(), Object.keys(mod.contract.params ?? {}).sort(), name);
  }
});
test("catalog joins README summary, workflows and choices", () => {
  const cat = buildCatalog(defaultSteps, [{ name: "short", title: "Short", steps: [{ step: "cut", approve: false }] }], (s) => `# ${s}\n\nDoes ${s}.\n\nMore.`);
  const cut = cat.find((t) => t.name === "cut")!;
  assert.deepEqual([cut.title, cut.summary, cut.workflows], ["Remove silences and retakes", "Does cut.", ["short"]]);
  assert.deepEqual(cut.params.find((p) => p.name === "pace")!.choices!.map((c) => c.value), ["natural", "tight"]);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): tools catalog with plain-language options`

### Task 14: keys and settings, connection tests

**Files:** Create `dashboard/src/settings.ts` (+ test), `dashboard/src/probes.ts` (+ test), `dashboard/src/routes/settings.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/types.ts`.

**Interfaces:**
- Consumes: `updateEnvFile`, `maskSecret`, `loadLayeredEnv`, `loadProvidersFile`, `readAppSettings`, `writeAppSettings`, `createRedactor`, `resolveBin`, `runBin` (core).
- Produces:
  ```ts
  export type SettingField = { name: string; kind: "secret" | "text" | "path"; providers: string[]; label: string; help: string;
    getKeyUrl?: string; recommended?: boolean; source: "app" | "workspace" | "process" | "unset"; masked: string };
  export type ProbeResult = { provider: string; ok: boolean; status?: number; message: string; ms: number };
  export function settingsSchema(entries: ProviderEntry[]): Omit<SettingField, "source" | "masked">[];
  export function readSettings(o: { home: string; root?: string; processEnv: Record<string, string>; entries: ProviderEntry[] }): SettingField[];
  export function writeSettings(home: string, values: Record<string, string>, entries: ProviderEntry[]): Promise<void>; // writes ~/.mostudio/.env
  export function probeProvider(entry: ProviderEntry, env: Record<string, string | undefined>,
    deps: { fetch: typeof fetch; run?: (b: string, a: string[]) => Promise<string>; listDir?: (p: string) => string[] }): Promise<ProbeResult>;
  ```
  Schema = providers whose capabilities include `stt` or `llm` (what steps use today; stock/image keys come back when a step needs them) (F17): each distinct `keyEnv` (secret), each `env` value (text, e.g. `CLOUDFLARE_ACCOUNT_ID`), plus `WHISPER_MODELS_DIR` (path); sorted by name. Labels/links: `GROQ_API_KEY` "Groq key", `https://console.groq.com/keys`, **recommended**, help `Free. Used for transcription and AI steps.`; `GEMINI_API_KEY` "Google Gemini key", `https://aistudio.google.com/apikey`, recommended, help `Free. Used for AI steps.`; others "<Provider id, capitalised> key", help `Optional backup provider.`. `FFMPEG`, `FFPROBE`, `WHISPER_CLI` are **not** writable from the dashboard (F6).
  `source` from `loadLayeredEnv` sources; `masked` = `maskSecret` for secrets, value otherwise.
  Probes (10 s; missing key → `ok:false`, `Add your <label> first`, no request; 401/403 → `This key was refused. Copy it again from <host>.`; network error → `Can't reach <host>. Check your internet connection.`; success → `Connected (<ms> ms)`; every message through a redactor holding the key):
  | provider | request |
  |---|---|
  | groq, zai, mistral (`openai-compat`) | `GET {baseUrl}/models`, `Authorization: Bearer` |
  | openrouter | `GET https://openrouter.ai/api/v1/key`, Bearer |
  | nvidia | `GET {baseUrl}/models`, Bearer; success message `Reachable. This service can't confirm the key without using credits.` |
  | gemini | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, header `x-goog-api-key` |
  | cloudflare | needs `CLOUDFLARE_ACCOUNT_ID` (else `Add your Cloudflare account ID first`); `GET https://api.cloudflare.com/client/v4/accounts/<id>/ai/models/search?per_page=1`, Bearer |
  | whisper-cpp | `run(resolveBin("whisper-cli", env), ["--help"])` + a `ggml-*.bin` in `WHISPER_MODELS_DIR`; message `Ready (models: <names>)` |
  Routes: `GET /api/settings` → `{ keysFile: "<home>/.env", fields, animatedCaptions: boolean }`; `PUT /api/settings` `{ values?: Record<string,string>; animatedCaptions?: boolean }` (unknown name → 400 `unknown setting: X`) → same shape; `POST /api/settings/reveal` `{ name }` → `{ value }` only when `source === "app"` (else 403 `This key is managed outside mostudio`) (F7); `POST /api/settings/test` `{ provider; values?: Record<string,string> }` → `ProbeResult`, where `values` may only override schema secret/text names (paths ignored) (F6).

- [ ] **Step 1: Write failing tests**

```ts
test("schema: stt/llm keys plus whisper models dir; no binary paths, no stock keys", () => {
  const names = settingsSchema(realEntries).map((f) => f.name);
  for (const n of ["GROQ_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "WHISPER_MODELS_DIR"]) assert.ok(names.includes(n), n);
  for (const n of ["FFMPEG", "WHISPER_CLI", "PEXELS_API_KEY"]) assert.ok(!names.includes(n), n);
});
test("read masks and reports the layer", () => {
  const home = tmpDir(), ws = tmpDir();
  writeFileSync(join(home, ".env"), "GROQ_API_KEY=gsk_abcdefgh1234\n");
  writeFileSync(join(ws, ".env.local"), "MISTRAL_API_KEY=mistral12345678\n");
  const f = readSettings({ home, root: ws, processEnv: { GEMINI_API_KEY: "AIzaXXXXXXXX9999" }, entries: realEntries });
  assert.deepEqual(pick(f, "GROQ_API_KEY"), { source: "app", masked: "gsk…1234" });
  assert.deepEqual(pick(f, "MISTRAL_API_KEY"), { source: "workspace", masked: "mis…5678" });
  assert.deepEqual(pick(f, "GEMINI_API_KEY"), { source: "process", masked: "AIz…9999" });
});
test("write goes to ~/.mostudio/.env and refuses unknown names", async () => {
  const home = tmpDir();
  await writeSettings(home, { GROQ_API_KEY: "gsk_x_123456" }, realEntries);
  assert.equal(loadEnvFile(join(home, ".env")).GROQ_API_KEY, "gsk_x_123456");
  await assert.rejects(writeSettings(home, { NODE_OPTIONS: "--inspect" }, realEntries), /unknown setting: NODE_OPTIONS/);
  await assert.rejects(writeSettings(home, { WHISPER_CLI: "/bin/sh" }, realEntries), /unknown setting: WHISPER_CLI/);
});
test("probe 401 → friendly refusal, key never echoed", async () => {
  const r = await probeProvider(groq, { GROQ_API_KEY: "gsk_secret_999999" }, { fetch: (async () => new Response("no", { status: 401 })) as typeof fetch });
  assert.deepEqual([r.ok, r.status], [false, 401]);
  assert.match(r.message, /refused/); assert.doesNotMatch(r.message, /gsk_secret/);
});
test("probe without key makes no request", async () => {});
test("gemini key goes in the header, not the URL", async () => {});
test("reveal only for keys mostudio stores", async () => { /* source app → 200 value; process → 403 */ });
test("test endpoint ignores path overrides", async () => { /* values {WHISPER_CLI:"/bin/sh"} for whisper-cpp → run stub never receives "/bin/sh" */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): keys stored in ~/.mostudio with masked view and connection tests`

### Task 15: first-run setup API

**Files:** Create `dashboard/src/routes/setup.ts` (+ test); Modify `dashboard/src/server.ts`, `dashboard/src/context.ts` (`root` mutable), `dashboard/src/types.ts`.

**Interfaces:**
- Consumes: `scaffoldWorkspace`, `checkSystem`, `defaultWorkspace`, `readAppSettings`, `writeAppSettings` (core); `readSettings` (Task 14).
- Produces:
  ```ts
  export type SetupState = { needsSetup: boolean; workspace: string | null; suggestedWorkspace: string; checks: Check[];
    hasAiKey: boolean /* a key is set for an stt provider (groq, cloudflare+account id) or the whisper check passes */; packaged: boolean; version: string };
  ```
  `GET /api/setup` → `SetupState` (works without a workspace; every workspace route returns 409 `setup needed` until one exists). `POST /api/setup/workspace` `{ path: string }` → expands a leading `~`; must then be absolute (400 `Choose a full folder path, like /Users/you/Movies/mostudio`); parent must exist (400 `That folder's parent doesn't exist`); `scaffoldWorkspace`, `writeAppSettings({ workspace })`, `ctx.root = path` → `{ entries: ScaffoldEntry[], state: SetupState }`.

- [ ] **Step 1: Write failing tests**

```ts
test("fresh install needs setup and suggests ~/Movies/mostudio", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  const s = await (await d.api("/api/setup")).json();
  assert.equal(s.needsSetup, true);
  assert.match(s.suggestedWorkspace, /Movies\/mostudio$/);
  assert.equal((await d.api("/api/projects")).status, 409);
  await d.close();
});
test("choosing a folder scaffolds it, remembers it, unlocks the API", async () => {
  const d = await startTestDashboard({ noWorkspace: true }); const target = join(tmpDir(), "Mes vidéos");
  const r = await (await d.api("/api/setup/workspace", post({ path: target }))).json();
  assert.equal(r.state.needsSetup, false);
  assert.ok(existsSync(join(target, "inspiration/shorts/links.txt")));
  assert.equal((await readAppSettings(d.home)).workspace, target);
  assert.equal((await d.api("/api/projects")).status, 200);
  await d.close();
});
test("relative or orphan paths are refused with plain messages", async () => {});
test("version comes from package.json", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): first-run setup API (workspace folder, checks, key status)`

### Task 16: `mostudio ui` command

**Files:** Modify `cli/src/main.ts` (+ test), `cli/bin/mostudio.ts`, `README.md`.

**Interfaces:**
- Consumes: `startDashboard` (Task 7).
- Produces: `mostudio ui [--port <n>] [--open]` (alias `dashboard`). Works with or without a workspace. Prints exactly:
  ```
  mostudio is running at http://127.0.0.1:<port>
  Keep this window open while you work. Close it (or press Ctrl+C) to stop.
  ```
  Without `--open` it also prints `Open this link: http://127.0.0.1:<port>/?t=<token>`; with `--open` the link goes to `io.openUrl` (default `runBin("open", [url])`) and is not printed. `io.signal?: AbortSignal` stops it; the bin wires SIGINT, SIGTERM and SIGHUP (closing the Terminal window sends SIGHUP) to an AbortController; stop → `close()` → exit 0. `packaged` = `env.MOSTUDIO_PACKAGED === "1"`. Busy `--port` → exit 1 `Port <n> is busy. Start without --port to pick a free one.`

- [ ] **Step 1: Write failing tests**

```ts
test("ui starts, prints the address, stops on abort", async () => {
  const ac = new AbortController(); reset();
  const p = main(["ui", "--port", "0"], { ...mk(), signal: ac.signal }, steps);
  await waitFor(() => /Open this link: http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(out()));
  const link = /Open this link: (\S+)/.exec(out())![1]!;
  assert.equal((await fetch(link, { redirect: "manual" })).status, 302);
  ac.abort(); assert.equal(await p, 0);
});
test("--open hands the link to the opener and does not print it", async () => { /* io.openUrl stub gets the tokened URL; out() has no "?t=" */ });
test("busy --port exits 1 with a plain hint", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(cli): mostudio ui starts the dashboard and opens the browser`

---

## Part C — Dashboard UI (branch `feat/dashboard-ui`)

Browser code is TypeScript in `dashboard/web/`, type-checked by `dashboard/web/tsconfig.json` (`lib: ["es2023","dom","dom.iterable"]`, `types: ["node"]` for tests, root strict flags incl. `erasableSyntaxOnly`, `include: ["**/*.ts", "../src/types.ts"]`); root `tsconfig.json` excludes it; `package.json` `typecheck` = `tsc --noEmit && tsc --noEmit -p dashboard/web`. The bundled Node is pinned (Part D), so `stripTypeScriptTypes` cannot change under users (F18). Pure logic in `dashboard/web/lib/*.ts` with node tests; views in `dashboard/web/views/*.ts` covered by typecheck plus browser checks with the installed `playwright-skill` in Task 28. Web modules only `import type` from `../src/types.ts`. Data is rendered with `textContent`, never `innerHTML`.

Design direction (refined in Task 28 with `impeccable`): calm editing-room UI, dark-first neutral surfaces, one accent `#FFD400` (the caption highlight), monospace only for timestamps and logs, left rail with 4 tabs (Studio, Inspiration, Tools, Settings) collapsing to a bottom bar under 720 px; colour tokens on `:root` with a `prefers-color-scheme: light` override. Browse 21st.dev community dropzone/stepper patterns for reference (no code copied).

### Task 17: shell, API client, friendly errors

**Files:** Create `dashboard/web/tsconfig.json`, `dashboard/web/styles.css`, `dashboard/web/lib/api.ts` (+ test), `dashboard/web/lib/errors.ts` (+ test), `dashboard/web/lib/dom.ts`, `dashboard/web/views/error-box.ts`; Modify `dashboard/web/index.html`, `dashboard/web/app.ts`, `package.json`, `dashboard/src/static.test.ts` (every non-test web module serves 200).

**Interfaces:**
- Produces:
  ```ts
  // lib/api.ts (the session cookie travels automatically; no token code in the browser)
  export class ApiFailure extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
  export function createApi(f?: typeof fetch): {
    get<T>(path: string): Promise<T>; send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
    text(path: string): Promise<string>; putText(path: string, text: string): Promise<void>;
    upload<T>(path: string, file: Blob, onProgress: (fraction: number) => void): { done: Promise<T>; abort(): void }; // XMLHttpRequest PUT
    events(projectId: string, onEvent: (e: RunEvent) => void): () => void;
    fileUrl(projectId: string, rel: string): string; };
  export type Api = ReturnType<typeof createApi>;
  // lib/errors.ts
  export type Explained = { title: string; advice: string; action?: { label: string; href: string }; details: string };
  export function explainError(message: string): Explained;
  // lib/dom.ts
  export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string | boolean | EventListener>, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K];
  // views/error-box.ts
  export function errorBox(message: string): HTMLElement; // title, advice, optional action link, <details> with the raw message
  // app.ts: hash router "#studio" (default) | "#inspiration" | "#tools" | "#settings" | "#setup"; loads GET /api/setup first and forces #setup while needsSetup; every view exports mount(root: HTMLElement, api: Api): () => void
  ```
  `explainError` table (first match wins; `details` = raw message):
  | pattern | title | advice | action |
  |---|---|---|---|
  | `/No provider available for "stt"/` | `No transcription service available` | `Add a free Groq key so mostudio can turn speech into text.` | `Open settings` → `#settings` |
  | `/No provider available for "llm"/` | `No AI service available` | `Add a free Groq or Gemini key.` | `#settings` |
  | `/cancelled by user/` | `Stopped` | `You stopped this run. Start again when you're ready.` | — |
  | `/not found; install it or set/` | `A video tool is missing` | `Reinstall mostudio: download the latest zip and replace the folder.` | — |
  | `/needs libass/` | `Captions can't be burned with this video engine` | `Turn on animated captions in Settings, or reinstall mostudio.` | `#settings` |
  | `/captions\.ass is .* but output is/` | `Captions were made for another video size` | `Re-run the captions step, then continue.` | — |
  | `/no words in transcript/` | `No speech found` | `This clip seems silent or music-only. Try a clip where someone talks.` | — |
  | `/This project already made/` | `This project already made another kind of video` | `Start a new project for a different kind of video.` | — |
  | `/Not enough free disk space/` | `Your disk is full` | the server message | — |
  | `/refused\|\b401\b\|\b403\b/` | `A key was refused` | `Copy the key again and test it in Settings.` | `#settings` |
  | `/missing input: /` | `An earlier step hasn't run yet` | `Run the steps before this one first.` | — |
  | default | `Something went wrong` | `Open the details below and share them if you ask for help.` | — |

- [ ] **Step 1: Write failing tests**

```ts
test("api surfaces server error text with status", async () => {
  const f = (async () => new Response(JSON.stringify({ error: "This project is already running." }), { status: 409 })) as typeof fetch;
  await assert.rejects(createApi(f).send("POST", "/api/projects/p/run", {}), (e: ApiFailure) => e.status === 409 && /already running/.test(e.message));
});
test("explainError maps engine messages to plain advice", () => {
  assert.equal(explainError('No provider available for "stt": groq: no-key').action!.href, "#settings");
  assert.equal(explainError("cancelled by user").title, "Stopped");
  const e = explainError("weird ffmpeg thing");
  assert.deepEqual([e.title, e.details], ["Something went wrong", "weird ffmpeg thing"]);
});
test("no explanation leaks a CLI flag", () => {
  for (const m of ['No provider available for "stt": x', "x. Burning captions with ffmpeg needs libass: brew install ffmpeg-full (or use --param captionsRenderer=hyperframes)"]) {
    const e = explainError(m); assert.doesNotMatch(e.title + e.advice, /--|brew|\.env/);
  }
});
```

- [ ] **Step 2: Run** `node --test dashboard/web/lib/api.test.ts dashboard/web/lib/errors.test.ts dashboard/src/static.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): dashboard shell, API client, plain-language errors`

### Task 18: first-run setup screen

**Files:** Create `dashboard/web/views/setup.ts`, `dashboard/web/lib/setup.ts` (+ test).

**Interfaces:**
- Consumes: `GET /api/setup`, `POST /api/setup/workspace`, `PUT /api/settings`, `POST /api/settings/test`, `POST /api/show-in-finder`.
- Produces:
  ```ts
  export type SetupStepId = "folder" | "check" | "key" | "done";
  export function nextSetupStep(s: SetupState): SetupStepId; // no workspace → folder; failed required check → check; !hasAiKey → key; else done
  export function checkRows(checks: Check[]): { label: string; ok: boolean; required: boolean; text: string }[]; // ok → "Ready"; else `${detail}. ${fix ?? ""}`.trim()
  ```
  Copy (exact headings): 1 `Where should mostudio keep your videos?` (text field prefilled with `suggestedWorkspace`, button `Use this folder`; after success the created folders with `Show in Finder`). 2 `Checking your Mac` (rows; a required failure blocks with its fix; optional rows tagged `Optional`). 3 `Add your free Groq key` (`1. Open console.groq.com/keys and sign in.` `2. Create a key and copy it.` `3. Paste it here.`; password field + `Test` + `Save`; link `I'll do this later`, which shows `Transcription won't work until you add a key.`). 4 `You're ready` → `Make my first video` → `#studio`.

- [ ] **Step 1: Write failing tests**

```ts
test("nextSetupStep", () => {
  assert.equal(nextSetupStep(state({ workspace: null })), "folder");
  assert.equal(nextSetupStep(state({ workspace: "/w", checks: [chk("ffmpeg", false, true)] })), "check");
  assert.equal(nextSetupStep(state({ workspace: "/w", hasAiKey: false })), "key");
  assert.equal(nextSetupStep(state({ workspace: "/w", hasAiKey: true })), "done");
});
test("checkRows", () => {
  assert.equal(checkRows([chk("whisper", false, false, "not installed", "Optional. Cloud transcription works without it.")])[0]!.text,
    "not installed. Optional. Cloud transcription works without it.");
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): first-run setup (folder, Mac check, Groq key)`

### Task 19: pipeline state and live stepper

**Files:** Create `dashboard/web/lib/pipeline.ts` (+ test), `dashboard/web/views/stepper.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type StepState = "idle" | "running" | "pass" | "warn" | "fail" | "cached" | "awaiting" | "interrupted" | "cancelled";
  export type StepCard = { step: string; approve: boolean; state: StepState; startedAt?: number; durationMs?: number; result?: StepView; logs: string[]; autoApproved?: boolean };
  export type PipelineState = { workflow?: string; mode: RunMode; running: boolean; cards: StepCard[]; lastEventId: number; error?: string;
    outcome?: "done" | "failed" | "awaiting-approval" | "cancelled" };
  export const STEP_LABELS: Record<string, string>; // ingest "Import", transcribe "Transcribe", cut "Cut silences", localize "Subtitles", captions "Captions", chapters "Chapters", mix "Sound", assemble "Render", qa "Check"
  export const MAX_LOG_LINES = 400;
  export function initialState(wf: WorkflowInfo, status: ProjectStatus): PipelineState;
  export function applyEvent(s: PipelineState, e: RunEvent): PipelineState; // pure; ignores e.id <= lastEventId
  export function elapsed(card: StepCard, now: number): string;             // "m:ss"
  // views/stepper.ts
  export function renderStepper(s: PipelineState, opts: { selected?: string; onSelect(step: string): void }): HTMLElement;
  ```
  Rules: `run-start` → running, mode, outcome cleared; `step-start` → running, `startedAt`, logs cleared; `log` → its card (or the running card); `step-end` → state from status (`cached` when cached and not fail; fail with error `cancelled by user` → `cancelled`), `durationMs`; `approved` → back to result state, `autoApproved = auto`; `run-end` → running false, outcome; `awaiting-approval` → `stoppedAt` card `awaiting`; `failed` with `error` and no step-end → `error`. Cards for steps outside the workflow (single tools) are appended. Badges always have text (`Done`, `Done with warnings`, `Failed`, `Reused`, `Needs your review`, `Interrupted`, `Stopped`, `Running…`, `Waiting`, `Approved automatically`), never colour alone.

- [ ] **Step 1: Write failing tests**

```ts
test("live run to a review pause", () => {
  let s = initialState(wf(["ingest", "captions*"]), emptyStatus);
  s = reduce(s, [ev(1, { type: "run-start", kind: "workflow", name: "short", mode: "manual" }), ev(2, { type: "step-start", step: "ingest" }),
    ev(3, { type: "log", step: "ingest", message: "copied a.mov" }), ev(4, { type: "step-end", result: res("ingest", "pass") }),
    ev(5, { type: "step-start", step: "captions" }), ev(6, { type: "step-end", result: res("captions", "warn") }),
    ev(7, { type: "run-end", status: "awaiting-approval", stoppedAt: "captions" })]);
  assert.deepEqual(s.cards.map((c) => c.state), ["pass", "awaiting"]);
  assert.deepEqual([s.running, s.outcome, s.cards[0]!.logs], [false, "awaiting-approval", ["copied a.mov"]]);
});
test("replayed ids are ignored", () => {});
test("auto approval is marked on the card", () => { /* approved{auto:true} → autoApproved true, state warn */ });
test("cancelled step shows Stopped", () => { /* step-end fail error "cancelled by user" → "cancelled" */ });
test("interrupted and pending come from status", () => {});
test("elapsed and log cap", () => {
  assert.equal(elapsed({ state: "running", startedAt: 0 } as StepCard, 65_000), "1:05");
  /* 450 logs → 400 kept, last present */
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): live pipeline state and stepper`

### Task 20: step output previews

**Files:** Create `dashboard/web/lib/previews.ts` (+ test), `dashboard/web/views/previews.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type PreviewKind = "media-info" | "video" | "audio" | "words" | "edl" | "units" | "captions" | "text" | "image" | "report";
  export type Preview = { kind: PreviewKind; path: string; label: string };
  export function previewsFor(step: string, status: ProjectStatus): Preview[];
  export function edlBar(edl: { keep: { start: number; end: number }[]; removed: { start: number; end: number; reason: string }[] }, total: number):
    { left: number; width: number; kind: "keep" | "silence" | "filler" | "retake" }[];
  export function formatTime(sec: number): string; // "mm:ss.cc"
  // views/previews.ts
  export function renderPreview(p: Preview, api: Api, projectId: string): Promise<HTMLElement>;
  ```
  | step | previews (label) |
  |---|---|
  | ingest | `media-info` `media/ingest.json` ("Your video"); `video` `<status.media.file>` |
  | transcribe | `words` `transcript/words.json` ("What was said": first 300 words `[mm:ss.cc] word`, `conf < 0.6` underlined) |
  | cut | `edl` `cut/edl.json` ("What was cut": bar + counts by reason + new length) |
  | localize | `units` `localize/units.json` ("Subtitle lines") |
  | captions | `captions` `captions/captions.txt` ("Captions") |
  | mix | `audio` `audio/mix.wav` ("Sound": `<audio>` + waveform from `GET /peaks?buckets=<canvas width>`) |
  | chapters | `text` `chapters/youtube.txt` ("Chapters", Copy button) |
  | assemble | `video` `renders/final.mp4` ("Your video", `Show in Finder`) |
  | qa | `image` `renders/contact-sheet.jpg`; `report` `renders/qa.md` (preformatted) |
  Only pass/warn steps get previews.

- [ ] **Step 1: Write failing tests**

```ts
test("previewsFor maps steps and skips failed ones", () => {
  const st = status({ ingest: "pass", cut: "fail", assemble: "warn" }, { file: "media/a.mov" });
  assert.deepEqual(previewsFor("ingest", st).map((p) => [p.kind, p.path]), [["media-info", "media/ingest.json"], ["video", "media/a.mov"]]);
  assert.deepEqual(previewsFor("cut", st), []);
  assert.deepEqual(previewsFor("assemble", st).map((p) => p.path), ["renders/final.mp4"]);
});
test("edlBar", () => {
  assert.deepEqual(edlBar({ keep: [{ start: 0, end: 5 }], removed: [{ start: 5, end: 10, reason: "silence" }] }, 10),
    [{ left: 0, width: 50, kind: "keep" }, { left: 50, width: 50, kind: "silence" }]);
});
test("formatTime", () => { assert.equal(formatTime(65.239), "01:05.24"); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): per-step previews (transcript, cut bar, captions, sound, render)`

### Task 21: Studio A — projects and video upload

**Files:** Create `dashboard/web/views/studio.ts`, `dashboard/web/views/studio-upload.ts`, `dashboard/web/lib/studio.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  export const MEDIA_EXTS: string[];                        // equals UPLOAD_EXTS (Task 10)
  export function acceptsMedia(name: string): boolean;
  export function slugFromFileName(name: string): string;   // "My Clip (final) 2.MOV" → "my-clip-final-2"; "été à Fès.mp4" → "ete-a-fes"; nothing usable → "video"
  export function formatBytes(n: number): string;          // "1.4 GB", "820 MB", "12 KB"
  ```
  View: project list (name from slug, date, `lastStatus` badge) + `New video`; project without media → big dropzone `Drop your video here` / `or choose a file` (Enter/Space opens the picker); a drop with no project selected creates one from `slugFromFileName`; progress `formatBytes(sent) of formatBytes(total)` + `Cancel upload`; errors via `errorBox`; earlier uploads listed for reuse.

- [ ] **Step 1: Write failing tests**

```ts
test("slugFromFileName", () => {
  assert.equal(slugFromFileName("My Clip (final) 2.MOV"), "my-clip-final-2");
  assert.equal(slugFromFileName("été à Fès.mp4"), "ete-a-fes");
  assert.equal(slugFromFileName("..."), "video");
});
test("MEDIA_EXTS equals the server allow-list", async () => {
  const { UPLOAD_EXTS } = await import("../../src/routes/projects.ts");
  assert.deepEqual([...MEDIA_EXTS].sort(), [...UPLOAD_EXTS].sort());
});
test("formatBytes", () => { assert.equal(formatBytes(1_400_000_000), "1.4 GB"); assert.equal(formatBytes(12_000), "12 KB"); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): studio projects and video upload`

### Task 22: Studio B — make the video (mode, run, review, stop)

**Files:** Create `dashboard/web/views/studio-run.ts`, `dashboard/web/lib/run.ts` (+ test); Modify `dashboard/web/views/studio.ts`.

**Interfaces:**
- Consumes: Tasks 12, 17, 19, 20.
- Produces:
  ```ts
  export function buildRunRequest(o: { workflow: string; mode: RunMode; source?: string; params: Record<string, Record<string, string>> }): RunRequest; // drops empty strings and empty steps
  export function modeCopy(mode: RunMode): { title: string; help: string };
  export function primaryAction(s: PipelineState, hasSource: boolean): "start" | "stop" | "continue" | "start-over" | "none";
  ```
  `modeCopy` (exact): manual → `{ title: "Review before finishing", help: "mostudio pauses at the captions so you can fix words before the video is rendered." }`; auto → `{ title: "Do it all for me", help: "mostudio makes the whole video without pausing. If a step fails its quality check, it still stops and tells you why." }`.
  `primaryAction`: running → `stop`; outcome `awaiting-approval` → `continue`; outcome `done` → `start-over`; no source and no ingested media → `none`; else `start`.
  View: `What are you making?` cards from `/api/workflows` (locked to the project's workflow once it has one); `Subtitles language` (localize `lang` choices) and `Pace` (cut `pace` choices); the mode choice; one primary button (`Make my video` / `Stop` with confirm `Stop this run? Finished steps are kept.` / `Approve & continue` / `Make it again`); stepper; selected-step panel (logs auto-scroll unless scrolled up; previews; `errorBox`). Captions review: caption text, `Fix words` editor for `edits/replacements.txt` (hint `One fix per line: wrong => right`), `Apply fixes` (`POST /rerun {step:"captions"}`), `Approve & continue`. Done: final video player + `Show in Finder`. Subscribes to events per project; re-fetches status on every `run-end`; 1 s ticker for elapsed while running.

- [ ] **Step 1: Write failing tests**

```ts
test("buildRunRequest drops empties", () => {
  assert.deepEqual(buildRunRequest({ workflow: "short", mode: "auto", source: "uploads/a.mov", params: { localize: { lang: "arabizi", prefer: "" }, cut: { pace: "" } } }),
    { workflow: "short", mode: "auto", source: "uploads/a.mov", params: { localize: { lang: "arabizi" } } });
});
test("primaryAction", () => {
  assert.equal(primaryAction(ps({ running: true }), true), "stop");
  assert.equal(primaryAction(ps({ outcome: "awaiting-approval" }), true), "continue");
  assert.equal(primaryAction(ps({}), false), "none");
  assert.equal(primaryAction(ps({ outcome: "done" }), true), "start-over");
});
test("auto copy is honest about failing steps", () => { assert.match(modeCopy("auto").help, /still stops/); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): make a video in review or auto mode, fix captions, stop`

### Task 23: Inspiration view

**Files:** Create `dashboard/web/views/inspiration.ts`, `dashboard/web/lib/inspiration.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  export function extractUrls(text: string): string[];      // every http(s) URL, deduped, order kept
  export function shelfCopy(kind: InspirationKind): { title: string; accepts: string };
  ```
  `shelfCopy` (exact): shorts → `{ title: "Short-form (vertical)", accepts: "Reels, Shorts, TikToks: links, clips, screenshots, notes" }`; long → `{ title: "Long-form (landscape)", accepts: "YouTube videos, podcasts, interviews: links, clips, notes" }`.
  View: intro `Save videos you like. mostudio keeps them in your folder for reference.`; paste box `Paste one or more links` → each URL posted (auto-sorted; toast `Added to Short-form` / `Added to Long-form` with `Move`, which deletes and re-adds on the other shelf); two shelves (stacked < 900 px): dropzone, `accepts`, `Show folder in Finder`, links (platform, note, remove), files (name, size, remove).

- [ ] **Step 1: Write failing tests**

```ts
test("extractUrls", () => {
  assert.deepEqual(extractUrls("look https://youtu.be/a and\nhttps://www.instagram.com/reel/X/ https://youtu.be/a"), ["https://youtu.be/a", "https://www.instagram.com/reel/X/"]);
  assert.deepEqual(extractUrls("no links"), []);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): inspiration shelves with auto-sorted links and dropzones`

### Task 24: Tools view

**Files:** Create `dashboard/web/views/tools.ts`, `dashboard/web/lib/tools.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  export function formToParams(params: ToolParam[], values: Record<string, string | boolean>): Record<string, string | number | boolean>; // numbers parsed; empty optional dropped; throws `<label> must be a number`
  export function missingSteps(tool: ToolInfo, status: ProjectStatus, catalog: ToolInfo[]): string[]; // producing steps of unmet inputs, catalog order; "edits/*" always met
  ```
  View: cards (title, summary, "Used in" chips); a card opens a panel: options from `ToolParam` (choices → labelled select, toggle → switch, file → select of project uploads, provider → providers with that capability; `advanced` behind `More options`), project select, `Run on this project` (disabled with `Run <STEP_LABELS joined> first` when `missingSteps` non-empty), `Run again even if nothing changed` (`force`), live log, result, previews (Tasks 19–20); collapsed `Technical details` (inputs/outputs/gate).

- [ ] **Step 1: Write failing tests**

```ts
test("formToParams", () => {
  const ps = [p("pace", "string", true, "Pace"), p("maxGap", "number", true, "Max gap"), p("retakes", "boolean", true, "Retakes")];
  assert.deepEqual(formToParams(ps, { pace: "tight", maxGap: "0.3", retakes: false }), { pace: "tight", maxGap: 0.3, retakes: false });
  assert.deepEqual(formToParams(ps, { pace: "", maxGap: "" }), {});
  assert.throws(() => formToParams(ps, { maxGap: "abc" }), /Max gap must be a number/);
});
test("missingSteps names what to run first", async () => {
  const { buildCatalog } = await import("../../src/catalog.ts"); const { defaultSteps } = await import("../../../steps/index.ts");
  const catalog = buildCatalog(defaultSteps, [], () => "");
  const captions = catalog.find((t) => t.name === "captions")!;
  assert.deepEqual(missingSteps(captions, status({ ingest: "pass", transcribe: "pass" }), catalog), ["cut", "localize"]);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): tools with plain options and single-step runs`

### Task 25: Settings view

**Files:** Create `dashboard/web/views/settings.ts`, `dashboard/web/lib/settings.ts` (+ test).

**Interfaces:**
- Produces:
  ```ts
  export type ProviderGroup = { id: string; title: string; recommended: boolean; fields: SettingField[] };
  export function groupFields(fields: SettingField[]): { recommended: ProviderGroup[]; more: ProviderGroup[]; paths: SettingField[] };
  export function dirtyValues(original: SettingField[], edits: Record<string, string>): Record<string, string>;
  export function sourceText(f: SettingField): string;
  ```
  `sourceText`: app → `Saved in mostudio`; workspace → `Set in this workspace's .env.local (overrides mostudio)`; process → `Provided by your system (e.g. Bitwarden); can't be changed here`; unset → `Not set`.
  View: header `Your keys stay on this Mac, in <keysFile>.`; **Recommended** (Gemini, Groq) expanded; **More providers** collapsed. Provider card: masked value or `Not set`, `Get a key` (new tab), `Change` (password input with show/hide), `Reveal` only when `source === "app"` (30 s), source text, `Test connection` (sends unsaved values for that provider) with the result line. `Animated captions` switch, help `Moving word-by-word captions. Needs internet the first time and takes longer to render.` Sticky `Save changes` bar when `dirtyValues` is non-empty. Inputs `autocomplete="off"`, `spellcheck="false"`.

- [ ] **Step 1: Write failing tests**

```ts
test("groupFields puts recommended providers first", () => {
  const g = groupFields([f("MISTRAL_API_KEY", ["mistral"]), f("GROQ_API_KEY", ["groq"], true), f("GEMINI_API_KEY", ["gemini"], true), f("WHISPER_MODELS_DIR", [], false, "path")]);
  assert.deepEqual(g.recommended.map((x) => x.id), ["gemini", "groq"]);
  assert.deepEqual(g.more.map((x) => x.id), ["mistral"]);
  assert.deepEqual(g.paths.map((x) => x.name), ["WHISPER_MODELS_DIR"]);
});
test("dirtyValues only reports changes", () => { assert.deepEqual(dirtyValues([f("A", [])], { A: "new" }), { A: "new" }); assert.deepEqual(dirtyValues([f("A", [])], {}), {}); });
test("sourceText", () => { assert.match(sourceText({ source: "process" } as SettingField), /can't be changed here/); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): settings with recommended keys, tests and animated-captions switch`

---

## Part D — macOS portable zip (branch `feat/mac-portable`)

### Task 26: packaging script, pinned runtimes, launcher

**Files:** Create `scripts/package-mac.ts`, `scripts/package-mac.test.ts`, `packaging/runtime.lock.json`, `packaging/Start mostudio.command` (mode 755), `packaging/LICENSES/README.md`; Modify `package.json` (`"version": "0.1.0"`, script `"package:mac": "node scripts/package-mac.ts"`), `tsconfig.json` (`include` += `"scripts"`), `.gitignore` (`dist/`), `docs/provenance.md` (rows for the Node and ffmpeg builds).

**Interfaces:**
- Produces:
  ```ts
  export type Arch = "arm64" | "x64";
  export type Pinned = { url: string; sha256: string };
  export type RuntimeLock = { node: { version: string; arm64: Pinned; x64: Pinned };
    ffmpeg: { version: string; license: string; buildSource: string; sourceTarball: Pinned;
      arm64: { ffmpeg: Pinned; ffprobe: Pinned }; x64: { ffmpeg: Pinned; ffprobe: Pinned } } };
  export function appFiles(repoRoot: string): Promise<string[]>;               // repo-relative files copied into app/
  export function verifySha256(file: string, expected: string): Promise<void>; // throws `checksum mismatch for <file>`
  export function ffmpegCapsOk(filters: string, encoders: string): { ok: boolean; missing: string[] }; // needs filter "ass", encoders "h264_videotoolbox" and "aac"
  export function buildZip(o: { arch: Arch; repoRoot: string; outDir: string; lock: RuntimeLock; cacheDir: string }): Promise<string>;
  ```
  `appFiles` includes `core/**`, `cli/**`, `steps/**`, `dashboard/**`, `components/**`, `workflows/*.json`, `schemas/**`, `providers.json`, `package.json`, `LICENSE`, `README.md`; excludes every `*.test.ts`, `**/tests/**`, `**/fixtures/**`, `dashboard/src/testkit.ts`, `dashboard/web/lib/fixture-typed.ts`; never includes `.env*`, `mostudio.config.json`, `projects/`, `inspiration/`, `.claude/`, `.agents/`, `.superpowers/`, `spikes/`, `docs/`, `tasks/`, `node_modules/` (Review Focus 2).
  Zip layout (root folder `mostudio/`): `Start mostudio.command`, `How to open mostudio.txt` (Task 27), `app/…`, `runtime/node/` (official tarball extracted as-is: `bin/node`, `bin/npx`, `lib/node_modules/npm`), `runtime/bin/ffmpeg`, `runtime/bin/ffprobe`, `LICENSES/` (`node-LICENSE`, `ffmpeg-COPYING` (text for `ffmpeg.license`), `ffmpeg-BUILD.txt` = `ffmpeg -buildconf` output + version + where the source is, `mostudio-LICENSE`). Outputs: `dist/mostudio-<version>-mac-<arch>.zip` and `dist/ffmpeg-<version>-source.tar.xz` (GPL corresponding source; publish it next to every zip).
  `buildZip` steps: download to `cacheDir` (reuse on sha match) → `verifySha256` → extract with `tar -xf` → `chmod +x` → `codesign --force --sign - runtime/bin/ffmpeg runtime/bin/ffprobe` (ad-hoc; arm64 refuses unsigned code) → run bundled ffmpeg `-hide_banner -filters` / `-encoders`, fail unless `ffmpegCapsOk` (x64 only on an x64 host or via `arch -x86_64`; else print `skipped x64 runtime check (no Rosetta)`) → copy `appFiles` → `ditto -c -k --keepParent <stage>/mostudio <zip>` (keeps exec bits and symlinks).
  `packaging/runtime.lock.json`: Node `22.23.3` from `https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz` and `…-darwin-x64.tar.gz`, sha256 from that release's `SHASUMS256.txt`. ffmpeg: first candidate the static macOS builds from `ffmpeg.martin-riedl.de` (arm64 + amd64); fallback `osxexperts.net` (arm64) + `evermeet.cx` (x64). Pick the newest release whose binaries pass `ffmpegCapsOk`; never a build configured with `--enable-nonfree`; record exact URLs, sha256, license and the matching `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`, and add both builds to `docs/provenance.md`.
  `packaging/Start mostudio.command` (exact):
  ```bash
  #!/bin/bash
  # Double-click to start mostudio. Keep this window open while you work.
  here="$(cd "$(dirname "$0")" && pwd)"
  xattr -dr com.apple.quarantine "$here" 2>/dev/null || true
  export PATH="$here/runtime/node/bin:$here/runtime/bin:$PATH"
  export FFMPEG="$here/runtime/bin/ffmpeg" FFPROBE="$here/runtime/bin/ffprobe" MOSTUDIO_PACKAGED=1
  clear
  echo "Starting mostudio…"
  exec "$here/runtime/node/bin/node" --disable-warning=ExperimentalWarning "$here/app/cli/bin/mostudio.ts" ui --open
  ```
  (After the user approves the launcher once, the `xattr` line clears the download quarantine from the bundled Node and ffmpeg so macOS doesn't block each binary separately.)

- [ ] **Step 1: Write failing tests**

```ts
test("appFiles never ships secrets, footage or dev folders", async () => {
  const files = await appFiles(process.cwd());
  for (const f of files) assert.doesNotMatch(f, /(^|\/)\.env|^projects\/|^inspiration\/|^\.claude\/|^spikes\/|^docs\/|^tasks\/|\.test\.ts$|\/tests\/|testkit\.ts$/, f);
  for (const must of ["cli/bin/mostudio.ts", "core/src/index.ts", "dashboard/web/index.html", "workflows/short.json", "providers.json"]) assert.ok(files.includes(must), must);
});
test("ffmpegCapsOk", () => {
  assert.deepEqual(ffmpegCapsOk(" ass  V->V", " h264_videotoolbox x\n aac y"), { ok: true, missing: [] });
  assert.deepEqual(ffmpegCapsOk(" scale", " libx264"), { ok: false, missing: ["ass", "h264_videotoolbox", "aac"] });
});
test("verifySha256", async () => { /* file "abc" ↔ ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad; wrong hash rejects /checksum mismatch/ */ });
test("launcher is executable and uses the bundled runtime", () => {
  const p = "packaging/Start mostudio.command"; const text = readFileSync(p, "utf8");
  assert.ok(statSync(p).mode & 0o111);
  assert.match(text, /MOSTUDIO_PACKAGED=1/); assert.match(text, /runtime\/node\/bin\/node/); assert.match(text, /ui --open/);
});
test("lock file is complete", () => { /* every url https; every sha256 /^[0-9a-f]{64}$/ for node arm64/x64, ffmpeg+ffprobe arm64/x64, sourceTarball */ });
```

- [ ] **Step 2: Run** `node --test scripts/package-mac.test.ts` → FAIL.
- [ ] **Step 3: Fill `packaging/runtime.lock.json`** per the rules (download candidates, `shasum -a 256`, caps check on this arm64 Mac); record in `docs/provenance.md`.
- [ ] **Step 4: Implement** `scripts/package-mac.ts` (`node scripts/package-mac.ts [--arch arm64|x64|all]`, default `all`).
- [ ] **Step 5: Run** `node --test scripts/package-mac.test.ts && npm run typecheck` → PASS; `npm run package:mac` → two zips in `dist/`; `unzip -l dist/mostudio-0.1.0-mac-arm64.zip | grep -E "\.env|projects/|inspiration/"` prints nothing.
- [ ] **Step 6: Commit** `build: macOS portable zips with pinned Node and ffmpeg`

### Task 27: "How to open" guide and in-app version

**Files:** Create `packaging/How to open mostudio.txt`; Modify `dashboard/web/app.ts` (footer `mostudio <version>` from `/api/setup`), `scripts/package-mac.test.ts`.

`packaging/How to open mostudio.txt` (exact):
```
How to open mostudio (first time only)

1. Double-click the zip you downloaded. A "mostudio" folder appears.
   Move it wherever you like (for example into Applications).
2. Open the folder and double-click "Start mostudio".
3. macOS says it can't check the app for malware. Click "Done" (not "Move to Trash").
4. Open System Settings > Privacy & Security. Scroll down to the message about
   "Start mostudio" and click "Open Anyway". Confirm with your password or Touch ID.
5. Double-click "Start mostudio" again and click "Open".
   A small Terminal window opens and your browser shows mostudio.

Every next time: just double-click "Start mostudio".
Keep the Terminal window open while you work. Close it to quit mostudio.

Why the warning? mostudio is not signed by Apple yet. It runs only on your Mac;
your videos and keys never leave it, except the audio sent to the AI service
you choose (Groq, Gemini…) for transcription and subtitles.

Updating: download the new zip and replace the old "mostudio" folder.
Your videos (Movies/mostudio) and keys (~/.mostudio) are kept.
```

- [ ] **Step 1: Write a failing test**: the guide contains `Open Anyway`, `Privacy & Security`, `Movies/mostudio`, and no `--`; `buildZip`'s layout list includes `How to open mostudio.txt`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `docs: first-open guide for the unsigned macOS app; show version`

### Task 28: design QA and end-to-end on a clean Mac account

**Files:** Modify `dashboard/web/styles.css` and views as the audit requires; `README.md` (Getting started: download zip → open guide; developers: `mostudio init` → `mostudio ui`; `run --auto`); `tasks/todo.md` (review section); `docs/moskills-value.md` (entry).

- [ ] **Step 1: Design audit** — `/impeccable audit` then `/impeccable polish` on `dashboard/web/` (user rule). Fix all P0/P1: visible keyboard focus, keyboard-operable dropzones, no colour-only states, contrast ≥ 4.5:1 in both themes, 360 px without horizontal scroll, `prefers-reduced-motion`, every error through `errorBox`.
- [ ] **Step 2: Browser checks** with `playwright-skill` against `node cli/bin/mostudio.ts ui` (temp `MOSTUDIO_HOME`, no workspace): setup → "You're ready"; paste a Shorts link → Short-form shelf; upload a real 30 s talking clip with progress; review mode pauses at captions; `Apply fixes`, `Approve & continue` → final video plays; refresh mid-run keeps state; `Stop` during transcribe → `Stopped` within 2 s. Screenshots to the scratchpad; pass/fail into `tasks/todo.md`.
- [ ] **Step 3: Full suite** — `npm test && npm run typecheck` → all PASS (summary line into `tasks/todo.md`).
- [ ] **Step 4: Clean-account test (the user runs it; the agent prepares the checklist)** — new macOS user account without Homebrew or Node: download `dist/mostudio-0.1.0-mac-arm64.zip` through a browser (so quarantine applies) → follow the guide literally → setup → paste a Groq key → auto mode short video → `Show in Finder` → close Terminal → reopen → project still there. Same with the x64 zip on an Intel Mac or under Rosetta if available. Note every hesitation; fix copy before release.
- [ ] **Step 5: Security spot checks** — `curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.test" -H "x-mostudio-token: <t>" -X PUT http://127.0.0.1:<port>/api/settings -d '{}'` → `403`; `/api/settings` without cookie → `401`.
- [ ] **Step 6: Commit** (separate): `style(web): impeccable audit fixes`, `docs: getting started with the macOS app`. Publishing zips (GitHub release) is a separate user decision.

---

## Review record (Fable 5.2 findings → resolution)

| id | resolution |
|---|---|
| F1 terminal-only install; npm global can't strip TS | Part D portable zip + launcher; app lives outside `node_modules` |
| F2 HyperFrames needs npx/network | packaged default `ass` captions, opt-in "Animated captions" (Tasks 12, 14, 25); system check row (Task 5); Windows deferred (D2) |
| F3 parameter properties | Global Constraint; `HttpError`/`ApiFailure` declare fields |
| F4 workspace fell back to package | Task 2 `rootOf`; `PACKAGE_ROOT` never a workspace in the zip; default `~/Movies/mostudio` |
| F5 re-run captions lost workflow params | `POST /rerun` + `stepParams` (Tasks 3, 12, 22) |
| F6 writable binary paths; query token | paths not writable from UI; probes ignore path overrides; cookie/header token only (Tasks 7, 14) |
| F7 reveal exposes Bitwarden keys | reveal only `source: "app"` (Task 14) |
| F8 per-tab token | HttpOnly SameSite cookie (Task 7) |
| F9 no cancel | Task 4 (core), 11–12 (API), 22 (UI) |
| F10 shutdown hangs | `closeAllConnections` + `abortAll` (Tasks 7, 11) |
| F11 busy port | 4317–4327 then any (Task 7) |
| F12 CLI-speak errors | friendly server messages + `explainError`/`errorBox` (Tasks 12, 17) |
| F13 Windows chmod, cloud-synced keys | macOS only (D2); keys in `~/.mostudio/.env` (D4) |
| F14 waveform memory | server peaks endpoint (Task 10) |
| F15 terminal wizard | browser setup (Tasks 15, 18); `init` non-interactive (Task 6) |
| F16 `checkParams` not exported; mismatch handling | exported (Task 3); 409 before start (Task 12) |
| F17 too many providers | stt/llm only; Groq/Gemini recommended (Tasks 14, 25) |
| F18 experimental strip | pinned bundled Node; `--disable-warning=ExperimentalWarning` in launcher |
| F19 marker from a live CLI run | pid liveness (Task 10) |
| F20 wrong examples README | not copied; fixed (Task 6); no forced `.gitignore` |
| F21 workflows shadowing | per-file merge (Task 2) |
| F22 headers, decode, timing-safe, realpath, disk space | Tasks 7, 8 |
| F23 tests didn't match fixtures | Task 3 uses `base()`/`fake()`; Task 8 typed fixture |
| F24 big UI task, manual-only views | Studio split (21/22); playwright checks (28) |
| F25 nothing reads inspiration | stated in UI + READMEs; consumer = later plan |
| F26 Windows/Linux specifics | out of scope (D2); accented paths tested (Tasks 6, 8, 15) |

## Self-review record

- **Coverage:** R0 → Part D + Tasks 15, 17, 18, 22, 27, 28; R1 → 2, 6, 15, 18; R2 → 9, 23; R3 → 10–12, 19–22; R4 → 3, 12, 22; R5 → 13, 24; R6 → 1, 14, 25. D1 → 26; D2 → 26/27 (mac only); D3 → 27; D4 → 1, 2, 14.
- **Steps scan:** one-line `/* … */` test bodies name exact inputs and expected outputs; no TBD lines. Task 26 Step 3 is a sourcing step with explicit acceptance rules (caps check, sha256, license, no nonfree).
- **Types:** `RunMode`, `RunEvent(Body)`, `StepView`, `ProjectStatus`, `WorkflowInfo`, `ToolInfo/ToolParam/Knob`, `SettingField`, `ProbeResult`, `SetupState`, `Inspiration*`, `RunRequest/StepRequest/ApproveRequest` live in `dashboard/src/types.ts`; `Check`, `ScaffoldEntry`, `AppSettings` in core; Part C uses the same names. `UPLOAD_EXTS` (T10) ↔ `MEDIA_EXTS` (T21) parity test. `stepParams`/`checkParams` (T3) used in T12. `runWithSignal`/`CancelledError` (T4) used in T11–12. `openPath` (T7) used in T9.
- **Known limits (accepted):** an upload is copied again into `media/` by ingest (disk check accounts for it); a CLI run and a dashboard run on one project at once are only guarded by pid markers; NVIDIA keys can't be verified for free; macOS asks once to open the unsigned launcher (guide covers it); animated captions in the packaged app need internet on first use.
