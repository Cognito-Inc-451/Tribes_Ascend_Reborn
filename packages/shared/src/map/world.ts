import { CollisionWorld, TriGrid } from '../sim/collision.js';
import type { MapData } from './spec.js';

/** Energy fields in TA maps (base force fields, shield domes, conduit fields): translucent, players pass through. */
export const isForceFieldMesh = (name: string) => /forcefield(?!_base)|shielddome|sunstar_shield$|conduit_field|forcebubble/i.test(name);
const solid = (me: { collide: boolean; name: string } | undefined) => !!me?.collide && !isForceFieldMesh(me.name);

/** Transform all collidable mesh instances to a world-space triangle soup. */
export function buildWorldTriangles(map: MapData): Float32Array | null {
  if (!map.meshes?.length || !map.instances?.length) return null;
  let total = 0;
  for (const it of map.instances) { const me = map.meshes[it.mesh]; if (solid(me)) total += me.indices.length; }
  if (!total) return null;
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const it of map.instances) {
    const me = map.meshes[it.mesh];
    if (!solid(me)) continue;
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

export function buildCollisionWorld(map: MapData): CollisionWorld {
  const tris = buildWorldTriangles(map);
  return new CollisionWorld(map.terrain, map.boxes, tris ? new TriGrid(tris) : null);
}
