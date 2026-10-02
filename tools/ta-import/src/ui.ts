import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { extractTexture, type TextureData } from './texture.js';
import type { UPackage } from './upk.js';

/** Decode mip 0 to RGBA8. */
export function decodeRGBA(t: TextureData): { w: number; h: number; rgba: Uint8Array } {
  const { w, h, data } = t.mips[0];
  const out = new Uint8Array(w * h * 4);
  if (t.format === 'rgba') {
    const gray = data.length === w * h;
    for (let i = 0; i < w * h; i++) {
      if (gray) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i]; out[i * 4 + 3] = 255; continue; }
      out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3];
    }
    return { w, h, rgba: out };
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const c565 = (c: number) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const block = t.format === 'dxt1' ? 8 : 16;
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const base = (by * bw + bx) * block;
    if (base + block > data.length) continue;
    const co = base + (block === 16 ? 8 : 0);
    const a = v.getUint16(co, true), b = v.getUint16(co + 2, true);
    const p0 = c565(a), p1 = c565(b);
    const opaque = t.format !== 'dxt1' || a > b;
    const pal = [p0, p1, opaque ? p0.map((x, i) => (2 * x + p1[i]) / 3) : p0.map((x, i) => (x + p1[i]) / 2), opaque ? p0.map((x, i) => (x + 2 * p1[i]) / 3) : [0, 0, 0]];
    const bits = v.getUint32(co + 4, true);
    const alpha = new Array<number>(16).fill(255);
    if (t.format === 'dxt3') for (let i = 0; i < 16; i++) alpha[i] = ((data[base + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
    else if (t.format === 'dxt5') {
      const a0 = data[base], a1 = data[base + 1];
      const ap = [a0, a1];
      for (let k = 1; k < 7; k++) ap.push(a0 > a1 ? ((7 - k) * a0 + k * a1) / 7 : k < 5 ? ((5 - k) * a0 + k * a1) / 5 : k === 5 ? 0 : 255);
      if (a0 <= a1) { ap[6] = 0; ap[7] = 255; }
      let ab = 0n;
      for (let k = 0; k < 6; k++) ab |= BigInt(data[base + 2 + k]) << BigInt(8 * k);
      for (let i = 0; i < 16; i++) alpha[i] = ap[Number((ab >> BigInt(3 * i)) & 7n)];
    }
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const idx = (bits >>> (2 * i)) & 3, col = pal[idx], q = (y * w + x) * 4;
      out[q] = col[0]; out[q + 1] = col[1]; out[q + 2] = col[2];
      out[q + 3] = t.format === 'dxt1' ? (!opaque && idx === 3 ? 0 : 255) : alpha[i];
    }
  }
  return { w, h, rgba: out };
}

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf: Uint8Array) => { let c = -1; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(tb));
  return Buffer.concat([len, tb, cr]);
};

export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const UI_PREFIXES = ['TribesHud.', 'Hud_Items.Custom.', 'Hud_Items.hud_', 'Hud_CaH.Textures.', 'TribesMenu.LoadingScene.', 'TribesMenu.TeamSummary.', 'TribesUI.Login.', 'Hud_HealthBar.'];

/** Exports HUD icons and the menu/HUD images embedded in TA's Scaleform UI to outDir/ui/<path>.png. */
export function exportUi(pkgs: UPackage[], cooked: string, outDir: string, log: (s: string) => void): string[] {
  const dir = join(outDir, 'ui');
  mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  for (const pkg of pkgs) for (let i = 0; i < pkg.exports.length; i++) {
    const e = pkg.exports[i];
    if (pkg.className(e) !== 'Texture2D') continue;
    const path = pkg.refPath(i + 1);
    if (!UI_PREFIXES.some((p) => path.startsWith(p))) continue;
    const tex = extractTexture(pkg, e, cooked, 1024);
    if (!tex?.mips.length) continue;
    const { w, h, rgba } = decodeRGBA(tex);
    const name = path.replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase();
    if (names.includes(name)) continue;
    writeFileSync(join(dir, `${name}.png`), encodePng(w, h, rgba));
    names.push(name);
  }
  // Startup splash (TribesGame/Splash/PC/Splash.bmp: 24-bit bottom-up BMP) -> ui/splash.png.
  const bmp = join(cooked, '..', 'Splash', 'PC', 'Splash.bmp');
  if (existsSync(bmp)) {
    const b = readFileSync(bmp);
    const off = b.readUInt32LE(10), w = b.readInt32LE(18), hh = b.readInt32LE(22), bpp = b.readUInt16LE(28);
    if (b.toString('latin1', 0, 2) === 'BM' && b.readUInt32LE(30) === 0 && (bpp === 24 || bpp === 32) && w > 0 && w < 8192 && Math.abs(hh) < 8192) {
      const H = Math.abs(hh), bytes = bpp / 8, stride = Math.ceil((w * bytes) / 4) * 4;
      const rgba = new Uint8Array(w * H * 4);
      for (let y = 0; y < H; y++) {
        const src = off + (hh > 0 ? H - 1 - y : y) * stride;
        for (let x = 0; x < w; x++) {
          const s = src + x * bytes, d = (y * w + x) * 4;
          rgba[d] = b[s + 2]; rgba[d + 1] = b[s + 1]; rgba[d + 2] = b[s]; rgba[d + 3] = 255;
        }
      }
      writeFileSync(join(dir, 'splash.png'), encodePng(w, H, rgba));
      names.push('splash');
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ images: names }));
  log(`ui: ${names.length} images`);
  return names;
}
