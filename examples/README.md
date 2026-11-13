# Examples & Project Templates

This directory provides reference templates, sample configurations, and guides on how projects and assets are structured in `mostudio`.

## Project Directory Structure

Working projects live inside the root `projects/<project-slug>/` directory (which is gitignored to protect personal video footage and intermediate renders).

When a project is created and runs workflows, its directory is structured as follows:

```
projects/<project-slug>/
├── ingest/
│   └── source.mp4           # Ingested video/audio file
├── transcribe/
│   ├── transcript.json      # Word-level timestamps, confidence scores, and language detection
│   └── words.json           # Filtered word list
├── captions/
│   └── captions.txt         # Timed caption segments grouped for readability
├── edits/
│   └── replacements.txt     # Manual overrides for spelling, terminology, or translations
└── steps/
    ├── workflow.json        # Active workflow name (e.g. "short" or "rough-cut")
    ├── workflow-params.json # Saved parameters for reproducible re-runs
    └── approvals.json       # Interactive step approval status
```

## Running Example Workflows

To create and run a project:
```bash
# 1. Initialize a new project directory
mostudio new --project projects/my-sample-video

# 2. Run the short-form workflow (9:16 vertical shorts/reels preset)
mostudio run short --project projects/my-sample-video

# 3. Or run the rough-cut workflow (16:9 YouTube landscape preset)
mostudio run rough-cut --project projects/my-sample-video
```
