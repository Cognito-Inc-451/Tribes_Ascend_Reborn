import { readFileSync } from 'node:fs';
import { extractSkeletalMesh } from './skel.js';
import { UPackage } from './upk.js';

// Dev helper: tsx src/probe-skel.ts <skel-index.json> <object path>...
const [, , indexFile, ...paths] = process.argv;
const index = JSON.parse(readFileSync(indexFile, 'utf8')) as Record<string, { file: string }>;
for (const p of paths) {
  const ent = index[p];
  if (!ent) { console.log(`? ${p}`); continue; }
  const pkg = new UPackage(ent.file);
  const i = pkg.exports.findIndex((_, k) => pkg.refPath(k + 1) === p);
  try {
    const m = extractSkeletalMesh(pkg, pkg.exports[i]);
    const n = m.positions.length / 3;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < n; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], m.positions[v * 3 + a]); hi[a] = Math.max(hi[a], m.positions[v * 3 + a]); }
    console.log(`${p}: ${m.bones.length} bones, ${n} verts, ${m.indices.length / 3} tris, ${m.sections.length} sections, mats ${m.materials.map((r) => pkg.refPath(r)).join(' | ')}`);
    console.log(`  bbox ${lo.map((x) => x.toFixed(0))} .. ${hi.map((x) => x.toFixed(0))}; bones: ${m.bones.slice(0, 40).map((b) => b.name).join(' ')}`);
    for (const conj of [false, true]) {
      const wq: number[][] = [], wp: number[][] = [];
      const mul = (a: number[], b: number[]) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
      const rot = (q: number[], v: number[]) => { const p = mul(mul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };
      m.bones.forEach((b, k) => {
        const lq = conj && k > 0 ? [-b.rot[0], -b.rot[1], -b.rot[2], b.rot[3]] : [...b.rot];
        if (b.parent < 0) { wq.push(lq); wp.push([...b.pos]); return; }
        const pr = rot(wq[b.parent], b.pos);
        wp.push([wp[b.parent][0] + pr[0], wp[b.parent][1] + pr[1], wp[b.parent][2] + pr[2]]);
        wq.push(mul(wq[b.parent], lq));
      });
      const show = m.bones.map((b, k) => [b.name, k] as const).filter(([nm]) => /^(Head|L_Hand|R_Hand|L_Foot|R_Foot|L_Toe|F_tire|B_tire|Pelvis)$/i.test(nm));
      console.log(`  conj=${conj}: ${show.map(([nm, k]) => `${nm}(${wp[k].map((x) => x.toFixed(0)).join(',')})`).join(' ')}`);
    }
  } catch (err) { console.log(`! ${p}: ${(err as Error).message}`); }
}
