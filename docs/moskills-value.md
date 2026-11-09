# moskills value log

Purpose: measure what the moskills standard actually adds to mostudio, so the user can judge it with evidence, not impressions.

## Baseline (2026-11-09)

- Repo before install: empty (`git init`, 0 files).
- Install: `moskills init --target . --agents` from the main moskills checkout (v0.9.0, commit af3ba05). `doctor`: OK.
- Note: the Claude plugin's `moskills-init` command points at a stale worktree (`.worktrees/pr39`, branch `claude/zealous-cori-70pe75`, 2 weeks older than `main`). Main checkout used instead. Worth fixing in moskills.

## What it added (89 files)

| Area | Files | What it gives |
|---|---|---|
| Standard (`.claude/standard/`) | base, delegation, session-protocol + checksum manifest | routing of requests to capabilities, plan → gates → finished/still-not-done, bounded review (max 2 challenger passes) |
| Skills ×15 (`.claude/skills/` and `.agents/skills/`) | align-intent, checkpoint, compress-input, design-system, diagnose, evolvebook, gatekeeper, handoff, learn, modular-build, preview, project-dna, shared-language, system-map, tdd | same workflow for Claude and for Codex/Gemini/Antigravity via `.agents/` |
| Commands ×14 (`.claude/commands/`) | slash shortcuts for the skills | optional; ordinary language works too |
| Project seeds | CLAUDE.md, AGENTS.md, `.claude/STATE.md`, `tasks/todo.md`, `tasks/lessons.md` | durable state across sessions, plan + evidence tables, lesson log |
| Guard | `.claude/hooks/agent-guard.sh` (not wired as git hook: install was without `--with-hooks`) | blocks conflict markers / placeholder phrases when enabled |
| Config | `.moskills.json`, `.claude/settings.local.json` (gitignored) | version pin, small allowlist |
| Evolvebook engine | template + `evolvebook.sh` | the evolving-skill mechanism mostudio is built on |

## Expected value (hypotheses to verify)

1. H1 — Evolvebook gives mostudio its "improves every run" loop for free.
2. H2 — run-state proof stops "done" claims without passing checks.
3. H3 — `.agents/` mirror makes the repo usable by Codex/Gemini without extra work (supports goal G3).
4. H4 — STATE/todo/lessons cut re-explaining between sessions.
5. H5 — bounded challenger review catches spec gaps early.

## Evidence log

Add one row each time moskills changed an outcome (good or bad).

| Date | Capability | What happened | Value (+/−/0) | Evidence |
|---|---|---|---|---|
| 2026-11-09 | install | 89 files, doctor OK in one command | + | install output |
| 2026-11-09 | delegation (bounded review) | pass 1: builder check + red-team found 19 issues; v1 cut from 6 phases to 2 spikes + 4 steps; 3 decisions sent to user | + | spec §13 |
| 2026-11-09 | project seeds | CLAUDE.md constraints + todo filled in < 5 min; gave reviewers a clear frame | + (small) | CLAUDE.md, tasks/todo.md |

| 2026-11-09 | modular-build + bounded review | Plan 1 built as 8 modules, each with own review; 13 Important defects caught per task (secret leak, cache gaps, crash safety) + 8 by final review before any Plan 2 code depended on them | + | .superpowers ledger, 28 commits |
| 2026-11-09 | install (plugin path) | plugin's init command pointed at a stale worktree; main checkout used | − | baseline note |

## Costs to watch

- Footprint: 89 files before any product code; skills duplicated in `.claude/` and `.agents/`.
- Process overhead on small tasks.
- Version drift between plugin cache, worktrees and npm (seen at install).
