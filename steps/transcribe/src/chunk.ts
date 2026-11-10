import { quietestPoint } from "../../../core/src/index.ts";
import type { Range } from "../../../core/src/index.ts";

export const CHUNK_SEC = 600;
export const SPLIT_SLACK_SEC = 10;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Split `durationSec` of audio into chunks of about 600 s. Each cut sits at the quietest point within
 * +-10 s of a 600 s mark (so a chunk may run up to 610 s); no split when the total is <= 600 s.
 * `env` is the RMS envelope (dBFS) with `windowMs` per entry.
 */
export function planChunks(durationSec: number, env: Float32Array, windowMs: number): Range[] {
  const cuts: number[] = [];
  for (let mark = CHUNK_SEC; mark + SPLIT_SLACK_SEC < durationSec; mark += CHUNK_SEC) {
    cuts.push(round3(quietestPoint(env, windowMs, mark - SPLIT_SLACK_SEC, mark + SPLIT_SLACK_SEC)));
  }
  const edges = [0, ...cuts, durationSec];
  const out: Range[] = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push({ start: edges[i] as number, end: edges[i + 1] as number });
  return out;
}
