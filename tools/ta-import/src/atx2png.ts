import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Dev helper: decode mip 0 of an .atx (DXT1/DXT5) to PNG. Usage: tsx src/atx2png.ts <in.atx> <out.png>
const b = readFileSync(process.argv[2]);
const fmt = b[4];
const w = b.readUInt16LE(8), h = b.readUInt16LE(10), size = b.readUInt32LE(12);
const data = b.subarray(16, 16 + size);
const out = Buffer.alloc(w * h * 4);
const c565 = (c: number) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
const block = fmt === 1 ? 8 : 16;
for (let by = 0; by < h / 4; by++) for (let bx = 0; bx < w / 4; bx++) {
  const o = (by * (w / 4) + bx) * block + (fmt === 1 ? 0 : 8);
  const a = data.readUInt16LE(o), c = data.readUInt16LE(o + 2);
  const p0 = c565(a), p1 = c565(c);
  const pal = [p0, p1, p0.map((v, i) => (2 * v + p1[i]) / 3), p0.map((v, i) => (v + 2 * p1[i]) / 3)];
  const bits = data.readUInt32LE(o + 4);
  for (let i = 0; i < 16; i++) {
    const col = pal[(bits >>> (2 * i)) & 3];
    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2), q = (y * w + x) * 4;
    out[q] = col[0]; out[q + 1] = col[1]; out[q + 2] = col[2]; out[q + 3] = 255;
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf: Buffer) => { let c = -1; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((w * 4 + 1) * h);
for (let y = 0; y < h; y++) out.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
writeFileSync(process.argv[3], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
