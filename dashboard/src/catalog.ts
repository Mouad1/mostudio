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

/**
 * What each tool does, in plain words for the Tools page. The step READMEs are developer docs
 * (file paths, core function names, spec references), so they are only a fallback.
 */
const STEP_SUMMARIES: Record<string, string> = {
  ingest: "Brings your video or audio file into the project and checks it has sound. Your original file is never changed.",
  transcribe: "Writes down every spoken word with its timing, using free speech-to-text services that don't train on your audio.",
  cut: "Removes silences, filler words like \"euh\" and earlier retakes, keeping your last take. Choose a natural or tight pace.",
  localize: "Makes the subtitle lines in your audience's language: the words as spoken, Darija in Latin letters (Arabizi), French or English.",
  captions: "Times the captions on the edited video and applies your word fixes. You can review them before the video is made.",
  chapters: "Suggests YouTube chapters with short titles from what you say.",
  mix: "Builds the voice track for the edited video, can add background music under your voice, and evens out the loudness.",
  assemble: "Renders the final video at the size you chose (YouTube, Shorts, Reels or TikTok) with the captions and sound.",
  qa: "Checks the finished video (black or silent start, loudness) and writes a short report with a contact sheet for you to score.",
};

/** A README paragraph as plain text: bold, italics, inline code and links become their words. */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

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
    let summary = STEP_SUMMARIES[name];
    if (summary === undefined) {
      let md = "";
      try {
        md = readme(name);
      } catch {
        md = "";
      }
      summary = plainText(extractSummary(md));
    }
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
