# mostudio

Local dashboard and CLI for video editing: ingest, transcribe, rough-cut and reel assembly.

Status: pre-alpha.

## Getting Started

### 1. Portable macOS App (Creators)

The beta ZIP is for Apple Silicon Macs (M1 or newer) on macOS 12 or later. On [GitHub Releases](https://github.com/Mouad1/mostudio/releases), open the latest release, expand **Assets** and download `mostudio-<version>-mac-arm64.zip`. On an Intel Mac, [run from source](#2-developer--cli-setup).

The ZIP is not signed by Apple yet, so the first launch needs **Open Anyway** in System Settings. **How to open mostudio.txt** inside the folder walks through it.

1. Open **Finder > Downloads** after downloading the ZIP. If it went to a different folder, use **Show in Finder** from your browser’s downloads list. For a ZIP you built, open the checkout’s `dist/` folder.
2. Double-click the ZIP to extract the `mostudio` folder.
3. Inside `mostudio`, double-click **Start mostudio** (`Start mostudio.command`). For the first launch, follow **How to open mostudio.txt** beside the launcher.
4. Finish workspace setup in the browser. The dashboard runs on your Mac. If you configure a cloud AI provider, it receives the audio or text needed for the steps you run.

#### Build an Apple Silicon candidate

On an Apple Silicon Mac with Xcode command-line tools and CMake, build the pinned FFmpeg runtime and package its verified files:

```bash
bash scripts/build-ffmpeg-mac.sh /tmp/mostudio-controlled-ffmpeg
npm run package:mac -- --ffmpeg-build /tmp/mostudio-controlled-ffmpeg
```

`dist/controlled-mac-arm64/` contains the ZIP, the corresponding FFmpeg source archive, and `SHA256SUMS`. Each release publishes the same three files. See `packaging/ffmpeg-build.md` for the build details.

### 2. Developer & CLI Setup

If you prefer using the terminal or running from source:

```bash
# 1. Initialize project folders and check system dependencies
node cli/bin/mostudio.ts init

# 2. Launch the dashboard and open the link printed in the terminal
MOSTUDIO_ROOT="$HOME/Movies/mostudio" node cli/bin/mostudio.ts ui
```

## Requirements

- Node >= 22.18 (runs TypeScript directly)
- FFmpeg and FFprobe. Use an FFmpeg build with `libass` to burn captions.

## Directory Structure & Personal Files

To keep personal assets, API secrets, and raw video footage separate from the source code, organize your personal files according to the following layout:

```
mostudio/
├── .env.local             # Personal API keys (Groq, Gemini, Cloudflare, etc. - gitignored)
├── projects/              # Working video projects (gitignored)
│   └── <project-slug>/    # Individual project workspace (source footage, transcripts, cache, renders)
├── inspiration/           # Local creative references and notes (collections are gitignored)
│   ├── shorts/links.txt   # Short-form video inspiration URLs (Reels, TikToks, Shorts)
│   └── long/links.txt     # Long-form video inspiration URLs (YouTube)
└── examples/              # Sample workflows, demo project templates, and mock inputs
    └── README.md          # Guide & template layout for example projects
```

### Where to Place Your Files:

1. **API Keys & Credentials:**
   - Use **Settings** in the dashboard or create `.env.local` in your workspace using `.env.example` as a template.

2. **Video Projects & Personal Media (`projects/`):**
   - For the default workspace, run `MOSTUDIO_ROOT="$HOME/Movies/mostudio" node cli/bin/mostudio.ts new my-video` from the source checkout.
   - The command prints the project folder. Put your footage there, then pass that folder to `mostudio run short --project <dir>`.
   - All contents inside `projects/` are gitignored to ensure personal footage and intermediate cache files are never committed to version control.

3. **Inspirations & References (`inspiration/`):**
   - Store URLs of videos, reels, editing styles, or music references you want to model.
   - Add URLs to `inspiration/shorts/links.txt` for 9:16 vertical content (Instagram Reels, TikTok, YouTube Shorts).
   - Add URLs to `inspiration/long/links.txt` for 16:9 landscape content (YouTube, interviews, podcasts).
   - Add text or Markdown notes for pacing, hooks, or sound design ideas. The source checkout has more detail in `inspiration/README.md`.

4. **Examples & Templates (`examples/`):**
   - Place reproducible project structures, sample JSON parameters, or mock caption fixtures in `examples/`.
   - See `examples/README.md` in the source checkout for the layout.

## API keys

Add your provider keys in **Settings** or in `.env.local` in your workspace. Transcription needs a supported cloud provider such as Groq or a local Whisper model. For cloud steps, your provider receives your key for authentication and the audio or text needed for the request.

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

## Dashboard UI

Start the local dashboard server:

```
mostudio ui [--port <n>] [--open]
```

Alias: `mostudio dashboard`.

- `--port <n>`: Bind to a specific port. By default, picks a free port between 4317 and 4327.
- `--open`: Open the dashboard in your browser on macOS. On other systems, start without this flag and open the link printed in the terminal.
- Press `Ctrl+C` or close the terminal window to stop the dashboard cleanly.

## Test

```
npm test
```

## Third-party materials

See `docs/provenance.md` in the source checkout or `LICENSES/` next to the Mac launcher.

License: MIT
