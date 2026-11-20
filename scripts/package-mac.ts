import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type Arch = "arm64" | "x64";
export type Pinned = { url: string; sha256: string };
export type RuntimeLock = {
  node: { version: string; arm64: Pinned; x64: Pinned };
  ffmpeg: {
    version: string;
    license: string;
    buildSource: string;
    sourceTarball: Pinned;
    arm64: { ffmpeg: Pinned; ffprobe: Pinned };
    x64: { ffmpeg: Pinned; ffprobe: Pinned };
  };
};

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "tests",
  "fixtures",
  "projects",
  "inspiration",
  "spikes",
  "docs",
  "tasks",
  ".git",
  ".claude",
  ".agents",
  ".superpowers",
  ".hyperframes",
  "cache",
  "dist"
]);

export async function appFiles(repoRoot: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string, relBase: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (shouldInclude(rel)) {
          result.push(rel);
        }
      }
    }
  }

  function shouldInclude(rel: string): boolean {
    if (
      rel.endsWith(".test.ts") ||
      /(^|\/)tests\//.test(rel) ||
      /(^|\/)fixtures\//.test(rel) ||
      rel.endsWith("testkit.ts") ||
      rel.endsWith("fixture-typed.ts") ||
      rel === "cli/bin/mostudio-bws" ||
      /(^|\/)\.env/.test(rel) ||
      rel === "mostudio.config.json" ||
      rel.endsWith("/mostudio.config.json") ||
      rel.endsWith(".DS_Store")
    ) {
      return false;
    }

    if (
      rel.startsWith("core/") ||
      rel.startsWith("cli/") ||
      rel.startsWith("steps/") ||
      rel.startsWith("dashboard/") ||
      rel.startsWith("components/") ||
      rel.startsWith("schemas/") ||
      (rel.startsWith("workflows/") && rel.endsWith(".json")) ||
      rel === "providers.json" ||
      rel === "package.json" ||
      rel === "LICENSE" ||
      rel === "README.md"
    ) {
      return true;
    }

    return false;
  }

  await walk(repoRoot, "");
  result.sort();
  return result;
}

export async function verifySha256(file: string, expected: string): Promise<void> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
}

const CONTROLLED_SOURCE = "ffmpeg-corresponding-source.tar.gz";
const CONTROLLED_RUNTIME = ["bin/ffmpeg", "bin/ffprobe", CONTROLLED_SOURCE];
const CONTROLLED_LICENSE = "LICENSES/ffmpeg-COPYING.GPLv3";

/**
 * Check the controlled FFmpeg build against its SHA256SUMS. With `stageDir`, each listed file is
 * copied there first and the copy is verified, so later changes to `buildDir` cannot reach the package.
 */
export async function readControlledFfmpeg(buildDir: string, stageDir?: string): Promise<string[]> {
  const manifest = fs.readFileSync(path.join(buildDir, "SHA256SUMS"), "utf8").trim();
  const files = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) [ *](\S+)$/i);
    const file = match?.[2];
    if (!file || files.has(file) || (!CONTROLLED_RUNTIME.includes(file) && !/^LICENSES\/[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(file))) {
      throw new Error(`invalid controlled FFmpeg checksum entry: ${line}`);
    }
    files.set(file, match[1]);
  }
  for (const file of [...CONTROLLED_RUNTIME, CONTROLLED_LICENSE]) {
    if (!files.has(file)) throw new Error(`controlled FFmpeg checksum missing: ${file}`);
  }
  for (const [file, digest] of files) {
    let checked = path.join(buildDir, file);
    if (stageDir) {
      const staged = path.join(stageDir, file);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.copyFileSync(checked, staged);
      checked = staged;
    }
    await verifySha256(checked, digest);
  }
  return [...files.keys()].filter((file) => file.startsWith("LICENSES/")).sort();
}

export function ffmpegCapsOk(filters: string, encoders: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!/\bass\b/.test(filters)) {
    missing.push("ass");
  }
  if (!/\bh264_videotoolbox\b/.test(encoders)) {
    missing.push("h264_videotoolbox");
  }
  if (!/\baac\b/.test(encoders)) {
    missing.push("aac");
  }
  return { ok: missing.length === 0, missing };
}

async function getCachedOrDownload(url: string, sha256: string, cacheDir: string): Promise<string> {
  const urlObj = new URL(url);
  const segments = urlObj.pathname.split("/").filter(Boolean);
  const rawFilename = segments.slice(-2).join("-") || "download";
  const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const target = path.join(cacheDir, filename);

  if (fs.existsSync(target)) {
    try {
      await verifySha256(target, sha256);
      return target;
    } catch {
      // checksum failed, re-download
    }
  }

  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.statusText}`);
  }
  const arrayBuf = await res.arrayBuffer();
  await fs.promises.writeFile(target, Buffer.from(arrayBuf));
  await verifySha256(target, sha256);
  return target;
}

type BuildZipOptions = {
  arch: Arch;
  repoRoot: string;
  outDir: string;
  lock: RuntimeLock;
  cacheDir: string;
  ffmpegBuildDir?: string;
};

export async function buildZip(o: BuildZipOptions): Promise<string> {
  if (o.ffmpegBuildDir && (o.arch !== "arm64" || process.arch !== "arm64" || process.platform !== "darwin")) {
    throw new Error("controlled FFmpeg packaging requires an Apple Silicon Mac and --arch arm64");
  }
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(o.outDir, ".package-"));
  try {
    return await stageZip(o, stageDir);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

async function stageZip(o: BuildZipOptions, stageDir: string): Promise<string> {
  // Package only the verified copies of the controlled build.
  const controlledDir = o.ffmpegBuildDir && path.join(stageDir, "controlled-ffmpeg");
  const controlledNotices = o.ffmpegBuildDir && controlledDir && await readControlledFfmpeg(o.ffmpegBuildDir, controlledDir);
  const nodeTarball = await getCachedOrDownload(o.lock.node[o.arch].url, o.lock.node[o.arch].sha256, o.cacheDir);
  const root = path.join(stageDir, "mostudio");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "runtime/node"), { recursive: true });
  fs.mkdirSync(path.join(root, "runtime/bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "LICENSES"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });

  execFileSync("tar", ["-xf", nodeTarball, "--strip-components=1", "-C", path.join(root, "runtime/node")]);
  if (controlledDir && controlledNotices) {
    for (const name of ["ffmpeg", "ffprobe"]) {
      fs.copyFileSync(path.join(controlledDir, "bin", name), path.join(root, "runtime/bin", name));
    }
    for (const notice of controlledNotices) {
      fs.copyFileSync(path.join(controlledDir, notice), path.join(root, notice));
    }
  } else {
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const pin = o.lock.ffmpeg[o.arch][name];
      const binZip = await getCachedOrDownload(pin.url, pin.sha256, o.cacheDir);
      execFileSync("unzip", ["-q", "-o", binZip, "-d", path.join(root, "runtime/bin")]);
    }
    const pin = o.lock.ffmpeg.sourceTarball;
    const source = await getCachedOrDownload(pin.url, pin.sha256, o.cacheDir);
    const outSrc = path.join(o.outDir, `ffmpeg-${o.lock.ffmpeg.version}-source.tar.xz`);
    if (!fs.existsSync(outSrc)) await fs.promises.copyFile(source, outSrc);
  }

  const ffmpegBin = path.join(root, "runtime/bin/ffmpeg");
  const ffprobeBin = path.join(root, "runtime/bin/ffprobe");
  fs.chmodSync(ffmpegBin, 0o755);
  fs.chmodSync(ffprobeBin, 0o755);

  if (!o.ffmpegBuildDir) {
    try {
      execFileSync("codesign", ["--force", "--sign", "-", ffmpegBin, ffprobeBin]);
    } catch (err) {
      console.warn("codesign warning:", err);
    }
  }

  let buildConfText = "";
  const isArmHost = process.arch === "arm64";
  let canRun = false;
  if (o.arch === "arm64") {
    canRun = isArmHost;
  } else {
    try {
      execFileSync("arch", ["-x86_64", "/usr/bin/true"]);
      canRun = true;
    } catch {
      canRun = false;
    }
  }

  if (canRun) {
    const runFfmpeg = (args: string[]) => {
      if (o.arch === "x64" && isArmHost) {
        return execFileSync("arch", ["-x86_64", ffmpegBin, ...args], { encoding: "utf8" });
      }
      return execFileSync(ffmpegBin, args, { encoding: "utf8" });
    };

    const filters = runFfmpeg(["-hide_banner", "-filters"]);
    const encoders = runFfmpeg(["-hide_banner", "-encoders"]);
    const caps = ffmpegCapsOk(filters, encoders);
    if (!caps.ok) {
      throw new Error(`ffmpeg missing capabilities: ${caps.missing.join(", ")}`);
    }
    if (o.ffmpegBuildDir) {
      for (const [name, bin] of [["ffmpeg", ffmpegBin], ["ffprobe", ffprobeBin]]) {
        const version = execFileSync(bin, ["-version"], { encoding: "utf8" }).split(/\s+/)[2];
        if (version !== o.lock.ffmpeg.version) {
          throw new Error(`${name} version ${version} does not match the lock (${o.lock.ffmpeg.version})`);
        }
      }
      for (const filter of ["zscale", "tonemap"]) {
        if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw new Error(`ffmpeg missing filter: ${filter}`);
      }
      for (const encoder of ["libx264", "libmp3lame"]) {
        if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`ffmpeg missing encoder: ${encoder}`);
      }
    } else {
      try {
        buildConfText = runFfmpeg(["-hide_banner", "-buildconf"]);
      } catch {
        buildConfText = runFfmpeg(["-version"]);
      }
    }
  } else {
    console.log(`skipped ${o.arch} runtime check (no Rosetta)`);
  }

  fs.copyFileSync(path.join(o.repoRoot, "LICENSE"), path.join(root, "LICENSES/mostudio-LICENSE"));
  const nodeLicense = path.join(root, "runtime/node/LICENSE");
  if (fs.existsSync(nodeLicense)) {
    fs.copyFileSync(nodeLicense, path.join(root, "LICENSES/node-LICENSE"));
  }

  if (!o.ffmpegBuildDir) {
    const ffmpegCopyingPath = path.join(o.repoRoot, "packaging/LICENSES/ffmpeg-COPYING");
    if (fs.existsSync(ffmpegCopyingPath)) {
      fs.copyFileSync(ffmpegCopyingPath, path.join(root, "LICENSES/ffmpeg-COPYING"));
    } else {
      fs.writeFileSync(
        path.join(root, "LICENSES/ffmpeg-COPYING"),
        `FFmpeg is licensed under the ${o.lock.ffmpeg.license}.\nSee https://www.gnu.org/licenses/gpl-3.0.en.html\n`
      );
    }
  }

  const sourceName = `ffmpeg-${o.lock.ffmpeg.version}-${o.arch}-corresponding-source.tar.gz`;
  fs.writeFileSync(
    path.join(root, "LICENSES/ffmpeg-BUILD.txt"),
    o.ffmpegBuildDir
      ? `FFmpeg and FFprobe ${o.lock.ffmpeg.version}\nMatching source and build scripts: ${sourceName}\n`
      : `FFmpeg and FFprobe ${o.lock.ffmpeg.version}\n` +
        `Upstream FFmpeg source: https://ffmpeg.org/releases/ffmpeg-${o.lock.ffmpeg.version}.tar.xz\n` +
        `Third-party binary source: ${o.lock.ffmpeg.buildSource}\n\n` +
        `Build configuration:\n${buildConfText}\n`
  );

  const licensesReadme = path.join(o.repoRoot, "packaging/LICENSES/README.md");
  if (fs.existsSync(licensesReadme)) {
    fs.copyFileSync(licensesReadme, path.join(root, "LICENSES/README.md"));
  }

  const launcher = path.join(o.repoRoot, "packaging/Start mostudio.command");
  fs.copyFileSync(launcher, path.join(root, "Start mostudio.command"));
  fs.chmodSync(path.join(root, "Start mostudio.command"), 0o755);

  const howTo = path.join(o.repoRoot, "packaging/How to open mostudio.txt");
  if (fs.existsSync(howTo)) {
    fs.copyFileSync(howTo, path.join(root, "How to open mostudio.txt"));
  }

  const files = await appFiles(o.repoRoot);
  for (const rel of files) {
    const src = path.join(o.repoRoot, rel);
    const dst = path.join(root, "app", rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const pkgJson = JSON.parse(fs.readFileSync(path.join(o.repoRoot, "package.json"), "utf8"));
  const version = pkgJson.version || "0.1.0";
  const zipName = `mostudio-${version}-mac-${o.arch}.zip`;
  const stagedZip = path.join(stageDir, zipName);
  execFileSync("ditto", ["-c", "-k", "--norsrc", "--keepParent", root, stagedZip]);

  if (controlledDir) {
    const stagedSource = path.join(stageDir, sourceName);
    fs.copyFileSync(path.join(controlledDir, CONTROLLED_SOURCE), stagedSource);
    const sums = execFileSync("shasum", ["-a", "256", zipName, sourceName], { cwd: stageDir });
    fs.writeFileSync(path.join(stageDir, "SHA256SUMS"), sums);
    fs.renameSync(stagedSource, path.join(o.outDir, sourceName));
  }
  const zipPath = path.join(o.outDir, zipName);
  fs.renameSync(stagedZip, zipPath);
  if (o.ffmpegBuildDir) {
    fs.renameSync(path.join(stageDir, "SHA256SUMS"), path.join(o.outDir, "SHA256SUMS"));
  }

  return zipPath;
}

if (process.argv[1] && (pathToFileURL(process.argv[1]).href === import.meta.url || process.argv[1].endsWith("package-mac.ts"))) {
  const archIndex = process.argv.indexOf("--arch");
  const buildIndex = process.argv.indexOf("--ffmpeg-build");
  const ffmpegBuildDir = buildIndex === -1 ? undefined : process.argv[buildIndex + 1];
  if (buildIndex !== -1 && (!ffmpegBuildDir || ffmpegBuildDir.startsWith("--"))) {
    throw new Error("--ffmpeg-build requires a directory");
  }
  const targetArch = archIndex === -1 ? (ffmpegBuildDir ? "arm64" : "all") : process.argv[archIndex + 1];
  if (targetArch !== "arm64" && targetArch !== "x64" && targetArch !== "all") {
    throw new Error("--arch must be arm64, x64 or all");
  }
  const repoRoot = process.cwd();
  const lockPath = path.join(repoRoot, "packaging/runtime.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as RuntimeLock;
  const outDir = ffmpegBuildDir ? path.join(repoRoot, "dist", "controlled-mac-arm64") : path.join(repoRoot, "dist");
  const cacheDir = path.join(os.homedir(), ".cache/mostudio/packaging");

  const arches: Arch[] = targetArch === "all" ? ["arm64", "x64"] : [targetArch];
  for (const arch of arches) {
    console.log(`Building package for macOS ${arch}...`);
    const zip = await buildZip({ arch, repoRoot, outDir, lock, cacheDir, ffmpegBuildDir });
    console.log(`Created ${zip}`);
  }
}
