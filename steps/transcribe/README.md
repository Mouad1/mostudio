# transcribe

Word-level transcript of the ingested clip. Rotates free STT providers (Groq, Cloudflare Workers AI, local whisper.cpp) through core `withProvider`; the step is `private`, so only providers that do not train on data are picked.

- **Input:** `media/ingest.json` (and the media file it names). Params: `language` (optional ISO code; whisper-cpp uses `auto` when absent), `prefer` (optional provider id tried first), `prompt` (optional text sent to the model as context: names, tech terms; Groq `prompt`, Cloudflare `initial_prompt`, not whisper-cpp), `dialect` (optional; only `darija`, anything else fails; cannot be combined with `language`).
- **Outputs:** `transcript/audio.wav` (16 kHz mono PCM) and `transcript/words.json` (`{ language, provider, durationSec, words: {w,start,end,conf?}[], segments: {start,end,text}[] }`, source timeline, seconds).
- **Chunking:** audio longer than 600 s is cut near each 600 s mark at the quietest point within +-10 s (so a chunk may run up to 610 s). HTTP providers get mp3 64 kb/s mono chunks and whisper-cpp gets WAV chunks, both in `cache/transcribe/`. Each chunk goes through `withProvider` on its own and may land on a different provider; word times are offset by chunk start.
- **`dialect=darija`** (Moroccan Darija, code-switched with French/English): audio is split into ~30 s windows at the quietest point within +-5 s of each 30 s mark. Each window first runs pass A: `language=ar` plus a built-in Darija prompt (Arabic script with typical French/tech loanwords; your `prompt` is appended). Auto language rewrites Darija into Modern Standard Arabic, which pass A avoids. When A reads as MSA (`msaScore` = MSA markers like `سوف الذي لقد` minus Darija markers like `ديال دابا واش` > 0), pass B runs with no language; B wins only if it detected French or English (forcing `ar` translates French speech into MSA). A failing pass B keeps A. Each window's choice is logged. Loanwords written phonetically in Arabic script (`الوتي` = outil) are normal; the `localize` step turns them into Latin script.
- **Hallucination filter (always on):** a segment whose normalized text (lowercase, no punctuation or diacritics) equals, or is a run of whole words inside, a known Whisper silence line (`اشتركوا في القناة`, `ترجمة نانسي قنقر`, `thanks for watching`, Amara.org credits, ...) is dropped together with the words whose midpoint is inside it. List in `src/hallucinations.ts`.
- **Metrics:** `wordCount`, `pctTimestamped`, `meanConfidence` (1 with `confidenceKnown: false` when the provider gives none, e.g. whisper-cpp), `language`, `chunks`, `runtimeSec`, `provider` (the one that served most chunks), `nonSpeechDropped`, `hallucinationsDropped` (segments); with `dialect`: `windows`, `autoWindows` (windows that used pass B).
- **Gate:** `pctTimestamped >= 95` fail, `wordCount > 0` fail (music-only clip), `meanConfidence >= 0.7` warn. Zero words still writes `words.json` with `words: []`.
- **Binaries:** ffmpeg via `resolveFfmpeg`; `whisper-cli` via `WHISPER_CLI`; models from `WHISPER_MODELS_DIR` (`ggml-<model>.bin`). Cloudflare needs `CLOUDFLARE_ACCOUNT_ID`.

```
mostudio step transcribe --project <dir> [--param language=en] [--param prefer=whisper-cpp]
mostudio step transcribe --project <dir> --param dialect=darija [--param "prompt=mostudio, HyperFrames"]
```
