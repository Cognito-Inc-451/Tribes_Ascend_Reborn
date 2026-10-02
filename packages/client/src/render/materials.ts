import * as THREE from 'three';
import type { ArmorSkin, SkinPattern } from '@ar/shared';

/** MeshStandardMaterial with world-space procedural grime/detail so untextured geometry does not look flat. */
export function surfaceMaterial(color: number, opts: { roughness?: number; metalness?: number; detail?: number; scale?: number; emissive?: number; vertexColors?: boolean; flat?: boolean; transparent?: boolean; opacity?: number; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0.05, vertexColors: opts.vertexColors ?? false,
    flatShading: opts.flat ?? false, emissive: opts.emissive ?? 0x000000, transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  const detail = opts.detail ?? 0.18, scale = opts.scale ?? 0.35;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detail };
    sh.uniforms.uScale = { value: scale };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          wn = mat3(instanceMatrix) * wn;
        #endif
        vWPos = (modelMatrix * wp).xyz;
        vWNrm = normalize(mat3(modelMatrix) * wn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        uniform float uDetail;
        uniform float uScale;
        float h3(vec3 p){ p = fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        float vn(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
          return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float n = vn(vWPos*uScale)*0.55 + vn(vWPos*uScale*4.1)*0.3 + vn(vWPos*uScale*13.0)*0.15;
        float ao = mix(1.0, 0.82, smoothstep(0.2, -0.6, vWNrm.y));
        diffuseColor.rgb *= (1.0 - uDetail*0.5 + n*uDetail) * ao;`);
  };
  return m;
}

const MAT_COLORS: Record<string, { color: number; rough: number; metal: number; detail?: number; emissive?: number; transparent?: boolean; opacity?: number }> = {
  concrete: { color: 0x8c8f93, rough: 0.9, metal: 0.05 },
  metal: { color: 0x7d858e, rough: 0.5, metal: 0.6 },
  floor: { color: 0x6d7278, rough: 0.7, metal: 0.3 },
  roof: { color: 0x74797f, rough: 0.8, metal: 0.2 },
  trim: { color: 0x3c424a, rough: 0.5, metal: 0.6 },
  pad: { color: 0x565c63, rough: 0.6, metal: 0.4 },
  rock: { color: 0x6f6a62, rough: 0.95, metal: 0, detail: 0.35 },
  ice: { color: 0xbfd8ea, rough: 0.25, metal: 0.1, detail: 0.1 },
  crystal: { color: 0x9ad0c8, rough: 0.3, metal: 0.1, emissive: 0x102820 },
  wood: { color: 0x5a4632, rough: 0.9, metal: 0 },
  leaves: { color: 0x3e6a2e, rough: 0.9, metal: 0, detail: 0.4 },
  glass: { color: 0x88aacc, rough: 0.1, metal: 0.3, transparent: true, opacity: 0.35 },
  forcefield: { color: 0x66ccff, rough: 0.2, metal: 0, emissive: 0x2288cc, transparent: true, opacity: 0.35 },
  water: { color: 0x2a5a7a, rough: 0.15, metal: 0.1, transparent: true, opacity: 0.8 },
  lava: { color: 0xff5a1a, rough: 0.6, metal: 0, emissive: 0xff3300 },
};

const cache = new Map<string, THREE.MeshStandardMaterial>();

export function matFor(tag: string, themeStructure?: number, tint?: number): THREE.MeshStandardMaterial {
  const key = `${tag}:${themeStructure ?? ''}:${tint ?? ''}`;
  let m = cache.get(key);
  if (m) return m;
  const d = MAT_COLORS[tag] ?? MAT_COLORS.concrete;
  let color = d.color;
  if (themeStructure !== undefined && ['concrete', 'roof', 'floor'].includes(tag)) color = new THREE.Color(themeStructure).lerp(new THREE.Color(d.color), 0.4).getHex();
  if (tint !== undefined) color = new THREE.Color(color).lerp(new THREE.Color(tint), 0.35).getHex();
  m = surfaceMaterial(color, { roughness: d.rough, metalness: d.metal, detail: d.detail, emissive: d.emissive, transparent: d.transparent, opacity: d.opacity, flat: true, side: d.transparent ? THREE.DoubleSide : THREE.FrontSide });
  cache.set(key, m);
  return m;
}

export function clearMaterialCache() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

/** Canvas-generated pattern texture for armour skins / weapon finishes. */
export function patternTexture(pattern: SkinPattern, base: number, secondary: number, scale = 1, seed = 1): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  g.fillStyle = hex(base);
  g.fillRect(0, 0, size, size);
  g.fillStyle = hex(secondary);
  g.strokeStyle = hex(secondary);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const step = 16 / scale;
  switch (pattern) {
    case 'camo':
      for (let i = 0; i < 26; i++) { g.beginPath(); g.ellipse(rnd() * size, rnd() * size, 6 + rnd() * 18, 4 + rnd() * 10, rnd() * 3, 0, Math.PI * 2); g.fill(); }
      break;
    case 'plating':
      g.lineWidth = 2;
      for (let y = 0; y < size; y += step * 2) for (let x = 0; x < size; x += step * 2) g.strokeRect(x + 1, y + 1, step * 2 - 2, step * 2 - 2);
      break;
    case 'hex':
      g.lineWidth = 1.5;
      for (let y = 0; y < size + step; y += step * 0.87) for (let x = 0; x < size + step; x += step * 1.5) {
        const ox = (Math.round(y / (step * 0.87)) % 2) * step * 0.75;
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.lineTo(x + ox + Math.cos(a) * step * 0.5, y + Math.sin(a) * step * 0.5); }
        g.closePath(); g.stroke();
      }
      break;
    case 'stripes':
      for (let x = -size; x < size * 2; x += step * 1.5) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + size, size); g.lineWidth = step * 0.5; g.stroke(); }
      break;
    case 'glyph':
      g.lineWidth = 2;
      for (let i = 0; i < 14; i++) {
        const x = rnd() * size, y = rnd() * size;
        g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 3; k++) g.lineTo(x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20);
        g.stroke();
      }
      break;
    case 'digital':
      for (let y = 0; y < size; y += 8) for (let x = 0; x < size; x += 8) if (rnd() < 0.35) g.fillRect(x, y, 8, 8);
      break;
    case 'circuit':
      g.lineWidth = 1.5;
      for (let i = 0; i < 18; i++) {
        let x = Math.floor(rnd() * 16) * 8, y = Math.floor(rnd() * 16) * 8;
        g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 4; k++) { if (rnd() < 0.5) x += (rnd() < 0.5 ? -1 : 1) * 16; else y += (rnd() < 0.5 ? -1 : 1) * 16; g.lineTo(x, y); }
        g.stroke();
        g.fillRect(x - 2, y - 2, 4, 4);
      }
      break;
    default:
      for (let i = 0; i < 40; i++) { g.globalAlpha = 0.15; g.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 6, 1 + rnd() * 3); }
      g.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const skinCache = new Map<string, THREE.MeshStandardMaterial>();
export function skinMaterial(skin: ArmorSkin): THREE.MeshStandardMaterial {
  let m = skinCache.get(skin.id);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    map: patternTexture(skin.pattern, skin.base, skin.secondary, skin.patternScale, skin.id.length),
    roughness: skin.material === 'metal' ? 0.45 : skin.material === 'weathered' ? 0.8 : 0.7,
    metalness: skin.material === 'metal' ? 0.55 : 0.15,
  });
  skinCache.set(skin.id, m);
  return m;
}
