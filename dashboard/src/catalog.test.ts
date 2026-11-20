import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSteps } from "../../steps/index.ts";
import { buildCatalog } from "./catalog.ts";
import { KNOBS } from "./knobs.ts";
import { startTestDashboard } from "./testkit.ts";
import type { ToolInfo } from "./types.ts";

const STEPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "steps");

test("every contract param has a knob and every knob names a real param", () => {
  for (const [name, mod] of Object.entries(defaultSteps)) {
    assert.deepEqual(Object.keys(KNOBS[name] ?? {}).sort(), Object.keys(mod.contract.params ?? {}).sort(), name);
  }
});

test("catalog joins plain descriptions, workflows and choices", () => {
  const cat = buildCatalog(
    defaultSteps,
    [{ name: "short", title: "Short", steps: [{ step: "cut", approve: false }] }],
    (s) => `# ${s}\n\nDoes **${s}** via \`withProvider\`.\n\nMore.`,
  );
  const cut = cat.find((t) => t.name === "cut")!;
  assert.deepEqual([cut.title, cut.workflows], ["Remove silences and retakes", ["short"]]);
  assert.match(cut.summary, /silences/);
  assert.deepEqual(cut.params.find((p) => p.name === "pace")!.choices!.map((c) => c.value), ["natural", "tight"]);
});

test("built-in tools describe themselves in plain words, not developer docs", () => {
  // The real READMEs, as GET /api/tools reads them.
  const cat = buildCatalog(defaultSteps, [], (s) => readFileSync(join(STEPS_DIR, s, "README.md"), "utf8"));
  for (const tool of cat) {
    assert.ok(tool.summary.length > 0, tool.name);
    assert.doesNotMatch(tool.summary, /[`*_#\[\]]/, `${tool.name}: no markdown`);
    assert.doesNotMatch(tool.summary, /withProvider|spec G\d|\.json|ffprobe|EDL|edit decision/i, `${tool.name}: no jargon`);
  }
});

test("a step without a built-in description falls back to its README summary as plain text", () => {
  const custom = { custom: { contract: { params: {} } } } as unknown as typeof defaultSteps;
  const [tool] = buildCatalog(custom, [], () => "# custom\n\nMakes a **bold** move with `code` and [a link](https://x.y).\n");
  assert.equal(tool!.summary, "Makes a bold move with code and a link.");
  assert.equal(buildCatalog(custom, [], () => "")[0]!.summary, "");
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
