import { parseObject } from './props.js';
import { UPackage } from './upk.js';

// Dev helper: summarise a package's classes to discover actor types.
// Usage: tsx src/probe.ts <file> [classFilter] [--dump N]
const [, , file, filter, dumpFlag, dumpN] = process.argv;
const t0 = Date.now();
const pkg = new UPackage(file);
console.log(`version ${pkg.version}/${pkg.licensee} flags 0x${pkg.flags.toString(16)} comp ${pkg.compressionFlags} names ${pkg.names.length} imports ${pkg.imports.length} exports ${pkg.exports.length} (${Date.now() - t0} ms)`);
if (dumpFlag === '--dump') {
  let n = Number(dumpN ?? 3);
  for (const e of pkg.exports) {
    if (!pkg.className(e).toLowerCase().includes((filter ?? '').toLowerCase())) continue;
    const data = pkg.exportData(e);
    const obj = parseObject(pkg, data);
    console.log(`--- ${pkg.className(e)} ${e.objectName}_${e.nameNumber} size=${e.serialSize} outer=${pkg.refPath(e.outer)} propsEnd=${obj?.end}`);
    if (obj) for (const [k, v] of obj.props) {
      const s = typeof v === 'object' && v && 'ref' in v ? `ref ${v.ref} -> ${pkg.refPath(v.ref)}` : typeof v === 'object' && v && 'raw' in v ? `raw[${v.raw.length}]` : JSON.stringify(v);
      console.log(`   ${k} = ${s}`);
    }
    else console.log('   (unparsed) head:', [...data.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    if (obj && data.length > obj.end) console.log('   tail head:', [...data.subarray(obj.end, obj.end + 48)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    if (--n <= 0) break;
  }
  process.exit(0);
}
const counts = new Map<string, number>();
for (const e of pkg.exports) counts.set(pkg.className(e), (counts.get(pkg.className(e)) ?? 0) + 1);
const rows = [...counts].filter(([c]) => !filter || c.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b[1] - a[1]);
for (const [c, n] of rows.slice(0, 80)) console.log(String(n).padStart(6), c);
