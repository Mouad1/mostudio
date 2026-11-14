import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEDIA_EXTS,
  acceptsMedia,
  formatBytes,
  slugFromFileName,
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

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(12_000), "12 KB");
  assert.equal(formatBytes(820_000_000), "820 MB");
  assert.equal(formatBytes(1_400_000_000), "1.4 GB");
  assert.equal(formatBytes(2_500_000_000_000), "2.5 TB");
});
