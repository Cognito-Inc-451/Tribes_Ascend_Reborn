import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { encodeMapData, ITEMS, LAYOUTS, type ModeId, type ThemeId } from '@ar/shared';
import { exportAnims } from './anim.js';
import { importMap, indexCooked, loadPackage, modeFromFile } from './extract.js';
import { Resolver } from './material.js';
import { exportModels } from './models.js';
import { extractMusic, extractSfx, extractVoices } from './sound.js';
import { exportUi } from './ui.js';
import { encodeTexture, extractTexture, type TextureData } from './texture.js';
import { UPackage } from './upk.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const install = resolve(opt('install', resolve(repoRoot, '..'))!);
const outDir = resolve(opt('out', join(repoRoot, 'maps-original'))!);
const only = opt('only')?.split(',');
const all = args.includes('--all');
const texMax = Number(opt('texmax', '512'));
// Mips above texmax (up to texhi) go to <name>.hi.atx, fetched only by clients on Ultra texture quality.
const texHi = Number(opt('texhi', '1024'));
const withTextures = !args.includes('--no-textures');
const withVoices = !args.includes('--no-voices');
const assetsOnly = args.includes('--assets-only');
const cooked = join(install, 'TribesGame', 'CookedPC');

if (!existsSync(cooked)) {
  console.error(`Tribes: Ascend CookedPC not found at ${cooked}. Pass --install <path to Tribes Ascend>.`);
  process.exit(1);
}

const files = new Map<string, string>();
(function walk(d: string) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (['.fmap', '.udk'].includes(extname(f).toLowerCase()) && /^Tr[A-Za-z]+-/.test(f)) files.set(basename(f, extname(f)), p);
  }
})(join(cooked, 'Maps'));

interface Job { id: string; name: string; theme: ThemeId; mode: ModeId; file: string; internal: string }
const jobs: Job[] = [];
const used = new Set<string>();
for (const l of LAYOUTS) {
  for (const internal of l.internal ?? []) {
    const file = files.get(internal);
    const mode = modeFromFile(internal);
    if (!file || !mode) continue;
    if (jobs.some((j) => j.id === l.id && j.mode === mode)) continue;
    jobs.push({ id: l.id, name: l.name, theme: l.theme, mode, file, internal });
    used.add(internal);
  }
}
if (all) {
  for (const [internal, file] of files) {
    if (used.has(internal) || /[_-](Sound|Ter|Cameras|Visuals)$/i.test(internal)) continue;
    const mode = modeFromFile(internal);
    if (!mode) continue;
    const raw = internal.replace(/^Tr[A-Za-z]+-/, '');
    const id = `x_${raw.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (jobs.some((j) => j.id === id && j.mode === mode)) continue;
    jobs.push({ id, name: raw.replace(/([a-z])([A-Z])/g, '$1 $2'), theme: 'alpine', mode, file, internal });
  }
}

mkdirSync(outDir, { recursive: true });
const texDir = join(outDir, 'textures');
mkdirSync(texDir, { recursive: true });
const texDone = new Map<string, boolean>();
const onTexture = withTextures
  ? (t: { pkg: UPackage; exp: { objectName: string } }) => {
    const name = t.exp.objectName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 96);
    const known = texDone.get(name);
    if (known !== undefined) return known ? name : null;
    const file = join(texDir, `${name}.atx`);
    let ok = existsSync(file);
    if (!ok) {
      const tex = extractTexture(t.pkg, t.exp as never, cooked, texMax);
      if (tex) { writeFileSync(file, encodeTexture(tex)); ok = true; }
    }
    const hiFile = join(texDir, `${name}.hi.atx`), noHi = join(texDir, `${name}.hi.none`);
    if (ok && texHi > texMax && !existsSync(hiFile) && !existsSync(noHi)) {
      const big = extractTexture(t.pkg, t.exp as never, cooked, texHi);
      const top = big ? big.mips.filter((m) => Math.max(m.w, m.h) > texMax) : [];
      if (big && top.length) writeFileSync(hiFile, encodeTexture({ ...big, mips: top }));
      else writeFileSync(noHi, '');
    }
    texDone.set(name, ok);
    return ok ? name : null;
  }
  : undefined;
/** Packed lightmap pages are regenerated on every import (their layout depends on the level). */
const onLightmapPage = withTextures
  ? (t: TextureData) => {
    const name = t.name.replace(/[^A-Za-z0-9_]/g, '_');
    writeFileSync(join(texDir, `${name}.atx`), encodeTexture(t));
    return name;
  }
  : undefined;

if (withVoices && (all || !only || assetsOnly)) {
  const gameU = join(cooked, 'TribesGame.u');
  if (existsSync(gameU)) {
    console.log('Extracting voice packs from TribesGame.u ...');
    const game = new UPackage(gameU);
    const manifest = extractVoices(game, join(outDir, 'voices'), (s) => console.log(`  ${s}`));
    const soundsPkg = join(cooked, 'Maps', 'TA_Sounds.upk');
    manifest.music = extractMusic([game, ...(existsSync(soundsPkg) ? [new UPackage(soundsPkg)] : [])], join(outDir, 'voices'), (s) => console.log(`  ${s}`));
    manifest.sfx = extractSfx(game, Object.keys(ITEMS), join(outDir, 'voices'), (s) => console.log(`  ${s}`));
    const utGame = join(cooked, 'UTGame.u');
    exportUi([game, ...(existsSync(utGame) ? [new UPackage(utGame)] : [])], cooked, outDir, (s) => console.log(`  ${s}`));
    writeFileSync(join(outDir, 'voices', 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
}

if (onTexture && (all || !only || assetsOnly)) {
  console.log('Exporting models (characters, weapons, vehicles, stations) ...');
  const anims1p = exportModels(cooked, outDir, new Resolver(indexCooked(cooked), loadPackage), loadPackage, onTexture, (s) => console.log(`  ${s}`));
  const gameU = join(cooked, 'TribesGame.u');
  if (existsSync(gameU)) exportAnims(loadPackage(gameU), outDir, (s) => console.log(`  ${s}`), anims1p);
}
if (assetsOnly) process.exit(0);

const index: object[] = [];
for (const j of jobs) {
  if (only && !only.includes(j.id)) continue;
  const t0 = Date.now();
  console.log(`${j.internal} -> ${j.id}.${j.mode}`);
  try {
    const map = importMap([j.file], j.mode, { cookedDir: cooked, id: j.id, name: j.name, theme: j.theme, log: (s) => console.log(s), onTexture, onLightmapPage });
    const blob = gzipSync(encodeMapData(map), { level: 6 });
    const name = `${j.id}.${j.mode}.arm.gz`;
    writeFileSync(join(outDir, name), blob);
    const hash = createHash('sha256').update(blob).digest('hex').slice(0, 24);
    const kinds: Record<string, number> = {};
    for (const e of map.entities) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log(`  ${(blob.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0} ms`, JSON.stringify(kinds));
    index.push({ id: j.id, name: j.name, mode: j.mode, theme: j.theme, file: name, bytes: blob.length, hash, internal: j.internal });
  } catch (err) {
    console.error(`  ! failed: ${(err as Error).message}`);
  }
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(mergeIndex(index), null, 2));
console.log(`\nWrote ${index.length} maps to ${outDir} (local only, do not redistribute).`);

/** With --only, keep previously imported entries instead of truncating the index. */
function mergeIndex(fresh: object[]): object[] {
  const path = join(outDir, 'index.json');
  if (!only || !existsSync(path)) return fresh;
  const key = (e: { file?: string }) => e.file;
  const prev = JSON.parse(readFileSync(path, 'utf8')) as { file?: string }[];
  const seen = new Set(fresh.map((e) => key(e as { file?: string })));
  return [...prev.filter((e) => !seen.has(key(e))), ...fresh];
}
