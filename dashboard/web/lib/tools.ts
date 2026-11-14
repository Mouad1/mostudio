import type { ProjectStatus, ToolInfo, ToolParam } from "../../src/types.ts";

export const PROVIDERS_BY_CAPABILITY: Record<string, string[]> = {
  stt: ["groq", "cloudflare", "whisper-cpp"],
  llm: ["gemini", "groq", "openrouter", "mistral", "zai", "nvidia"],
  vision: ["gemini", "zai"],
  tts: ["gemini"],
  image: ["gemini", "cloudflare"],
  stock: ["pexels", "pixabay"],
};

export function formToParams(
  params: ToolParam[],
  values: Record<string, string | boolean | undefined | null>
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const param of params) {
    const val = values[param.name];

    if (val === "" || val === undefined || val === null) {
      if (param.optional) {
        continue;
      }
    }

    if (param.type === "number") {
      const num = Number(val);
      if (val === "" || val === undefined || val === null || Number.isNaN(num)) {
        throw new Error(`${param.label} must be a number`);
      }
      result[param.name] = num;
    } else if (param.type === "boolean") {
      result[param.name] = Boolean(val);
    } else if (param.type === "string") {
      result[param.name] = String(val ?? "");
    }
  }

  return result;
}

export function missingSteps(
  tool: ToolInfo,
  status: ProjectStatus,
  catalog: ToolInfo[]
): string[] {
  const missing = new Set<string>();

  for (const input of tool.inputs || []) {
    if (input.startsWith("edits/")) {
      continue;
    }

    const producingStep = catalog.find((step) => step.outputs.includes(input));
    if (producingStep) {
      const stepResult = status.steps?.[producingStep.name];
      const isPassingOrWarn =
        stepResult && (stepResult.status === "pass" || stepResult.status === "warn");
      if (!isPassingOrWarn) {
        missing.add(producingStep.name);
      }
    }
  }

  return catalog
    .map((step) => step.name)
    .filter((stepName) => missing.has(stepName));
}
