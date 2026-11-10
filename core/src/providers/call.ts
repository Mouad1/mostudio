import { NoProviderError } from "./registry.ts";
import type { Capability, PickedProvider, ProviderRegistry } from "./registry.ts";

export class ProviderHttpError extends Error {
  status: number;
  providerId: string;
  constructor(status: number, providerId: string, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.providerId = providerId;
  }
}

export type WithProviderOptions = { prefer?: string; private?: boolean; maxAttempts?: number };

export type WithProviderResult<T> = {
  result: T;
  provider: { id: string; model: string };
  attempts: { id: string; error: string }[];
};

/**
 * Pick a provider, run `fn`, and on failure rotate to the next one.
 * 429 marks the provider exhausted; other errors just move on. Quota is recorded only for successes.
 */
export async function withProvider<T>(
  providers: ProviderRegistry,
  capability: Capability,
  fn: (p: PickedProvider) => Promise<T>,
  opts: WithProviderOptions = {},
): Promise<WithProviderResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const attempts: { id: string; error: string }[] = [];
  for (;;) {
    let p: PickedProvider;
    try {
      p = await providers.pick(capability, {
        private: opts.private,
        prefer: opts.prefer,
        exclude: attempts.map((a) => a.id),
      });
    } catch (e) {
      if (e instanceof NoProviderError && attempts.length > 0) throw withAttempts(e, capability, attempts);
      throw e;
    }
    try {
      const result = await fn(p);
      await providers.recordUse(p.id);
      return { result, provider: { id: p.id, model: p.model }, attempts };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      attempts.push({ id: p.id, error });
      if (e instanceof ProviderHttpError && e.status === 429) await providers.markExhausted(p.id);
      if (attempts.length >= maxAttempts) {
        throw new Error(`${capability}: all ${attempts.length} attempts failed; attempts: ${formatAttempts(attempts)}`);
      }
    }
  }
}

function formatAttempts(attempts: { id: string; error: string }[]): string {
  return attempts.map((a) => `${a.id}: ${a.error}`).join("; ");
}

function withAttempts(e: NoProviderError, capability: string, attempts: { id: string; error: string }[]): NoProviderError {
  const err = new NoProviderError(capability, e.reasons);
  err.message = `${e.message}; attempts: ${formatAttempts(attempts)}`;
  return err;
}
