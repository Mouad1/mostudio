import type { Capability, Check, StepResult, Threshold } from "../../core/src/index.ts";

export type RunMode = "manual" | "auto";

export type StepView = StepResult & {
  cached?: boolean;
  awaitingApproval?: true;
};

export type RunEventBody =
  | { type: "run-start"; kind: "workflow" | "step"; name: string; mode: RunMode }
  | { type: "step-start"; step: string }
  | { type: "log"; step?: string; message: string }
  | { type: "step-end"; result: StepView }
  | { type: "approved"; step: string; auto: boolean }
  | { type: "run-end"; status: "done" | "failed" | "awaiting-approval" | "cancelled"; stoppedAt?: string; error?: string };

export type RunEvent = RunEventBody & { id: number; at: string };

export type Emit = (e: RunEventBody) => void;

export type ProjectSummary = {
  id: string;
  workflow?: string;
  lastStatus: "new" | "running" | "done" | "failed" | "awaiting-approval" | "interrupted";
};

export type ProjectStatus = {
  id: string;
  dir: string;
  workflow?: string;
  steps: Record<string, StepView>;
  pending: string[];
  running: boolean;
  interrupted: string[];
  uploads: string[];
  media?: { file: string; durationSec: number; width: number; height: number };
};

export type WorkflowInfo = {
  name: string;
  title: string;
  steps: { step: string; approve: boolean }[];
};

export const PROJECT_ID_RE: RegExp = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Knob = {
  label: string;
  help: string;
  choices?: { value: string; label: string }[];
  input?: "text" | "textarea" | "number" | "toggle" | "file" | "provider";
  advanced?: boolean;
};

export type ToolParam = {
  name: string;
  type: "string" | "number" | "boolean";
  optional: boolean;
} & Knob;

export type ToolInfo = {
  name: string;
  title: string;
  summary: string;
  inputs: string[];
  outputs: string[];
  params: ToolParam[];
  gate: Threshold[];
  workflows: string[];
  capability?: Capability;
};

export type SettingField = {
  name: string;
  kind: "secret" | "text" | "path";
  providers: string[];
  label: string;
  help: string;
  getKeyUrl?: string;
  recommended?: boolean;
  source: "app" | "workspace" | "process" | "unset";
  masked: string;
};

export type ProbeResult = {
  provider: string;
  ok: boolean;
  status?: number;
  message: string;
  ms: number;
};

export type SetupState = {
  needsSetup: boolean;
  workspace: string | null;
  suggestedWorkspace: string;
  checks: Check[];
  hasAiKey: boolean;
  packaged: boolean;
  version: string;
};

export type InspirationKind = "shorts" | "long";

export type InspirationLink = {
  url: string;
  note?: string;
  platform: "youtube" | "instagram" | "tiktok" | "x" | "facebook" | "other";
};

export type InspirationFile = {
  name: string;
  path: string;
  sizeBytes: number;
  kind: "media" | "note";
};

export type InspirationShelf = {
  kind: InspirationKind;
  folder: string;
  links: InspirationLink[];
  files: InspirationFile[];
};

export type RunRequest = {
  workflow: string;
  mode: RunMode;
  source?: string;
  params?: Record<string, Record<string, string | number | boolean>>;
  force?: string[];
};

export type StepRequest = {
  params?: Record<string, string | number | boolean>;
  force?: boolean;
};

export type ApproveRequest = {
  step: string;
  continue?: boolean;
  mode?: RunMode;
};
