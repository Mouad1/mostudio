# mostudio

CLI and agent skill for video editing: ingest, transcribe, rough-cut and reel assembly, with zero runtime dependencies.

Status: pre-alpha.

## Requirements

- Node >= 22.18 (runs TypeScript directly)
- ffmpeg

## Directory Structure & Personal Files

To keep personal assets, API secrets, and raw video footage separate from the source code, organize your personal files according to the following layout:

```
mostudio/
├── .env.local             # Personal API keys (Groq, Gemini, Cloudflare, etc. - gitignored)
├── projects/              # Working video projects (gitignored)
│   └── <project-slug>/    # Individual project workspace (source footage, transcripts, cache, renders)
├── inspiration/           # Creative reference links, style benchmarks, and notes
│   ├── shorts/links.txt   # Short-form video inspiration URLs (Reels, TikToks, Shorts)
│   └── long/links.txt     # Long-form video inspiration URLs (YouTube)
├── examples/              # Sample workflows, demo project templates, and mock inputs
│   └── README.md          # Guide & template layout for example projects
└── spikes/                # Local tech spikes and experiments
    └── */media/           # Test audio/video files used for benchmarks (gitignored)
```

### Where to Place Your Files:

1. **API Keys & Credentials:**
   - Store in `.env.local` (copy from `.env.example`). This file is gitignored.
   - Or use Bitwarden Secrets Manager via `cli/bin/mostudio-bws`.

2. **Video Projects & Personal Media (`projects/`):**
   - Create a project: `mostudio new --project projects/<slug>` (e.g. `projects/my-video`).
   - Place your raw camera footage, audio tracks, or recordings inside that project directory.
   - Run workflows pointing to it: `mostudio run short --project projects/<slug>`.
   - All contents inside `projects/` are gitignored to ensure personal footage and intermediate cache files are never committed to version control.

3. **Inspirations & References (`inspiration/`):**
   - Store URLs of videos, reels, editing styles, or music references you want to model.
   - Add URLs to `inspiration/shorts/links.txt` for 9:16 vertical content (Instagram Reels, TikTok, YouTube Shorts).
   - Add URLs to `inspiration/long/links.txt` for 16:9 landscape content (YouTube, interviews, podcasts).
   - Add text or markdown notes for pacing, hooks, or sound design ideas. See [inspiration/README.md](inspiration/README.md).

4. **Examples & Templates (`examples/`):**
   - Place reproducible project structures, sample JSON parameters, or mock caption fixtures in `examples/`.
   - See [examples/README.md](examples/README.md) for detailed layout specifications.

## API keys

Free-tier provider keys (Groq, Gemini, …) are read from the environment. Two ways to provide them:

- **Bitwarden Secrets Manager (recommended):** store the machine-account access token in the macOS keychain once (`security add-generic-password -a "$USER" -s bws-hermes -w`), then run commands through `cli/bin/mostudio-bws` instead of `cli/bin/mostudio.ts`. It goes through MoOS (`moos secrets run hermes -- …`), which forces the right Bitwarden server; keys exist only in that process. `cli/bin/mostudio-bws --check` lists which keys are available (names only). Override with `MOSTUDIO_BWS_PROJECT` (default `hermes`) and `MOOS_BIN` (path to `moos`).
- **`.env.local`:** copy `.env.example` to `.env.local` (gitignored) and fill the values.

## Workflows

`workflows/<name>.json` chains steps; `mostudio run <name> --project <dir>` runs them in order, skipping cached steps, and stops at the first failure. Shipped: `rough-cut` (16:9, youtube preset) and `short` (9:16, tight pace, shorts preset).

Captions for a Moroccan Darija video: `--param transcribe.dialect=darija` keeps the transcript in Darija (forced-Arabic pass with a Darija prompt, auto language only for windows spoken in French/English; add names and terms with `--param "transcribe.prompt=..."`), and `--param localize.lang=arabizi|fr|en` puts captions and chapter titles in the audience's language (`arabizi` = Darija in Latin letters). The default `localize.lang=source` keeps the transcript as is.

```
mostudio run short --project projects/<slug> --param transcribe.dialect=darija --param localize.lang=arabizi
```

```
mostudio run rough-cut --project projects/<slug> [--param <step>.<key>=<value>]... [--force <step>]... [--switch-workflow] [--auto] [--json]
mostudio approve captions --project projects/<slug>
```

A step with `"approve": true` pauses the run (exit 3) after it succeeds. Review its outputs (for captions: `captions/captions.txt`, fixes go in `edits/replacements.txt`), re-run the same command, then `mostudio approve <step>`; the next run continues. Approval is tied to the step's input hash, so changing its inputs asks again. Pass `--auto` to auto-approve human review gates without pausing (gate metric failures still halt the run). `--param` overrides the workflow's own params for that step. Exit codes: 0 done, 2 failed, 3 awaiting approval, 64 usage error.

One project runs one workflow: the first `run` records its name in `steps/workflow.json`, and running a different workflow on the same project exits 64 ("this project ran <name>; create a new project (mostudio new) or pass --switch-workflow"). Start a new project with `mostudio new`, or pass `--switch-workflow` to switch on purpose.

`--param` values are remembered per project and workflow (`steps/workflow-params.json`, `{ <workflow>: { <step>: { <key>: <value> } } }`; the older flat file is migrated when read), so re-runs resume without repeating them (e.g. `ingest.source`); to change one, pass it again, and to forget one pass an empty value (`--param ingest.source=`). Params are validated against the step's contract before being remembered; a typo exits 64 and saves nothing. `--force <step>` on an approval step also clears its approval. `mostudio status --project <dir>` lists each step's latest result and marks an approval step of the project's workflow that is still "awaiting approval". State files such as `steps/approvals.json` have no lock: don't run two commands on the same project at once.

## Test

```
npm test
```

## Design

See [docs/superpowers/specs/2026-11-09-mostudio-design.md](docs/superpowers/specs/2026-11-09-mostudio-design.md).

License: MIT
