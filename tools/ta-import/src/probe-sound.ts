import { UPackage } from './upk.js';
import { parseObject } from './props.js';

// Dev helper: list SoundNodeWave groups in a package and dump one wave's layout.
// Usage: tsx src/probe-sound.ts <file> [groupFilter] [dumpName]
const pkg = new UPackage(process.argv[2]);
const filter = new RegExp(process.argv[3] ?? '.', 'i');
const groups = new Map<string, number>();
const samples = new Map<string, string>();
for (let i = 0; i < pkg.exports.length; i++) {
  const e = pkg.exports[i];
  if (pkg.className(e) !== 'SoundNodeWave') continue;
  const path = pkg.refPath(i + 1);
  if (!filter.test(path)) continue;
  const g = path.split('.').slice(0, -1).join('.');
  groups.set(g, (groups.get(g) ?? 0) + 1);
  if (!samples.has(g)) samples.set(g, path.split('.').pop()!);
}
for (const [g, n] of [...groups].sort()) console.log(String(n).padStart(5), g, '  e.g.', samples.get(g));
const dump = process.argv[4];
if (dump) {
  const i = pkg.exports.findIndex((e) => pkg.className(e) === 'SoundNodeWave' && e.objectName === dump);
  const e = pkg.exports[i];
  const data = pkg.exportData(e);
  const obj = parseObject(pkg, data)!;
  console.log(`--- ${pkg.refPath(i + 1)} size ${data.length} propsEnd ${obj.end}`);
  for (const [k, v] of obj.props) console.log('  prop', k, JSON.stringify(v)?.slice(0, 100));
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = obj.end;
  for (let k = 0; k < 6 && o + 16 <= data.length; k++) {
    const flags = v.getUint32(o, true), count = v.getInt32(o + 4, true), size = v.getInt32(o + 8, true), off = v.getInt32(o + 12, true);
    const head = String.fromCharCode(...data.subarray(o + 16, o + 20));
    console.log(`  bulk ${k} @${o}: flags 0x${flags.toString(16)} count ${count} size ${size} offset ${off} head '${head}'`);
    o += 16 + ((flags & 1) ? 0 : Math.max(0, size));
  }
}
