import { mulberry32, Noise2D } from '../rng.js';
import type { OBB } from '../sim/collision.js';
import { Heightfield } from '../sim/terrain.js';
import { PrefabBuilder, PREFABS } from './prefabs.js';
import type { Feature, MapData, MapEntity, MapSpec, PrefabPlacement } from './spec.js';
import { THEMES } from './themes.js';

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function featureHeight(f: Feature, x: number, z: number): number {
  switch (f.type) {
    case 'hill': { const d2 = (x - f.x) ** 2 + (z - f.z) ** 2; return f.h * Math.exp(-d2 / (f.r * f.r)); }
    case 'plateau':
    case 'bowl': { const d = Math.hypot(x - f.x, z - f.z); return f.h * (1 - smooth(f.r * (1 - (f.edge ?? 0.4)), f.r, d)); }
    case 'crater': {
      const d = Math.hypot(x - f.x, z - f.z);
      return f.h * Math.exp(-((d - f.r) ** 2) / ((f.r * 0.3) ** 2)) - f.h * 0.7 * (1 - smooth(0, f.r, d));
    }
    case 'ridge':
    case 'valley': { const d = segDist(x, z, f.x, f.z, f.x2 ?? f.x, f.z2 ?? f.z); return f.h * Math.exp(-(d * d) / (f.r * f.r)); }
    case 'channel': { const d = segDist(x, z, f.x, f.z, f.x2 ?? f.x, f.z2 ?? f.z); return f.h * (1 - smooth(f.r * 0.5, f.r, d)); }
  }
}

const mirrorFeature = (f: Feature): Feature => ({ ...f, x: -f.x, z: -f.z, x2: f.x2 !== undefined ? -f.x2 : undefined, z2: f.z2 !== undefined ? -f.z2 : undefined });
const mirrorTeam = (t: number | undefined) => (t === 0 ? 1 : t === 1 ? 0 : t);
const mirrorPrefab = (p: PrefabPlacement): PrefabPlacement => ({ ...p, x: -p.x, z: -p.z, yaw: (p.yaw ?? 0) + Math.PI, team: mirrorTeam(p.team) });

export function expandSpec(spec: MapSpec): { features: Feature[]; prefabs: PrefabPlacement[] } {
  const features = [...spec.features];
  const prefabs = [...spec.prefabs];
  if (spec.mirror === 'point') {
    for (const f of spec.features) if (!f.noMirror && (f.x !== 0 || f.z !== 0 || (f.x2 ?? 0) !== 0)) features.push(mirrorFeature(f));
    for (const p of spec.prefabs) if (!p.noMirror) prefabs.push(mirrorPrefab(p));
  }
  return { features, prefabs };
}

export function generateMap(spec: MapSpec): MapData {
  const rnd = mulberry32(spec.seed);
  const noise = new Noise2D(spec.seed);
  const { features, prefabs } = expandSpec(spec);
  const res = spec.res;
  const heights = new Float32Array(res * res);
  const half = spec.size / 2;
  const cell = spec.size / (res - 1);
  const symmetric = spec.mirror === 'point';

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * cell, z = -half + j * cell;
      let n = noise.fbm(x / spec.noise.scale, z / spec.noise.scale, spec.noise.octaves);
      if (symmetric) n = (n + noise.fbm(-x / spec.noise.scale, -z / spec.noise.scale, spec.noise.octaves)) * 0.5;
      if (spec.noise.ridged) {
        let r = noise.ridged(x / (spec.noise.scale * 0.7) + 17, z / (spec.noise.scale * 0.7) - 9, 4);
        if (symmetric) r = (r + noise.ridged(-x / (spec.noise.scale * 0.7) + 17, -z / (spec.noise.scale * 0.7) - 9, 4)) * 0.5;
        n += (r - 0.5) * spec.noise.ridged;
      }
      let h = spec.baseHeight + n * spec.noise.amp;
      for (const f of features) h += featureHeight(f, x, z);
      const e = Math.max(Math.abs(x), Math.abs(z)) / half;
      if (e > spec.edge.start) h += spec.edge.height * ((e - spec.edge.start) / (1 - spec.edge.start)) ** 2;
      heights[j * res + i] = h;
    }
  }

  const terrain = new Heightfield(spec.size, spec.size, res, res, heights);

  // Flatten pads under structures.
  const origins = prefabs.map((p) => terrain.heightAt(p.x, p.z));
  prefabs.forEach((p, idx) => {
    const r = (p.flatten ?? PREFABS[p.prefab].flatten) * (p.scale ?? 1);
    if (r <= 0) return;
    const target = origins[idx];
    const blend = r * 0.8;
    const i0 = Math.max(0, Math.floor((p.x - r - blend + half) / cell)), i1 = Math.min(res - 1, Math.ceil((p.x + r + blend + half) / cell));
    const j0 = Math.max(0, Math.floor((p.z - r - blend + half) / cell)), j1 = Math.min(res - 1, Math.ceil((p.z + r + blend + half) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * cell, z = -half + j * cell;
        const w = 1 - smooth(r, r + blend, Math.hypot(x - p.x, z - p.z));
        const k = j * res + i;
        heights[k] += (target - heights[k]) * w;
      }
  });

  const boxes: OBB[] = [];
  const entities: MapEntity[] = [];
  for (const p of prefabs) {
    const oy = terrain.heightAt(p.x, p.z) + (p.lift ?? 0);
    const b = new PrefabBuilder(boxes, entities, p.x, oy, p.z, p.yaw ?? 0, p.team ?? 255, p.scale ?? 1, p.modes);
    PREFABS[p.prefab].fn(b, rnd, p);
  }

  scatterDecor(spec, terrain, prefabs, boxes, rnd);
  return { id: spec.id, name: spec.name, theme: spec.theme, source: 'reborn', modes: spec.modes, terrain, boxes, entities };
}

function scatterDecor(spec: MapSpec, terrain: Heightfield, prefabs: PrefabPlacement[], boxes: OBB[], rnd: () => number) {
  const theme = THEMES[spec.theme];
  if (theme.scatter === 'none' || spec.scatter <= 0) return;
  const count = Math.round((spec.scatter * spec.size * spec.size) / 60000);
  const keepOut = prefabs.filter((p) => (p.flatten ?? PREFABS[p.prefab].flatten) > 0);
  const half = spec.size / 2 - 20;
  const placed: { x: number; z: number }[] = [];
  const entitiesSink: MapEntity[] = [];
  for (let i = 0; i < count; i++) {
    const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
    if (keepOut.some((p) => Math.hypot(p.x - x, p.z - z) < (p.flatten ?? PREFABS[p.prefab].flatten) + 30)) continue;
    const pts = spec.mirror === 'point' ? [{ x, z }, { x: -x, z: -z }] : [{ x, z }];
    for (const pt of pts) {
      placed.push(pt);
      const y = terrain.heightAt(pt.x, pt.z);
      const b = new PrefabBuilder(boxes, entitiesSink, pt.x, y, pt.z, rnd() * Math.PI * 2, 255, 0.6 + rnd() * 0.9);
      if (theme.scatter === 'ice_spikes') PREFABS.ice_spike.fn(b, rnd, { prefab: 'ice_spike', x: pt.x, z: pt.z });
      else if (theme.scatter === 'pillars') PREFABS.pillar.fn(b, rnd, { prefab: 'pillar', x: pt.x, z: pt.z });
      else if (theme.scatter === 'crystals') {
        const n0 = boxes.length;
        PREFABS.ice_spike.fn(b, rnd, { prefab: 'ice_spike', x: pt.x, z: pt.z });
        for (let k = n0; k < boxes.length; k++) boxes[k].mat = 'crystal';
      } else if (theme.scatter === 'trees') {
        const h = 8 + rnd() * 10;
        b.box(0, h / 2, 0, 0.5, h / 2, 0.5, 'wood');
        const canopy = b.box(0, h, 0, 3 + rnd() * 2, 2.5 + rnd(), 3 + rnd() * 2, 'leaves');
        canopy.noCollide = true;
      } else PREFABS.rock.fn(b, rnd, { prefab: 'rock', x: pt.x, z: pt.z });
    }
  }
}

export function entitiesForMode(map: MapData, mode: string): MapEntity[] {
  return map.entities.filter((e) => !e.modes || e.modes.includes(mode as never));
}
