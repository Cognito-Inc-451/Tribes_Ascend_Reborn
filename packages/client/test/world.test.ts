// Unit tests for the pure maths helpers in render/world.ts (weather wrap box and
// view-distance culling). vitest runs in a node environment, so stub the browser
// globals that settings.ts touches at import time before importing the module.
import { describe, expect, it } from 'vitest';

const mem: Record<string, string> = {};
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
};

const { wrapBox, cullVisible } = await import('../src/render/world.js');

const BOX = 120, HALF = BOX / 2;

describe('wrapBox', () => {
  it('maps coordinates into the box centred on c', () => {
    for (let v = -5000; v <= 5000; v += 7) {
      const w = wrapBox(v, 0, BOX);
      expect(w).toBeGreaterThanOrEqual(-HALF);
      expect(w).toBeLessThan(HALF);
    }
  });

  it('is periodic with the box size', () => {
    for (let v = -300; v <= 300; v += 11) {
      expect(wrapBox(v + BOX, 0, BOX)).toBeCloseTo(wrapBox(v, 0, BOX), 6);
      expect(wrapBox(v - BOX, 0, BOX)).toBeCloseTo(wrapBox(v, 0, BOX), 6);
    }
  });

  it('keeps the coordinate unchanged when it is already inside the box', () => {
    // The GPU wrap must be a no-op for particles already around the camera,
    // otherwise particles would teleport when the camera moves.
    for (let v = -59; v <= 59; v += 13) expect(wrapBox(v, 0, BOX)).toBeCloseTo(v, 6);
    for (let v = 41; v <= 159; v += 13) expect(wrapBox(v, 100, BOX)).toBeCloseTo(v, 6);
  });

  it('wraps around the centre, not around zero', () => {
    // Box centred on 1000 spans [940, 1060): 0 folds to 0 + 8 * 120 = 960.
    expect(wrapBox(0, 1000, BOX)).toBeCloseTo(960, 6);
    expect(wrapBox(1000 + HALF - 1, 1000, BOX)).toBeCloseTo(1000 + HALF - 1, 6);
    expect(wrapBox(1000 + HALF, 1000, BOX)).toBeCloseTo(1000 - HALF, 6);
  });

  it('handles negative centres and offsets', () => {
    // Box centred on -1000 spans [-1060, -940): -60 folds to -60 - 8 * 120 = -1020.
    expect(wrapBox(-60, -1000, BOX)).toBeCloseTo(-1020, 6);
    expect(wrapBox(-61, -1000, BOX)).toBeCloseTo(-1021, 6);
  });
});

describe('cullVisible', () => {
  it('keeps bodies inside the view distance and culls bodies beyond it', () => {
    expect(cullVisible(0, 0, 0, 1, 900, true, 1.15)).toBe(true);
    expect(cullVisible(899, 0, 0, 1, 900, false, 1.15)).toBe(true);
    expect(cullVisible(1100, 0, 0, 1, 900, true, 1.15)).toBe(false);
    expect(cullVisible(1100, 0, 0, 1, 900, false, 1.15)).toBe(false);
  });

  it('measures the nearest surface, so a large body stays visible', () => {
    // Centre 950 m away with a 100 m radius: nearest surface is 850 m, inside 900 m.
    expect(cullVisible(950, 0, 0, 100, 900, false, 1.15)).toBe(true);
    expect(cullVisible(1001, 0, 0, 100, 900, false, 1.15)).toBe(false);
  });

  it('applies hysteresis: a visible body is only hidden once past dist * hysteresis', () => {
    // Nearest surface at 1000 m: inside the 900 * 1.15 = 1035 m exit threshold.
    expect(cullVisible(1000, 0, 0, 0, 900, true, 1.15)).toBe(true);
    expect(cullVisible(1036, 0, 0, 0, 900, true, 1.15)).toBe(false);
    // ... while a hidden body only re-enters at 900 m, so the boundary does not flicker.
    expect(cullVisible(1000, 0, 0, 0, 900, false, 1.15)).toBe(false);
  });

  it('uses the full 3D distance', () => {
    // 400,400,400 is 692.8 m from the camera.
    expect(cullVisible(400, 400, 400, 0, 700, false, 1.15)).toBe(true);
    expect(cullVisible(400, 400, 400, 0, 690, false, 1.15)).toBe(false);
  });
});
