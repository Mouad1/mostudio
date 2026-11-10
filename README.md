# mostudio

CLI and agent skill for video editing: ingest, transcribe, rough-cut and reel assembly, with zero runtime dependencies.

Status: pre-alpha.

## Requirements

- Node >= 22.18 (runs TypeScript directly)
- ffmpeg

## API keys

Free-tier provider keys (Groq, Gemini, …) are read from the environment. Two ways to provide them:

- **Bitwarden Secrets Manager (recommended):** store the machine-account access token in the macOS keychain once (`security add-generic-password -a "$USER" -s bws-hermes -w`), then run commands through `cli/bin/mostudio-bws` instead of `cli/bin/mostudio.ts`. Keys exist only in that process. `cli/bin/mostudio-bws --check` lists which keys are available (names only). Override with `MOSTUDIO_BWS_KEYCHAIN` and `MOSTUDIO_BWS_SERVER` (default `https://vault.bitwarden.com`).
- **`.env.local`:** copy `.env.example` to `.env.local` (gitignored) and fill the values.

## Test

```
npm test
```

## Design

See [docs/superpowers/specs/2026-11-09-mostudio-design.md](docs/superpowers/specs/2026-11-09-mostudio-design.md).

License: MIT
