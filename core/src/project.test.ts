import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { createProject } from "./project.ts";

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-project-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("createProject builds the spec layout", async () => {
  const dir = await createProject(tmp, "darija-harness", { date: new Date("2026-11-09T10:00:00Z") });
  assert.equal(basename(dir), "2026-11-09-darija-harness");
  for (const d of ["media", "cache", "scenes", "renders", "steps"]) {
    assert.ok(statSync(join(dir, d)).isDirectory());
  }
  assert.equal(await readFile(join(dir, "brief.md"), "utf8"), "# Brief\n");
});

test("createProject writes the given brief", async () => {
  const dir = await createProject(tmp, "with-brief", { brief: "Make it punchy" });
  assert.equal(await readFile(join(dir, "brief.md"), "utf8"), "Make it punchy");
});

test("createProject rejects bad slugs", async () => {
  await assert.rejects(createProject(tmp, "Mon Projet"));
});

test("createProject rejects an existing folder", async () => {
  const opts = { date: new Date("2026-11-09T10:00:00Z") };
  await createProject(tmp, "dup", opts);
  await assert.rejects(createProject(tmp, "dup", opts));
});

test("createProject works under a path with spaces and accents", async () => {
  const root = join(tmp, "Vidéos à monter");
  const dir = await createProject(root, "accent-test");
  assert.ok(statSync(join(dir, "steps")).isDirectory());
});
