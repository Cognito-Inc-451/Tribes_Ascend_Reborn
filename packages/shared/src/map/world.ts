import { CollisionWorld, TriGrid } from '../sim/collision.js';
import type { MapData, MapEntity, MeshInstance } from './spec.js';

/** Energy fields in TA maps (base force fields, shield domes, conduit fields): translucent, players pass through. */
export const isForceFieldMesh = (name: string) => /forcefield(?!_base)|shielddome|sunstar_shield$|conduit_field|forcebubble/i.test(name);
/** TA's map-edge warning grids (shown only near the boundary); the creativity walls do the blocking. */
export const isBoundaryMesh = (name: string) => /outofbounds|gridplane|walllimit/i.test(name);
const solid = (me: { collide: boolean; name: string } | undefined) => !!me?.collide && !isForceFieldMesh(me.name) && !isBoundaryMesh(me.name);

/** Transform mesh instances to a world-space triangle soup. */
function instanceTriangles(map: MapData, list: MeshInstance[]): Float32Array | null {
  let total = 0;
  for (const it of list) total += map.meshes![it.mesh].indices.length;
  if (!total) return null;
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const it of list) {
    const me = map.meshes![it.mesh];
    const m = it.m, P = me.positions, I = me.indices;
    // Imported triangles wind clockwise seen from the front; emit them counter-clockwise (normal = e1 x e2 points out)
    // so ray hits can tell front from back. Mirrored instances (negative scale) are already flipped.
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const order = det < 0 ? [0, 1, 2] : [0, 2, 1];
    for (let t = 0; t + 2 < I.length; t += 3) {
      for (const k of order) {
        const idx = I[t + k];
        const x = P[idx * 3], y = P[idx * 3 + 1], z = P[idx * 3 + 2];
        out[o++] = m[0] * x + m[1] * y + m[2] * z + m[3];
        out[o++] = m[4] * x + m[5] * y + m[6] * z + m[7];
        out[o++] = m[8] * x + m[9] * y + m[10] * z + m[11];
      }
    }
  }
  return out;
}

/** Transform all collidable mesh instances to a world-space triangle soup. */
export function buildWorldTriangles(map: MapData): Float32Array | null {
  if (!map.meshes?.length || !map.instances?.length) return null;
  return instanceTriangles(map, map.instances.filter((it) => solid(map.meshes![it.mesh])));
}

const BASE_KINDS = new Set(['flag_stand', 'generator', 'inventory', 'repair_station', 'vehicle_pad', 'base_turret', 'radar']);

/**
 * TA left most base door fields without collision (Katabatic, Blueshift...). Upright fields within 45 m of a team's base
 * objects become team blockers like TA's real ones: the owners walk through, enemies are kept out while the base has
 * power. Floors, lift tubes, conduits and domes stay walk-through. Call before building the world and the view.
 */
export function addBaseFieldBlockers(map: MapData): void {
  const anchors: MapEntity[] = map.entities.filter((e) => e.team <= 1 && BASE_KINDS.has(e.kind));
  if (!anchors.length || !map.instances || !map.meshes) return;
  const blockers = (map.blockers ??= []);
  const taken = new Set(blockers.map((b) => b.instance));
  map.instances.forEach((it, i) => {
    const me = map.meshes![it.mesh];
    if (taken.has(i) || !/forcefield(?!_base)/i.test(me.name) || /collision|conduit|launcher/i.test(me.name)) return;
    const P = me.positions, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[k + a]); mx[a] = Math.max(mx[a], P[k + a]); }
    const m = it.m;
    const ext = [0, 1, 2].map((k) => Math.hypot(m[k], m[4 + k], m[8 + k]) * (mx[k] - mn[k]));
    const thin = ext.indexOf(Math.min(...ext));
    const upright = Math.abs(m[4 + thin]) / (Math.hypot(m[thin], m[4 + thin], m[8 + thin]) || 1) < 0.4;
    if (!upright || ext[thin] > 2 || ext.some((v, k) => k !== thin && v < 2)) return;
    const lc = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
    const c = { x: m[0] * lc[0] + m[1] * lc[1] + m[2] * lc[2] + m[3], y: m[4] * lc[0] + m[5] * lc[1] + m[6] * lc[2] + m[7], z: m[8] * lc[0] + m[9] * lc[1] + m[10] * lc[2] + m[11] };
    let owner: MapEntity | null = null, best = 45;
    for (const e of anchors) { const d = Math.hypot(e.pos.x - c.x, e.pos.y - c.y, e.pos.z - c.z); if (d < best) { best = d; owner = e; } }
    if (owner) blockers.push({ instance: i, team: owner.team, gate: owner.team });
  });
}

export function buildCollisionWorld(map: MapData): CollisionWorld {
  const tris = buildWorldTriangles(map);
  const world = new CollisionWorld(map.terrain, map.boxes, tris ? new TriGrid(tris) : null);
  world.boosts = map.boosts ?? [];
  // Map force fields collide with their exact mesh (shield domes stay hollow), for players only.
  world.blockers = (map.blockers ?? []).map((b) => {
    const it = map.instances?.[b.instance];
    const t = it && map.meshes?.[it.mesh] ? instanceTriangles(map, [it]) : null;
    return { grid: new TriGrid(t ?? new Float32Array(0)), passTeam: b.team === 255 ? undefined : b.team };
  });
  return world;
}
