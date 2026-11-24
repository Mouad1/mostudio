# transcribe

Word-level transcript of the ingested clip. Rotates free STT providers (Groq, Cloudflare Workers AI, local whisper.cpp) through core `withProvider`; the step is `private`, so only providers that do not train on data are picked.

- **Input:** `media/ingest.json` (and the media file it names). Params: `language` (optional ISO code; whisper-cpp uses `auto` when absent), `prefer` (optional provider id tried first), `prompt` (optional text sent to the model as context: names, tech terms; Groq `prompt`, Cloudflare `initial_prompt`, not whisper-cpp), `dialect` (optional; only `darija`, anything else fails; cannot be combined with `language`).
- **Outputs:** `transcript/audio.wav` (16 kHz mono PCM on the container timeline: a late audio start and timestamp gaps are padded with silence, so word times match the picture) and `transcript/words.json` (`{ language, provider, durationSec, words: {w,start,end,conf?}[], segments: {start,end,text}[] }`, source timeline, seconds).
- **Chunking:** audio longer than 600 s is cut near each 600 s mark at the quietest point within +-10 s (so a chunk may run up to 610 s). HTTP providers get mp3 64 kb/s mono chunks and whisper-cpp gets WAV chunks, both in `cache/transcribe/`. Each chunk goes through `withProvider` on its own and may land on a different provider; word times are offset by chunk start.
- **`dialect=darija`** (Moroccan Darija, code-switched with French/English): audio is split into ~30 s windows at the quietest point within +-5 s of each 30 s mark; a last window that would be under 10 s joins the one before it (a short, mostly silent window makes Whisper read the prompt back). Each window first runs pass A: `language=ar` plus a built-in Darija prompt (Arabic script with typical French/tech loanwords; your `prompt` is appended). Auto language rewrites Darija into Modern Standard Arabic, which pass A avoids. When A reads as MSA (`msaScore` = MSA markers like `سوف الذي لقد` minus Darija markers like `ديال دابا واش` > 0), pass B runs with no language; B wins only if it detected French or English (forcing `ar` translates French speech into MSA). A failing pass B keeps A. Each window's choice is logged. Loanwords written phonetically in Arabic script (`الوتي` = outil) are normal; the `localize` step turns them into Latin script.
- **Hallucination filter (always on):** a segment whose normalized text (lowercase, no punctuation or diacritics) equals, or is a run of whole words inside, a known Whisper silence line (`اشتركوا في القناة`, `ترجمة نانسي قنقر`, `thanks for watching`, Amara.org credits, ...) is dropped together with the words whose midpoint is inside it. List in `src/hallucinations.ts`.
- **Text with no speech under it (always on, per chunk/window, before a Darija pass is judged):** (1) **prompt echo**: a segment of 4+ words of which at least half sit in runs of 4+ words copied in order from the prompt sent with that call (built-in Darija prompt plus `prompt`) is dropped with its words; real speech sharing a few prompt words stays. (2) **collapsed runs**: 3+ consecutive words lasting <= 25 ms each are dropped, plus the next word when it ends its segment; Groq's whisper-large-v3 aligns a repeated sentence, or a French translation of the line before it, this way (20 ms per word, no audio left for it). A segment that loses words keeps the text and span of the words left, or goes. Words belong to segments in transcript order when the segment texts split on spaces are exactly the words (every Groq reply seen; Groq can time a segment's last words past the next segment's start), else to the last segment starting at or before their midpoint. Code in `src/echo.ts`.

```mermaid
flowchart LR
  R[STT reply for a chunk or Darija window] --> E[drop segments that read the prompt back]
  E --> C[drop runs of 3+ words of <= 25 ms]
  C --> P[Darija: judge pass A / B]
  P --> H[hallucination blocklist, non-speech, timing fixes]
```

Each STT reply is cleaned (E, C) before anything else reads it, so a Darija pass is judged on speech only.

- **Silent audio:** when no 10 ms window of the audio rises above -60 dBFS the clip is not sent to any provider (Whisper invents "Thank you." over silence): zero words, and the step fails with `no words in transcript` (shown as "No speech found") instead of failing later at the mix.
- **Metrics:** `wordCount`, `pctTimestamped`, `meanConfidence` (1 with `confidenceKnown: false` when the provider gives none, e.g. whisper-cpp), `language`, `chunks`, `runtimeSec`, `provider` (the one that served most chunks), `nonSpeechDropped`, `silentAudio`, `hallucinationsDropped` (segments), `promptEchoDropped` and `collapsedDropped` (words); with `dialect`: `windows`, `autoWindows` (windows that used pass B).
- **Gate:** `pctTimestamped >= 95` fail, `wordCount > 0` fail (music-only clip), `meanConfidence >= 0.7` warn. Zero words still writes `words.json` with `words: []`.
- **Binaries:** ffmpeg via `resolveFfmpeg`; `whisper-cli` via `WHISPER_CLI`; models from `WHISPER_MODELS_DIR` (`ggml-<model>.bin`). Cloudflare needs `CLOUDFLARE_ACCOUNT_ID`.

```
mostudio step transcribe --project <dir> [--param language=en] [--param prefer=whisper-cpp]
mostudio step transcribe --project <dir> --param dialect=darija [--param "prompt=mostudio, HyperFrames"]
```
