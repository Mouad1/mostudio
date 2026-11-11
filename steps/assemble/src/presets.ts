export type PresetSize = { name: string; width: number; height: number };
export type Renderer = "ass" | "hyperframes" | "none";

const FIXED: Record<string, [number, number]> = {
  youtube: [1920, 1080],
  shorts: [1080, 1920],
  reels: [1080, 1920],
  tiktok: [1080, 1920],
};
/** Vertical social presets whose short cuts get HyperFrames captions by default. */
const SOCIAL = new Set(["shorts", "reels", "tiktok"]);
export const HYPERFRAMES_MAX_SEC = 180;

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Output size for a preset; `source` (the default) keeps the displayed ingest size, rounded down to even for yuv420p. */
export function presetSize(preset: string | undefined, ingest: { width: number; height: number }): PresetSize {
  const name = preset ?? "source";
  if (name === "source") return { name, width: even(ingest.width), height: even(ingest.height) };
  const size = FIXED[name];
  if (!size) throw new Error(`unknown preset "${name}" (use source, youtube, shorts, reels or tiktok)`);
  return { name, width: size[0], height: size[1] };
}

/** Caption renderer: none when not burning, the param when given, else hyperframes for short social cuts, else ass. */
export function chooseRenderer(o: { preset: string; outDurationSec: number; burn: boolean; param?: string }): Renderer {
  if (!o.burn) return "none";
  if (o.param !== undefined) {
    if (o.param !== "ass" && o.param !== "hyperframes") throw new Error(`captionsRenderer must be "ass" or "hyperframes", got "${o.param}"`);
    return o.param;
  }
  return SOCIAL.has(o.preset) && o.outDurationSec <= HYPERFRAMES_MAX_SEC ? "hyperframes" : "ass";
}

/** False for a vertical social preset whose cut runs past 180 s (Shorts/Reels/TikTok length limits). */
export function socialDurationOk(preset: string, outDurationSec: number): boolean {
  return !(SOCIAL.has(preset) && outDurationSec > HYPERFRAMES_MAX_SEC);
}
