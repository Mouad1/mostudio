import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readJson, writeJsonAtomic } from "../fs/atomic.ts";

export type Tz = "America/Los_Angeles" | "UTC";

export type ProviderQuota = {
  day: { count: number; resetAt: string };
  minute: number[];
  exhaustedUntil?: string;
};
export type QuotaStore = Record<string, ProviderQuota>;

const MINUTE = 60_000;

function localParts(tz: Tz, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of tz from UTC at the given instant: local wall time as UTC minus the instant. */
function offsetMs(tz: Tz, at: Date): number {
  const p = localParts(tz, at);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Next local midnight in tz strictly after `now`, as a UTC Date. DST-safe. */
export function nextReset(tz: Tz, now: Date): Date {
  const p = localParts(tz, now);
  const wallMidnight = Date.UTC(p.y, p.mo - 1, p.d + 1, 0, 0, 0);
  let guess = wallMidnight - offsetMs(tz, now);
  // The offset may differ at the target instant (DST change); refine until stable.
  for (let i = 0; i < 3; i++) {
    const next = wallMidnight - offsetMs(tz, new Date(guess));
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export async function loadStore(path: string): Promise<QuotaStore> {
  return (await readJson<QuotaStore>(path)) ?? {};
}

export async function saveStore(path: string, store: QuotaStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, store);
}

/** Current quota state for a provider with day rollover and minute pruning applied. */
export function currentQuota(
  store: QuotaStore,
  id: string,
  tz: Tz,
  now: Date,
): ProviderQuota {
  const q = store[id];
  const t = now.getTime();
  if (!q) return { day: { count: 0, resetAt: nextReset(tz, now).toISOString() }, minute: [] };
  const rolled = t >= Date.parse(q.day.resetAt);
  const out: ProviderQuota = {
    day: rolled ? { count: 0, resetAt: nextReset(tz, now).toISOString() } : { ...q.day },
    minute: q.minute.filter((m) => m > t - MINUTE),
  };
  if (q.exhaustedUntil && Date.parse(q.exhaustedUntil) > t) out.exhaustedUntil = q.exhaustedUntil;
  return out;
}
