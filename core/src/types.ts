export type StepStatus = "pass" | "warn" | "fail";
export type MetricValue = number | string | boolean;
export type Metrics = Record<string, MetricValue>;
export type GateLevel = "warn" | "fail";

export type Threshold = {
  metric: string;
  op: "<" | "<=" | ">" | ">=" | "==" | "between";
  value: number | [number, number] | string | boolean;
  level: GateLevel;
};

export type Verdict = {
  metric: string;
  actual: MetricValue | undefined;
  threshold: Threshold;
  ok: boolean;
};

export type StepResult = {
  step: string;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputsHash: string;
  metrics: Metrics;
  verdicts: Verdict[];
  artifacts: string[];
  provider?: { id: string; model: string };
  quota?: Record<string, number>;
  error?: string;
};
