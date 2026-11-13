import { CancelledError, currentSignal } from "../proc.ts";
import { NoProviderError } from "./registry.ts";
import type { Capability, PickedProvider, ProviderRegistry } from "./registry.ts";

export class ProviderHttpError extends Error {
  status: number;
  providerId: string;
  /** Seconds the provider asked us to wait (Retry-After / x-ratelimit-reset-*), when it said. */
  retryAfterSec?: number;
  constructor(status: number, providerId: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.providerId = providerId;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

/** Groq-style reset durations: "1m30s", "12.5s", "450ms", "2h1m". */
function parseDuration(v: string): number | undefined {
  const s = v.trim();
  if (!/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(s)) return undefined;
  const unit: Record<string, number> = { ms: 0.001, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(m[1]) * (unit[m[2] as string] ?? 0);
  return Math.round(total * 1000) / 1000;
}

/**
 * Wait the provider asked for, in seconds: `Retry-After` (seconds or HTTP date) first, else the longer of
 * `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens`. Undefined when none is usable.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ra = headers.get("retry-after")?.trim();
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra)) return Number(ra);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, Math.round((at - now) / 1000));
  }
  const resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map((h) => headers.get(h))
    .flatMap((v) => (v ? [parseDuration(v)] : []))
    .filter((n): n is number => n !== undefined);
  return resets.length ? Math.max(...resets) : undefined;
}

/** Configuration or local-input errors that no other provider could fix; withProvider rethrows them at once. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export type WithProviderOptions = {
  prefer?: string;
  private?: boolean;
  maxAttempts?: number;
  /** Providers to skip from the start (e.g. ones that already hit 429 earlier in the run). */
  exclude?: string[];
  /** Injectable wait for a short Retry-After (tests). */
  sleep?: (ms: number) => Promise<void>;
};

export type Attempt = { id: string; error: string; status?: number };

export type WithProviderResult<T> = {
  result: T;
  provider: { id: string; model: string };
  attempts: Attempt[];
};

/** Longest Retry-After we wait out on the same provider; longer means exhausted. */
const MAX_WAIT_SEC = 60;

/**
 * Pick a provider, run `fn`, and on failure rotate to the next one.
 * 429: when the provider says to retry within 60 s, wait and retry it once; otherwise (or on a second 429) mark it
 * exhausted for this capability. Other errors just move on. Quota is recorded only for successes.
 * Validate/parse the provider's output inside `fn`: a throw there rotates providers, whereas anything
 * `fn` returns counts as success. A NonRetryableError thrown by `fn` is rethrown without rotating.
 */
export async function withProvider<T>(
  providers: ProviderRegistry,
  capability: Capability,
  fn: (p: PickedProvider) => Promise<T>,
  opts: WithProviderOptions = {},
): Promise<WithProviderResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt[] = [];
  for (;;) {
    const cur = currentSignal();
    if (cur?.aborted) throw new CancelledError();
    let p: PickedProvider;
    try {
      p = await providers.pick(capability, {
        private: opts.private,
        prefer: opts.prefer,
        exclude: [...(opts.exclude ?? []), ...attempts.map((a) => a.id)],
      });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (e instanceof NoProviderError && attempts.length > 0) throw withAttempts(e, capability, attempts);
      throw e;
    }
    let result: T;
    try {
      result = await fn(p).catch(async (e: unknown) => {
        if (e instanceof CancelledError) throw e;
        const wait = e instanceof ProviderHttpError && e.status === 429 ? e.retryAfterSec : undefined;
        if (wait === undefined || wait > MAX_WAIT_SEC) throw e;
        await sleep(wait * 1000);
        return fn(p);
      });
    } catch (e) {
      if (e instanceof NonRetryableError || e instanceof CancelledError) throw e;
      const error = e instanceof Error ? e.message : String(e);
      attempts.push({ id: p.id, error, ...(e instanceof ProviderHttpError ? { status: e.status } : {}) });
      if (e instanceof ProviderHttpError && e.status === 429) await providers.markExhausted(p.id, undefined, capability);
      if (attempts.length >= maxAttempts) {
        throw withAttempts(new NoProviderError(capability, []), capability, attempts, true);
      }
      continue;
    }
    try {
      await providers.recordUse(p.id);
    } catch {
      // Quota bookkeeping must not discard a good result or burn another provider's quota.
    }
    return { result, provider: { id: p.id, model: p.model }, attempts };
  }
}

function formatAttempts(attempts: Attempt[]): string {
  return attempts.map((a) => `${a.id}: ${a.error}`).join("; ");
}

function withAttempts(
  e: NoProviderError,
  capability: string,
  attempts: Attempt[],
  replace = false,
): NoProviderError {
  const err = new NoProviderError(capability, e.reasons);
  const head = replace ? `No provider succeeded for "${capability}"` : e.message;
  err.message = `${head}; attempts: ${formatAttempts(attempts)}`;
  return err;
}
