import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
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
import { planChunks } from "./chunk.ts";
import { transcribeCloudflare } from "./cloudflare.ts";
import { buildSegments, transcribeWhisperCpp } from "./whisper-cpp.ts";
import type { Segment } from "./whisper-cpp.ts";

const WINDOW_MS = 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

type ChunkOut = { language: string; words: Word[]; segments: Segment[] };

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
      const ffmpeg = await resolveFfmpeg(ctx.env, []);

      const wav = join(ctx.projectDir, "transcript", "audio.wav");
      await mkdir(join(ctx.projectDir, "transcript"), { recursive: true });
      await writeOutputAtomic(wav, (tmp) =>
        runBin(ffmpeg, ["-y", "-v", "error", "-i", join(ctx.projectDir, ingest.file), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp]).then(() => {}),
      );
      const env = await rmsEnvelope(wav, WINDOW_MS);
      const durationSec = round3((env.length * WINDOW_MS) / 1000);
      const chunks = planChunks(durationSec, env, WINDOW_MS);
      ctx.log(`audio ${durationSec}s, ${chunks.length} chunk(s)`);

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

      const dispatch = async (p: PickedProvider, i: number): Promise<ChunkOut> => {
        if (p.kind === "openai-compat") {
          const r = await transcribeAudio(p, await chunkFile(i, "mp3"), { language, fetchImpl: deps.fetchImpl });
          return { language: r.language, words: r.words, segments: r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
        }
        if (p.kind === "native" && p.id === "cloudflare") {
          return transcribeCloudflare(p, await chunkFile(i, "mp3"), { language, fetchImpl: deps.fetchImpl });
        }
        if (p.kind === "local" && p.id === "whisper-cpp") {
          return transcribeWhisperCpp(p, await chunkFile(i, "wav"), { language, env: ctx.env, workDir: cache });
        }
        throw new Error(`transcribe: unsupported stt provider ${p.id} (${p.kind})`);
      };

      const words: Word[] = [];
      const segments: Segment[] = [];
      const used = new Map<string, { n: number; model: string }>();
      let detected: string | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const offset = (chunks[i] as { start: number }).start;
        const { result, provider, attempts } = await withProvider(
          ctx.providers,
          "stt",
          async (p) => {
            const r = await dispatch(p, i);
            if (!Array.isArray(r.words)) throw new Error(`${p.id}: no words in response`);
            return r;
          },
          { prefer, private: true },
        );
        for (const a of attempts) ctx.log(`chunk ${i + 1}: ${a.id} failed, rotating: ${a.error}`);
        const hit = used.get(provider.id);
        used.set(provider.id, { n: (hit?.n ?? 0) + 1, model: provider.model });
        if (!detected && result.words.length > 0) detected = result.language;
        const segs = result.segments.length > 0 ? result.segments : buildSegments(result.words);
        for (const w of result.words) {
          words.push({ ...w, start: round3(w.start + offset), end: round3(w.end + offset) });
        }
        for (const s of segs) segments.push({ ...s, start: round3(s.start + offset), end: round3(s.end + offset) });
        ctx.log(`chunk ${i + 1}/${chunks.length}: ${result.words.length} words via ${provider.id}`);
      }

      const top = [...used.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const prov = top ? { id: top[0], model: top[1].model } : undefined;
      const lang = detected ?? language ?? "unknown";
      await mkdir(join(ctx.projectDir, "transcript"), { recursive: true });
      await writeJsonAtomic(join(ctx.projectDir, "transcript", "words.json"), {
        language: lang,
        provider: prov,
        durationSec,
        words,
        segments,
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
      };
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
