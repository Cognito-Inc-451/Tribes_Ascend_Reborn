import { readFileSync } from 'node:fs';
import { lzoDecompress } from './lzo.js';

export interface NameEntry { name: string; flags: bigint }
export interface ImportEntry { classPackage: string; className: string; outer: number; objectName: string }
export interface ExportEntry {
  classIndex: number; superIndex: number; outer: number; objectName: string; nameNumber: number; archetype: number;
  flags: bigint; serialSize: number; serialOffset: number; exportFlags: number;
}

const PKG_STORE_COMPRESSED = 0x02000000;

/** Minimal Unreal Engine 3 package reader (TA: file version 805, licensee 2). Read-only. */
export class UPackage {
  readonly data: Uint8Array;
  readonly view: DataView;
  version = 0;
  licensee = 0;
  flags = 0;
  names: NameEntry[] = [];
  imports: ImportEntry[] = [];
  exports: ExportEntry[] = [];
  compressionFlags = 0;

  constructor(readonly path: string) {
    const raw = new Uint8Array(readFileSync(path));
    const hdr = new Reader(raw);
    if (hdr.u32() !== 0x9e2a83c1) throw new Error(`${path}: not a UE3 package`);
    this.version = hdr.u16();
    this.licensee = hdr.u16();
    hdr.i32(); // total header size
    hdr.fstring(); // folder
    this.flags = hdr.u32();
    const nameCount = hdr.i32(), nameOffset = hdr.i32();
    const exportCount = hdr.i32(), exportOffset = hdr.i32();
    const importCount = hdr.i32(), importOffset = hdr.i32();
    if (this.version >= 415) hdr.i32();
    if (this.version >= 623) { hdr.i32(); hdr.i32(); hdr.i32(); }
    if (this.version >= 584) hdr.i32();
    hdr.skip(16);
    const gens = hdr.i32();
    for (let i = 0; i < gens; i++) { hdr.i32(); hdr.i32(); if (this.version >= 322) hdr.i32(); }
    hdr.i32(); // engine version
    hdr.i32(); // cooker version
    this.compressionFlags = hdr.u32();
    const chunks: { uo: number; us: number; co: number; cs: number }[] = [];
    const nChunks = hdr.i32();
    for (let i = 0; i < nChunks; i++) chunks.push({ uo: hdr.i32(), us: hdr.i32(), co: hdr.i32(), cs: hdr.i32() });

    if (chunks.length && (this.flags & PKG_STORE_COMPRESSED || this.compressionFlags)) {
      const total = chunks.reduce((m, c) => Math.max(m, c.uo + c.us), 0);
      const out = new Uint8Array(total);
      out.set(raw.subarray(0, Math.min(chunks[0].uo, raw.length)));
      for (const c of chunks) decompressChunk(raw, c.co, out, c.uo, this.compressionFlags);
      this.data = out;
    } else {
      this.data = raw;
    }
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);

    const r = new Reader(this.data, nameOffset);
    for (let i = 0; i < nameCount; i++) this.names.push({ name: r.fstring(), flags: r.u64() });
    r.off = importOffset;
    for (let i = 0; i < importCount; i++) {
      const classPackage = this.nameAt(r.i32(), r.i32());
      const className = this.nameAt(r.i32(), r.i32());
      const outer = r.i32();
      const objectName = this.nameAt(r.i32(), r.i32());
      this.imports.push({ classPackage, className, outer, objectName });
    }
    r.off = exportOffset;
    for (let i = 0; i < exportCount; i++) {
      const classIndex = r.i32(), superIndex = r.i32(), outer = r.i32();
      const ni = r.i32(), nn = r.i32();
      const archetype = r.i32();
      const flags = r.u64();
      const serialSize = r.i32();
      const serialOffset = serialSize > 0 || this.version >= 249 ? r.i32() : 0;
      if (this.version < 543) { const n = r.i32(); r.skip(n * 12); }
      const exportFlags = r.u32();
      if (this.version >= 322) { const n = r.i32(); r.skip(n * 4); r.skip(16); }
      if (this.version >= 475) r.u32();
      this.exports.push({ classIndex, superIndex, outer, objectName: this.names[ni]?.name ?? `?${ni}`, nameNumber: nn, archetype, flags, serialSize, serialOffset, exportFlags });
    }
  }

  nameAt(index: number, number = 0): string {
    const n = this.names[index]?.name ?? `?name${index}`;
    return number > 0 ? `${n}_${number - 1}` : n;
  }

  /** Object reference (FPackageIndex) to its short name. */
  refName(idx: number): string {
    if (idx > 0) { const e = this.exports[idx - 1]; return e ? (e.nameNumber > 0 ? `${e.objectName}_${e.nameNumber - 1}` : e.objectName) : `?exp${idx}`; }
    if (idx < 0) return this.imports[-idx - 1]?.objectName ?? `?imp${idx}`;
    return 'None';
  }

  refPath(idx: number): string {
    const parts: string[] = [];
    let cur = idx, guard = 0;
    while (cur !== 0 && guard++ < 16) {
      parts.unshift(this.refName(cur));
      cur = cur > 0 ? this.exports[cur - 1]?.outer ?? 0 : this.imports[-cur - 1]?.outer ?? 0;
    }
    return parts.join('.');
  }

  className(e: ExportEntry): string {
    return e.classIndex === 0 ? 'Class' : this.refName(e.classIndex);
  }

  exportData(e: ExportEntry): Uint8Array {
    return this.data.subarray(e.serialOffset, e.serialOffset + e.serialSize);
  }
}

/** Decompress a UE3 compressed-chunk blob (package chunks, compressed bulk data, TFC entries). */
export function decompressBulk(raw: Uint8Array, offset: number, uncompressed: number, flags: number): Uint8Array {
  const out = new Uint8Array(uncompressed);
  decompressChunk(raw, offset, out, 0, flags & 0x10 ? 2 : flags & 0x2 ? 1 : 2);
  return out;
}

function decompressChunk(raw: Uint8Array, offset: number, out: Uint8Array, outOffset: number, compressionFlags: number) {
  const r = new Reader(raw, offset);
  const tag = r.u32();
  if (tag !== 0x9e2a83c1) throw new Error(`bad chunk tag at ${offset}`);
  const blockSize = r.i32();
  r.i32(); // summary compressed size
  const totalUncomp = r.i32();
  const nBlocks = Math.ceil(totalUncomp / (blockSize || 131072));
  const blocks: { cs: number; us: number }[] = [];
  for (let i = 0; i < nBlocks; i++) blocks.push({ cs: r.i32(), us: r.i32() });
  let src = r.off, dst = outOffset;
  for (const b of blocks) {
    const input = raw.subarray(src, src + b.cs);
    let block: Uint8Array;
    if (compressionFlags & 2) block = lzoDecompress(input, b.us);
    else if (compressionFlags & 1) block = inflateZlib(input, b.us);
    else throw new Error(`unsupported compression ${compressionFlags}`);
    out.set(block.subarray(0, b.us), dst);
    src += b.cs;
    dst += b.us;
  }
}

import { inflateSync } from 'node:zlib';
function inflateZlib(input: Uint8Array, _size: number): Uint8Array {
  return new Uint8Array(inflateSync(input));
}

export class Reader {
  private view: DataView;
  constructor(readonly data: Uint8Array, public off = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get remaining() { return this.data.byteLength - this.off; }
  skip(n: number) { this.off += n; }
  u8() { return this.view.getUint8(this.off++); }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i32() { const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  u64() { const v = this.view.getBigUint64(this.off, true); this.off += 8; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  fstring(): string {
    const len = this.i32();
    if (len === 0) return '';
    if (len > 0) {
      const s = new TextDecoder('latin1').decode(this.data.subarray(this.off, this.off + len - 1));
      this.off += len;
      return s;
    }
    const n = -len;
    let s = '';
    for (let i = 0; i < n - 1; i++) s += String.fromCharCode(this.view.getUint16(this.off + i * 2, true));
    this.off += n * 2;
    return s;
  }
}
