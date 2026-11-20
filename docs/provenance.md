# Provenance

Third-party code, prose, or assets used in mostudio.

| Part | Source | License | How used | Date |
|------|--------|---------|----------|------|
| ingest ffmpeg/ffprobe spawn pattern | tubemauto packages/media/src/ffmpeg.ts (user's own repo) | owner's code, relicensed MIT | adapted | 2026-11-09 |
| transcribe whisper.cpp JSON parsing (word offsets, skip punctuation tokens) | tubemauto packages/providers/src/whisper-cpp.ts (user's own repo) | owner's code, relicensed MIT | idea adapted, rewritten | 2026-11-10 |
| captions ASS timestamp and text escaping | tubemauto packages/media/src/captions.ts (formatAssTimestamp, escapeAssText; user's own repo) | owner's code, relicensed MIT | written from the idea of (not copied) | 2026-11-11 |
| portable macOS runtime Node.js | https://nodejs.org/dist/v22.23.3/ (official macOS darwin-arm64 and darwin-x64 binaries) | Node.js license (MIT-like) | bundled in dist/ portable zip | 2026-11-14 |
| portable macOS runtime FFmpeg & FFprobe | https://ffmpeg.martin-riedl.de (v9.0.2 macOS arm64/amd64 static builds; source tarball from https://ffmpeg.org/releases/) | GPLv3 | bundled in dist/ portable zip | 2026-11-14 |
