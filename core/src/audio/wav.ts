import { open } from "node:fs/promises";

/** Duration of a PCM WAV from its header (the file must be seekable-written, as ffmpeg does). */
export async function wavDuration(path: string): Promise<number> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    let rate = 0;
    let frame = 0;
    const ch = Buffer.alloc(8);
    for (let pos = 12; pos + 8 <= size; ) {
      await fh.read(ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4);
      const len = ch.readUInt32LE(4);
      if (id === "fmt ") {
        const b = Buffer.alloc(16);
        await fh.read(b, 0, 16, pos + 8);
        rate = b.readUInt32LE(4);
        frame = b.readUInt16LE(12);
      } else if (id === "data") {
        if (!rate || !frame) throw new Error(`${path}: WAV data before fmt`);
        return Math.min(len, size - pos - 8) / frame / rate;
      }
      pos += 8 + len + (len % 2);
    }
    throw new Error(`${path}: WAV has no data chunk`);
  } finally {
    await fh.close();
  }
}
