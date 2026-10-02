import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseObject } from './props.js';
import { decompressBulk, type ExportEntry, type UPackage } from './upk.js';

export type TexFormat = 'dxt1' | 'dxt3' | 'dxt5' | 'rgba';
export interface TexMip { w: number; h: number; data: Uint8Array }
export interface TextureData { name: string; format: TexFormat; mips: TexMip[]; packed?: boolean }

const BULK_SEPARATE_FILE = 0x1;
const BULK_ZLIB = 0x2;
const BULK_LZO = 0x10;
const BULK_UNUSED = 0x20;

const FORMATS: Record<string, TexFormat> = { PF_DXT1: 'dxt1', PF_DXT3: 'dxt3', PF_DXT5: 'dxt5', PF_A8R8G8B8: 'rgba', PF_G8: 'rgba' };

function readTfc(cookedDir: string, cache: string, offset: number, size: number): Uint8Array | null {
  const path = join(cookedDir, `${cache}.tfc`);
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = new Uint8Array(size);
    const n = readSync(fd, buf, 0, size, offset);
    return n === size ? buf : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a cooked Texture2D (v805): SourceArt bulk (empty), then Mips[]: bulk header + data (inline or in a .tfc),
 * followed by SizeX/SizeY. Picks the mip chain starting at the largest level <= maxSize.
 */
export function extractTexture(pkg: UPackage, e: ExportEntry, cookedDir: string, maxSize: number): TextureData | null {
  const data = pkg.exportData(e);
  const obj = parseObject(pkg, data);
  if (!obj) return null;
  const fmtName = obj.props.get('Format');
  const format = typeof fmtName === 'string' ? FORMATS[fmtName] : undefined;
  if (!format) return null;
  const cache = typeof obj.props.get('TextureFileCacheName') === 'string' ? (obj.props.get('TextureFileCacheName') as string) : 'Textures';
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = obj.end;
  const bulkHeader = () => {
    const h = { flags: v.getUint32(o, true), count: v.getInt32(o + 4, true), size: v.getInt32(o + 8, true), offset: v.getInt32(o + 12, true), at: o + 16 };
    o += 16;
    return h;
  };
  // SourceArt
  const src = bulkHeader();
  if (!(src.flags & BULK_SEPARATE_FILE) && src.size > 0) o += src.size;
  if (o + 4 > data.length) return null;
  const nMips = v.getInt32(o, true);
  o += 4;
  if (nMips <= 0 || nMips > 16) return null;
  const mips: { w: number; h: number; load: () => Uint8Array | null }[] = [];
  for (let i = 0; i < nMips; i++) {
    if (o + 16 > data.length) return null;
    const b = bulkHeader();
    const inlineAt = b.at;
    if (!(b.flags & BULK_SEPARATE_FILE) && b.size > 0) o += b.size;
    if (o + 8 > data.length) return null;
    const w = v.getInt32(o, true), h = v.getInt32(o + 4, true);
    o += 8;
    if (b.flags & BULK_UNUSED || b.count <= 0) continue;
    const compressed = (b.flags & (BULK_LZO | BULK_ZLIB)) !== 0;
    const load = (): Uint8Array | null => {
      const raw = b.flags & BULK_SEPARATE_FILE ? readTfc(cookedDir, cache, b.offset, b.size) : data.subarray(inlineAt, inlineAt + b.size);
      if (!raw) return null;
      try {
        return compressed ? decompressBulk(raw, 0, b.count, b.flags) : raw.slice(0, b.count);
      } catch {
        return null;
      }
    };
    mips.push({ w, h, load });
  }
  const start = mips.findIndex((m) => Math.max(m.w, m.h) <= maxSize);
  if (start < 0) return null;
  const out: TexMip[] = [];
  for (const m of mips.slice(start)) {
    if (m.w < 4 || m.h < 4) break;
    let d = m.load();
    if (!d) { if (out.length) break; continue; }
    if (format === 'rgba') d = toRgba(d, fmtName as string, m.w, m.h);
    out.push({ w: m.w, h: m.h, data: d });
  }
  return out.length ? { name: e.objectName, format, mips: out, packed: isChannelPacked(format, out[out.length - 1]) } : null;
}

/**
 * Some TA "diffuse" textures are channel-packed masks the material recolours (they look magenta raw).
 * Detect them from the average colour of the smallest mip so the client can use luminance instead.
 */
function isChannelPacked(format: TexFormat, m: TexMip): boolean {
  let r = 0, g = 0, b = 0, n = 0;
  if (format === 'rgba') {
    for (let i = 0; i < m.data.length; i += 4) { r += m.data[i]; g += m.data[i + 1]; b += m.data[i + 2]; n++; }
    r /= n * 255; g /= n * 255; b /= n * 255;
  } else {
    const block = format === 'dxt1' ? 8 : 16, off = format === 'dxt1' ? 0 : 8;
    for (let o = 0; o + block <= m.data.length; o += block) {
      for (const c of [m.data[o + off] | (m.data[o + off + 1] << 8), m.data[o + off + 2] | (m.data[o + off + 3] << 8)]) {
        r += ((c >> 11) & 31) / 31; g += ((c >> 5) & 63) / 63; b += (c & 31) / 31; n++;
      }
    }
    if (!n) return false;
    r /= n; g /= n; b /= n;
  }
  return Math.min(r, b) > g * 1.6 && Math.max(r, b) > 0.35;
}

function toRgba(src: Uint8Array, fmt: string, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  if (fmt === 'PF_G8') {
    for (let i = 0; i < w * h; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i]; out[i * 4 + 3] = 255; }
  } else {
    for (let i = 0; i < w * h; i++) { out[i * 4] = src[i * 4 + 2]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4]; out[i * 4 + 3] = src[i * 4 + 3]; }
  }
  return out;
}

/** Container written to disk and served to clients: 'ATX1', format, mip count, then (w, h, size, bytes) per mip. */
export function encodeTexture(t: TextureData): Uint8Array {
  const total = 8 + t.mips.reduce((n, m) => n + 8 + m.data.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set([0x41, 0x54, 0x58, 0x31]);
  v.setUint8(4, ['rgba', 'dxt1', 'dxt3', 'dxt5'].indexOf(t.format));
  v.setUint8(5, t.mips.length);
  v.setUint8(6, t.packed ? 1 : 0);
  let o = 8;
  for (const m of t.mips) {
    v.setUint16(o, m.w, true); v.setUint16(o + 2, m.h, true); v.setUint32(o + 4, m.data.length, true);
    out.set(m.data, o + 8);
    o += 8 + m.data.length;
  }
  return out;
}
