import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { clampKeeps, durationBound, pickH264Encoder, readJson, resolveBin, resolveFfmpeg, runBin, writeOutputAtomic } from "../../../core/src/index.ts";
import type { Range, StepContract, StepModule } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { batchGraph, escapeFilterPath, fitFilter, frameCounts, presetFilter } from "./filters.ts";
import type { Segment } from "./filters.ts";
import { renderCaptions } from "./hyperframes.ts";
import type { Cue } from "./hyperframes.ts";
import { chooseRenderer, presetSize, socialDurationOk } from "./presets.ts";

const BATCH = 60;
/** Files assemble writes into scenes/captions; anything else there is reported before the folder is regenerated. */
const SCENE_FILES = new Set(["index.html", "hyperframes.json", "compositions/captions.html", "assets/cut.mp4"]);
const BASE = ["-hide_banner", "-loglevel", "error", "-y"];
const FF_TIMEOUT_MS = 3_600_000;
const NEEDS = ["trim", "setpts", "split", "fps", "tpad", "concat", "scale", "pad", "setsar"];
/** Seconds of lead-in before a batch's first keep for the input seek (accurate seek decodes from there). */
const SEEK_LEAD = 1;

type Encoder = "h264_videotoolbox" | "libx264";
type Ingest = { file: string; durationSec?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean; hdr?: boolean; colorTransfer?: string };

/** HLG/PQ -> SDR BT.709 (linear light, Hable curve), applied once in the CFR pass. */
export const TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
const t = (n: number): string => n.toFixed(6);

/** One concat-demuxer line; single quotes inside the path are written as '\''. */
const concatLine = (path: string): string => `file '${path.replaceAll("'", "'\\''")}'`;

/** Encoder args: intermediates near-lossless, final at delivery quality; always yuv420p. */
function encodeArgs(enc: Encoder, final: boolean): string[] {
  const q = enc === "h264_videotoolbox" ? ["-c:v", enc, "-q:v", final ? "60" : "70"] : ["-c:v", enc, "-crf", final ? "18" : "12", "-preset", "veryfast"];
  return [...q, "-pix_fmt", "yuv420p"];
}

/** ffmpeg with every needed filter; when libass is what is missing, add the install hint. `candidates` is for tests. */
export async function resolveAssembleFfmpeg(env: Record<string, string | undefined>, needs: string[], candidates?: string[]): Promise<string> {
  try {
    return await resolveFfmpeg(env, needs, candidates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!needs.includes("ass")) throw err;
    throw new Error(`${msg}. Burning captions with ffmpeg needs libass: brew install ffmpeg-full (or use --param captionsRenderer=hyperframes)`);
  }
}

/**
 * ffmpeg for an HDR source: one that also has zscale + tonemap (toneMap true), else a build with only `needs`
 * plus a warning: the render continues untone-mapped. `candidates` is for tests.
 */
export async function resolveHdrFfmpeg(
  env: Record<string, string | undefined>,
  needs: string[],
  candidates?: string[],
): Promise<{ ffmpeg: string; toneMap: boolean; warning?: string }> {
  try {
    return { ffmpeg: await resolveAssembleFfmpeg(env, [...needs, "zscale", "tonemap"], candidates), toneMap: true };
  } catch {
    const ffmpeg = await resolveAssembleFfmpeg(env, needs, candidates);
    return {
      ffmpeg,
      toneMap: false,
      warning: "warning: source is HDR but no ffmpeg build has zscale + tonemap; rendering without tone mapping (colours will look washed out). Install ffmpeg-full: brew install ffmpeg-full",
    };
  }
}

type Probe = { formatStart: number; audioStart?: number };

async function probeStarts(ffprobe: string, file: string): Promise<Probe> {
  const out = await runBin(ffprobe, ["-v", "error", "-show_entries", "format=start_time:stream=codec_type,start_time", "-of", "json", file]);
  const j = JSON.parse(out) as { format?: { start_time?: string }; streams?: { codec_type?: string; start_time?: string }[] };
  const num = (v: string | undefined): number | undefined => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { formatStart: num(j.format?.start_time) ?? 0, audioStart: num(j.streams?.find((s) => s.codec_type === "audio")?.start_time) };
}

/** Fail early when captions.ass was laid out for another aspect ratio than the output (libass would stretch it). */
export async function checkAssSize(assPath: string, width: number, height: number): Promise<void> {
  const text = await readFile(assPath, "utf8");
  const x = Number(/^PlayResX:\s*(\d+)/m.exec(text)?.[1]);
  const y = Number(/^PlayResY:\s*(\d+)/m.exec(text)?.[1]);
  if (!(x > 0 && y > 0)) return;
  if (Math.abs(x / y - width / height) / (width / height) > 0.01) {
    throw new Error(`captions.ass is ${x}x${y} but output is ${width}x${height}: re-run captions with --param width=${width} --param height=${height}`);
  }
}

/** Files under `dir` that assemble does not generate (HyperFrames' own .hyperframes/ is ignored). */
async function foreignFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = e.split(sep).join("/");
    if (rel === ".hyperframes" || rel.startsWith(".hyperframes/") || SCENE_FILES.has(rel)) continue;
    if ([...SCENE_FILES].some((f) => f.startsWith(`${rel}/`))) continue; // a folder we write into
    out.push(rel);
  }
  return out.sort();
}

type Final = { durationSec: number; width: number; height: number; fps: number; avOffsetMs: number; endDriftMs: number };

/** Duration, size, frame rate and the first-video vs first-audio pts offset of the final file. */
async function probeFinal(ffprobe: string, file: string): Promise<Final> {
  const j = JSON.parse(
    await runBin(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", file]),
  ) as { streams: { width: number; height: number; avg_frame_rate: string }[]; format: { duration: string } };
  const s = j.streams[0];
  if (!s) throw new Error(`${file} has no video stream`);
  const [n, d] = s.avg_frame_rate.split("/").map(Number);
  const first = async (stream: string): Promise<number> => {
    const p = JSON.parse(
      await runBin(ffprobe, ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time", "-read_intervals", "%+#8", "-of", "json", file]),
    ) as { packets?: { pts_time?: string }[] };
    const times = (p.packets ?? []).map((x) => Number(x.pts_time)).filter(Number.isFinite);
    if (!times.length) throw new Error(`${file}: no ${stream} packets`);
    return Math.min(...times);
  };
  const [v, a] = [await first("v:0"), await first("a:0")];
  // stream ends (start + duration): picture and sound must stop together
  const ends = JSON.parse(
    await runBin(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", file]),
  ) as { streams?: { codec_type?: string; start_time?: string; duration?: string }[] };
  const end = (type: string): number => {
    const s = ends.streams?.find((x) => x.codec_type === type);
    const v0 = Number(s?.start_time ?? 0);
    const d = Number(s?.duration);
    if (!Number.isFinite(d)) throw new Error(`${file}: no ${type} stream duration`);
    return (Number.isFinite(v0) ? v0 : 0) + d;
  };
  const endDriftMs = round(Math.abs(end("video") - end("audio")) * 1000, 1);
  return {
    endDriftMs,
    durationSec: Number(j.format.duration),
    width: s.width,
    height: s.height,
    fps: n && d ? round(n / d, 2) : 0,
    avOffsetMs: round(Math.abs(a - v) * 1000, 1),
  };
}

export const assemble: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const t0 = performance.now();
    const p = ctx.params;
    const burn = p.burnCaptions !== false;

    const ingest = await readJson<Ingest>(join(ctx.projectDir, "media", "ingest.json"));
    if (!ingest?.file) throw new Error("media/ingest.json has no file");
    if (!ingest.width || !ingest.height || !ingest.fps) throw new Error("media/ingest.json needs width, height and fps");
    const edl = await readJson<{ keep: Range[]; outDurationSec: number; sourceDurationSec?: number }>(join(ctx.projectDir, "cut", "edl.json"));
    if (!edl || !Array.isArray(edl.keep) || edl.keep.length === 0) throw new Error("cut/edl.json has no keep ranges");

    // same clamp as mix, so the video cut matches audio/mix.wav
    const { keep: keeps } = clampKeeps(edl.keep, durationBound(ingest.durationSec, edl.sourceDurationSec));
    if (keeps.length === 0) throw new Error("all keep ranges lie beyond the source duration");
    const outDur = keeps.reduce((a, k) => a + k.end - k.start, 0);

    const fps = round(ingest.fps, 2);
    const size = presetSize(typeof p.preset === "string" ? p.preset : undefined, { width: ingest.width, height: ingest.height });
    const renderer = chooseRenderer({
      preset: size.name,
      outDurationSec: outDur,
      burn,
      param: typeof p.captionsRenderer === "string" ? p.captionsRenderer : undefined,
    });
    if (!socialDurationOk(size.name, outDur)) {
      ctx.log(`assemble: warning: ${size.name} cut is ${round(outDur, 1)} s, over the 180 s limit for ${size.name}; trim it or use --param preset=youtube`);
    }
    if (renderer === "ass") await checkAssSize(join(ctx.projectDir, "captions", "captions.ass"), size.width, size.height);
    const needs = renderer === "ass" ? [...NEEDS, "ass"] : NEEDS;
    let ffmpeg: string;
    let toneMap = false;
    if (ingest.hdr === true) {
      const hdr = await resolveHdrFfmpeg(ctx.env, needs);
      ({ ffmpeg, toneMap } = hdr);
      if (hdr.warning) ctx.log(`assemble: ${hdr.warning}`);
      else ctx.log(`assemble: HDR source (${ingest.colorTransfer ?? "hdr"}): tone-mapping to SDR BT.709`);
    } else {
      ffmpeg = await resolveAssembleFfmpeg(ctx.env, needs);
    }
    const encoder = await pickH264Encoder(ffmpeg, ctx.env);
    const ffprobe = resolveBin("ffprobe", ctx.env);
    const source = join(ctx.projectDir, ingest.file);
    const mixWav = join(ctx.projectDir, "audio", "mix.wav");

    // keep times are on the audio clock (mix re-zeroes the audio stream); video pts are re-zeroed to the
    // format start, so the CFR intermediate is shifted by the audio stream's offset into the file
    const starts = await probeStarts(ffprobe, source);
    const aOff = Math.max(0, (starts.audioStart ?? starts.formatStart) - starts.formatStart);

    const cache = join(ctx.projectDir, "cache", "assemble");
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    await mkdir(join(ctx.projectDir, "renders"), { recursive: true });
    try {
      // 1. one constant-frame-rate, video-only intermediate of the source on the audio clock: every grid time has
      // a frame (VFR gaps are filled with the held frame), so batches can input-seek and count frames safely.
      // It is scaled down into the preset box here, so large sources never produce source-size intermediates.
      const cfrFile = join(cache, "cfr.mp4");
      const lastEnd = Math.max(...keeps.map((k) => k.end));
      const cfrSec = Math.min(lastEnd + 1, typeof ingest.durationSec === "number" && ingest.durationSec > 0 ? ingest.durationSec : Infinity);
      ctx.log(`assemble: CFR intermediate (${round(cfrSec, 1)} s source, fit ${size.width}x${size.height})…`);
      const cfrVf = [`setpts=PTS-${t(aOff)}/TB`, `fps=${fps}:start_time=0`, ...(toneMap ? [TONEMAP] : []), fitFilter(size.width, size.height)].join(",");
      await runBin(
        ffmpeg,
        [...BASE, "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", cfrVf, ...encodeArgs(encoder, false), "-t", t(lastEnd + 1), cfrFile],
        FF_TIMEOUT_MS,
      );

      // 2. video-only cut in batches of <= 60 keeps
      const batchSize = Number(ctx.env.MOSTUDIO_ASSEMBLE_BATCH) > 0 ? Math.floor(Number(ctx.env.MOSTUDIO_ASSEMBLE_BATCH)) : BATCH;
      const frames = frameCounts(keeps, fps);
      const batches: string[] = [];
      const nBatches = Math.ceil(keeps.length / batchSize);
      for (let i = 0; i < keeps.length; i += batchSize) {
        ctx.log(`assemble: batch ${i / batchSize + 1}/${nBatches}`);
        const slice = keeps.slice(i, i + batchSize);
        const counts = frames.slice(i, i + batchSize);
        const first = slice[0];
        if (!first) continue;
        const seek = Math.max(0, first.start - SEEK_LEAD);
        const segments: Segment[] = slice
          .map((k, j) => ({ start: k.start - seek, end: k.end - seek, frames: counts[j] ?? 0 }))
          .filter((s) => s.frames > 0);
        if (segments.length === 0) continue;
        const file = join(cache, `batch-${String(batches.length).padStart(3, "0")}.mp4`);
        await runBin(
          ffmpeg,
          [...BASE, "-ss", t(seek), "-i", cfrFile, "-filter_complex", batchGraph(segments, fps), "-map", "[out]", "-an", ...encodeArgs(encoder, false), file],
          FF_TIMEOUT_MS,
        );
        batches.push(file);
      }
      await rm(cfrFile, { force: true });
      if (batches.length === 0) throw new Error("every keep range is shorter than one frame");
      // the batches are joined by the concat demuxer as the final pass reads them (no joined copy on disk)
      const list = join(cache, "list.txt");
      await writeFile(list, `${batches.map(concatLine).join("\n")}\n`);
      const cut = ["-f", "concat", "-safe", "0", "-i", list];

      // 3. final pass: preset size, captions, mixed audio
      const finalPath = join(ctx.projectDir, "renders", "final.mp4");
      const preset = presetFilter(size.width, size.height, fps);
      const cfr = ["-r", String(fps), "-fps_mode", "cfr"];
      const audio = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];
      const tail = ["-t", t(outDur), "-movflags", "+faststart"];
      if (renderer === "hyperframes") {
        const presetCut = join(cache, "cut-preset.mp4");
        await runBin(ffmpeg, [...BASE, ...cut, "-vf", preset, "-an", ...encodeArgs(encoder, false), ...cfr, "-t", t(outDur), presetCut], FF_TIMEOUT_MS);
        const cues = (await readJson<Cue[]>(join(ctx.projectDir, "captions", "cues.json"))) ?? [];
        if (!Array.isArray(cues)) throw new Error("captions/cues.json is not an array");
        const captioned = join(cache, "captioned.mp4");
        const sceneDir = join(ctx.projectDir, "scenes", "captions");
        const foreign = await foreignFiles(sceneDir);
        if (foreign.length) ctx.log(`assemble: warning: regenerating scenes/captions removes files assemble did not write: ${foreign.join(", ")}`);
        await renderCaptions({
          env: ctx.env,
          sceneDir,
          presetCut,
          cues,
          width: size.width,
          height: size.height,
          fps,
          durationSec: round(outDur, 3),
          out: captioned,
          log: ctx.log,
        });
        const got = Number(await runBin(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", captioned]));
        if (!(Math.abs(got - outDur) <= 0.1)) {
          throw new Error(`HyperFrames render is ${round(got, 3)} s, expected ${round(outDur, 3)} s (scenes/captions)`);
        }
        ctx.log("assemble: final encode (HyperFrames video + mix)…");
        await writeOutputAtomic(finalPath, (tmp) =>
          runBin(ffmpeg, [...BASE, "-i", captioned, "-i", mixWav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...audio, ...tail, tmp], FF_TIMEOUT_MS).then(() => {}),
        );
      } else {
        ctx.log(`assemble: final encode (${round(outDur, 1)} s, ${size.width}x${size.height}, captions ${renderer})…`);
        const vf = renderer === "ass" ? `${preset},ass=filename=${escapeFilterPath(join(ctx.projectDir, "captions", "captions.ass"))}` : preset;
        await writeOutputAtomic(finalPath, (tmp) =>
          runBin(
            ffmpeg,
            [...BASE, ...cut, "-i", mixWav, "-map", "0:v:0", "-map", "1:a:0", "-vf", vf, ...encodeArgs(encoder, true), ...cfr, ...audio, ...tail, tmp],
            FF_TIMEOUT_MS,
          ).then(() => {}),
        );
      }
      await writeOutputAtomic(join(ctx.projectDir, "renders", "final.srt"), (tmp) => copyFile(join(ctx.projectDir, "captions", "captions.srt"), tmp));

      const f = await probeFinal(ffprobe, finalPath);
      const metrics = {
        durationSec: round(f.durationSec, 3),
        durationDeltaSec: round(Math.abs(f.durationSec - edl.outDurationSec), 3),
        avOffsetMs: f.avOffsetMs,
        endDriftMs: f.endDriftMs,
        socialDurationOk: socialDurationOk(size.name, outDur),
        width: f.width,
        height: f.height,
        fps: f.fps,
        batches: batches.length,
        captionsBurned: renderer !== "none",
        captionsRenderer: renderer,
        toneMapped: toneMap,
        encoder,
        renderSec: round((performance.now() - t0) / 1000, 1),
      };
      ctx.log(
        `assemble: ${keeps.length} keeps in ${batches.length} batch(es), ${f.width}x${f.height} @ ${f.fps}, ${metrics.durationSec}s, captions ${renderer}, ${encoder}, ${metrics.renderSec}s`,
      );
      return { metrics, artifacts: ["renders/final.mp4", "renders/final.srt"] };
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  },
};

export default assemble;
