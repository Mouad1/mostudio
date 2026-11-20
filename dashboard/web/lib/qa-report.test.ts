import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQaReport, siblingPath } from "./qa-report.ts";

// The shape steps/qa writes (audio-only source, so the black check is skipped).
const QA_MD = [
  "# QA report",
  "",
  "- File: renders/final.mp4",
  "- Duration: 64.94 s",
  "- Resolution: 1920x1080",
  "",
  "## Measured",
  "",
  "| Check | Value | Result |",
  "| --- | --- | --- |",
  "| Black opening (blackStartSec) | skipped | skipped: audio-only source, plain background |",
  "| Silent opening (silentStartSec) | 0 s | pass |",
  "| Integrated loudness (integratedLufs) | -14.1 LUFS | warn |",
  "| True peak (truePeakDb) | -2 dBTP | info |",
  "",
  "> Note: the source had no picture, so the render is captions on a plain black background. The black-opening check is skipped.",
  "",
  "## Contact sheet",
  "",
  "![Contact sheet](contact-sheet.jpg) (12 frames, [contact-sheet.jpg](contact-sheet.jpg))",
  "",
  "## Rubric (fill in)",
  "",
  "| Item | Target | Score |",
  "| --- | --- | --- |",
  "| Hook clear in 3 s | yes / no | |",
  "| Pacing | 1-5 | |",
  "| Caption errors per minute | <= 2 | |",
  "| Loudness | -14 LUFS +-1 LU | -14.1 LUFS (auto) |",
  "| Notes | | |",
  "",
].join("\n");

test("parseQaReport reads facts, measured checks, notes, contact sheet and rubric", () => {
  const r = parseQaReport(QA_MD);
  assert.deepEqual(r.facts, [
    { label: "File", value: "renders/final.mp4" },
    { label: "Duration", value: "64.94 s" },
    { label: "Resolution", value: "1920x1080" },
  ]);
  assert.deepEqual(r.measured, [
    { check: "Black opening", value: "skipped", level: "skipped", detail: "audio-only source, plain background" },
    { check: "Silent opening", value: "0 s", level: "pass", detail: "" },
    { check: "Integrated loudness", value: "-14.1 LUFS", level: "warn", detail: "" },
    { check: "True peak", value: "-2 dBTP", level: "info", detail: "" },
  ]);
  assert.deepEqual(r.notes, [
    { text: "The source had no picture, so the render is captions on a plain black background. The black-opening check is skipped.", fail: false },
  ]);
  assert.deepEqual(r.contactSheet, { file: "contact-sheet.jpg", caption: "12 frames" });
  assert.deepEqual(r.rubric, [
    { item: "Hook clear in 3 s", target: "yes / no", score: "" },
    { item: "Pacing", target: "1-5", score: "" },
    { item: "Caption errors per minute", target: "<= 2", score: "" },
    { item: "Loudness", target: "-14 LUFS +-1 LU", score: "-14.1 LUFS (auto)" },
    { item: "Notes", target: "", score: "" },
  ]);
});

test("parseQaReport marks FAIL notes and keeps HTML as plain text", () => {
  const r = parseQaReport(
    [
      "## Measured",
      "| Check | Value | Result |",
      "| --- | --- | --- |",
      "| <img src=x onerror=alert(1)> | 1 | fail |",
      "",
      "> FAIL: the render has no audio track.",
    ].join("\n"),
  );
  assert.deepEqual(r.measured, [{ check: "<img src=x onerror=alert(1)>", value: "1", level: "fail", detail: "" }]);
  assert.deepEqual(r.notes, [{ text: "FAIL: the render has no audio track.", fail: true }]);
  assert.equal(r.contactSheet, undefined);
});

test("parseQaReport ignores an unknown result word as info", () => {
  const r = parseQaReport("## Measured\n| Check | Value | Result |\n| --- | --- | --- |\n| X | 1 | maybe |\n");
  assert.equal(r.measured[0]?.level, "info");
});

test("siblingPath only resolves a plain image file next to the report", () => {
  assert.equal(siblingPath("renders/qa.md", "contact-sheet.jpg"), "renders/contact-sheet.jpg");
  assert.equal(siblingPath("qa.md", "sheet.png"), "sheet.png");
  for (const bad of ["../media/x.jpg", "/etc/x.jpg", "sub/x.jpg", "x.svg", "javascript:alert(1)", "https://e.com/x.jpg", ".hidden.jpg", ""]) {
    assert.equal(siblingPath("renders/qa.md", bad), undefined, bad);
  }
});
