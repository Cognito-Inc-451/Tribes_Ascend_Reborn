import { describe, expect, it } from 'vitest';
import { ADAPTIVE_RULE, adaptiveStep, initialAdaptiveState, type AdaptiveRule } from '../src/render/adaptive.js';

const RULE: AdaptiveRule = { ...ADAPTIVE_RULE, samples: 3 };

/** Feed a frame-rate sequence and report the resulting scale. */
const run = (fps: number[], player = 1, start = player, rule = RULE) => {
  let st = initialAdaptiveState(start, rule);
  for (const f of fps) st = adaptiveStep(st, f, player, rule);
  return st.scale;
};

describe('adaptive resolution', () => {
  it("starts at the player's slider value, clamped to the rule range", () => {
    expect(initialAdaptiveState(1.5).scale).toBe(1.5);
    expect(initialAdaptiveState(0.2).scale).toBe(ADAPTIVE_RULE.min);
    expect(initialAdaptiveState(9).scale).toBe(ADAPTIVE_RULE.max);
  });

  it('idles inside the deadband', () => {
    expect(run([56, 58, 60, 62, 64, 56, 58, 60], 1)).toBe(1);
  });

  it('drops one step after a sustained slow trend', () => {
    expect(run([40, 40, 40], 1)).toBeCloseTo(0.95, 5);
    expect(run([40, 40, 40, 40, 40, 40], 1)).toBeCloseTo(0.9, 5);
  });

  it('climbs back after a sustained fast trend', () => {
    expect(run([80, 80, 80], 1.5, 0.8)).toBeCloseTo(0.85, 5);
  });

  it("never climbs above the player's slider", () => {
    expect(run(new Array(20).fill(200), 1)).toBe(1);
  });

  it('never drops below the floor', () => {
    expect(run(new Array(60).fill(5), 1)).toBe(ADAPTIVE_RULE.min);
  });

  it('obeys a lowered slider immediately', () => {
    let st = initialAdaptiveState(1, RULE);
    for (let i = 0; i < 3; i++) st = adaptiveStep(st, 40, 1, RULE);
    expect(st.scale).toBeCloseTo(0.95, 5);
    st = adaptiveStep(st, 60, 0.6, RULE);
    expect(st.scale).toBe(0.6);
    expect(st.streak).toBe(0);
  });

  it('cancels oscillating samples instead of accumulating them', () => {
    // Alternating slow/fast never reaches the required streak length.
    expect(run([40, 70, 40, 70, 40, 70, 40, 70], 1)).toBe(1);
  });

  it('lands on the slider grid', () => {
    let st = initialAdaptiveState(1, RULE);
    for (let i = 0; i < 60; i++) st = adaptiveStep(st, 20, 1, RULE);
    expect(Math.abs(st.scale * 100 - Math.round(st.scale * 100))).toBeLessThan(1e-9);
  });

  it('resets its streak when it takes a step', () => {
    let st = initialAdaptiveState(1, RULE);
    for (let i = 0; i < 3; i++) st = adaptiveStep(st, 40, 1, RULE);
    expect(st.streak).toBe(0);
    expect(st.scale).toBeCloseTo(0.95, 5);
  });

  it('recovers under a frame-rate cap that pins the measured fps', () => {
    // A 60 fps cap lets the counter reach ~61.9 and no higher; targeting 90% of the cap
    // puts that above the fast threshold, so a dropped scale can climb back.
    const capped: AdaptiveRule = { ...ADAPTIVE_RULE, target: 54, samples: 3 };
    expect(run(new Array(6).fill(40), 1, 1, capped)).toBeLessThan(1);
    expect(run(new Array(3).fill(61.9), 1, 0.9, capped)).toBeCloseTo(0.95, 5);
  });

  it('keeps the shipped rule conservative', () => {
    // 44 slow samples must not move it; the 45th must.
    expect(run(new Array(44).fill(40), 1, 1, ADAPTIVE_RULE)).toBe(1);
    expect(run(new Array(45).fill(40), 1, 1, ADAPTIVE_RULE)).toBeCloseTo(0.95, 5);
  });
});
