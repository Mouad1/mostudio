import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStatus, ToolInfo, ToolParam } from "../../src/types.ts";
import { formToParams, missingSteps } from "./tools.ts";

function p(
  name: string,
  type: "string" | "number" | "boolean",
  optional: boolean,
  label: string
): ToolParam {
  return {
    name,
    type,
    optional,
    label,
    help: "",
  };
}

function status(
  stepStatuses: Record<string, "pass" | "warn" | "fail">
): ProjectStatus {
  const steps: Record<string, any> = {};
  for (const [s, st] of Object.entries(stepStatuses)) {
    steps[s] = { step: s, status: st };
  }
  return {
    id: "proj-1",
    dir: "/tmp/proj-1",
    steps,
    pending: [],
    running: false,
    interrupted: [],
    uploads: [],
  };
}

test("formToParams parses numbers, drops empty optional, and sets booleans", () => {
  const ps = [
    p("pace", "string", true, "Pace"),
    p("maxGap", "number", true, "Max gap"),
    p("retakes", "boolean", true, "Retakes"),
  ];
  assert.deepEqual(
    formToParams(ps, { pace: "tight", maxGap: "0.3", retakes: false }),
    { pace: "tight", maxGap: 0.3, retakes: false }
  );
  assert.deepEqual(formToParams(ps, { pace: "", maxGap: "" }), {});
  assert.throws(
    () => formToParams(ps, { maxGap: "abc" }),
    /Max gap must be a number/
  );
});

test("formToParams handles required params and boolean true", () => {
  const ps = [
    p("requiredText", "string", false, "Required Text"),
    p("requiredNum", "number", false, "Required Num"),
    p("burnCaptions", "boolean", true, "Burn Captions"),
  ];
  assert.deepEqual(
    formToParams(ps, { requiredText: "hello", requiredNum: "42", burnCaptions: true }),
    { requiredText: "hello", requiredNum: 42, burnCaptions: true }
  );
  assert.throws(
    () => formToParams(ps, { requiredText: "hello", requiredNum: "" }),
    /Required Num must be a number/
  );
});

test("missingSteps names what to run first", async () => {
  const { buildCatalog } = await import("../../src/catalog.ts");
  const { defaultSteps } = await import("../../../steps/index.ts");
  const catalog = buildCatalog(defaultSteps, [], () => "");
  const captions = catalog.find((t) => t.name === "captions")!;
  assert.deepEqual(
    missingSteps(captions, status({ ingest: "pass", transcribe: "pass" }), catalog),
    ["cut", "localize"]
  );
});

test("missingSteps returns empty array when all prerequisites pass or warn", async () => {
  const { buildCatalog } = await import("../../src/catalog.ts");
  const { defaultSteps } = await import("../../../steps/index.ts");
  const catalog = buildCatalog(defaultSteps, [], () => "");
  const captions = catalog.find((t) => t.name === "captions")!;
  assert.deepEqual(
    missingSteps(
      captions,
      status({ ingest: "pass", transcribe: "warn", cut: "pass", localize: "warn" }),
      catalog
    ),
    []
  );
});

test("missingSteps includes failed steps as missing", async () => {
  const { buildCatalog } = await import("../../src/catalog.ts");
  const { defaultSteps } = await import("../../../steps/index.ts");
  const catalog = buildCatalog(defaultSteps, [], () => "");
  const captions = catalog.find((t) => t.name === "captions")!;
  assert.deepEqual(
    missingSteps(
      captions,
      status({ ingest: "pass", transcribe: "fail", cut: "pass", localize: "pass" }),
      catalog
    ),
    ["transcribe"]
  );
});
