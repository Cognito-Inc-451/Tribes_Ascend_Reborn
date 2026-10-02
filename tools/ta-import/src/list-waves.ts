import { UPackage } from './upk.js';

// Dev helper: print all SoundNodeWave names under a group. Usage: tsx src/list-waves.ts <file> <group>
const pkg = new UPackage(process.argv[2]);
const names: string[] = [];
for (let i = 0; i < pkg.exports.length; i++) {
  const e = pkg.exports[i];
  if (pkg.className(e) === 'SoundNodeWave' && pkg.refPath(i + 1).startsWith(process.argv[3] + '.')) names.push(pkg.refPath(i + 1).slice(process.argv[3].length + 1));
}
console.log(names.sort().join(' '));
