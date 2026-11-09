// Spike S2: HyperFrames scene -> clip -> ffmpeg assembly (concat, ASS captions, loudnorm).
// Run from repo root: node spikes/s2-render/run.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const media = join(here, "media");
const sceneDir = join(here, "scene");
const out = {
  scene: join(media, "scene.mp4"),
  alpha: join(media, "scene-alpha.webm"),
  standin: join(media, "standin.mp4"),
  voice: join(media, "voice.wav"),
  ass: join(media, "captions.ass"),
  final: join(media, "final.mp4"),
};
const commands: string[] = [];

// The default Homebrew ffmpeg lacks libass (no `ass` filter). Prefer an ffmpeg-full build when present.
const FULL = "/opt/homebrew/opt/ffmpeg-full/bin";
const FFMPEG = process.env.FFMPEG ?? (existsSync(`${FULL}/ffmpeg`) ? `${FULL}/ffmpeg` : "ffmpeg");
const FFPROBE = process.env.FFPROBE ?? (existsSync(`${FULL}/ffprobe`) ? `${FULL}/ffprobe` : "ffprobe");

type Run = { code: number | null; stdout: string; stderr: string; seconds: number };

function run(cmd: string, args: string[], cwd: string = root): Promise<Run> {
  commands.push(`${cmd} ${args.map((a) => (/[\s;|\[\]]/.test(a) ? `'${a}'` : a)).join(" ")}`.replaceAll(`${root}/`, ""));
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const p = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr, seconds: (performance.now() - t0) / 1000 }));
  });
}

async function must(cmd: string, args: string[], cwd?: string): Promise<Run> {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0) throw new Error(`${cmd} failed (${r.code}): ${r.stderr.slice(-800)}`);
  return r;
}

const ff = (...a: string[]) => must(FFMPEG, ["-hide_banner", "-y", "-loglevel", "error", ...a]);

async function probeJson(file: string, extra: string[]): Promise<any> {
  const r = await must(FFPROBE, ["-v", "error", "-of", "json", ...extra, file]);
  return JSON.parse(r.stdout);
}

async function firstPacketPts(file: string, stream: "v:0" | "a:0"): Promise<number> {
  const j = await probeJson(file, ["-select_streams", stream, "-show_entries", "packet=pts_time", "-read_intervals", "%+#5"]);
  const times = (j.packets as { pts_time: string }[]).map((p) => Number(p.pts_time));
  return Math.min(...times);
}

async function measureLoudness(file: string): Promise<number> {
  const r = await must(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.stderr);
  if (!m) throw new Error("no ebur128 summary");
  return Number(m[1]);
}

mkdirSync(media, { recursive: true });

// (a) render the HyperFrames scene (timed). --quality looks is the default tier.
const render = await must("npx", ["hyperframes", "render", sceneDir, "--quality", "looks", "--fps", "30", "--format", "mp4", "-o", out.scene, "--quiet"]);
const renderSeconds = render.seconds;

// (a2) alpha probe: WebM renders with transparency per the CLI docs.
const alphaRun = await run("npx", ["hyperframes", "render", sceneDir, "--quality", "draft", "--fps", "30", "--format", "webm", "-o", out.alpha, "--quiet"]);
let alphaPixFmt = "n/a";
let alphaTag = "n/a";
if (alphaRun.code === 0) {
  const s = await probeJson(out.alpha, ["-select_streams", "v:0", "-show_entries", "stream=pix_fmt,codec_name:stream_tags=alpha_mode"]);
  alphaPixFmt = String(s.streams[0].pix_fmt);
  alphaTag = String(s.streams[0].tags?.ALPHA_MODE ?? s.streams[0].tags?.alpha_mode ?? "none");
}

// (b) stand-in talking head (10 s testsrc2) and a 5 s test voice (sine).
await ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", out.standin);
await ff("-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000", "-c:a", "pcm_s16le", out.voice);

// (c) captions (ASS), concat, two-pass loudnorm to -14 LUFS.
writeFileSync(
  out.ass,
  [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Outline,Shadow,Alignment,MarginL,MarginR,MarginV",
    "Style: Cap,Arial,84,&H00FFFFFF,&H00000000,&H80000000,1,6,0,2,60,60,260", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    "Dialogue: 0,0:00:01.00,0:00:04.00,Cap,,0,0,0,,Captions burned in by ffmpeg",
    "",
  ].join("\n"),
);

const LUFS_TARGET = -14;
const lnBase = `I=${LUFS_TARGET}:TP=-1.5:LRA=11`;
// Audio bed: voice at t=0 plus a quiet pink-noise bed for the full 15 s, mixed.
const audioGraph = "[1:a]apad=whole_dur=15[vo];anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=15[n];[vo][n]amix=inputs=2:duration=longest:normalize=0";
const pass1 = await must(FFMPEG, [
  "-hide_banner", "-nostats", "-i", out.standin, "-i", out.voice, "-filter_complex",
  `${audioGraph},loudnorm=${lnBase}:print_format=json[a]`, "-map", "[a]", "-f", "null", "-",
]);
const ln = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/s.exec(pass1.stderr)![0]) as Record<string, string>;
const lnMeasured = `measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true`;

const videoGraph =
  "[0:v]fps=30,format=yuv420p,setsar=1[a0];[2:v]fps=30,scale=1080:1920,format=yuv420p,setsar=1[a1];" +
  "[a0][a1]concat=n=2:v=1:a=0[cat];[cat]ass=spikes/s2-render/media/captions.ass[v]";
await ff(
  "-i", out.standin, "-i", out.voice, "-i", out.scene, "-filter_complex",
  `${videoGraph};${audioGraph},loudnorm=${lnBase}:${lnMeasured}:print_format=summary,aresample=48000[a]`,
  "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "192k", "-t", "15", "-movflags", "+faststart", out.final,
);

// (d) probe.
const vs = await probeJson(out.final, ["-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,codec_name:format=duration"]);
const [fn, fd] = String(vs.streams[0].avg_frame_rate).split("/").map(Number);
const lufs = await measureLoudness(out.final);
const vPts = await firstPacketPts(out.final, "v:0");
const aPts = await firstPacketPts(out.final, "a:0");
const offsetMs = (aPts - vPts) * 1000;
const duration = Number(vs.format.duration);

const checks = {
  size: vs.streams[0].width === 1080 && vs.streams[0].height === 1920,
  fps: Math.abs(fn / fd - 30) < 0.01,
  duration: Math.abs(duration - 15) <= 0.1,
  lufs: Math.abs(lufs - LUFS_TARGET) <= 1,
  offset: Math.abs(offsetMs) < 40,
};

const report = `# S2 render spike report

Generated by \`node spikes/s2-render/run.ts\` on ${new Date().toISOString()}.
ffmpeg: ${FFMPEG} (needs libass for the \`ass\` filter).
HyperFrames CLI via \`npx hyperframes\` (Apache 2.0, external CLI only).

## Measured

| Metric | Value | Expected | Pass |
| --- | --- | --- | --- |
| HyperFrames render time (5 s scene, --quality looks) | ${renderSeconds.toFixed(1)} s | n/a | n/a |
| Output size | ${vs.streams[0].width}x${vs.streams[0].height} | 1080x1920 | ${checks.size} |
| FPS | ${(fn / fd).toFixed(3)} | 30 | ${checks.fps} |
| Duration | ${duration.toFixed(3)} s | 15 +/- 0.1 | ${checks.duration} |
| Integrated loudness (ebur128) | ${lufs.toFixed(1)} LUFS | -14 +/- 1 | ${checks.lufs} |
| A/V start offset (first audio pts - first video pts) | ${offsetMs.toFixed(1)} ms | < 40 | ${checks.offset} |
| Alpha WebM render (draft) | exit ${alphaRun.code}, pix_fmt ${alphaPixFmt}, ALPHA_MODE ${alphaTag}, ${alphaRun.seconds.toFixed(1)} s | n/a | n/a |

Loudnorm pass 1 (before): input_i ${ln.input_i}, input_tp ${ln.input_tp}, input_lra ${ln.input_lra}.

## Exact commands

\`\`\`
# all commands run from the repo root\n${commands.join("\n")}
\`\`\`
`;
writeFileSync(join(here, "report.md"), report);
console.log(report);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
