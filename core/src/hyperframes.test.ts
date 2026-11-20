import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hyperframesCommand, hyperframesLint, hyperframesRender } from "./hyperframes.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-hf-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("hyperframesCommand: env string, JSON array, pinned default", () => {
  assert.deepEqual(hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "node /x/fake.ts" }), ["node", "/x/fake.ts"]);
  assert.deepEqual(hyperframesCommand({}), ["npx", "--yes", "hyperframes@0.9.26"]);
  assert.deepEqual(hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: '["/path with space/hf", "--x"]' }), ["/path with space/hf", "--x"]);
  assert.throws(() => hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "[nope" }), /not a JSON array/);
  assert.throws(() => hyperframesCommand({ MOSTUDIO_HYPERFRAMES_BIN: "[]" }), /non-empty JSON array of strings/);
});

/** Fake CLI (JSON array form, path with a space): logs its argv; exits 1 when the first arg is "fail". */
async function fake(): Promise<{ env: Record<string, string>; log: string }> {
  const log = join(dir, "argv.jsonl");
  const bin = join(dir, "fake hf.ts");
  await writeFile(
    bin,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("/bad")) { console.error("lint: 2 errors"); process.exit(1); }
`,
  );
  return { env: { MOSTUDIO_HYPERFRAMES_BIN: JSON.stringify([process.execPath, bin]) }, log };
}

test("hyperframesLint and hyperframesRender invoke the CLI with the expected args", async () => {
  const { env, log } = await fake();
  await hyperframesLint(env, "/scene dir");
  await hyperframesRender(env, "/scene dir", { fps: 29.97, out: "/o/out.mp4" });
  await hyperframesRender(env, "/scene dir", { fps: 30, out: "/o/b.mov", quality: "draft", format: "mov" });
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.deepEqual(calls[0], ["lint", "/scene dir"]);
  assert.deepEqual(calls[1], ["render", "/scene dir", "--quality", "looks", "--fps", "2997/100", "--format", "mp4", "-o", "/o/out.mp4", "--quiet"]);
  assert.deepEqual(calls[2], ["render", "/scene dir", "--quality", "draft", "--fps", "30", "--format", "mov", "-o", "/o/b.mov", "--quiet"]);
});

test("lint failure names the scene folder", async () => {
  const { env } = await fake();
  await assert.rejects(hyperframesLint(env, "/bad"), /HyperFrames lint failed for \/bad: .*lint: 2 errors/);
});
