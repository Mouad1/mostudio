import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "../../../core/src/index.ts";
import type { SetupState } from "../../src/types.ts";
import { checkRows, nextSetupStep } from "./setup.ts";

function state(partial: Partial<SetupState>): SetupState {
  return {
    needsSetup: true,
    workspace: null,
    suggestedWorkspace: "/Users/test/Movies/mostudio",
    checks: [],
    hasAiKey: false,
    packaged: false,
    version: "0.0.0",
    ...partial,
  };
}

function chk(
  name: string,
  ok: boolean,
  required: boolean,
  detail = "",
  fix?: string
): Check {
  return {
    name: name as any,
    label: name,
    ok,
    required,
    detail,
    fix,
  };
}

test("nextSetupStep", () => {
  assert.equal(nextSetupStep(state({ workspace: null })), "folder");
  assert.equal(
    nextSetupStep(
      state({ workspace: "/w", checks: [chk("ffmpeg", false, true)] })
    ),
    "check"
  );
  assert.equal(
    nextSetupStep(state({ workspace: "/w", hasAiKey: false })),
    "key"
  );
  assert.equal(
    nextSetupStep(state({ workspace: "/w", hasAiKey: true })),
    "done"
  );
  assert.equal(
    nextSetupStep(
      state({
        workspace: "/w",
        hasAiKey: true,
        checks: [chk("whisper", false, false)],
      })
    ),
    "done"
  );
});

test("checkRows", () => {
  assert.equal(
    checkRows([
      chk(
        "whisper",
        false,
        false,
        "not installed",
        "Optional. Cloud transcription works without it."
      ),
    ])[0]!.text,
    "not installed. Optional. Cloud transcription works without it."
  );

  const okRow = checkRows([chk("node", true, true, "v22.18.0")])[0]!;
  assert.equal(okRow.text, "Ready");
  assert.equal(okRow.ok, true);
  assert.equal(okRow.required, true);
  assert.equal(okRow.label, "node");

  const noFixRow = checkRows([chk("node", false, true, "Node version too old")])[0]!;
  assert.equal(noFixRow.text, "Node version too old.");
});
