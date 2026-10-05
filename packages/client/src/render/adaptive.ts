/**
 * Adaptive resolution: nudge the renderer's pixel ratio to hold a frame-rate target.
 *
 * The player's own "Screen Percentage" is the *ceiling* — this controller can only
 * drop below it, never above, so a tuned slider is never overridden by the game.
 * All logic is pure so it can be tested without a GL context.
 */

export interface AdaptiveRule {
  /** Frame rate to hold. */
  target: number;
  /** Lowest scale the controller may pick. */
  min: number;
  /** Highest scale the controller may pick (the player's saved renderScale). */
  max: number;
  /** Quantisation grid, so the scale lands on slider-friendly values. */
  step: number;
  /** Fraction of the target treated as "on target" — nothing changes inside this band. */
  deadband: number;
  /** Consecutive out-of-band samples required before a step is taken. */
  samples: number;
}

export interface AdaptiveState {
  scale: number;
  /** Consecutive out-of-band samples seen so far (signed: negative = slow, positive = fast). */
  streak: number;
}

export const ADAPTIVE_RULE: AdaptiveRule = {
  target: 60,
  min: 0.5,
  max: 2,
  step: 0.05,
  // 8% is wider than the jitter of a smoothed frame counter, so the controller idles
  // at 55-65 fps instead of pumping the resolution every second.
  deadband: 0.08,
  samples: 45,
};

export function initialAdaptiveState(playerScale: number, rule: AdaptiveRule = ADAPTIVE_RULE): AdaptiveState {
  return { scale: clamp(playerScale, rule.min, rule.max), streak: 0 };
}

/**
 * One sample of the controller. `fps` is the smoothed frame rate; `playerScale` is the
 * live slider value, so raising it mid-fight is honoured immediately.
 */
export function adaptiveStep(
  state: AdaptiveState,
  fps: number,
  playerScale: number,
  rule: AdaptiveRule = ADAPTIVE_RULE,
): AdaptiveState {
  const max = clamp(playerScale, rule.min, rule.max);
  // The player lowered the ceiling below where we are: obey at once, no waiting.
  if (state.scale > max) return { scale: max, streak: 0 };

  const slow = fps <= rule.target * (1 - rule.deadband);
  const fast = fps >= rule.target * (1 + rule.deadband);
  if (!slow && !fast) return state.streak === 0 ? state : { scale: state.scale, streak: 0 };

  // A sample in the opposite direction of the current streak cancels it: oscillating
  // frame rates must not accumulate into a step.
  const dir = slow ? -1 : 1;
  const streak = Math.sign(state.streak) === dir ? state.streak + dir : dir;
  if (Math.abs(streak) < rule.samples) return { scale: state.scale, streak };

  const want = snap(state.scale + dir * rule.step, rule.step);
  return { scale: clamp(want, rule.min, max), streak: 0 };
}

/** Snap to the step grid (0.05 grid → two decimals). */
function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
