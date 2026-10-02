import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UPackage } from './upk.js';

// Dev helper: find packages containing SoundNodeWave exports matching a pattern.
// Usage: tsx src/find-sounds.ts <CookedPC> <regex> [maxMB]
const [, , root, pattern = 'VGS', maxMb = '600'] = process.argv;
const re = new RegExp(pattern, 'i');
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(upk|u)$/i.test(f) && statSync(p).size < Number(maxMb) * 1e6) files.push(p); } };
walk(root);
for (const f of files) {
  try {
    const pkg = new UPackage(f);
    const hits = pkg.exports.filter((e) => pkg.className(e) === 'SoundNodeWave' && re.test(pkg.refPath(pkg.exports.indexOf(e) + 1)));
    if (hits.length) console.log(`${hits.length}\t${f}\t${hits.slice(0, 3).map((e) => pkg.refPath(pkg.exports.indexOf(e) + 1)).join(', ')}`);
  } catch (err) { console.log(`! ${f}: ${(err as Error).message}`); }
}
