import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStatus, StepView } from "../../src/types.ts";
import { edlBar, formatTime, previewsFor } from "./previews.ts";

function status(
  steps: Record<string, "pass" | "warn" | "fail">,
  media?: { file: string }
): ProjectStatus {
  const stepsMap: Record<string, StepView> = {};
  for (const [k, v] of Object.entries(steps)) {
    stepsMap[k] = {
      step: k,
      status: v,
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(2_000).toISOString(),
      durationMs: 1000,
      inputsHash: "hash123",
      metrics: {},
      verdicts: [],
      artifacts: [],
    };
  }
  return {
    id: "2026-11-14-test",
    dir: "/tmp/test",
    steps: stepsMap,
    pending: [],
    running: false,
    interrupted: [],
    uploads: [],
    media: media ? { file: media.file, durationSec: 10, width: 1920, height: 1080 } : undefined,
  };
}

test("previewsFor maps steps and skips failed ones", () => {
  const st = status({ ingest: "pass", cut: "fail", assemble: "warn" }, { file: "media/a.mov" });
  assert.deepEqual(
    previewsFor("ingest", st).map((p) => [p.kind, p.path]),
    [
      ["media-info", "media/ingest.json"],
      ["video", "media/a.mov"],
    ]
  );
  assert.deepEqual(previewsFor("cut", st), []);
  assert.deepEqual(
    previewsFor("assemble", st).map((p) => p.path),
    ["renders/final.mp4"]
  );
});

test("previewsFor maps all pipeline steps correctly", () => {
  const allSteps: Record<string, "pass"> = {
    ingest: "pass",
    transcribe: "pass",
    cut: "pass",
    localize: "pass",
    captions: "pass",
    mix: "pass",
    chapters: "pass",
    assemble: "pass",
    qa: "pass",
  };
  const st = status(allSteps);
  // ingest without media.file
  assert.deepEqual(previewsFor("ingest", st), [
    { kind: "media-info", path: "media/ingest.json", label: "Your video" },
  ]);
  assert.deepEqual(previewsFor("transcribe", st), [
    { kind: "words", path: "transcript/words.json", label: "What was said" },
  ]);
  assert.deepEqual(previewsFor("cut", st), [
    { kind: "edl", path: "cut/edl.json", label: "What was cut" },
  ]);
  assert.deepEqual(previewsFor("localize", st), [
    { kind: "units", path: "localize/units.json", label: "Subtitle lines" },
  ]);
  assert.deepEqual(previewsFor("captions", st), [
    { kind: "captions", path: "captions/captions.txt", label: "Captions" },
  ]);
  assert.deepEqual(previewsFor("mix", st), [
    { kind: "audio", path: "audio/mix.wav", label: "Sound" },
  ]);
  assert.deepEqual(previewsFor("chapters", st), [
    { kind: "text", path: "chapters/youtube.txt", label: "Chapters" },
  ]);
  assert.deepEqual(previewsFor("assemble", st), [
    { kind: "video", path: "renders/final.mp4", label: "Your video" },
  ]);
  assert.deepEqual(previewsFor("qa", st), [
    { kind: "image", path: "renders/contact-sheet.jpg", label: "Contact sheet" },
    { kind: "report", path: "renders/qa.md", label: "QA Report" },
  ]);
});

test("previewsFor returns empty array for missing step or non pass/warn status", () => {
  const st = status({ ingest: "fail" });
  assert.deepEqual(previewsFor("ingest", st), []);
  assert.deepEqual(previewsFor("unknown", st), []);
});

test("edlBar", () => {
  assert.deepEqual(
    edlBar(
      { keep: [{ start: 0, end: 5 }], removed: [{ start: 5, end: 10, reason: "silence" }] },
      10
    ),
    [
      { left: 0, width: 50, kind: "keep" },
      { left: 50, width: 50, kind: "silence" },
    ]
  );
});

test("edlBar handles filler, retake, multiple segments sorted by left", () => {
  const res = edlBar(
    {
      keep: [
        { start: 2, end: 4 },
        { start: 8, end: 10 },
      ],
      removed: [
        { start: 0, end: 2, reason: "silence" },
        { start: 4, end: 6, reason: "filler" },
        { start: 6, end: 8, reason: "retake" },
      ],
    },
    10
  );
  assert.deepEqual(res, [
    { left: 0, width: 20, kind: "silence" },
    { left: 20, width: 20, kind: "keep" },
    { left: 40, width: 20, kind: "filler" },
    { left: 60, width: 20, kind: "retake" },
    { left: 80, width: 20, kind: "keep" },
  ]);
});

test("edlBar handles zero or negative total gracefully", () => {
  assert.deepEqual(edlBar({ keep: [], removed: [] }, 0), []);
});

test("formatTime", () => {
  assert.equal(formatTime(65.239), "01:05.24");
  assert.equal(formatTime(0), "00:00.00");
  assert.equal(formatTime(5.5), "00:05.50");
  assert.equal(formatTime(3661.02), "61:01.02");
});
