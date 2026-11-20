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

/**
 * Scale down to fit inside width x height keeping the aspect ratio, never up, even dimensions (yuv420p).
 * Applied in the CFR pass so a 4K source never produces 4K intermediates.
 */
export function fitFilter(width: number, height: number): string {
  return `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/**
 * Renumber + CFR + scale to fit + black pad + square pixels, applied once in the final pass to the joined batches.
 * The batches are already exact frame counts on the grid; renumbering first stops the concat demuxer's batch-join
 * timestamps (libx264 B-frame edit lists) from making the CFR step drop a frame at every join (seen on ffmpeg 7.1).
 */
export function presetFilter(width: number, height: number, fps: number): string {
  return `setpts=N/(${fps}*TB),fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
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

export type Segment = { startFrame: number; frames: number };

/** Index on the fps grid of the frame nearest `sec` (ties go to the earlier frame), as a time-based trim would keep. */
export function gridFrame(sec: number, fps: number): number {
  return Math.max(0, Math.ceil(sec * fps - 0.5 - 1e-9));
}

/**
 * Video-only filter graph for one batch of the constant-frame-rate intermediate. Each segment takes exactly
 * `frames` frames from frame `startFrame` (indices relative to the batch's input seek), selected by frame number,
 * not by time: a time window can hold one frame fewer than the cut needs, and padding that by cloning (`tpad`)
 * silently does nothing on ffmpeg 7.1, which lost ~20 % of the frames of short keeps there. `tpad` stays only as a
 * guard for a segment that runs past the end of the intermediate. Segments are concatenated and renumbered to [out].
 */
export function batchGraph(segments: Segment[], fps: number): string {
  const n = segments.length;
  const tags = segments.map((_, i) => `[s${i}]`).join("");
  const parts = [n > 1 ? `[0:v]split=${n}${tags}` : "[0:v]null[s0]"];
  segments.forEach((s, i) => {
    const pad = Math.max(1, s.frames / fps).toFixed(3);
    parts.push(
      `[s${i}]trim=start_frame=${s.startFrame}:end_frame=${s.startFrame + s.frames},setpts=PTS-STARTPTS,` +
        `tpad=stop_mode=clone:stop_duration=${pad},trim=end_frame=${s.frames},setpts=N/(${fps}*TB)[v${i}]`,
    );
  });
  // concat treats a one-frame segment as zero-length, so the next segment's first frame repeats its timestamp and
  // the muxer drops it (a cut of 1-2 frame keeps lost a third of its frames); renumbering after concat keeps every frame
  parts.push(`${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[c]`);
  parts.push(`[c]setpts=N/(${fps}*TB)[out]`);
  return parts.join(";");
}
