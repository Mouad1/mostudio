import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSteps } from "../../steps/index.ts";
import { buildCatalog } from "./catalog.ts";
import { KNOBS } from "./knobs.ts";
import { startTestDashboard } from "./testkit.ts";
import type { ToolInfo } from "./types.ts";

test("every contract param has a knob and every knob names a real param", () => {
  for (const [name, mod] of Object.entries(defaultSteps)) {
    assert.deepEqual(Object.keys(KNOBS[name] ?? {}).sort(), Object.keys(mod.contract.params ?? {}).sort(), name);
  }
});

test("catalog joins README summary, workflows and choices", () => {
  const cat = buildCatalog(
    defaultSteps,
    [{ name: "short", title: "Short", steps: [{ step: "cut", approve: false }] }],
    (s) => `# ${s}\n\nDoes ${s}.\n\nMore.`,
  );
  const cut = cat.find((t) => t.name === "cut")!;
  assert.deepEqual([cut.title, cut.summary, cut.workflows], ["Remove silences and retakes", "Does cut.", ["short"]]);
  assert.deepEqual(cut.params.find((p) => p.name === "pace")!.choices!.map((c) => c.value), ["natural", "tight"]);
});

test("catalog handles missing readme or headers gracefully", () => {
  const cat = buildCatalog(defaultSteps, [], () => "");
  for (const tool of cat) {
    assert.equal(tool.summary, "");
    assert.deepEqual(tool.workflows, []);
  }
});

test("catalog maps capabilities correctly", () => {
  const cat = buildCatalog(defaultSteps, [], () => "");
  assert.equal(cat.find((t) => t.name === "transcribe")!.capability, "stt");
  assert.equal(cat.find((t) => t.name === "localize")!.capability, "llm");
  assert.equal(cat.find((t) => t.name === "chapters")!.capability, "llm");
  assert.equal(cat.find((t) => t.name === "cut")!.capability, undefined);
});

test("GET /api/tools returns 200 with tools array", async () => {
  const d = await startTestDashboard();
  const res = await d.api("/api/tools");
  assert.equal(res.status, 200);
  const data = (await res.json()) as { tools: ToolInfo[] };
  assert.ok(Array.isArray(data.tools));
  assert.equal(data.tools.length, Object.keys(defaultSteps).length);
  const names = data.tools.map((t) => t.name);
  assert.deepEqual(names, Object.keys(defaultSteps));
  const transcribe = data.tools.find((t) => t.name === "transcribe")!;
  assert.equal(transcribe.capability, "stt");
  assert.equal(transcribe.title, "Transcribe speech");
  assert.ok(transcribe.summary.length > 0);
  await d.close();
});
