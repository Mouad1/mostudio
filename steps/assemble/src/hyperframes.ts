import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBin } from "../../../core/src/index.ts";

export type CueWord = { w: string; start: number; end: number };
export type Cue = { start: number; end: number; text: string; words?: CueWord[] };
export type Composition = { index: string; captions: string; config: string };

const COMPONENT = new URL("../../../components/captions-karaoke/", import.meta.url);
const PINNED = ["npx", "--yes", "hyperframes@0.9.26"];
const RENDER_TIMEOUT_MS = 3_600_000;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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

/** One caption group per cue, clamped to the composition; words become timed spans for the highlight. */
function groups(cues: Cue[], durationSec: number): string {
  const out: string[] = [];
  cues.forEach((c, i) => {
    const start = r3(Math.max(0, c.start));
    const end = r3(Math.min(durationSec, c.end));
    if (!(end - start > 0.001)) return;
    const words = c.words?.length
      ? c.words.map((w) => `<span class="w" data-ws="${r3(w.start)}" data-we="${r3(w.end)}">${esc(w.w)}</span>`)
      : c.text.split(/\s+/).filter(Boolean).map((w) => `<span class="w">${esc(w)}</span>`);
    out.push(`    <div id="cap-${i}" class="cap clip" data-start="${start}" data-duration="${r3(end - start)}">${words.join(" ")}</div>`);
  });
  return out.join("\n");
}

/** Root composition + captions scene + project config for `scenes/captions/`. `video` is relative to the scene dir. */
export async function buildComposition(
  cues: Cue[],
  o: { width: number; height: number; durationSec: number; video: string },
): Promise<Composition> {
  const { width: w, height: h } = o;
  const d = r3(o.durationSec);
  const s = Math.min(w / 1080, h / 1920);
  const [template, css] = await Promise.all([
    readFile(new URL("index.html", COMPONENT), "utf8"),
    readFile(new URL("captions.css", COMPONENT), "utf8"),
  ]);
  const fill: Record<string, string> = {
    WIDTH: String(w),
    HEIGHT: String(h),
    BOTTOM: String(Math.round((340 * h) / 1920)),
    SIDE: String(Math.round(w * 0.08)),
    SIZE: String(Math.round(76 * s)),
    OUTLINE: String(Math.max(2, Math.round(6 * s))),
    GROUPS: groups(cues, d),
  };
  const captions = template
    .replace("/*{{CSS}}*/", () => css.trim())
    .replace(/\{\{([A-Z]+)\}\}/g, (m, k: string) => fill[k] ?? m);
  const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${w}, height=${h}" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #000; }
      #root { position: relative; width: ${w}px; height: ${h}px; }
      #bg { position: absolute; left: 0; top: 0; width: ${w}px; height: ${h}px; object-fit: contain; z-index: 1; }
      #captions { z-index: 2; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="${w}" data-height="${h}" data-no-timeline>
      <video id="bg" class="clip" src="${esc(o.video)}" data-start="0" data-duration="${d}" data-track-index="0" muted playsinline></video>
      <div id="captions" class="clip" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${d}" data-track-index="1" data-track-kind="captions" data-width="${w}" data-height="${h}"></div>
    </div>
  </body>
</html>
`;
  const config = `${JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2)}\n`;
  return { index, captions, config };
}

const fpsArg = (fps: number): string => (Number.isInteger(fps) ? String(fps) : `${Math.round(fps * 100)}/100`);

/**
 * Write `sceneDir` (index.html, compositions/captions.html, hyperframes.json, assets/cut.mp4 moved from
 * `presetCut`), then `lint` and `render --quality looks` it to `out` (video only, preset size).
 */
export async function renderCaptions(o: {
  env: Record<string, string | undefined>;
  sceneDir: string;
  presetCut: string;
  cues: Cue[];
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  out: string;
  log: (msg: string) => void;
}): Promise<void> {
  const c = await buildComposition(o.cues, { width: o.width, height: o.height, durationSec: o.durationSec, video: "assets/cut.mp4" });
  await rm(o.sceneDir, { recursive: true, force: true });
  await mkdir(join(o.sceneDir, "compositions"), { recursive: true });
  await mkdir(join(o.sceneDir, "assets"), { recursive: true });
  const video = join(o.sceneDir, "assets", "cut.mp4");
  await rename(o.presetCut, video).catch(async () => {
    await copyFile(o.presetCut, video);
  });
  await writeFile(join(o.sceneDir, "index.html"), c.index);
  await writeFile(join(o.sceneDir, "compositions", "captions.html"), c.captions);
  await writeFile(join(o.sceneDir, "hyperframes.json"), c.config);

  const [bin, ...pre] = hyperframesCommand(o.env);
  if (!bin) throw new Error("MOSTUDIO_HYPERFRAMES_BIN is empty");
  await runBin(bin, [...pre, "lint", o.sceneDir], 600_000).catch((e: Error) => {
    throw new Error(`HyperFrames lint failed for ${o.sceneDir}: ${e.message}`);
  });
  o.log(`assemble: HyperFrames render of ${o.durationSec}s captions (${o.width}x${o.height})`);
  await runBin(
    bin,
    [...pre, "render", o.sceneDir, "--quality", "looks", "--fps", fpsArg(o.fps), "--format", "mp4", "-o", o.out, "--quiet"],
    RENDER_TIMEOUT_MS,
  ).catch((e: Error) => {
    throw new Error(`HyperFrames render failed: ${e.message}`);
  });
}
