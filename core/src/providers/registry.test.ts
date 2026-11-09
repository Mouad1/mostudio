import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { after, before, test } from "node:test";
import { createRegistry, NoProviderError } from "./registry.ts";
import type { ProviderEntry } from "./registry.ts";

let tmp: string;
let n = 0;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-registry-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});
const store = () => join(tmp, `sub${n++}`, "quota.json");

function entry(id: string, over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id,
    capabilities: ["stt"],
    kind: "openai-compat",
    model: `${id}-model`,
    keyEnv: `${id.toUpperCase()}_KEY`,
    limits: {},
    reset: { tz: "America/Los_Angeles" },
    flags: { commercial_ok: true, trains_on_data: false, renewable: true },
    priority: { stt: 1 },
    ...over,
  };
}
const env = { A_KEY: "ka", B_KEY: "kb", C_KEY: "kc" };
const t0 = new Date("2026-11-03T18:00:00Z");

test("seed providers.json is valid and picks groq for stt", async () => {
  const seeds = JSON.parse(
    readFileSync(new URL("../../../providers.json", import.meta.url), "utf8"),
  ) as ProviderEntry[];
  const reg = createRegistry(seeds, { GROQ_API_KEY: "g", GEMINI_API_KEY: "m" }, store(), "free-only");
  const stt = await reg.pick("stt", { now: t0 });
  assert.equal(stt.id, "groq");
  assert.equal(stt.model, "whisper-large-v3");
  const llm = await reg.pick("llm", { now: t0 });
  assert.equal(llm.id, "gemini");
  assert.equal((await reg.pick("stt", { now: t0, private: true })).id, "groq");
  const noKeys = createRegistry(seeds, {}, store(), "free-only");
  assert.equal((await noKeys.pick("stt", { now: t0 })).id, "whisper-cpp");
  assert.ok(seeds.every((e) => e.id !== "cohere"));
  assert.equal(seeds.find((e) => e.id === "nvidia")?.flags.renewable, false);
});

test("picks highest priority with key", async () => {
  const reg = createRegistry(
    [entry("b", { priority: { stt: 2 } }), entry("a", { priority: { stt: 1 } })],
    env,
    store(),
    "free-only",
  );
  const p = await reg.pick("stt", { now: t0 });
  assert.equal(p.id, "a");
  assert.equal(p.key?.reveal(), "ka");
  assert.ok(!inspect(p).includes("ka\""), "raw key not on object");
  assert.ok(!JSON.stringify(p).includes('"ka"'));
});

test("skips provider without key; keyless local entry needs no key", async () => {
  const reg = createRegistry(
    [entry("a"), entry("local", { kind: "local", keyEnv: undefined, priority: { stt: 9 } })],
    {},
    store(),
    "free-only",
  );
  const p = await reg.pick("stt", { now: t0 });
  assert.equal(p.id, "local");
  assert.equal(p.key, undefined);
});

test("models map overrides model per capability", async () => {
  const reg = createRegistry(
    [entry("a", { capabilities: ["stt", "llm"], priority: { stt: 1, llm: 1 }, models: { llm: "big" } })],
    env,
    store(),
    "free-only",
  );
  assert.equal((await reg.pick("llm", { now: t0 })).model, "big");
  assert.equal((await reg.pick("stt", { now: t0 })).model, "a-model");
});

test("private step skips trains_on_data", async () => {
  const reg = createRegistry(
    [entry("a", { capabilities: ["llm"], priority: { llm: 1 }, flags: { commercial_ok: true, trains_on_data: true, renewable: true } })],
    env,
    store(),
    "free-only",
  );
  assert.equal((await reg.pick("llm", { now: t0 })).id, "a");
  await assert.rejects(reg.pick("llm", { now: t0, private: true }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.deepEqual(e.reasons, [{ id: "a", reason: "excluded-flag" }]);
    return true;
  });
});

test("commercial_ok false is excluded", async () => {
  const reg = createRegistry(
    [entry("a", { flags: { commercial_ok: false, trains_on_data: false, renewable: true } })],
    env,
    store(),
    "free-only",
  );
  await assert.rejects(reg.pick("stt", { now: t0 }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.equal(e.reasons[0]?.reason, "excluded-flag");
    return true;
  });
});

test("paid entries excluded under free-only, allowed under allow-paid", async () => {
  const e = entry("a", { paid: true });
  const free = createRegistry([e], env, store(), "free-only");
  await assert.rejects(free.pick("stt", { now: t0 }), (err: unknown) => {
    assert.ok(err instanceof NoProviderError);
    assert.deepEqual(err.reasons, [{ id: "a", reason: "excluded-flag" }]);
    return true;
  });
  const paid = createRegistry([e], env, store(), "allow-paid");
  assert.equal((await paid.pick("stt", { now: t0 })).id, "a");
});

test("daily limit exhausts then resets at next midnight Pacific", async () => {
  const reg = createRegistry([entry("a", { limits: { rpd: 3 } }), entry("b", { priority: { stt: 2 } })], env, store(), "free-only");
  for (let i = 0; i < 3; i++) {
    const at = new Date(t0.getTime() + i * 120_000);
    assert.equal((await reg.pick("stt", { now: at })).id, "a");
    await reg.recordUse("a", at);
  }
  const later = new Date(t0.getTime() + 600_000);
  assert.equal((await reg.pick("stt", { now: later })).id, "b");
  // t0 = 10:00 PST 2026-11-03; next midnight PT = 2026-11-04T08:00Z
  const nextDay = new Date("2026-11-04T08:01:00Z");
  assert.equal((await reg.pick("stt", { now: nextDay })).id, "a");
});

test("rpm limit rate-limits for 60 s then clears", async () => {
  const reg = createRegistry([entry("a", { limits: { rpm: 2 } })], env, store(), "free-only");
  await reg.recordUse("a", t0);
  await reg.recordUse("a", new Date(t0.getTime() + 1000));
  await assert.rejects(reg.pick("stt", { now: new Date(t0.getTime() + 2000) }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.equal(e.reasons[0]?.reason, "rate-limited");
    assert.equal(e.reasons[0]?.until, new Date(t0.getTime() + 60_000).toISOString());
    return true;
  });
  assert.equal((await reg.pick("stt", { now: new Date(t0.getTime() + 61_500) })).id, "a");
});

test("all exhausted gives one reason per provider", async () => {
  const reg = createRegistry(
    [entry("a", { limits: { rpd: 1 } }), entry("b", { priority: { stt: 2 }, keyEnv: "NOPE_KEY" })],
    env,
    store(),
    "free-only",
  );
  await reg.recordUse("a", t0);
  await assert.rejects(reg.pick("stt", { now: t0 }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.equal(e.reasons.length, 2);
    assert.equal(e.reasons[0]?.reason, "exhausted");
    assert.equal(e.reasons[0]?.until, "2026-11-04T08:00:00.000Z");
    assert.deepEqual(e.reasons[1], { id: "b", reason: "no-key" });
    assert.match(e.message, /a: exhausted until 2026-11-04T08:00:00.000Z/);
    assert.match(e.message, /b: no-key/);
    return true;
  });
});

test("markExhausted skips provider until reset", async () => {
  const reg = createRegistry([entry("a"), entry("b", { priority: { stt: 2 } })], env, store(), "free-only");
  await reg.markExhausted("a", t0);
  assert.equal((await reg.pick("stt", { now: t0 })).id, "b");
  assert.equal((await reg.pick("stt", { now: new Date("2026-11-04T07:59:00Z") })).id, "b");
  assert.equal((await reg.pick("stt", { now: new Date("2026-11-04T08:00:00Z") })).id, "a");
});

test("quota persists across registries on the same store", async () => {
  const s = store();
  await createRegistry([entry("a", { limits: { rpd: 1 } })], env, s, "free-only").recordUse("a", t0);
  await assert.rejects(createRegistry([entry("a", { limits: { rpd: 1 } })], env, s, "free-only").pick("stt", { now: t0 }));
});

test("unknown capability gives NoProviderError naming it with empty reasons", async () => {
  const reg = createRegistry([entry("a")], env, store(), "free-only");
  await assert.rejects(reg.pick("tts", { now: t0 }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.deepEqual(e.reasons, []);
    assert.match(e.message, /tts/);
    return true;
  });
});

test("corrupt quota file does not brick pick", async () => {
  const s = store();
  await mkdir(dirname(s), { recursive: true });
  await writeFile(s, "{not json");
  const reg = createRegistry([entry("a", { limits: { rpd: 5 } })], env, s, "free-only");
  assert.equal((await reg.pick("stt", { now: t0 })).id, "a");
  await reg.recordUse("a", t0);
  assert.equal((await reg.pick("stt", { now: t0 })).id, "a");
});

test("wrong-shape quota entries do not brick pick", async () => {
  for (const bad of [`{"a":{}}`, `{"a":{"day":5,"minute":"x"}}`, `{"a":null}`, `[1]`, `"x"`]) {
    const s = store();
    await mkdir(dirname(s), { recursive: true });
    await writeFile(s, bad);
    const reg = createRegistry([entry("a", { limits: { rpd: 5, rpm: 5 } })], env, s, "free-only");
    assert.equal((await reg.pick("stt", { now: t0 })).id, "a", bad);
    await reg.recordUse("a", t0);
  }
});

test("rpm 0 and rpd 0 mean no capacity without throwing RangeError", async () => {
  const reg = createRegistry(
    [entry("a", { limits: { rpm: 0 } }), entry("b", { priority: { stt: 2 }, limits: { rpd: 0 } })],
    env,
    store(),
    "free-only",
  );
  await assert.rejects(reg.pick("stt", { now: t0 }), (e: unknown) => {
    assert.ok(e instanceof NoProviderError);
    assert.deepEqual(e.reasons[0], { id: "a", reason: "rate-limited" });
    assert.equal(e.reasons[1]?.reason, "exhausted");
    return true;
  });
});

test("prefer tries the named provider first when eligible", async () => {
  const reg = createRegistry(
    [entry("a", { priority: { stt: 1 } }), entry("b", { priority: { stt: 2 } })],
    env,
    store(),
    "free-only",
  );
  assert.equal((await reg.pick("stt", { now: t0, prefer: "b" })).id, "b");
  const noB = createRegistry([entry("a"), entry("b", { keyEnv: "MISSING_KEY" })], env, store(), "free-only");
  assert.equal((await noB.pick("stt", { now: t0, prefer: "b" })).id, "a");
  assert.equal((await reg.pick("stt", { now: t0, prefer: "zzz" })).id, "a");
});

test("exclude skips providers with reason excluded", async () => {
  const reg = createRegistry([entry("a"), entry("b", { priority: { stt: 2 } })], env, store(), "free-only");
  assert.equal((await reg.pick("stt", { now: t0, exclude: ["a"] })).id, "b");
  await assert.rejects(reg.pick("stt", { now: t0, exclude: ["a", "b"] }), (e: NoProviderError) => {
    assert.deepEqual(e.reasons.map((r) => [r.id, r.reason]), [["a", "excluded"], ["b", "excluded"]]);
    return true;
  });
});

test("entry env maps logical names to resolved non-secret values", async () => {
  const reg = createRegistry(
    [entry("a", { env: { accountId: "A_ACCOUNT_ID", region: "A_REGION" } })],
    { ...env, A_ACCOUNT_ID: "acct-1" },
    store(),
    "free-only",
  );
  const p = await reg.pick("stt", { now: t0 });
  assert.deepEqual(p.envValues, { accountId: "acct-1", region: undefined });
  const plain = createRegistry([entry("b")], env, store(), "free-only");
  assert.deepEqual((await plain.pick("stt", { now: t0 })).envValues, {});
});

test("seed cloudflare entry maps CLOUDFLARE_ACCOUNT_ID", () => {
  const seeds = JSON.parse(readFileSync(new URL("../../../providers.json", import.meta.url), "utf8")) as ProviderEntry[];
  assert.equal(seeds.find((e) => e.id === "cloudflare")?.env?.accountId, "CLOUDFLARE_ACCOUNT_ID");
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  assert.match(example, /^CLOUDFLARE_ACCOUNT_ID=/m);
});
