import type { ModeId } from '../data/modes.js';
import { ByteReader, ByteWriter } from '../net/bytes.js';
import type { OBB } from '../sim/collision.js';
import { Heightfield } from '../sim/terrain.js';
import type { EntityKind, MapData, MapEntity, MeshAsset, MeshInstance } from './spec.js';
import type { ThemeId } from './themes.js';

const MAGIC = 0x4152_4d33; // "ARM3"

/** Compact binary form used to stream server-hosted (original) maps to clients. */
export function encodeMapData(m: MapData): Uint8Array {
  const w = new ByteWriter(1 << 20);
  w.u32(MAGIC).str(m.id).str(m.name).str(m.theme).str(m.source).str(m.modes.join(','));
  const t = m.terrain;
  w.f32(t.width).f32(t.depth).u32(t.resX).u32(t.resZ).f32(t.originX).f32(t.originZ);
  let lo = Infinity, hi = -Infinity;
  for (const h of t.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const range = hi - lo || 1;
  w.f32(lo).f32(range);
  for (const h of t.heights) w.u16(Math.round(((h - lo) / range) * 65535));
  const holeIdx: number[] = [];
  if (t.holes) t.holes.forEach((v, i) => { if (v) holeIdx.push(i); });
  w.u32(holeIdx.length);
  for (const i of holeIdx) w.u32(i);

  const mats = [...new Set(m.boxes.map((b) => b.mat))];
  w.u16(mats.length);
  for (const s of mats) w.str(s);
  w.u32(m.boxes.length);
  for (const b of m.boxes) {
    w.f32(b.c.x).f32(b.c.y).f32(b.c.z).f32(b.h[0]).f32(b.h[1]).f32(b.h[2]);
    for (const a of b.axes) w.f32(a);
    w.u16(mats.indexOf(b.mat)).u8(b.noCollide ? 1 : 0);
  }
  w.u32(m.entities.length);
  for (const e of m.entities) {
    w.str(e.kind).u8(e.team).f32(e.pos.x).f32(e.pos.y).f32(e.pos.z).f32(e.yaw).str(e.modes?.join(',') ?? '').str(e.tag ?? '');
  }
  const meshes = m.meshes ?? [];
  w.u32(meshes.length);
  for (const me of meshes) {
    const nv = me.positions.length / 3;
    w.str(me.name).str(me.mat).u8((me.collide ? 1 : 0) | (me.hidden ? 2 : 0) | (me.uvs ? 4 : 0)).u32(nv);
    for (const v of me.positions) w.f32(v);
    w.u32(me.indices.length);
    if (nv < 65536) for (const i of me.indices) w.u16(i);
    else for (const i of me.indices) w.u32(i);
    if (me.uvs) for (const v of me.uvs) w.f32(v);
    const groups = me.groups ?? [];
    w.u16(groups.length);
    for (const g of groups) w.u32(g.start).u32(g.count).i32(g.tex);
  }
  const inst = m.instances ?? [];
  w.u32(inst.length);
  for (const it of inst) {
    w.u32(it.mesh).u8(it.team ?? 255);
    for (const v of it.m) w.f32(v);
  }
  w.f32(m.killZ ?? -1e9);
  const tex = m.textures ?? [];
  w.u32(tex.length);
  for (const s of tex) w.str(s);
  const layers = m.terrainLayers ?? [];
  w.u8(layers.length);
  for (const l of layers) w.i32(l.tex).f32(l.scale);
  const splat = m.terrainSplat;
  w.u32(splat ? splat.length : 0);
  if (splat) w.bytes(splat);
  w.str(m.env ? JSON.stringify(m.env) : '');
  return w.finish();
}

export function decodeMapData(data: Uint8Array): MapData {
  const r = new ByteReader(data);
  if (r.u32() !== MAGIC) throw new Error('Not an Ascend Reborn map blob');
  const id = r.str(), name = r.str(), theme = r.str() as ThemeId, source = r.str() as MapData['source'];
  const modes = r.str().split(',').filter(Boolean) as ModeId[];
  const width = r.f32(), depth = r.f32(), resX = r.u32(), resZ = r.u32(), originX = r.f32(), originZ = r.f32();
  const lo = r.f32(), range = r.f32();
  const heights = new Float32Array(resX * resZ);
  for (let i = 0; i < heights.length; i++) heights[i] = lo + (r.u16() / 65535) * range;
  const terrain = new Heightfield(width, depth, resX, resZ, heights, originX, originZ);
  const nHoles = r.u32();
  if (nHoles) {
    terrain.holes = new Uint8Array(resX * resZ);
    for (let i = 0; i < nHoles; i++) terrain.holes[r.u32()] = 1;
  }

  const mats: string[] = [];
  const nm = r.u16();
  for (let i = 0; i < nm; i++) mats.push(r.str());
  const boxes: OBB[] = [];
  const nb = r.u32();
  for (let i = 0; i < nb; i++) {
    const c = { x: r.f32(), y: r.f32(), z: r.f32() };
    const h: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const axes = Array.from({ length: 9 }, () => r.f32()) as OBB['axes'];
    const mat = mats[r.u16()];
    const noCollide = r.u8() === 1;
    boxes.push({ c, h, axes, mat, noCollide: noCollide || undefined });
  }
  const entities: MapEntity[] = [];
  const ne = r.u32();
  for (let i = 0; i < ne; i++) {
    const kind = r.str() as EntityKind, team = r.u8();
    const pos = { x: r.f32(), y: r.f32(), z: r.f32() }, yaw = r.f32();
    const ms = r.str(), tag = r.str();
    entities.push({ kind, team, pos, yaw, modes: ms ? (ms.split(',') as ModeId[]) : undefined, tag: tag || undefined });
  }
  const meshes: MeshAsset[] = [];
  const nMesh = r.u32();
  for (let i = 0; i < nMesh; i++) {
    const name = r.str(), mat = r.str(), flags = r.u8(), nv = r.u32();
    const collide = (flags & 1) !== 0, hidden = (flags & 2) !== 0;
    const positions = new Float32Array(nv * 3);
    for (let k = 0; k < positions.length; k++) positions[k] = r.f32();
    const ni = r.u32();
    const indices = new Uint32Array(ni);
    if (nv < 65536) for (let k = 0; k < ni; k++) indices[k] = r.u16();
    else for (let k = 0; k < ni; k++) indices[k] = r.u32();
    let uvs: Float32Array | undefined;
    if (flags & 4) { uvs = new Float32Array(nv * 2); for (let k = 0; k < uvs.length; k++) uvs[k] = r.f32(); }
    const ng = r.u16();
    const groups: NonNullable<MeshAsset['groups']> = [];
    for (let k = 0; k < ng; k++) groups.push({ start: r.u32(), count: r.u32(), tex: r.i32() });
    meshes.push({ name, mat, collide, hidden: hidden || undefined, positions, indices, uvs, groups: ng ? groups : undefined });
  }
  const instances: MeshInstance[] = [];
  const nInst = r.u32();
  for (let i = 0; i < nInst; i++) {
    const mesh = r.u32(), team = r.u8();
    const mm = new Float32Array(12);
    for (let k = 0; k < 12; k++) mm[k] = r.f32();
    instances.push({ mesh, m: mm, team: team === 255 ? undefined : team });
  }
  const killZ = r.f32();
  const textures: string[] = [];
  const nt = r.u32();
  for (let i = 0; i < nt; i++) textures.push(r.str());
  const terrainLayers: NonNullable<MapData['terrainLayers']> = [];
  const nl = r.u8();
  for (let i = 0; i < nl; i++) terrainLayers.push({ tex: r.i32(), scale: r.f32() });
  const ns = r.u32();
  let terrainSplat: Uint8Array | undefined;
  if (ns) terrainSplat = r.bytes(ns).slice();
  const envStr = r.str();
  let env: MapData['env'];
  try { env = envStr ? JSON.parse(envStr) : undefined; } catch { env = undefined; }
  return {
    id, name, theme, source, modes, terrain, boxes, entities, meshes, instances, killZ: killZ > -1e8 ? killZ : undefined,
    textures: nt ? textures : undefined, terrainLayers: nl ? terrainLayers : undefined, terrainSplat, env,
  };
}

export async function mapHash(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
