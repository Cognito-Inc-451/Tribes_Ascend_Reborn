/**
 * Minimal Verlet cloth used for flag banners.
 *
 * Deliberately free of three.js so the simulation can be unit-tested in the plain
 * node test environment and reused by both the world flag and the carried flag.
 * Particle order matches THREE.PlaneGeometry(w, h, cols - 1, rows - 1) exactly
 * (row-major, x increasing, y decreasing), so the sim output can be copied
 * straight into the geometry's position buffer.
 */

export interface ClothVec {
  x: number;
  y: number;
  z: number;
}

export interface Cloth {
  cols: number;
  rows: number;
  /** Live positions, 3 floats per particle. */
  pos: Float32Array;
  /** Previous positions for the Verlet integration. */
  prev: Float32Array;
  /** Rest positions; pinned particles are snapped back to these every step. */
  rest: Float32Array;
  pinned: Uint8Array;
  /** Link endpoint indices, pairs. */
  links: Int32Array;
  /** Rest length of each link. */
  restLen: Float32Array;
}

/**
 * Build a banner pinned along its left edge (the pole side).
 * Layout mirrors PlaneGeometry: particle `iy * cols + ix` sits at
 * `x = ix * w / (cols - 1) - w / 2`, `y = h / 2 - iy * h / (rows - 1)`, `z = 0`.
 */
export function createCloth(w: number, h: number, cols: number, rows: number): Cloth {
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const dx = w / (cols - 1);
  const dy = h / (rows - 1);
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const k = (iy * cols + ix) * 3;
      pos[k] = ix * dx - w / 2;
      pos[k + 1] = h / 2 - iy * dy;
      pos[k + 2] = 0;
    }
  }
  const pinned = new Uint8Array(n);
  for (let iy = 0; iy < rows; iy++) pinned[iy * cols] = 1;

  const links: number[] = [];
  const at = (ix: number, iy: number) => iy * cols + ix;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      if (ix + 1 < cols) links.push(at(ix, iy), at(ix + 1, iy));
      if (iy + 1 < rows) links.push(at(ix, iy), at(ix, iy + 1));
      if (ix + 1 < cols && iy + 1 < rows) {
        links.push(at(ix, iy), at(ix + 1, iy + 1));
        links.push(at(ix + 1, iy), at(ix, iy + 1));
      }
    }
  }
  const linkArr = Int32Array.from(links);
  const restLen = new Float32Array(linkArr.length / 2);
  for (let l = 0; l < linkArr.length; l += 2) {
    const a = linkArr[l] * 3;
    const b = linkArr[l + 1] * 3;
    restLen[l >> 1] = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
  }

  return { cols, rows, pos, prev: Float32Array.from(pos), rest: Float32Array.from(pos), pinned, links: linkArr, restLen };
}

/** Snap the banner back to its flat rest shape (used when a flag respawns). */
export function resetCloth(c: Cloth) {
  c.pos.set(c.rest);
  c.prev.set(c.rest);
}

/**
 * Advance the banner one step.
 *
 * `wind` is an acceleration in the banner's local space (m/s^2) — the caller
 * supplies the relative airflow, i.e. the negated flag velocity scaled by a drag
 * coefficient, so a flag streaming behind a running carrier lies flat.
 * `flutter` is a deterministic travelling wave (no RNG) so tests stay stable.
 */
export function stepCloth(c: Cloth, dt: number, t: number, wind: ClothVec, gravity = 3.2, flutter = 1) {
  const h = Math.min(Math.max(dt, 1 / 240), 1 / 20);
  const h2 = h * h;
  const damp = 0.985;
  const { cols, rows, pos, prev, rest, pinned, links, restLen } = c;
  const lastCol = cols - 1;

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = iy * cols + ix;
      const k = i * 3;
      if (pinned[i]) {
        pos[k] = rest[k];
        pos[k + 1] = rest[k + 1];
        pos[k + 2] = rest[k + 2];
        prev[k] = pos[k];
        prev[k + 1] = pos[k + 1];
        prev[k + 2] = pos[k + 2];
        continue;
      }
      // The free edge flutters hardest; the wave travels down the banner.
      const f = flutter * (0.35 + 0.65 * (ix / lastCol));
      const ax = wind.x + Math.sin(t * 3.1 + ix * 0.9 + iy * 1.7) * 2.2 * f;
      const ay = wind.y - gravity + Math.sin(t * 2.3 + ix * 1.3 + iy * 0.6) * 0.55 * f;
      const az = wind.z + Math.cos(t * 2.7 + ix * 0.7 + iy * 1.1) * 2.6 * f;
      const nx = pos[k] + (pos[k] - prev[k]) * damp + ax * h2;
      const ny = pos[k + 1] + (pos[k + 1] - prev[k + 1]) * damp + ay * h2;
      const nz = pos[k + 2] + (pos[k + 2] - prev[k + 2]) * damp + az * h2;
      prev[k] = pos[k];
      prev[k + 1] = pos[k + 1];
      prev[k + 2] = pos[k + 2];
      pos[k] = nx;
      pos[k + 1] = ny;
      pos[k + 2] = nz;
    }
  }

  for (let it = 0; it < 3; it++) {
    for (let l = 0; l < links.length; l += 2) {
      const ia = links[l];
      const ib = links[l + 1];
      const a = ia * 3;
      const b = ib * 3;
      const dx = pos[b] - pos[a];
      const dy = pos[b + 1] - pos[a + 1];
      const dz = pos[b + 2] - pos[a + 2];
      const d = Math.hypot(dx, dy, dz);
      if (!(d > 1e-9)) continue;
      const rest0 = restLen[l >> 1];
      // Pull toward the rest length, but never let a link stretch beyond it.
      const target = d > rest0 ? rest0 : d;
      const corr = (d - target) / d;
      const pa = pinned[ia];
      const pb = pinned[ib];
      if (pa && pb) continue;
      const share = pa || pb ? 1 : 0.5;
      const sx = dx * corr, sy = dy * corr, sz = dz * corr;
      if (!pa) {
        pos[a] += sx * share;
        pos[a + 1] += sy * share;
        pos[a + 2] += sz * share;
      }
      if (!pb) {
        pos[b] -= sx * share;
        pos[b + 1] -= sy * share;
        pos[b + 2] -= sz * share;
      }
    }
    for (let i = 0; i < pinned.length; i++) {
      if (!pinned[i]) continue;
      const k = i * 3;
      pos[k] = rest[k];
      pos[k + 1] = rest[k + 1];
      pos[k + 2] = rest[k + 2];
    }
  }

  // Hard inextensibility. Three Jacobi iterations do not fully converge on a
  // 45-particle mesh, so a strong gust leaves links visibly elongated. Sweeping
  // once is not enough either: repairing a late link drags the free end of an
  // earlier one back past its rest length, so the correction has to propagate down
  // the chain. Repeat the sweep until nothing is over-stretched.
  for (let pass = 0; pass < 12; pass++) {
    let over = 0;
    for (let l = 0; l < links.length; l += 2) {
      const ia = links[l];
      const ib = links[l + 1];
      const pa = pinned[ia];
      const pb = pinned[ib];
      if (pa && pb) continue;
      const a = ia * 3;
      const b = ib * 3;
      const dx = pos[b] - pos[a];
      const dy = pos[b + 1] - pos[a + 1];
      const dz = pos[b + 2] - pos[a + 2];
      const d = Math.hypot(dx, dy, dz);
      if (!(d > 1e-9)) continue;
      const rest0 = restLen[l >> 1];
      if (d <= rest0) continue;
      over = Math.max(over, d - rest0);
      const corr = (d - rest0) / d;
      const sx = dx * corr, sy = dy * corr, sz = dz * corr;
      // Push the slack out to the free edge: the particle further from the pole
      // absorbs the whole correction, so one sweep propagates the fix down the
      // whole banner. Splitting evenly (Jacobi) converges far too slowly for a
      // clamp that has to hold every frame.
      const ca = ia % cols;
      const cb = ib % cols;
      const aShare = pa ? 0 : cb > ca ? 0 : ca > cb ? 1 : pb ? 1 : 0.5;
      const bShare = pb ? 0 : cb > ca ? 1 : ca > cb ? 0 : pa ? 1 : 0.5;
      pos[a] += sx * aShare;
      pos[a + 1] += sy * aShare;
      pos[a + 2] += sz * aShare;
      pos[b] -= sx * bShare;
      pos[b + 1] -= sy * bShare;
      pos[b + 2] -= sz * bShare;
    }
    if (over < 1e-7) break;
  }
}

/**
 * Relative airflow felt by a banner moving through still air, in the banner's
 * local axes. `vel` is the banner's world velocity and `yaw` its facing angle.
 */
export function bannerWind(vel: ClothVec, yaw: number, drag = 2.6, out: ClothVec = { x: 0, y: 0, z: 0 }): ClothVec {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Inverse of the Y-rotation: local = Ry(-yaw) * world.
  out.x = (-vel.x * c - vel.z * s) * drag;
  out.y = -vel.y * drag * 0.5;
  out.z = (vel.x * s - vel.z * c) * drag;
  return out;
}
