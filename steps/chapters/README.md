# chapters

YouTube chapters from the **cut** transcript. Asks a free `llm` provider (rotating, private-safe) and falls back to pause-based chapters when none is available. Renders nothing.

- **Inputs:** `transcript/words.json`, `cut/edl.json`, `localize/units.json`. **Outputs:** `chapters/chapters.json` (`[{ start, title }]`, cut timeline, seconds) and `chapters/youtube.txt` (`mm:ss Title`, `h:mm:ss` past one hour, first line `00:00`).
- **Prompt:** cut-timeline words as lines prefixed `[mm:ss]` about every 30 s (truncated to about 24k chars by keeping evenly spaced lines). Asks for `{"chapters":[{"start":seconds,"title":"..."}]}`, 4-10 chapters (2-4 under 3 min), titles at most 50 chars, in the transcript's language (or `language`). Prompt text lives in `src/prompt.ts`.
- **Validation (inside the provider call, so a bad reply rotates to the next provider):** JSON (``` fences stripped), non-empty array, each `start` a finite number in `[0, outDurationSec)`, non-empty title.
- **Post-processing:** sort; first forced to 0; each start snapped to the nearest sentence start (word after a gap over 0.6 s) within 10 s; chapters under 10 s after the previous are dropped (earlier title wins), as is a last chapter under 10 s from the end; titles trimmed to 50 chars on a word boundary.
- **No LLM (every provider failed or none configured):** chapters at the longest pauses, one per ~3 min (at least 2), at least 10 s apart and from start/end, titled with the first 6 words; `fallback: true`, `provider: "none"`. The step never fails because of this.
- **Under 30 s:** a single chapter at 0, no model call.
- **Localized:** when `localize/units.json` has `lang` other than `source`, the prompt transcript is built from its unit texts (spread over each unit's span with `unitsToWords`) and, unless `language` is set, titles are asked in that language (`arabizi` -> Moroccan Darija written in Arabizi (Latin letters), `fr` -> French, `en` -> English).
- **Params:** `language` (title language hint), `prefer` (provider id to try first).
- **Metrics:** `chapterCount, minChapterSec` (min gap between starts and last-to-end), `firstAtZero, provider, fallback`. **Gate:** `firstAtZero == true` and `minChapterSec >= 10` fail; `chapterCount >= 3` and `fallback == false` warn (YouTube shows chapters only with 3 or more).

```
mostudio step chapters --project <dir> [--param prefer=groq]
```
