# captions

Caption cues on the **cut** timeline from the word transcript and the edit list, with your word replacements applied. Renders nothing.

- **Inputs:** `media/ingest.json` (default `width`/`height`), `transcript/words.json`, `cut/edl.json`, `localize/units.json`, `edits/*`.
- **Localized text:** when `localize/units.json` has `lang` other than `source` (`arabizi`, `fr`, `en`), its unit texts replace the source words: each unit's tokens are spread over its cut-timeline span in proportion to their length (`unitsToWords` in core), then replacements and cue grouping run as usual (a word's keep is found from its cut-time midpoint). With `lang=source` the per-word source timings are used as before.
- **Create `edits/replacements.txt` first.** `mostudio new` does it; for an older project create the `edits/` folder and the file yourself (a header line is enough), otherwise the step fails on a missing input. Lines are `wrong => right`: case-insensitive, whole words, the left side may be several words (`wa zane => Ouazzane`), `#` starts a comment. Lines without `=>` or with an empty side are ignored and counted in `replacementRulesIgnored`. Trailing punctuation of the matched word is kept; the right side is used verbatim.
- **Outputs:** `captions/cues.json` (array of `{ start, end, text, words: {w,start,end}[] }`, cut timeline, seconds), `captions.srt`, `captions.ass`, `captions.txt` (`[mm:ss.cc → mm:ss.cc] text`, for review).
- **Mapping:** a word is kept when its midpoint is in a keep; its edges are clamped into that keep. Words in removed parts are dropped; a cue never crosses a cut.
- **Params:** `style` = `long` (default: one line of at most 42 chars, font 48 on 1080 p, bottom margin 60) or `short` (at most 3 words, font 84 on 1080 wide, bottom margin 340, karaoke `\k` tags: white before the word is spoken, `#FFD400` after (Primary=highlight, Secondary=white), 6 px black outline); an unknown style fails. `width`/`height` default to `media/ingest.json` (else 1920x1080 long, 1080x1920 short). `font` defaults to `Arial`.
- **Cues:** new cue after a gap over 0.6 s, a cut, 5 s, or the char/word limit; minimum 0.5 s (extended into the following gap, never over the next cue and never past the end of its keep).
- **Metrics:** `cueCount, maxCharsPerLine, maxReadingSpeed` (chars/s, cues under 0.3 s excluded), `replacementsApplied, replacementRulesIgnored, arabicScriptPct`. **Gate:** `maxCharsPerLine <= 42` fail; `maxReadingSpeed <= 17`, `arabicScriptPct == 0`, `cueCount > 0` warn.
- `arabicScriptPct` is the share of kept words (after replacements) with Arabic-script letters (U+0600-U+06FF); it warns when the transcript is in Arabic script; Latin (Darija) rewriting is the `localize` step's job (`--param localize.lang=arabizi`).
- No kept speech (zero keep or zero words) writes valid empty files and warns on `cueCount`.

```
mostudio step captions --project <dir> [--param style=short]
```
