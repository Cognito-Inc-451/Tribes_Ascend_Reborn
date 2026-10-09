import * as THREE from 'three';
import type { Heightfield } from '@ar/shared';
import { settings } from '../settings.js';
import { withFog } from './fog.js';
import { forceFieldTime } from './forcefield.js';

/** World-space position varying shared by the liquid shaders (instancing aware). */
const WPOS_VERT = `
  vec4 lqWp = vec4(transformed, 1.0);
  vec3 lqWn = objectNormal;
  #ifdef USE_INSTANCING
    lqWp = instanceMatrix * lqWp;
    lqWn = mat3(instanceMatrix) * lqWn;
  #endif
  vLqPos = (modelMatrix * lqWp).xyz;
  vLqNrm = normalize(mat3(modelMatrix) * lqWn);`;

const NOISE = `
  float lqH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lqN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lqH(i), lqH(i + vec2(1, 0)), f.x), mix(lqH(i + vec2(0, 1)), lqH(i + vec2(1, 1)), f.x), f.y); }`;

let lava: THREE.MeshStandardMaterial | null = null;
/** TA's lava: slowly flowing molten crust with a bright emissive core (blooms with HDR on). */
export function lavaMaterial(): THREE.MeshStandardMaterial {
  if (lava) return lava;
  const m = new THREE.MeshStandardMaterial({ color: 0x2a0d05, roughness: 0.75, metalness: 0, emissive: 0xffffff, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'ta-lava';
  m.onBeforeCompile = (sh) => {
    withFog(sh);
    sh.uniforms.uTime = forceFieldTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;')
      .replace('#include <project_vertex>', `#include <project_vertex>${WPOS_VERT}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;\nuniform float uTime;${NOISE}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec2 lqP = vLqPos.xz * 0.11 + vec2(vLqPos.y * 0.05);
        vec2 lqFlow = vec2(uTime * 0.035, uTime * 0.02);
        float lqV = lqN(lqP + lqFlow) * 0.55 + lqN(lqP * 2.3 - lqFlow * 1.7) * 0.3 + lqN(lqP * 6.1 + lqFlow * 2.9) * 0.15;
        float lqPulse = 0.85 + 0.15 * sin(uTime * 1.3 + lqV * 6.0);
        float lqHot = smoothstep(0.38, 0.72, lqV);
        vec3 lqGlow = mix(vec3(1.6, 0.22, 0.02), vec3(4.2, 1.9, 0.35), lqHot) * lqPulse;
        totalEmissiveRadiance = mix(lqGlow * 0.18, lqGlow, smoothstep(0.25, 0.55, lqV));
        diffuseColor.rgb *= 1.0 - lqHot;`);
  };
  lava = m;
  return m;
}

/**
 * Terrain height field for shoreline foam: one R8 texture per map, texel = (height - min) / (max - min),
 * laid out 1:1 with the terrain grid so the water shader can map a world XZ to a terrain height and
 * derive water depth analytically. Shared by every water surface on the map at any level.
 */
export interface FoamField {
  readonly id: number;
  readonly mask: THREE.DataTexture;
  readonly originX: number;
  readonly originZ: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly minH: number;
  readonly maxH: number;
}

/** A water surface's shoreline context: the map height field plus the surface's own water level. */
export interface WaterFoam {
  readonly field: FoamField;
  readonly level: number;
  /** Half-width of the surf band, in metres. */
  readonly width?: number;
}

const foamFields = new Map<string, FoamField>();
let foamSeq = 0;

/** Bake (and cache) the map's height field. Returns null for degenerate terrain. */
export function buildFoamField(terrain: Heightfield, key: string): FoamField | null {
  const hit = foamFields.get(key);
  if (hit) return hit;
  const resX = terrain.resX, resZ = terrain.resZ;
  if (resX < 2 || resZ < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const h of terrain.heights) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!(hi > lo)) return null;
  const data = new Uint8Array(resX * resZ);
  const inv = 255 / (hi - lo);
  for (let i = 0; i < resX * resZ; i++) {
    // Holes have no terrain under them; read them as deep so no surf line appears there.
    const h = terrain.holes?.[i] ? hi : terrain.heights[i];
    data[i] = Math.max(0, Math.min(255, Math.round((h - lo) * inv)));
  }
  const mask = new THREE.DataTexture(data, resX, resZ, THREE.RedFormat, THREE.UnsignedByteType);
  mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
  mask.minFilter = THREE.LinearFilter;
  mask.magFilter = THREE.LinearFilter;
  mask.generateMipmaps = false;
  mask.unpackAlignment = 1;
  mask.needsUpdate = true;
  const f: FoamField = {
    id: ++foamSeq,
    mask,
    originX: terrain.originX,
    originZ: terrain.originZ,
    cellX: terrain.cellX,
    cellZ: terrain.cellZ,
    minH: lo,
    maxH: hi,
  };
  foamFields.set(key, f);
  return f;
}

/** Shoreline/crest foam helpers injected into the water fragment shader. */
const FOAM_HELPERS = `
float lqWave(vec2 p) {
  return lqN(p * 0.35 + uTime * vec2(0.09, 0.05))
       + 0.5 * lqN(p * 0.9 - uTime * vec2(0.12, 0.07))
       + 0.25 * lqN(p * 2.6 + uTime * 0.2);
}
// Foam amount for a water-plane XZ position: shoreline band plus open-water crests.
float lqFoam(vec2 p) {
#ifdef USE_FOAM
  float lqB = texture2D(uFoamMask, (p - uFoamOrigin) * uFoamTexel + uFoamTexel * 0.5).r * uFoamRange + uFoamMin;
  float lqS = 1.0 - smoothstep(0.0, uFoamWidth, uFoamLevel - lqB);
  float lqWv = lqWave(p);
  return clamp(lqS * (0.35 + 0.65 * smoothstep(0.9, 1.5, lqWv)) + smoothstep(1.2, 1.6, lqWv) * 0.4, 0.0, 1.0);
#else
  return 0.0;
#endif
}
`;

const waters = new Map<string, THREE.MeshStandardMaterial>();
/**
 * Water by quality: low = flat tinted surface, medium = animated wave normals + fresnel, high = also sky reflections
 * (environment map) and, with SSR on, an alpha marker the post chain uses for screen-space reflections.
 */
export function waterMaterial(env: THREE.Texture | null, tint = 0x1d4a5c, foam: WaterFoam | null = null): THREE.MeshStandardMaterial {
  const q = settings.waterQuality, ssr = q === 'high' && settings.ssr && settings.post !== 'off';
  const fk = foam ? `|f${foam.field.id}|${foam.level.toFixed(2)}|${foam.width ?? 0}` : '';
  const key = `${q}|${ssr}|${tint}|${env ? env.uuid : ''}${fk}`;
  let m = waters.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: tint, roughness: q === 'low' ? 0.3 : 0.06, metalness: 0, side: THREE.DoubleSide,
    envMap: q === 'high' ? env : null, envMapIntensity: 1.1,
  });
  m.userData.tint = tint;
  if (q !== 'low') {
    m.customProgramCacheKey = () => `ta-water-${ssr}-${foam ? 1 : 0}`;
    m.onBeforeCompile = (sh) => {
      withFog(sh);
      sh.uniforms.uTime = forceFieldTime;
      if (foam) {
        const img = foam.field.mask.image as { width: number; height: number };
        sh.uniforms.uFoamMask = { value: foam.field.mask };
        sh.uniforms.uFoamOrigin = { value: new THREE.Vector2(foam.field.originX, foam.field.originZ) };
        // World units per mask texel: the field spans cellX * texelCount along X (same for Z).
        sh.uniforms.uFoamTexel = { value: new THREE.Vector2(1 / (foam.field.cellX * img.width), 1 / (foam.field.cellZ * img.height)) };
        sh.uniforms.uFoamRange = { value: foam.field.maxH - foam.field.minH };
        sh.uniforms.uFoamMin = { value: foam.field.minH };
        sh.uniforms.uFoamLevel = { value: foam.level };
        sh.uniforms.uFoamWidth = { value: foam.width ?? 3 };
      }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;')
        .replace('#include <project_vertex>', `#include <project_vertex>${WPOS_VERT}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;\nuniform float uTime;${NOISE}${foam ? `\n#define USE_FOAM 1\nuniform sampler2D uFoamMask;\nuniform vec2 uFoamOrigin, uFoamTexel;\nuniform float uFoamRange, uFoamMin, uFoamLevel, uFoamWidth;` : ''}${FOAM_HELPERS}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // Wave normals for horizontal water; waterfalls keep their geometry normal and get streaks instead.
          float lqFlat = smoothstep(0.6, 0.9, abs(vLqNrm.y));
          vec2 lqW = vLqPos.xz;
          float lqE = 0.35;
          float lqH0 = lqWave(lqW);
          float lqHx = lqWave(lqW + vec2(lqE, 0.0));
          float lqHz = lqWave(lqW + vec2(0.0, lqE));
          vec3 lqWn = normalize(vec3(-(lqHx - lqH0) / lqE * 0.35, 1.0, -(lqHz - lqH0) / lqE * 0.35)) * sign(vLqNrm.y + 1e-4);
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(lqWn, 0.0)).xyz), lqFlat));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float lqFall = 1.0 - smoothstep(0.3, 0.7, abs(vLqNrm.y));
          float lqStreak = lqN(vec2(dot(vLqPos.xz, vec2(0.7, 0.7)) * 1.5, vLqPos.y * 0.25 + uTime * 1.6));
          float lqFallFoam = lqFall * smoothstep(0.55, 0.95, lqStreak);
          float lqFoamV = max(lqFoam(vLqPos.xz), lqFallFoam);
          totalEmissiveRadiance += vec3(0.25, 0.32, 0.36) * lqFallFoam;
          if (lqFoamV > 0.004) {
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.78, 0.82), lqFoamV * 0.85);
            roughnessFactor = mix(roughnessFactor, 0.5, lqFoamV);
            totalEmissiveRadiance += vec3(0.30, 0.36, 0.40) * lqFoamV * 0.35;
          }`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          ${ssr ? 'if (abs(vLqNrm.y) > 0.8 && lqFoam(vLqPos.xz) < 0.3) gl_FragColor.a = 0.0;' : ''}`);
    };
  }
  waters.set(key, m);
  return m;
}

/** Drop cached liquid materials (quality change or map unload). */
export function disposeLiquids() {
  for (const m of waters.values()) m.dispose();
  waters.clear();
  lava?.dispose();
  lava = null;
  for (const f of foamFields.values()) f.mask.dispose();
  foamFields.clear();
}

/**
 * Swap the sky reflection on every cached water material.
 *
 * The map's painted sky dome is loaded (and its IBL baked) *after* the level geometry is built, so water
 * created at load time holds the procedural fallback env. When the baked environment arrives the render
 * target behind the old texture is disposed, and a water shader sampling a disposed texture draws its
 * reflection as black - which is what a sky-domed map like Crossfire showed.
 */
export function refreshWaterEnv(env: THREE.Texture): void {
  for (const m of waters.values()) {
    // Only high-quality water samples the env map; the others must keep envMap null.
    if (m.envMap === null || m.envMap === env) continue;
    m.envMap = env;
    m.needsUpdate = true;
  }
}
