import assert from "node:assert/strict";
import { test } from "node:test";
import { isMac, revealLabel } from "./platform.ts";

test("Finder is named only on macOS (QA p2)", () => {
  assert.equal(revealLabel({ platform: "MacIntel" }), "Show in Finder");
  assert.equal(revealLabel({ userAgentData: { platform: "macOS" } }), "Show in Finder");
  assert.equal(revealLabel({ platform: "Linux x86_64" }), "Show in folder");
  assert.equal(revealLabel({ userAgentData: { platform: "Windows" }, platform: "Win32" }), "Show in folder");
  assert.equal(isMac({}), false);
});
