# mostudio

CLI and agent skill for video editing: ingest, transcribe, rough-cut and reel assembly, with zero runtime dependencies.

Status: pre-alpha.

## Requirements

- Node >= 22.18 (runs TypeScript directly)
- ffmpeg

## API keys

Free-tier provider keys (Groq, Gemini, …) are read from the environment. Two ways to provide them:

- **Bitwarden Secrets Manager (recommended):** store the machine-account access token in the macOS keychain once (`security add-generic-password -a "$USER" -s bws-hermes -w`), then run commands through `cli/bin/mostudio-bws` instead of `cli/bin/mostudio.ts`. It goes through MoOS (`moos secrets run hermes -- …`), which forces the right Bitwarden server; keys exist only in that process. `cli/bin/mostudio-bws --check` lists which keys are available (names only). Override with `MOSTUDIO_BWS_PROJECT` (default `hermes`) and `MOOS_BIN` (path to `moos`).
- **`.env.local`:** copy `.env.example` to `.env.local` (gitignored) and fill the values.

## Workflows

`workflows/<name>.json` chains steps; `mostudio run <name> --project <dir>` runs them in order, skipping cached steps, and stops at the first failure. Shipped: `rough-cut` (16:9, youtube preset) and `short` (9:16, tight pace, shorts preset).

```
mostudio run rough-cut --project projects/<slug> [--param <step>.<key>=<value>]... [--force <step>]... [--json]
mostudio approve captions --project projects/<slug>
```

A step with `"approve": true` pauses the run (exit 3) after it succeeds. Review its outputs (for captions: `captions/captions.txt`, fixes go in `edits/replacements.txt`), re-run the same command, then `mostudio approve <step>`; the next run continues. Approval is tied to the step's input hash, so changing its inputs asks again. `--param` overrides the workflow's own params for that step. Exit codes: 0 done, 2 failed, 3 awaiting approval, 64 usage error.

`--param` values are remembered per project (`steps/workflow-params.json`), so re-runs resume without repeating them (e.g. `ingest.source`); to change one, pass it again. `--force <step>` on an approval step also clears its approval. State files such as `steps/approvals.json` have no lock: don't run two commands on the same project at once.

## Test

```
npm test
```

## Design

See [docs/superpowers/specs/2026-11-09-mostudio-design.md](docs/superpowers/specs/2026-11-09-mostudio-design.md).

License: MIT
