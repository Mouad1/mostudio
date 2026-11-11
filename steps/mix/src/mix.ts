import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loudnormPass, measureLoudness, readJson, resolveFfmpeg, runBin, writeOutputAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };

const BATCH = 80;
const RATE = 48000;
const NEEDS = ["loudnorm", "sidechaincompress", "afade", "atrim", "concat", "amix", "asplit"];
const PCM = ["-ar", String(RATE), "-ac", "2", "-c:a", "pcm_s16le"];
const BASE = ["-hide_banner", "-loglevel", "error", "-y"];
const MIX_TIMEOUT_MS = 600_000;

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const t = (n: number): string => n.toFixed(6);

/** One concat-demuxer line; single quotes inside the path are written as '\''. */
export function concatLine(path: string): string {
  return `file '${path.replaceAll("'", "'\\''")}'`;
}

/** Filter graph cutting `keeps` out of input 0 with fades at each boundary, concatenated to [out]. */
export function voiceGraph(keeps: Range[], fadeSec: number): string {
  const n = keeps.length;
  const tags = keeps.map((_, i) => `[s${i}]`).join("");
  const parts = [`[0:a]aresample=${RATE},aformat=channel_layouts=stereo,asplit=${n}${tags}`];
  keeps.forEach((k, i) => {
    const len = k.end - k.start;
    let f = `[s${i}]atrim=${t(k.start)}:${t(k.end)},asetpts=PTS-STARTPTS`;
    if (fadeSec > 0 && len >= 2 * fadeSec) {
      f += `,afade=t=in:d=${t(fadeSec)},afade=t=out:st=${t(len - fadeSec)}:d=${t(fadeSec)}`;
    }
    parts.push(`${f}[a${i}]`);
  });
  parts.push(`${keeps.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1[out]`);
  return parts.join(";");
}

/** Duration of a PCM WAV from its header (the file must be seekable-written, as ffmpeg does). */
async function wavDuration(path: string): Promise<number> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    let rate = 0;
    let frame = 0;
    const ch = Buffer.alloc(8);
    for (let pos = 12; pos + 8 <= size; ) {
      await fh.read(ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4);
      const len = ch.readUInt32LE(4);
      if (id === "fmt ") {
        const b = Buffer.alloc(16);
        await fh.read(b, 0, 16, pos + 8);
        rate = b.readUInt32LE(4);
        frame = b.readUInt16LE(12);
      } else if (id === "data") {
        if (!rate || !frame) throw new Error(`${path}: WAV data before fmt`);
        return Math.min(len, size - pos - 8) / frame / rate;
      }
      pos += 8 + len + (len % 2);
    }
    throw new Error(`${path}: WAV has no data chunk`);
  } finally {
    await fh.close();
  }
}

export const mix: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const musicDb = num(ctx.params.musicDb, -21);
    const target = num(ctx.params.targetLufs, -14);
    const music = typeof ctx.params.music === "string" && ctx.params.music ? ctx.params.music : undefined;

    const ingest = await readJson<{ file: string; hasAudio?: boolean }>(join(ctx.projectDir, "media", "ingest.json"));
    if (!ingest?.file) throw new Error("media/ingest.json has no file");
    if (ingest.hasAudio === false) throw new Error("source has no audio track");
    const edl = await readJson<{ fadeSec?: number; keep: Range[]; outDurationSec: number }>(join(ctx.projectDir, "cut", "edl.json"));
    if (!edl || !Array.isArray(edl.keep) || edl.keep.length === 0) throw new Error("cut/edl.json has no keep ranges");
    const fadeSec = num(edl.fadeSec, 0.01);
    const outDur = edl.outDurationSec;
    const source = join(ctx.projectDir, ingest.file);

    const ffmpeg = await resolveFfmpeg(ctx.env, NEEDS);
    const cache = join(ctx.projectDir, "cache", "mix");
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    await mkdir(join(ctx.projectDir, "audio"), { recursive: true });

    try {
      // voice: cut + fades, in batches so the filter graph stays small
      const batches: string[] = [];
      for (let i = 0; i < edl.keep.length; i += BATCH) {
        const file = join(cache, `batch-${String(batches.length).padStart(3, "0")}.wav`);
        const graph = voiceGraph(edl.keep.slice(i, i + BATCH), fadeSec);
        await runBin(ffmpeg, [...BASE, "-i", source, "-filter_complex", graph, "-map", "[out]", ...PCM, file], MIX_TIMEOUT_MS);
        batches.push(file);
      }
      const voice = join(cache, "voice.wav");
      const list = join(cache, "list.txt");
      await writeFile(list, `${batches.map(concatLine).join("\n")}\n`);
      await runBin(ffmpeg, [...BASE, "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", voice], MIX_TIMEOUT_MS);

      // optional music, ducked under the voice
      let pre = voice;
      if (music) {
        pre = join(cache, "pre.wav");
        const graph = [
          `[1:a]atrim=0:${t(outDur)},asetpts=PTS-STARTPTS,aresample=${RATE},aformat=channel_layouts=stereo,volume=${musicDb}dB[m]`,
          "[0:a]asplit=2[v1][v2]",
          "[m][v1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d]",
          "[v2][d]amix=inputs=2:duration=first:normalize=0[mixed]",
        ].join(";");
        await runBin(
          ffmpeg,
          [...BASE, "-i", voice, "-stream_loop", "-1", "-i", music, "-filter_complex", graph, "-map", "[mixed]", "-t", t(outDur), ...PCM, pre],
          MIX_TIMEOUT_MS,
        );
      }

      // two-pass loudness normalization
      const s = await loudnormPass(pre, ctx.env, { target });
      const af =
        `loudnorm=I=${target}:TP=-1:LRA=50:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}` +
        `:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true,aresample=${RATE}`;
      const finalPath = join(ctx.projectDir, "audio", "mix.wav");
      await writeOutputAtomic(finalPath, async (tmp) => {
        await runBin(ffmpeg, [...BASE, "-i", pre, "-af", af, ...PCM, tmp], MIX_TIMEOUT_MS);
      });

      const got = await measureLoudness(finalPath, ctx.env);
      const durationSec = round(await wavDuration(finalPath), 3);
      const metrics = {
        integratedLufs: round(got.integratedLufs, 1),
        truePeakDb: round(got.truePeakDb, 1),
        durationSec,
        segments: edl.keep.length,
        batches: batches.length,
        hasMusic: music !== undefined,
      };
      ctx.log(`mix: ${metrics.segments} segments, ${metrics.integratedLufs} LUFS, ${metrics.truePeakDb} dBTP, ${durationSec}s${music ? " + music" : ""}`);
      return { metrics, artifacts: ["audio/mix.wav"] };
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  },
};

export default mix;
