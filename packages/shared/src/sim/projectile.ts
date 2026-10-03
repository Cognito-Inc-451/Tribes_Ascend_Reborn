import { GRAVITY, UU_PER_METER } from '../constants.js';
import type { ProjectileDef } from '../data/items.js';
import type { Vec3 } from '../math.js';
import type { CollisionWorld } from './collision.js';
import type { RayHit } from './terrain.js';

export interface ProjState {
  id: number;
  owner: number;
  team: number;
  item: string;
  pos: Vec3;
  vel: Vec3;
  age: number;
  bounces: number;
  stuck: boolean;
  stuckTo: number;      // player id, -1 none
  stuckOffset: Vec3;
  resting: boolean;
  homingTarget: number; // -1 none
  vehicleShot?: boolean;
  dmgOverride?: { direct: number; splashMax: number; splashMin: number; radius: number };
}

export interface ProjStep { hit: RayHit | null; explode: boolean; vanish: boolean }

/** Advance a projectile against static world (players are tested separately by the server). */
export function advanceProjectile(p: ProjState, def: ProjectileDef, world: CollisionWorld, dt: number, homingPos?: Vec3): ProjStep {
  p.age += dt;
  const res: ProjStep = { hit: null, explode: false, vanish: false };
  if (def.fuse !== undefined && p.age >= def.fuse) { res.explode = true; return res; }
  if (p.age >= def.lifetime) { res.explode = !!def.explodeOnExpire; res.vanish = !def.explodeOnExpire; return res; }
  if (p.stuck || p.resting) return res;

  if (def.homing && homingPos) {
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || def.speed;
    const tx = homingPos.x - p.pos.x, ty = homingPos.y + 1 - p.pos.y, tz = homingPos.z - p.pos.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const k = Math.min(1, def.homing * dt);
    p.vel.x = p.vel.x / sp * (1 - k) + (tx / tl) * k;
    p.vel.y = p.vel.y / sp * (1 - k) + (ty / tl) * k;
    p.vel.z = p.vel.z / sp * (1 - k) + (tz / tl) * k;
    const nl = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    p.vel.x = p.vel.x / nl * sp; p.vel.y = p.vel.y / nl * sp; p.vel.z = p.vel.z / nl * sp;
  }

  p.vel.y -= GRAVITY * world.gravityScale * def.gravity * dt;
  const next = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt, z: p.pos.z + p.vel.z * dt };
  const hit = world.raycast(p.pos, next);
  if (!hit) { p.pos = next; return res; }

  const n = hit.normal;
  if (def.sticky) {
    p.pos = { x: hit.point.x + n.x * 0.05, y: hit.point.y + n.y * 0.05, z: hit.point.z + n.z * 0.05 };
    p.vel = { x: 0, y: 0, z: 0 };
    p.stuck = true;
    return res;
  }
  const canBounce = def.bounce !== undefined || (def.bounces !== undefined && p.bounces < def.bounces);
  if (canBounce) {
    const r = def.bounce ?? 1;
    const vn = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
    p.vel = { x: (p.vel.x - 2 * vn * n.x) * r, y: (p.vel.y - 2 * vn * n.y) * r, z: (p.vel.z - 2 * vn * n.z) * r };
    p.pos = { x: hit.point.x + n.x * 0.06, y: hit.point.y + n.y * 0.06, z: hit.point.z + n.z * 0.06 };
    p.bounces++;
    if (def.bounce !== undefined && Math.hypot(p.vel.x, p.vel.y, p.vel.z) < 2 && n.y > 0.6) { p.resting = true; p.vel = { x: 0, y: 0, z: 0 }; }
    return res;
  }
  p.pos = hit.point;
  res.hit = hit;
  res.explode = true;
  return res;
}

export function splashDamage(splashMax: number, splashMin: number, radius: number, dist: number): number {
  if (dist >= radius) return 0;
  return splashMax + (splashMin - splashMax) * (dist / radius);
}

export function hitscanFalloff(damage: number, minDamage: number, start: number, end: number, dist: number): number {
  if (dist <= start) return damage;
  if (dist >= end) return minDamage;
  return damage + (minDamage - damage) * ((dist - start) / (end - start));
}

/** Segment vs vertical capsule (feet at base). Returns fraction along segment or -1. */
export function segmentVsCapsule(a: Vec3, b: Vec3, base: Vec3, radius: number, height: number): number {
  const p0 = { x: base.x, y: base.y + radius, z: base.z };
  const segH = Math.max(0, height - 2 * radius);
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  let best = -1;
  const N = Math.max(2, Math.ceil(Math.hypot(dx, dy, dz) / (radius * 0.5)));
  // Analytic infinite-cylinder test in XZ, then clamp by Y and caps.
  const fx = a.x - p0.x, fz = a.z - p0.z;
  const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - radius * radius;
  if (A > 1e-9) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t < 0 || t > 1) continue;
        const y = a.y + dy * t;
        if (y >= p0.y && y <= p0.y + segH) { best = t; break; }
      }
    }
  }
  if (C <= 0 && a.y >= p0.y - radius && a.y <= p0.y + segH + radius) return 0;
  // Caps: sample spheres along the path (cheap, projectiles are small).
  if (best < 0) {
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      const cy = Math.min(Math.max(y, p0.y), p0.y + segH);
      if ((x - p0.x) ** 2 + (y - cy) ** 2 + (z - p0.z) ** 2 <= radius * radius) { best = t; break; }
    }
  }
  return best;
}

/** Closest distance from point to a player's capsule axis (for splash). */
export function distToCapsule(p: Vec3, base: Vec3, radius: number, height: number): number {
  const y0 = base.y + radius, y1 = base.y + height - radius;
  const cy = Math.min(Math.max(p.y, y0), y1);
  return Math.max(0, Math.hypot(p.x - base.x, p.y - cy, p.z - base.z) - radius);
}

/** TA TrProjectile.m_fInstigatorMomentumTransferMultiplier: your own explosions push you 1.5x as hard. */
export const SELF_IMPULSE_MULT = 1.5;
/** TA TrDmgType_Base.m_fImpulseRangePct: full impulse while the falloff scale is at least this. */
export const IMPULSE_RANGE_PCT = 0.65;
/** TA UTPawn JumpZ (322 uu/s): Pawn.AddVelocity halves upward kicks while already rising faster than this. */
export const KNOCK_RISE_LIMIT = 322 / UU_PER_METER;

/**
 * Velocity change from a splash at `at` on a capsule (feet at `base`), as TA's TrPawn.TakeRadiusDamage:
 * the falloff scale lerps 1 -> knockMin with distance from the pawn's centre, impulse stays full while
 * that scale is >= 65 % and fades below it, own explosions push 1.5x and may add `selfLift` upward.
 * Shared so the client can predict its own disc and nade jumps with exactly the server's numbers.
 */
export function splashKnockback(at: Vec3, base: Vec3, height: number, splashRadius: number, impulse: number, mass: number, self: boolean, knockMin = 0.3, selfLift = 0): Vec3 | null {
  const dx = base.x - at.x, dy = base.y + height * 0.5 - at.y, dz = base.z - at.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist >= splashRadius || mass <= 0) return null;
  const scale = 1 + (knockMin - 1) * (dist / splashRadius);
  const imp = impulse * (self ? SELF_IMPULSE_MULT : 1) * Math.min(1, scale / IMPULSE_RANGE_PCT);
  const lift = self ? selfLift * scale : 0;
  if (imp <= 0 && lift <= 0) return null;
  const k = 1 / mass / UU_PER_METER, n = dist || 1;
  return { x: (dx / n) * imp * k, y: ((dy / n) * imp + lift) * k, z: (dz / n) * imp * k };
}

/**
 * Add a knockback velocity the way UE3 pawns take momentum: grounded targets get at least 40 % of it
 * upward (DamageType.bExtraMomentumZ) and upward kicks are halved while already rising fast.
 */
export function applyKnockback(s: { vel: Vec3; onGround: boolean }, dv: Vec3): void {
  let y = dv.y;
  if (s.onGround) y = Math.max(y, 0.4 * Math.hypot(dv.x, dv.y, dv.z));
  if (s.vel.y > KNOCK_RISE_LIMIT && y > 0) y *= 0.5;
  s.vel.x += dv.x;
  s.vel.y += y;
  s.vel.z += dv.z;
  s.onGround = false;
}
