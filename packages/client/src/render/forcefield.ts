import * as THREE from 'three';

/** Shared clock for every force-field surface (advanced once per frame by the world view). */
export const forceFieldTime = { value: 0 };

const cache = new Map<string, THREE.ShaderMaterial>();

/**
 * Translucent energy surface like TA's base/deployable force fields: additive, fresnel-bright edges,
 * a scrolling hex lattice and slow interference bands. `instanced` reads per-instance colour as the team tint.
 */
export function forceFieldMaterial(color: number, instanced = false, strength = 1): THREE.ShaderMaterial {
  const key = `${color}|${instanced}|${strength}`;
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: true,
    defines: instanced ? { FF_INSTANCED: '' } : {},
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vTint;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normal;
        vTint = vec3(1.0);
        #ifdef USE_INSTANCING
          wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          n = mat3(instanceMatrix) * n;
        #endif
        #if defined(FF_INSTANCED) && defined(USE_INSTANCING_COLOR)
          vTint = instanceColor;
        #endif
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * n);
        vView = cameraPosition - wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uColor; uniform float uTime; uniform float uStrength;
      varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vTint;
      float hexEdge(vec2 p) {
        p *= vec2(1.0, 1.1547);
        p.x += mod(floor(p.y), 2.0) * 0.5;
        vec2 f = abs(fract(p) - 0.5);
        return smoothstep(0.42, 0.5, max(f.x * 1.5 + f.y, f.y * 2.0));
      }
      void main() {
        vec3 V = normalize(vView);
        float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 2.2);
        vec2 uv = vec2(vWorld.x + vWorld.z, vWorld.y) * 0.9;
        float hex = hexEdge(uv + vec2(0.0, uTime * 0.15));
        float band = 0.5 + 0.5 * sin(vWorld.y * 3.0 - uTime * 2.2 + sin(vWorld.x * 0.7 + uTime) * 0.8);
        float flicker = 0.92 + 0.08 * sin(uTime * 17.0 + vWorld.x * 3.1);
        float a = (0.07 + fres * 0.55 + hex * 0.16 + band * 0.06) * flicker * uStrength;
        vec3 col = uColor * vTint;
        gl_FragColor = vec4(col * a * 1.6, a);
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor *= 1.0 - fogFactor;
        #endif
      }`,
  });
  m.uniforms.uTime = forceFieldTime;
  cache.set(key, m);
  return m;
}
