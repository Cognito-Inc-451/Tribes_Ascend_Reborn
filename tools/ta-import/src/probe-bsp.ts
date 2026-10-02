import { parseObject } from './props.js';
import { UPackage } from './upk.js';

// Dev helper: dump the layout of the largest BSP Model in a package.
// Usage: tsx src/probe-bsp.ts <file>
const pkg = new UPackage(process.argv[2]);
let best = -1;
for (let i = 0; i < pkg.exports.length; i++) {
  const e = pkg.exports[i];
  if (pkg.className(e) !== 'Model') continue;
  if (best < 0 || e.serialSize > pkg.exports[best].serialSize) best = i;
}
const e = pkg.exports[best];
const data = pkg.exportData(e);
const obj = parseObject(pkg, data)!;
console.log(`${e.objectName} outer=${pkg.refPath(e.outer)} size=${data.length} propsEnd=${obj.end}`);
const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
let o = obj.end + 28;
const arr = (label: string) => {
  const es = v.getInt32(o, true), n = v.getInt32(o + 4, true);
  console.log(`${label} @${o}: elemSize ${es} count ${n}`);
  const start = o + 8;
  o = start + es * n;
  return { start, es, n };
};
const vecs = arr('Vectors');
const pts = arr('Points');
const nodes = arr('Nodes');
for (let k = 0; k < 3; k++) {
  const b = nodes.start + k * nodes.es;
  const ints = [...Array(nodes.es / 4)].map((_, i) => v.getInt32(b + i * 4, true));
  console.log(`node ${k}: plane ${[0, 1, 2, 3].map((i) => v.getFloat32(b + i * 4, true).toFixed(2)).join(',')} ints ${ints.slice(4).join(' ')} bytes60-63 ${[...data.subarray(b + 60, b + 64)].join(' ')}`);
}
console.log(`after nodes @${o}: surfs count ${v.getInt32(o, true)}; next 64 bytes:`, [...data.subarray(o, o + 64)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
for (let row = 0; row < 6; row++) {
  const b = o + row * 16;
  console.log(`  +${row * 16}: ${[0, 1, 2, 3].map((i) => `${v.getInt32(b + i * 4, true)}/${v.getFloat32(b + i * 4, true).toFixed(2)}`).join('  ')}`);
}
// Find a plausible stride for the Surfs array: offsets of the next few "name/ref-like" repeating patterns.
const hits: number[] = [];
for (let p = o + 4; p < o + 4000 && hits.length < 12; p += 4) if (v.getUint32(p, true) === v.getUint32(o + 4, true)) hits.push(p - o - 4);
console.log('repeat offsets of first surf dword:', hits.join(' '));
const nS = v.getInt32(o, true);
for (let p = o; p < data.length - 8; p += 4) {
  const es = v.getInt32(p, true), n = v.getInt32(p + 4, true);
  if ((es === 24 || es === 16 || es === 20) && n > 100 && n < 200000 && p + 8 + es * n <= data.length) {
    const pv = v.getInt32(p + 8, true), pv2 = v.getInt32(p + 8 + es, true);
    if (pv >= 0 && pv < pts.n && pv2 >= 0 && pv2 < pts.n) console.log(`candidate verts header @${p} (+${p - o}) es ${es} n ${n}; (${p - o - 4}) / nS = ${((p - o - 4) / nS).toFixed(3)}`);
  }
}
let q = o + 4 + nS * 60;
console.log(`after surfs @${q}: ${[0, 1, 2, 3, 4, 5].map((i) => v.getInt32(q + i * 4, true)).join(' ')}`);
const vEs = v.getInt32(q, true), vN = v.getInt32(q + 4, true);
q += 8;
let maxP = 0, sumNV = 0;
for (let i = 0; i < vN; i++) maxP = Math.max(maxP, v.getInt32(q + i * vEs, true));
for (let k = 0; k < nodes.n; k++) sumNV += data[nodes.start + k * 64 + 54];
let maxPool = 0;
for (let k = 0; k < nodes.n; k++) maxPool = Math.max(maxPool, v.getInt32(nodes.start + k * 64 + 16, true) + data[nodes.start + k * 64 + 54]);
console.log(`verts es ${vEs} n ${vN} max pVertex ${maxP} (points ${pts.n}); sum NumVertices ${sumNV}; max pool end ${maxPool}`);
const surfFlags = new Map<number, number>();
for (let i = 0; i < nS; i++) { const f = v.getUint32(o + 4 + i * 60 + 4, true); surfFlags.set(f, (surfFlags.get(f) ?? 0) + 1); }
console.log('surf field1 histogram', [...surfFlags].slice(0, 12).map(([f, n]) => `0x${f.toString(16)}:${n}`).join(' '));
void vecs; void pts;
