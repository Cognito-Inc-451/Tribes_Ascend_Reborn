import * as THREE from 'three';
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

const waters = new Map<string, THREE.MeshStandardMaterial>();
/**
 * Water by quality: low = flat tinted surface, medium = animated wave normals + fresnel, high = also sky reflections
 * (environment map) and, with SSR on, an alpha marker the post chain uses for screen-space reflections.
 */
export function waterMaterial(env: THREE.Texture | null, tint = 0x1d4a5c): THREE.MeshStandardMaterial {
  const q = settings.waterQuality, ssr = q === 'high' && settings.ssr && settings.post !== 'off';
  const key = `${q}|${ssr}|${tint}|${env ? env.uuid : ''}`;
  let m = waters.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: tint, roughness: q === 'low' ? 0.3 : 0.06, metalness: 0, side: THREE.DoubleSide,
    envMap: q === 'high' ? env : null, envMapIntensity: 1.1,
  });
  if (q !== 'low') {
    m.customProgramCacheKey = () => `ta-water-${ssr}`;
    m.onBeforeCompile = (sh) => {
      withFog(sh);
      sh.uniforms.uTime = forceFieldTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;')
        .replace('#include <project_vertex>', `#include <project_vertex>${WPOS_VERT}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vLqPos;\nvarying vec3 vLqNrm;\nuniform float uTime;${NOISE}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // Wave normals for horizontal water; waterfalls keep their geometry normal and get streaks instead.
          float lqFlat = smoothstep(0.6, 0.9, abs(vLqNrm.y));
          vec2 lqW = vLqPos.xz;
          float lqE = 0.35;
          float lqH0 = lqN(lqW * 0.35 + uTime * vec2(0.09, 0.05)) + 0.5 * lqN(lqW * 0.9 - uTime * vec2(0.12, 0.07)) + 0.25 * lqN(lqW * 2.6 + uTime * 0.2);
          float lqHx = lqN((lqW + vec2(lqE, 0.0)) * 0.35 + uTime * vec2(0.09, 0.05)) + 0.5 * lqN((lqW + vec2(lqE, 0.0)) * 0.9 - uTime * vec2(0.12, 0.07)) + 0.25 * lqN((lqW + vec2(lqE, 0.0)) * 2.6 + uTime * 0.2);
          float lqHz = lqN((lqW + vec2(0.0, lqE)) * 0.35 + uTime * vec2(0.09, 0.05)) + 0.5 * lqN((lqW + vec2(0.0, lqE)) * 0.9 - uTime * vec2(0.12, 0.07)) + 0.25 * lqN((lqW + vec2(0.0, lqE)) * 2.6 + uTime * 0.2);
          vec3 lqWn = normalize(vec3(-(lqHx - lqH0) / lqE * 0.35, 1.0, -(lqHz - lqH0) / lqE * 0.35)) * sign(vLqNrm.y + 1e-4);
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(lqWn, 0.0)).xyz), lqFlat));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float lqFall = 1.0 - smoothstep(0.3, 0.7, abs(vLqNrm.y));
          float lqStreak = lqN(vec2(dot(vLqPos.xz, vec2(0.7, 0.7)) * 1.5, vLqPos.y * 0.25 + uTime * 1.6));
          totalEmissiveRadiance += vec3(0.25, 0.32, 0.36) * lqFall * smoothstep(0.55, 0.95, lqStreak);`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          ${ssr ? 'if (abs(vLqNrm.y) > 0.8) gl_FragColor.a = 0.0;' : ''}`);
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
}
