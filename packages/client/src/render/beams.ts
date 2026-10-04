import * as THREE from 'three';
import { forceFieldTime } from './forcefield.js';

/** Meshes TA draws as soft light shafts / exhaust plumes (additive cones) rather than as solid glowing shells. */
export const BEAM_MESH = /thruster_?smoke|light_?beam|spot_?light_?beam|light_?shaft|light_?cone|dust_?beam|_beam_/i;

/**
 * Where a cone narrows: object-space y of its narrow end and its wide end (shafts fade out toward the wide end).
 * Null when the mesh is not a long y-aligned cone.
 */
export function coneAxis(positions: Float32Array): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < positions.length; i += 3) { lo = Math.min(lo, positions[i]); hi = Math.max(hi, positions[i]); }
  const len = hi - lo;
  if (!(len > 0)) return null;
  let rLo = 0, nLo = 0, rHi = 0, nHi = 0, wide = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const r = Math.hypot(positions[i], positions[i + 2]);
    wide = Math.max(wide, r);
    if (positions[i + 1] < lo + len * 0.15) { rLo += r; nLo++; }
    if (positions[i + 1] > hi - len * 0.15) { rHi += r; nHi++; }
  }
  if (len < wide * 1.2 || !nLo || !nHi) return null;
  return rLo / nLo < rHi / nHi ? [lo, hi] : [hi, lo];
}

const cache = new Map<string, THREE.ShaderMaterial>();

/**
 * A soft, additive light shaft: bright at the source, fading along its length and toward its silhouette (so it reads
 * as a volume, not a glass shell), with slow drifting streaks. `map` (TA's dust panner) modulates the streaks.
 */
export function beamMaterial(key: string, axis: [number, number] | null, tint: number, map?: THREE.Texture | null): THREE.ShaderMaterial {
  let m = cache.get(key);
  if (m) { if (map && !m.uniforms.map.value) { m.uniforms.map.value = map; m.uniforms.hasMap.value = 1; } return m; }
  m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: {
      uTime: forceFieldTime, uColor: { value: new THREE.Color(tint) }, uAxis: { value: new THREE.Vector2(axis?.[0] ?? 0, axis?.[1] ?? 1) },
      uFade: { value: axis ? 1 : 0 }, map: { value: map ?? null }, hasMap: { value: map ? 1 : 0 },
    },
    vertexShader: `
      uniform vec2 uAxis;
      varying vec3 vN; varying vec3 vV; varying float vH; varying vec2 vUv; varying vec3 vObj;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vec4 mv = viewMatrix * (m * vec4(position, 1.0));
        vN = normalize(mat3(viewMatrix) * (mat3(m) * normal));
        vV = normalize(-mv.xyz);
        vH = clamp((position.y - uAxis.x) / (uAxis.y - uAxis.x + 1e-5), 0.0, 1.0);
        vUv = uv; vObj = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uFade; uniform sampler2D map; uniform float hasMap;
      varying vec3 vN; varying vec3 vV; varying float vH; varying vec2 vUv; varying vec3 vObj;
      void main() {
        float f = abs(dot(normalize(vN), normalize(vV)));
        float edge = pow(f, 1.5);
        float along = mix(1.0, (1.0 - vH) * (1.0 - vH), uFade);
        float flow = 0.7 + 0.3 * sin(vObj.y * 1.3 - uTime * 3.0 + sin(vObj.x * 2.1 + vObj.z * 1.7) * 2.0);
        if (hasMap > 0.5) {
          vec3 t = texture2D(map, vUv + vec2(uTime * 0.05, uTime * 0.12)).rgb;
          flow = 0.35 + 1.1 * dot(t, vec3(0.3, 0.59, 0.11));
        }
        float a = edge * along * flow * 0.5;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
  cache.set(key, m);
  return m;
}

export function disposeBeams() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
