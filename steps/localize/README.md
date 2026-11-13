# localize

Subtitle lines on the **cut** timeline in the audience's language. Captions and chapters read them; this step renders nothing. Never Arabic script on screen: `arabizi`, `fr` and `en` are checked for it.

- **Inputs:** `transcript/words.json`, `cut/edl.json`. **Output:** `localize/units.json` = `{ lang, provider?, units: { id, start, end, text, src }[] }` (cut timeline, seconds; `text` is what captions show, `src` the source words).
- **Units:** source words are mapped to the cut timeline like chapters do (kept when the midpoint is inside a keep, edges clamped, transcript order, never sorted). A new unit starts after a gap over 0.6 s, at a keep boundary, or when the unit would pass 7 s or 18 words. Ids start at 1.
- **Params:** `lang` = `source` (default: text = the joined source words, no model call), `arabizi` (Moroccan Darija in Latin letters, digits 3=ع 7=ح 9=ق 2=ء 5=خ allowed; transliterated, not translated; French/English loanwords that ASR wrote in Arabic script get their normal spelling back, `الوتي` -> `l'outil`; lines that came out as Modern Standard Arabic are rendered as natural Darija), `fr` or `en` (concise subtitle translation, names and tech terms kept); anything else fails. `prefer` = provider id tried first.
- **Model call:** a free `llm` provider (rotating, private-safe), units sent in batches of 40 as `{"units":[{"id":n,"text":"..."}]}`. Prompts live in `src/prompt.ts`. The reply is validated inside the provider call, so a bad one rotates: valid JSON, exactly the same ids, non-empty text, no Arabic-script letters. When no provider succeeds for a batch, its units keep the source text and count in `fallbackUnits`.
- **Metrics:** `unitCount`, `fallbackUnits`, `arabicScriptPct` (share of output tokens with Arabic-script letters; always 0 for `lang=source`, where Arabic script is expected), `lang`. **Gate:** `arabicScriptPct == 0` warn, `fallbackUnits == 0` warn.
- **Downstream:** with `lang` other than `source`, captions spread each unit's text over its time span (`unitsToWords` in core) instead of using per-word source timings, and chapters write titles in that language.

```
mostudio step localize --project <dir> [--param lang=arabizi] [--param prefer=groq]
```
