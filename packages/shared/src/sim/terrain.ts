import type { Vec3 } from '../math.js';

export interface RayHit { t: number; point: Vec3; normal: Vec3; boxIndex: number; /** Hit a mesh triangle from behind (the ray started inside a closed mesh). */ back?: boolean }

/** Regular-grid heightfield in meters, y-up. Sample (i,j) sits at (originX + i*cellX, originZ + j*cellZ). */
export class Heightfield {
  readonly cellX: number;
  readonly cellZ: number;
  /** Per-vertex flag: 1 = the quad whose min corner is this vertex is a hole. */
  holes: Uint8Array | null = null;

  constructor(
    readonly width: number,
    readonly depth: number,
    readonly resX: number,
    readonly resZ: number,
    readonly heights: Float32Array,
    readonly originX = -width / 2,
    readonly originZ = -depth / 2,
  ) {
    this.cellX = width / (resX - 1);
    this.cellZ = depth / (resZ - 1);
  }

  static flat(size: number, res: number, h = 0): Heightfield {
    return new Heightfield(size, size, res, res, new Float32Array(res * res).fill(h));
  }

  sample(i: number, j: number): number {
    i = i < 0 ? 0 : i >= this.resX ? this.resX - 1 : i;
    j = j < 0 ? 0 : j >= this.resZ ? this.resZ - 1 : j;
    return this.heights[j * this.resX + i];
  }

  heightAt(x: number, z: number): number {
    const fx = (x - this.originX) / this.cellX;
    const fz = (z - this.originZ) / this.cellZ;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = this.sample(i, j), h10 = this.sample(i + 1, j), h01 = this.sample(i, j + 1), h11 = this.sample(i + 1, j + 1);
    // Split each cell into two triangles so collision matches the rendered mesh.
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  isHole(x: number, z: number): boolean {
    if (!this.holes) return false;
    const i = Math.floor((x - this.originX) / this.cellX), j = Math.floor((z - this.originZ) / this.cellZ);
    if (i < 0 || j < 0 || i >= this.resX - 1 || j >= this.resZ - 1) return false;
    return this.holes[j * this.resX + i] !== 0;
  }

  /** Height for collision purposes; -Infinity inside terrain holes. */
  solidHeightAt(x: number, z: number): number {
    return this.isHole(x, z) ? -Infinity : this.heightAt(x, z);
  }

  normalAt(x: number, z: number): Vec3 {
    const fx = (x - this.originX) / this.cellX;
    const fz = (z - this.originZ) / this.cellZ;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = this.sample(i, j), h10 = this.sample(i + 1, j), h01 = this.sample(i, j + 1), h11 = this.sample(i + 1, j + 1);
    let dx: number, dz: number;
    if (tx + tz <= 1) { dx = (h10 - h00) / this.cellX; dz = (h01 - h00) / this.cellZ; }
    else { dx = (h11 - h01) / this.cellX; dz = (h11 - h10) / this.cellZ; }
    const l = Math.hypot(dx, 1, dz);
    return { x: -dx / l, y: 1 / l, z: -dz / l };
  }

  inBounds(x: number, z: number, margin = 0): boolean {
    return x >= this.originX + margin && x <= this.originX + this.width - margin && z >= this.originZ + margin && z <= this.originZ + this.depth - margin;
  }

  /**
   * Terrain is a two-sided surface: any crossing (down or up) outside a hole counts as a hit,
   * which keeps rays inside underground tunnels (below terrain) working.
   */
  raycast(from: Vec3, to: Vec3): RayHit | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const lenH = Math.hypot(dx, dz);
    const step = Math.min(this.cellX, this.cellZ) * 0.5;
    const n = Math.max(1, Math.ceil(lenH / step), Math.ceil(Math.abs(dy) / 2));
    let prevT = 0;
    let prevSign = from.y - this.heightAt(from.x, from.z) >= 0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = from.x + dx * t, y = from.y + dy * t, z = from.z + dz * t;
      const sign = y - this.heightAt(x, z) >= 0;
      if (sign !== prevSign) {
        let lo = prevT, hi = t;
        for (let b = 0; b < 10; b++) {
          const m = (lo + hi) / 2;
          const mx = from.x + dx * m, my = from.y + dy * m, mz = from.z + dz * m;
          if ((my - this.heightAt(mx, mz) >= 0) === prevSign) lo = m; else hi = m;
        }
        const px = from.x + dx * lo, pz = from.z + dz * lo;
        if (!this.isHole(px, pz)) {
          const nrm = this.normalAt(px, pz);
          if (!prevSign) { nrm.x = -nrm.x; nrm.y = -nrm.y; nrm.z = -nrm.z; }
          return { t: lo, point: { x: px, y: from.y + dy * lo, z: pz }, normal: nrm, boxIndex: -1 };
        }
      }
      prevT = t;
      prevSign = sign;
    }
    return null;
  }
}
