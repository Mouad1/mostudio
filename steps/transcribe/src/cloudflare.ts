import { readFile } from "node:fs/promises";
import { parseRetryAfter, ProviderHttpError } from "../../../core/src/index.ts";
import type { FetchLike, PickedProvider, Word } from "../../../core/src/index.ts";
import { buildSegments } from "./whisper-cpp.ts";
import type { Segment } from "./whisper-cpp.ts";

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

type CfResponse = {
  result?: {
    text?: string;
    words?: { word: string; start: number; end: number }[];
    transcription_info?: { language?: string };
  };
};

/** Cloudflare Workers AI Whisper: JSON body with base64 audio, word timestamps in `result.words`. */
export async function transcribeCloudflare(
  p: PickedProvider,
  audioPath: string,
  opts: { language?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ language: string; words: Word[]; segments: Segment[] }> {
  const accountId = p.envValues.accountId;
  if (!accountId) throw new Error("cloudflare: accountId missing (set CLOUDFLARE_ACCOUNT_ID in .env.local)");
  const key = p.key?.reveal();
  if (!key) throw new Error(`cloudflare: API key required (${p.keyEnv ?? "no keyEnv"})`);
  const audio = await readFile(audioPath);
  const body: Record<string, string> = { audio: audio.toString("base64") };
  if (opts.language) body.language = opts.language;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${p.model}`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderHttpError(res.status, p.id, `${p.id} HTTP ${res.status}: ${text.split(key).join("[redacted]").slice(0, 200)}`, parseRetryAfter(res.headers));
  }
  let data: CfResponse;
  try {
    data = JSON.parse(text) as CfResponse;
  } catch {
    throw new Error("cloudflare: response was not JSON");
  }
  const words = (data.result?.words ?? []).map((w): Word => ({ w: w.word.trim(), start: round3(w.start), end: round3(w.end) }));
  return {
    language: data.result?.transcription_info?.language ?? opts.language ?? "unknown",
    words,
    segments: buildSegments(words),
  };
}
