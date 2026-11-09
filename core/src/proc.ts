import { execFile } from "node:child_process";

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

/** Run a binary without a shell; fail with a message naming the binary when missing, slow or failing. */
export function runBin(bin: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") {
        return reject(new Error(`${bin} not found; install it or set FFMPEG / FFPROBE / WHISPER_CLI in .env.local`));
      }
      if (e.killed) return reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      reject(new Error(`${bin} failed: ${String(stderr).trim().split("\n").slice(-3).join(" ") || e.message}`));
    });
  });
}
