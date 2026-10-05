import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { buildCollisionWorld, Heightfield, isForceFieldMesh, UU_PER_METER, type MapBlocker, type MapBoost, type MapData, type MapEntity, type MapEnv, type MapVolume, type MeshAsset, type MeshFx, type MeshInstance, type ModeId, type TerrainLayer, type ThemeId, type EntityKind } from '@ar/shared';
import { packLightmaps, type LightmapSource } from './lightmaps.js';
import type { TextureData } from './texture.js';
import { diffuseParams, materialBlend, materialFx, resolveDiffuse, resolveNormal, resolveSpecular, Resolver, type ObjRef } from './material.js';
import { extractStaticMesh } from './mesh.js';
import { extractModel, type ModelPolys } from './model.js';
import { isRaw, isRef, isRot, isVec, parseObject, parseStructArray, type PropValue, type Rot, type Vec } from './props.js';
import { UPackage, type ExportEntry } from './upk.js';

interface MatInfo { tex: number; ntex: number; stex: number; fx?: MeshFx; tile?: number; tint?: [number, number, number] }

const S = 1 / UU_PER_METER;
const ROT = (Math.PI * 2) / 65536;

// UE3 (X fwd, Y right, Z up) -> map space (x = X, y = Z, z = Y), meters.
const toMap = (v: Vec) => ({ x: v.x * S, y: v.z * S, z: v.y * S });

export const MODE_PREFIX: [string, ModeId][] = [
  ['TrCTFBlitz-', 'blitz'], ['TrCTF-', 'ctf'], ['TrCaH-', 'cah'], ['TrTeamRabbit-', 'tdm'], ['TrRabbit-', 'rabbit'], ['TrArena-', 'arena'], ['TrTraining-', 'training'],
];

export function modeFromFile(file: string): ModeId | null {
  const b = basename(file);
  for (const [p, m] of MODE_PREFIX) if (b.startsWith(p)) return m;
  return null;
}

const CLASS_KIND: [RegExp, EntityKind][] = [
  [/^TrCTFBase_/, 'flag_stand'], [/^TrPowerGenerator_/, 'generator'], [/^TrBaseTurret_/, 'base_turret'], [/^TrRadarStation_/, 'radar'],
  [/^TrInventoryStation_/, 'inventory'], [/^TrRepairStation_/, 'repair_station'], [/^TrVehicleStation_/, 'vehicle_pad'],
  [/PlayerStart/, 'spawn'], [/^BookMark/, 'bookmark'], [/CaHCapturePoint|CaHControlPoint|TrCaHPoint/i, 'cap_point'],
  [/^TrFlagRabbit|RabbitFlag|TrRabbitBase|TrFlagTDM|TDMFlag/i, 'rabbit_flag'], [/^TrVehiclePad/, 'bookmark'],
];

function teamFromClass(c: string, props: Map<string, PropValue>): number {
  if (/BloodEagle/i.test(c)) return 0;
  if (/DiamondSword/i.test(c)) return 1;
  const tn = props.get('TeamNumber') ?? props.get('TeamIndex') ?? props.get('DefenderTeamIndex') ?? props.get('m_DefenderTeamIndex');
  if (typeof tn === 'number' && (tn === 0 || tn === 1)) return tn;
  return 255;
}

function meshMaterial(name: string): string {
  const n = name.toLowerCase();
  if (/lava/.test(n)) return 'lava';
  if (/water/.test(n)) return 'water';
  if (/rock|cliff|boulder|stone|mountain/.test(n)) return 'rock';
  if (/ice|crystal|spike/.test(n)) return 'ice';
  if (/tree|trunk|wood|log|branch/.test(n)) return 'wood';
  if (/leaf|leaves|foliage|bush|plant|grass|fern/.test(n)) return 'leaves';
  if (/glass|window/.test(n)) return 'glass';
  if (/pad|ramp|floor|platform|catwalk/.test(n)) return 'floor';
  if (/pipe|metal|rail|beam|strut|truss|antenna|tower/.test(n)) return 'metal';
  return 'concrete';
}

function noCollide(name: string): boolean {
  return /leaf|leaves|foliage|grass|fern|smoke|fx_|_fx|decal|light_?shaft|lightbeam|glow|hologram|waterfall|fog|cloud|sky|waterplane|lavaplane/i.test(name);
}

/** Sky cards (star fields, nebula paintings, out-of-bounds backdrops) stay out of the map. */
const SKIP_MESH = /starfield|shootingstar|_stars?_|nebula|outofbounds|gridplane|rimlight/i;
/** Authored sky domes are kept: the client draws them unlit behind everything and lights the scene from them. */
const SKY_MESH = /skydome|skybox|skysphere|sky_?hemi/i;
/** Invisible in game, collision only (map-edge "creativity walls", blockers). */
const HIDDEN_MESH = /creativitywall|walllimit|invisiblewall|invis_?wall|blocker|blockingmesh|collision_?only/i;

/** Largest vertex distance from the origin, in metres — used to rank authored sky domes by size. */
function meshRadius(p: Float32Array): number {
  let r = 0;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2];
    if (d > r) r = d;
  }
  return Math.sqrt(r);
}

/** 3x3 column-major UE rotation (from FRotationMatrix rows) times per-axis scale, converted to map axes. */
function transform(loc: Vec, rot: Rot, scale: Vec): Float32Array {
  const P = rot.pitch * ROT, Y = rot.yaw * ROT, R = rot.roll * ROT;
  const SP = Math.sin(P), CP = Math.cos(P), SY = Math.sin(Y), CY = Math.cos(Y), SR = Math.sin(R), CR = Math.cos(R);
  const rows = [
    [CP * CY, CP * SY, SP],
    [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP],
    [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP],
  ];
  const sc = [scale.x, scale.y, scale.z];
  // A[r][c] = rows[c][r] * sc[c]  (UE space, column-vector convention)
  const A = [0, 1, 2].map((r) => [0, 1, 2].map((c) => rows[c][r] * sc[c]));
  // Swap Y/Z on both sides (P A P); mesh positions are pre-converted to map axes in meters.
  const p = [0, 2, 1];
  const m = new Float32Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 4 + c] = A[p[r]][p[c]];
  const t = toMap(loc);
  m[3] = t.x; m[7] = t.y; m[11] = t.z;
  return m;
}

function actorScale(P: Map<string, PropValue>): Vec {
  const ds = typeof P.get('DrawScale') === 'number' ? (P.get('DrawScale') as number) : 1;
  const d3 = isVec(P.get('DrawScale3D')) ? (P.get('DrawScale3D') as Vec) : { x: 1, y: 1, z: 1 };
  return { x: ds * d3.x, y: ds * d3.y, z: ds * d3.z };
}

/** Brush volume -> convex hull planes (outward normals, inside where n·p <= d) in map metres. */
function volumeFrom(model: ModelPolys, pre: Vec, m: Float32Array, kind: MapVolume['kind'], dps: number): MapVolume | null {
  const pts = model.points;
  const world = (i: number) => {
    const x = (pts[i * 3] - pre.x) * S, y = (pts[i * 3 + 2] - pre.z) * S, z = (pts[i * 3 + 1] - pre.y) * S;
    return { x: m[0] * x + m[1] * y + m[2] * z + m[3], y: m[4] * x + m[5] * y + m[6] * z + m[7], z: m[8] * x + m[9] * y + m[10] * z + m[11] };
  };
  const polys = [...model.visibleSolid, ...model.invisibleSolid, ...model.visibleNonSolid].filter((p) => p.length >= 3).map((p) => p.map(world));
  if (!polys.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity }, c = { x: 0, y: 0, z: 0 };
  let n = 0;
  for (const p of polys) for (const v of p) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    c.x += v.x; c.y += v.y; c.z += v.z; n++;
  }
  c.x /= n; c.y /= n; c.z /= n;
  const planes: number[] = [];
  for (const p of polys) {
    // Newell normal, oriented away from the centroid (winding flips with the axis swap, so do not rely on it).
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    nx /= l; ny /= l; nz /= l;
    let d = nx * p[0].x + ny * p[0].y + nz * p[0].z;
    if (nx * c.x + ny * c.y + nz * c.z > d) { nx = -nx; ny = -ny; nz = -nz; d = -d; }
    let dup = false;
    for (let k = 0; k < planes.length && !dup; k += 4) dup = planes[k] * nx + planes[k + 1] * ny + planes[k + 2] * nz > 0.9999 && Math.abs(planes[k + 3] - d) < 0.01;
    if (!dup) planes.push(nx, ny, nz, d);
  }
  // Only convex brushes reduce to planes; a hollow one (Blueshift's space shell) would otherwise swallow the map.
  const tol = 0.05 + 1e-4 * Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  for (const p of polys) for (const v of p) {
    for (let k = 0; k < planes.length; k += 4) if (planes[k] * v.x + planes[k + 1] * v.y + planes[k + 2] * v.z - planes[k + 3] > tol) return null;
  }
  return planes.length >= 4 ? { kind, dps, min, max, planes: new Float32Array(planes) } : null;
}

export interface ImportOptions {
  cookedDir: string; id: string; name: string; theme: ThemeId; log?: (s: string) => void;
  /** Export a texture once; returns the shared texture name or null if it could not be read. */
  onTexture?: (t: ObjRef) => string | null;
  /** Write a packed lightmap page; returns its texture name or null. */
  onLightmapPage?: (t: TextureData) => string | null;
}

interface LightmapPending { inst: MeshInstance; src: number; st: [number, number, number, number]; scale: [number, number, number] }

let fileIndex: Map<string, string> | null = null;
export function indexCooked(dir: string): Map<string, string> {
  if (fileIndex) return fileIndex;
  fileIndex = new Map();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (['.upk', '.fmap', '.udk', '.u'].includes(extname(f).toLowerCase())) fileIndex!.set(basename(f, extname(f)).toLowerCase(), p);
    }
  };
  walk(dir);
  return fileIndex;
}

const pkgCache = new Map<string, UPackage>();
export function loadPackage(path: string): UPackage {
  let p = pkgCache.get(path);
  if (!p) { p = new UPackage(path); pkgCache.set(path, p); }
  return p;
}

let resolver: Resolver | null = null;

const colorOf = (v: PropValue | undefined, def: number): number => {
  if (!isRaw(v)) return def;
  if (v.raw.length === 4) return (v.raw[2] << 16) | (v.raw[1] << 8) | v.raw[0];
  if (v.raw.length === 16) {
    const f = new DataView(v.raw.buffer, v.raw.byteOffset, 16);
    const c = (i: number) => Math.round(Math.min(1, Math.max(0, f.getFloat32(i * 4, true))) * 255);
    return (c(0) << 16) | (c(1) << 8) | c(2);
  }
  return def;
};
const num = (v: PropValue | undefined, def: number) => (typeof v === 'number' ? v : def);

export function importMap(files: string[], mode: ModeId, opts: ImportOptions): MapData {
  const log = opts.log ?? (() => {});
  const main = loadPackage(files[0]);
  const pkgs: UPackage[] = [main];
  const idx = indexCooked(opts.cookedDir);
  for (const e of main.exports) {
    if (!main.className(e).startsWith('LevelStreaming')) continue;
    const obj = parseObject(main, main.exportData(e));
    const name = obj?.props.get('PackageName');
    if (typeof name !== 'string' || /_sound$/i.test(name)) continue;
    const local = join(dirname(files[0]), `${name}.fmap`);
    const path = existsSync(local) ? local : idx.get(name.toLowerCase());
    if (path) pkgs.push(loadPackage(path));
    else log(`  ! streaming level ${name} not found`);
  }
  for (const f of files.slice(1)) pkgs.push(loadPackage(f));

  const meshes: MeshAsset[] = [];
  const allTerrains: { hf: Heightfield; layers?: TerrainLayer[]; splat?: Uint8Array }[] = [];
  const meshIndex = new Map<string, number>();
  const instances: MeshInstance[] = [];
  const entities: MapEntity[] = [];
  const volumes: MapVolume[] = [];
  const boosts: MapBoost[] = [];
  const blockers: MapBlocker[] = [];
  const spawnOrder = new Map<MapEntity, number>();
  const lmSources: LightmapSource[] = [];
  const lmSourceIndex = new Map<string, number>();
  const lmPending: LightmapPending[] = [];
  /** Static meshes with simple collision (a BodySetup), i.e. ones that stop players in TA. */
  const bodyMeshes = new Set<string>();
  /** Non-colliding copies of meshes (actors with collision switched off), and how often each was used. */
  const ncMesh = new Map<number, number>();
  const ncCount = new Map<string, number>();
  /** Collision-only copies of meshes on actors hidden in game. */
  const hiddenMesh = new Map<number, number>();
  const hiddenCount = { proxies: 0, dropped: 0 };
  let terrain: Heightfield | null = null;
  let killZ: number | undefined;
  const env: MapEnv = {};
  const textures: string[] = [];
  const texIndex = new Map<string, number>();
  let terrainLayers: TerrainLayer[] | undefined;
  let terrainSplat: Uint8Array | undefined;
  resolver ??= new Resolver(idx, loadPackage);
  const R = resolver;

  /** Material reference -> index into `textures` (diffuse), or -1. */
  const archCache = new Map<string, { pkg: UPackage; exp: ExportEntry; props: Map<string, PropValue> } | null>();
  const archetypeOf = (pkg: UPackage, exp: ExportEntry) => {
    if (!exp.archetype) return null;
    const key = `${pkg.path}:${exp.archetype}`;
    let a = archCache.get(key);
    if (a === undefined) {
      const o = R.get(pkg, exp.archetype);
      const props = o ? R.props(o) : null;
      a = o && props ? { pkg: o.pkg, exp: o.exp, props } : null;
      archCache.set(key, a);
    }
    return a;
  };
  /** A property from the object or, when omitted because it equals the template (prefab instances), from its archetype chain. */
  const inherited = (pkg: UPackage, exp: ExportEntry, props: Map<string, PropValue> | undefined, name: string): { pkg: UPackage; v: PropValue } | null => {
    let cur: { pkg: UPackage; exp: ExportEntry; props?: Map<string, PropValue> } | null = { pkg, exp, props };
    for (let d = 0; d < 5 && cur; d++) {
      const v = cur.props?.get(name);
      if (v !== undefined) return { pkg: cur.pkg, v };
      cur = archetypeOf(cur.pkg, cur.exp);
    }
    return null;
  };

  const texIndexOf = (tex: ObjRef | null): number => {
    if (!tex || !opts.onTexture) return -1;
    const name = opts.onTexture(tex);
    if (!name) return -1;
    let ti = texIndex.get(name) ?? -1;
    if (ti < 0) { ti = textures.length; textures.push(name); texIndex.set(name, ti); }
    return ti;
  };
  const infoCache = new Map<string, MatInfo>();
  /** Diffuse + normal + specular map, diffuse tiling / tint and liquid / blend tag of a material reference. */
  const matInfo = (pkg: UPackage, ref: number): MatInfo => {
    if (!ref || !opts.onTexture) return { tex: -1, ntex: -1, stex: -1 };
    const key = `${pkg.path}:${ref}`;
    const hit = infoCache.get(key);
    if (hit) return hit;
    const mat = R.get(pkg, ref);
    const dif = mat ? resolveDiffuse(R, mat) : null;
    const info: MatInfo = mat
      ? { tex: texIndexOf(dif), ntex: texIndexOf(resolveNormal(R, mat)), stex: texIndexOf(resolveSpecular(R, mat)), fx: materialFx(R, mat) ?? materialBlend(R, mat), ...diffuseParams(R, mat, dif) }
      : { tex: -1, ntex: -1, stex: -1 };
    infoCache.set(key, info);
    return info;
  };
  const groupOf = (mi: MatInfo) => ({ tex: mi.tex, ntex: mi.ntex >= 0 ? mi.ntex : undefined, stex: mi.stex >= 0 ? mi.stex : undefined, fx: mi.fx, tile: mi.tile, tint: mi.tint });
  /** Authored sky domes found while resolving meshes; the best is chosen after the import walk. */
  const skyCands: { mesh: number, radius: number, groups?: NonNullable<MeshAsset['groups']> }[] = [];

  const resolveMesh = (pkg: UPackage, ref: number, overrides: number[] = []): number => {
    let owner = pkg, exp: ExportEntry | undefined;
    const fullPath = pkg.refPath(ref);
    const baseKey = fullPath;
    const ovKey = overrides.some((o) => o) ? `${fullPath}|${overrides.join(',')}` : fullPath;
    if (meshIndex.has(ovKey)) return meshIndex.get(ovKey)!;
    if (ovKey !== baseKey && meshIndex.has(baseKey)) {
      const bi = meshIndex.get(baseKey)!;
      if (bi < 0) return -1;
      const base = meshes[bi];
      const groups = base.groups?.map((g, k) => {
        if (!overrides[k]) return g;
        const mi = matInfo(pkg, overrides[k]);
        return { ...g, ...groupOf(mi) };
      });
      if (!groups || groups.every((g, k) => g === base.groups![k])) { meshIndex.set(ovKey, bi); return bi; }
      meshes.push({ ...base, groups });
      meshIndex.set(ovKey, meshes.length - 1);
      // Painted clones are the domes that actually show art, so they must be candidates too.
      if (base.sky) skyCands.push({ mesh: meshes.length - 1, radius: meshRadius(base.positions), groups });
      return meshes.length - 1;
    }
    if (ref > 0) exp = pkg.exports[ref - 1];
    else {
      const [pkgName, ...rest] = fullPath.split('.');
      const path = idx.get(pkgName.toLowerCase());
      if (!path) { meshIndex.set(fullPath, -1); return -1; }
      owner = loadPackage(path);
      const want = rest.join('.');
      const i = owner.exports.findIndex((e) => owner.className(e) === 'StaticMesh' && owner.refPath(owner.exports.indexOf(e) + 1) === want);
      exp = i >= 0 ? owner.exports[i] : undefined;
    }
    const md = exp ? extractStaticMesh(owner, exp) : null;
    if (!md) { meshIndex.set(fullPath, -1); log(`  ! mesh not extracted: ${fullPath}`); return -1; }
    if (SKIP_MESH.test(md.name)) { meshIndex.set(fullPath, -1); return -1; }
    const body = exp ? parseObject(owner, owner.exportData(exp))?.props : undefined;
    if (isRef(body?.get('BodySetup')) && (body!.get('BodySetup') as { ref: number }).ref !== 0) bodyMeshes.add(md.name);
    const lmIndex = num(body?.get('LightMapCoordinateIndex'), 0);
    const uv2 = lmIndex > 0 ? md.uvSets[lmIndex] : undefined;
    const positions = new Float32Array(md.positions.length);
    for (let i = 0; i < md.positions.length; i += 3) {
      positions[i] = md.positions[i] * S;
      positions[i + 1] = md.positions[i + 2] * S;
      positions[i + 2] = md.positions[i + 1] * S;
    }
    // Axis swap flips handedness, so reverse winding to keep faces outward.
    const indices = new Uint32Array(md.indices.length);
    for (let i = 0; i < md.indices.length; i += 3) { indices[i] = md.indices[i]; indices[i + 1] = md.indices[i + 2]; indices[i + 2] = md.indices[i + 1]; }
    const hidden = HIDDEN_MESH.test(md.name);
    const sky = SKY_MESH.test(md.name);
    const groups = md.sections.length && md.uvs ? md.sections.map((s) => {
      const mi = matInfo(owner, s.material);
      return { start: s.firstIndex, count: s.numTriangles * 3, ...groupOf(mi) };
    }) : undefined;
    meshes.push({
      name: md.name, positions, indices, mat: meshMaterial(md.name), collide: hidden || !noCollide(md.name), hidden: hidden || undefined,
      sky: sky || undefined,
      uvs: groups ? md.uvs! : undefined, uv2: groups ? uv2 : undefined, groups,
    });
    meshIndex.set(fullPath, meshes.length - 1);
    // Remember every authored dome; the best one is picked once all meshes are in.
    if (sky) skyCands.push({ mesh: meshes.length - 1, radius: meshRadius(positions), groups });
    return overrides.some((o) => o) ? resolveMesh(pkg, ref, overrides) : meshes.length - 1;
  };

  /** Fan-triangulate convex UE-space polygons into a map-space mesh asset (meters, reversed winding). */
  const pushPolys = (name: string, pts: Float32Array, polys: number[][], mat: string, collide: boolean, hidden: boolean, pivot = { x: 0, y: 0, z: 0 }): number => {
    if (!polys.length) return -1;
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const idx: number[] = [];
    const vid = (p: number) => {
      let r = remap.get(p);
      if (r === undefined) {
        r = pos.length / 3;
        remap.set(p, r);
        pos.push((pts[p * 3] - pivot.x) * S, (pts[p * 3 + 2] - pivot.z) * S, (pts[p * 3 + 1] - pivot.y) * S);
      }
      return r;
    };
    for (const poly of polys) {
      const a = vid(poly[0]);
      for (let i = 1; i + 1 < poly.length; i++) idx.push(a, vid(poly[i + 1]), vid(poly[i]));
    }
    meshes.push({ name, positions: new Float32Array(pos), indices: new Uint32Array(idx), mat, collide, hidden: hidden || undefined });
    return meshes.length - 1;
  };
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

  /**
   * TA's baked (Lightmass) lighting of a StaticMeshComponent: after its properties come LODData[]; LOD 0 holds shadow
   * maps, then an FLightMap2D (type 2: light GUIDs, three textures + scale vectors, atlas coordinate scale and bias).
   * The third texture is the simple (non-directional) lightmap.
   */
  const lightmapOf = (pkg: UPackage, comp: ExportEntry, end: number): Omit<LightmapPending, 'inst'> | undefined => {
    const d = pkg.exportData(comp);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = end;
    const i32 = () => { const x = v.getInt32(o, true); o += 4; return x; };
    const f32 = () => { const x = v.getFloat32(o, true); o += 4; return x; };
    try {
      if (o + 24 > d.length || i32() < 1) return undefined;
      for (let k = 0; k < 2; k++) { const n = i32(); if (n < 0 || n > 64) return undefined; o += n * 4; }
      if (i32() !== 2) return undefined;
      const guids = i32();
      if (guids < 0 || guids > 4096) return undefined;
      o += guids * 16;
      const tex: number[] = [], scale: number[][] = [];
      for (let k = 0; k < 3; k++) { tex.push(i32()); scale.push([f32(), f32(), f32()]); }
      const st: [number, number, number, number] = [f32(), f32(), f32(), f32()];
      const ref = tex[2];
      if (o > d.length || ref <= 0 || pkg.className(pkg.exports[ref - 1]) !== 'LightMapTexture2D' || !st.every(Number.isFinite)) return undefined;
      const key = `${pkg.path}:${ref}`;
      let src = lmSourceIndex.get(key);
      if (src === undefined) { src = lmSources.length; lmSources.push({ pkg, exp: pkg.exports[ref - 1] }); lmSourceIndex.set(key, src); }
      return { src, st, scale: [scale[2][0], scale[2][1], scale[2][2]] };
    } catch { return undefined; }
  };

  /** Ops wired to a Kismet op's outputs (only the output labelled `label` when given). */
  const kismetOut = (pkg: UPackage, props: Map<string, PropValue>, label?: string): number[] => {
    const out: number[] = [];
    for (const link of parseStructArray(pkg, props.get('OutputLinks'))) {
      if (label && link.get('LinkDesc') !== label) continue;
      for (const l of parseStructArray(pkg, link.get('Links'))) { const op = l.get('LinkedOp'); if (isRef(op) && op.ref > 0) out.push(op.ref); }
    }
    return out;
  };
  /** First Kismet variable plugged into a variable link (export ref, 0 if none). */
  const kismetVarRef = (pkg: UPackage, props: Map<string, PropValue>, label: string): number => {
    for (const link of parseStructArray(pkg, props.get('VariableLinks'))) {
      const lv = link.get('LinkedVariables');
      if (link.get('LinkDesc') !== label || !isRaw(lv) || lv.raw.length < 8) continue;
      return new DataView(lv.raw.buffer, lv.raw.byteOffset, lv.raw.byteLength).getInt32(4, true);
    }
    return 0;
  };
  const kismetVar = (pkg: UPackage, props: Map<string, PropValue>, label: string): Map<string, PropValue> | null => {
    const ref = kismetVarRef(pkg, props, label);
    return ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[ref - 1]))?.props ?? null : null;
  };
  /** Actors (export refs) whose collision / visibility a generator's Online/Offline Kismet toggles -> that team. */
  const generatorGated = (pkg: UPackage): Map<number, number> => {
    const out = new Map<number, number>();
    pkg.exports.forEach((e, i) => {
      if (pkg.className(e) !== 'TrSeqEvent_Generator') return;
      const P = parseObject(pkg, pkg.exportData(e))?.props;
      const gen = P?.get('Originator');
      if (!P || !isRef(gen) || gen.ref <= 0) return;
      const gc = pkg.className(pkg.exports[gen.ref - 1]);
      const team = /BloodEagle/.test(gc) ? 0 : /DiamondSword/.test(gc) ? 1 : -1;
      if (team < 0) return;
      for (const op of [...kismetOut(pkg, P, 'Online'), ...kismetOut(pkg, P, 'Offline')]) {
        const ex = pkg.exports[op - 1];
        if (!ex || !/^SeqAct_(ChangeCollision|ToggleHidden|Toggle)$/.test(pkg.className(ex))) continue;
        const OP = parseObject(pkg, pkg.exportData(ex))?.props;
        for (const link of parseStructArray(pkg, OP?.get('VariableLinks'))) {
          const lv = link.get('LinkedVariables');
          if (link.get('LinkDesc') !== 'Target' || !isRaw(lv) || lv.raw.length < 4) continue;
          const dv = new DataView(lv.raw.buffer, lv.raw.byteOffset, lv.raw.byteLength);
          for (let k = 0; k < dv.getInt32(0, true) && 8 + k * 4 <= lv.raw.length; k++) {
            const vr = dv.getInt32(4 + k * 4, true);
            const obj = vr > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[vr - 1]))?.props.get('ObjValue') : undefined;
            if (isRef(obj) && obj.ref > 0) out.set(obj.ref, team);
          }
        }
      }
    });
    return out;
  };
  /**
   * TA accelerators and launch pads are Kismet: Touch(volume) -> [GetTeamNum -> CompareInt A == B] -> [SetPhysics]
   * -> SetVelocity(VelocityDir). Hellfire's only fire one way (velocity component vs a threshold); Perdition's
   * dampers read the velocity and halve it.
   */
  const boostsFromTouch = (pkg: UPackage, P: Map<string, PropValue>) => {
    const orig = P.get('Originator');
    if (!isRef(orig) || orig.ref <= 0) return;
    const VP = parseObject(pkg, pkg.exportData(pkg.exports[orig.ref - 1]))?.props;
    const brush = VP?.get('Brush');
    if (!VP || !isRef(brush) || brush.ref <= 0) return;
    const model = extractModel(pkg, pkg.exports[brush.ref - 1]);
    const vloc = isVec(VP.get('Location')) ? (VP.get('Location') as Vec) : { x: 0, y: 0, z: 0 };
    const vrot = isRot(VP.get('Rotation')) ? (VP.get('Rotation') as Rot) : { pitch: 0, yaw: 0, roll: 0 };
    const pre = isVec(VP.get('PrePivot')) ? (VP.get('PrePivot') as Vec) : { x: 0, y: 0, z: 0 };
    const hull = model ? volumeFrom(model, pre, transform(vloc, vrot, actorScale(VP)), 'pain', 0) : null;
    if (!hull) return;
    const seen = new Set<number>();
    const component = new Map<number, 'x' | 'y' | 'z'>();
    const walk = (ref: number, team: number, scale: number | undefined, cond: MapBoost['cond'], depth: number) => {
      if (depth > 12 || seen.has(ref)) return;
      seen.add(ref);
      const ex = pkg.exports[ref - 1];
      const OP = ex ? parseObject(pkg, pkg.exportData(ex))?.props : null;
      if (!ex || !OP) return;
      const c = pkg.className(ex);
      const base = { min: hull.min, max: hull.max, planes: hull.planes, team, cond };
      if (c === 'SeqAct_SetVelocity') {
        const d = OP.get('VelocityDir');
        if (kismetVarRef(pkg, OP, 'Velocity Dir') > 0) {
          if (scale !== undefined && scale !== 1) boosts.push({ ...base, vel: { x: 0, y: 0, z: 0 }, scale });
          return;
        }
        if (!isVec(d)) return;
        const mag = num(OP.get('VelocityMag'), 0), l = Math.hypot(d.x, d.y, d.z) || 1;
        boosts.push({ ...base, vel: toMap(mag > 0 ? { x: (d.x / l) * mag, y: (d.y / l) * mag, z: (d.z / l) * mag } : d) });
        return;
      }
      if (c === 'SeqCond_CompareInt') {
        const b = num(kismetVar(pkg, OP, 'B')?.get('IntValue'), 0);
        for (const n of kismetOut(pkg, OP, 'A == B')) walk(n, b, scale, cond, depth + 1);
        return;
      }
      if (c === 'SeqCond_CompareFloat') {
        const axis = component.get(kismetVarRef(pkg, OP, 'A'));
        const value = num(kismetVar(pkg, OP, 'B')?.get('FloatValue'), 0) * S;
        for (const [label, gt] of [['A < B', false], ['A <= B', false], ['A > B', true], ['A >= B', true]] as const) {
          for (const n of kismetOut(pkg, OP, label)) walk(n, team, scale, axis ? { axis, gt, value } : cond, depth + 1);
        }
        return;
      }
      if (c === 'SeqAct_GetVelocity') scale ??= 1;
      if (c === 'SeqAct_GetVectorComponents') {
        for (const [label, axis] of [['X', 'x'], ['Y', 'z'], ['Z', 'y']] as const) { const r = kismetVarRef(pkg, OP, label); if (r > 0) component.set(r, axis); }
      }
      if (scale === 1 && (c === 'SeqAct_DivideFloat' || c === 'SeqAct_MultiplyFloat')) {
        const b = num(kismetVar(pkg, OP, 'B')?.get('FloatValue'), 1);
        if (b > 0) scale = c === 'SeqAct_DivideFloat' ? 1 / b : b;
      }
      for (const n of kismetOut(pkg, OP)) walk(n, team, scale, cond, depth + 1);
    };
    for (const n of kismetOut(pkg, P, 'Touched')) walk(n, 255, undefined, undefined, 0);
  };
  /**
   * Visible BSP polygons grouped by surface material, with UE3's BSP texture mapping:
   * uv = ((P - pBase) . vTextureU|V) / 128 (each polygon gets its own vertices since UVs are per surface).
   */
  const pushBsp = (pkg: UPackage, name: string, model: ModelPolys, polys: number[][], surfOf: number[], collide: boolean): number => {
    if (!polys.length) return -1;
    const byMat = new Map<number, number[]>();
    polys.forEach((_, i) => {
      const s = model.surfs[surfOf[i]];
      const ref = s && !/DefaultMaterial$/.test(pkg.refPath(s.material)) ? s.material : 0;
      const arr = byMat.get(ref) ?? [];
      arr.push(i);
      byMat.set(ref, arr);
    });
    const P = model.points, V = model.vectors;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const groups: NonNullable<MeshAsset['groups']> = [];
    for (const [ref, list] of byMat) {
      const start = idx.length;
      for (const pi of list) {
        const poly = polys[pi], s = model.surfs[surfOf[pi]];
        const b = s ? s.base * 3 : -1, u = s ? s.u * 3 : -1, w = s ? s.v * 3 : -1;
        const first = pos.length / 3;
        for (const p of poly) {
          const x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
          pos.push(x * S, z * S, y * S);
          if (b >= 0 && u >= 0 && w >= 0 && b + 2 < P.length && u + 2 < V.length && w + 2 < V.length) {
            const dx = x - P[b], dy = y - P[b + 1], dz = z - P[b + 2];
            uv.push((dx * V[u] + dy * V[u + 1] + dz * V[u + 2]) / 128, (dx * V[w] + dy * V[w + 1] + dz * V[w + 2]) / 128);
          } else uv.push(0, 0);
        }
        for (let i = 1; i + 1 < poly.length; i++) idx.push(first, first + i + 1, first + i);
      }
      const mi = matInfo(pkg, ref);
      groups.push({ start, count: idx.length - start, ...groupOf(mi) });
    }
    const textured = groups.some((g) => g.tex >= 0 || g.fx);
    meshes.push({
      name, positions: new Float32Array(pos), indices: new Uint32Array(idx), mat: 'concrete', collide,
      uvs: textured ? new Float32Array(uv) : undefined, groups: textured ? groups : undefined,
    });
    return meshes.length - 1;
  };
  const addLevelBsp = (pkg: UPackage, e: ExportEntry) => {
    const model = extractModel(pkg, e);
    if (!model) return;
    const tag = basename(pkg.path, extname(pkg.path));
    for (const [polys, surfOf, suffix, collide] of [
      [model.visibleSolid, model.visibleSolidSurf, 'bsp', true], [model.visibleNonSolid, model.visibleNonSolidSurf, 'bsp_nonsolid', false],
    ] as const) {
      const mi = pushBsp(pkg, `${tag}_${suffix}`, model, polys, surfOf, collide);
      if (mi >= 0) instances.push({ mesh: mi, m: IDENTITY });
    }
    const mi = pushPolys(`${tag}_bsp_invisible`, model.points, model.invisibleSolid, 'concrete', true, true);
    if (mi >= 0) instances.push({ mesh: mi, m: IDENTITY });
    log(`  BSP ${tag}: ${model.visibleSolid.length} solid, ${model.visibleNonSolid.length} non-solid, ${model.invisibleSolid.length} invisible polys`);
  };

  for (const pkg of pkgs) {
    const gated = generatorGated(pkg);
    // TA rates player starts equally and takes the first best one in the level's navigation list, so keep that order.
    const navNext = new Map<number, number>(), navPointed = new Set<number>(), pkgSpawns: [MapEntity, number][] = [];
    for (let ei = 0; ei < pkg.exports.length; ei++) {
      const e = pkg.exports[ei];
      const outer = pkg.refPath(e.outer);
      if (!outer.startsWith('TheWorld')) continue;
      const cls = pkg.className(e);
      if (cls === 'Model' && outer === 'TheWorld.PersistentLevel') { addLevelBsp(pkg, e); continue; }
      if (/Component$|^Model$|^Polys$|^Level$|^World$|Sequence|^Package$/.test(cls)) continue;
      const obj = parseObject(pkg, pkg.exportData(e));
      if (!obj) continue;
      const P = obj.props;
      const nav = P.get('nextNavigationPoint');
      if (isRef(nav) && nav.ref > 0) { navNext.set(ei + 1, nav.ref); navPointed.add(nav.ref); }
      const loc = isVec(P.get('Location')) ? (P.get('Location') as Vec) : { x: 0, y: 0, z: 0 };
      const rot = isRot(P.get('Rotation')) ? (P.get('Rotation') as Rot) : { pitch: 0, yaw: 0, roll: 0 };

      if (cls === 'WorldInfo') {
        const kz = P.get('KillZ');
        if (typeof kz === 'number') killZ = kz * S;
        continue;
      }

      if (cls === 'Terrain') {
        const data = pkg.exportData(e);
        const nx = Number(P.get('NumVerticesX')), ny = Number(P.get('NumVerticesY'));
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const count = view.getInt32(obj.end, true);
        if (count !== nx * ny) { log(`  ! terrain height count ${count} != ${nx}x${ny}`); continue; }
        const ds3 = isVec(P.get('DrawScale3D')) ? (P.get('DrawScale3D') as Vec) : { x: 256, y: 256, z: 256 };
        const ds = typeof P.get('DrawScale') === 'number' ? (P.get('DrawScale') as number) : 1;
        const heights = new Float32Array(count);
        for (let i = 0; i < count; i++) heights[i] = (loc.z + ((view.getUint16(obj.end + 4 + i * 2, true) - 32768) / 128) * ds3.z * ds) * S;
        const cellX = ds3.x * ds * S, cellZ = ds3.y * ds * S;
        terrain = new Heightfield(cellX * (nx - 1), cellZ * (ny - 1), nx, ny, heights, loc.x * S, loc.y * S);
        const infoOff = obj.end + 4 + count * 2;
        if (infoOff + 4 <= data.length && view.getInt32(infoOff, true) === count) {
          const holes = new Uint8Array(count);
          let nh = 0;
          for (let i = 0; i < count; i++) if (data[infoOff + 4 + i] & 1) { holes[i] = 1; nh++; }
          if (nh) terrain.holes = holes;
          log(`  terrain holes: ${nh}`);
          // AlphaMaps follow InfoData: count, then per map (count, bytes).
          const alpha: Uint8Array[] = [];
          let ao = infoOff + 4 + count;
          const na = ao + 4 <= data.length ? view.getInt32(ao, true) : 0;
          ao += 4;
          for (let k = 0; k < na && k < 32 && ao + 4 <= data.length; k++) {
            const n = view.getInt32(ao, true);
            if (n !== count || ao + 4 + n > data.length) break;
            alpha.push(data.subarray(ao + 4, ao + 4 + n));
            ao += 4 + n;
          }
          const layers = parseStructArray(pkg, P.get('Layers')).filter((l) => l.get('Hidden') !== true);
          const out: TerrainLayer[] = [];
          const splat = new Uint8Array(count * 4);
          for (const layer of layers) {
            if (out.length >= 5) break;
            const setup = layer.get('Setup');
            const tls = isRef(setup) ? R.get(pkg, setup.ref) : null;
            const tlsProps = tls ? R.props(tls) : null;
            const tm = parseStructArray(tls?.pkg ?? pkg, tlsProps?.get('Materials'))[0]?.get('Material');
            const tmat = isRef(tm) && tls ? R.get(tls.pkg, tm.ref) : null;
            const tmProps = tmat ? R.props(tmat) : null;
            const mref = tmProps?.get('Material');
            const info = isRef(mref) && tmat ? matInfo(tmat.pkg, mref.ref) : { tex: -1, ntex: -1, stex: -1 };
            const tex = info.tex;
            const ai = num(layer.get('AlphaMapIndex'), -1);
            if (out.length > 0 && !alpha[ai]) continue;
            if (out.length > 0) { const a = alpha[ai], ch = out.length - 1; for (let i = 0; i < count; i++) splat[i * 4 + ch] = a[i]; }
            out.push({ tex, scale: num(tmProps?.get('MappingScale'), 4) * cellX, ntex: info.ntex >= 0 ? info.ntex : undefined, stex: info.stex >= 0 ? info.stex : undefined });
          }
          if (out.some((l) => l.tex >= 0)) {
            terrainLayers = out;
            if (out.length > 1) terrainSplat = splat;
            log(`  terrain layers: ${out.map((l) => (l.tex >= 0 ? textures[l.tex] : '-')).join(', ')}`);
          }
        }
        log(`  terrain ${nx}x${ny} cell ${cellX.toFixed(2)}m origin (${(loc.x * S).toFixed(0)}, ${(loc.y * S).toFixed(0)})`);
        allTerrains.push({ hf: terrain, layers: terrainLayers, splat: terrainSplat });
        continue;
      }

      if (/DirectionalLight$/.test(cls) && !env.sunDir) {
        const P0 = rot.pitch * ROT, Y0 = rot.yaw * ROT;
        const f = { x: Math.cos(P0) * Math.cos(Y0), y: Math.cos(P0) * Math.sin(Y0), z: Math.sin(P0) };
        env.sunDir = { x: -f.x, y: -f.z, z: -f.y };
        const lc = P.get('LightComponent');
        const lp = isRef(lc) && lc.ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[lc.ref - 1]))?.props : null;
        env.sunColor = colorOf(lp?.get('LightColor'), 0xffffff);
        env.sunIntensity = num(lp?.get('Brightness'), 1);
        // A plain (static) DirectionalLight is baked into the lightmaps; a DominantDirectionalLight stays dynamic.
        if (cls === 'DirectionalLight') env.sunBaked = true;
        continue;
      }
      if (/^SkyLight/.test(cls)) {
        const lc = P.get('LightComponent');
        const lp = isRef(lc) && lc.ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[lc.ref - 1]))?.props : null;
        // Keep the authored sky tint and brightness separate; the client scales them.
        env.ambientColor = colorOf(lp?.get('LightColor'), 0xffffff);
        env.ambientIntensity = num(lp?.get('Brightness'), 1);
        continue;
      }
      if (cls === 'ExponentialHeightFog' || cls === 'HeightFog') {
        const fc = P.get('Component');
        const fp = isRef(fc) && fc.ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[fc.ref - 1]))?.props : null;
        env.fogDensity = num(fp?.get('FogDensity'), 0.02);
        env.fogColor = colorOf(fp?.get('FogInscatteringColor') ?? fp?.get('LightInscatteringColor'), 0x8899aa);
        // Sun-in-scattering colour drives the aerial-perspective glow toward the sun.
        env.fogLightColor = colorOf(fp?.get('LightInscatteringColor'), env.fogColor);
        env.fogStart = num(fp?.get('StartDistance'), 0) * S;
        if (cls === 'ExponentialHeightFog') {
          env.fogHeight = loc.z * S;
          env.fogFalloff = num(fp?.get('FogHeightFalloff'), 0.2);
          env.fogMaxOpacity = num(fp?.get('FogMaxOpacity'), 1);
        }
        continue;
      }
      if (cls === 'TrWeatherVolume') { env.snow = true; continue; }
      if (cls === 'SeqEvent_Touch') { boostsFromTouch(pkg, P); continue; }

      const smc = P.get('StaticMeshComponent');
      // UTKillZVolume kills on touch; PhysicsVolumes with bPainCausing (lava, pits, Walled In's sky) and Blueshift's
      // space GravityVolumes hurt per second.
      if (/(KillZVolume|PhysicsVolume|GravityVolume)$/.test(cls)) {
        const kill = /KillZVolume$/.test(cls), dps = num(P.get('DamagePerSec'), kill ? 90000 : 0);
        const brush = P.get('Brush');
        if ((kill || (P.get('bPainCausing') === true && dps > 0)) && isRef(brush) && brush.ref > 0) {
          const model = extractModel(pkg, pkg.exports[brush.ref - 1]);
          const pre = isVec(P.get('PrePivot')) ? (P.get('PrePivot') as Vec) : { x: 0, y: 0, z: 0 };
          const vol = model ? volumeFrom(model, pre, transform(loc, rot, actorScale(P)), kill ? 'kill' : 'pain', dps) : null;
          if (vol) volumes.push(vol);
        }
        continue;
      }
      if (/BlockingVolume$/.test(cls)) {
        const brush = P.get('Brush');
        const pre = isVec(P.get('PrePivot')) ? (P.get('PrePivot') as Vec) : { x: 0, y: 0, z: 0 };
        const model = isRef(brush) && brush.ref > 0 ? extractModel(pkg, pkg.exports[brush.ref - 1]) : null;
        if (model) {
          const polys = [...model.visibleSolid, ...model.invisibleSolid, ...model.visibleNonSolid];
          const mi = pushPolys(`${cls}_${e.objectName}_${e.nameNumber}`, model.points, polys, 'concrete', true, true, pre);
          if (mi >= 0) instances.push({ mesh: mi, m: transform(loc, rot, actorScale(P)) });
        }
        continue;
      }
      if (isRef(smc) && smc.ref > 0) {
        const comp = pkg.exports[smc.ref - 1];
        const cobj = comp ? parseObject(pkg, pkg.exportData(comp)) : null;
        const sm = comp ? inherited(pkg, comp, cobj?.props, 'StaticMesh') : null;
        if (sm && isRef(sm.v) && sm.v.ref !== 0) {
          const mpkg = sm.pkg;
          const ovp = inherited(pkg, comp, cobj?.props, 'Materials');
          const ov = ovp && ovp.pkg === mpkg ? ovp.v : undefined;
          const overrides: number[] = [];
          if (isRaw(ov) && ov.raw.length >= 4) {
            const dv = new DataView(ov.raw.buffer, ov.raw.byteOffset, ov.raw.byteLength);
            const n = dv.getInt32(0, true);
            for (let k = 0; k < n && 4 + k * 4 + 4 <= ov.raw.length; k++) overrides.push(dv.getInt32(4 + k * 4, true));
          }
          let mi = resolveMesh(mpkg, sm.v.ref, overrides);
          const prop = (x: ExportEntry, p: Map<string, PropValue> | undefined, n: string) => inherited(pkg, x, p, n)?.v;
          if (mi >= 0) {
            // Level designers switch collision off per actor (light beams, decals, set dressing behind blocking volumes).
            if (meshes[mi].collide && !meshes[mi].hidden && !isForceFieldMesh(meshes[mi].name)
              && (prop(e, P, 'bCollideActors') === false || prop(comp, cobj?.props, 'CollideActors') === false)) {
              let nc = ncMesh.get(mi);
              if (nc === undefined) { meshes.push({ ...meshes[mi], collide: false }); nc = meshes.length - 1; ncMesh.set(mi, nc); }
              mi = nc;
              ncCount.set(meshes[mi].name, (ncCount.get(meshes[mi].name) ?? 0) + 1);
            }
            // Actors hidden in game (collision proxies) only collide; hidden ones without collision are dropped.
            // Generator-toggled actors and force fields keep their own handling.
            const hiddenInGame = (prop(e, P, 'bHidden') === true || prop(comp, cobj?.props, 'HiddenGame') === true)
              && !isForceFieldMesh(meshes[mi].name) && !gated.has(ei + 1) && !meshes[mi].hidden;
            if (hiddenInGame && !meshes[mi].collide) { hiddenCount.dropped++; mi = -1; }
            else if (hiddenInGame) {
              let hv = hiddenMesh.get(mi);
              if (hv === undefined) { meshes.push({ ...meshes[mi], hidden: true }); hv = meshes.length - 1; hiddenMesh.set(mi, hv); }
              mi = hv;
              hiddenCount.proxies++;
            }
          }
          if (mi >= 0) {
            const dsv = prop(e, P, 'DrawScale'), d3v = prop(e, P, 'DrawScale3D'), csv = prop(comp, cobj?.props, 'Scale'), c3v = prop(comp, cobj?.props, 'Scale3D');
            const ds = typeof dsv === 'number' ? dsv : 1;
            const d3 = isVec(d3v) ? d3v : { x: 1, y: 1, z: 1 };
            const cs = typeof csv === 'number' ? csv : 1;
            const c3 = isVec(c3v) ? c3v : { x: 1, y: 1, z: 1 };
            const scale = { x: ds * d3.x * cs * c3.x, y: ds * d3.y * cs * c3.y, z: ds * d3.z * cs * c3.z };
            const name = meshes[mi].name;
            const team = /(^|_)BE(_|$)|BloodEagle/i.test(name) ? 0 : /(^|_)DS(_|$)|DiamondSword/i.test(name) ? 1 : undefined;
            instances.push({ mesh: mi, m: transform(loc, rot, scale), team });
            const lmRaw = comp && cobj && opts.onLightmapPage ? lightmapOf(pkg, comp, cobj.end) : undefined;
            if (lmRaw) lmPending.push({ inst: instances[instances.length - 1], ...lmRaw });
            if (isForceFieldMesh(name)) {
              // TA team blockers let their defenders through and drop with their generator; other energy fields with
              // simple collision stop every player, some (SunStar's flag shields) only while a generator runs them.
              // Shots pass either way.
              const flag = (x: ExportEntry, p: Map<string, PropValue> | undefined, n: string) => prop(x, p, n) !== false;
              const gate = gated.get(ei + 1);
              if (cls === 'TrTeamBlockerStaticMeshActor') {
                const t = num(prop(e, P, 'm_DefenderTeamIndex'), 0);
                instances[instances.length - 1].team = t;
                blockers.push({ instance: instances.length - 1, team: t, gate: gate ?? t });
              } else if (gate !== undefined || (bodyMeshes.has(name) && flag(e, P, 'bCollideActors') && flag(comp, cobj?.props, 'CollideActors') && flag(comp, cobj?.props, 'BlockActors'))) {
                // Generator-run shields (SunStar's flag domes) block all in TA; letting their own team through keeps
                // flag captures possible while still keeping attackers out until the generator falls.
                if (gate !== undefined) instances[instances.length - 1].team = gate;
                blockers.push({ instance: instances.length - 1, team: gate ?? 255, gate });
              }
            }
          }
        }
      }

      for (const [re, kind] of CLASS_KIND) {
        if (!re.test(cls)) continue;
        const pos = toMap(loc);
        // UE yaw turns +X toward +Y; map yaw θ faces (-sin θ, -cos θ), so θ = -ψ - π/2.
        const ent: MapEntity = { kind, team: teamFromClass(cls, P), pos, yaw: -rot.yaw * ROT - Math.PI / 2 };
        // UE3 omits properties equal to their default; PlayerStart.TeamIndex defaults to 0 (Blood Eagle).
        if (kind === 'spawn' && ent.team === 255) ent.team = 0;
        if (/^TrVehiclePad/.test(cls)) ent.tag = 'vpad';
        if (kind === 'flag_stand' && mode === 'blitz') ent.kind = 'blitz_stand';
        if (kind === 'cap_point') {
          const label = P.get('m_sScreenName') ?? P.get('m_nPointIndex') ?? P.get('Tag');
          ent.tag = typeof label === 'string' ? label.replace(/[^A-Za-z]/g, '').slice(-1).toUpperCase() : String.fromCharCode(65 + entities.filter((x) => x.kind === 'cap_point').length);
          ent.team = 255;
        }
        if (kind === 'spawn') pkgSpawns.push([ent, ei + 1]);
        entities.push(ent);
        break;
      }
    }
    const navIndex = new Map<number, number>();
    for (const head of [...navNext.keys()].filter((k) => !navPointed.has(k))) {
      for (let r = head; r > 0 && !navIndex.has(r); r = navNext.get(r) ?? 0) navIndex.set(r, navIndex.size);
    }
    for (const [ent, ref] of pkgSpawns) spawnOrder.set(ent, pkgs.indexOf(pkg) * 1e7 + (navIndex.get(ref) ?? 5e6 + ref));
  }
  if (ncCount.size) {
    const top = [...ncCount].sort((a, b) => b[1] - a[1]);
    log(`  collision off: ${top.reduce((s, [, n]) => s + n, 0)} instances (${top.slice(0, 8).map(([k, n]) => `${k} x${n}`).join(', ')}${top.length > 8 ? ', ...' : ''})`);
  }
  if (hiddenCount.proxies || hiddenCount.dropped) log(`  hidden in game: ${hiddenCount.proxies} collision proxies, ${hiddenCount.dropped} dropped`);
  // Player starts in TA's navigation-list order.
  const spawnsInOrder = entities.filter((x) => x.kind === 'spawn').sort((a, b) => spawnOrder.get(a)! - spawnOrder.get(b)!);
  let spawnK = 0;
  for (let i = 0; i < entities.length; i++) if (entities[i].kind === 'spawn') entities[i] = spawnsInOrder[spawnK++];

  if (allTerrains.length > 1) {
    // Several Terrain actors (a big landscape plus detail patches): keep the largest and stamp the others' solid areas into it.
    allTerrains.sort((a, b) => b.hf.width * b.hf.depth - a.hf.width * a.hf.depth);
    const base = allTerrains[0];
    terrain = base.hf; terrainLayers = base.layers; terrainSplat = base.splat;
    for (const o of allTerrains.slice(1)) mergeTerrain(base.hf, o.hf);
    log(`  merged ${allTerrains.length} terrain actors into ${base.hf.resX}x${base.hf.resZ}`);
  }

  if (!terrain) {
    // Some arenas are pure static geometry: synthesise a floor well below the playable space.
    let minY = Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const it of instances) {
      minY = Math.min(minY, it.m[7]); minX = Math.min(minX, it.m[3]); maxX = Math.max(maxX, it.m[3]); minZ = Math.min(minZ, it.m[11]); maxZ = Math.max(maxZ, it.m[11]);
    }
    const pad = 200;
    const w = maxX - minX + pad * 2, d = maxZ - minZ + pad * 2;
    const floorY = (killZ ?? minY - 60) - 5;
    terrain = new Heightfield(w, d, 2, 2, new Float32Array(4).fill(floorY), minX - pad, minZ - pad);
    // Falling off a floorless arena must kill (TA falls to KillZ); never let players land on the synthesised floor.
    if (killZ === undefined) killZ = floorY + 15;
    log('  (no terrain actor; synthesised floor)');
  }
  if (volumes.length) log(`  volumes: ${volumes.map((v) => `${v.kind}${v.kind === 'pain' ? `(${v.dps}/s)` : ''}`).join(', ')}`);
  if (boosts.length) log(`  boosts: ${boosts.map((b) => `${b.scale !== undefined ? `x${b.scale}` : `(${b.vel.x.toFixed(0)},${b.vel.y.toFixed(0)},${b.vel.z.toFixed(0)})`}${b.team !== 255 ? `/t${b.team}` : ''}`).join(' ')}`);
  if (blockers.length) log(`  force fields: ${blockers.map((b) => `${meshes[instances[b.instance].mesh].name}${b.team !== 255 ? `/t${b.team}` : ''}${b.gate !== undefined ? `/gen${b.gate}` : ''}`).join(' ')}`);
  if (lmPending.length && opts.onLightmapPage) {
    // TA atlas UV = lightmap UV * CoordinateScale + CoordinateBias; then into our packed page.
    const { pages, placed } = packLightmaps(lmSources, opts.cookedDir);
    const pageTex = pages.map((p, k) => {
      const name = opts.onLightmapPage!({ ...p, name: `LM_${opts.id}_${mode}_${k}` });
      if (!name) return -1;
      let ti = texIndex.get(name) ?? -1;
      if (ti < 0) { ti = textures.length; textures.push(name); texIndex.set(name, ti); }
      return ti;
    });
    let lit = 0;
    for (const l of lmPending) {
      const pl = placed[l.src];
      if (!pl || pageTex[pl.page] < 0) continue;
      l.inst.lm = { tex: pageTex[pl.page], st: [l.st[0] * pl.su, l.st[1] * pl.sv, l.st[2] * pl.su + pl.u0, l.st[3] * pl.sv + pl.v0], scale: l.scale };
      lit++;
    }
    log(`  lightmaps: ${lmSources.length} atlases -> ${pages.map((p) => `${p.mips[0].w}x${p.mips[0].h}`).join(', ')}, ${lit} instances`);
  }

  // Choose the dome that reads best: painted first, then biggest, then any.
  {
    let best: (typeof skyCands)[number] | null = null, bestScore = -1;
    for (const c of skyCands) {
      const painted = c.groups?.some((g) => g.tex >= 0) ? 1e9 : 0;
      const score = painted + Math.min(1e8, c.radius * 1e4);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) {
      env.skyMesh = best.mesh;
      const g0 = best.groups?.find((g) => g.tex >= 0) ?? best.groups?.[0];
      if (g0 && g0.tex >= 0) env.skyTex = g0.tex;
      // Material tint is a float triple (0..4); pack it to a colour the client can multiply the dome by.
      if (g0?.tint) {
        const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
        env.skyColor = (c(g0.tint[0]) << 16) | (c(g0.tint[1]) << 8) | c(g0.tint[2]);
      }
    }
  }

  log(`  meshes ${meshes.length}, instances ${instances.length}, entities ${entities.length}, textures ${textures.length}`);
  const data: MapData = {
    id: opts.id, name: opts.name, theme: opts.theme, source: 'original', modes: [mode], terrain, boxes: [], entities, meshes, instances, killZ,
    textures: textures.length ? textures : undefined, terrainLayers, terrainSplat, env: Object.keys(env).length ? env : undefined,
    volumes: volumes.length ? volumes : undefined, boosts: boosts.length ? boosts : undefined, blockers: blockers.length ? blockers : undefined,
  };
  closeFloorlessHoles(data, log);
  return data;
}

/** Copy the solid (non-hole) part of terrain `o` into `base` at base's vertices. */
function mergeTerrain(base: Heightfield, o: Heightfield) {
  const ex = o.cellX * 0.25, ez = o.cellZ * 0.25;
  const solidAt = (x: number, z: number) => o.inBounds(x, z) && x < o.originX + o.width && z < o.originZ + o.depth && !o.isHole(x, z);
  for (let j = 0; j < base.resZ; j++) for (let i = 0; i < base.resX; i++) {
    const x = base.originX + i * base.cellX, z = base.originZ + j * base.cellZ;
    if (!o.inBounds(x, z)) continue;
    if (!(solidAt(x + ex, z + ez) || solidAt(x - ex, z + ez) || solidAt(x + ex, z - ez) || solidAt(x - ex, z - ez))) continue;
    base.heights[j * base.resX + i] = o.heightAt(x, z);
    if (base.holes) base.holes[j * base.resX + i] = 0;
  }
}

/**
 * BSP brushes are not imported, so a base-entrance hole whose floor was BSP would drop players to the kill plane.
 * Fill floorless cells of small hole clusters; large clusters are intentional cut-outs of the map edge.
 */
function closeFloorlessHoles(data: MapData, log: (s: string) => void) {
  const T = data.terrain;
  const holes = T.holes;
  if (!holes) return;
  const W = T.resX, H = T.resZ, MAX_CLUSTER = 600;
  const comp = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!holes[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      n++;
      const i = k % W, j = (k - i) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const q = b * W + a;
        if (holes[q] && comp[q] < 0) { comp[q] = id; stack.push(q); }
      }
    }
    sizes.push(n);
  }
  if (!sizes.some((n) => n <= MAX_CLUSTER)) return;
  const tris = buildCollisionWorld(data).tris;
  let closed = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!holes[k] || sizes[comp[k]] > MAX_CLUSTER) continue;
      const x = T.originX + (i + 0.5) * T.cellX, z = T.originZ + (j + 0.5) * T.cellZ, y = T.heightAt(x, z);
      if (!tris?.raycast({ x, y: y + 2, z }, { x, y: y - 60, z }, [])) { holes[k] = 0; closed++; }
    }
  }
  if (!holes.some((v) => v)) T.holes = null;
  if (closed) log(`  closed ${closed} floorless entrance-hole cells`);
}
