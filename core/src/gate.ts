import type { Metrics, MetricValue, StepStatus, Threshold, Verdict } from "./types.ts";

function check(actual: MetricValue | undefined, t: Threshold): boolean {
  if (actual === undefined) return false;
  if (t.op === "==") return actual === t.value;
  if (typeof actual !== "number") return false;
  if (t.op === "between") {
    if (!Array.isArray(t.value) || t.value.length !== 2) return false;
    const [min, max] = t.value;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    if (typeof min !== "number" || typeof max !== "number") return false;
    return actual >= min && actual <= max;
  }
  if (typeof t.value !== "number" || !Number.isFinite(t.value)) return false;
  switch (t.op) {
    case "<":
      return actual < t.value;
    case "<=":
      return actual <= t.value;
    case ">":
      return actual > t.value;
    case ">=":
      return actual >= t.value;
    default:
      return false;
  }
}

export function evaluateGate(
  metrics: Metrics,
  thresholds: Threshold[],
): { status: StepStatus; verdicts: Verdict[] } {
  const verdicts: Verdict[] = thresholds.map((threshold) => {
    if (typeof threshold !== "object" || threshold === null || Array.isArray(threshold)) {
      return { metric: "<invalid>", actual: undefined, threshold, ok: false };
    }
    const actual = metrics[threshold.metric];
    return { metric: threshold.metric, actual, threshold, ok: check(actual, threshold) };
  });
  const failed = verdicts.filter((v) => !v.ok);
  const status: StepStatus = failed.some((v) => v.threshold?.level !== "warn")
    ? "fail"
    : failed.length > 0
      ? "warn"
      : "pass";
  return { status, verdicts };
}

const isObject = (t: unknown): t is Threshold => typeof t === "object" && t !== null && !Array.isArray(t);

/** Overrides replace base entries with the same metric+level. Malformed entries never match and pass through for evaluateGate to report. */
export function mergeThresholds(base: Threshold[], overrides: Threshold[]): Threshold[] {
  const same = (a: Threshold, b: Threshold) =>
    isObject(a) && isObject(b) && a.metric === b.metric && a.level === b.level;
  const used = new Set<Threshold>();
  const merged = base.map((b) => {
    const o = overrides.find((x) => same(x, b));
    if (!o) return b;
    used.add(o);
    return o;
  });
  return [...merged, ...overrides.filter((o) => !used.has(o))];
}
