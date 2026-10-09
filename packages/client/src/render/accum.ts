import * as THREE from 'three';
import type { Heightfield, Theme } from '@ar/shared';

export type AccumKind = 'snow' | 'rain' | 'ash' | 'dust' | 'none';

/**
 * Weather accumulation: snow/ash/dust film and rain wetness that build on
 * horizontal surfaces while the weather runs and melt off when it stops.
 *
 * The state is a pair of scalars integrated on the CPU and published through
 * these shared uniform objects, so one per-frame step drives every surface in
 * the world without adding materials to the surface cache.
 */
interface Film {
  color: number;
  /** Seconds of this weather needed for full coverage. */
  fill: number;
  /** Seconds without weather needed to melt off. */
  melt: number;
  /** Peak coverage the film reaches (ash/dust never bury the terrain). */
  cover: number;
}

const FILMS: Record<'snow' | 'ash' | 'dust', Film> = {
  snow: { color: 0xeef3f8, fill: 90, melt: 150, cover: 0.9 },
  ash: { color: 0x40383a, fill: 120, melt: 120, cover: 0.6 },
  dust: { color: 0xc8a878, fill: 150, melt: 110, cover: 0.45 },
};

/** Rain darkens and glossifies surfaces instead of covering them. */
const WET_FILL = 25;
const WET_DRY = 45;

export const ACCUM_UNIFORMS = {
  uAccum: { value: 0 },
  uAccumWet: { value: 0 },
  uAccumColor: { value: new THREE.Color(FILMS.snow.color) },
  uAccumLow: { value: 0 },
  uAccumHigh: { value: 1 },
};

/** Film coverage 0..1, ramped by the active weather. */
let film = 0;
let wet = 0;

/** Tint the film from the map theme and fit the height ramp to the terrain. */
export function applyAccumTheme(theme: Theme, terrain: Heightfield) {
  ACCUM_UNIFORMS.uAccumColor.value.setHex(theme.snow);
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of terrain.heights) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  ACCUM_UNIFORMS.uAccumLow.value = lo;
  // Keep a spread so the ramp is a gradient, not a step.
  ACCUM_UNIFORMS.uAccumHigh.value = hi > lo + 1 ? hi : lo + 1;
}

/** Pick the film colour for the active weather (called once per map). */
export function setAccumKind(kind: AccumKind) {
  const spec = kind === 'snow' || kind === 'ash' || kind === 'dust' ? FILMS[kind] : null;
  ACCUM_UNIFORMS.uAccumColor.value.setHex(spec ? spec.color : FILMS.snow.color);
}

/**
 * Integrate the film and wetness for one frame. A null kind (no weather on
 * this map) is treated like 'none': the existing film melts off.
 */
export function stepAccum(kind: AccumKind | null, dt: number) {
  const spec = kind === 'snow' || kind === 'ash' || kind === 'dust' ? FILMS[kind] : null;
  if (spec) film = Math.min(spec.cover, film + dt / spec.fill);
  else film = Math.max(0, film - dt / FILMS.snow.melt);
  if (kind === 'rain') wet = Math.min(1, wet + dt / WET_FILL);
  else wet = Math.max(0, wet - dt / WET_DRY);
  ACCUM_UNIFORMS.uAccum.value = film;
  ACCUM_UNIFORMS.uAccumWet.value = wet;
}

/** Reset the field (map change). */
export function resetAccum() {
  film = 0;
  wet = 0;
  ACCUM_UNIFORMS.uAccum.value = 0;
  ACCUM_UNIFORMS.uAccumWet.value = 0;
}

/** Uniform declarations + helpers to inject at the fragment `#include <common>`. */
export const ACCUM_FRAG = /* glsl */`
uniform float uAccum;
uniform float uAccumWet;
uniform vec3 uAccumColor;
uniform float uAccumLow;
uniform float uAccumHigh;
float arCover(vec3 arN, float arH) {
  float arFlat = smoothstep(0.62, 0.88, arN.y);
  float arAlt = 0.55 + 0.45 * smoothstep(uAccumLow, uAccumHigh, arH);
  return uAccum * arFlat * arAlt;
}
float arWet(vec3 arN) { return uAccumWet * smoothstep(0.30, 0.95, arN.y); }
`;

/**
 * Coverage + wetness for the `#include <color_fragment>` hook. Declares
 * `arS`/`arW`, which the roughness hook reuses (same main() scope).
 * Substituting AR_NRM/AR_ALT lets the terrain shader feed it its own varyings.
 */
export const ACCUM_APPLY = /* glsl */`
float arS = arCover(AR_NRM, AR_ALT);
float arW = arWet(AR_NRM);
diffuseColor.rgb = mix(diffuseColor.rgb, uAccumColor, arS * 0.85);
diffuseColor.rgb *= 1.0 - arW * 0.45;
`;

/** Wet surfaces are glossy; applied at `#include <roughnessmap_fragment>`. */
export const ACCUM_ROUGH = /* glsl */`
roughnessFactor = mix(roughnessFactor, 0.18, arW);
`;
