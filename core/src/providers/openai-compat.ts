import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { NonRetryableError, ProviderHttpError } from "./call.ts";
import type { PickedProvider } from "./registry.ts";

export type FetchLike = typeof fetch;

export type Word = { w: string; start: number; end: number; conf?: number };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function endpoint(p: PickedProvider, path: string): string {
  if (!p.baseUrl) throw new NonRetryableError(`${p.id}: provider has no baseUrl`);
  return `${p.baseUrl.replace(/\/+$/, "")}${path}`;
}

function bearer(p: PickedProvider): string {
  const key = p.key?.reveal();
  if (!key) throw new NonRetryableError(`${p.id}: API key required (${p.keyEnv ?? "no keyEnv"})`);
  return `Bearer ${key}`;
}

async function post(p: PickedProvider, url: string, init: RequestInit, f: FetchLike, timeoutMs: number): Promise<unknown> {
  const res = await f(url, { ...init, method: "POST", signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    let redacted = text;
    const secret = p.key?.reveal();
    if (secret) redacted = redacted.split(secret).join("[redacted]");
    const snippet = redacted.slice(0, 200);
    throw new ProviderHttpError(res.status, p.id, `${p.id} HTTP ${res.status}: ${snippet}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${p.id}: response was not JSON`);
  }
}

export async function chatComplete(
  p: PickedProvider,
  messages: { role: "system" | "user"; content: string }[],
  opts: { json?: boolean; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string> {
  const url = endpoint(p, "/chat/completions");
  const auth = bearer(p);
  const body: Record<string, unknown> = { model: p.model, messages, temperature: 0.2 };
  if (opts.json) body.response_format = { type: "json_object" };
  const data = (await post(
    p,
    url,
    { headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) },
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 120_000,
  )) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${p.id}: response has no message content`);
  return content;
}

type VerboseJson = {
  language?: string;
  words?: { word: string; start: number; end: number }[];
  segments?: { start: number; end: number; text: string; avg_logprob?: number }[];
};

export async function transcribeAudio(
  p: PickedProvider,
  audioPath: string,
  opts: { language?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{
  language: string;
  words: Word[];
  segments: { start: number; end: number; text: string; avgLogprob?: number }[];
}> {
  const url = endpoint(p, "/audio/transcriptions");
  const auth = bearer(p);
  let audio: Awaited<ReturnType<typeof readFile>>;
  try {
    audio = await readFile(audioPath);
  } catch (e) {
    throw new NonRetryableError(`cannot read audio file ${audioPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([audio]), basename(audioPath));
  form.append("model", p.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (opts.language) form.append("language", opts.language);
  const data = (await post(
    p,
    url,
    { headers: { authorization: auth }, body: form },
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 600_000,
  )) as VerboseJson;

  const segments = (data.segments ?? []).map((s) => {
    const seg: { start: number; end: number; text: string; avgLogprob?: number } = {
      start: round3(s.start),
      end: round3(s.end),
      text: s.text,
    };
    if (typeof s.avg_logprob === "number") seg.avgLogprob = s.avg_logprob;
    return seg;
  });
  const words = (data.words ?? []).map((w): Word => {
    const out: Word = { w: w.word.trim(), start: round3(w.start), end: round3(w.end) };
    const mid = (w.start + w.end) / 2;
    const seg = segments.find((s) => s.avgLogprob !== undefined && mid >= s.start && mid <= s.end);
    if (seg?.avgLogprob !== undefined) out.conf = round3(Math.min(1, Math.max(0, Math.exp(seg.avgLogprob))));
    return out;
  });
  return { language: data.language ?? opts.language ?? "unknown", words, segments };
}
