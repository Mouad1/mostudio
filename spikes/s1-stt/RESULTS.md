# S1 — STT on Darija/FR/EN (round 1–2, 2026-11-13)

Clips: `darija-01` (mostly Darija, 57 s), `darija-02` (technical, 92 s), `darija-03` (FR/EN/Darija, 56 s).
Scripts: `run.sh` (3 engines, auto language), `run-ar.sh` (language=ar + Darija prompt), `wer.mjs` (normalized WER + word diffs).

**WER below is against the written script, not what was said** (the speaker changed words). Final numbers wait for corrected refs (`media/darija-0N.draft.txt` → `.ref.txt`).

| Engine | 01 | 02 | 03 | Speed (all 3 clips) |
|---|---|---|---|---|
| groq large-v3, auto | 68 % | 87 % | **51 %** | 4 s |
| groq large-v3, ar + prompt | **55 %** | **79 %** | 83 % | 4 s |
| whisper.cpp large-v3, auto | 62 % | 95 % | 53 % | 124 s |
| whisper.cpp large-v3, ar + prompt | 58 % | 124 % | 98 % | ~130 s |
| whisper.cpp turbo, auto | 80 % | 117 % | 40 % | 53 s |

## Findings (by reading the outputs)

1. **Auto language rewrites Darija into MSA** (`سوف اشرح لكم كيفية تعمل`) or into French (clip 03). Content is lost, not just misspelled.
2. **Groq + `language=ar` + Darija prompt gives near-verbatim Darija** on Darija-heavy speech (01, 02). Most remaining "errors" are French loanwords written phonetically in Arabic script (`الوتي` = outil, `سوتيتر` = sous-titres, `الكابشنز` = captions) and the speaker's own word changes.
3. **Forcing `ar` on French-heavy speech translates the French into MSA** (03). Auto is right for that clip.
4. whisper.cpp large-v3 with prompt loops/hallucinates on 02 (WER > 100 %). Local engines stay fallback only.
5. Same failure seen on the real 10-min rush: opening hallucination `اشتركوا في القناة` (15 s) and MSA drift (`سوف نريك`, `الكثير من المشاهدين`).

## Proposed chain + correction rule (pending corrected refs)

- Default for Darija projects: Groq large-v3, `language=ar`, Darija + tech-terms prompt. Fallback: whisper.cpp large-v3 auto.
- Per chunk: if the auto pass detects French/English, keep the auto result for that chunk.
- Drop known Whisper hallucinations (`اشتركوا في القناة`, `ترجمة نانسي قنقر`, `subtitles by…`) over silence.
- Loanword map (Arabic-script → Latin) applied before captions, seeded from these diffs.
