# transcribe

Word-level transcript of the ingested clip. Rotates free STT providers (Groq, Cloudflare Workers AI, local whisper.cpp) through core `withProvider`; the step is `private`, so only providers that do not train on data are picked.

- **Input:** `media/ingest.json` (and the media file it names). Params: `language` (optional ISO code; whisper-cpp uses `auto` when absent), `prefer` (optional provider id tried first).
- **Outputs:** `transcript/audio.wav` (16 kHz mono PCM) and `transcript/words.json` (`{ language, provider, durationSec, words: {w,start,end,conf?}[], segments: {start,end,text}[] }`, source timeline, seconds).
- **Chunking:** audio longer than 600 s is cut near each 600 s mark at the quietest point within +-10 s (so a chunk may run up to 610 s). HTTP providers get mp3 64 kb/s mono chunks and whisper-cpp gets WAV chunks, both in `cache/transcribe/`. Each chunk goes through `withProvider` on its own and may land on a different provider; word times are offset by chunk start.
- **Metrics:** `wordCount`, `pctTimestamped`, `meanConfidence` (1 with `confidenceKnown: false` when the provider gives none, e.g. whisper-cpp), `language`, `chunks`, `runtimeSec`, `provider` (the one that served most chunks).
- **Gate:** `pctTimestamped >= 95` fail, `wordCount > 0` fail (music-only clip), `meanConfidence >= 0.7` warn. Zero words still writes `words.json` with `words: []`.
- **Binaries:** ffmpeg via `resolveFfmpeg`; `whisper-cli` via `WHISPER_CLI`; models from `WHISPER_MODELS_DIR` (`ggml-<model>.bin`). Cloudflare needs `CLOUDFLARE_ACCOUNT_ID`.

```
mostudio step transcribe --project <dir> [--param language=en] [--param prefer=whisper-cpp]
```
