import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contentType, parseRange, serveFile, serveWeb, WEB_ROOT } from "./static.ts";
import { startTestDashboard } from "./testkit.ts";
import { HttpError, type Req, type Res } from "./http.ts";

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseRange("bytes=0-1,5-6", 1000), "invalid");
  assert.equal(parseRange("bytes=1000-", 1000), "invalid");
  assert.equal(parseRange(undefined, 1000), undefined);
  assert.equal(parseRange("bytes=500-100", 1000), "invalid");
  assert.equal(parseRange("bytes=-", 1000), "invalid");
  assert.equal(parseRange("not-bytes=0-10", 1000), "invalid");
  assert.deepEqual(parseRange("bytes=-2000", 1000), { start: 0, end: 999 });
});

test("contentType returns expected MIME types", () => {
  assert.equal(contentType("index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("app.ts"), "text/javascript");
  assert.equal(contentType("bundle.js"), "text/javascript");
  assert.equal(contentType("styles.css"), "text/css");
  assert.equal(contentType("data.json"), "application/json");
  assert.equal(contentType("video.mp4"), "video/mp4");
  assert.equal(contentType("clip.mov"), "video/quicktime");
  assert.equal(contentType("stream.webm"), "video/webm");
  assert.equal(contentType("sound.wav"), "audio/wav");
  assert.equal(contentType("song.mp3"), "audio/mpeg");
  assert.equal(contentType("track.m4a"), "audio/mp4");
  assert.equal(contentType("photo.jpg"), "image/jpeg");
  assert.equal(contentType("photo.jpeg"), "image/jpeg");
  assert.equal(contentType("logo.png"), "image/png");
  assert.equal(contentType("banner.webp"), "image/webp");
  assert.equal(contentType("sub.srt"), "text/plain; charset=utf-8");
  assert.equal(contentType("sub.ass"), "text/plain; charset=utf-8");
  assert.equal(contentType("notes.txt"), "text/plain; charset=utf-8");
  assert.equal(contentType("readme.md"), "text/plain; charset=utf-8");
  assert.equal(contentType("file.bin"), "application/octet-stream");
});

test("serveFile serves whole file and partial range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "static-test-"));
  const sampleFile = join(dir, "sample.txt");
  writeFileSync(sampleFile, "0123456789abcdefghij"); // 20 bytes

  const svgFile = join(dir, "image.svg");
  writeFileSync(svgFile, "<svg></svg>");

  try {
    // 1. Serve whole file
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url === "/sample") {
          await serveFile(req as Req, res as Res, sampleFile);
        } else if (req.url === "/svg") {
          await serveFile(req as Req, res as Res, svgFile);
        } else if (req.url === "/missing") {
          await serveFile(req as Req, res as Res, join(dir, "does-not-exist.txt"));
        }
      } catch (err) {
        if (err instanceof HttpError) {
          res.writeHead(err.status, { "content-type": "text/plain" });
          res.end(err.message);
        } else {
          res.writeHead(500);
          res.end("internal error");
        }
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const base = "http://127.0.0.1:" + port;

    try {
      // Whole file
      const resFull = await fetch(base + "/sample");
      assert.equal(resFull.status, 200);
      assert.equal(resFull.headers.get("accept-ranges"), "bytes");
      assert.equal(resFull.headers.get("x-content-type-options"), "nosniff");
      assert.equal(resFull.headers.get("content-length"), "20");
      assert.equal(await resFull.text(), "0123456789abcdefghij");

      // Range request 206
      const resRange = await fetch(base + "/sample", {
        headers: { range: "bytes=4-9" },
      });
      assert.equal(resRange.status, 206);
      assert.equal(resRange.headers.get("content-range"), "bytes 4-9/20");
      assert.equal(resRange.headers.get("content-length"), "6");
      assert.equal(await resRange.text(), "456789");

      // Invalid range 416
      const resInvalid = await fetch(base + "/sample", {
        headers: { range: "bytes=50-60" },
      });
      assert.equal(resInvalid.status, 416);
      assert.equal(resInvalid.headers.get("content-range"), "bytes */20");

      // SVG gets Content-Disposition: attachment
      const resSvg = await fetch(base + "/svg");
      assert.equal(resSvg.headers.get("content-disposition"), "attachment");

      // Missing file throws 404
      const resMissing = await fetch(base + "/missing");
      assert.equal(resMissing.status, 404);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("typed web modules are served as JavaScript without types, with security headers", async () => {
  const d = await startTestDashboard();
  const r = await fetch(d.base + "/lib/fixture-typed.ts");
  assert.equal(r.headers.get("content-type"), "text/javascript");
  assert.doesNotMatch(await r.text(), /:\s*(string|number)\b/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match((await fetch(d.base + "/")).headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal((await fetch(d.base + "/../package.json")).status, 404);
  assert.equal((await fetch(d.base + "/test.test.ts")).status, 404);
  await d.close();
});

test("every non-test web module in dashboard/web serves 200 without type annotations", async () => {
  const d = await startTestDashboard();
  try {
    const files: string[] = [];
    function scan(dir: string, rel: string) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          scan(join(dir, ent.name), rel ? `${rel}/${ent.name}` : ent.name);
        } else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.includes(".test.")) {
          files.push(rel ? `${rel}/${ent.name}` : ent.name);
        }
      }
    }
    scan(WEB_ROOT, "");
    assert.ok(files.length > 0, "expected to find web modules in WEB_ROOT");
    for (const file of files) {
      const res = await fetch(`${d.base}/${file}`);
      assert.equal(res.status, 200, `fetching ${file} failed with status ${res.status}`);
      assert.equal(res.headers.get("content-type"), "text/javascript");
      const text = await res.text();
      assert.ok(text.length > 0, `${file} should not be empty`);
    }
  } finally {
    await d.close();
  }
});
