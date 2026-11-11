import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { checkAssSize, resolveAssembleFfmpeg } from "../src/assemble.ts";
import { escapeFilterPath, frameCounts, presetFilter } from "../src/filters.ts";
import { buildComposition, hyperframesCommand } from "../src/hyperframes.ts";
import { chooseRenderer, presetSize } from "../src/presets.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-assemble-unit-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("escapeFilterPath survives both ffmpeg parsing levels", () => {
  // level 1 (option value): \ ' : get a backslash; level 2 (graph): \ ' [ ] , ; get another
  assert.equal(escapeFilterPath("/a/Vidéos à monter/l'essai/c.ass"), "/a/Vidéos à monter/l\\\\\\'essai/c.ass");
  assert.equal(escapeFilterPath("C:/x"), "C\\\\:/x");
  assert.equal(escapeFilterPath("a[1],b;c"), "a\\[1\\]\\,b\\;c");
  assert.equal(escapeFilterPath("a\\b"), "a\\\\\\\\b");
});

test("presets: fixed sizes, source = ingest size rounded to even", () => {
  const ingest = { width: 641, height: 361, fps: 29.97 };
  assert.deepEqual(presetSize("youtube", ingest), { name: "youtube", width: 1920, height: 1080 });
  for (const p of ["shorts", "reels", "tiktok"]) assert.deepEqual(presetSize(p, ingest), { name: p, width: 1080, height: 1920 });
  assert.deepEqual(presetSize(undefined, ingest), { name: "source", width: 640, height: 360 });
  assert.throws(() => presetSize("imax", ingest), /unknown preset "imax"/);
});

test("renderer: hyperframes for short social cuts, ass otherwise, param wins", () => {
  assert.equal(chooseRenderer({ preset: "shorts", outDurationSec: 80, burn: true }), "hyperframes");
  assert.equal(chooseRenderer({ preset: "tiktok", outDurationSec: 180, burn: true }), "hyperframes");
  assert.equal(chooseRenderer({ preset: "reels", outDurationSec: 180.5, burn: true }), "ass");
  assert.equal(chooseRenderer({ preset: "youtube", outDurationSec: 30, burn: true }), "ass");
  assert.equal(chooseRenderer({ preset: "shorts", outDurationSec: 30, burn: true, param: "ass" }), "ass");
  assert.equal(chooseRenderer({ preset: "youtube", outDurationSec: 30, burn: true, param: "hyperframes" }), "hyperframes");
  assert.equal(chooseRenderer({ preset: "shorts", outDurationSec: 30, burn: false }), "none");
  assert.throws(() => chooseRenderer({ preset: "shorts", outDurationSec: 30, burn: true, param: "remotion" }), /captionsRenderer/);
});

test("frame counts telescope to round(total * fps)", () => {
  const keeps = Array.from({ length: 150 }, (_, i) => ({ start: i * 0.15, end: i * 0.15 + 0.1 + (i % 7) * 0.013 }));
  const n = frameCounts(keeps, 29.97);
  const total = keeps.reduce((a, k) => a + k.end - k.start, 0);
  assert.equal(n.reduce((a, b) => a + b, 0), Math.round(total * 29.97));
});

test("preset filter scales to fit, pads black, square pixels", () => {
  assert.equal(
    presetFilter(1080, 1920, 30),
    "fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
  );
});

test("missing libass gives the install hint", async () => {
  const fake = join(dir, "ffmpeg-noass");
  await writeFile(fake, "#!/bin/sh\necho ' T.. scale             V->V       Scale the input video size.'\n");
  await chmod(fake, 0o755);
  await assert.rejects(resolveAssembleFfmpeg({}, ["ass"], [fake]), (e: Error) => {
    assert.match(e.message, /missing filters ass/);
    assert.match(e.message, /brew install ffmpeg-full/);
    assert.match(e.message, /captionsRenderer=hyperframes/);
    return true;
  });
});

test("hyperframes composition has one captions track and no external URLs", async () => {
  const cues = [
    { start: 0.2, end: 1.5, text: "Hello <world> & co", words: [{ w: "Hello", start: 0.2, end: 0.6 }, { w: "<world>", start: 0.6, end: 1.0 }, { w: "&", start: 1.0, end: 1.2 }, { w: "co", start: 1.2, end: 1.5 }] },
    { start: 1.6, end: 9.0, text: "no word timing", words: [] },
  ];
  const c = await buildComposition(cues, { width: 1080, height: 1920, durationSec: 3, video: "assets/cut.mp4" });
  assert.equal(c.index.match(/data-track-kind="captions"/g)?.length, 1);
  for (const text of [c.index, c.captions, c.config]) assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(c.captions, /gsap/i);
  assert.match(c.index, /data-duration="3"/);
  assert.match(c.index, /<video id="bg"[^>]*src="assets\/cut.mp4"[^>]*muted/);
  assert.match(c.captions, /&lt;world&gt;/);
  assert.doesNotMatch(c.captions, /<world>/);
  assert.equal(c.captions.match(/class="cap clip"/g)?.length, 2);
  // second cue is clamped to the composition end
  assert.match(c.captions, /data-start="1.6" data-duration="1.4"/);
  assert.match(c.captions, /#FFD400/);
  assert.doesNotThrow(() => JSON.parse(c.config));
});

test("hyperframes command: env override split on spaces, else pinned npx", () => {
  assert.deepEqual(hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "node /x/fake.ts" }), ["node", "/x/fake.ts"]);
  assert.deepEqual(hyperframesCommand({}), ["npx", "--yes", "hyperframes@0.9.26"]);
  assert.deepEqual(hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: '["/path with space/hf", "--x"]' }), ["/path with space/hf", "--x"]);
  assert.throws(() => hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "[nope" }), /not a JSON array/);
  assert.throws(() => hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "[]" }), /non-empty JSON array of strings/);
});

test("checkAssSize: same aspect passes, a different one names the fix", async () => {
  const ass = (x: number, y: number) => `[Script Info]\nPlayResX: ${x}\nPlayResY: ${y}\n`;
  const f = join(dir, "c.ass");
  await writeFile(f, ass(1080, 1920));
  await checkAssSize(f, 1080, 1920);
  await writeFile(f, ass(640, 360));
  await checkAssSize(f, 1920, 1080);
  await assert.rejects(checkAssSize(f, 1080, 1920), /^Error: captions\.ass is 640x360 but output is 1080x1920: re-run captions with --param width=1080 --param height=1920$/);
  await writeFile(f, "[Script Info]\n");
  await checkAssSize(f, 1080, 1920);
});
