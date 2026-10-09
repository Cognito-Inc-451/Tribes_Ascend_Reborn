import { describe, expect, test } from 'vitest';
import {
  bannerWind,
  createCloth,
  resetCloth,
  stepCloth,
  type Cloth,
  type ClothVec,
} from '../src/render/cloth.js';

/** Longest link stretch ratio across the whole mesh (1 = exactly at rest length). */
function stretch(c: Cloth): number {
  let worst = 0;
  for (let l = 0; l < c.links.length; l += 2) {
    const a = c.links[l] * 3;
    const b = c.links[l + 1] * 3;
    const dx = c.pos[a] - c.pos[b];
    const dy = c.pos[a + 1] - c.pos[b + 1];
    const dz = c.pos[a + 2] - c.pos[b + 2];
    const rest = c.restLen[l >> 1];
    if (rest > 1e-9) worst = Math.max(worst, Math.hypot(dx, dy, dz) / rest);
  }
  return worst;
}

function allFinite(c: Cloth): boolean {
  for (const v of c.pos) if (!Number.isFinite(v)) return false;
  for (const v of c.prev) if (!Number.isFinite(v)) return false;
  return true;
}

describe('createCloth', () => {
  test('builds cols*rows particles matching a subdivided plane', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    expect(c.pos.length).toBe(9 * 5 * 3);
    expect(c.prev.length).toBe(c.pos.length);
    expect(c.rest.length).toBe(c.pos.length);
    expect(c.pinned.length).toBe(9 * 5);
    // Row-major, centred on the origin, first row at the top: PlaneGeometry layout.
    expect(c.pos[0]).toBeCloseTo(-1.1 / 2, 6);
    expect(c.pos[1]).toBeCloseTo(0.7 / 2, 6);
    expect(c.pos[2]).toBeCloseTo(0, 6);
    expect(c.pos[(9 * 5 - 1) * 3]).toBeCloseTo(1.1 / 2, 6);
    expect(c.pos[(9 * 5 - 1) * 3 + 1]).toBeCloseTo(-0.7 / 2, 6);
  });

  test('pins only the pole edge (left column)', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    for (let i = 0; i < c.pinned.length; i++) {
      expect(c.pinned[i]).toBe(i % 9 === 0 ? 1 : 0);
    }
  });

  test('rest lengths come from the initial layout', () => {
    const c = createCloth(2, 1, 3, 2);
    // Horizontal spacing 1, vertical 1, diagonal sqrt(2). restLen is a
    // Float32Array, so compare with a float32-sized tolerance.
    expect(c.restLen.some((r) => Math.abs(r - 1) < 1e-6)).toBe(true);
    expect(c.restLen.some((r) => Math.abs(r - Math.SQRT2) < 1e-6)).toBe(true);
  });
});

describe('stepCloth', () => {
  test('pinned particles stay exactly at rest', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    for (let i = 0; i < 400; i++) {
      stepCloth(c, 1 / 60, i / 60, { x: 6, y: 1, z: -4 });
    }
    for (let i = 0; i < c.pinned.length; i++) {
      if (!c.pinned[i]) continue;
      expect(c.pos[i * 3]).toBeCloseTo(c.rest[i * 3], 6);
      expect(c.pos[i * 3 + 1]).toBeCloseTo(c.rest[i * 3 + 1], 6);
      expect(c.pos[i * 3 + 2]).toBeCloseTo(c.rest[i * 3 + 2], 6);
    }
  });

  test('no link ever stretches beyond its rest length', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      stepCloth(c, 1 / 30, i / 30, { x: 18, y: -6, z: 9 }, 3.2, 1.6);
      worst = Math.max(worst, stretch(c));
    }
    // Positions and rest lengths are Float32Arrays, so a link measured after the
    // clamp carries ~1e-7 relative rounding per component; 1e-5 leaves headroom
    // while still catching any real elongation.
    expect(worst).toBeLessThanOrEqual(1.00001);
  });

  test('the free edge trails downwind of the pole', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    for (let i = 0; i < 240; i++) stepCloth(c, 1 / 60, i / 60, { x: 8, y: 0, z: 0 });
    // Wind blows along -X (bannerWind inverts the flag's velocity), so the free
    // edge must trail behind the pole side rather than streaming out to +X.
    const tipX = c.pos[(9 * 5 - 1) * 3];
    expect(tipX).toBeLessThan(c.rest[(9 * 5 - 1) * 3]);
  });

  test('stays finite under absurd steps', () => {
    const c = createCloth(1, 1, 5, 5);
    for (let i = 0; i < 120; i++) {
      stepCloth(c, i % 2 ? 10 : 0, i, { x: 1e4, y: -1e4, z: 1e4 }, 9.8, 3);
      expect(allFinite(c)).toBe(true);
    }
  });

  test('resetCloth snaps the mesh back to its rest layout', () => {
    const c = createCloth(1.1, 0.7, 9, 5);
    for (let i = 0; i < 120; i++) stepCloth(c, 1 / 60, i / 60, { x: 9, y: 2, z: 3 });
    resetCloth(c);
    for (let i = 0; i < c.pos.length; i++) expect(c.pos[i]).toBeCloseTo(c.rest[i], 6);
  });
});

describe('bannerWind', () => {
  test('a stationary banner feels no wind', () => {
    const w = bannerWind({ x: 0, y: 0, z: 0 }, 0);
    expect(w.x).toBeCloseTo(0, 6);
    expect(w.y).toBeCloseTo(0, 6);
    expect(w.z).toBeCloseTo(0, 6);
  });

  test('airflow opposes the flag velocity', () => {
    const vel: ClothVec = { x: 10, y: 0, z: 0 };
    const w = bannerWind(vel, 0, 2.6);
    expect(w.x).toBeCloseTo(-26, 6);
    expect(w.z).toBeCloseTo(0, 6);
  });

  test('vertical motion is damped so the banner does not flip', () => {
    const w = bannerWind({ x: 0, y: 10, z: 0 }, 0, 2);
    expect(w.y).toBeCloseTo(-10, 6);
  });

  test('yaw rotates the airflow into banner space', () => {
    const vel: ClothVec = { x: 10, y: 0, z: 0 };
    const half = Math.SQRT1_2;
    // Quarter turn: world +X is the banner's +Z, so the full speed shows up there.
    const a = bannerWind(vel, Math.PI / 2, 1);
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.z).toBeCloseTo(10, 5);
    const b = bannerWind(vel, Math.PI, 1);
    expect(b.x).toBeCloseTo(10, 5);
    expect(b.z).toBeCloseTo(0, 5);
    const d = bannerWind(vel, Math.PI / 4, 1);
    expect(d.x).toBeCloseTo(-10 * half, 5);
    expect(d.z).toBeCloseTo(10 * half, 5);
  });

  test('writes into a supplied output vector', () => {
    const out = { x: 1, y: 1, z: 1 };
    const r = bannerWind({ x: 4, y: 0, z: 0 }, 0, 1, out);
    expect(r).toBe(out);
    expect(out.x).toBeCloseTo(-4, 6);
  });
});
