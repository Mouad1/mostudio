# mix

Renders the cut voice track once from the edit list, optionally adds background music ducked under the voice, and normalizes loudness. Output: `audio/mix.wav`, 48 kHz stereo, cut timeline.

- **Inputs:** `media/ingest.json`, `cut/edl.json`. A source with `hasAudio: false` fails with "source has no audio track".
- **Output:** `audio/mix.wav` (pcm_s16le).
- **Params:** `music` (absolute file path; its bytes join the cache hash), `musicDb` (default -21), `targetLufs` (default -14).
- **Voice:** each `keep` is trimmed from the source with `afade` in/out of `edl.fadeSec` (skipped when the keep is shorter than 2 fades), concatenated. Batches of at most 80 segments go to `cache/mix/batch-NNN.wav`, then a concat-demuxer list joins them; `cache/mix/` is removed afterwards.
- **Music:** looped (`-stream_loop -1`), trimmed to `outDurationSec`, set to `musicDb`, ducked by `sidechaincompress` (threshold 0.05, ratio 8, attack 20 ms, release 300 ms) keyed on the voice, then `amix` with the voice first. The threshold is an absolute level (-26 dBFS), so very quiet voice tracks duck little.
- **Loudness:** two-pass `loudnorm` (measure, then `linear=true`, `TP=-1`). `LRA` is set to 50 so linear mode is never abandoned for dynamic mode on material with a wide loudness range (dynamic mode pumps the music bed). The result is re-measured for the metrics.
- **Metrics:** `integratedLufs, truePeakDb` (1 decimal, measured on the output), `durationSec` (3 decimals), `segments, batches, hasMusic`. **Gate:** `integratedLufs` within [-15, -13] fail, `truePeakDb <= -1` fail.

```
mostudio step mix --project <dir> [--param music=/abs/song.mp3 --param musicDb=-18]
```
