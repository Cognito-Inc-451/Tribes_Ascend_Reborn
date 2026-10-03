import * as THREE from 'three';

/**
 * UE3 ExponentialHeightFog for every fogged material: density falls off with height (valleys fill, peaks clear),
 * integrated along the view ray, capped at a max opacity, with inscattering that brightens toward the sun.
 * The uniforms are shared objects, so one update per frame reaches every program.
 */
export const FOG_UNIFORMS = {
  /** x: fog base height (m), y: height falloff (1/m, 0 = plain exp2 fog), z: max opacity, w: start distance (m). */
  fogHeight: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** xyz: direction towards the sun, w: inscattering exponent. */
  fogSun: { value: new THREE.Vector4(0, 1, 0, 8) },
  /** Linear colour added to the fog when looking toward the sun (volumetric sun glow). */
  fogSunColor: { value: new THREE.Color(0, 0, 0) },
};

/** Materials with their own onBeforeCompile must call this to receive the height-fog uniforms. */
export function withFog(shader: { uniforms: Record<string, THREE.IUniform> }) {
  Object.assign(shader.uniforms, FOG_UNIFORMS);
}

let installed = false;
export function installHeightFog() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  // View matrices are rigid, so world = camera + R^T * view-space position (no per-vertex inverse).
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  uniform vec4 fogHeight;
  uniform vec4 fogSun;
  uniform vec3 fogSunColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogLen = length(fogRay);
  #ifdef FOG_EXP2
    float fogDist = max(fogLen - fogHeight.w, 0.0);
    float fogH = 1.0;
    if (fogHeight.y > 0.0) {
      float dy = clamp(fogHeight.y * fogRay.y, -60.0, 60.0);
      float lineInt = abs(dy) > 0.001 ? (1.0 - exp(-dy)) / dy : 1.0 - 0.5 * dy;
      fogH = exp(-clamp(fogHeight.y * (cameraPosition.y - fogHeight.x), -60.0, 60.0)) * lineInt;
    }
    float fogFactor = 1.0 - exp(- fogDensity * fogDensity * fogDist * fogDist * fogH);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  fogFactor = min(fogFactor, fogHeight.z > 0.0 ? fogHeight.z : 1.0);
  vec3 fogCol = fogColor + fogSunColor * pow(max(dot(fogRay / max(fogLen, 1e-3), fogSun.xyz), 0.0), fogSun.w);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
#endif`;
  // Every built-in and shader material gets the shared uniforms unless it installs its own hook (those call withFog).
  (THREE.Material.prototype as unknown as { onBeforeCompile: (s: { uniforms: Record<string, THREE.IUniform> }) => void }).onBeforeCompile = withFog;
}
