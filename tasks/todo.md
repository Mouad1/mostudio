# Work plan

> Keep completed items for history. Plan non-trivial work before implementation; record prerequisites and observed evidence. Users do not need to invoke workflow commands.

## Agreed scope

- Request / outcome: design spec for mostudio, challenged by independent agents, approved by user.
- Acceptance criteria / exclusions: spec covers intent, goals, constraints, decisions; builder-check + red-team run (max 2 passes); user approval. No product code.
- Constraints / unresolved decisions: project name `mostudio` is a working name; dependency approvals pending (PySceneDetect, OpenTimelineIO, React/Vite/playwright-core).

## Dependency order

1. Required foundations / shared contracts:
2. Dependent work (parallel only when independent):
3. Integration and proportionate verification:

## Checklist

- [x] Create repo, install moskills (doctor OK).
- [x] Write spec + moskills value log.
- [x] Challenger pass 1 (builder check + red-team).
- [x] Fold findings, user questions (3 answered).
- [x] User approves spec (2026-11-09).
- [x] Plan 1 written: docs/superpowers/plans/2026-11-09-plan-1-foundation.md (awaiting approval)
## Modules (Plan 1)
- [x] module-scaffold: zero-dep TS workspace (03218a5..3b37e45)
- [x] module-s2-render-spike: HyperFrames → ffmpeg proven, ADR 0002 proposed (accepted 2026-11-10)
- [x] module-core: types, ledger, gate, config/providers/quotas, step runner (94c5224..527a459 + final fixes)
- [x] module-cli: new / step / status (bfbe154 + final fixes)
- [x] module-ingest: probe + import with gate (4855227 + final fixes)
- [ ] module-s1-stt-spike: blocked on user's 3 Darija clips + references + GROQ key in .env.local
- [x] User acceptance: ADR 0002, core, ingest (2026-11-10). Real phone clip check still optional.
- [ ] Establish required foundations.
- [ ] Complete dependent work within agreed scope.
- [ ] Verify applicable gates and record evidence.
- [ ] Complete bounded review (at most two challenger/fixer passes for non-trivial work).
- [ ] Record Finished / Still not done and next actions.

## Finished

- None yet.

## Still not done

- No work assessed yet.

## Review / evidence

| Gate | Required? | Status | Evidence / reason / next action |
| --- | --- | --- | --- |
| Behavior | undecided | unknown | |
| Visual | undecided | unknown | |
| Code / config / docs | undecided | unknown | |
| Human completion validation | when requested | unknown | |

- Review passes: 1 / 2; 19 findings, all folded into spec §13; findings, fixes, and unresolved issues:
- Limitations / exact next step:
- Required failed or unknown gates keep work Still not done. Not applicable needs a reason.
- User validation is always required before commit, push, or merge; completion checks do not authorize these actions.

## Modules (Plan 2 — rough cut)
- [x] core: optional params, timeline + word-timing normalization, envelope, ffmpeg/encoder picker, provider loop (429 Retry-After, per-capability exhaustion), loudness, HyperFrames runner, workflow runner
- [x] steps: transcribe (Groq→Cloudflare→whisper.cpp), cut, captions, mix, chapters, assemble (HDR tone-map, CFR, HyperFrames shorts), qa
- [x] CLI run/approve/status; workflows rough-cut + short
- [x] Live smoke on Marginol clip: rough-cut done (−14.4 LUFS, endDrift 10 ms), shorts render via HyperFrames
- [ ] Task 11: real 10–20 min rush (needs user's clip), measure user time (G2 ≤ 30 min)

## Plan 2.1 — Darija transcription + caption languages (2026-11-13)

Goal: Darija rushes give clean captions in the audience's language: `arabizi` (Morocco), `fr`, `en`. Never Arabic script on screen.
Evidence driving it: S1 results (spikes/s1-stt/RESULTS.md) + first real rush (MSA drift, fake "اشتركوا في القناة", 62 % Arabic script).

- [ ] transcribe v4: `dialect=darija` → ~30 s windows, two passes (ar + Darija prompt / auto); keep auto only when it hears FR/EN and the ar pass reads as MSA. Drop known Whisper hallucination segments. `prompt` param. Metrics: windows, autoWindows, hallucinationsDropped.
- [ ] core: `transcribeAudio` takes `prompt`; `core/src/units.ts` (Unit type, unitsToWords).
- [ ] localize v1 (new step): cut-timeline sentence units → LLM (provider rotation) → `localize/units.json` in `lang` (source|arabizi|fr|en). Gate: arabicScriptPct == 0 when lang ≠ source.
- [ ] captions v3 + chapters v4 read `localize/units.json` (titles and cues in the same language).
- [ ] workflows: localize after cut in rough-cut and short.
- [ ] Real check: first half of the 2026-11-12 rush in arabizi, fr, en; contact sheets + caption samples to user.

## Plan 3 — Dashboard, Onboarding Wizard, and Portable macOS App (2026-11-13..14)

- [x] Part A: Init wizard, .env.local parser, workspace resolution, run --auto, cancellation signal, system check (Tasks 1–6)
- [x] Part B: Dashboard server core, static HTTP range, inspiration API, projects API, SSE events, run routes, tools catalog, settings API, setup wizard API, mostudio ui launcher (Tasks 7–16)
- [x] Part C: Web shell, setup wizard view, pipeline state & stepper, 10 step output previews, Studio A & B, Inspiration view, Tools view, Settings view (Tasks 17–25)
- [x] Part D: Portable macOS app packaging script (scripts/package-mac.ts), pinned runtime lock (packaging/runtime.lock.json), launcher script (packaging/Start mostudio.command), Gatekeeper first-open guide (packaging/How to open mostudio.txt), in-app version display, design audit and accessibility polish (Tasks 26–28)
- Test suite: 672 tests passing, clean typecheck across root and web.
