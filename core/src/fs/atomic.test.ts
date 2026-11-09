import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { after, before, test } from "node:test";
import { readJson, writeJsonAtomic, writeOutputAtomic } from "./atomic.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-atomic-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writeJsonAtomic writes and readJson reads back", async () => {
  const p = join(dir, "ok.json");
  await writeJsonAtomic(p, { a: 1, b: [1, 2] });
  assert.deepEqual(await readJson(p), { a: 1, b: [1, 2] });
});

test("writeJsonAtomic leaves no partial file when rename fails", async () => {
  const sub = await mkdtemp(join(dir, "fail-"));
  const p = join(sub, "data.json");
  await writeFile(p, '{"original":true}');
  const big = { items: Array.from({ length: 50_000 }, (_, i) => ({ i, s: "x".repeat(20) })) };
  await assert.rejects(
    writeJsonAtomic(p, big, {
      rename: async () => {
        throw new Error("boom");
      },
    }),
    /boom/,
  );
  assert.equal(await readFile(p, "utf8"), '{"original":true}');
  const left = (await readdir(sub)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, []);
});

test("readJson returns undefined for a missing file", async () => {
  assert.equal(await readJson(join(dir, "nope.json")), undefined);
});

test("readJson throws on invalid JSON", async () => {
  const p = join(dir, "bad.json");
  await writeFile(p, "{not json");
  await assert.rejects(readJson(p), SyntaxError);
});

test("writeOutputAtomic renames the tmp file into place on success", async () => {
  const d = await mkdtemp(join(tmpdir(), "mostudio-out-"));
  try {
    const final = join(d, "out file.mp4");
    let tmpSeen = "";
    await writeOutputAtomic(final, async (tmp) => {
      tmpSeen = tmp;
      await writeFile(tmp, "video");
    });
    assert.equal(dirname(tmpSeen), d);
    assert.equal(extname(tmpSeen), ".mp4");
    assert.notEqual(tmpSeen, final);
    assert.equal(readFileSync(final, "utf8"), "video");
    assert.deepEqual(readdirSync(d), ["out file.mp4"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("writeOutputAtomic removes the tmp file and keeps no output on failure", async () => {
  const d = await mkdtemp(join(tmpdir(), "mostudio-out-"));
  try {
    const final = join(d, "out.mp4");
    await assert.rejects(
      writeOutputAtomic(final, async (tmp) => {
        await writeFile(tmp, "partial");
        throw new Error("ffmpeg died");
      }),
      /ffmpeg died/,
    );
    assert.deepEqual(readdirSync(d), []);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
