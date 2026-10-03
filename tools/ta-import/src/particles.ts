import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRaw, isRef, parseStruct, parseStructArray, type PropValue } from './props.js';
import { materialBlend, resolveDiffuse, type ObjRef, type Resolver } from './material.js';
import type { UPackage } from './upk.js';

/**
 * TA's Cascade particle systems (weapon trails, explosions, fractal shards), reduced to what a sprite renderer needs:
 * per emitter the texture/blend, spawn (bursts + rate), lifetime, size (+ over life), colour/alpha (+ over life),
 * start velocity, acceleration and spawn shape. Distributions are read from their baked lookup tables
 * ([min, max, samples...]); units are converted to metres.
 */
export interface FxEmitter {
  kind: 'sprite' | 'beam' | 'trail' | 'mesh';
  tex?: string;
  blend: 'add' | 'alpha' | 'mod';
  /** Sub-images (columns, rows) of a flipbook texture. */
  sub?: [number, number];
  align?: 'velocity' | 'rect';
  local?: boolean;
  duration: number;
  loops: number;
  delay?: number;
  rate: number;
  bursts: [number, number][];
  life: [number, number];
  size: [number, number];
  /** Length (velocity-aligned) or height when it differs from the width. */
  sizeY?: [number, number];
  sizeLife?: number[];
  color: [number, number, number];
  alpha: number;
  colorLife?: number[][];
  alphaLife?: number[];
  vel: [number, number, number, number, number, number];
  radial?: [number, number];
  accel?: [number, number, number];
  sphere?: [number, number];
  loc?: [number, number, number, number, number, number];
  rot?: [number, number];
  rotRate?: [number, number];
}

const M = 1 / 50;

/** Baked distribution: [min, max, samples...]; each sample holds `elem` values, or min+max pairs for uniform ones. */
function dist(pkg: UPackage, v: PropValue | undefined, elem: number): number[][] | null {
  const s = parseStruct(pkg, v);
  const lt = s?.get('LookupTable');
  if (!s || !isRaw(lt) || lt.raw.length < 4) return null;
  const dv = new DataView(lt.raw.buffer, lt.raw.byteOffset, lt.raw.byteLength);
  const n = dv.getInt32(0, true);
  const t: number[] = [];
  for (let i = 0; i < n && 4 + i * 4 + 4 <= lt.raw.length; i++) t.push(dv.getFloat32(4 + i * 4, true));
  if (t.length < 2 + elem) return null;
  const op = s.get('Op');
  const chunk = typeof s.get('LookupTableChunkSize') === 'number' && (s.get('LookupTableChunkSize') as number) > 0
    ? (s.get('LookupTableChunkSize') as number)
    : op === 1 || op === 2 || op === 'RDO_Random' || op === 'RDO_Extreme' ? elem * 2 : elem;
  const out: number[][] = [];
  for (let o = 2; o + chunk <= t.length; o += chunk) out.push(t.slice(o, o + chunk));
  return out.length ? out : null;
}
/** [min, max] of a float distribution at t = 0. */
const range1 = (d: number[][] | null, def: number): [number, number] => (d ? [d[0][0], d[0][d[0].length > 1 ? 1 : 0]] : [def, def]);
/** Min and max vector at t = 0 (equal for constants). */
const range3 = (d: number[][] | null): [number, number, number, number, number, number] | null => {
  if (!d) return null;
  const s = d[0];
  return s.length >= 6 ? [s[0], s[1], s[2], s[3], s[4], s[5]] : [s[0], s[1], s[2], s[0], s[1], s[2]];
};
const round = (x: number) => Math.round(x * 1000) / 1000;
const refs = (v: PropValue | undefined): number[] => {
  if (!isRaw(v) || v.raw.length < 4) return [];
  const dv = new DataView(v.raw.buffer, v.raw.byteOffset, v.raw.byteLength);
  const n = dv.getInt32(0, true);
  const out: number[] = [];
  for (let i = 0; i < n && 4 + i * 4 + 4 <= v.raw.length; i++) out.push(dv.getInt32(4 + i * 4, true));
  return out;
};

export class ParticleExporter {
  readonly systems: Record<string, FxEmitter[]> = {};
  constructor(private R: Resolver, private onTexture: (t: ObjRef) => string | null, private log: (s: string) => void) {}

  /** Exports a ParticleSystem referenced from `pkg` (import or export); returns its key or null. */
  system(pkg: UPackage, ref: number): string | null {
    const ps = this.R.get(pkg, ref);
    if (!ps || this.R.className(ps) !== 'ParticleSystem') return null;
    const key = ps.pkg.refPath(ps.index);
    if (this.systems[key]) return key;
    const P = this.R.props(ps);
    const emitters: FxEmitter[] = [];
    for (const er of refs(P?.get('Emitters'))) {
      try {
        const e = this.emitter(ps.pkg, er);
        if (e) emitters.push(e);
      } catch (err) { this.log(`  ! ${key}: ${(err as Error).message}`); }
    }
    if (!emitters.length) return null;
    this.systems[key] = emitters;
    return key;
  }

  private emitter(pkg: UPackage, ref: number): FxEmitter | null {
    const e = this.R.get(pkg, ref);
    if (!e) return null;
    const EP = this.R.props(e);
    const lod = refs(EP?.get('LODLevels'))[0];
    const L = lod ? this.R.get(e.pkg, lod) : null;
    const LP = L ? this.R.props(L) : null;
    if (!L || !LP || LP.get('bEnabled') === false) return null;
    const req = isRef(LP.get('RequiredModule')) ? this.R.get(L.pkg, (LP.get('RequiredModule') as { ref: number }).ref) : null;
    const RP = req ? this.R.props(req) : null;
    if (!RP) return null;
    const p = L.pkg;
    const out: FxEmitter = {
      kind: 'sprite', blend: 'add', duration: Number(RP.get('EmitterDuration') ?? 1), loops: Number(RP.get('EmitterLoops') ?? 0),
      rate: 0, bursts: [], life: [1, 1], size: [1, 1], color: [1, 1, 1], alpha: 1, vel: [0, 0, 0, 0, 0, 0],
    };
    if (typeof RP.get('EmitterDelay') === 'number') out.delay = round(RP.get('EmitterDelay') as number);
    if (RP.get('bUseLocalSpace') === true) out.local = true;
    const align = RP.get('ScreenAlignment');
    if (align === 'PSA_Velocity') out.align = 'velocity'; else if (align === 'PSA_Rectangle') out.align = 'rect';
    const sh = Number(RP.get('SubImages_Horizontal') ?? 1), sv = Number(RP.get('SubImages_Vertical') ?? 1);
    if (sh > 1 || sv > 1) out.sub = [sh, sv];
    out.rate = Math.max(0, range1(dist(p, RP.get('SpawnRate'), 1), 0)[1]);
    for (const b of parseStructArray(p, RP.get('BurstList'))) out.bursts.push([Number(b.get('Count') ?? 0), round(Number(b.get('Time') ?? 0))]);
    const mat = isRef(RP.get('Material')) ? this.R.get(p, (RP.get('Material') as { ref: number }).ref) : null;
    if (mat) {
      const tex = resolveDiffuse(this.R, mat);
      if (tex) out.tex = this.onTexture(tex) ?? undefined;
      const blend = materialBlend(this.R, mat);
      out.blend = blend === 'translucent' ? 'alpha' : blend === 'modulate' ? 'mod' : blend === 'additive' ? 'add' : 'alpha';
    }
    const td = isRef(LP.get('TypeDataModule')) ? this.R.get(p, (LP.get('TypeDataModule') as { ref: number }).ref) : null;
    if (td) {
      const c = this.R.className(td);
      out.kind = /Beam/.test(c) ? 'beam' : /Trail|Ribbon/.test(c) ? 'trail' : /Mesh/.test(c) ? 'mesh' : 'sprite';
    }
    const mods = [...refs(LP.get('Modules')), ...(isRef(LP.get('SpawnModule')) ? [(LP.get('SpawnModule') as { ref: number }).ref] : [])];
    for (const mr of mods) {
      const m = this.R.get(p, mr);
      const MP = m ? this.R.props(m) : null;
      if (!m || !MP || MP.get('bEnabled') === false) continue;
      const c = this.R.className(m);
      const d1 = (k: string) => dist(p, MP.get(k), 1), d3 = (k: string) => dist(p, MP.get(k), 3);
      switch (c) {
        case 'ParticleModuleSpawn': {
          out.rate = Math.max(out.rate, range1(d1('Rate'), 0)[1]);
          for (const b of parseStructArray(p, MP.get('BurstList'))) out.bursts.push([Number(b.get('Count') ?? 0), round(Number(b.get('Time') ?? 0))]);
          break;
        }
        case 'ParticleModuleLifetime': out.life = range1(d1('Lifetime'), 1).map(round) as [number, number]; break;
        case 'ParticleModuleSize': {
          const r = range3(d3('StartSize'));
          if (r) {
            out.size = [round(r[0] * M), round(r[3] * M)];
            if (Math.abs(r[1] - r[0]) > 1e-3 || Math.abs(r[4] - r[3]) > 1e-3) out.sizeY = [round(r[1] * M), round(r[4] * M)];
          }
          break;
        }
        case 'ParticleModuleSizeMultiplyLife': { const d = d3('LifeMultiplier'); if (d && d.length > 1) out.sizeLife = d.map((s) => round(s[0])); break; }
        case 'ParticleModuleColor': {
          const r = range3(d3('StartColor'));
          if (r) out.color = [round(r[0]), round(r[1]), round(r[2])];
          out.alpha = round(range1(d1('StartAlpha'), 1)[0]);
          break;
        }
        case 'ParticleModuleColorOverLife': {
          const cl = d3('ColorOverLife'), al = d1('AlphaOverLife');
          if (cl) { if (cl.length > 1) out.colorLife = cl.map((s) => s.slice(0, 3).map(round)); else out.color = cl[0].slice(0, 3).map(round) as [number, number, number]; }
          if (al) { if (al.length > 1) out.alphaLife = al.map((s) => round(s[0])); else out.alpha = round(al[0][0]); }
          break;
        }
        case 'ParticleModuleVelocity': {
          const r = range3(d3('StartVelocity'));
          if (r) out.vel = r.map((x) => round(x * M)) as FxEmitter['vel'];
          const rr = d1('StartVelocityRadial');
          if (rr) out.radial = range1(rr, 0).map((x) => round(x * M)) as [number, number];
          break;
        }
        case 'ParticleModuleAcceleration': { const r = range3(d3('Acceleration')); if (r) out.accel = [round(r[0] * M), round(r[1] * M), round(r[2] * M)]; break; }
        case 'ParticleModuleLocation': { const r = range3(d3('StartLocation')); if (r) out.loc = r.map((x) => round(x * M)) as FxEmitter['loc']; break; }
        case 'ParticleModuleLocationPrimitiveSphere': {
          const r = range1(d1('StartRadius'), 0).map((x) => round(x * M)) as [number, number];
          out.sphere = r;
          if (MP.get('Velocity') === true) out.radial = [Math.max(out.radial?.[0] ?? 0, r[0] * 2), Math.max(out.radial?.[1] ?? 0, r[1] * 2)];
          break;
        }
        case 'ParticleModuleRotation': out.rot = range1(d1('StartRotation'), 0).map(round) as [number, number]; break;
        case 'ParticleModuleRotationRate': out.rotRate = range1(d1('StartRotationRate'), 0).map(round) as [number, number]; break;
        default: break;
      }
    }
    // UE3 Z-up -> our Y-up.
    const swap = (v: number[]) => { for (let i = 0; i + 2 < v.length; i += 3) [v[i + 1], v[i + 2]] = [v[i + 2], v[i + 1]]; };
    swap(out.vel); if (out.accel) swap(out.accel); if (out.loc) swap(out.loc);
    if (!out.bursts.length && out.rate <= 0) return null;
    return out;
  }
}

/** Colour of a light component/archetype (LightColor is a BGRA FColor struct). */
function lightColor(pkg: UPackage, props: Map<string, PropValue> | null): number | undefined {
  const c = props?.get('LightColor');
  if (!isRaw(c) || c.raw.length < 4) return undefined;
  const s = parseStruct(pkg, c);
  if (s && typeof s.get('R') === 'number') return ((s.get('R') as number) << 16) | ((s.get('G') as number) << 8) | (s.get('B') as number);
  const [b, g, r] = c.raw;
  return (r << 16) | (g << 8) | b;
}

export interface ItemFx { trail?: string; explode?: string; shard?: string; beam?: string; light?: number; boomLight?: number }

const FX_ALIAS: Record<string, string> = {
  spare_spinfusor: 'spinfusor', devastator_spinfusor: 'spinfusor', blinksfusor: 'light_spinfusor', spinfusor_mkd: 'spinfusor', spinfusor_mkx: 'spinfusor',
  thumper_d: 'thumper', thumper_dx: 'thumper', fusion_mortar_deluxe: 'fusion_mortar', dust_devil: 'grenade_launcher', tc24: 'grenade_launcher',
  compact_nitron: 'impact_nitron', explosive_nitron: 'impact_nitron', sticky_xl: 'sticky_grenade', light_sticky: 'sticky_grenade', tcng_quickfuse: 'tcng',
  emp_xl: 'emp_grenade', heavy_ap_xl: 'heavy_ap', defective_frag: 'frag_grenade', extended_fractal: 'fractal_grenade', whiteout_grenade: 'emp_grenade',
  arx_buster: 'jackal', titan_launcher: 'saber_launcher', nova_blaster_mx: 'nova_blaster',
};

/**
 * Weapon effects: each TA device (Default__TrDevice_*) names its projectile classes; their defaults hold the flight
 * trail, explosion (and fractal shard/beam) particle systems and light colours. Devices map to our items by name.
 * Writes outDir/fx/manifest.json ({ systems, items }) and returns the number of items covered.
 */
export function exportWeaponFx(R: Resolver, game: UPackage, items: Record<string, { name: string }>, onTexture: (t: ObjRef) => string | null, outDir: string, log: (s: string) => void): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(Object.entries(items).map(([id, it]) => [norm(it.name), id]));
  const defaults = new Map<string, number>();
  game.exports.forEach((e, i) => { if (e.objectName.startsWith('Default__')) defaults.set(e.objectName, i + 1); });
  const props = (pkg: UPackage, ref: number) => { const o = R.get(pkg, ref); return o ? { o, P: R.props(o) } : null; };
  const classDefault = (pkg: UPackage, ref: number) => {
    const cls = R.get(pkg, ref);
    const d = cls ? defaults.get(`Default__${cls.exp.objectName}`) : undefined;
    return d ? props(game, d) : null;
  };
  const px = new ParticleExporter(R, onTexture, log);
  const out: Record<string, ItemFx> = {};
  for (const [name, idx] of defaults) {
    if (!name.startsWith('Default__TrDevice_')) continue;
    const dev = props(game, idx);
    const itemName = dev?.P?.get('ItemName');
    const id = typeof itemName === 'string' ? byName.get(norm(itemName)) : undefined;
    if (!dev?.P || !id || out[id]) continue;
    const proj = refs(dev.P.get('WeaponProjectiles')).map((r) => classDefault(game, r)).find((x) => x?.P);
    if (!proj?.P) continue;
    const P = proj.P, pkg = proj.o.pkg;
    const sys = (k: string) => (isRef(P.get(k)) ? px.system(pkg, (P.get(k) as { ref: number }).ref) ?? undefined : undefined);
    const fx: ItemFx = { trail: sys('ProjFlightTemplate'), explode: sys('ProjExplosionTemplate'), shard: sys('m_FractalExplosionTemplate'), beam: sys('m_FractalBeamTemplate') };
    const pl = isRef(P.get('ProjectileLight')) ? props(pkg, (P.get('ProjectileLight') as { ref: number }).ref) : null;
    fx.light = lightColor(pkg, pl?.P ?? null);
    const el = isRef(P.get('ExplosionLightClass')) ? classDefault(pkg, (P.get('ExplosionLightClass') as { ref: number }).ref) : null;
    fx.boomLight = lightColor(game, el?.P ?? null);
    for (const k of Object.keys(fx) as (keyof ItemFx)[]) if (fx[k] === undefined) delete fx[k];
    if (Object.keys(fx).length) out[id] = fx;
  }
  // Variants TA names differently (or that reuse their base weapon's effects).
  for (const [id, base] of Object.entries(FX_ALIAS)) if (items[id] && !out[id] && out[base]) out[id] = out[base];
  mkdirSync(join(outDir, 'fx'), { recursive: true });
  writeFileSync(join(outDir, 'fx', 'manifest.json'), JSON.stringify({ systems: px.systems, items: out }));
  log(`fx: ${Object.keys(out).length} items, ${Object.keys(px.systems).length} particle systems`);
  return Object.keys(out).length;
}
