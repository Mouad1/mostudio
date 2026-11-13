import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { StepModule } from "../../core/src/index.ts";
import { main, rootOf } from "./main.ts";

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
  "fake-warn": {
    contract: { name: "fake-warn", ...fakeContract, gate: [{ metric: "a", op: "between", value: [2, 4], level: "warn" }] },
    run: async () => ({ metrics: { a: 9 }, artifacts: [] }),
  },
  "fake-file": {
    contract: { name: "fake-file", ...fakeContract, params: { source: "string" }, fileParams: ["source"] },
    run: async (ctx) => ({ metrics: { source: String(ctx.params.source) }, artifacts: [] }),
  },
  captions: {
    contract: { name: "captions", ...fakeContract, params: { width: "number?" } },
    run: async (ctx) => ({ metrics: { width: Number(ctx.params.width ?? 0) }, artifacts: [] }),
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
  root: cwd,
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

test("catch-all error message is redacted", async () => {
  const secret = "sekret-path-777";
  reset();
  assert.equal(await run(["new", "redacted", "--brief", secret], { GROQ_API_KEY: secret }), 1);
  assert.match(err(), /\[redacted\]/);
  assert.ok(!err().includes(secret));
});

test("repo files come from root, not cwd; user paths resolve against cwd", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "mostudio-elsewhere-"));
  try {
    writeFileSync(join(elsewhere, "brief.md"), "# elsewhere\n");
    const io = { ...mk(), cwd: elsewhere };
    reset();
    assert.equal(await main(["new", "fromelsewhere", "--brief", "brief.md"], io, steps), 0);
    const dir = out().trim();
    assert.ok(dir.startsWith(join(cwd, "projects")));
    reset();
    assert.equal(await main(["step", "fake", "--project", dir, "--param", "n=1"], io, steps), 0);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("root defaults to MOSTUDIO_ROOT, then the CLI's own repo", () => {
  const base = { stdout: () => {}, stderr: () => {}, cwd: "/tmp" };
  assert.equal(rootOf({ ...base, env: { MOSTUDIO_ROOT: "/some/root" } }), "/some/root");
  assert.equal(rootOf({ ...base, env: { MOSTUDIO_ROOT: "" } }), join(import.meta.dirname, "..", ".."));
  assert.ok(existsSync(join(rootOf({ ...base, env: {} }), "providers.json")));
  assert.equal(rootOf({ ...base, env: { MOSTUDIO_ROOT: "/a" }, root: "/b" }), "/b");

  // finds workspace via findWorkspace(cwd)
  const ws = mkdtempSync(join(tmpdir(), "mostudio-ws-root-"));
  try {
    writeFileSync(join(ws, "mostudio.config.json"), "{}");
    const sub = join(ws, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    assert.equal(rootOf({ ...base, env: {}, cwd: sub }), ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("invalid providers.json in workspace fails loudly", async () => {
  const root = mkdtempSync(join(tmpdir(), "mostudio-root-"));
  try {
    const io = { ...mk(), root };
    const dir = await newProject("noproviders");
    writeFileSync(join(root, "providers.json"), "{not json");
    reset();
    assert.equal(await main(["step", "fake", "--project", dir, "--param", "n=1"], io, steps), 1);
    assert.match(err(), /providers\.json/);
    writeFileSync(join(root, "providers.json"), JSON.stringify([{ id: "x" }]));
    reset();
    assert.equal(await main(["step", "fake", "--project", dir, "--param", "n=1"], io, steps), 1);
    assert.match(err(), /providers\.json\[0\]\.capabilities/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run finds workflows in the package when the workspace has none", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mostudio-ws-wf-"));
  try {
    writeFileSync(join(ws, "mostudio.config.json"), JSON.stringify({}));
    const dir = join(ws, "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.json"), JSON.stringify({ name: "p" }));
    reset();
    assert.equal(
      await main(
        ["run", "nope", "--project", dir],
        {
          stdout: (s: string) => void outBuf.push(s),
          stderr: (s: string) => void errBuf.push(s),
          cwd: ws,
          root: ws,
          env: env(),
        },
        steps,
      ),
      64,
    );
    assert.match(err(), /unknown workflow: nope/);
    assert.match(err(), /rough-cut/);
    assert.match(err(), /short/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("warn status prints the failed warn verdicts", async () => {
  const dir = await newProject("warning");
  reset();
  assert.equal(await run(["step", "fake-warn", "--project", dir]), 0);
  assert.match(out(), /^fake-warn {2}warn /m);
  assert.match(out(), /^ {2}✗ a between 2\.\.4 \(actual 9\)$/m);
});

test("relative fileParams resolve against cwd", async () => {
  const dir = await newProject("fileparam");
  writeFileSync(join(cwd, "clip file.txt"), "x");
  reset();
  assert.equal(await run(["step", "fake-file", "--project", dir, "--param", "source=clip file.txt", "--json"]), 0);
  assert.equal(JSON.parse(out()).metrics.source, join(cwd, "clip file.txt"));
});

test("inherited object keys are not step names", async () => {
  const dir = await newProject("proto");
  for (const name of ["toString", "constructor", "__proto__"]) {
    reset();
    assert.equal(await run(["step", name, "--project", dir]), 64, name);
    assert.match(err(), /unknown step/);
  }
});

const writeWf = (name: string, wf: unknown) => {
  mkdirSync(join(cwd, "workflows"), { recursive: true });
  writeFileSync(join(cwd, "workflows", `${name}.json`), JSON.stringify(wf));
};

test("run prints a line per step then a done summary", async () => {
  writeWf("wf-ok", { name: "wf-ok", steps: [{ step: "fake", params: { n: 1 } }, { step: "fake-warn" }] });
  const dir = await newProject("run-ok");
  reset();
  assert.equal(await run(["run", "wf-ok", "--project", dir]), 0);
  assert.match(out(), /^fake {2}pass .*a=1/m);
  assert.match(out(), /^fake-warn {2}warn /m);
  assert.match(out(), /^wf-ok: done$/m);
});

test("CLI run maps --param step.key=value to that step", async () => {
  writeWf("wf-param", { name: "wf-param", steps: [{ step: "fake", params: { n: 1 } }, { step: "captions", params: { width: 1920 } }] });
  const dir = await newProject("run-param");
  reset();
  assert.equal(await run(["run", "wf-param", "--project", dir, "--param", "fake.n=5", "--param", "captions.width=1080"]), 0);
  assert.match(out(), /^fake {2}pass .*a=5/m);
  assert.match(out(), /^captions {2}pass .*width=1080/m);
});

test("run rejects --param for a step outside the workflow", async () => {
  writeWf("wf-p2", { name: "wf-p2", steps: [{ step: "fake", params: { n: 1 } }] });
  const dir = await newProject("run-badparam");
  reset();
  assert.equal(await run(["run", "wf-p2", "--project", dir, "--param", "nope.x=1"]), 64);
  assert.match(err(), /nope/);
  reset();
  assert.equal(await run(["run", "wf-p2", "--project", dir, "--param", "n=1"]), 64);
});

test("run exits 2 and names the failing step", async () => {
  writeWf("wf-fail", { name: "wf-fail", steps: [{ step: "fake-fail" }, { step: "fake", params: { n: 1 } }] });
  const dir = await newProject("run-fail");
  reset();
  assert.equal(await run(["run", "wf-fail", "--project", dir]), 2);
  assert.match(out(), /^wf-fail: failed at fake-fail$/m);
  assert.doesNotMatch(out(), /^fake {2}/m);
});

test("CLI exit 3 on awaiting approval names the review files, approve resumes", async () => {
  writeWf("wf-appr", { name: "wf-appr", steps: [{ step: "captions", approve: true }, { step: "fake", params: { n: 1 } }] });
  const dir = await newProject("run-approve");
  reset();
  assert.equal(await run(["run", "wf-appr", "--project", dir]), 3);
  assert.match(out(), /^wf-appr: awaiting approval at captions$/m);
  assert.match(out(), /review captions\/captions\.txt, add fixes to edits\/replacements\.txt, re-run the same command, then: mostudio approve captions --project /);
  reset();
  assert.equal(await run(["approve", "captions", "--project", dir]), 0);
  reset();
  assert.equal(await run(["run", "wf-appr", "--project", dir]), 0);
  assert.match(out(), /^captions .*\(cached\)$/m);
  assert.match(out(), /^wf-appr: done$/m);
});

test("run uses a generic review message for other steps", async () => {
  writeWf("wf-gen", { name: "wf-gen", steps: [{ step: "fake", params: { n: 1 }, approve: true }] });
  const dir = await newProject("run-generic");
  reset();
  assert.equal(await run(["run", "wf-gen", "--project", dir]), 3);
  assert.match(out(), /review the outputs of fake, then: mostudio approve fake --project /);
});

test("run --json prints status, stoppedAt and results", async () => {
  writeWf("wf-json", { name: "wf-json", steps: [{ step: "captions", approve: true }] });
  const dir = await newProject("run-json");
  reset();
  assert.equal(await run(["run", "wf-json", "--project", dir, "--json"]), 3);
  const r = JSON.parse(out());
  assert.equal(r.status, "awaiting-approval");
  assert.equal(r.stoppedAt, "captions");
  assert.equal(r.results[0].step, "captions");
});

test("run --force reruns only that step", async () => {
  writeWf("wf-force", { name: "wf-force", steps: [{ step: "fake", params: { n: 1 } }, { step: "fake-warn" }] });
  const dir = await newProject("run-force");
  reset();
  await run(["run", "wf-force", "--project", dir]);
  reset();
  assert.equal(await run(["run", "wf-force", "--project", dir, "--force", "fake-warn"]), 0);
  assert.match(out(), /^fake .*\(cached\)$/m);
  assert.doesNotMatch(out(), /^fake-warn .*\(cached\)$/m);
});

test("run exits 64 for unknown workflow (listing available) and unknown step", async () => {
  writeWf("wf-known", { name: "wf-known", steps: [{ step: "fake", params: { n: 1 } }] });
  writeWf("wf-badstep", { name: "wf-badstep", steps: [{ step: "ghost" }] });
  const dir = await newProject("run-unknown");
  reset();
  assert.equal(await run(["run", "nope", "--project", dir]), 64);
  assert.match(err(), /unknown workflow: nope/);
  assert.match(err(), /wf-known/);
  reset();
  assert.equal(await run(["run", "wf-badstep", "--project", dir]), 64);
  assert.match(err(), /unknown step "ghost"/);
});

test("approve exits 1 when the step has no passing result", async () => {
  const dir = await newProject("approve-none");
  reset();
  assert.equal(await run(["approve", "captions", "--project", dir]), 1);
  assert.match(err(), /no passing result/);
});

test("run remembers --param across re-runs", async () => {
  writeWf("wf-mem", { name: "wf-mem", steps: [{ step: "fake" }, { step: "captions", approve: true }] });
  const dir = await newProject("run-mem");
  reset();
  assert.equal(await run(["run", "wf-mem", "--project", dir, "--param", "fake.n=4"]), 3);
  reset();
  assert.equal(await run(["approve", "captions", "--project", dir]), 0);
  reset();
  assert.equal(await run(["run", "wf-mem", "--project", dir]), 0);
  assert.match(out(), /^fake .*a=4.*\(cached\)$/m);
  assert.match(out(), /^wf-mem: done$/m);
});

test("run --json still prints output when a step throws unexpectedly", async () => {
  const bad: StepModule = {
    contract: { name: "bad", ...fakeContract },
    run: async () => ({ metrics: {}, artifacts: [] }),
  };
  Object.defineProperty(bad.contract, "name", {
    get() {
      throw new Error("kaboom");
    },
  });
  writeWf("wf-throw", { name: "wf-throw", steps: [{ step: "bad" }] });
  const dir = await newProject("run-throw");
  reset();
  assert.equal(await main(["run", "wf-throw", "--project", dir, "--json"], mk(), { ...steps, bad }), 2);
  const r = JSON.parse(out());
  assert.equal(r.status, "failed");
  assert.equal(r.stoppedAt, "bad");
  assert.match(r.results[0].error, /kaboom/);
  reset();
  assert.equal(await main(["status", "--project", dir, "--json"], mk(), steps), 0);
  assert.equal(JSON.parse(out()).bad.status, "fail");
  reset();
  assert.equal(await run(["approve", "bad", "--project", dir]), 1);
  assert.match(err(), /no passing result/);
});

test("run: invalid --param exits 64 naming step and key, persists nothing; empty value forgets", async () => {
  writeWf("wf-val", { name: "wf-val", steps: [{ step: "fake", params: { n: 1 } }] });
  const dir = await newProject("run-validate");
  reset();
  assert.equal(await run(["run", "wf-val", "--project", dir, "--param", "fake.m=2"]), 64);
  assert.match(err(), /step "fake".*undeclared params: m/);
  assert.equal(existsSync(join(dir, "steps", "workflow-params.json")), false);
  reset();
  assert.equal(await run(["run", "wf-val", "--project", dir, "--param", "fake.n=8"]), 0);
  assert.match(out(), /a=8/);
  reset();
  assert.equal(await run(["run", "wf-val", "--project", dir, "--param", "fake.n="]), 0);
  assert.match(out(), /a=1/);
});

test("run refuses a second workflow on a project (exit 64) unless --switch-workflow", async () => {
  writeWf("wf-a", { name: "wf-a", steps: [{ step: "fake", params: { n: 1 } }] });
  writeWf("wf-b", { name: "wf-b", steps: [{ step: "fake", params: { n: 2 } }] });
  const dir = await newProject("run-switch");
  reset();
  assert.equal(await run(["run", "wf-a", "--project", dir]), 0);
  reset();
  assert.equal(await run(["run", "wf-b", "--project", dir]), 64);
  assert.match(err(), /this project ran wf-a; create a new project \(mostudio new\) or pass --switch-workflow/);
  reset();
  assert.equal(await run(["run", "wf-b", "--project", dir, "--switch-workflow"]), 0);
  assert.match(out(), /^wf-b: done$/m);
});

test("status marks an unapproved approval step of the project's workflow", async () => {
  writeWf("wf-st", { name: "wf-st", steps: [{ step: "fake", params: { n: 1 } }, { step: "captions", approve: true }] });
  const dir = await newProject("status-approval");
  reset();
  assert.equal(await run(["run", "wf-st", "--project", dir]), 3);
  reset();
  assert.equal(await run(["status", "--project", dir]), 0);
  assert.match(out(), /^captions .*awaiting approval/m);
  assert.doesNotMatch(out(), /^fake .*awaiting approval/m);
  reset();
  assert.equal(await run(["status", "--project", dir, "--json"]), 0);
  assert.equal(JSON.parse(out()).captions.awaitingApproval, true);
  reset();
  assert.equal(await run(["approve", "captions", "--project", dir]), 0);
  reset();
  assert.equal(await run(["status", "--project", dir]), 0);
  assert.doesNotMatch(out(), /awaiting approval/);
});

test("run --auto passes the approve step and logs it", async () => {
  writeWf("wf-auto", { name: "wf-auto", steps: [{ step: "captions", approve: true }, { step: "fake", params: { n: 1 } }] });
  const dir = await newProject("run-auto");
  reset();
  assert.equal(await run(["run", "wf-auto", "--project", dir, "--auto"]), 0);
  assert.match(err(), /auto-approved captions/);
  assert.match(out(), /^captions .*pass/m);
  assert.match(out(), /^fake .*pass/m);
  assert.match(out(), /^wf-auto: done$/m);
  const approvals = JSON.parse(readFileSync(join(dir, "steps", "approvals.json"), "utf8"));
  assert.ok(approvals.captions);
});
