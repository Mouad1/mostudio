# qa

Checks the final render, measures it and writes a report for a human to score (spec G6).

- **Input:** `renders/final.mp4`. **Outputs:** `renders/contact-sheet.jpg`, `renders/qa.md`.
- **Black opening:** `blackdetect=d=0.05:pix_th=0.10` on the first 2 s. `blackStartSec` = end of a black run starting at <= 0.05 s, else 0.
- **Silent opening:** `silencedetect=n=-50dB:d=0.1` on the first 1 s. `silentStartSec` = end of a silence run starting at <= 0.05 s (1.0 if it never ends in the window), else 0.
- Files shorter than the window are checked over their full length.
- **Loudness:** `measureLoudness` on the whole file (`integratedLufs`, `truePeakDb`, 1 decimal).
- **Contact sheet:** 12 frames evenly spaced (`fps=12/duration`, first sample half a step in), `scale=400:-2,tile=4x3`, 1600 px wide JPEG.
- **qa.md:** file, duration, resolution; a "Measured" table with pass/warn/fail per gate threshold; a "Rubric (fill in)" table (hook clear in 3 s, pacing 1-5, caption errors per minute, loudness auto-filled, notes).
- **Metrics:** `blackStartSec, silentStartSec, integratedLufs, truePeakDb, contactSheetFrames, durationSec`.
- **Gate:** `blackStartSec <= 0.1` fail, `silentStartSec <= 0.5` fail, `integratedLufs` within [-15, -13] warn.

```
mostudio step qa --project <dir>
```
