import assert from "node:assert/strict";
import { test } from "node:test";
import { explainError } from "./errors.ts";

test("explainError maps engine messages to plain advice", () => {
  assert.equal(
    explainError('No provider available for "stt": groq: no-key').action!.href,
    "#settings"
  );
  assert.equal(explainError("cancelled by user").title, "Stopped");
  const e = explainError("weird ffmpeg thing");
  assert.deepEqual([e.title, e.advice, e.details], ["That didn't work", "Weird ffmpeg thing", "weird ffmpeg thing"]);
});

test("no explanation leaks a CLI flag", () => {
  for (const m of [
    'No provider available for "stt": x',
    "x. Burning captions with ffmpeg needs libass: brew install ffmpeg-full (or use --param captionsRenderer=hyperframes)",
    "API refused key with .env setting",
  ]) {
    const e = explainError(m);
    assert.doesNotMatch(e.title + e.advice, /--|brew|\.env/);
  }
});

test("explainError covers all mapped patterns", () => {
  // stt
  const stt = explainError('No provider available for "stt": groq: no-key');
  assert.equal(stt.title, "No transcription service available");
  assert.equal(stt.advice, "Add a free Groq key so mostudio can turn speech into text.");
  assert.deepEqual(stt.action, { label: "Open settings", href: "#settings" });

  // llm
  const llm = explainError('No provider available for "llm": gemini: no-key');
  assert.equal(llm.title, "No AI service available");
  assert.equal(llm.advice, "Add a free Groq or Gemini key.");
  assert.deepEqual(llm.action, { label: "Open settings", href: "#settings" });

  // cancelled
  const cancel = explainError("run cancelled by user at step 2");
  assert.equal(cancel.title, "Stopped");
  assert.equal(cancel.advice, "You stopped this run. Start again when you're ready.");
  assert.equal(cancel.action, undefined);

  // not found
  const notFound = explainError("ffmpeg not found; install it or set FFMPEG_PATH");
  assert.equal(notFound.title, "A video tool is missing");
  assert.equal(notFound.advice, "Reinstall mostudio: download the latest zip and replace the folder.");
  assert.equal(notFound.action, undefined);

  // needs libass
  const libass = explainError("Burning captions with ffmpeg needs libass");
  assert.equal(libass.title, "Captions can't be burned with this video engine");
  assert.equal(libass.advice, "Turn on animated captions in Settings, or reinstall mostudio.");
  assert.deepEqual(libass.action, { label: "Open settings", href: "#settings" });

  // captions size
  const captionsSize = explainError("captions.ass is 1080x1920 but output is 1920x1080");
  assert.equal(captionsSize.title, "Captions were made for another video size");
  assert.equal(captionsSize.advice, "Re-run the captions step, then continue.");
  assert.equal(captionsSize.action, undefined);

  // no words
  const noWords = explainError("no words in transcript after run");
  assert.equal(noWords.title, "No speech found");
  assert.equal(noWords.advice, "This clip seems silent or music-only. Try a clip where someone talks.");
  assert.equal(noWords.action, undefined);

  // already made
  const alreadyMade = explainError("This project already made a short video");
  assert.equal(alreadyMade.title, "This project already made another kind of video");
  assert.equal(alreadyMade.advice, "Start a new project for a different kind of video.");
  assert.equal(alreadyMade.action, undefined);

  // disk full
  const disk = explainError("Not enough free disk space: need 10 GB, have 2 GB");
  assert.equal(disk.title, "Your disk is full");
  assert.equal(disk.advice, "Not enough free disk space: need 10 GB, have 2 GB");
  assert.equal(disk.action, undefined);

  // refused / 401 / 403
  for (const msg of ["connection refused", "Groq returned 401 unauthorized", "Cloudflare returned 403 forbidden"]) {
    const refused = explainError(msg);
    assert.equal(refused.title, "A key was refused");
    assert.equal(refused.advice, "Copy the key again and test it in Settings.");
    assert.deepEqual(refused.action, { label: "Open settings", href: "#settings" });
  }

  // missing input
  const missing = explainError("missing input: edl.json");
  assert.equal(missing.title, "An earlier step hasn't run yet");
  assert.equal(missing.advice, "Run the steps before this one first.");
  assert.equal(missing.action, undefined);

  // fallback default
  const def = explainError("unrecognized crash in step");
  assert.equal(def.title, "That didn't work");
  assert.equal(def.advice, "Unrecognized crash in step");
  assert.equal(def.details, "unrecognized crash in step");
  assert.equal(def.action, undefined);
});

test("an unmapped error shows its own first line up front, the rest only in Details", () => {
  const e = explainError("Upload failed: disk busy\n    at saveStream (files.ts:42)\n    at handler");
  assert.equal(e.advice, "Upload failed: disk busy");
  assert.match(e.details, /saveStream/);
  assert.doesNotMatch(e.title + e.advice, /Something went wrong|Open the details/);
  assert.equal(explainError("").advice, "Open the details below and share them if you ask for help.");
});

test("a refused file type says so in plain words", () => {
  const e = explainError("mostudio can't use this file type (.txt). Use a video or audio file.");
  assert.equal(e.title, "This file type can't be used");
  assert.equal(e.advice, "mostudio can't use this file type (.txt). Use a video or audio file.");
});

test("a tab without a session is told to open the terminal link", () => {
  const e = explainError("unauthorized");
  assert.equal(e.title, "This tab isn't connected to mostudio");
  assert.equal(e.advice, "Open the link printed in your terminal.");
  assert.equal(explainError("Groq returned 401 unauthorized").title, "A key was refused");
});

test("an unreadable file is explained in plain words, from the upload refusal or an older ffprobe failure", () => {
  const plain =
    "mostudio can't read this file (it may be damaged or not a real video/audio file). Try exporting it again.";
  for (const m of [
    plain,
    "ffprobe failed: [mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found /p/media/clip.mp4: Invalid data found when processing input",
    "ffprobe failed: /p/media/clip.mp4: Invalid data found when processing input",
  ]) {
    const e = explainError(m);
    assert.equal(e.title, "This file can't be read", m);
    assert.equal(e.advice, plain, m);
    assert.equal(e.details, m);
  }
});
