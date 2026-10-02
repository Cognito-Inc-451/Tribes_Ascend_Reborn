import { parseObject } from './props.js';
import { UPackage } from './upk.js';

// Dev helper: dump Texture2D layout. Usage: tsx src/probe-tex.ts <file> [nameFilter]
const pkg = new UPackage(process.argv[2]);
const filter = (process.argv[3] ?? '').toLowerCase();
let shown = 0;
for (const e of pkg.exports) {
  if (pkg.className(e) !== 'Texture2D' || !e.objectName.toLowerCase().includes(filter)) continue;
  const data = pkg.exportData(e);
  const obj = parseObject(pkg, data)!;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  console.log(`--- ${e.objectName} size ${data.length} propsEnd ${obj.end}`);
  for (const [k, val] of obj.props) console.log('  prop', k, JSON.stringify(val)?.slice(0, 100));
  const ints = (o: number, n: number) => [...Array(n)].map((_, i) => v.getInt32(o + i * 4, true));
  console.log('  tail ints:', ints(obj.end, 24).join(' '));
  if (++shown >= Number(process.argv[4] ?? 2)) break;
}
