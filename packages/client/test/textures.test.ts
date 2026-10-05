// Unit tests for the ATX mip-chain helpers in render/textures.ts.
// vitest runs in a node environment, so stub the browser globals that
// settings.ts touches at import time before importing the module.
import { describe, expect, it } from 'vitest';

const mem: Record<string, string> = {};
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
};

const { buildMipChain, parseAtx } = await import('../src/render/textures.js');

type Mip = { w: number, h: number, data: Uint8Array };

function mip(w: number, h: number, blockBytes: number): Mip {
  // DXT block count for a w x h level, matching the encoder's layout.
  const bytes = Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (w * 31 + h * 7 + i) & 0xff;
  return { w, h, data };
}

function encodeAtx(format: number, mips: Mip[], packed = false): Uint8Array {
  let size = 8;
  for (const m of mips) size += 8 + m.data.length;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x41545831); // "ATX1" big-endian
  v.setUint8(4, format);
  v.setUint8(5, mips.length);
  v.setUint8(6, packed ? 1 : 0);
  let o = 8;
  for (const m of mips) {
    v.setUint16(o, m.w, true);
    v.setUint16(o + 2, m.h, true);
    v.setUint32(o + 4, m.data.length, true);
    o += 8;
    buf.set(m.data, o);
    o += m.data.length;
  }
  return buf;
}

describe('parseAtx', () => {
  it('round-trips a full DXT5 chain', () => {
    const mips = [mip(8, 8, 16), mip(4, 4, 16), mip(2, 2, 16), mip(1, 1, 16)];
    const atx = parseAtx(encodeAtx(3, mips).buffer);
    expect(atx).not.toBeNull();
    expect(atx!.format).toBe(3);
    expect(atx!.packed).toBe(false);
    expect(atx!.mips.map((m: Mip) => [m.w, m.h, m.data.length])).toEqual([
      [8, 8, 64], [4, 4, 16], [2, 2, 16], [1, 1, 16],
    ]);
  });

  it('preserves the packed flag', () => {
    const atx = parseAtx(encodeAtx(1, [mip(4, 4, 8)], true).buffer);
    expect(atx?.packed).toBe(true);
  });

  it('rejects a bad magic', () => {
    const buf = encodeAtx(1, [mip(4, 4, 8)]);
    buf[0] = 0x00;
    expect(parseAtx(buf.buffer)).toBeNull();
  });

  it('rejects a buffer truncated mid-chain', () => {
    const atx = parseAtx(encodeAtx(3, [mip(8, 8, 16), mip(4, 4, 16)]).slice(0, 8 + 8 + 32).buffer);
    expect(atx).toBeNull();
  });
});

describe('buildMipChain', () => {
  it('keeps a complete DXT5 8x8 chain intact', () => {
    const { chain, complete } = buildMipChain([mip(8, 8, 16), mip(4, 4, 16), mip(2, 2, 16), mip(1, 1, 16)], 16);
    expect(complete).toBe(true);
    expect(chain.map((m) => [m.width, m.height])).toEqual([[8, 8], [4, 4], [2, 2], [1, 1]]);
    expect(chain.map((m) => m.data.length)).toEqual([64, 16, 16, 16]);
  });

  it('re-slices the tail from the last cooked mip (UE3 stores 4x4 blocks for small levels)', () => {
    // UE3 cooks every level below 4x4 as a 4x4 block, so a chain that stops at
    // 4x4 still contains the bytes for 2x2 and 1x1 in its leading block.
    const { chain, complete } = buildMipChain([mip(8, 8, 16), mip(4, 4, 16)], 16);
    expect(complete).toBe(true);
    expect(chain.length).toBe(4);
    expect(chain[2]).toMatchObject({ width: 2, height: 2 });
    expect(chain[3]).toMatchObject({ width: 1, height: 1 });
    expect(chain[3].data.length).toBe(16);
  });

  it('reports truncated chains and stops at the last fully backed level', () => {
    // Middle level missing (e.g. BULK_UNUSED gap): 2x2 data cannot back 4x4.
    const { chain, complete } = buildMipChain([mip(8, 8, 8), mip(2, 2, 4)], 8);
    expect(complete).toBe(false);
    expect(chain.length).toBe(1);
    expect(chain[0].width).toBe(8);
    expect(chain[0].height).toBe(8);
  });

  it('handles non-power-of-two sizes', () => {
    const { chain, complete } = buildMipChain([mip(12, 8, 8), mip(6, 4, 8), mip(3, 2, 8), mip(1, 1, 8)], 8);
    expect(complete).toBe(true);
    expect(chain.map((m) => [m.width, m.height])).toEqual([[12, 8], [6, 4], [3, 2], [1, 1]]);
  });

  it('every chain level carries exactly its block-aligned byte count', () => {
    const { chain } = buildMipChain([mip(16, 16, 16), mip(8, 8, 16)], 16);
    for (const level of chain) {
      const need = Math.ceil(level.width / 4) * Math.ceil(level.height / 4) * 16;
      expect(level.data.length).toBe(need);
    }
  });
});
