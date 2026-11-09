import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hashFiles } from "./hash.ts";

let dir: string;
let f: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-hash-"));
  f = join(dir, "a.txt");
  await writeFile(f, "hello");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("hashFiles changes when params change", async () =>
  assert.notEqual(await hashFiles([f], { a: 1 }), await hashFiles([f], { a: 2 })));

test("hashFiles ignores param key order", async () =>
  assert.equal(
    await hashFiles([f], { a: 1, b: { x: 1, y: 2 } }),
    await hashFiles([f], { b: { y: 2, x: 1 }, a: 1 }),
  ));

test("hashFiles changes when file bytes change", async () => {
  const g = join(dir, "g.txt");
  await writeFile(g, "one");
  const h1 = await hashFiles([g], {});
  await writeFile(g, "two");
  assert.notEqual(await hashFiles([g], {}), h1);
});

test("hashFiles ignores path list order", async () => {
  const g = join(dir, "g2.txt");
  await writeFile(g, "z");
  assert.equal(await hashFiles([f, g], null), await hashFiles([g, f], null));
});

test("hashFiles rejects naming a missing file", async () => {
  const missing = join(dir, "missing.bin");
  await assert.rejects(hashFiles([missing], {}), (e: Error) => e.message.includes(missing));
});
