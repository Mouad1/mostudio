import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { Config } from "./config.ts";
import { latest, readLedger } from "./ledger.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import { runStep } from "./step.ts";
import type { StepContract, StepModule } from "./step.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const providers = {} as ProviderRegistry;
const silent = () => {};

let tmp: string;
let dir: string;
let n = 0;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-step-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = join(tmp, `Vidéos à monter ${n++}`);
  await mkdir(join(dir, "media"), { recursive: true });
  await mkdir(join(dir, "steps"), { recursive: true });
  await writeFile(join(dir, "media", "in.txt"), "hello");
});

const base = () => ({ config, providers, log: silent });

function makeFake(over: Partial<StepContract> = {}, write = true) {
  const calls = { n: 0 };
  const mod: StepModule = {
    contract: {
      name: "fake",
      inputs: ["media/in.txt"],
      outputs: ["renders/out.txt"],
      gate: [{ metric: "n", op: ">=", value: 1, level: "fail" }],
      ...over,
    },
    async run(ctx) {
      calls.n++;
      if (write) {
        await mkdir(join(ctx.projectDir, "renders"), { recursive: true });
        await writeFile(join(ctx.projectDir, "renders", "out.txt"), "x");
      }
      return { metrics: { n: 3 }, artifacts: ["renders/out.txt"] };
    },
  };
  return { mod, calls };
}

test("runs, gates, records", async () => {
  const { mod } = makeFake();
  const r = await runStep(dir, mod, base());
  assert.equal(r.status, "pass");
  assert.equal(r.cached, false);
  assert.deepEqual(r.artifacts, ["renders/out.txt"]);
  assert.equal(latest(await readLedger(dir), "fake")?.inputsHash, r.inputsHash);
  assert.ok(existsSync(join(dir, "steps", "fake.json")));
});

test("second run with same inputs is cached, ledger not rewritten", async () => {
  const { mod, calls } = makeFake();
  await runStep(dir, mod, base());
  const r = await runStep(dir, mod, base());
  assert.equal(r.cached, true);
  assert.equal(calls.n, 1);
  assert.equal((await readLedger(dir)).steps.fake?.length, 1);
});

test("force bypasses cache", async () => {
  const { mod, calls } = makeFake();
  await runStep(dir, mod, base());
  const r = await runStep(dir, mod, { ...base(), force: true });
  assert.equal(r.cached, false);
  assert.equal(calls.n, 2);
});

test("missing output file bypasses cache", async () => {
  const { mod, calls } = makeFake();
  await runStep(dir, mod, base());
  await rm(join(dir, "renders", "out.txt"));
  assert.equal((await runStep(dir, mod, base())).cached, false);
  assert.equal(calls.n, 2);
});

test("changed fileParams file invalidates cache", async () => {
  const src = join(dir, "source.txt");
  await writeFile(src, "a");
  const { mod } = makeFake({ params: { source: "string" }, fileParams: ["source"] });
  const opts = { ...base(), params: { source: src } };
  await runStep(dir, mod, opts);
  assert.equal((await runStep(dir, mod, opts)).cached, true);
  await writeFile(src, "b");
  assert.equal((await runStep(dir, mod, opts)).cached, false);
});

test("changed input file invalidates cache", async () => {
  const { mod } = makeFake();
  await runStep(dir, mod, base());
  await writeFile(join(dir, "media", "in.txt"), "changed");
  assert.equal((await runStep(dir, mod, base())).cached, false);
});

test("changed params invalidate cache", async () => {
  const { mod } = makeFake({ params: { k: "number" } });
  await runStep(dir, mod, { ...base(), params: { k: "1" } });
  assert.equal((await runStep(dir, mod, { ...base(), params: { k: "1" } })).cached, true);
  assert.equal((await runStep(dir, mod, { ...base(), params: { k: "2" } })).cached, false);
});

test("two steps never share a hash", async () => {
  const a = await runStep(dir, makeFake({ name: "one" }).mod, base());
  const b = await runStep(dir, makeFake({ name: "two" }).mod, base());
  assert.notEqual(a.inputsHash, b.inputsHash);
});

test("missing declared output fails", async () => {
  const { mod } = makeFake({}, false);
  const r = await runStep(dir, mod, base());
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /renders\/out\.txt/);
});

test("thrown error is recorded as fail without stack", async () => {
  const { mod } = makeFake();
  mod.run = async () => {
    throw new Error("boom");
  };
  const r = await runStep(dir, mod, base());
  assert.equal(r.status, "fail");
  assert.equal(r.error, "boom");
  assert.equal(latest(await readLedger(dir), "fake")?.error, "boom");
});

test("failed result is not served from cache", async () => {
  const { mod, calls } = makeFake({}, false);
  await runStep(dir, mod, base());
  assert.equal((await runStep(dir, mod, base())).cached, false);
  assert.equal(calls.n, 2);
});

test("gate failure yields fail and gateOverrides apply", async () => {
  const { mod } = makeFake({ gate: [{ metric: "n", op: ">=", value: 10, level: "fail" }] });
  assert.equal((await runStep(dir, mod, base())).status, "fail");
  const r = await runStep(dir, mod, {
    ...base(),
    force: true,
    gateOverrides: [{ metric: "n", op: ">=", value: 1, level: "fail" }],
  });
  assert.equal(r.status, "pass");
});

test("missing input fails before running and is recorded", async () => {
  const { mod, calls } = makeFake({ inputs: ["media/nope.txt"] });
  const r = await runStep(dir, mod, base());
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /media\/nope\.txt/);
  assert.equal(r.inputsHash, "");
  assert.equal(r.durationMs, 0);
  assert.equal(calls.n, 0);
  assert.equal(latest(await readLedger(dir), "fake")?.status, "fail");
});

test("missing fileParams file fails; relative path fails", async () => {
  const { mod, calls } = makeFake({ params: { source: "string" }, fileParams: ["source"] });
  const r1 = await runStep(dir, mod, { ...base(), params: { source: join(dir, "nope") } });
  assert.equal(r1.status, "fail");
  const r2 = await runStep(dir, mod, { ...base(), params: { source: "rel.txt" } });
  assert.equal(r2.status, "fail");
  assert.equal(calls.n, 0);
});

test("glob media/* expands sorted files, skips dotfiles and dirs", async () => {
  await writeFile(join(dir, "media", "b.txt"), "b");
  await writeFile(join(dir, "media", ".hidden"), "h");
  await mkdir(join(dir, "media", "sub"));
  const { mod } = makeFake({ inputs: ["media/*"] });
  const r1 = await runStep(dir, mod, base());
  assert.equal(r1.status, "pass");
  assert.equal((await runStep(dir, mod, base())).cached, true);
  await writeFile(join(dir, "media", "c.txt"), "c");
  assert.equal((await runStep(dir, mod, base())).cached, false);
  await writeFile(join(dir, "media", ".hidden"), "changed");
  assert.equal((await runStep(dir, mod, base())).cached, true);
});

test("empty glob counts as missing input", async () => {
  await rm(join(dir, "media", "in.txt"));
  const { mod, calls } = makeFake({ inputs: ["media/*"] });
  const r = await runStep(dir, mod, base());
  assert.equal(r.status, "fail");
  assert.equal(calls.n, 0);
});

test("unsupported glob pattern fails", async () => {
  for (const p of ["media/*.mp4", "**/*", "*/in.txt", "media/**"]) {
    const { mod, calls } = makeFake({ inputs: [p] });
    const r = await runStep(dir, mod, base());
    assert.equal(r.status, "fail", p);
    assert.match(r.error ?? "", /unsupported input pattern/);
    assert.equal(calls.n, 0);
  }
});

test("params: coercion, type validation, undeclared extras", async () => {
  let seen: Record<string, unknown> = {};
  const { mod } = makeFake({ params: { t: "number", on: "boolean", s: "string" } });
  const inner = mod.run;
  mod.run = async (ctx) => {
    seen = ctx.params;
    return inner(ctx);
  };
  const ok = await runStep(dir, mod, { ...base(), params: { t: "3.5", on: "true", s: "x" } });
  assert.equal(ok.status, "pass");
  assert.deepEqual(seen, { t: 3.5, on: true, s: "x" });

  const badNum = await runStep(dir, mod, { ...base(), params: { t: "abc", on: "true", s: "x" } });
  assert.equal(badNum.status, "fail");
  const badBool = await runStep(dir, mod, { ...base(), params: { t: 1, on: "yes", s: "x" } });
  assert.equal(badBool.status, "fail");
  const missing = await runStep(dir, mod, { ...base(), params: { t: 1, on: true } });
  assert.equal(missing.status, "fail");
  const wrong = await runStep(dir, mod, { ...base(), params: { t: 1, on: true, s: 5 } });
  assert.equal(wrong.status, "fail");
  const extra = await runStep(dir, mod, { ...base(), params: { t: 1, on: true, s: "x", zzz: 1 } });
  assert.equal(extra.status, "fail");
  assert.match(extra.error ?? "", /zzz/);
});

test("default log writes to stderr with step prefix; opts.log overrides", async () => {
  const lines: string[] = [];
  const { mod } = makeFake();
  const inner = mod.run;
  mod.run = async (ctx) => {
    ctx.log("hi");
    return inner(ctx);
  };
  await runStep(dir, mod, { config, providers, log: (m) => lines.push(m) });
  assert.deepEqual(lines, ["hi"]);
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((c: string | Uint8Array) => {
    out += String(c);
    return true;
  }) as typeof process.stderr.write;
  try {
    await runStep(dir, mod, { config, providers, force: true });
  } finally {
    process.stderr.write = orig;
  }
  assert.match(out, /\[fake\] hi/);
});

test("provider and quota from output are recorded", async () => {
  const { mod } = makeFake();
  const inner = mod.run;
  mod.run = async (ctx) => ({
    ...(await inner(ctx)),
    provider: { id: "p", model: "m" },
    quota: { requests: 1 },
  });
  const r = await runStep(dir, mod, base());
  assert.deepEqual(r.provider, { id: "p", model: "m" });
  assert.deepEqual(r.quota, { requests: 1 });
  assert.equal(await readFile(join(dir, "renders", "out.txt"), "utf8"), "x");
});
