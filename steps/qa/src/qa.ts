import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateGate, measureLoudness, resolveBin, resolveFfmpeg, runBin, runBinCapture, writeOutputAtomic } from "../../../core/src/index.ts";
import type { StepContract, StepModule, Threshold } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };

const FRAMES = 12;
const BLACK_WINDOW_SEC = 2;
const SILENCE_WINDOW_SEC = 1;
/** A run counts as "at the start" when it begins within this many seconds of 0. */
const START_TOLERANCE_SEC = 0.05;
const NEEDS = ["blackdetect", "silencedetect", "fps", "tpad", "scale", "tile"];
const SILENT_DB = -70;
const BASE = ["-hide_banner", "-nostats", "-y"];
const QA_TIMEOUT_MS = 600_000;

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

/** End of a black run that starts at the very beginning (stderr of blackdetect); 0 when none. `windowSec` stands in for a run that never ends. */
export function parseBlackStart(stderr: string, windowSec: number): number {
  for (const m of stderr.matchAll(/black_start:(-?[\d.]+)(?:\s+black_end:(-?[\d.]+))?/g)) {
    if (Number(m[1]) <= START_TOLERANCE_SEC) return round(m[2] === undefined ? windowSec : Number(m[2]), 3);
  }
  return 0;
}

/** End of a silence run that starts at the very beginning (stderr of silencedetect); 0 when none. A run with no end lasts the whole window. */
export function parseSilentStart(stderr: string, windowSec: number): number {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.e+-]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.e+-]+)/g)].map((m) => Number(m[1]));
  const i = starts.findIndex((s) => s <= START_TOLERANCE_SEC);
  if (i < 0) return 0;
  const end = ends[i];
  return round(end === undefined ? windowSec : Math.min(end, windowSec), 3);
}

type Level = "pass" | "warn" | "fail";

/** Verdict of one gate metric: its threshold's level when it misses, else pass. */
function level(metrics: Record<string, number | boolean>, metric: string): Level {
  const t = (contract.gate as Threshold[]).filter((g) => g.metric === metric);
  const { verdicts } = evaluateGate(metrics, t);
  const bad = verdicts.find((v) => !v.ok);
  return bad ? (bad.threshold.level === "warn" ? "warn" : "fail") : "pass";
}

export function reportMarkdown(info: {
  file: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  silentAudio: boolean;
  metrics: Record<string, number | boolean>;
}): string {
  const { metrics: m } = info;
  const row = (name: string, metric: string, unit: string): string =>
    `| ${name} | ${m[metric]}${unit} | ${level(m, metric)} |`;
  return [
    "# QA report",
    "",
    `- File: ${info.file}`,
    `- Duration: ${info.durationSec} s`,
    `- Resolution: ${info.width}x${info.height}`,
    "",
    "## Measured",
    "",
    "| Check | Value | Result |",
    "| --- | --- | --- |",
    row("Black opening (blackStartSec)", "blackStartSec", " s"),
    row("Silent opening (silentStartSec)", "silentStartSec", " s"),
    row("Integrated loudness (integratedLufs)", "integratedLufs", " LUFS"),
    `| True peak (truePeakDb) | ${m.truePeakDb} dBTP | info |`,
    "",
    ...(!info.hasAudio
      ? ["> FAIL: the render has no audio track. Silent opening and loudness are reported as worst case (-70 LUFS).", ""]
      : info.silentAudio
        ? ["> FAIL: the audio is digitally silent, so loudness could not be measured and is reported as -70 LUFS.", ""]
        : []),
    "## Contact sheet",
    "",
    `![Contact sheet](contact-sheet.jpg) (${m.contactSheetFrames} frames, [contact-sheet.jpg](contact-sheet.jpg))`,
    "",
    "## Rubric (fill in)",
    "",
    "| Item | Target | Score |",
    "| --- | --- | --- |",
    "| Hook clear in 3 s | yes / no | |",
    "| Pacing | 1-5 | |",
    "| Caption errors per minute | <= 2 | |",
    `| Loudness | -14 LUFS +-1 LU | ${m.integratedLufs} LUFS (auto) |`,
    "| Notes | | |",
    "",
  ].join("\n");
}

export const qa: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const input = join(ctx.projectDir, "renders", "final.mp4");
    const ffmpeg = await resolveFfmpeg(ctx.env, NEEDS);
    const ffprobe = resolveBin("ffprobe", ctx.env);

    const probe = JSON.parse(
      await runBin(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", input]),
    ) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const duration = Number(probe.format?.duration);
    const width = probe.streams?.[0]?.width;
    const height = probe.streams?.[0]?.height;
    if (!Number.isFinite(duration) || duration <= 0 || !width || !height) throw new Error("renders/final.mp4 has no readable video stream or duration");

    // Windows are capped at the file length so short renders are still checked.
    const blackWin = Math.min(BLACK_WINDOW_SEC, duration);
    const silenceWin = Math.min(SILENCE_WINDOW_SEC, duration);
    const black = await runBinCapture(
      ffmpeg,
      [...BASE, "-i", input, "-t", String(blackWin), "-vf", "blackdetect=d=0.05:pix_th=0.10", "-an", "-f", "null", "-"],
      QA_TIMEOUT_MS,
    );
    const hasAudio = (await runBin(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", input])).trim() !== "";
    let silentStartSec = silenceWin;
    let loud = { integratedLufs: SILENT_DB, truePeakDb: SILENT_DB };
    let silentAudio = false;
    if (hasAudio) {
      const silence = await runBinCapture(
        ffmpeg,
        [...BASE, "-i", input, "-t", String(silenceWin), "-af", "silencedetect=n=-50dB:d=0.1", "-vn", "-f", "null", "-"],
        QA_TIMEOUT_MS,
      );
      silentStartSec = parseSilentStart(silence.stderr, silenceWin);
      try {
        loud = await measureLoudness(input, ctx.env);
      } catch (e) {
        // digital silence: loudnorm reports -inf, which the core parser rejects
        if (!/no usable input_i/.test(String((e as Error).message))) throw e;
        silentAudio = true;
      }
    }

    // 12 evenly spaced frames: seek half a step in, then sample at 12/duration fps (last frame cloned if rounding drops one), tiled 4x3 at 400 px each (1600 wide).
    await mkdir(join(ctx.projectDir, "renders"), { recursive: true });
    const vf = `fps=${(FRAMES / duration).toFixed(6)},tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},scale=400:-2,tile=4x3`;
    await writeOutputAtomic(join(ctx.projectDir, "renders", "contact-sheet.jpg"), async (tmp) => {
      await runBin(ffmpeg, [...BASE, "-loglevel", "error", "-ss", (duration / (2 * FRAMES)).toFixed(6), "-i", input, "-an", "-vf", vf, "-frames:v", "1", "-q:v", "3", "-f", "image2", tmp], QA_TIMEOUT_MS);
    });

    const metrics = {
      blackStartSec: parseBlackStart(black.stderr, blackWin),
      silentStartSec,
      integratedLufs: round(loud.integratedLufs, 1),
      truePeakDb: round(loud.truePeakDb, 1),
      contactSheetFrames: FRAMES,
      durationSec: round(duration, 3),
      hasAudio,
    };
    const md = reportMarkdown({ file: "renders/final.mp4", durationSec: metrics.durationSec, width, height, hasAudio, silentAudio, metrics });
    await writeOutputAtomic(join(ctx.projectDir, "renders", "qa.md"), (tmp) => writeFile(tmp, md));
    ctx.log(`qa: black ${metrics.blackStartSec}s, silent ${metrics.silentStartSec}s, ${metrics.integratedLufs} LUFS, ${metrics.truePeakDb} dBTP`);
    return { metrics, artifacts: ["renders/contact-sheet.jpg", "renders/qa.md"] };
  },
};

export default qa;
