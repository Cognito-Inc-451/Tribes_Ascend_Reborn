import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeMapData } from '@ar/shared';

// Dev helper: list meshes whose world bounds contain spawn points. Usage: tsx src/inspect.ts <maps-original/x.arm.gz>
const d = decodeMapData(new Uint8Array(gunzipSync(readFileSync(process.argv[2]))));
const sp = d.entities.filter((e) => e.kind === 'spawn');
const hits = new Map<string, number>();
for (const it of d.instances ?? []) {
  const me = d.meshes![it.mesh];
  const p = me.positions, m = it.m;
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const w = [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
  }
  for (const s of sp) {
    const q = [s.pos.x, s.pos.y + 1, s.pos.z];
    if (q.every((v, k) => v >= mn[k] && v <= mx[k])) {
      const key = `${me.name}${me.collide ? '' : ' (nocollide)'}${me.hidden ? ' hidden' : ''} [${mn.map((v) => v.toFixed(0))}]-[${mx.map((v) => v.toFixed(0))}]`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
}
for (const [k, n] of hits) console.log(n, k);
let lo = Infinity, hi = -Infinity;
for (const h of d.terrain.heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
console.log('terrain range', lo.toFixed(1), hi.toFixed(1), 'spawns', sp.length);
