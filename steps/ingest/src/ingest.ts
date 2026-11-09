import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeJsonAtomic } from "../../../core/src/index.ts";
import type { StepContract, StepModule } from "../../../core/src/index.ts";
import contract from "../contract.json" with { type: "json" };
import { probe } from "./probe.ts";

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export const ingest: StepModule = {
  contract: contract as StepContract,
  async run(ctx) {
    const source = String(ctx.params.source);
    const name = basename(source);
    const rel = `media/${name}`;
    await mkdir(join(ctx.projectDir, "media"), { recursive: true });
    const dest = join(ctx.projectDir, rel);
    await copyFile(source, dest);
    ctx.log(`copied ${name} into media/`);
    const info = await probe(dest);
    const hash = await sha256(dest);
    const size = (await stat(dest)).size;
    await writeJsonAtomic(join(ctx.projectDir, "media", "ingest.json"), { file: rel, ...info, sha256: hash });
    return {
      metrics: {
        durationSec: info.durationSec,
        fps: info.fps,
        width: info.width,
        height: info.height,
        rotation: info.rotation,
        hasAudio: info.hasAudio,
        sha256: hash,
        sizeMB: Math.round((size / 1024 / 1024) * 100) / 100,
      },
      artifacts: [rel, "media/ingest.json"],
    };
  },
};

export default ingest;
