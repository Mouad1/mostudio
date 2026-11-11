import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clampKeeps,
  durationBound,
  loudnormPass,
  measureLoudness,
  readJson,
  resolveBin,
  resolveFfmpeg,
  runBin,
  wavDuration,
  writeOutputAtomic,
} from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };

const BATCH = 80;
const RATE = 48000;
const NEEDS = ["loudnorm", "sidechaincompress", "afade", "atrim", "concat", "amix", "asplit", "alimiter", "acompressor", "highpass", "aresample", "aformat", "asetpts", "volume"];
const PCM = ["-ar", String(RATE), "-ac", "2", "-c:a", "pcm_s16le"];
const PCM_F = ["-ar", String(RATE), "-ac", "2", "-c:a", "pcm_f32le"];
const MAX_GAIN_DB = 30;
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
  const parts = [`[0:a]aresample=${RATE},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,asplit=${n}${tags}`];
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

export const mix: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const musicDb = num(ctx.params.musicDb, -21);
    const target = num(ctx.params.targetLufs, -14);
    const music = typeof ctx.params.music === "string" && ctx.params.music ? ctx.params.music : undefined;

    const ingest = await readJson<{ file: string; hasAudio?: boolean; durationSec?: number }>(join(ctx.projectDir, "media", "ingest.json"));
    if (!ingest?.file) throw new Error("media/ingest.json has no file");
    if (ingest.hasAudio === false) throw new Error("source has no audio track");
    const edl = await readJson<{ fadeSec?: number; keep: Range[]; outDurationSec: number; sourceDurationSec?: number }>(join(ctx.projectDir, "cut", "edl.json"));
    if (!edl || !Array.isArray(edl.keep) || edl.keep.length === 0) throw new Error("cut/edl.json has no keep ranges");
    const fadeSec = num(edl.fadeSec, 0.01);
    // same bound as cut (shorter of container and audio track), so audio, video and chapters agree
    const bound = durationBound(ingest.durationSec, edl.sourceDurationSec);
    const { keep: keeps, clamped } = clampKeeps(edl.keep, bound);
    if (clamped) ctx.log(`mix: clamped keep ranges to source duration ${bound}s`);
    if (keeps.length === 0) throw new Error("all keep ranges lie beyond the source duration");
    const outDur = keeps.reduce((a, k) => a + k.end - k.start, 0);
    const source = join(ctx.projectDir, ingest.file);

    const ffmpeg = await resolveFfmpeg(ctx.env, NEEDS);
    if (music) {
      try {
        if (!(await stat(music)).isFile()) throw new Error("not a file");
      } catch {
        throw new Error(`music file not found: ${music}`);
      }
      const probe = await runBin(resolveBin("ffprobe", ctx.env), ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", music]).catch(() => {
        throw new Error(`music file is not readable media: ${music}`);
      });
      if (!probe.trim()) throw new Error(`music file has no audio track: ${music}`);
    }
    const cache = join(ctx.projectDir, "cache", "mix");
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    await mkdir(join(ctx.projectDir, "audio"), { recursive: true });

    try {
      // voice: cut + fades, in batches so the filter graph stays small
      const batches: string[] = [];
      for (let i = 0; i < keeps.length; i += BATCH) {
        const file = join(cache, `batch-${String(batches.length).padStart(3, "0")}.wav`);
        const graph = voiceGraph(keeps.slice(i, i + BATCH), fadeSec);
        await runBin(ffmpeg, [...BASE, "-i", source, "-filter_complex", graph, "-map", "[out]", ...PCM_F, file], MIX_TIMEOUT_MS);
        batches.push(file);
      }
      const voice = join(cache, "voice.wav");
      const list = join(cache, "list.txt");
      await writeFile(list, `${batches.map(concatLine).join("\n")}\n`);
      await runBin(ffmpeg, [...BASE, "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", voice], MIX_TIMEOUT_MS);

      // voice pre-processing: high-pass + gentle speech compression so gain can be added later
      const voiceP = join(cache, "voice-p.wav");
      await runBin(
        ffmpeg,
        [...BASE, "-i", voice, "-af", "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2", ...PCM_F, voiceP],
        MIX_TIMEOUT_MS,
      );

      // optional music, ducked under the voice (threshold relative to the voice loudness)
      let pre = voiceP;
      if (music) {
        const iVoice = (await loudnormPass(voiceP, ctx.env, {})).input_i;
        const threshold = Math.min(1, Math.max(0.000976563, 10 ** ((iVoice - 12) / 20)));
        pre = join(cache, "pre.wav");
        const graph = [
          `[1:a]atrim=0:${t(outDur)},asetpts=PTS-STARTPTS,aresample=${RATE},aformat=channel_layouts=stereo,volume=${musicDb}dB[m]`,
          "[0:a]asplit=2[v1][v2]",
          `[m][v1]sidechaincompress=threshold=${threshold.toFixed(6)}:ratio=8:attack=20:release=300[d]`,
          "[v2][d]amix=inputs=2:duration=first:normalize=0[mixed]",
        ].join(";");
        await runBin(
          ffmpeg,
          [...BASE, "-i", voiceP, "-stream_loop", "-1", "-i", music, "-filter_complex", graph, "-map", "[mixed]", "-t", t(outDur), ...PCM_F, pre],
          MIX_TIMEOUT_MS,
        );
      }

      // deterministic loudness: measure, gain + sample-peak limiter, verify, retry once if short
      const i0 = (await loudnormPass(pre, ctx.env, {})).input_i;
      const render = async (gainDb: number, out: string): Promise<void> => {
        const af = `volume=${gainDb.toFixed(3)}dB,alimiter=limit=0.708:attack=5:release=50:level=false`;
        await runBin(ffmpeg, [...BASE, "-i", pre, "-af", af, ...PCM, out], MIX_TIMEOUT_MS);
      };
      if (target - i0 > MAX_GAIN_DB) throw new Error(`voice too quiet (I0 = ${round(i0, 1)} LUFS)`);
      let gain = target - i0;
      let passes = 1;
      let chosen = join(cache, "pass-1.wav");
      await render(gain, chosen);
      let got = await measureLoudness(chosen, ctx.env);
      if (got.integratedLufs < target - 0.5) {
        gain += target - got.integratedLufs;
        if (gain > MAX_GAIN_DB) throw new Error(`voice too quiet (I0 = ${round(i0, 1)} LUFS)`);
        passes = 2;
        chosen = join(cache, "pass-2.wav");
        await render(gain, chosen);
        got = await measureLoudness(chosen, ctx.env);
      }
      const finalPath = join(ctx.projectDir, "audio", "mix.wav");
      await writeOutputAtomic(finalPath, async (tmp) => {
        await copyFile(chosen, tmp);
      });
      const durationSec = round(await wavDuration(finalPath), 3);
      const metrics = {
        integratedLufs: round(got.integratedLufs, 1),
        truePeakDb: round(got.truePeakDb, 1),
        durationSec,
        driftSec: round(Math.abs(durationSec - edl.outDurationSec), 3),
        segments: keeps.length,
        batches: batches.length,
        passes,
        hasMusic: music !== undefined,
        clamped,
      };
      ctx.log(`mix: ${metrics.segments} segments, ${metrics.integratedLufs} LUFS, ${metrics.truePeakDb} dBTP, ${durationSec}s${music ? " + music" : ""}`);
      return {
        metrics,
        artifacts: ["audio/mix.wav"],
        ...(clamped
          ? {
              failNote: `keep ranges were clamped to the source duration ${round(bound, 3)}s, so the mix is ${durationSec}s while cut/edl.json expects ${edl.outDurationSec}s; re-run cut (mostudio step cut --force) so the edl matches the source`,
            }
          : {}),
      };
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  },
};

export default mix;
