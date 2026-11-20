import type { RunMode, RunRequest } from "../../src/types.ts";
import type { PipelineState } from "./pipeline.ts";

/** What the speaker talks. "darija" keeps Moroccan Darija as spoken instead of formal Arabic. */
export type SpokenLanguage = "darija" | "auto";

/**
 * The Spoken language a run starts with: Darija when the subtitles are Arabizi (chosen now, or
 * remembered by the project), otherwise what the project ran with last time, otherwise Auto.
 */
export function defaultSpokenLanguage(
  subtitleLang: string,
  remembered: Record<string, Record<string, unknown>> | undefined
): SpokenLanguage {
  const lang = subtitleLang || remembered?.localize?.lang;
  if (lang === "arabizi") return "darija";
  if (remembered?.transcribe?.dialect === "darija") return "darija";
  return "auto";
}

export function buildRunRequest(o: {
  workflow: string;
  mode: RunMode;
  source?: string;
  /** Unset (undefined) values are left out; "" is sent so the server forgets a remembered value. */
  params: Record<string, Record<string, string | undefined>>;
  /** Sent as transcribe.dialect: "darija", or "" for Auto so a remembered dialect is forgotten. */
  spoken?: SpokenLanguage;
}): RunRequest {
  const cleanParams: Record<string, Record<string, string>> = {};
  for (const [step, stepParams] of Object.entries(o.params || {})) {
    const cleanedStep: Record<string, string> = {};
    for (const [key, val] of Object.entries(stepParams || {})) {
      if (val !== undefined && val !== null) {
        cleanedStep[key] = val;
      }
    }
    if (Object.keys(cleanedStep).length > 0) {
      cleanParams[step] = cleanedStep;
    }
  }
  if (o.spoken) {
    cleanParams.transcribe = { ...cleanParams.transcribe, dialect: o.spoken === "darija" ? "darija" : "" };
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
): "start" | "stop" | "continue" | "retry" | "start-over" | "none" {
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
  // Re-running the same workflow picks up at the failed step: finished steps are reused.
  if (
    s.outcome === "failed" ||
    s.outcome === "cancelled" ||
    s.cards?.some((c) => c.state === "fail" || c.state === "interrupted" || c.state === "cancelled")
  ) {
    return "retry";
  }
  if (!hasSource) {
    return "none";
  }
  return "start";
}
