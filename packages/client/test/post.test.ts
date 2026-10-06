// Unit tests for the pure maths helpers in render/post.ts (structural rebuild key,
// chain buffer sizing, bloom response, white balance, haze). vitest runs in a node
// environment, so stub the browser globals that settings.ts touches at import time.
import { describe, expect, it } from 'vitest';

const mem: Record<string, string> = {};
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
};

const { structuralKey, chainSizes, bloomParams, whiteBalance, hazeParams } =
  await import('../src/render/post.js');

const BASE = {
  hdr: true, msaa: 4, bloom: 0.55, ao: 1, godrays: 0.4, dof: 0, motionBlur: 0, ssr: false,
};

describe('structuralKey', () => {
  it('is stable for identical structures', () => {
    expect(structuralKey({ ...BASE })).toBe(structuralKey({ ...BASE }));
  });

  it('ignores slider-only differences (bloom strength, godray intensity, motion shutter)', () => {
    // Strength/intensity changes are uniforms, not shape changes: no rebuild needed.
    expect(structuralKey({ ...BASE, bloom: 1.4 })).toBe(structuralKey({ ...BASE, bloom: 0.2 }));
    expect(structuralKey({ ...BASE, godrays: 0.9 })).toBe(structuralKey({ ...BASE, godrays: 0.1 }));
    expect(structuralKey({ ...BASE, motionBlur: 0.5 })).toBe(structuralKey({ ...BASE, motionBlur: 0.1 }));
  });

  it('reacts to every structural switch', () => {
    const k = structuralKey(BASE);
    expect(structuralKey({ ...BASE, hdr: false })).not.toBe(k);
    expect(structuralKey({ ...BASE, msaa: 0 })).not.toBe(k);
    expect(structuralKey({ ...BASE, ao: 2 })).not.toBe(k);
    expect(structuralKey({ ...BASE, ao: 0 })).not.toBe(k);
    expect(structuralKey({ ...BASE, dof: 0.5 })).not.toBe(k);
    expect(structuralKey({ ...BASE, dof: 0 })).toBe(k);
    expect(structuralKey({ ...BASE, ssr: true })).not.toBe(k);
    // Turning a feature fully on/off changes the shape (defines + targets).
    expect(structuralKey({ ...BASE, bloom: 0 })).not.toBe(k);
    expect(structuralKey({ ...BASE, godrays: 0 })).not.toBe(k);
  });
});

describe('chainSizes', () => {
  it('halves, quarters and eighths by bit shift, rounded', () => {
    const s = chainSizes(1920, 1080);
    expect(s).toMatchObject({ w: 1920, h: 1080, hw: 960, hh: 540, qw: 480, qh: 270, ww: 240, wh: 135 });
  });

  it('never produces a zero or negative dimension', () => {
    for (const [w, h] of [[1, 1], [3, 5], [7, 2], [0, 0], [-4, -4]] as const) {
      const s = chainSizes(w, h);
      for (const v of Object.values(s)) expect(v).toBeGreaterThanOrEqual(1);
    }
  });

  it('rounds fractional sizes', () => {
    const s = chainSizes(1339.5, 751.4);
    expect(s.w).toBe(Math.round(1339.5));
    expect(s.h).toBe(Math.round(751.4));
  });
});

describe('bloomParams', () => {
  it('scales intensity with strength and keeps a high soft knee', () => {
    const p = bloomParams(0.55);
    expect(p.threshold).toBe(1.0);
    expect(p.knee).toBe(0.8);
    expect(p.intensity).toBeCloseTo(0.55 * 0.85, 6);
  });

  it('drops the threshold under the 8-bit ceiling when HDR is off', () => {
    // 8-bit linear targets clip at 1.0: a threshold of 1.0 would never pass a pixel.
    const p = bloomParams(0.55, false);
    expect(p.threshold).toBeLessThan(1.0);
    expect(p.threshold + p.knee).toBeLessThanOrEqual(1.0);
    expect(p.intensity).toBeGreaterThan(bloomParams(0.55).intensity);
  });

  it('clamps extreme strengths into a sane range', () => {
    expect(bloomParams(-1).intensity).toBe(0);
    expect(bloomParams(9).intensity).toBeCloseTo(2 * 0.85, 6);
    expect(bloomParams(-1, false).intensity).toBe(0);
    expect(bloomParams(9, false).intensity).toBeCloseTo(2 * 0.95, 6);
  });

  it('is monotonic in strength', () => {
    expect(bloomParams(0.2).intensity).toBeLessThan(bloomParams(0.55).intensity);
    expect(bloomParams(0.55).intensity).toBeLessThan(bloomParams(1.0).intensity);
    expect(bloomParams(0.2, false).intensity).toBeLessThan(bloomParams(1.0, false).intensity);
  });
});

describe('whiteBalance', () => {
  it('is identity at neutral temperature and tint', () => {
    expect(whiteBalance(0, 0)).toEqual([1, 1, 1]);
  });

  it('warms (R up, B down) with positive temperature', () => {
    const [r, , b] = whiteBalance(1, 0);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });

  it('shifts green/magenta with tint', () => {
    const [, g, b] = whiteBalance(0, 1);
    expect(g).toBeLessThan(1);
    expect(b).toBeGreaterThan(1);
  });

  it('clamps inputs to [-1, 1] and stays positive', () => {
    for (const t of [-3, -1, 0, 1, 3]) {
      for (const g of [-3, 0, 3]) {
        for (const c of whiteBalance(t, g)) {
          expect(c).toBeGreaterThan(0);
          expect(Number.isFinite(c)).toBe(true);
        }
      }
    }
  });
});

describe('hazeParams', () => {
  it('has a sane near/far ordering and a mild amount', () => {
    const h = hazeParams();
    expect(h.near).toBeGreaterThan(0);
    expect(h.far).toBeGreaterThan(h.near);
    expect(h.amount).toBeGreaterThan(0);
    expect(h.amount).toBeLessThan(1);
  });
});
