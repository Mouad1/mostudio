import type { RunMode, RunRequest } from "../../src/types.ts";
import type { PipelineState } from "./pipeline.ts";

export function buildRunRequest(o: {
  workflow: string;
  mode: RunMode;
  source?: string;
  params: Record<string, Record<string, string>>;
}): RunRequest {
  const cleanParams: Record<string, Record<string, string>> = {};
  for (const [step, stepParams] of Object.entries(o.params || {})) {
    const cleanedStep: Record<string, string> = {};
    for (const [key, val] of Object.entries(stepParams || {})) {
      if (val !== undefined && val !== null && val !== "") {
        cleanedStep[key] = val;
      }
    }
    if (Object.keys(cleanedStep).length > 0) {
      cleanParams[step] = cleanedStep;
    }
  }

  const req: RunRequest = {
    workflow: o.workflow,
    mode: o.mode,
    ...(o.source ? { source: o.source } : {}),
    ...(Object.keys(cleanParams).length > 0 ? { params: cleanParams } : {}),
  };
  return req;
}

export function modeCopy(mode: RunMode): { title: string; help: string } {
  if (mode === "manual") {
    return {
      title: "Review before finishing",
      help: "mostudio pauses at the captions so you can fix words before the video is rendered.",
    };
  }
  return {
    title: "Do it all for me",
    help: "mostudio makes the whole video without pausing. If a step fails its quality check, it still stops and tells you why.",
  };
}

export function primaryAction(
  s: PipelineState,
  hasSource: boolean
): "start" | "stop" | "continue" | "start-over" | "none" {
  if (s.running) {
    return "stop";
  }
  if (
    s.outcome === "awaiting-approval" ||
    (!s.running && s.cards?.some((c) => c.state === "awaiting"))
  ) {
    return "continue";
  }
  if (s.outcome === "done") {
    return "start-over";
  }
  if (!hasSource) {
    return "none";
  }
  return "start";
}
