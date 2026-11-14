import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { HttpError, type Req } from "./http.ts";
import { ensureSpace, insideDir, safeFileName, saveStream, uniquePath } from "./files.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "files-test-"));
}

test("insideDir refuses escapes, including through a symlink", async () => {
  const d = tmpDir();
  try {
    symlinkSync("/etc", join(d, "link"));
    await assert.rejects(insideDir(d, "../x"), /escapes/);
    await assert.rejects(insideDir(d, "/etc/passwd"), /escapes/);
    await assert.rejects(insideDir(d, "link/hosts"), /escapes/);
    await assert.rejects(insideDir(d, "link/nonexistent"), /escapes/);
    await assert.rejects(insideDir(d, "foo\0bar"), /escapes/);
    assert.equal(await insideDir(d, "renders/new.mp4"), join(realpathSync(d), "renders/new.mp4"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("safeFileName and uniquePath", async () => {
  assert.equal(safeFileName("../../My clip été.MOV"), "My clip été.MOV");
  assert.equal(safeFileName("\u0000.hidden"), "hidden");
  assert.throws(() => safeFileName("..."), /bad file name/);
  assert.throws(() => safeFileName(""), /bad file name/);

  // Long name capping
  const longName = "a".repeat(150) + ".mp4";
  const capped = safeFileName(longName);
  assert.equal(capped.length, 120);
  assert.ok(capped.endsWith(".mp4"));

  const d = tmpDir();
  try {
    writeFileSync(join(d, "a.mov"), "");
    assert.equal(await uniquePath(d, "a.mov"), join(d, "a (2).mov"));
    writeFileSync(join(d, "a (2).mov"), "");
    assert.equal(await uniquePath(d, "a.mov"), join(d, "a (3).mov"));
    assert.equal(await uniquePath(d, "b.mov"), join(d, "b.mov"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("ensureSpace allows small allocations and rejects huge ones", async () => {
  const d = tmpDir();
  try {
    // 100 bytes should pass
    await ensureSpace(d, 100);

    // Huge allocation (10^16 bytes ~ 10 PB) should fail with 507
    await assert.rejects(
      ensureSpace(d, 1e16),
      (err: any) => err instanceof HttpError && err.status === 507 && /Not enough free disk space/.test(err.message)
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("saveStream saves data atomically and rejects missing length or interrupted upload", async () => {
  const d = tmpDir();
  try {
    const finalPath = join(d, "upload.mp4");

    // 1. Missing Content-Length -> 411
    const reqNoLen = new Readable({ read() { this.push(null); } }) as any;
    reqNoLen.headers = {};
    await assert.rejects(
      saveStream(reqNoLen, finalPath),
      (err: any) => err instanceof HttpError && err.status === 411
    );

    // 2. Successful save
    const content = Buffer.from("test upload payload data");
    const reqSuccess = Readable.from([content]) as any;
    reqSuccess.headers = { "content-length": String(content.length) };
    const written = await saveStream(reqSuccess, finalPath);
    assert.equal(written, content.length);
    assert.equal(readFileSync(finalPath, "utf8"), "test upload payload data");

    // 3. Interrupted stream -> cleans up tmp and throws 400
    const finalPath2 = join(d, "interrupted.mp4");
    const reqInterrupted = new Readable({
      read() {
        process.nextTick(() => {
          this.destroy(Object.assign(new Error("premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
        });
      }
    }) as any;
    reqInterrupted.headers = { "content-length": "100" };
    

    await assert.rejects(
      saveStream(reqInterrupted, finalPath2),
      (err: any) => err instanceof HttpError && err.status === 400 && /upload interrupted/.test(err.message)
    );
    assert.equal(existsSync(finalPath2), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
