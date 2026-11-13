import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chatComplete, NoProviderError, normalizeWordTimings, readJson, withProvider, writeJsonAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule, Unit, Word } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { groupUnits, toCut } from "./group.ts";
import { arabicScriptPct, buildMessages, LANGS, parseReply } from "./prompt.ts";
import type { Lang, TargetLang } from "./prompt.ts";

export const BATCH_SIZE = 20;
/** A failed batch is split in halves down to this size, then retried once after a pause, before keeping source text. */
export const MIN_SPLIT = 5;
export const RETRY_WAIT_MS = 8_000;
const LLM_TIMEOUT_MS = 60_000;

/** Split into consecutive batches of at most `size`. */
export function batches<T>(items: T[], size: number = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function parseLang(v: unknown): Lang {
  const lang = typeof v === "string" && v !== "" ? v : "source";
  if (!(LANGS as readonly string[]).includes(lang)) throw new Error(`unknown lang "${lang}" (expected ${LANGS.join(", ")})`);
  return lang as Lang;
}

/** 429, 503, auth errors and timeouts: trying the same provider again in this run only wastes time. */
export function isOverloaded(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 429 || status === 503 || status === 401 || status === 403) return true;
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /HTTP (429|503)\b|timeout|timed out|aborted/i.test(msg);
}

export type LocalizeDeps = { sleep?: (ms: number) => Promise<void> };

export function createLocalize(deps: LocalizeDeps = {}): StepModule {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    contract: contract as StepContract,
    async run(ctx) {
      const lang = parseLang(ctx.params.lang);
      const prefer = typeof ctx.params.prefer === "string" && ctx.params.prefer !== "" ? ctx.params.prefer : undefined;
      const tr = await readJson<{ words: Word[] }>(join(ctx.projectDir, "transcript", "words.json"));
      const edl = await readJson<{ keep: Range[] }>(join(ctx.projectDir, "cut", "edl.json"));
      if (!edl || !Array.isArray(edl.keep)) throw new Error("cut/edl.json has no keep list");
      // words.json from transcribe v2+ is already normalized; this covers older files
      const source = normalizeWordTimings((tr?.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start));
      const units: Unit[] = groupUnits(toCut(source, edl.keep));

      let fallbackUnits = 0;
      const used = new Map<string, { n: number; model: string }>();
      if (lang !== "source") {
        const target: TargetLang = lang;
        const list = batches(units);
        // a provider that is overloaded, rate-limited or timing out is skipped for the rest of this run (each try can cost 60 s)
        const dead = new Set<string>();
        let noneLeft = false;
        // Free tiers fail in bursts (503 "high demand", malformed JSON on long replies): split, then retry once, then keep source.
        const convert = async (batch: Unit[], label: string, retried: boolean): Promise<void> => {
          const ids = batch.map((u) => u.id);
          try {
            const r = await withProvider(
              ctx.providers,
              "llm",
              async (p) => {
                try {
                  return parseReply(await chatComplete(p, buildMessages(target, batch), { json: true, timeoutMs: LLM_TIMEOUT_MS }), ids);
                } catch (e) {
                  if (isOverloaded(e)) dead.add(p.id);
                  throw e;
                }
              },
              { prefer, private: true, exclude: [...dead] },
            );
            for (const a of r.attempts) ctx.log(`batch ${label}: ${a.id} failed, rotating: ${a.error}`);
            for (const u of batch) u.text = r.result.get(u.id) as string;
            const hit = used.get(r.provider.id);
            used.set(r.provider.id, { n: (hit?.n ?? 0) + 1, model: r.provider.model });
          } catch (err) {
            if (!(err instanceof NoProviderError)) throw err;
            // nothing was even tried (all exhausted, keyless or skipped): splitting or waiting cannot help, so give up on the rest of the run
            if (!/attempts:/.test(err.message)) noneLeft = true;
            if (noneLeft) {
              fallbackUnits += batch.length;
              ctx.log(`batch ${label}: no LLM provider left, keeping source text for ${batch.length} unit(s): ${err.message}`);
            } else if (batch.length > MIN_SPLIT) {
              ctx.log(`batch ${label}: no provider succeeded, splitting ${batch.length} unit(s) in two`);
              const mid = Math.ceil(batch.length / 2);
              await convert(batch.slice(0, mid), `${label}a`, retried);
              await convert(batch.slice(mid), `${label}b`, retried);
            } else if (!retried) {
              ctx.log(`batch ${label}: no provider succeeded, retrying in ${RETRY_WAIT_MS / 1000}s`);
              await sleep(RETRY_WAIT_MS);
              await convert(batch, label, true);
            } else {
              fallbackUnits += batch.length;
              ctx.log(`batch ${label}: no provider succeeded, keeping source text for ${batch.length} unit(s): ${err.message}`);
            }
          }
        };
        for (const [b, batch] of list.entries()) await convert(batch, `${b + 1}/${list.length}`, false);
      }

      const top = [...used.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const provider = top ? { id: top[0], model: top[1].model } : undefined;
      await mkdir(join(ctx.projectDir, "localize"), { recursive: true });
      await writeJsonAtomic(join(ctx.projectDir, "localize", "units.json"), { lang, ...(provider ? { provider } : {}), units });

      const metrics = {
        unitCount: units.length,
        fallbackUnits,
        // source text is expected in Arabic script; the check only means something once text is converted
        arabicScriptPct: lang === "source" ? 0 : arabicScriptPct(units.map((u) => u.text)),
        lang,
      };
      ctx.log(`localize ${lang}: ${units.length} unit(s)${provider ? ` via ${provider.id}` : ""}${fallbackUnits ? `, ${fallbackUnits} kept in source` : ""}`);
      return { metrics, artifacts: ["localize/units.json"], ...(provider ? { provider } : {}) };
    },
  };
}

export const localize: StepModule = createLocalize();
export default localize;
