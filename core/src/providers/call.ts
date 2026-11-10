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

/** Configuration or local-input errors that no other provider could fix; withProvider rethrows them at once. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
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
    let result: T;
    try {
      result = await fn(p);
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      const error = e instanceof Error ? e.message : String(e);
      attempts.push({ id: p.id, error });
      if (e instanceof ProviderHttpError && e.status === 429) await providers.markExhausted(p.id);
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

function formatAttempts(attempts: { id: string; error: string }[]): string {
  return attempts.map((a) => `${a.id}: ${a.error}`).join("; ");
}

function withAttempts(
  e: NoProviderError,
  capability: string,
  attempts: { id: string; error: string }[],
  replace = false,
): NoProviderError {
  const err = new NoProviderError(capability, e.reasons);
  const head = replace ? `No provider succeeded for "${capability}"` : e.message;
  err.message = `${head}; attempts: ${formatAttempts(attempts)}`;
  return err;
}
