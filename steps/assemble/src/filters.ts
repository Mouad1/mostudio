import type { Range } from "../../../core/src/index.ts";

const t = (n: number): string => n.toFixed(6);

/**
 * A file path as an ffmpeg filter option value (`ass=filename=<this>`), escaped for both parsing levels:
 * the option parser (\ ' :) and then the filter-graph parser (\ ' [ ] , ;). No quotes are used, so a
 * single quote in the path (l'essai) is safe.
 */
export function escapeFilterPath(p: string): string {
  const option = p.replace(/[\\':]/g, "\\$&");
  return option.replace(/[\\'[\],;]/g, "\\$&");
}

/** CFR + scale to fit + black pad + square pixels, applied once in the final pass. */
export function presetFilter(width: number, height: number, fps: number): string {
  return `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

/**
 * Frames each keep gets on the output grid: keep i spans round(O_i*fps)..round(O_{i+1}*fps) where O is the
 * cumulative cut time, so video cuts land within half a frame of the audio cuts and the total is round(total*fps).
 */
export function frameCounts(keeps: Range[], fps: number): number[] {
  let at = 0;
  return keeps.map((k) => {
    const from = Math.round(at * fps);
    at += k.end - k.start;
    return Math.round(at * fps) - from;
  });
}

export type Segment = { start: number; end: number; frames: number };

/**
 * Video-only filter graph for one batch of the constant-frame-rate intermediate (times relative to the batch's
 * input seek). Each segment keeps the grid frames nearest its start and end, is padded by cloning its last frame
 * and cut to exactly `frames` frames, then all are concatenated to [out].
 */
export function batchGraph(segments: Segment[], fps: number): string {
  const n = segments.length;
  const half = 0.5 / fps;
  const tags = segments.map((_, i) => `[s${i}]`).join("");
  const parts = [n > 1 ? `[0:v]split=${n}${tags}` : "[0:v]null[s0]"];
  segments.forEach((s, i) => {
    const a = Math.max(0, s.start - half);
    const b = Math.max(s.end - half, a + 2 * half);
    const pad = Math.max(1, s.end - s.start).toFixed(3);
    parts.push(
      `[s${i}]trim=start=${t(a)}:end=${t(b)},setpts=PTS-STARTPTS,` +
        `tpad=stop_mode=clone:stop_duration=${pad},trim=end_frame=${s.frames},setpts=N/(${fps}*TB)[v${i}]`,
    );
  });
  parts.push(`${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[out]`);
  return parts.join(";");
}
