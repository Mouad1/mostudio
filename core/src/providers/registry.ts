import { getSecret } from "../config.ts";
import type { Config, Secret } from "../config.ts";
import { currentQuota, loadStore, nextReset, saveStore } from "./quota.ts";
import type { Tz } from "./quota.ts";

export { nextReset } from "./quota.ts";

export type Capability = "stt" | "llm" | "vision" | "tts" | "image" | "stock";

export type ProviderEntry = {
  id: string;
  capabilities: Capability[];
  kind: "openai-compat" | "native" | "local";
  baseUrl?: string;
  /** Default model; `models[capability]` overrides it per capability. */
  model: string;
  models?: Partial<Record<Capability, string>>;
  keyEnv?: string;
  limits: { rpm?: number; rpd?: number };
  reset: { tz: Tz };
  flags: { commercial_ok: boolean; trains_on_data: boolean; renewable: boolean };
  priority: Record<string, number>;
  /** Billed provider; skipped when billing is "free-only". */
  paid?: boolean;
  /** Logical name -> name of a non-secret env var (e.g. accountId -> CLOUDFLARE_ACCOUNT_ID). */
  env?: Record<string, string>;
};

/** A selected provider: its key (if any) and its `env` mapping resolved to values. */
export type PickedProvider = ProviderEntry & {
  key?: Secret;
  envValues: Record<string, string | undefined>;
};

export type PickOptions = {
  private?: boolean;
  now?: Date;
  /** Try this provider id first when it is eligible. */
  prefer?: string;
  /** Skip these provider ids (reason "excluded"). */
  exclude?: string[];
};

export type Reason = {
  id: string;
  reason: "no-key" | "exhausted" | "excluded-flag" | "excluded" | "rate-limited";
  until?: string;
};

export class NoProviderError extends Error {
  reasons: Reason[];
  constructor(capability: string, reasons: Reason[]) {
    const detail = reasons.length
      ? reasons.map((r) => `${r.id}: ${r.reason}${r.until ? ` until ${r.until}` : ""}`).join("; ")
      : "no provider declares this capability";
    super(`No provider available for "${capability}": ${detail}`);
    this.name = "NoProviderError";
    this.reasons = reasons;
  }
}

export type ProviderRegistry = {
  pick(capability: string, opts?: PickOptions): Promise<PickedProvider>;
  recordUse(id: string, now?: Date): Promise<void>;
  /** Skip `id` until its next reset: for `capability` only when given, else for every capability. */
  markExhausted(id: string, now?: Date, capability?: string): Promise<void>;
};

export function createRegistry(
  entries: ProviderEntry[],
  env: Record<string, string | undefined>,
  quotaStorePath: string,
  billing: Config["billing"],
): ProviderRegistry {
  const byId = (id: string): ProviderEntry => {
    const e = entries.find((x) => x.id === id);
    if (!e) throw new Error(`unknown provider: ${id}`);
    return e;
  };
  // Serialize read-modify-write cycles on the store.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    pick(capability, opts = {}) {
      return locked(async () => {
        const now = opts.now ?? new Date();
        const store = await loadStore(quotaStorePath);
        const candidates = entries
          .filter((e) => e.capabilities.includes(capability as Capability))
          .sort((a, b) => (a.priority[capability] ?? Infinity) - (b.priority[capability] ?? Infinity));
        const preferred = candidates.findIndex((e) => e.id === opts.prefer);
        if (preferred > 0) candidates.unshift(...candidates.splice(preferred, 1));
        const reasons: Reason[] = [];
        for (const e of candidates) {
          if (opts.exclude?.includes(e.id)) {
            reasons.push({ id: e.id, reason: "excluded" });
            continue;
          }
          if (
            !e.flags.commercial_ok ||
            (opts.private && e.flags.trains_on_data) ||
            (billing === "free-only" && e.paid)
          ) {
            reasons.push({ id: e.id, reason: "excluded-flag" });
            continue;
          }
          let key: Secret | undefined;
          if (e.keyEnv) {
            key = getSecret(e.keyEnv, env);
            if (!key) {
              reasons.push({ id: e.id, reason: "no-key" });
              continue;
            }
          }
          const q = currentQuota(store, e.id, e.reset.tz, now);
          const exhaustedUntil = q.exhaustedUntil ?? q.exhaustedFor?.[capability];
          if (exhaustedUntil) {
            reasons.push({ id: e.id, reason: "exhausted", until: exhaustedUntil });
            continue;
          }
          if (e.limits.rpd !== undefined && (e.limits.rpd <= 0 || q.day.count >= e.limits.rpd)) {
            reasons.push({ id: e.id, reason: "exhausted", until: q.day.resetAt });
            continue;
          }
          if (e.limits.rpm !== undefined && q.minute.length >= e.limits.rpm) {
            const r: Reason = { id: e.id, reason: "rate-limited" };
            if (q.minute.length > 0) r.until = new Date(Math.min(...q.minute) + 60_000).toISOString();
            reasons.push(r);
            continue;
          }
          const picked: PickedProvider = {
            ...e,
            model: e.models?.[capability as Capability] ?? e.model,
            envValues: Object.fromEntries(Object.entries(e.env ?? {}).map(([k, name]) => [k, env[name] || undefined])),
          };
          if (key) picked.key = key;
          return picked;
        }
        throw new NoProviderError(capability, reasons);
      });
    },

    recordUse(id, now = new Date()) {
      return locked(async () => {
        const e = byId(id);
        const store = await loadStore(quotaStorePath);
        const q = currentQuota(store, id, e.reset.tz, now);
        q.day.count += 1;
        q.minute.push(now.getTime());
        store[id] = q;
        await saveStore(quotaStorePath, store);
      });
    },

    markExhausted(id, now = new Date(), capability) {
      return locked(async () => {
        const e = byId(id);
        const store = await loadStore(quotaStorePath);
        const q = currentQuota(store, id, e.reset.tz, now);
        const until = nextReset(e.reset.tz, now).toISOString();
        if (capability) q.exhaustedFor = { ...q.exhaustedFor, [capability]: until };
        else q.exhaustedUntil = until;
        store[id] = q;
        await saveStore(quotaStorePath, store);
      });
    },
  };
}
