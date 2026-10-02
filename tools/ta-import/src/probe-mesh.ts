import { parseObject } from './props.js';
import { UPackage } from './upk.js';

// Dev helper: dump StaticMesh layout around the vertex buffers. Usage: tsx src/probe-mesh.ts <file> [nameFilter]
const pkg = new UPackage(process.argv[2]);
const filter = (process.argv[3] ?? '').toLowerCase();
const e = pkg.exports.find((x) => pkg.className(x) === 'StaticMesh' && x.objectName.toLowerCase().includes(filter))!;
const data = pkg.exportData(e);
const obj = parseObject(pkg, data)!;
const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
console.log(`${e.objectName} size ${data.length} propsEnd ${obj.end}`);
for (const [k, val] of obj.props) console.log('  prop', k, JSON.stringify(val)?.slice(0, 80));
let pos = -1, n = 0;
for (let o = obj.end + 28; o + 16 < data.length; o++) {
  if (v.getInt32(o, true) === 12 && v.getInt32(o + 8, true) === 12 && v.getInt32(o + 4, true) === v.getInt32(o + 12, true) && v.getInt32(o + 4, true) > 2) { pos = o; n = v.getInt32(o + 4, true); break; }
}
console.log('position header at', pos, 'n', n);
const ints = (from: number, cnt: number) => [...Array(cnt)].map((_, i) => v.getInt32(from + i * 4, true));
console.log('before pos (120 ints):');
const pre = ints(pos - 480, 120);
for (let r = 0; r < 120; r += 12) console.log(`  @${pos - 480 + r * 4}: ${pre.slice(r, r + 12).join(' ')}`);
const after = pos + 16 + n * 12;
console.log('after positions:', ints(after, 8).join(' '));
const nt = v.getInt32(after, true), stride = v.getInt32(after + 4, true), full = v.getInt32(after + 12, true);
const es = v.getInt32(after + 16, true), cnt = v.getInt32(after + 20, true);
console.log(`numTex ${nt} stride ${stride} full ${full} elemSize ${es} count ${cnt}`);
const vb = after + 24;
for (let i = 0; i < 3; i++) console.log('  vert', i, [...data.subarray(vb + i * es, vb + (i + 1) * es)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
const cAfter = vb + es * cnt;
console.log('after vb:', ints(cAfter, 8).join(' '));
// Print refs that resolve to materials anywhere before the position buffer (byte-aligned scan).
for (let o = obj.end; o < pos; o++) {
  const r = v.getInt32(o, true);
  if (r === 0 || r > pkg.exports.length || -r > pkg.imports.length) continue;
  const cls = r < 0 ? pkg.imports[-r - 1].className : pkg.className(pkg.exports[r - 1]);
  if (!/^Material/.test(cls)) continue;
  console.log(`  ref @${o} (pos-${pos - o}) = ${r} ${cls} ${pkg.refPath(r)} next: ${ints(o + 4, 12).join(' ')}`);
}
