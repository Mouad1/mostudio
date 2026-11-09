import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseProviders } from "./parse.ts";

const good = {
  id: "a",
  capabilities: ["stt"],
  kind: "openai-compat",
  model: "m",
  limits: {},
  reset: { tz: "UTC" },
  flags: { commercial_ok: true, trains_on_data: false, renewable: true },
  priority: { stt: 1 },
};

test("parseProviders accepts the seed providers.json", () => {
  const seeds = JSON.parse(readFileSync(new URL("../../../providers.json", import.meta.url), "utf8"));
  assert.equal(parseProviders(seeds).length, seeds.length);
});

test("parseProviders accepts a minimal entry with optional fields", () => {
  const e = { ...good, keyEnv: "A_KEY", baseUrl: "https://x", models: { stt: "w" }, paid: false, env: { accountId: "A_ID" } };
  assert.deepEqual(parseProviders([e]), [e]);
});

test("parseProviders rejects a non-array", () => {
  assert.throws(() => parseProviders({}), /providers\.json: expected an array/);
});

test("parseProviders names the offending index and field", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /\[1\]: expected an object/],
    [{ ...good, id: "" }, /\[1\]\.id/],
    [{ ...good, capabilities: ["telepathy"] }, /\[1\]\.capabilities/],
    [{ ...good, kind: "magic" }, /\[1\]\.kind/],
    [{ ...good, model: 3 }, /\[1\]\.model/],
    [{ ...good, keyEnv: 3 }, /\[1\]\.keyEnv/],
    [{ ...good, limits: { rpm: "10" } }, /\[1\]\.limits\.rpm/],
    [{ ...good, reset: { tz: "Mars" } }, /\[1\]\.reset\.tz/],
    [{ ...good, flags: { commercial_ok: true } }, /\[1\]\.flags\.trains_on_data/],
    [{ ...good, priority: { stt: "1" } }, /\[1\]\.priority\.stt/],
    [{ ...good, env: { accountId: 1 } }, /\[1\]\.env\.accountId/],
    [{ ...good, models: { stt: 1 } }, /\[1\]\.models\.stt/],
  ];
  for (const [bad, re] of cases) assert.throws(() => parseProviders([good, bad]), re);
});
