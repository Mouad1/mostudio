import { join } from "node:path";
import { runBin } from "../src/probe.ts";

export type ClipOptions = { seconds: number; width: number; height: number; audio: boolean; rotation?: 90; name?: string };

/** Generate a synthetic clip with ffmpeg (lavfi testsrc2 + sine). */
export async function makeClip(dir: string, o: ClipOptions): Promise<string> {
  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  const out = join(dir, o.name ?? "clip.mp4");
  const plain = o.rotation ? join(dir, `.plain-${o.name ?? "clip.mp4"}`) : out;
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${o.width}x${o.height}:rate=30:duration=${o.seconds}`];
  if (o.audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${o.seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (o.audio) args.push("-c:a", "aac", "-shortest");
  args.push(plain);
  await runBin(ffmpeg, args);
  if (o.rotation) {
    // display_rotation is an input option; remux so the rotation lands in the container metadata
    await runBin(ffmpeg, ["-y", "-v", "error", "-display_rotation", String(o.rotation), "-i", plain, "-c", "copy", out]);
  }
  return out;
}
