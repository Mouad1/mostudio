import { readdirSync } from "node:fs";
import {
  createRedactor,
  resolveBin,
  runBin,
  type ProviderEntry,
} from "../../core/src/index.ts";
import { fieldLabel } from "./settings.ts";
import type { ProbeResult } from "./types.ts";

export async function probeProvider(
  entry: ProviderEntry,
  env: Record<string, string | undefined>,
  deps: {
    fetch: typeof fetch;
    run?: (b: string, a: string[]) => Promise<string>;
    listDir?: (p: string) => string[];
  },
): Promise<ProbeResult> {
  const envStrings: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.length > 0) {
      envStrings[k] = v;
    }
  }
  const redactor = createRedactor([envStrings]);

  // Missing key check
  if (entry.keyEnv) {
    const keyVal = env[entry.keyEnv];
    if (!keyVal || keyVal.trim() === "") {
      const label = fieldLabel(entry.keyEnv, entry.id);
      return {
        provider: entry.id,
        ok: false,
        message: `Add your ${label} first`,
        ms: 0,
      };
    }
  }

  // Cloudflare additional check
  if (entry.id === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId || accountId.trim() === "") {
      return {
        provider: "cloudflare",
        ok: false,
        message: "Add your Cloudflare account ID first",
        ms: 0,
      };
    }
  }

  // Whisper-cpp check
  if (entry.id === "whisper-cpp") {
    const t0 = Date.now();
    const modelsDir = env.WHISPER_MODELS_DIR;
    if (!modelsDir || modelsDir.trim() === "") {
      return {
        provider: "whisper-cpp",
        ok: false,
        message: "Add your Whisper models directory first",
        ms: 0,
      };
    }

    const listDir = deps.listDir ?? ((p: string) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    });

    const files = listDir(modelsDir);
    const models = files
      .filter((f) => /^ggml-.*\.bin$/.test(f))
      .map((f) => f.replace(/^ggml-/, "").replace(/\.bin$/, ""))
      .sort();

    if (models.length === 0) {
      return {
        provider: "whisper-cpp",
        ok: false,
        message: `No ggml-*.bin models found in ${modelsDir}`,
        ms: 0,
      };
    }

    const run = deps.run ?? ((b: string, a: string[]) => runBin(b, a));
    try {
      const bin = resolveBin("whisper-cli", envStrings);
      await run(bin, ["--help"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        provider: "whisper-cpp",
        ok: false,
        message: redactor.redact(msg),
        ms: Date.now() - t0,
      };
    }

    return {
      provider: "whisper-cpp",
      ok: true,
      message: `Ready (models: ${models.join(", ")})`,
      ms: Date.now() - t0,
    };
  }

  // HTTP-based probes
  let url = "";
  const headers: Record<string, string> = {};
  const key = entry.keyEnv ? (env[entry.keyEnv] ?? "") : "";

  if (entry.id === "openrouter") {
    url = "https://openrouter.ai/api/v1/key";
    headers["Authorization"] = `Bearer ${key}`;
  } else if (entry.id === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
    headers["x-goog-api-key"] = key;
  } else if (entry.id === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID!;
    url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`;
    headers["Authorization"] = `Bearer ${key}`;
  } else {
    const baseUrl = entry.baseUrl?.replace(/\/+$/, "") ?? "";
    url = `${baseUrl}/models`;
    headers["Authorization"] = `Bearer ${key}`;
  }

  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = entry.baseUrl ?? "";
  }

  const t0 = Date.now();
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const ms = Math.max(1, Date.now() - t0);

    if (res.status === 401 || res.status === 403) {
      return {
        provider: entry.id,
        ok: false,
        status: res.status,
        message: redactor.redact(`This key was refused. Copy it again from ${host}.`),
        ms,
      };
    }

    if (!res.ok) {
      return {
        provider: entry.id,
        ok: false,
        status: res.status,
        message: redactor.redact(`${entry.id} returned HTTP ${res.status}`),
        ms,
      };
    }

    let message = `Connected (${ms} ms)`;
    if (entry.id === "nvidia") {
      message = "Reachable. This service can't confirm the key without using credits.";
    }

    return {
      provider: entry.id,
      ok: true,
      status: res.status,
      message: redactor.redact(message),
      ms,
    };
  } catch (_err) {
    const ms = Date.now() - t0;
    return {
      provider: entry.id,
      ok: false,
      message: redactor.redact(`Can't reach ${host}. Check your internet connection.`),
      ms,
    };
  }
}
