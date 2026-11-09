import type { Metrics, MetricValue, StepStatus, Threshold, Verdict } from "./types.ts";

function check(actual: MetricValue | undefined, t: Threshold): boolean {
  if (actual === undefined) return false;
  if (t.op === "==") return actual === t.value;
  if (typeof actual !== "number") return false;
  if (t.op === "between") {
    if (!Array.isArray(t.value)) return false;
    const [min, max] = t.value;
    return actual >= min && actual <= max;
  }
  if (typeof t.value !== "number") return false;
  switch (t.op) {
    case "<":
      return actual < t.value;
    case "<=":
      return actual <= t.value;
    case ">":
      return actual > t.value;
    case ">=":
      return actual >= t.value;
  }
}

export function evaluateGate(
  metrics: Metrics,
  thresholds: Threshold[],
): { status: StepStatus; verdicts: Verdict[] } {
  const verdicts: Verdict[] = thresholds.map((threshold) => {
    const actual = metrics[threshold.metric];
    return { metric: threshold.metric, actual, threshold, ok: check(actual, threshold) };
  });
  const failed = verdicts.filter((v) => !v.ok);
  const status: StepStatus = failed.some((v) => v.threshold.level === "fail")
    ? "fail"
    : failed.length > 0
      ? "warn"
      : "pass";
  return { status, verdicts };
}

export function mergeThresholds(base: Threshold[], overrides: Threshold[]): Threshold[] {
  const same = (a: Threshold, b: Threshold) => a.metric === b.metric && a.level === b.level;
  const used = new Set<Threshold>();
  const merged = base.map((b) => {
    const o = overrides.find((x) => same(x, b));
    if (!o) return b;
    used.add(o);
    return o;
  });
  const appended: Threshold[] = [];
  for (const o of overrides) {
    if (used.has(o)) continue;
    const i = appended.findIndex((x) => same(x, o));
    if (i >= 0) appended[i] = o;
    else appended.push(o);
  }
  return [...merged, ...appended];
}
