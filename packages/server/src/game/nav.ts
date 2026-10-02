import type { CollisionWorld, Vec3 } from '@ar/shared';

const VOX = 0.5;            // voxel size (m)
const DOWN = 12, UP = 28;   // region below / above the goal (m)
const CAP_R = 1, CAP_H = 4; // capsule footprint in voxels: radius 0.5 m, height 2 m
const STEP = 2;             // search lattice step in voxels (1 m)

/**
 * Routes from open sky to indoor objectives (generator rooms, CaH points and flag stands inside bases) for bots.
 * The map around the goal is voxelised once (triangles + the terrain shell), dilated by the player capsule, and a
 * breadth-first search from the goal stops at the first cell with nothing above it; the result is string-pulled into
 * a few waypoints. Only objectives prepared with `prepare` have routes, so bots never trigger work mid-match.
 */
export class IndoorRoutes {
  private done = new Map<string, Vec3[] | null>();
  /** Diagnostics for tuning. */
  lastNodes = 0;
  lastMs = 0;

  constructor(private world: CollisionWorld) {}

  private static key(p: Vec3) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }

  /** Waypoints (outdoor entrance first, goal last), or null when the goal is outdoors, unreachable or not prepared. */
  route(goal: Vec3): Vec3[] | null {
    return this.done.get(IndoorRoutes.key(goal)) ?? null;
  }

  prepare(goal: Vec3) {
    const k = IndoorRoutes.key(goal);
    if (this.done.has(k)) return;
    const t0 = performance.now();
    // Most entrances are close; big bases (Katabatic) need a wider region.
    this.done.set(k, this.openSky(goal) ? null : this.search(goal, 45) ?? this.search(goal, 90));
    this.lastMs = performance.now() - t0;
  }

  openSky(p: Vec3): boolean {
    return !this.world.raycast({ x: p.x, y: p.y + 1.2, z: p.z }, { x: p.x, y: p.y + 150, z: p.z }, undefined, false);
  }

  private search(goal: Vec3, HALF: number): Vec3[] | null {
    const nx = Math.round((HALF * 2) / VOX), nz = nx, ny = Math.round((DOWN + UP) / VOX);
    const ox = goal.x - HALF, oz = goal.z - HALF, oy = goal.y - DOWN;
    const idx = (ix: number, iy: number, iz: number) => (iy * nz + iz) * nx + ix;
    const solid = new Uint8Array(nx * ny * nz);
    const mark = (x: number, y: number, z: number) => {
      const ix = Math.floor((x - ox) / VOX), iy = Math.floor((y - oy) / VOX), iz = Math.floor((z - oz) / VOX);
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz) solid[idx(ix, iy, iz)] = 1;
    };

    // Triangles: small ones mark their bounding voxels, large ones are sampled on a sub-voxel lattice.
    const grid = this.world.tris;
    if (grid) {
      const T = grid.tris;
      for (const t of grid.query(ox, oz, ox + HALF * 2, oz + HALF * 2, [])) {
        const o = t * 9;
        const minX = Math.min(T[o], T[o + 3], T[o + 6]), maxX = Math.max(T[o], T[o + 3], T[o + 6]);
        const minY = Math.min(T[o + 1], T[o + 4], T[o + 7]), maxY = Math.max(T[o + 1], T[o + 4], T[o + 7]);
        const minZ = Math.min(T[o + 2], T[o + 5], T[o + 8]), maxZ = Math.max(T[o + 2], T[o + 5], T[o + 8]);
        if (maxX < ox || maxZ < oz || maxY < oy || minX > ox + HALF * 2 || minZ > oz + HALF * 2 || minY > oy + DOWN + UP) continue;
        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
        if (span <= VOX * 2) {
          for (let x = minX; x <= maxX + VOX * 0.5; x += VOX) for (let y = minY; y <= maxY + VOX * 0.5; y += VOX) for (let z = minZ; z <= maxZ + VOX * 0.5; z += VOX) mark(Math.min(x, maxX), Math.min(y, maxY), Math.min(z, maxZ));
          continue;
        }
        const n = Math.ceil(span / (VOX * 0.6));
        for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
          const a = i / n, b = j / n, c = 1 - a - b;
          mark(T[o] * c + T[o + 3] * a + T[o + 6] * b, T[o + 1] * c + T[o + 4] * a + T[o + 7] * b, T[o + 2] * c + T[o + 5] * a + T[o + 8] * b);
        }
      }
    }
    // Terrain is a two-sided shell (rooms under it stay separate from the outside).
    const Tf = this.world.terrain;
    const terrainTop = new Int16Array(nx * nz).fill(-1);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const x = ox + (ix + 0.5) * VOX, z = oz + (iz + 0.5) * VOX;
      if (Tf.isHole(x, z)) continue;
      const iy = Math.floor((Tf.heightAt(x, z) - oy) / VOX);
      terrainTop[iz * nx + ix] = Math.min(ny - 1, iy);
      for (let k = iy - 1; k <= iy; k++) if (k >= 0 && k < ny) solid[idx(ix, k, iz)] = 1;
    }
    // Highest solid voxel per column: anything above it sees the sky.
    const top = new Int16Array(nx * nz).fill(-1);
    for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) if (solid[idx(ix, iy, iz)]) top[iz * nx + ix] = iy;

    // Capsule clearance: dilate horizontally by CAP_R and upward by CAP_H (feet voxel blocked if the body would overlap).
    const bx = new Uint8Array(solid.length);
    for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      let v = 0;
      for (let d = -CAP_R; d <= CAP_R && !v; d++) { const x = ix + d; if (x >= 0 && x < nx) v = solid[idx(x, iy, iz)]; }
      bx[idx(ix, iy, iz)] = v;
    }
    const bz = new Uint8Array(solid.length);
    for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      let v = 0;
      for (let d = -CAP_R; d <= CAP_R && !v; d++) { const z = iz + d; if (z >= 0 && z < nz) v = bx[idx(ix, iy, z)]; }
      bz[idx(ix, iy, iz)] = v;
    }
    const blocked = bx; // reuse
    for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      let v = 0;
      for (let d = 0; d < CAP_H && !v; d++) { const y = iy + d; v = y >= ny ? 0 : bz[idx(ix, y, iz)]; }
      blocked[idx(ix, iy, iz)] = v;
    }

    // BFS on a 1 m lattice through the goal voxel.
    const gx = Math.floor(HALF / VOX), gz = gx, gy0 = Math.floor(DOWN / VOX) + 1;
    let gy = -1;
    for (let k = 0; k <= 6; k++) if (gy0 + k < ny && !blocked[idx(gx, gy0 + k, gz)]) { gy = gy0 + k; break; }
    if (gy < 0) return null;
    const parent = new Map<number, number>();
    const queue: number[] = [idx(gx, gy, gz)];
    parent.set(queue[0], -1);
    let exit = -1;
    for (let h = 0; h < queue.length; h++) {
      const cur = queue[h];
      const ix = cur % nx, iz = Math.floor(cur / nx) % nz, iy = Math.floor(cur / (nx * nz));
      const col = iz * nx + ix;
      if (h > 0 && iy > top[col] && iy > terrainTop[col]) { exit = cur; break; }
      for (const [dx, dy, dz] of [[STEP, 0, 0], [-STEP, 0, 0], [0, 0, STEP], [0, 0, -STEP], [0, STEP, 0], [0, -STEP, 0]]) {
        const x = ix + dx, y = iy + dy, z = iz + dz;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const n = idx(x, y, z);
        if (parent.has(n) || blocked[n] || blocked[idx(ix + dx / 2, iy + dy / 2, iz + dz / 2)]) continue;
        parent.set(n, cur);
        queue.push(n);
      }
    }
    this.lastNodes = queue.length;
    if (exit < 0) return null;
    const cells: number[] = [];
    for (let k = exit; k >= 0; k = parent.get(k) ?? -1) cells.push(k);
    const at = (k: number): Vec3 => {
      const ix = k % nx, iz = Math.floor(k / nx) % nz, iy = Math.floor(k / (nx * nz));
      return { x: ox + (ix + 0.5) * VOX, y: oy + iy * VOX + 0.05, z: oz + (iz + 0.5) * VOX };
    };
    // A straight segment is usable when every feet voxel along it (or one step up) has capsule clearance.
    const clear = (a: Vec3, b: Vec3) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (Math.abs(b.y - a.y) > 3) return false;
      const n = Math.ceil(len / (VOX * 0.5));
      for (let s = 1; s < n; s++) {
        const t = s / n;
        const ix = Math.floor((a.x + (b.x - a.x) * t - ox) / VOX), iz = Math.floor((a.z + (b.z - a.z) * t - oz) / VOX);
        const iy = Math.floor((a.y + (b.y - a.y) * t - oy) / VOX);
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz || iy < 0 || iy + 2 >= ny) return false;
        if (blocked[idx(ix, iy, iz)] && blocked[idx(ix, iy + 1, iz)] && blocked[idx(ix, iy + 2, iz)]) return false;
      }
      return true;
    };
    const raw = cells.map(at);
    raw.push({ ...goal });
    const out: Vec3[] = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      let j = raw.length - 1;
      while (j > i + 1 && !clear(raw[i], raw[j])) j--;
      out.push(raw[j]);
      i = j;
    }
    return out;
  }
}
