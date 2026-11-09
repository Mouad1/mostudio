# ingest

First step. Copies the user's media file into the project, probes it with ffprobe, records metrics, and gates on audio presence. The original file is never modified.

- **Input:** param `source` = absolute path to the video file (copied, not moved, to `media/<original name>`; re-running overwrites).
- **Outputs:** `media/<name>` and `media/ingest.json` (`{ file: "media/<name>", durationSec, fps, width, height, rotation, hasAudio, audioChannels, videoCodec, audioCodec?, sha256 }`). `width`/`height` are displayed dimensions after rotation.
- **Metrics:** `durationSec`, `fps`, `width`, `height`, `rotation`, `hasAudio`, `sha256`, `sizeMB`.
- **Gate (fail):** `hasAudio == true`, `durationSec > 0`.
- **Binaries:** `ffprobe`/`ffmpeg` from PATH, or `FFPROBE`/`FFMPEG` env vars. 120 s timeout; clear error if missing.

```
mostudio step ingest --project <dir> --param source=/path/clip.mov
```
