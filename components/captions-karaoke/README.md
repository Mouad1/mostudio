# captions-karaoke

mostudio's own HyperFrames caption scene (MIT, written for mostudio; no registry blocks). Used by the `assemble` step for short vertical videos (`captionsRenderer=hyperframes`).

- `index.html`: the scene file (`<template>`), mounted at `scenes/captions/compositions/captions.html` by one host with `data-track-kind="captions"`. Placeholders `{{CSS}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{BOTTOM}}`, `{{SIDE}}`, `{{SIZE}}`, `{{OUTLINE}}`, `{{GROUPS}}` are filled by `steps/assemble/src/hyperframes.ts`.
- `captions.css`: inlined into the scene (a linked sheet cannot style a scene root).
- One group per cue of `captions/cues.json`: a `.cap.clip` div shown over `[start, end)`; each word is a `.w` span with `data-ws`/`data-we` (cut seconds).
- Look: Inter 900, white words, the spoken word `#FFD400` (colour only, so nothing reflows), word spacing widened by 0.18em for the outline, 6 px black outline (`-webkit-text-stroke` under the fill), bottom safe zone 340 px; sizes are designed at 1080x1920 and scaled by `min(width/1080, height/1920)` (the safe zone by `height/1920`).
- Motion: Web Animations API only (paused, timed with `delay`). No GSAP, no network, no external URLs.
