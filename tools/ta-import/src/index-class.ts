import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPackage } from './upk.js';

// Dev helper: index all exports of the given classes. Usage: tsx src/index-class.ts <CookedPC> <out.json> [Class,Class...]
const [, , root, out, classes = 'SkeletalMesh'] = process.argv;
const want = new Set(classes.split(','));
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(upk|u|fmap|udk)$/i.test(f)) files.push(p); } };
walk(root);
const index: Record<string, { file: string; cls: string; size: number }> = {};
for (const f of files) {
  try {
    const pkg = new UPackage(f);
    for (let i = 0; i < pkg.exports.length; i++) {
      const e = pkg.exports[i];
      const cls = pkg.className(e);
      if (!want.has(cls)) continue;
      const path = pkg.refPath(i + 1);
      if (!index[path] || index[path].size < e.serialSize) index[path] = { file: f, cls, size: e.serialSize };
    }
  } catch { /* unreadable package */ }
}
writeFileSync(out, JSON.stringify(index, null, 1));
console.log(`${Object.keys(index).length} objects indexed`);
