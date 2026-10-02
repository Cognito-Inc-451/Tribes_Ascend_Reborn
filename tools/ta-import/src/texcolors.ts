import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeMapData } from '@ar/shared';

// Dev helper: average colour of each texture a map uses. Usage: tsx src/texcolors.ts <map.arm.gz> <texDir>
const d = decodeMapData(new Uint8Array(gunzipSync(readFileSync(process.argv[2]))));
for (const name of d.textures ?? []) {
  const b = readFileSync(`${process.argv[3]}/${name}.atx`);
  const fmt = b[4], cnt = b[5];
  let o = 8, last = { w: 0, h: 0, at: 0, size: 0 };
  for (let i = 0; i < cnt; i++) { const w = b.readUInt16LE(o), h = b.readUInt16LE(o + 2), size = b.readUInt32LE(o + 4); last = { w, h, at: o + 8, size }; o += 8 + size; }
  let r = 0, g = 0, bl = 0, n = 0;
  const block = fmt === 1 ? 8 : 16, off = fmt === 1 ? 0 : 8;
  for (let p = last.at; p + block <= last.at + last.size; p += block) for (const c of [b.readUInt16LE(p + off), b.readUInt16LE(p + off + 2)]) { r += ((c >> 11) & 31) / 31; g += ((c >> 5) & 63) / 63; bl += (c & 31) / 31; n++; }
  console.log(name.padEnd(48), (r / n).toFixed(2), (g / n).toFixed(2), (bl / n).toFixed(2), 'packed', b[6]);
}
