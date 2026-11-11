import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const TIMEOUT_MS = 120_000;

export type BinName = "ffmpeg" | "ffprobe" | "whisper-cli";

const BIN_ENV: Record<BinName, string> = {
  ffmpeg: "FFMPEG",
  ffprobe: "FFPROBE",
  "whisper-cli": "WHISPER_CLI",
};

/** Path of an external binary: its env override (FFMPEG, FFPROBE, WHISPER_CLI) or its bare name. Empty = unset. */
export function resolveBin(name: BinName, env: Record<string, string | undefined>): string {
  return env[BIN_ENV[name]] || name;
}

type Captured = { stdout: string; stderr: string };

function execCapture(bin: string, args: string[], timeoutMs: number): Promise<Captured> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") {
        return reject(new Error(`${bin} not found; install it or set FFMPEG / FFPROBE / WHISPER_CLI in .env.local`));
      }
      if (e.killed) return reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      reject(new Error(`${bin} failed: ${String(stderr).trim().split("\n").slice(-3).join(" ") || e.message}`));
    });
  });
}

/** Run a binary without a shell; fail with a message naming the binary when missing, slow or failing. */
export async function runBin(bin: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return (await execCapture(bin, args, timeoutMs)).stdout;
}

/** Like runBin but also returns stderr (e.g. ffmpeg's loudnorm JSON report). */
export function runBinCapture(bin: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<Captured> {
  return execCapture(bin, args, timeoutMs);
}

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const filterCache = new Map<string, Promise<Set<string> | undefined>>();

/** Clear the per-process filter probe cache (tests). */
export function _resetFfmpegCache(): void {
  filterCache.clear();
}

/** Filter names a build offers, or undefined when it cannot be run. */
function probeFilters(bin: string): Promise<Set<string> | undefined> {
  let hit = filterCache.get(bin);
  if (!hit) {
    hit = runBin(bin, ["-hide_banner", "-filters"], 30_000).then(
      (out) => {
        const names = new Set<string>();
        for (const line of out.split("\n")) {
          const m = /^\s*[A-Z.|]{2,4}\s+(\S+)\s/.exec(line);
          if (m?.[1] && m[1] !== "=") names.add(m[1]);
        }
        return names;
      },
      () => undefined,
    );
    filterCache.set(bin, hit);
  }
  return hit;
}

/**
 * First ffmpeg (FFMPEG env, ffmpeg-full, PATH) whose `-filters` lists every name in `needs`.
 * `candidates` overrides the fallbacks after FFMPEG (tests).
 */
export async function resolveFfmpeg(
  env: Record<string, string | undefined>,
  needs: string[],
  candidates?: string[],
): Promise<string> {
  const list: string[] = [];
  if (env.FFMPEG) list.push(env.FFMPEG);
  for (const c of candidates ?? [FFMPEG_FULL, "ffmpeg"]) {
    if (c === FFMPEG_FULL && !existsSync(c)) continue;
    if (!list.includes(c)) list.push(c);
  }
  const report: string[] = [];
  for (const bin of list) {
    const have = await probeFilters(bin);
    if (!have) {
      report.push(`${bin}: not found`);
      continue;
    }
    const lacking = needs.filter((n) => !have.has(n));
    if (lacking.length === 0) return bin;
    report.push(`${bin}: missing filters ${lacking.join(", ")}`);
  }
  throw new Error(`no ffmpeg build has the needed filters (${needs.join(", ")}). Tried: ${report.join("; ")}`);
}

/** h264_videotoolbox when `-encoders` lists it, else libx264; MOSTUDIO_ENCODER=libx264 forces software. */
export async function pickH264Encoder(
  ffmpeg: string,
  env: Record<string, string | undefined> = process.env,
): Promise<"h264_videotoolbox" | "libx264"> {
  if (env.MOSTUDIO_ENCODER === "libx264") return "libx264";
  const out = await runBin(ffmpeg, ["-hide_banner", "-encoders"], 30_000);
  return /\bh264_videotoolbox\b/.test(out) ? "h264_videotoolbox" : "libx264";
}
