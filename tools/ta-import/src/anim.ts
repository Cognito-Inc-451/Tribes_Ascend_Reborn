import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { UU_PER_METER } from '@ar/shared';
import { isRaw, parseObject } from './props.js';
import type { UPackage } from './upk.js';

/*
 * TA's character animations (PC_Male.AnimSets.* in TribesGame.u). Cooked AnimSequences still carry RawAnimData
 * (per track: BulkSerialized FVector position keys and FQuat rotation keys, one per frame or a single constant key),
 * so we export those instead of decoding the compressed stream. Keys are converted to the client's space like bones:
 * positions (x, z, y) / 50; the root rotation (-x, -z, -y, w), other rotations (x, z, y, w).
 */
export interface AnimTrack { pos: Float32Array; rot: Float32Array }
export interface AnimSeq { name: string; frames: number; length: number; tracks: AnimTrack[] }
export interface AnimSetData { name: string; bones: string[]; seqs: AnimSeq[] }

const S = 1 / UU_PER_METER;

function nameArray(pkg: UPackage, raw: Uint8Array): string[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = dv.getInt32(0, true), out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pkg.names[dv.getInt32(4 + i * 8, true)]?.name ?? `bone${i}`);
  return out;
}

export function readAnimSet(pkg: UPackage, exportIndex: number): AnimSetData | null {
  const set = parseObject(pkg, pkg.exportData(pkg.exports[exportIndex]));
  const tb = set?.props.get('TrackBoneNames'), sq = set?.props.get('Sequences');
  if (!set || !isRaw(tb) || !isRaw(sq)) return null;
  const bones = nameArray(pkg, tb.raw);
  const sdv = new DataView(sq.raw.buffer, sq.raw.byteOffset, sq.raw.byteLength);
  const seqs: AnimSeq[] = [];
  for (let i = 0; i < sdv.getInt32(0, true); i++) {
    const ref = sdv.getInt32(4 + i * 4, true);
    if (ref <= 0) continue;
    const data = pkg.exportData(pkg.exports[ref - 1]);
    const o = parseObject(pkg, data);
    if (!o) continue;
    const name = o.props.get('SequenceName');
    const frames = o.props.get('NumFrames'), length = o.props.get('SequenceLength');
    if (typeof name !== 'string' || typeof frames !== 'number' || typeof length !== 'number') continue;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = o.end;
    const nTracks = v.getInt32(p, true); p += 4;
    if (nTracks !== bones.length) continue;
    const tracks: AnimTrack[] = [];
    let ok = true;
    for (let t = 0; t < nTracks && ok; t++) {
      const pe = v.getInt32(p, true), pn = v.getInt32(p + 4, true); p += 8;
      if (pe !== 12 || pn < 1 || p + pn * 12 > data.length) { ok = false; break; }
      const pos = new Float32Array(pn * 3);
      for (let k = 0; k < pn; k++, p += 12) {
        pos[k * 3] = v.getFloat32(p, true) * S; pos[k * 3 + 1] = v.getFloat32(p + 8, true) * S; pos[k * 3 + 2] = v.getFloat32(p + 4, true) * S;
      }
      const re = v.getInt32(p, true), rn = v.getInt32(p + 4, true); p += 8;
      if (re !== 16 || rn < 1 || p + rn * 16 > data.length) { ok = false; break; }
      const rot = new Float32Array(rn * 4);
      // Mesh bones convert as (-x,-z,-y,w); UE3 anim keys of non-root bones are the conjugate of that convention.
      const sx = t === 0 ? -1 : 1;
      for (let k = 0; k < rn; k++, p += 16) {
        rot[k * 4] = sx * v.getFloat32(p, true); rot[k * 4 + 1] = sx * v.getFloat32(p + 8, true); rot[k * 4 + 2] = sx * v.getFloat32(p + 4, true); rot[k * 4 + 3] = v.getFloat32(p + 12, true);
      }
      tracks.push({ pos, rot });
    }
    if (ok) seqs.push({ name, frames, length, tracks });
  }
  return { name: pkg.refPath(exportIndex + 1), bones, seqs };
}

/** 'AAN1' u16 bones (names), u16 sequences: name, u16 frames, f32 length, per track u16 posKeys, u16 rotKeys, f32 data. */
export function encodeAnimSet(a: AnimSetData): Buffer {
  const parts: Buffer[] = [];
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); parts.push(b); };
  const f32 = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); parts.push(b); };
  const str = (s: string) => { const e = Buffer.from(s.slice(0, 120)); parts.push(Buffer.from([e.length]), e); };
  parts.push(Buffer.from('AAN1'));
  u16(a.bones.length);
  for (const b of a.bones) str(b);
  u16(a.seqs.length);
  for (const s of a.seqs) {
    str(s.name); u16(s.frames); f32(s.length);
    for (const t of s.tracks) {
      u16(t.pos.length / 3); u16(t.rot.length / 4);
      parts.push(Buffer.from(t.pos.buffer, t.pos.byteOffset, t.pos.byteLength), Buffer.from(t.rot.buffer, t.rot.byteOffset, t.rot.byteLength));
    }
  }
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/**
 * Exports every PC_Male AnimSet (locomotion, per-weapon overrides, aim offsets) plus `extra` sets (key -> loader,
 * e.g. first-person weapon animations from their own packages) to outDir/models/anims.
 */
export function exportAnims(game: UPackage, outDir: string, log: (s: string) => void, extra: Record<string, () => AnimSetData | null> = {}) {
  const dir = join(outDir, 'models', 'anims');
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, { file: string; seqs: string[] }> = {};
  const write = (key: string, set: AnimSetData) => {
    writeFileSync(join(dir, `${key}.aanm`), encodeAnimSet(set));
    manifest[key] = { file: `${key}.aanm`, seqs: set.seqs.map((s) => s.name) };
  };
  for (let i = 0; i < game.exports.length; i++) {
    if (game.className(game.exports[i]) !== 'AnimSet') continue;
    const path = game.refPath(i + 1);
    if (!path.startsWith('PC_Male.AnimSets.')) continue;
    const set = readAnimSet(game, i);
    if (!set?.seqs.length) { log(`  ! anim set ${path}: no raw animation data`); continue; }
    write(path.slice('PC_Male.AnimSets.'.length).toLowerCase(), set);
  }
  let extras = 0;
  for (const [key, load] of Object.entries(extra)) {
    try {
      const set = load();
      if (set?.seqs.length) { write(key, set); extras++; } else log(`  ! anim set ${key}: not found or no raw data`);
    } catch (err) { log(`  ! anim set ${key}: ${(err as Error).message}`); }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ sets: manifest }));
  log(`animations: ${Object.keys(manifest).length} sets (${extras} first-person)`);
}
