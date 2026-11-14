import type { ProjectStatus, RunEvent, RunMode, StepView, WorkflowInfo } from "../../src/types.ts";

export type StepState =
  | "idle"
  | "running"
  | "pass"
  | "warn"
  | "fail"
  | "cached"
  | "awaiting"
  | "interrupted"
  | "cancelled";

export type StepCard = {
  step: string;
  approve: boolean;
  state: StepState;
  startedAt?: number;
  durationMs?: number;
  result?: StepView;
  logs: string[];
  autoApproved?: boolean;
};

export type PipelineState = {
  workflow?: string;
  mode: RunMode;
  running: boolean;
  cards: StepCard[];
  lastEventId: number;
  error?: string;
  outcome?: "done" | "failed" | "awaiting-approval" | "cancelled";
};

export const STEP_LABELS: Record<string, string> = {
  ingest: "Import",
  transcribe: "Transcribe",
  cut: "Cut silences",
  localize: "Subtitles",
  captions: "Captions",
  chapters: "Chapters",
  mix: "Sound",
  assemble: "Render",
  qa: "Check",
};

export const MAX_LOG_LINES = 400;

function computeInitialState(step: string, status: ProjectStatus, res?: StepView): StepState {
  if (status.interrupted?.includes(step)) {
    return "interrupted";
  }
  if (status.pending?.includes(step) || res?.awaitingApproval) {
    return "awaiting";
  }
  if (res) {
    if (res.cached && res.status !== "fail") {
      return "cached";
    }
    return res.status;
  }
  return "idle";
}

export function initialState(wf: WorkflowInfo, status: ProjectStatus): PipelineState {
  const cards: StepCard[] = [];
  const seen = new Set<string>();

  for (const s of wf.steps ?? []) {
    seen.add(s.step);
    const res = status.steps?.[s.step];
    cards.push({
      step: s.step,
      approve: s.approve,
      state: computeInitialState(s.step, status, res),
      startedAt: res?.startedAt ? Date.parse(res.startedAt) : undefined,
      durationMs: res?.durationMs,
      result: res,
      logs: [],
    });
  }

  if (status.steps) {
    for (const [stepName, res] of Object.entries(status.steps)) {
      if (!seen.has(stepName)) {
        seen.add(stepName);
        cards.push({
          step: stepName,
          approve: false,
          state: computeInitialState(stepName, status, res),
          startedAt: res?.startedAt ? Date.parse(res.startedAt) : undefined,
          durationMs: res?.durationMs,
          result: res,
          logs: [],
        });
      }
    }
  }

  return {
    workflow: wf.name || status.workflow || undefined,
    mode: "manual",
    running: Boolean(status.running),
    cards,
    lastEventId: 0,
    outcome: undefined,
    error: undefined,
  };
}

export function applyEvent(s: PipelineState, e: RunEvent): PipelineState {
  if (e.id <= s.lastEventId) {
    return s;
  }

  const base: PipelineState = {
    ...s,
    lastEventId: e.id,
  };

  switch (e.type) {
    case "run-start": {
      return {
        ...base,
        running: true,
        mode: e.mode,
        outcome: undefined,
        error: undefined,
        workflow: e.kind === "workflow" ? e.name : base.workflow,
      };
    }

    case "step-start": {
      const cardIndex = base.cards.findIndex((c) => c.step === e.step);
      const startedAt = Date.parse(e.at);
      let nextCards: StepCard[];

      if (cardIndex >= 0) {
        nextCards = base.cards.map((c, i) =>
          i === cardIndex
            ? {
                ...c,
                state: "running",
                startedAt,
                logs: [],
                durationMs: undefined,
                autoApproved: undefined,
              }
            : c
        );
      } else {
        const newCard: StepCard = {
          step: e.step,
          approve: false,
          state: "running",
          startedAt,
          logs: [],
          durationMs: undefined,
        };
        nextCards = [...base.cards, newCard];
      }

      return {
        ...base,
        running: true,
        cards: nextCards,
      };
    }

    case "log": {
      let targetIndex = -1;
      if (e.step) {
        targetIndex = base.cards.findIndex((c) => c.step === e.step);
      }
      if (targetIndex < 0) {
        targetIndex = base.cards.findIndex((c) => c.state === "running");
      }
      if (targetIndex < 0) {
        return base;
      }

      const target = base.cards[targetIndex]!;
      const nextLogs = [...target.logs, e.message];
      if (nextLogs.length > MAX_LOG_LINES) {
        nextLogs.splice(0, nextLogs.length - MAX_LOG_LINES);
      }

      const nextCards = base.cards.map((c, i) =>
        i === targetIndex
          ? {
              ...c,
              logs: nextLogs,
            }
          : c
      );

      return {
        ...base,
        cards: nextCards,
      };
    }

    case "step-end": {
      const stepName = e.result.step;
      const cardIndex = base.cards.findIndex((c) => c.step === stepName);

      let state: StepState;
      if (e.result.error === "cancelled by user") {
        state = "cancelled";
      } else if (e.result.cached && e.result.status !== "fail") {
        state = "cached";
      } else {
        state = e.result.status;
      }

      let nextCards: StepCard[];
      if (cardIndex >= 0) {
        nextCards = base.cards.map((c, i) =>
          i === cardIndex
            ? {
                ...c,
                state,
                durationMs: e.result.durationMs,
                result: e.result,
              }
            : c
        );
      } else {
        const newCard: StepCard = {
          step: stepName,
          approve: false,
          state,
          durationMs: e.result.durationMs,
          result: e.result,
          logs: [],
        };
        nextCards = [...base.cards, newCard];
      }

      return {
        ...base,
        cards: nextCards,
      };
    }

    case "approved": {
      const cardIndex = base.cards.findIndex((c) => c.step === e.step);
      if (cardIndex < 0) {
        return base;
      }

      const nextCards = base.cards.map((c, i) =>
        i === cardIndex
          ? {
              ...c,
              autoApproved: e.auto,
              state: (c.result?.status ?? "pass") as StepState,
            }
          : c
      );

      return {
        ...base,
        cards: nextCards,
      };
    }

    case "run-end": {
      let nextCards = base.cards;
      if (e.status === "awaiting-approval" && e.stoppedAt) {
        const cardIndex = base.cards.findIndex((c) => c.step === e.stoppedAt);
        if (cardIndex >= 0) {
          nextCards = base.cards.map((c, i) =>
            i === cardIndex
              ? {
                  ...c,
                  state: "awaiting",
                }
              : c
          );
        }
      }

      return {
        ...base,
        running: false,
        outcome: e.status,
        cards: nextCards,
        error: e.status === "failed" ? e.error : base.error,
      };
    }

    default:
      return base;
  }
}

export function elapsed(card: StepCard, now: number = Date.now()): string {
  const ms =
    card.durationMs ??
    (card.startedAt !== undefined ? Math.max(0, now - card.startedAt) : undefined);
  if (ms === undefined) {
    return "";
  }
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
