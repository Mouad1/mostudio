import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardContext } from "./context.ts";
import { startDashboard, type DashboardOptions } from "./server.ts";
import type { RunEvent } from "./types.ts";

/** A real 16-bit stereo sine WAV: a small upload body that ffprobe can read. */
export function generateSineWav(durationSec = 1, sampleRate = 48000, freq = 440): Buffer {
  const numChannels = 2;
  const bitsPerSample = 16;
  const numFrames = sampleRate * durationSec;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);

  // fmt subchunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 30000);
    buf.writeInt16LE(sample, offset);
    buf.writeInt16LE(sample, offset + 2);
    offset += 4;
  }
  return buf;
}

export type TestDashboardOptions = DashboardOptions & {
  noWorkspace?: boolean;
};

export function rawRequest(
  port: string | number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method,
        path,
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * The test process's environment without provider keys: a machine (or CI box) that has GROQ_API_KEY etc. set
 * must not change what the settings tests see. PATH, FFMPEG and the rest are kept so tools still resolve.
 */
export function withoutProviderKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !/_(API_KEY|API_TOKEN|TOKEN|SECRET)$/.test(k)) out[k] = v;
  }
  return out;
}

export async function startTestDashboard(o: TestDashboardOptions = {}): Promise<{
  base: string;
  token: string;
  ws: string;
  home: string;
  ctx: DashboardContext;
  api(path: string, init?: RequestInit): Promise<Response>;
  idle(id?: string): Promise<void>;
  events(id?: string): RunEvent[];
  close(): Promise<void>;
}> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "mostudio-home-"));
  let ws = o.root;
  if (!ws && !o.noWorkspace) {
    ws = mkdtempSync(join(tmpdir(), "mostudio-ws-"));
    writeFileSync(join(ws, "mostudio.config.json"), JSON.stringify({ billing: "free-only" }));
    mkdirSync(join(ws, "workflows"), { recursive: true });
    writeFileSync(join(ws, "workflows", "t.json"), JSON.stringify({ steps: [] }));
  }

  const d = await startDashboard({
    ...o,
    home,
    root: ws,
    port: o.port ?? 0,
    processEnv: o.processEnv ?? withoutProviderKeys(process.env),
  });

  const api = (path: string, init?: RequestInit): Promise<Response> => {
    const p = path.startsWith("/") ? path : `/${path}`;
    const url = `${d.url}${p}`;
    const headers = new Headers(init?.headers);
    if (!headers.has("origin")) {
      headers.set("origin", d.url);
    }
    if (!headers.has("x-mostudio-token")) {
      headers.set("x-mostudio-token", d.token);
    }
    return (o.fetch ?? fetch)(url, { ...init, headers });
  };

  const close = async (): Promise<void> => {
    await d.close();
    try {
      rmSync(home, { recursive: true, force: true });
      if (ws && !o.root && !o.noWorkspace) {
        rmSync(ws, { recursive: true, force: true });
      }
    } catch {}
  };

  return {
    base: d.url,
    token: d.token,
    ws: ws ?? "",
    home,
    ctx: d.ctx,
    api,
    idle: async (id?: string) => {
      if (id) {
        await d.ctx.jobs.idle(id);
      } else {
        await Promise.all(d.ctx.jobs.runningIds().map((i) => d.ctx.jobs.idle(i)));
      }
    },
    events: (id?: string) => (id ? d.ctx.jobs.events(id) : []),
    close,
  };
}
