import assert from "node:assert/strict";
import { test } from "node:test";
import { NonRetryableError, withProvider, ProviderHttpError } from "./call.ts";
import { NoProviderError } from "./registry.ts";
import type { PickedProvider, PickOptions, ProviderRegistry } from "./registry.ts";

function fakeRegistry(ids: string[]) {
  const log = { used: [] as string[], exhausted: [] as string[], picks: [] as (PickOptions | undefined)[] };
  const registry: ProviderRegistry = {
    async pick(capability, opts) {
      log.picks.push(opts);
      const id = ids.find((i) => !opts?.exclude?.includes(i));
      if (!id) throw new NoProviderError(capability, ids.map((i) => ({ id: i, reason: "excluded" as const })));
      return {
        id,
        model: `${id}-model`,
        capabilities: ["stt"],
        kind: "openai-compat",
        limits: {},
        reset: { tz: "UTC" },
        flags: { commercial_ok: true, trains_on_data: false, renewable: true },
        priority: {},
        envValues: {},
      } as PickedProvider;
    },
    async recordUse(id) {
      log.used.push(id);
    },
    async markExhausted(id) {
      log.exhausted.push(id);
    },
  };
  return { registry, log };
}

test("withProvider falls back after 429 and marks exhausted", async () => {
  const { registry, log } = fakeRegistry(["groq", "cloudflare"]);
  const out = await withProvider(registry, "stt", async (p) => {
    if (p.id === "groq") throw new ProviderHttpError(429, "groq", "groq HTTP 429: slow down");
    return "ok";
  });
  assert.equal(out.result, "ok");
  assert.deepEqual(out.provider, { id: "cloudflare", model: "cloudflare-model" });
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0]?.id, "groq");
  assert.deepEqual(log.exhausted, ["groq"]);
  assert.deepEqual(log.used, ["cloudflare"]);
});

test("withProvider falls back on network error without marking exhausted", async () => {
  const { registry, log } = fakeRegistry(["a", "b"]);
  const out = await withProvider(registry, "stt", async (p) => {
    if (p.id === "a") throw new TypeError("fetch failed");
    return 1;
  });
  assert.equal(out.provider.id, "b");
  assert.deepEqual(log.exhausted, []);
  assert.deepEqual(log.used, ["b"]);
});

test("withProvider falls back on 5xx and 401 without marking exhausted", async () => {
  const { registry, log } = fakeRegistry(["a", "b", "c"]);
  const out = await withProvider(registry, "stt", async (p) => {
    if (p.id === "a") throw new ProviderHttpError(500, "a", "a HTTP 500");
    if (p.id === "b") throw new ProviderHttpError(401, "b", "b HTTP 401");
    return "c-ok";
  });
  assert.equal(out.provider.id, "c");
  assert.deepEqual(log.exhausted, []);
  assert.deepEqual(log.used, ["c"]);
});

test("withProvider passes private and prefer to pick, accumulating exclude", async () => {
  const { registry, log } = fakeRegistry(["a", "b"]);
  await withProvider(
    registry,
    "stt",
    async (p) => {
      if (p.id === "a") throw new Error("boom");
      return 1;
    },
    { private: true, prefer: "a" },
  );
  assert.equal(log.picks[0]?.private, true);
  assert.equal(log.picks[0]?.prefer, "a");
  assert.deepEqual(log.picks[0]?.exclude, []);
  assert.deepEqual(log.picks[1]?.exclude, ["a"]);
});

test("all providers failing gives NoProviderError listing attempts", async () => {
  const { registry, log } = fakeRegistry(["a", "b"]);
  await assert.rejects(
    withProvider(registry, "stt", async (p) => {
      throw new Error(`${p.id} broke`);
    }),
    (e: unknown) => {
      assert.ok(e instanceof NoProviderError);
      assert.match(e.message, /attempts: a: a broke/);
      assert.match(e.message, /b: b broke/);
      assert.equal(e.reasons.length, 2);
      return true;
    },
  );
  assert.deepEqual(log.used, []);
});

test("withProvider with no attempts rethrows plain NoProviderError", async () => {
  const { registry } = fakeRegistry([]);
  await assert.rejects(
    withProvider(registry, "stt", async () => 1),
    (e: unknown) => e instanceof NoProviderError && !/attempts:/.test(e.message),
  );
});

test("withProvider stops at maxAttempts", async () => {
  const { registry } = fakeRegistry(["a", "b", "c"]);
  let calls = 0;
  await assert.rejects(
    withProvider(
      registry,
      "stt",
      async () => {
        calls++;
        throw new Error("x");
      },
      { maxAttempts: 2 },
    ),
  );
  assert.equal(calls, 2);
});

test("recordUse failure still returns the result and does not rotate", async () => {
  const { registry } = fakeRegistry(["a", "b"]);
  registry.recordUse = async () => {
    throw new Error("disk full");
  };
  let calls = 0;
  const out = await withProvider(registry, "stt", async () => {
    calls++;
    return "good";
  });
  assert.equal(out.result, "good");
  assert.equal(out.provider.id, "a");
  assert.equal(calls, 1);
});

test("maxAttempts exhaustion throws NoProviderError with attempts", async () => {
  const { registry } = fakeRegistry(["a", "b", "c"]);
  await assert.rejects(
    withProvider(
      registry,
      "stt",
      async (p) => {
        throw new Error(`${p.id} down`);
      },
      { maxAttempts: 2 },
    ),
    (e: unknown) => {
      assert.ok(e instanceof NoProviderError);
      assert.match(e.message, /attempts: a: a down; b: b down/);
      return true;
    },
  );
});

test("NonRetryableError is rethrown without rotating", async () => {
  const { registry, log } = fakeRegistry(["a", "b"]);
  let calls = 0;
  await assert.rejects(
    withProvider(registry, "stt", async () => {
      calls++;
      throw new NonRetryableError("no such file");
    }),
    (e: unknown) => e instanceof NonRetryableError,
  );
  assert.equal(calls, 1);
  assert.deepEqual(log.used, []);
  assert.deepEqual(log.exhausted, []);
});
