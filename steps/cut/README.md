# cut

Edit decision list from the word-level transcript: removes silences, filler words and earlier retakes (the last take is kept). Renders nothing.

- **Inputs:** `media/ingest.json`, `transcript/words.json`, `transcript/audio.wav`.
- **Output:** `cut/edl.json` = `{ source, fadeSec: 0.01, keep: {start,end}[], removed: {start,end,reason}[], outDurationSec }`, source timeline, seconds. `reason` is `retake`, `filler` or `silence` (dominant one for a contiguous removed span).
- **Params:** `pace` = `natural` (default: maxGap 0.45, pre 0.10, post 0.15) or `tight` (0.25 / 0.05 / 0.08); an unknown pace fails. `maxGap`, `pre`, `post`, `minKeep` (default 0.30) override the preset; `retakes` (default true).
- **Fillers:** `fillers.json`; words are lowercased, stripped of punctuation and runs of the same letter collapsed (`euuuh` matches `euh`, `hmmm` matches `hmm`).
- **Retakes:** phrases split at gaps > 0.6 s; a later phrase starting within 20 s with the same first 3 words replaces the earlier one(s). Phrases under 3 words never trigger.
- **Boundaries:** keeps are padded around runs of kept words (never into a neighbouring word) and snapped to the quietest point of their padding when the cut is short; keeps under `minKeep` are dropped.
- **Metrics:** `removedPct, cutCount, midWordCuts, shortestKeepSec, fillersRemoved, retakesRemoved, outDurationSec`. **Gate:** `midWordCuts == 0` fail, `removedPct <= 60` warn.
- Zero words in the transcript fails with "no words in transcript/words.json".

```
mostudio step cut --project <dir> [--param pace=tight]
```
