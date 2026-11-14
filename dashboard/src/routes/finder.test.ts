import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { startTestDashboard } from "../testkit.ts";

test("show-in-finder refuses paths outside the workspace", async () => {
  const opened: Array<{ path: string; reveal: boolean }> = [];
  const d = await startTestDashboard({
    openPath: async (p, reveal) => {
      opened.push({ path: p, reveal });
    },
  });
  try {
    // 1. Outside workspace
    const r1 = await d.api("/api/show-in-finder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc" }),
    });
    assert.equal(r1.status, 400);
    assert.equal(opened.length, 0);

    // 2. Inside workspace (file)
    const testFile = join(d.ws, "workflows", "t.json");
    const r2 = await d.api("/api/show-in-finder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: testFile }),
    });
    assert.equal(r2.status, 200);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].path, testFile);
    assert.equal(opened[0].reveal, true);

    // 3. Inside workspace (directory)
    const testDir = join(d.ws, "workflows");
    const r3 = await d.api("/api/show-in-finder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: testDir }),
    });
    assert.equal(r3.status, 200);
    assert.equal(opened.length, 2);
    assert.equal(opened[1].path, testDir);
    assert.equal(opened[1].reveal, false);
  } finally {
    await d.close();
  }
});
