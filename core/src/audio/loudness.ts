import { resolveFfmpeg, runBinCapture } from "../proc.ts";

export type Loudness = { integratedLufs: number; truePeakDb: number };

/** Numeric fields of the JSON block `loudnorm=print_format=json` prints on stderr. */
export type LoudnormStats = {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
};

/** Parse the trailing JSON block of ffmpeg's loudnorm report. */
export function parseLoudnorm(stderr: string): LoudnormStats {
  const end = stderr.lastIndexOf("}");
  const start = end < 0 ? -1 : stderr.lastIndexOf("{", end);
  if (start < 0) throw new Error("loudnorm printed no measurement block");
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch {
    throw new Error("loudnorm printed an unreadable measurement block");
  }
  const out: Record<string, number> = {};
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v)) throw new Error(`loudnorm measurement has no usable ${k} (silent audio?)`);
    out[k] = v;
  }
  return out as LoudnormStats;
}

/** Run the loudnorm measurement pass on a media file (optionally with a filter chain before it). */
export async function loudnormPass(
  file: string,
  env: Record<string, string | undefined>,
  opts: { prefilter?: string } = {},
): Promise<LoudnormStats> {
  const ffmpeg = await resolveFfmpeg(env, ["loudnorm"]);
  const af = `${opts.prefilter ? `${opts.prefilter},` : ""}loudnorm=I=-14:TP=-1:LRA=50:print_format=json`;
  const { stderr } = await runBinCapture(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", af, "-f", "null", "-"], 600_000);
  return parseLoudnorm(stderr);
}

/** Integrated loudness (LUFS) and true peak (dBTP) of an audio file. */
export async function measureLoudness(file: string, env: Record<string, string | undefined>): Promise<Loudness> {
  const s = await loudnormPass(file, env);
  return { integratedLufs: s.input_i, truePeakDb: s.input_tp };
}
