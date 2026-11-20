import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEDIA_EXTS,
  acceptsMedia,
  formatBytes,
  lockedWorkflowReason,
  mediaSpecs,
  slugFromFileName,
  workflowLabel,
} from "./studio.ts";

test("slugFromFileName", () => {
  assert.equal(slugFromFileName("My Clip (final) 2.MOV"), "my-clip-final-2");
  assert.equal(slugFromFileName("été à Fès.mp4"), "ete-a-fes");
  assert.equal(slugFromFileName("..."), "video");
  assert.equal(slugFromFileName(""), "video");
  assert.equal(slugFromFileName("---"), "video");
  assert.equal(slugFromFileName("Hello World!"), "hello-world");
});

test("MEDIA_EXTS equals the server allow-list", async () => {
  const { UPLOAD_EXTS } = await import("../../src/routes/projects.ts");
  assert.deepEqual([...MEDIA_EXTS].sort(), [...UPLOAD_EXTS].sort());
});

test("acceptsMedia", () => {
  assert.equal(acceptsMedia("clip.mp4"), true);
  assert.equal(acceptsMedia("clip.MOV"), true);
  assert.equal(acceptsMedia("clip.wav"), true);
  assert.equal(acceptsMedia("clip.FLAC"), true);
  assert.equal(acceptsMedia("file.txt"), false);
  assert.equal(acceptsMedia("archive.zip"), false);
  assert.equal(acceptsMedia("no-extension"), false);
});

test("workflowLabel and lockedWorkflowReason use plain words", () => {
  assert.equal(workflowLabel("rough-cut"), "Long video");
  assert.equal(workflowLabel("short"), "Short");
  assert.equal(workflowLabel("custom"), "custom");
  assert.equal(
    lockedWorkflowReason("rough-cut", "short"),
    "This project made a Long video. Start a new project for a Short."
  );
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(12_000), "12 KB");
  assert.equal(formatBytes(820_000_000), "820 MB");
  assert.equal(formatBytes(1_400_000_000), "1.4 GB");
  assert.equal(formatBytes(2_500_000_000_000), "2.5 TB");
});

test("mediaSpecs: audio-only media reads Audio only, not 0x0", () => {
  assert.equal(mediaSpecs({ width: 0, height: 0, durationSec: 91.8 }), "Audio only · 1:32");
  assert.equal(mediaSpecs({ width: 1920, height: 1080, durationSec: 91.8, hasVideo: false }), "Audio only · 1:32");
  assert.equal(mediaSpecs({ width: 1920, height: 1080, durationSec: 91.8 }), "1920x1080 · 91.8s");
});
