/**
 * One-step setup of the Tribes: Ascend data that ta-import reads:
 *   1. downloads the community "Parting Gifts" Tribes: Ascend archive (Backblaze, Wayback Machine as fallback),
 *   2. unpacks it into the folder that contains this repository (top-level folder stripped, so Binaries/,
 *      Engine/ and TribesGame/ sit right next to Ascend_Reborn/),
 *   3. runs `npm run ta-import -- --all`.
 *
 * Usage: npm run install-ta [-- --dir <target>] [--zip <local zip>] [--keep-zip] [--force] [--no-import]
 * Nothing is downloaded when the target already holds TribesGame/CookedPC (unless --force).
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createInflateRaw } from 'node:zlib';

const PRIMARY = 'https://f000.backblazeb2.com/file/tribes-zip/Tribes_Ascend_Parting_Gifts.zip';
const MIRRORS = [
  PRIMARY,
  // "id_" asks the Wayback Machine for the original bytes instead of its HTML frame.
  'https://web.archive.org/web/20250825161924id_/https://f000.backblazeb2.com/file/tribes-zip/Tribes_Ascend_Parting_Gifts.zip',
  'https://web.archive.org/web/20250825161924/https://f000.backblazeb2.com/file/tribes-zip/Tribes_Ascend_Parting_Gifts.zip',
];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const target = resolve(opt('dir') ?? join(repo, '..'));
const force = args.includes('--force');
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;

async function freeBytes(dir: string): Promise<number> {
  try { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

function progress(label: string, total: number) {
  let done = 0, last = 0;
  const t0 = Date.now();
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - last > 500) {
        last = now;
        const rate = done / Math.max(0.001, (now - t0) / 1000);
        const pct = total ? ` ${((done / total) * 100).toFixed(1)}%` : '';
        process.stdout.write(`\r  ${label}${pct}  ${gb(done)}${total ? ` / ${gb(total)}` : ''}  ${(rate / 1024 ** 2).toFixed(1)} MB/s   `);
      }
      cb(null, chunk);
    },
    flush(cb) { process.stdout.write('\n'); cb(); },
  });
}

async function download(dest: string): Promise<void> {
  for (const url of MIRRORS) {
    console.log(`Downloading ${url}`);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6 * 60 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if ((res.headers.get('content-type') ?? '').includes('text/html')) throw new Error('got an HTML page instead of the archive');
      const total = Number(res.headers.get('content-length') ?? 0);
      const free = await freeBytes(dirname(dest));
      if (total && free < total * 2.3) throw new Error(`not enough disk space on ${dirname(dest)}: ${gb(free)} free, about ${gb(total * 2.3)} needed (archive + unpacked)`);
      const part = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as never), progress('download', total), createWriteStream(part));
      const head = Buffer.alloc(2);
      const fh = await open(part, 'r'); await fh.read(head, 0, 2, 0); await fh.close();
      if (head.toString('latin1') !== 'PK') throw new Error('downloaded file is not a zip archive');
      renameSync(part, dest);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (/disk space/.test(msg)) throw e;
      console.warn(`  failed: ${msg}`);
    }
  }
  throw new Error('all download sources failed');
}

interface Entry { name: string; method: number; compSize: number; size: number; offset: number }

/** Minimal ZIP reader (stored/deflate, zip64) that streams entries straight to disk. */
async function readEntries(zip: string): Promise<Entry[]> {
  const fh = await open(zip, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const rec = Number(tail.readBigUInt64LE(loc + 8));
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, rec);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('bad zip64 end record');
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const out: Entry[] = [];
    let p = 0;
    for (let k = 0; k < count && p + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
      const method = cd.readUInt16LE(p + 10), flags = cd.readUInt16LE(p + 8);
      let compSize = cd.readUInt32LE(p + 20), sz = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nl).toString(flags & 0x800 ? 'utf8' : 'latin1');
      let e = p + 46 + nl;
      const end = e + el;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (sz === 0xffffffff) { sz = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
        }
        e += 4 + len;
      }
      out.push({ name: name.replace(/\\/g, '/'), method, compSize, size: sz, offset });
      p = end + cl;
    }
    return out;
  } finally { await fh.close(); }
}

async function extract(zip: string, dest: string) {
  const entries = await readEntries(zip);
  // Strip a single top-level folder so the game lands directly in `dest`.
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.name.includes('/')) ? `${[...tops][0]}/` : '';
  const total = entries.reduce((a, e) => a + e.size, 0);
  const free = await freeBytes(dest);
  if (free < total * 1.02) throw new Error(`not enough disk space on ${dest}: ${gb(free)} free, ${gb(total)} needed`);
  console.log(`Unpacking ${entries.length} files (${gb(total)}) into ${dest}${strip ? ` (without the "${strip.slice(0, -1)}" folder)` : ''}`);
  const fh = await open(zip, 'r');
  const lh = Buffer.alloc(30);
  let done = 0, last = 0;
  try {
    for (const en of entries) {
      const rel = en.name.slice(strip.length);
      if (!rel) continue;
      // Zip-slip guard: never write outside the destination.
      const out = resolve(dest, rel);
      if (!out.startsWith(resolve(dest) + sep) || /(^|\/)\.\.(\/|$)/.test(rel)) throw new Error(`unsafe path in archive: ${en.name}`);
      if (rel.endsWith('/')) { mkdirSync(out, { recursive: true }); continue; }
      mkdirSync(dirname(out), { recursive: true });
      if (!force && existsSync(out) && statSync(out).size === en.size) { done += en.size; continue; }
      await fh.read(lh, 0, 30, en.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${en.name}`);
      const start = en.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (en.compSize === 0) { createWriteStream(out).end(); continue; }
      const src = createReadStream(zip, { start, end: start + en.compSize - 1 });
      if (en.method === 0) await pipeline(src, createWriteStream(out));
      else if (en.method === 8) await pipeline(src, createInflateRaw(), createWriteStream(out));
      else throw new Error(`unsupported compression ${en.method} for ${en.name}`);
      done += en.size;
      if (Date.now() - last > 500) { last = Date.now(); process.stdout.write(`\r  unpack ${((done / Math.max(1, total)) * 100).toFixed(1)}%  ${gb(done)} / ${gb(total)}   `); }
    }
    process.stdout.write('\n');
  } finally { await fh.close(); }
}

function runImport(): Promise<number> {
  console.log('Running the importer (npm run ta-import -- --all) ...');
  return new Promise((res) => {
    const child = spawn('npm', ['run', 'ta-import', '--', '--all', '--install', target], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function main() {
  console.log(`Ascend Reborn installer\n  game data folder: ${target}\n  repository:       ${repo}`);
  mkdirSync(target, { recursive: true });
  const have = existsSync(join(target, 'TribesGame', 'CookedPC'));
  if (have && !force) console.log('Tribes: Ascend data already present (TribesGame/CookedPC); skipping download. Use --force to reinstall.');
  else {
    const local = opt('zip');
    const zip = local ? resolve(local) : join(target, 'Tribes_Ascend_Parting_Gifts.zip');
    if (!existsSync(zip)) await download(zip);
    else console.log(`Using ${zip}`);
    await extract(zip, target);
    if (!local && !args.includes('--keep-zip')) rmSync(zip, { force: true });
  }
  if (args.includes('--no-import')) return;
  const code = await runImport();
  if (code !== 0) { console.error(`ta-import exited with ${code}`); process.exit(code); }
  console.log('\nDone. Start the game with "npm start" (or "npm run play" for client mode) and open http://localhost:7770');
}

main().catch((e) => { console.error(`\nInstall failed: ${(e as Error).message}`); process.exit(1); });
