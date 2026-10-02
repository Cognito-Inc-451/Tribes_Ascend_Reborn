import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UPackage } from './upk.js';

// Dev helper: find exports of a class whose path matches a pattern.
// Usage: tsx src/find-class.ts <CookedPC> <ClassName> <regex> [maxMB]
const [, , root, cls = 'StaticMesh', pattern = 'WEP', maxMb = '600'] = process.argv;
const re = new RegExp(pattern, 'i');
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(upk|u)$/i.test(f) && statSync(p).size < Number(maxMb) * 1e6) files.push(p); } };
walk(root);
for (const f of files) {
  try {
    const pkg = new UPackage(f);
    const hits: string[] = [];
    for (let i = 0; i < pkg.exports.length; i++) {
      const e = pkg.exports[i];
      if (pkg.className(e) === cls && re.test(pkg.refPath(i + 1))) hits.push(`${pkg.refPath(i + 1)} (${e.serialSize})`);
    }
    if (hits.length) console.log(`${hits.length}\t${f}\n\t${hits.slice(0, 12).join('\n\t')}`);
  } catch (err) { console.log(`! ${f}: ${(err as Error).message}`); }
}
