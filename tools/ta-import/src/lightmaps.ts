import { extractTexture, type TexMip, type TextureData } from './texture.js';
import type { ExportEntry, UPackage } from './upk.js';

/** A lightmap atlas texture referenced by instances, with the UE3 coordinate scale/bias into it. */
export interface LightmapSource { pkg: UPackage; exp: ExportEntry }
/** Where a source landed: page index and UV transform `pageUV = texUV * (su, sv) + (u0, v0)`. */
export interface LightmapPlacement { page: number; su: number; sv: number; u0: number; v0: number }

const PAGE = 2048;

/**
 * TA bakes hundreds of small DXT1 lightmap atlases per level. Drawing per atlas would explode draw calls, so pick
 * one mip per atlas (the largest that keeps the total under `budget` texels), shelf-pack them into 2048-wide
 * DXT1 pages by copying 4x4 blocks, and return the pages plus each source's placement.
 */
export function packLightmaps(sources: LightmapSource[], cookedDir: string, budget = 6e6): { pages: TextureData[]; placed: (LightmapPlacement | null)[] } {
  const chains = sources.map((s) => {
    const t = extractTexture(s.pkg, s.exp, cookedDir, 1024);
    return t && t.format === 'dxt1' ? t.mips : null;
  });
  // Largest common size cap that fits the budget.
  const pick = (chain: TexMip[], cap: number) => chain.find((m) => Math.max(m.w, m.h) <= cap) ?? chain[chain.length - 1];
  let cap = 1024;
  for (; cap > 32; cap /= 2) {
    const total = chains.reduce((n, c) => n + (c ? pick(c, cap).w * pick(c, cap).h : 0), 0);
    if (total <= budget) break;
  }
  const mips = chains.map((c) => (c ? pick(c, cap) : null));
  const order = mips.map((m, i) => i).filter((i) => mips[i]).sort((a, b) => mips[b]!.h - mips[a]!.h || mips[b]!.w - mips[a]!.w);

  // Shelf packing (all sizes are multiples of 4).
  const pos: { page: number; x: number; y: number }[] = [];
  let page = 0, x = 0, y = 0, shelf = 0;
  const used: number[] = [0];
  for (const i of order) {
    const m = mips[i]!;
    if (x + m.w > PAGE) { x = 0; y += shelf; shelf = 0; }
    if (y + m.h > PAGE) { page++; x = 0; y = 0; shelf = 0; used[page] = 0; }
    pos[i] = { page, x, y };
    x += m.w;
    shelf = Math.max(shelf, m.h);
    used[page] = Math.max(used[page], y + m.h);
  }

  const pages: TextureData[] = used.map((h, p) => {
    const ph = Math.max(4, Math.ceil(h / 4) * 4);
    return { name: `page${p}`, format: 'dxt1', mips: [{ w: PAGE, h: ph, data: new Uint8Array((PAGE / 4) * (ph / 4) * 8) }] };
  });
  for (const i of order) {
    const m = mips[i]!, at = pos[i], dst = pages[at.page].mips[0].data;
    const bw = Math.ceil(m.w / 4), bh = Math.ceil(m.h / 4), rowBlocks = PAGE / 4;
    for (let j = 0; j < bh; j++) {
      const s = j * bw * 8, d = ((at.y / 4 + j) * rowBlocks + at.x / 4) * 8;
      dst.set(m.data.subarray(s, s + bw * 8), d);
    }
  }
  const placed = sources.map((_, i) => {
    const m = mips[i], at = pos[i];
    if (!m || !at) return null;
    const ph = pages[at.page].mips[0].h;
    return { page: at.page, su: m.w / PAGE, sv: m.h / ph, u0: at.x / PAGE, v0: at.y / ph };
  });
  return { pages, placed };
}
