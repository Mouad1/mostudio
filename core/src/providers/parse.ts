import type { ProviderEntry } from "./registry.ts";

const CAPABILITIES = new Set<string>(["stt", "llm", "vision", "tts", "image", "stock"]);
const KINDS = new Set<string>(["openai-compat", "native", "local"]);
const TZS = new Set<string>(["America/Los_Angeles", "UTC"]);
const FLAGS = ["commercial_ok", "trains_on_data", "renewable"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate parsed providers.json; throws naming `providers.json[i].field` on the first bad value. */
export function parseProviders(json: unknown): ProviderEntry[] {
  if (!Array.isArray(json)) throw new Error("providers.json: expected an array of provider entries");
  json.forEach((e, i) => {
    const at = `providers.json[${i}]`;
    const fail = (field: string, want: string): never => {
      throw new Error(`${at}.${field}: expected ${want}`);
    };
    if (!isObj(e)) throw new Error(`${at}: expected an object`);
    if (typeof e.id !== "string" || e.id === "") fail("id", "a non-empty string");
    if (
      !Array.isArray(e.capabilities) ||
      e.capabilities.length === 0 ||
      !e.capabilities.every((c) => typeof c === "string" && CAPABILITIES.has(c))
    ) {
      fail("capabilities", `a non-empty array of ${[...CAPABILITIES].join("|")}`);
    }
    if (typeof e.kind !== "string" || !KINDS.has(e.kind)) fail("kind", [...KINDS].join("|"));
    if (typeof e.model !== "string") fail("model", "a string");
    for (const f of ["baseUrl", "keyEnv"]) {
      if (e[f] !== undefined && typeof e[f] !== "string") fail(f, "a string");
    }
    if (e.paid !== undefined && typeof e.paid !== "boolean") fail("paid", "a boolean");
    const record = (field: string, value: unknown, kind: "string" | "number", keys?: Set<string>): void => {
      if (!isObj(value)) return fail(field, "an object");
      for (const [k, v] of Object.entries(value)) {
        if (keys && !keys.has(k)) fail(`${field}.${k}`, `a known capability key`);
        if (typeof v !== kind || (kind === "number" && !Number.isFinite(v))) fail(`${field}.${k}`, `a ${kind}`);
      }
    };
    if (e.models !== undefined) record("models", e.models, "string", CAPABILITIES);
    if (e.env !== undefined) record("env", e.env, "string");
    record("priority", e.priority, "number");
    if (!isObj(e.limits)) fail("limits", "an object");
    const limits = e.limits as Obj;
    for (const f of ["rpm", "rpd"]) {
      if (limits[f] !== undefined && (typeof limits[f] !== "number" || !Number.isFinite(limits[f]))) {
        fail(`limits.${f}`, "a number");
      }
    }
    if (!isObj(e.reset) || typeof e.reset.tz !== "string" || !TZS.has(e.reset.tz)) {
      fail("reset.tz", [...TZS].join("|"));
    }
    if (!isObj(e.flags)) fail("flags", "an object");
    for (const f of FLAGS) if (typeof (e.flags as Obj)[f] !== "boolean") fail(`flags.${f}`, "a boolean");
  });
  return json as ProviderEntry[];
}
