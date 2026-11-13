import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  NoProviderError,
  normalizeWordTimings,
  readJson,
  resolveFfmpeg,
  rmsEnvelope,
  runBin,
  transcribeAudio,
  withProvider,
  writeJsonAtomic,
  writeOutputAtomic,
} from "../../../core/src/index.ts";
import type { FetchLike, PickedProvider, StepContract, StepModule, Word } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { planChunks, WINDOW_SEC, WINDOW_SLACK_SEC } from "./chunk.ts";
import { transcribeCloudflare } from "./cloudflare.ts";
import { choosePass, darijaPrompt, msaScore } from "./darija.ts";
import { dropHallucinations } from "./hallucinations.ts";
import { buildSegments, transcribeWhisperCpp } from "./whisper-cpp.ts";
import { tightenToVoice } from "./voice.ts";
import type { Segment } from "./whisper-cpp.ts";

const WINDOW_MS = 10;
/** Decoding the whole source (a long 4K file) to 16 kHz WAV can take minutes. */
const EXTRACT_TIMEOUT_MS = 600_000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** ASR annotations, not speech: a whole token in () or [] ("(music)", "[Music]", "(applause).") or only music signs. */
export function isNonSpeech(w: string): boolean {
  const t = w.trim();
  return /^[[(][^\])]*[\])][.,!?;:]*$/.test(t) || /^[♪♫♬♩\s]+$/.test(t);
}

type ChunkOut = { language: string; words: Word[]; segments: Segment[] };
/** Per-call STT options: the Darija passes differ only in these. */
type Call = { language?: string; prompt?: string };
const DIALECTS = ["darija"];
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export type TranscribeDeps = { fetchImpl?: FetchLike };

export function createTranscribe(deps: TranscribeDeps = {}): StepModule {
  return {
    contract: contract as StepContract,
    async run(ctx) {
      const t0 = Date.now();
      const ingest = await readJson<{ file: string }>(join(ctx.projectDir, "media", "ingest.json"));
      if (!ingest?.file) throw new Error("media/ingest.json has no file");
      const language = typeof ctx.params.language === "string" ? ctx.params.language : undefined;
      const prefer = typeof ctx.params.prefer === "string" ? ctx.params.prefer : undefined;
      const dialect = str(ctx.params.dialect);
      const userPrompt = str(ctx.params.prompt);
      if (dialect !== undefined && !DIALECTS.includes(dialect)) throw new Error(`unknown dialect "${dialect}" (supported: ${DIALECTS.join(", ")})`);
      if (dialect && language) throw new Error(`dialect=${dialect} picks the language per window; drop the language param`);
      const ffmpeg = await resolveFfmpeg(ctx.env, []);

      const wav = join(ctx.projectDir, "transcript", "audio.wav");
      await mkdir(join(ctx.projectDir, "transcript"), { recursive: true });
      await writeOutputAtomic(wav, (tmp) =>
        runBin(ffmpeg, ["-y", "-v", "error", "-i", join(ctx.projectDir, ingest.file), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp], EXTRACT_TIMEOUT_MS).then(() => {}),
      );
      const env = await rmsEnvelope(wav, WINDOW_MS);
      const durationSec = round3((env.length * WINDOW_MS) / 1000);
      const chunks = dialect ? planChunks(durationSec, env, WINDOW_MS, WINDOW_SEC, WINDOW_SLACK_SEC) : planChunks(durationSec, env, WINDOW_MS);
      ctx.log(`audio ${durationSec}s, ${chunks.length} ${dialect ? `${dialect} window(s)` : "chunk(s)"}`);

      const cache = join(ctx.projectDir, "cache", "transcribe");
      await mkdir(cache, { recursive: true });
      const encoded = new Map<string, Promise<void>>();
      const chunkFile = (i: number, ext: "mp3" | "wav"): Promise<string> => {
        const c = chunks[i] as { start: number; end: number };
        const path = join(cache, `chunk-${String(i).padStart(3, "0")}.${ext}`);
        if (!encoded.has(path)) {
          const codec = ext === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "64k"] : ["-c:a", "pcm_s16le"];
          encoded.set(
            path,
            chunks.length === 1 && ext === "wav"
              ? Promise.resolve()
              : runBin(ffmpeg, ["-y", "-v", "error", "-ss", String(c.start), "-t", String(round3(c.end - c.start)), "-i", wav, "-ac", "1", "-ar", "16000", ...codec, path]).then(() => {}),
          );
        }
        return (encoded.get(path) as Promise<void>).then(() => (chunks.length === 1 && ext === "wav" ? wav : path));
      };

      const dispatch = async (p: PickedProvider, i: number, call: Call): Promise<ChunkOut> => {
        const { language: lang, prompt } = call;
        if (p.kind === "openai-compat") {
          const r = await transcribeAudio(p, await chunkFile(i, "mp3"), { language: lang, prompt, fetchImpl: deps.fetchImpl });
          return { language: r.language, words: r.words, segments: r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
        }
        if (p.kind === "native" && p.id === "cloudflare") {
          return transcribeCloudflare(p, await chunkFile(i, "mp3"), { language: lang, prompt, fetchImpl: deps.fetchImpl });
        }
        if (p.kind === "local" && p.id === "whisper-cpp") {
          // no prompt: whisper.cpp large-v3 loops/hallucinates with one (spikes/s1-stt)
          return transcribeWhisperCpp(p, await chunkFile(i, "wav"), { language: lang, env: ctx.env, workDir: cache });
        }
        throw new Error(`transcribe: unsupported stt provider ${p.id} (${p.kind})`);
      };

      const rawWords: Word[] = [];
      const segments: Segment[] = [];
      const used = new Map<string, { n: number; model: string }>();
      let detected: string | undefined;
      // providers that hit a rate limit or rejected the key are not retried for later chunks of this run
      const dead = new Set<string>();
      const stt = async (i: number, call: Call, label: string) => {
        const { result, provider, attempts } = await withProvider(
          ctx.providers,
          "stt",
          async (p) => {
            const r = await dispatch(p, i, call);
            if (!Array.isArray(r.words)) throw new Error(`${p.id}: no words in response`);
            return r;
          },
          { prefer, private: true, exclude: [...dead] },
        );
        for (const a of attempts) {
          ctx.log(`${label}: ${a.id} failed, rotating: ${a.error}`);
          if (a.status === 429 || a.status === 401 || a.status === 403) dead.add(a.id);
        }
        return { result, provider };
      };
      // Darija: pass A = forced Arabic + Darija prompt; pass B (auto language) runs only when A reads as MSA,
      // since B is chosen only then (French/English speech that forcing `ar` translated into MSA).
      let autoWindows = 0;
      const transcribeChunk = async (i: number) => {
        if (!dialect) return stt(i, { language, prompt: userPrompt }, `chunk ${i + 1}`);
        const label = `window ${i + 1}`;
        const a = await stt(i, { language: "ar", prompt: darijaPrompt(userPrompt) }, `${label} pass A`);
        const aText = a.result.words.map((w) => w.w).join(" ");
        const score = msaScore(aText);
        if (score <= 0) {
          ctx.log(`${label}: pass A (forced ar, msaScore ${score})`);
          return a;
        }
        try {
          const b = await stt(i, {}, `${label} pass B`);
          if (choosePass(aText, b.result.language) === "B") {
            autoWindows++;
            ctx.log(`${label}: pass B (auto heard ${b.result.language}, A msaScore ${score})`);
            return b;
          }
          ctx.log(`${label}: pass A (auto heard ${b.result.language}, A msaScore ${score})`);
        } catch (err) {
          if (!(err instanceof NoProviderError)) throw err;
          ctx.log(`${label}: pass A (pass B failed: ${err.message})`);
        }
        return a;
      };
      for (let i = 0; i < chunks.length; i++) {
        const offset = (chunks[i] as { start: number }).start;
        const { result, provider } = await transcribeChunk(i);
        const hit = used.get(provider.id);
        used.set(provider.id, { n: (hit?.n ?? 0) + 1, model: provider.model });
        if (!detected && result.words.length > 0) detected = result.language;
        const segs = result.segments.length > 0 ? result.segments : buildSegments(result.words);
        for (const w of result.words) {
          rawWords.push({ ...w, start: round3(w.start + offset), end: round3(w.end + offset) });
        }
        for (const s of segs) segments.push({ ...s, start: round3(s.start + offset), end: round3(s.end + offset) });
        ctx.log(`chunk ${i + 1}/${chunks.length}: ${result.words.length} words via ${provider.id}`);
      }

      const top = [...used.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const prov = top ? { id: top[0], model: top[1].model } : undefined;
      const lang = detected ?? language ?? "unknown";
      const clean = dropHallucinations(rawWords, segments);
      if (clean.dropped > 0) ctx.log(`dropped ${clean.dropped} hallucinated segment(s) like "thanks for watching"`);
      const speech = clean.words.filter((w) => !isNonSpeech(w.w));
      const nonSpeechDropped = clean.words.length - speech.length;
      if (nonSpeechDropped > 0) ctx.log(`dropped ${nonSpeechDropped} non-speech token(s) like (music) / ♪`);
      // ASR timestamps can overlap or start before the previous word: transcript order wins, timings made monotonic
      const tight = tightenToVoice(normalizeWordTimings(speech), env, WINDOW_MS);
      if (tight.tightened > 0) ctx.log(`tightened ${tight.tightened} word(s) stretched over silence`);
      const words = tight.words;
      await mkdir(join(ctx.projectDir, "transcript"), { recursive: true });
      await writeJsonAtomic(join(ctx.projectDir, "transcript", "words.json"), {
        language: lang,
        provider: prov,
        durationSec,
        words,
        segments: clean.segments,
      });

      const timestamped = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start < w.end).length;
      const confs = words.map((w) => w.conf).filter((c): c is number => typeof c === "number");
      const metrics: Record<string, number | string | boolean> = {
        wordCount: words.length,
        pctTimestamped: words.length === 0 ? 100 : Math.round((timestamped / words.length) * 10000) / 100,
        meanConfidence: confs.length === 0 ? 1 : Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000,
        language: lang,
        chunks: chunks.length,
        runtimeSec: Math.round((Date.now() - t0) / 100) / 10,
        provider: prov?.id ?? "none",
        nonSpeechDropped,
        hallucinationsDropped: clean.dropped,
        wordsTightened: tight.tightened,
      };
      if (dialect) {
        metrics.windows = chunks.length;
        metrics.autoWindows = autoWindows;
      }
      if (confs.length === 0) metrics.confidenceKnown = false;
      return {
        metrics,
        artifacts: ["transcript/audio.wav", "transcript/words.json"],
        ...(prov ? { provider: prov } : {}),
      };
    },
  };
}

export const transcribe: StepModule = createTranscribe();
export default transcribe;
