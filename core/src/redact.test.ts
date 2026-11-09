import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor } from "./redact.ts";

test("createRedactor masks secret-named env values of 6+ chars", () => {
  const r = createRedactor([{ A_KEY: "abcdef", SHORT_TOKEN: "abc", PLAIN: "visible-value" }, undefined, { DB_PASSWORD: "pw-123456" }]);
  assert.equal(r.redact("abcdef abc visible-value pw-123456"), "[redacted] abc visible-value [redacted]");
});

test("createRedactor accepts extra values and later additions", () => {
  const r = createRedactor([], ["extra-secret"]);
  r.add("added-later");
  r.add("tiny");
  assert.equal(r.redact("extra-secret added-later tiny"), "[redacted] [redacted] tiny");
});
