import { open } from "node:fs/promises";

const FLOOR_DB = -96;
const CHUNK_BYTES = 1 << 20;

type Fmt = { format: number; channels: number; sampleRate: number; bits: number };

/** RMS per window in dBFS (floor -96) of a 16-bit PCM WAV; channels are averaged. */
export async function rmsEnvelope(wavPath: string, windowMs = 10): Promise<Float32Array> {
  const fh = await open(wavPath, "r");
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`${wavPath}: not a RIFF/WAVE file`);
    }
    let fmt: Fmt | undefined;
    let dataStart = -1;
    let dataLen = 0;
    const ch = Buffer.alloc(8);
    for (let pos = 12; pos + 8 <= size; ) {
      await fh.read(ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4);
      const len = ch.readUInt32LE(4);
      const body = pos + 8;
      if (id === "fmt ") {
        const b = Buffer.alloc(16);
        await fh.read(b, 0, 16, body);
        fmt = { format: b.readUInt16LE(0), channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
      } else if (id === "data") {
        dataStart = body;
        // streamed WAVs may carry a 0 / 0xFFFFFFFF length: clamp to the file
        dataLen = Math.min(len, size - body);
        break;
      }
      pos = body + len + (len % 2);
    }
    if (!fmt) throw new Error(`${wavPath}: WAV has no fmt chunk`);
    if (dataStart < 0) throw new Error(`${wavPath}: WAV has no data chunk`);
    if (fmt.format !== 1 || fmt.bits !== 16) {
      throw new Error(`${wavPath}: only 16-bit PCM WAV is supported (got format ${fmt.format}, ${fmt.bits}-bit)`);
    }
    if (fmt.channels < 1) throw new Error(`${wavPath}: WAV has no channels`);

    const frameBytes = 2 * fmt.channels;
    const win = Math.max(1, Math.round((fmt.sampleRate * windowMs) / 1000));
    const totalFrames = Math.floor(dataLen / frameBytes);
    const out = new Float32Array(Math.ceil(totalFrames / win));
    const buf = Buffer.alloc(CHUNK_BYTES - (CHUNK_BYTES % frameBytes));
    let frame = 0;
    let sumSq = 0;
    let inWin = 0;
    let w = 0;
    const flush = (): void => {
      const rms = Math.sqrt(sumSq / inWin);
      out[w++] = rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms / 32768)) : FLOOR_DB;
      sumSq = 0;
      inWin = 0;
    };
    while (frame < totalFrames) {
      const want = Math.min(buf.length, (totalFrames - frame) * frameBytes);
      const { bytesRead: n } = await fh.read(buf, 0, want, dataStart + frame * frameBytes);
      if (n < frameBytes) break;
      const frames = Math.floor(n / frameBytes);
      for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE((f * fmt.channels + c) * 2);
        const v = s / fmt.channels;
        sumSq += v * v;
        if (++inWin === win) flush();
      }
      frame += frames;
    }
    if (inWin > 0) flush();
    return w === out.length ? out : out.slice(0, w);
  } finally {
    await fh.close();
  }
}

/** Center time (s) of the lowest-RMS window within [from, to]; ties go to the earliest. */
export function quietestPoint(env: Float32Array, windowMs: number, from: number, to: number): number {
  if (env.length === 0) throw new Error("empty envelope");
  const eps = 1e-9;
  const i0 = Math.min(env.length - 1, Math.max(0, Math.floor((from * 1000) / windowMs + eps)));
  const i1 = Math.min(env.length - 1, Math.max(i0, Math.ceil((to * 1000) / windowMs - eps) - 1));
  let best = i0;
  for (let i = i0 + 1; i <= i1; i++) if ((env[i] as number) < (env[best] as number)) best = i;
  return ((best + 0.5) * windowMs) / 1000;
}
