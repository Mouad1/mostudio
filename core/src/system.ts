import { readdirSync } from "node:fs";
import { resolveBin, runBin } from "./proc.ts";

export type CheckName =
  | "node"
  | "ffmpeg"
  | "ffprobe"
  | "captions-burn"
  | "whisper"
  | "animated-captions";

export type Check = {
  name: CheckName;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
};

export type SystemDeps = {
  nodeVersion: string;
  packaged: boolean;
  run: (bin: string, args: string[]) => Promise<string>;
  listDir: (path: string) => string[];
};

export function versionAtLeast(actual: string, min: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const a = parse(actual);
  const m = parse(min);
  const len = Math.max(a.length, m.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

export async function checkSystem(
  env: Record<string, string | undefined>,
  deps?: Partial<SystemDeps>,
): Promise<Check[]> {
  const nodeVersion = deps?.nodeVersion ?? process.version;
  const packaged = deps?.packaged ?? (env.MOSTUDIO_PACKAGED === "1");
  const run = deps?.run ?? ((bin: string, args: string[]) => runBin(bin, args, 15_000));
  const listDir =
    deps?.listDir ??
    ((path: string) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    });

  const checkNode = async (): Promise<Check> => {
    const ok = versionAtLeast(nodeVersion, "22.18");
    return {
      name: "node",
      label: "App runtime",
      ok,
      required: true,
      detail: nodeVersion,
      fix: ok
        ? undefined
        : packaged
          ? "Reinstall mostudio: download the latest zip and replace the folder."
          : "install Node 22.18 or newer from nodejs.org",
    };
  };

  const checkFfmpeg = async (): Promise<Check> => {
    const bin = resolveBin("ffmpeg", env);
    try {
      const out = await run(bin, ["-version"]);
      return {
        name: "ffmpeg",
        label: "Video engine (ffmpeg)",
        ok: true,
        required: true,
        detail: out.split("\n")[0].trim(),
      };
    } catch (err) {
      return {
        name: "ffmpeg",
        label: "Video engine (ffmpeg)",
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : String(err),
        fix: packaged
          ? "Reinstall mostudio: download the latest zip and replace the folder."
          : "brew install ffmpeg",
      };
    }
  };

  const checkFfprobe = async (): Promise<Check> => {
    const bin = resolveBin("ffprobe", env);
    try {
      const out = await run(bin, ["-version"]);
      return {
        name: "ffprobe",
        label: "Media reader (ffprobe)",
        ok: true,
        required: true,
        detail: out.split("\n")[0].trim(),
      };
    } catch (err) {
      return {
        name: "ffprobe",
        label: "Media reader (ffprobe)",
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : String(err),
        fix: packaged
          ? "Reinstall mostudio: download the latest zip and replace the folder."
          : "brew install ffmpeg",
      };
    }
  };

  const checkCaptionsBurn = async (): Promise<Check> => {
    const bin = resolveBin("ffmpeg", env);
    try {
      const out = await run(bin, ["-hide_banner", "-filters"]);
      if (out.includes(" ass ")) {
        return {
          name: "captions-burn",
          label: "Caption burn-in",
          ok: true,
          required: true,
          detail: "libass filter available",
        };
      }
    } catch {
      // fall through
    }
    return {
      name: "captions-burn",
      label: "Caption burn-in",
      ok: false,
      required: true,
      detail: "captions burn needs libass; HyperFrames captions still work",
      fix: packaged
        ? "Reinstall mostudio: download the latest zip and replace the folder."
        : "brew install ffmpeg-full",
    };
  };

  const checkWhisper = async (): Promise<Check> => {
    const bin = resolveBin("whisper-cli", env);
    try {
      await run(bin, ["--help"]);
    } catch (err) {
      return {
        name: "whisper",
        label: "Offline transcription (optional)",
        ok: false,
        required: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: "Optional. Cloud transcription works without it.",
      };
    }

    const modelsDir = env.WHISPER_MODELS_DIR;
    if (!modelsDir) {
      return {
        name: "whisper",
        label: "Offline transcription (optional)",
        ok: false,
        required: false,
        detail: "WHISPER_MODELS_DIR not set",
        fix: "Optional. Cloud transcription works without it.",
      };
    }

    try {
      const files = listDir(modelsDir);
      const models = files.filter((f) => /^ggml-.*\.bin$/.test(f));
      if (models.length > 0) {
        return {
          name: "whisper",
          label: "Offline transcription (optional)",
          ok: true,
          required: false,
          detail: `${models.length} model(s) found in ${modelsDir}`,
        };
      }
      return {
        name: "whisper",
        label: "Offline transcription (optional)",
        ok: false,
        required: false,
        detail: `no ggml-*.bin models found in ${modelsDir}`,
        fix: "Optional. Cloud transcription works without it.",
      };
    } catch (err) {
      return {
        name: "whisper",
        label: "Offline transcription (optional)",
        ok: false,
        required: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: "Optional. Cloud transcription works without it.",
      };
    }
  };

  const checkAnimatedCaptions = async (): Promise<Check> => {
    try {
      await run("npx", ["--version"]);
      return {
        name: "animated-captions",
        label: "Animated captions (optional)",
        ok: true,
        required: false,
        detail: "downloads its renderer the first time; needs internet",
      };
    } catch (err) {
      return {
        name: "animated-captions",
        label: "Animated captions (optional)",
        ok: false,
        required: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return Promise.all([
    checkNode(),
    checkFfmpeg(),
    checkFfprobe(),
    checkCaptionsBurn(),
    checkWhisper(),
    checkAnimatedCaptions(),
  ]);
}
