import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { buildCollisionWorld, Heightfield, UU_PER_METER, type MapData, type MapEntity, type MapEnv, type MeshAsset, type MeshInstance, type ModeId, type TerrainLayer, type ThemeId, type EntityKind } from '@ar/shared';
import { resolveDiffuse, Resolver, type ObjRef } from './material.js';
import { extractStaticMesh } from './mesh.js';
import { extractModel } from './model.js';
import { isRaw, isRef, isRot, isVec, parseObject, parseStructArray, type PropValue, type Rot, type Vec } from './props.js';
import { UPackage, type ExportEntry } from './upk.js';

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

/** Sky domes and star-field cards are replaced by the client sky shader. */
const SKIP_MESH = /skydome|skybox|skysphere|sky_?hemi|starfield|shootingstar|_stars?_|nebula|outofboundsgrid|rimlight/i;
/** Invisible in game, collision only (map-edge "creativity walls", blockers). */
const HIDDEN_MESH = /creativitywall|invisiblewall|invis_?wall|blocker|blockingmesh|collision_?only/i;

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

export interface ImportOptions {
  cookedDir: string; id: string; name: string; theme: ThemeId; log?: (s: string) => void;
  /** Export a texture once; returns the shared texture name or null if it could not be read. */
  onTexture?: (t: ObjRef) => string | null;
}

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
  let terrain: Heightfield | null = null;
  let killZ: number | undefined;
  const env: MapEnv = {};
  const textures: string[] = [];
  const texIndex = new Map<string, number>();
  const matTex = new Map<string, number>();
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

  const texFor = (pkg: UPackage, ref: number): number => {
    if (!ref || !opts.onTexture) return -1;
    const key = `${pkg.path}:${ref}`;
    const hit = matTex.get(key);
    if (hit !== undefined) return hit;
    let ti = -1;
    const mat = R.get(pkg, ref);
    const tex = mat ? resolveDiffuse(R, mat) : null;
    if (tex) {
      const name = opts.onTexture(tex);
      if (name) {
        ti = texIndex.get(name) ?? -1;
        if (ti < 0) { ti = textures.length; textures.push(name); texIndex.set(name, ti); }
      }
    }
    matTex.set(key, ti);
    return ti;
  };

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
      const groups = base.groups?.map((g, k) => ({ ...g, tex: overrides[k] ? texFor(pkg, overrides[k]) : g.tex }));
      if (!groups || groups.every((g, k) => g.tex === base.groups![k].tex)) { meshIndex.set(ovKey, bi); return bi; }
      meshes.push({ ...base, groups });
      meshIndex.set(ovKey, meshes.length - 1);
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
    const groups = md.sections.length && md.uvs ? md.sections.map((s) => ({ start: s.firstIndex, count: s.numTriangles * 3, tex: texFor(owner, s.material) })) : undefined;
    meshes.push({
      name: md.name, positions, indices, mat: meshMaterial(md.name), collide: hidden || !noCollide(md.name), hidden: hidden || undefined,
      uvs: groups ? md.uvs! : undefined, groups,
    });
    meshIndex.set(fullPath, meshes.length - 1);
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
  const addLevelBsp = (pkg: UPackage, e: ExportEntry) => {
    const model = extractModel(pkg, e);
    if (!model) return;
    const tag = basename(pkg.path, extname(pkg.path));
    for (const [polys, suffix, collide, hidden] of [
      [model.visibleSolid, 'bsp', true, false], [model.visibleNonSolid, 'bsp_nonsolid', false, false], [model.invisibleSolid, 'bsp_invisible', true, true],
    ] as const) {
      const mi = pushPolys(`${tag}_${suffix}`, model.points, polys, 'concrete', collide, hidden);
      if (mi >= 0) instances.push({ mesh: mi, m: IDENTITY });
    }
    log(`  BSP ${tag}: ${model.visibleSolid.length} solid, ${model.visibleNonSolid.length} non-solid, ${model.invisibleSolid.length} invisible polys`);
  };

  for (const pkg of pkgs) {
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
            const tex = isRef(mref) && tmat ? texFor(tmat.pkg, mref.ref) : -1;
            const ai = num(layer.get('AlphaMapIndex'), -1);
            if (out.length > 0 && !alpha[ai]) continue;
            if (out.length > 0) { const a = alpha[ai], ch = out.length - 1; for (let i = 0; i < count; i++) splat[i * 4 + ch] = a[i]; }
            out.push({ tex, scale: num(tmProps?.get('MappingScale'), 4) * cellX });
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
        continue;
      }
      if (/^SkyLight/.test(cls)) {
        const lc = P.get('LightComponent');
        const lp = isRef(lc) && lc.ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[lc.ref - 1]))?.props : null;
        const c = colorOf(lp?.get('LightColor'), 0xffffff), b = Math.min(1.5, num(lp?.get('Brightness'), 1));
        env.ambientColor = (Math.round(((c >> 16) & 255) * b / 1.5) << 16) | (Math.round(((c >> 8) & 255) * b / 1.5) << 8) | Math.round((c & 255) * b / 1.5);
        continue;
      }
      if (cls === 'ExponentialHeightFog' || cls === 'HeightFog') {
        const fc = P.get('Component');
        const fp = isRef(fc) && fc.ref > 0 ? parseObject(pkg, pkg.exportData(pkg.exports[fc.ref - 1]))?.props : null;
        env.fogDensity = num(fp?.get('FogDensity'), 0.02);
        env.fogColor = colorOf(fp?.get('FogInscatteringColor') ?? fp?.get('LightInscatteringColor'), 0x8899aa);
        env.fogStart = num(fp?.get('StartDistance'), 0) * S;
        continue;
      }
      if (cls === 'TrWeatherVolume') { env.snow = true; continue; }

      const smc = P.get('StaticMeshComponent');
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
          const mi = resolveMesh(mpkg, sm.v.ref, overrides);
          if (mi >= 0) {
            const prop = (x: ExportEntry, p: Map<string, PropValue> | undefined, n: string) => inherited(pkg, x, p, n)?.v;
            const dsv = prop(e, P, 'DrawScale'), d3v = prop(e, P, 'DrawScale3D'), csv = prop(comp, cobj?.props, 'Scale'), c3v = prop(comp, cobj?.props, 'Scale3D');
            const ds = typeof dsv === 'number' ? dsv : 1;
            const d3 = isVec(d3v) ? d3v : { x: 1, y: 1, z: 1 };
            const cs = typeof csv === 'number' ? csv : 1;
            const c3 = isVec(c3v) ? c3v : { x: 1, y: 1, z: 1 };
            const scale = { x: ds * d3.x * cs * c3.x, y: ds * d3.y * cs * c3.y, z: ds * d3.z * cs * c3.z };
            const name = meshes[mi].name;
            const team = /(^|_)BE(_|$)|BloodEagle/i.test(name) ? 0 : /(^|_)DS(_|$)|DiamondSword/i.test(name) ? 1 : undefined;
            instances.push({ mesh: mi, m: transform(loc, rot, scale), team });
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
        entities.push(ent);
        break;
      }
    }
  }

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
    terrain = new Heightfield(w, d, 2, 2, new Float32Array(4).fill((killZ ?? minY - 60) - 5), minX - pad, minZ - pad);
    log('  (no terrain actor; synthesised floor)');
  }

  log(`  meshes ${meshes.length}, instances ${instances.length}, entities ${entities.length}, textures ${textures.length}`);
  const data: MapData = {
    id: opts.id, name: opts.name, theme: opts.theme, source: 'original', modes: [mode], terrain, boxes: [], entities, meshes, instances, killZ,
    textures: textures.length ? textures : undefined, terrainLayers, terrainSplat, env: Object.keys(env).length ? env : undefined,
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
