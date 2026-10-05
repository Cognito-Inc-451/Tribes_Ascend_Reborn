import * as THREE from 'three';
import { settings } from '../settings.js';

/** Decodes the importer's ATX container (DXT1/3/5 or RGBA mip chains). */
export interface Atx { format: number; packed: boolean; mips: { w: number; h: number; data: Uint8Array<ArrayBuffer> }[] }

export function parseAtx(buf: ArrayBuffer): Atx | null {
  const v = new DataView(buf);
  if (buf.byteLength < 8 || v.getUint32(0, false) !== 0x41545831) return null;
  const format = v.getUint8(4), n = v.getUint8(5), packed = v.getUint8(6) === 1;
  const mips: Atx['mips'] = [];
  let o = 8;
  for (let i = 0; i < n && o + 8 <= buf.byteLength; i++) {
    const w = v.getUint16(o, true), h = v.getUint16(o + 2, true), size = v.getUint32(o + 4, true);
    if (o + 8 + size > buf.byteLength) break;
    mips.push({ w, h, data: new Uint8Array(buf, o + 8, size) });
    o += 8 + size;
  }
  return mips.length ? { format, packed, mips } : null;
}

// ---- CPU DXT decode, used only when the GPU lacks S3TC (rare on desktop).
function rgb565(c: number, out: number[], o: number) {
  out[o] = ((c >> 11) & 31) * 255 / 31; out[o + 1] = ((c >> 5) & 63) * 255 / 63; out[o + 2] = (c & 31) * 255 / 31; out[o + 3] = 255;
}

function decodeDxt(m: { w: number; h: number; data: Uint8Array }, format: number): Uint8Array<ArrayBuffer> {
  const { w, h, data } = m;
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const block = format === 1 ? 8 : 16;
  const pal: number[] = new Array(16).fill(0);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = (by * bw + bx) * block;
    let c = b;
    alpha.fill(255);
    if (format === 3) {
      for (let i = 0; i < 8; i++) { const a = data[b + i]; alpha[i * 2] = (a & 15) * 17; alpha[i * 2 + 1] = (a >> 4) * 17; }
      c = b + 8;
    } else if (format === 5) {
      const a0 = data[b], a1 = data[b + 1];
      const av = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) av.push(((7 - i) * a0 + i * a1) / 7);
      else { for (let i = 1; i < 5; i++) av.push(((5 - i) * a0 + i * a1) / 5); av.push(0, 255); }
      let bits = 0n;
      for (let i = 0; i < 6; i++) bits |= BigInt(data[b + 2 + i]) << BigInt(8 * i);
      for (let i = 0; i < 16; i++) alpha[i] = av[Number((bits >> BigInt(3 * i)) & 7n)];
      c = b + 8;
    }
    const c0 = data[c] | (data[c + 1] << 8), c1 = data[c + 2] | (data[c + 3] << 8);
    rgb565(c0, pal, 0); rgb565(c1, pal, 4);
    const opaque = format !== 1 || c0 > c1;
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = opaque ? (2 * pal[k] + pal[4 + k]) / 3 : (pal[k] + pal[4 + k]) / 2;
      pal[12 + k] = opaque ? (pal[k] + 2 * pal[4 + k]) / 3 : 0;
    }
    pal[11] = 255; pal[15] = opaque ? 255 : 0;
    const idx = data[c + 4] | (data[c + 5] << 8) | (data[c + 6] << 16) | (data[c + 7] << 24);
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py;
      if (x >= w || y >= h) continue;
      const i = py * 4 + px, sel = (idx >>> (2 * i)) & 3, o = (y * w + x) * 4;
      out[o] = pal[sel * 4]; out[o + 1] = pal[sel * 4 + 1]; out[o + 2] = pal[sel * 4 + 2];
      out[o + 3] = format === 1 ? pal[sel * 4 + 3] : alpha[i];
    }
  }
  return out;
}

export interface MipLevel { data: Uint8Array<ArrayBuffer>; width: number; height: number }

/**
 * Rebuilds the exact WebGL mip chain (down to 1x1) from a cooked ATX chain.
 * UE3 cooks every level below 4x4 as a 4x4 block, so the missing tail is
 * re-sliced from the last cooked mip (its leading bytes are the top-left
 * quadrant in block order). `complete` is false when the source chain is
 * truncated so far that the tail cannot be re-sliced at all.
 */
export function buildMipChain(mips: { w: number, h: number, data: Uint8Array }[], blockBytes: number): { chain: MipLevel[], complete: boolean } {
  const w0 = mips[0].w, h0 = mips[0].h;
  const levels = Math.floor(Math.log2(Math.max(w0, h0))) + 1;
  const chain: MipLevel[] = [];
  for (let i = 0; i < levels; i++) {
    const width = Math.max(1, w0 >> i), height = Math.max(1, h0 >> i);
    const need = Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
    const src = mips[Math.min(i, mips.length - 1)].data;
    if (src.length < need) break;
    chain.push({ data: src.subarray(0, need) as Uint8Array<ArrayBuffer>, width, height });
  }
  return { chain, complete: chain.length === levels };
}

let s3tc: boolean | null = null;
let maxAniso = 1;

/** Fetches imported textures from this machine's node first, then the host; shared by every material. */
export class TextureStore {
  private cache = new Map<string, Promise<THREE.Texture | null>>();
  constructor(private bases: string[], renderer: THREE.WebGLRenderer) {
    if (s3tc === null) {
      s3tc = renderer.extensions.has('WEBGL_compressed_texture_s3tc') || renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
      maxAniso = renderer.capabilities.getMaxAnisotropy();
    }
  }

  /** `linear` for data textures such as normal maps (no sRGB decode). */
  get(name: string, linear = false): Promise<THREE.Texture | null> {
    const key = linear ? `${name}|lin` : name;
    let p = this.cache.get(key);
    if (!p) { p = this.load(name, linear); this.cache.set(key, p); }
    return p;
  }

  private async fetchAtx(base: string, file: string): Promise<Atx | null> {
    try {
      const r = await fetch(`${base}/assets/tex/${encodeURIComponent(file)}.atx`, { signal: AbortSignal.timeout(20000) });
      return r.ok ? parseAtx(await r.arrayBuffer()) : null;
    } catch { return null; }
  }

  private async load(name: string, linear: boolean): Promise<THREE.Texture | null> {
    for (const base of this.bases) {
      const atx = await this.fetchAtx(base, name);
      if (!atx) continue;
      // Ultra: the importer keeps the original top mips (above 512) in a separate file.
      if (settings.textureDetail === 'ultra') {
        const hi = await this.fetchAtx(base, `${name}.hi`);
        if (hi && hi.format === atx.format) atx.mips = [...hi.mips, ...atx.mips];
      }
      return this.build(atx, linear);
    }
    return null;
  }

  private build(atx: Atx, linear = false): THREE.Texture {
    const cap = settings.textureDetail === 'low' ? 128 : settings.textureDetail === 'medium' ? 256 : settings.textureDetail === 'high' ? 512 : 4096;
    let mips = atx.mips;
    while (mips.length > 1 && Math.max(mips[0].w, mips[0].h) > cap) mips = mips.slice(1);
    let tex: THREE.Texture;
    if (atx.format === 0) {
      const m = mips[0];
      tex = new THREE.DataTexture(m.data, m.w, m.h, THREE.RGBAFormat);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    } else if (s3tc) {
      const fmt = atx.format === 1 ? THREE.RGB_S3TC_DXT1_Format : atx.format === 2 ? THREE.RGBA_S3TC_DXT3_Format : THREE.RGBA_S3TC_DXT5_Format;
      const blockBytes = atx.format === 1 ? 8 : 16;
      const { chain, complete } = buildMipChain(mips, blockBytes);
      if (!chain.length) {
        // Corrupt/truncated source: decode the best mip on the CPU so filtering stays trilinear.
        tex = new THREE.DataTexture(decodeDxt(mips[0], atx.format), mips[0].w, mips[0].h, THREE.RGBAFormat);
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
      } else {
        // Complete chain: upload every level as-is. Truncated chain: upload what we have and let
        // WebGL2 (texStorage2D + generateMipmap) synthesise the missing tail on the GPU, so the
        // texture keeps trilinear + anisotropic filtering instead of dropping to LinearFilter.
        tex = new THREE.CompressedTexture(chain as unknown as ImageData[], mips[0].w, mips[0].h, fmt as THREE.CompressedPixelFormat);
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = !complete;
      }
    } else {
      const m = mips[0];
      tex = new THREE.DataTexture(decodeDxt(m, atx.format), m.w, m.h, THREE.RGBAFormat);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(maxAniso, Math.max(1, settings.anisotropy || 1));
    tex.userData.packed = atx.packed;
    tex.needsUpdate = true;
    return tex;
  }

  dispose() {
    for (const p of this.cache.values()) void p.then((t) => t?.dispose());
    this.cache.clear();
  }
}
