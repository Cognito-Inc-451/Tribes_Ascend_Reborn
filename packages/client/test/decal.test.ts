// Decal placement maths. Vitest runs in a `node` environment, so the module
// under test is imported after shimming the browser globals it touches at
// import time, and only the pure exported helpers are exercised (no WebGL).
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).localStorage = {
  _m: new Map<string, string>(),
  getItem(k: string) { return this._m.get(k) ?? null; },
  setItem(k: string, v: string) { this._m.set(k, v); },
  removeItem(k: string) { this._m.delete(k); },
};

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decalQuaternion } from '../src/render/fx.js';

/** Rotate +Z by the quaternion (x, y, z, w) and return the result. */
function rotateForward(q: [number, number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  // v' = q * v * q^-1 with v = (0, 0, 1)
  return [
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
}

function norm(q: [number, number, number, number]): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

test('a +Z normal needs no rotation', () => {
  assert.deepEqual(decalQuaternion({ x: 0, y: 0, z: 1 }), [0, 0, 0, 1]);
});

test('a -Z normal flips the decal about X', () => {
  assert.deepEqual(decalQuaternion({ x: 0, y: 0, z: -1 }), [1, 0, 0, 0]);
});

test('the quaternion is unit length', () => {
  const cases = [
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 1 },
    { x: -0.3, y: 0.8, z: -0.5 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 0 },
  ];
  for (const n of cases) {
    assert.ok(Math.abs(norm(decalQuaternion(n)) - 1) < 1e-12, JSON.stringify(n));
  }
});

test('no quaternion contains NaN', () => {
  for (const n of [{ x: 0, y: 0, z: 0 }, { x: 1e-9, y: 1e-9, z: 1e-9 }]) {
    for (const v of decalQuaternion(n)) assert.ok(Number.isFinite(v), JSON.stringify(n));
  }
});

test('the quaternion carries +Z onto the surface normal', () => {
  const cases = [
    { x: 0, y: 1, z: 0 },
    { x: 0.7071, y: 0.7071, z: 0 },
    { x: 0, y: 0.7071, z: 0.7071 },
    { x: -0.3, y: 0.8, z: -0.5 },
    { x: 0.5, y: -0.2, z: 0.84 },
  ];
  for (const raw of cases) {
    const len = Math.hypot(raw.x, raw.y, raw.z);
    const n = { x: raw.x / len, y: raw.y / len, z: raw.z / len };
    const f = rotateForward(decalQuaternion(n));
    assert.ok(Math.abs(f[0] - n.x) < 1e-9, `${JSON.stringify(n)} -> ${JSON.stringify(f)}`);
    assert.ok(Math.abs(f[1] - n.y) < 1e-9, `${JSON.stringify(n)} -> ${JSON.stringify(f)}`);
    assert.ok(Math.abs(f[2] - n.z) < 1e-9, `${JSON.stringify(n)} -> ${JSON.stringify(f)}`);
  }
});

test('unnormalised input still aims at the surface', () => {
  const n = { x: 0, y: 3, z: 3 }; // 45 degree slope, length 3*sqrt(2)
  const f = rotateForward(decalQuaternion(n));
  const k = Math.SQRT1_2;
  assert.ok(Math.abs(f[1] - k) < 1e-9);
  assert.ok(Math.abs(f[2] - k) < 1e-9);
});
