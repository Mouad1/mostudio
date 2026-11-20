import { runBin } from "./proc.ts";

/** The HyperFrames version used when MOSTUDIO_HYPERFRAMES_BIN is unset. */
const PINNED = ["npx", "--yes", "hyperframes@0.9.26"];
const LINT_TIMEOUT_MS = 600_000;
const RENDER_TIMEOUT_MS = 3_600_000;

/**
 * The HyperFrames CLI: MOSTUDIO_HYPERFRAMES_BIN as a JSON array of strings (paths with spaces) or split on
 * whitespace, else the pinned npx package.
 */
export function hyperframesCommand(env: Record<string, string | undefined>): string[] {
  const custom = env.MOSTUDIO_HYPERFRAMES_BIN?.trim();
  if (!custom) return [...PINNED];
  if (custom.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(custom);
    } catch {
      throw new Error("MOSTUDIO_HYPERFRAMES_BIN starts with [ but is not a JSON array");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((a) => typeof a === "string" && a)) {
      throw new Error("MOSTUDIO_HYPERFRAMES_BIN must be a non-empty JSON array of strings");
    }
    return parsed;
  }
  return custom.split(/\s+/);
}

/** Run the HyperFrames CLI with `args` (no shell). */
async function hyperframes(env: Record<string, string | undefined>, args: string[], timeoutMs: number): Promise<string> {
  const [bin, ...pre] = hyperframesCommand(env);
  if (!bin) throw new Error("MOSTUDIO_HYPERFRAMES_BIN is empty");
  return runBin(bin, [...pre, ...args], timeoutMs);
}

/** `hyperframes lint <sceneDir>`; a failure names the scene folder. */
export async function hyperframesLint(env: Record<string, string | undefined>, sceneDir: string, timeoutMs = LINT_TIMEOUT_MS): Promise<void> {
  await hyperframes(env, ["lint", sceneDir], timeoutMs).catch((e: Error) => {
    throw new Error(`HyperFrames lint failed for ${sceneDir}: ${e.message}`);
  });
}

/** HyperFrames' --fps form: integers as is, fractional rates as hundredths (29.97 -> 2997/100). */
const fpsArg = (fps: number): string => (Number.isInteger(fps) ? String(fps) : `${Math.round(fps * 100)}/100`);

export type HyperframesRenderOptions = {
  fps: number;
  out: string;
  /** Default "looks". */
  quality?: string;
  /** Default "mp4". */
  format?: string;
  timeoutMs?: number;
};

/** `hyperframes render <sceneDir> --quality … --fps … --format … -o <out> --quiet`. */
export async function hyperframesRender(env: Record<string, string | undefined>, sceneDir: string, o: HyperframesRenderOptions): Promise<void> {
  const args = ["render", sceneDir, "--quality", o.quality ?? "looks", "--fps", fpsArg(o.fps), "--format", o.format ?? "mp4", "-o", o.out, "--quiet"];
  await hyperframes(env, args, o.timeoutMs ?? RENDER_TIMEOUT_MS).catch((e: Error) => {
    throw new Error(`HyperFrames render failed: ${e.message}`);
  });
}
