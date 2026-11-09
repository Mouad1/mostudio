import { execFile } from "node:child_process";

const TIMEOUT_MS = 120_000;

export type ProbeResult = {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
  audioChannels: number;
  videoCodec: string;
  audioCodec?: string;
};

/** Run a binary without a shell; fail with a message naming the binary when missing or slow. */
export function runBin(bin: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") return reject(new Error(`${bin} not found; install ffmpeg or set the FFMPEG/FFPROBE env var`));
      if (e.killed) return reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      reject(new Error(`${bin} failed: ${String(stderr).trim().split("\n").slice(-3).join(" ") || e.message}`));
    });
  });
}

type Stream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
};

function parseRate(rate: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(rate ?? "");
  if (!m) return 0;
  const den = Number(m[2]);
  if (den === 0) return 0;
  const v = Number(m[1]) / den;
  return Number.isFinite(v) ? v : 0;
}

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

function rotationOf(v: Stream): number {
  const raw = v.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? Number(v.tags?.rotate ?? 0);
  const deg = Number.isFinite(raw) ? Math.round(Math.abs(raw) / 90) * 90 : 0;
  return deg % 360;
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await runBin(process.env.FFPROBE ?? "ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file,
  ]);
  const data = JSON.parse(out) as { streams?: Stream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  let fps = parseRate(video?.avg_frame_rate);
  if (fps === 0) fps = parseRate(video?.r_frame_rate);
  const rotation = video ? rotationOf(video) : 0;
  const w = video?.width ?? 0;
  const h = video?.height ?? 0;
  const swap = rotation === 90 || rotation === 270;
  const result: ProbeResult = {
    durationSec: round(Number.isFinite(duration) ? duration : 0, 3),
    fps: round(fps, 3),
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    hasAudio: audio !== undefined,
    audioChannels: audio?.channels ?? 0,
    videoCodec: video?.codec_name ?? "",
  };
  if (audio?.codec_name) result.audioCodec = audio.codec_name;
  return result;
}
