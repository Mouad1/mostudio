import type { Capability, StepModule } from "../../core/src/index.ts";
import { KNOBS } from "./knobs.ts";
import type { Knob, ToolInfo, ToolParam, WorkflowInfo } from "./types.ts";

export type { Knob, ToolInfo, ToolParam } from "./types.ts";
export { KNOBS } from "./knobs.ts";

const STEP_TITLES: Record<string, string> = {
  ingest: "Import media",
  transcribe: "Transcribe speech",
  cut: "Remove silences and retakes",
  localize: "Darija / Arabizi subtitles",
  captions: "Captions",
  chapters: "YouTube chapters",
  mix: "Sound: loudness and music",
  assemble: "Render the video",
  qa: "Quality check",
};

const STEP_CAPABILITIES: Partial<Record<string, Capability>> = {
  transcribe: "stt",
  localize: "llm",
  chapters: "llm",
};

export function extractSummary(md: string): string {
  if (!md) return "";
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim().startsWith("#")) {
    i++;
  }
  if (i >= lines.length) return "";
  i++;
  while (i < lines.length && lines[i]!.trim() === "") {
    i++;
  }
  if (i >= lines.length) return "";
  const paraLines: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.trim().startsWith("#")) {
    paraLines.push(lines[i]!.trim());
    i++;
  }
  return paraLines.join(" ");
}

export function buildCatalog(
  steps: Record<string, StepModule>,
  workflows: WorkflowInfo[],
  readme: (step: string) => string,
): ToolInfo[] {
  const tools: ToolInfo[] = [];

  for (const [name, mod] of Object.entries(steps)) {
    const title = STEP_TITLES[name] ?? name;
    let md = "";
    try {
      md = readme(name);
    } catch {
      md = "";
    }
    const summary = extractSummary(md);
    const inputs = [...(mod.contract.inputs ?? [])];
    const outputs = [...(mod.contract.outputs ?? [])];
    const gate = [...(mod.contract.gate ?? [])];
    const matchingWorkflows = workflows
      .filter((wf) => wf.steps.some((s) => s.step === name))
      .map((wf) => wf.name);

    const params: ToolParam[] = [];
    const stepKnobs = KNOBS[name] ?? {};
    for (const [paramName, rawType] of Object.entries(mod.contract.params ?? {})) {
      const optional = rawType.endsWith("?");
      const type = (optional ? rawType.slice(0, -1) : rawType) as "string" | "number" | "boolean";
      const knob = stepKnobs[paramName] ?? { label: paramName, help: "" };
      params.push({
        name: paramName,
        type,
        optional,
        ...knob,
      });
    }

    const tool: ToolInfo = {
      name,
      title,
      summary,
      inputs,
      outputs,
      params,
      gate,
      workflows: matchingWorkflows,
    };

    const cap = STEP_CAPABILITIES[name];
    if (cap) {
      tool.capability = cap;
    }

    tools.push(tool);
  }

  return tools;
}
