import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CancelledError, currentSignal } from "../proc.ts";
import { NonRetryableError, parseRetryAfter, ProviderHttpError } from "./call.ts";
import type { PickedProvider } from "./registry.ts";

export type FetchLike = typeof fetch;

export type Word = { w: string; start: number; end: number; conf?: number };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function endpoint(p: PickedProvider, path: string): string {
  if (!p.baseUrl) throw new Error(`${p.id}: provider has no baseUrl`);
  return `${p.baseUrl.replace(/\/+$/, "")}${path}`;
}

function bearer(p: PickedProvider): string {
  const key = p.key?.reveal();
  if (!key) throw new Error(`${p.id}: API key required (${p.keyEnv ?? "no keyEnv"})`);
  return `Bearer ${key}`;
}

/** POST and return the OK response; a non-2xx becomes a ProviderHttpError with the key redacted from its body. */
async function request(p: PickedProvider, url: string, init: RequestInit, f: FetchLike, timeoutMs: number): Promise<Response> {
  const cur = currentSignal();
  if (cur?.aborted) throw new CancelledError();
  const sigs = [AbortSignal.timeout(timeoutMs)];
  if (cur) sigs.push(cur);
  const signal = AbortSignal.any(sigs);
  let res: Response;
  try {
    res = await f(url, { ...init, method: "POST", signal });
  } catch (err) {
    if (cur?.aborted) throw new CancelledError();
    throw err;
  }
  if (cur?.aborted) throw new CancelledError();
  if (!res.ok) {
    let redacted: string;
    try {
      redacted = await res.text();
    } catch (err) {
      if (cur?.aborted) throw new CancelledError();
      throw err;
    }
    const secret = p.key?.reveal();
    if (secret) redacted = redacted.split(secret).join("[redacted]");
    const snippet = redacted.slice(0, 200);
    throw new ProviderHttpError(res.status, p.id, `${p.id} HTTP ${res.status}: ${snippet}`, parseRetryAfter(res.headers));
  }
  return res;
}

async function post(p: PickedProvider, url: string, init: RequestInit, f: FetchLike, timeoutMs: number): Promise<unknown> {
  const cur = currentSignal();
  if (cur?.aborted) throw new CancelledError();
  const res = await request(p, url, init, f, timeoutMs);
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (cur?.aborted) throw new CancelledError();
    throw err;
  }
  if (cur?.aborted) throw new CancelledError();
  try {
    return JSON.parse(text);
  } catch {
    if (cur?.aborted) throw new CancelledError();
    throw new Error(`${p.id}: response was not JSON`);
  }
}

export type PostOptions = { fetchImpl?: FetchLike; timeoutMs?: number; headers?: Record<string, string> };

function jsonInit(p: PickedProvider, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { headers: { ...headers, authorization: bearer(p), "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** POST a JSON body to `baseUrl + path` with the provider's key; returns the parsed JSON reply. */
export async function postJson(p: PickedProvider, path: string, body: unknown, opts: PostOptions = {}): Promise<unknown> {
  const url = endpoint(p, path);
  return post(p, url, jsonInit(p, body, opts.headers), opts.fetchImpl ?? fetch, opts.timeoutMs ?? 120_000);
}

/** POST a JSON body and return the raw reply bytes (e.g. TTS audio, image data). */
export async function postBinary(p: PickedProvider, path: string, body: unknown, opts: PostOptions = {}): Promise<Uint8Array> {
  const cur = currentSignal();
  if (cur?.aborted) throw new CancelledError();
  const url = endpoint(p, path);
  const res = await request(p, url, jsonInit(p, body, opts.headers), opts.fetchImpl ?? fetch, opts.timeoutMs ?? 300_000);
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    if (cur?.aborted) throw new CancelledError();
    throw err;
  }
  return new Uint8Array(buf);
}

/** Chat message content: plain text, or parts mixing text and images (vision models). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export async function chatComplete(
  p: PickedProvider,
  messages: ChatMessage[],
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
  opts: { language?: string; prompt?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{
  language: string;
  words: Word[];
  segments: { start: number; end: number; text: string; avgLogprob?: number }[];
}> {
  const cur = currentSignal();
  if (cur?.aborted) throw new CancelledError();
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
  if (opts.prompt) form.append("prompt", opts.prompt);
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
