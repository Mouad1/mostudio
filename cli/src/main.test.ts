import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { StepModule } from "../../core/src/index.ts";
import { main } from "./main.ts";

const fakeContract = { inputs: [], outputs: [], gate: [] };
const steps: Record<string, StepModule> = {
  fake: {
    contract: { name: "fake", ...fakeContract, params: { n: "number" } },
    run: async (ctx) => ({ metrics: { b: 2, a: ctx.params.n as number, name: "x" }, artifacts: [] }),
  },
  "fake-fail": {
    contract: { name: "fake-fail", ...fakeContract, gate: [{ metric: "a", op: ">=", value: 5, level: "fail" }] },
    run: async () => ({ metrics: { a: 1 }, artifacts: [] }),
  },
  "fake-throw": {
    contract: { name: "fake-throw", ...fakeContract },
    run: async () => {
      throw new Error(`boom with sekret-value-123 inside`);
    },
  },
};

let cwd: string;
let home: string;
let outBuf: string[];
let errBuf: string[];
const env = (extra: Record<string, string> = {}) => ({ MOSTUDIO_HOME: home, ...extra });
const mk = (extra: Record<string, string> = {}) => ({
  stdout: (s: string) => void outBuf.push(s),
  stderr: (s: string) => void errBuf.push(s),
  cwd,
  env: env(extra),
});
const out = () => outBuf.join("");
const err = () => errBuf.join("");
const run = (argv: string[], extra: Record<string, string> = {}) => main(argv, mk(extra), steps);

before(() => {
  cwd = mkdtempSync(join(tmpdir(), "mostudio-cli-"));
  home = mkdtempSync(join(tmpdir(), "mostudio-home-"));
  writeFileSync(join(cwd, "providers.json"), "[]");
  writeFileSync(join(cwd, "mostudio.config.json"), JSON.stringify({ projectsRoot: "projects" }));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const reset = () => {
  outBuf = [];
  errBuf = [];
};

async function newProject(slug: string): Promise<string> {
  reset();
  assert.equal(await run(["new", slug]), 0);
  return out().trim();
}

test("new creates a project and prints its path", async () => {
  reset();
  assert.equal(await run(["new", "demo"]), 0);
  assert.match(out(), /\d{4}-\d{2}-\d{2}-demo$/m);
  assert.equal(out().trim().split("\n").length, 1);
  assert.ok(existsSync(out().trim()));
});

test("new rejects bad slug and existing project with exit 1", async () => {
  reset();
  assert.equal(await run(["new", "Bad Slug"]), 1);
  assert.match(err(), /invalid slug/);
  await newProject("twice");
  reset();
  assert.equal(await run(["new", "twice"]), 1);
  assert.ok(err().length > 0);
});

test("new --brief copies the brief file", async () => {
  writeFileSync(join(cwd, "b.md"), "# My brief\n");
  const dir = await newProject("briefed");
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(dir, "brief.md"), "utf8"), "# Brief\n");
  reset();
  assert.equal(await run(["new", "briefed2", "--brief", "b.md"]), 0);
  assert.equal(readFileSync(join(out().trim(), "brief.md"), "utf8"), "# My brief\n");
});

test("step prints a human line and exits 0 on pass", async () => {
  const dir = await newProject("pass");
  reset();
  assert.equal(await run(["step", "fake", "--project", dir, "--param", "n=7"]), 0);
  assert.match(out(), /^fake {2}pass {2}\d+\.\ds {2}a=7 b=2 name=x$/m);
  reset();
  assert.equal(await run(["step", "fake", "--project", dir, "--param", "n=7"]), 0);
  assert.match(out(), /\(cached\)$/m);
});

test("step accepts a project path relative to cwd", async () => {
  const dir = await newProject("rel");
  reset();
  assert.equal(await run(["step", "fake", "--project", dir.slice(cwd.length + 1), "--param", "n=1"]), 0);
});

test("step returns 2 on fail and prints verdicts", async () => {
  const dir = await newProject("failing");
  reset();
  assert.equal(await run(["step", "fake-fail", "--project", dir]), 2);
  assert.match(out(), /^fake-fail {2}fail /m);
  assert.match(out(), /^ {2}✗ a >= 5 \(actual 1\)$/m);
});

test("step prints error line on fail without verdicts", async () => {
  const dir = await newProject("missingparam");
  reset();
  assert.equal(await run(["step", "fake", "--project", dir]), 2);
  assert.match(out(), /^error: missing param: n$/m);
});

test("step --json prints the StepResult with cached", async () => {
  const dir = await newProject("json");
  reset();
  assert.equal(await run(["step", "fake", "--project", dir, "--param", "n=3", "--json"]), 0);
  const r = JSON.parse(out());
  assert.equal(r.step, "fake");
  assert.equal(r.status, "pass");
  assert.equal(r.cached, false);
});

test("step --force reruns instead of using the cache", async () => {
  const dir = await newProject("force");
  await run(["step", "fake", "--project", dir, "--param", "n=3"]);
  reset();
  assert.equal(await run(["step", "fake", "--project", dir, "--param", "n=3", "--force", "--json"]), 0);
  assert.equal(JSON.parse(out()).cached, false);
});

test("unknown step lists available steps and exits 64", async () => {
  const dir = await newProject("unk");
  reset();
  assert.equal(await run(["step", "nope", "--project", dir]), 64);
  assert.match(err(), /fake-fail/);
});

test("step with bad project path exits 1; missing --project exits 64", async () => {
  reset();
  assert.equal(await run(["step", "fake", "--project", join(cwd, "does-not-exist")]), 1);
  reset();
  assert.equal(await run(["step", "fake"]), 64);
});

test("status says no steps yet on an empty project", async () => {
  const dir = await newProject("empty");
  reset();
  assert.equal(await run(["status", "--project", dir]), 0);
  assert.match(out(), /no steps yet/);
});

test("status lists latest result per step sorted by name", async () => {
  const dir = await newProject("stat");
  await run(["step", "fake-fail", "--project", dir]);
  await run(["step", "fake", "--project", dir, "--param", "n=1"]);
  reset();
  assert.equal(await run(["status", "--project", dir]), 0);
  const lines = out().trim().split("\n").filter((l) => /^fake/.test(l));
  assert.match(lines[0] ?? "", /^fake {2}pass/);
  assert.match(lines[1] ?? "", /^fake-fail {2}fail/);
});

test("status --json lists latest results", async () => {
  const dir = await newProject("statjson");
  await run(["step", "fake", "--project", dir, "--param", "n=1"]);
  reset();
  assert.equal(await run(["status", "--project", dir, "--json"]), 0);
  assert.equal(JSON.parse(out()).fake.status, "pass");
});

test("unknown command prints usage and exits 64", async () => {
  reset();
  assert.equal(await run(["dance"]), 64);
  assert.match(err(), /usage/i);
  reset();
  assert.equal(await run([]), 64);
});

test("--help prints usage and exits 0", async () => {
  reset();
  assert.equal(await run(["--help"]), 0);
  assert.match(out(), /usage/i);
});

test("output never contains a secret value", async () => {
  const dir = await newProject("secret");
  const secret = "sekret-value-123";
  reset();
  const code = await run(["step", "fake-throw", "--project", dir], { GROQ_API_KEY: secret });
  assert.equal(code, 2);
  assert.ok(out().includes("[redacted]"));
  assert.ok(!out().includes(secret));
  assert.ok(!err().includes(secret));
  reset();
  await run(["status", "--project", dir, "--json"], { GROQ_API_KEY: secret });
  assert.ok(!out().includes(secret));
});
