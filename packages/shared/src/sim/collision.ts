import type { Vec3 } from '../math.js';
import { Heightfield, type RayHit } from './terrain.js';

/** Oriented box. `axes` holds the local X, Y, Z unit axes in world space (row-major: ax, ay, az). */
export interface OBB {
  c: Vec3;
  h: [number, number, number];
  axes: [number, number, number, number, number, number, number, number, number];
  mat: string;
  id?: number;
  noCollide?: boolean;
  passTeam?: number;
}

export function makeOBB(c: Vec3, h: [number, number, number], yaw = 0, pitch = 0, roll = 0, mat = 'concrete'): OBB {
  // Rotation order: yaw (Y) * pitch (X) * roll (Z).
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const m00 = cy * cr + sy * sp * sr, m01 = -cy * sr + sy * sp * cr, m02 = sy * cp;
  const m10 = cp * sr, m11 = cp * cr, m12 = -sp;
  const m20 = -sy * cr + cy * sp * sr, m21 = sy * sr + cy * sp * cr, m22 = cy * cp;
  return { c: { ...c }, h, axes: [m00, m10, m20, m01, m11, m21, m02, m12, m22], mat };
}

export function obbBounds(b: OBB): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const a = b.axes;
  const ex = Math.abs(a[0]) * b.h[0] + Math.abs(a[3]) * b.h[1] + Math.abs(a[6]) * b.h[2];
  const ey = Math.abs(a[1]) * b.h[0] + Math.abs(a[4]) * b.h[1] + Math.abs(a[7]) * b.h[2];
  const ez = Math.abs(a[2]) * b.h[0] + Math.abs(a[5]) * b.h[1] + Math.abs(a[8]) * b.h[2];
  return { minX: b.c.x - ex, maxX: b.c.x + ex, minY: b.c.y - ey, maxY: b.c.y + ey, minZ: b.c.z - ez, maxZ: b.c.z + ez };
}

function toLocal(b: OBB, p: Vec3, out: number[]): void {
  const dx = p.x - b.c.x, dy = p.y - b.c.y, dz = p.z - b.c.z, a = b.axes;
  out[0] = dx * a[0] + dy * a[1] + dz * a[2];
  out[1] = dx * a[3] + dy * a[4] + dz * a[5];
  out[2] = dx * a[6] + dy * a[7] + dz * a[8];
}

function dirToWorld(b: OBB, lx: number, ly: number, lz: number): Vec3 {
  const a = b.axes;
  return { x: lx * a[0] + ly * a[3] + lz * a[6], y: lx * a[1] + ly * a[4] + lz * a[7], z: lx * a[2] + ly * a[5] + lz * a[8] };
}

const cl = (v: number, h: number) => (v < -h ? -h : v > h ? h : v);

export interface ContactInfo { onGround: boolean; groundNormal: Vec3; impact: number; hitWall: boolean; hitBox: number }

/** Segment-vs-OBB closest approach. Returns world push normal and depth if within radius. */
export function capsuleVsOBB(b: OBB, a: Vec3, bb: Vec3, r: number): { n: Vec3; depth: number } | null {
  const A = [0, 0, 0], B = [0, 0, 0];
  toLocal(b, a, A);
  toLocal(b, bb, B);
  const [hx, hy, hz] = b.h;
  if (Math.min(Math.abs(A[0]), Math.abs(B[0])) > hx + r && Math.sign(A[0]) === Math.sign(B[0])) return null;
  if (Math.min(A[1], B[1]) > hy + r || Math.max(A[1], B[1]) < -hy - r) return null;
  if (Math.min(Math.abs(A[2]), Math.abs(B[2])) > hz + r && Math.sign(A[2]) === Math.sign(B[2])) return null;
  const d0 = B[0] - A[0], d1 = B[1] - A[1], d2 = B[2] - A[2];
  const dd = d0 * d0 + d1 * d1 + d2 * d2 || 1;
  let t = 0.5, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
  for (let k = 0; k < 4; k++) {
    px = A[0] + d0 * t; py = A[1] + d1 * t; pz = A[2] + d2 * t;
    qx = cl(px, hx); qy = cl(py, hy); qz = cl(pz, hz);
    t = ((qx - A[0]) * d0 + (qy - A[1]) * d1 + (qz - A[2]) * d2) / dd;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  px = A[0] + d0 * t; py = A[1] + d1 * t; pz = A[2] + d2 * t;
  qx = cl(px, hx); qy = cl(py, hy); qz = cl(pz, hz);
  const vx = px - qx, vy = py - qy, vz = pz - qz;
  const dist = Math.hypot(vx, vy, vz);
  if (dist > r) return null;
  if (dist > 1e-5) return { n: dirToWorld(b, vx / dist, vy / dist, vz / dist), depth: r - dist };
  // Segment point inside box: push out along the axis of least penetration.
  const ox = hx - Math.abs(px), oy = hy - Math.abs(py), oz = hz - Math.abs(pz);
  if (oy <= ox && oy <= oz) return { n: dirToWorld(b, 0, Math.sign(py) || 1, 0), depth: oy + r };
  if (ox <= oz) return { n: dirToWorld(b, Math.sign(px) || 1, 0, 0), depth: ox + r };
  return { n: dirToWorld(b, 0, 0, Math.sign(pz) || 1), depth: oz + r };
}

export function rayVsOBB(b: OBB, from: Vec3, to: Vec3): { t: number; normal: Vec3 } | null {
  const o = [0, 0, 0], e = [0, 0, 0];
  toLocal(b, from, o);
  toLocal(b, to, e);
  const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  let tmin = 0, tmax = 1, axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < -b.h[i] || o[i] > b.h[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (-b.h[i] - o[i]) * inv, t2 = (b.h[i] - o[i]) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // started inside
  const n = [0, 0, 0];
  n[axis] = sign;
  return { t: tmin, normal: dirToWorld(b, n[0], n[1], n[2]) };
}

const CELL = 24;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

const TCELL = 8;

/** Static triangle soup (world space) with a uniform XZ grid, used for original-map meshes. */
export class TriGrid {
  private grid = new Map<number, number[]>();
  /** Triangles spanning too many cells (backdrops, huge floors) are tested on every query instead. */
  private big: number[] = [];
  private stamp: Uint32Array;
  private stampId = 1;
  readonly count: number;
  /** Per-triangle AABB (minX, minY, minZ, maxX, maxY, maxZ): cheap reject before exact capsule tests. */
  readonly box: Float32Array;

  constructor(readonly tris: Float32Array) {
    this.count = tris.length / 9;
    this.stamp = new Uint32Array(this.count);
    this.box = new Float32Array(this.count * 6);
    for (let t = 0; t < this.count; t++) {
      const o = t * 9, b = t * 6;
      this.box[b] = Math.min(tris[o], tris[o + 3], tris[o + 6]); this.box[b + 3] = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      this.box[b + 1] = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]); this.box[b + 4] = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
      this.box[b + 2] = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]); this.box[b + 5] = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    }
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const minX = Math.min(tris[o], tris[o + 3], tris[o + 6]), maxX = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const minZ = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), maxZ = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      if (!Number.isFinite(minX + maxX + minZ + maxZ)) continue;
      const i0 = Math.floor(minX / TCELL), i1 = Math.floor(maxX / TCELL), j0 = Math.floor(minZ / TCELL), j1 = Math.floor(maxZ / TCELL);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 256) { this.big.push(t); continue; }
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(t);
        }
    }
  }

  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    this.stampId = (this.stampId + 1) >>> 0 || 1;
    for (let i = Math.floor(minX / TCELL); i <= Math.floor(maxX / TCELL); i++)
      for (let j = Math.floor(minZ / TCELL); j <= Math.floor(maxZ / TCELL); j++) {
        const arr = this.grid.get(key(i, j));
        if (!arr) continue;
        for (const t of arr) {
          if (this.stamp[t] === this.stampId) continue;
          this.stamp[t] = this.stampId;
          out.push(t);
        }
      }
    for (const t of this.big) {
      const o = t * 9, T = this.tris;
      if (Math.max(T[o], T[o + 3], T[o + 6]) < minX || Math.min(T[o], T[o + 3], T[o + 6]) > maxX) continue;
      if (Math.max(T[o + 2], T[o + 5], T[o + 8]) < minZ || Math.min(T[o + 2], T[o + 5], T[o + 8]) > maxZ) continue;
      out.push(t);
    }
    return out;
  }

  /** Möller–Trumbore against candidate triangles along the segment. */
  raycast(from: Vec3, to: Vec3, tmp: number[]): { t: number; normal: Vec3; back: boolean } | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const lenH = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(lenH / TCELL));
    let best: { t: number; normal: Vec3; back: boolean } | null = null;
    this.stampId = (this.stampId + 1) >>> 0 || 1;
    for (let s = 0; s < steps; s++) {
      if (best && s / steps > best.t + 1 / steps) break;
      const t0 = s / steps, t1 = (s + 1) / steps;
      const x0 = from.x + dx * t0, z0 = from.z + dz * t0, x1 = from.x + dx * t1, z1 = from.z + dz * t1;
      for (let i = Math.floor(Math.min(x0, x1) / TCELL); i <= Math.floor(Math.max(x0, x1) / TCELL); i++)
        for (let j = Math.floor(Math.min(z0, z1) / TCELL); j <= Math.floor(Math.max(z0, z1) / TCELL); j++) {
          const arr = this.grid.get(key(i, j));
          if (!arr) continue;
          for (const t of arr) {
            if (this.stamp[t] === this.stampId) continue;
            this.stamp[t] = this.stampId;
            const h = rayTri(this.tris, t * 9, from, dx, dy, dz);
            if (h && (!best || h.t < best.t)) best = h;
          }
        }
    }
    void tmp;
    for (const t of this.big) {
      const h = rayTri(this.tris, t * 9, from, dx, dy, dz);
      if (h && (!best || h.t < best.t)) best = h;
    }
    return best;
  }
}

function rayTri(T: Float32Array, o: number, from: Vec3, dx: number, dy: number, dz: number): { t: number; normal: Vec3; back: boolean } | null {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const sx = from.x - T[o], sy = from.y - T[o + 1], sz = from.z - T[o + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > 1) return null;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const back = nx * dx + ny * dy + nz * dz > 0;
  if (back) { nx = -nx; ny = -ny; nz = -nz; }
  return { t, normal: { x: nx, y: ny, z: nz }, back };
}

const cp = { x: 0, y: 0, z: 0 };
/** Closest point on triangle (Ericson, RTCD 5.1.5); writes into `cp`. */
function closestOnTri(T: Float32Array, o: number, px: number, py: number, pz: number): void {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { cp.x = ax; cp.y = ay; cp.z = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { cp.x = bx; cp.y = by; cp.z = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); cp.x = ax + abx * v; cp.y = ay + aby * v; cp.z = az + abz * v; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { cp.x = cx; cp.y = cy; cp.z = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); cp.x = ax + acx * w; cp.y = ay + acy * w; cp.z = az + acz * w; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    cp.x = bx + (cx - bx) * w; cp.y = by + (cy - by) * w; cp.z = bz + (cz - bz) * w; return;
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  cp.x = ax + abx * v + acx * w; cp.y = ay + aby * v + acy * w; cp.z = az + abz * v + acz * w;
}

function capsuleVsTri(T: Float32Array, o: number, ax: number, ay: number, az: number, by: number, r: number): { n: Vec3; depth: number } | null {
  // Vertical capsule segment (ax, ay..by, az).
  let t = 0.5, py = ay;
  for (let k = 0; k < 3; k++) {
    py = ay + (by - ay) * t;
    closestOnTri(T, o, ax, py, az);
    t = (by - ay) > 1e-6 ? Math.min(1, Math.max(0, (cp.y - ay) / (by - ay))) : 0;
  }
  py = ay + (by - ay) * t;
  closestOnTri(T, o, ax, py, az);
  const vx = ax - cp.x, vy = py - cp.y, vz = az - cp.z;
  const d = Math.hypot(vx, vy, vz);
  if (d >= r) return null;
  if (d > 1e-5) return { n: { x: vx / d, y: vy / d, z: vz / d }, depth: r - d };
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return { n: { x: nx, y: ny, z: nz }, depth: r };
}

export class CollisionWorld {
  private grid = new Map<number, number[]>();
  readonly dynamic = new Map<number, OBB>();
  private stamp = new Uint32Array(0);
  private stampId = 1;

  constructor(readonly terrain: Heightfield, readonly boxes: OBB[], readonly tris: TriGrid | null = null) {
    this.stamp = new Uint32Array(boxes.length);
    boxes.forEach((b, idx) => {
      if (b.noCollide) return;
      const bb = obbBounds(b);
      for (let i = Math.floor(bb.minX / CELL); i <= Math.floor(bb.maxX / CELL); i++)
        for (let j = Math.floor(bb.minZ / CELL); j <= Math.floor(bb.maxZ / CELL); j++) {
          const k = key(i, j);
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(idx);
        }
    });
  }

  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    this.stampId = (this.stampId + 1) >>> 0 || 1;
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++)
      for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
        const arr = this.grid.get(key(i, j));
        if (!arr) continue;
        for (const idx of arr) {
          if (this.stamp[idx] === this.stampId) continue;
          this.stamp[idx] = this.stampId;
          out.push(idx);
        }
      }
    return out;
  }

  private tmp: number[] = [];
  private tmp2: number[] = [];

  raycast(from: Vec3, to: Vec3, ignoreDynamic?: number, includeDynamic = true): RayHit | null {
    let best: RayHit | null = this.terrain.raycast(from, to);
    const cand = this.query(Math.min(from.x, to.x), Math.min(from.z, to.z), Math.max(from.x, to.x), Math.max(from.z, to.z), this.tmp);
    const test = (b: OBB, idx: number) => {
      const h = rayVsOBB(b, from, to);
      if (h && (!best || h.t < best.t)) {
        best = { t: h.t, normal: h.normal, boxIndex: idx, point: { x: from.x + (to.x - from.x) * h.t, y: from.y + (to.y - from.y) * h.t, z: from.z + (to.z - from.z) * h.t } };
      }
    };
    for (const idx of cand) test(this.boxes[idx], idx);
    if (includeDynamic) for (const [id, b] of this.dynamic) if (id !== ignoreDynamic && !b.noCollide) test(b, -1000 - id);
    if (this.tris) {
      const h = this.tris.raycast(from, to, this.tmp);
      if (h && (!best || h.t < best.t)) {
        best = { t: h.t, normal: h.normal, boxIndex: -2, back: h.back, point: { x: from.x + (to.x - from.x) * h.t, y: from.y + (to.y - from.y) * h.t, z: from.z + (to.z - from.z) * h.t } };
      }
    }
    return best;
  }

  /** Push a vertical capsule (feet at pos) out of terrain and boxes, clipping velocity. `prev` = feet position before this move. */
  resolveCapsule(pos: Vec3, vel: Vec3, radius: number, height: number, ignoreDynamic?: number, prev?: Vec3, team = -1): ContactInfo {
    const info: ContactInfo = { onGround: false, groundNormal: { x: 0, y: 1, z: 0 }, impact: 0, hitWall: false, hitBox: -1 };
    const clip = (n: Vec3) => {
      const vn = vel.x * n.x + vel.y * n.y + vel.z * n.z;
      if (vn < 0) {
        // Like UE3 Landed(): only landings on walkable surfaces hurt, never glancing wall hits.
        if (n.y > 0.65) info.impact = Math.max(info.impact, -vn);
        vel.x -= vn * n.x; vel.y -= vn * n.y; vel.z -= vn * n.z;
      }
    };

    for (let iter = 0; iter < 3; iter++) {
      const a = { x: pos.x, y: pos.y + radius, z: pos.z };
      const b = { x: pos.x, y: pos.y + height - radius, z: pos.z };
      const cand = this.query(pos.x - radius - 1, pos.z - radius - 1, pos.x + radius + 1, pos.z + radius + 1, this.tmp);
      let moved = false;
      const handle = (box: OBB, idx: number) => {
        const r = capsuleVsOBB(box, a, b, radius);
        if (!r) return;
        pos.x += r.n.x * r.depth; pos.y += r.n.y * r.depth; pos.z += r.n.z * r.depth;
        a.x = b.x = pos.x; a.y = pos.y + radius; b.y = pos.y + height - radius; a.z = b.z = pos.z;
        clip(r.n);
        if (r.n.y > 0.65) { info.onGround = true; info.groundNormal = r.n; }
        else if (r.n.y > -0.3) info.hitWall = true;
        info.hitBox = idx;
        moved = true;
      };
      for (const idx of cand) handle(this.boxes[idx], idx);
      for (const [id, box] of this.dynamic) if (id !== ignoreDynamic && !box.noCollide && box.passTeam !== team) handle(box, -1000 - id);
      if (this.tris) {
        const T = this.tris.tris, B = this.tris.box;
        const tc = this.tris.query(pos.x - radius - 0.5, pos.z - radius - 0.5, pos.x + radius + 0.5, pos.z + radius + 0.5, this.tmp2);
        for (const t of tc) {
          const bo = t * 6;
          if (B[bo + 1] > pos.y + height || B[bo + 4] < pos.y || B[bo] > pos.x + radius || B[bo + 3] < pos.x - radius || B[bo + 2] > pos.z + radius || B[bo + 5] < pos.z - radius) continue;
          const r = capsuleVsTri(T, t * 9, pos.x, pos.y + radius, pos.z, pos.y + height - radius, radius);
          if (!r) continue;
          pos.x += r.n.x * r.depth; pos.y += r.n.y * r.depth; pos.z += r.n.z * r.depth;
          clip(r.n);
          if (r.n.y > 0.65) { info.onGround = true; info.groundNormal = r.n; }
          else if (r.n.y > -0.3) info.hitWall = true;
          info.hitBox = -2;
          moved = true;
        }
      }
      if (!moved) break;
    }

    const T = this.terrain;
    const h = T.heightAt(pos.x, pos.z);
    const wasAbove = !prev || prev.y >= T.heightAt(prev.x, prev.z) - 0.3;
    if (!T.isHole(pos.x, pos.z)) {
      if (wasAbove && pos.y <= h + 0.02) {
        const n = T.normalAt(pos.x, pos.z);
        if (pos.y < h) pos.y = h;
        clip(n);
        if (!info.onGround || n.y > info.groundNormal.y) info.groundNormal = n;
        info.onGround = true;
      } else if (!wasAbove && prev && pos.y + height > h && prev.y + height <= T.heightAt(prev.x, prev.z) + 0.3) {
        // Underground: terrain acts as a ceiling.
        const n = T.normalAt(pos.x, pos.z);
        pos.y = h - height;
        clip({ x: -n.x, y: -n.y, z: -n.z });
      }
    }
    return info;
  }
}
