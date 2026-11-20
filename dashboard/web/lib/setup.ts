import type { Check } from "../../../core/src/index.ts";
import type { SetupState } from "../../src/types.ts";

export type SetupStepId = "folder" | "check" | "key" | "done";

export function nextSetupStep(s: SetupState): SetupStepId {
  if (!s.workspace) {
    return "folder";
  }
  if (s.checks?.some((c) => c.required && !c.ok)) {
    return "check";
  }
  if (!s.hasAiKey) {
    return "key";
  }
  return "done";
}

export function checkRows(
  checks: Check[]
): { label: string; ok: boolean; required: boolean; text: string }[] {
  return (checks ?? []).map((c) => ({
    label: c.label,
    ok: c.ok,
    required: c.required,
    text: c.ok ? "Ready" : `${c.detail}. ${c.fix ?? ""}`.trim(),
  }));
}
