import { quietestPoint } from "../../../core/src/index.ts";
import type { Range } from "../../../core/src/index.ts";

export const CHUNK_SEC = 600;
export const SPLIT_SLACK_SEC = 10;
/** Darija mode: short windows so each one can pick its own pass (forced Arabic or auto language). */
export const WINDOW_SEC = 30;
export const WINDOW_SLACK_SEC = 5;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Split `durationSec` of audio into chunks of about `chunkSec` (default 600 s). Each cut sits at the quietest point
 * within +-`slackSec` (default 10 s) of a chunk mark (so a chunk may run up to 610 s); no split when the total is
 * <= `chunkSec`. `env` is the RMS envelope (dBFS) with `windowMs` per entry.
 */
export function planChunks(
  durationSec: number,
  env: Float32Array,
  windowMs: number,
  chunkSec: number = CHUNK_SEC,
  slackSec: number = SPLIT_SLACK_SEC,
): Range[] {
  const cuts: number[] = [];
  for (let mark = chunkSec; mark + slackSec < durationSec; mark += chunkSec) {
    cuts.push(round3(quietestPoint(env, windowMs, mark - slackSec, mark + slackSec)));
  }
  const edges = [0, ...cuts, durationSec];
  const out: Range[] = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push({ start: edges[i] as number, end: edges[i + 1] as number });
  return out;
}
