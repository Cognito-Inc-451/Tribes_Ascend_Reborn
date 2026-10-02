import * as THREE from 'three';
import { isForceFieldMesh, THEMES, type MapData, type Theme } from '@ar/shared';
import { settings } from '../settings.js';
import { forceFieldMaterial, forceFieldTime } from './forcefield.js';
import { matFor, surfaceMaterial } from './materials.js';
import type { TextureStore } from './textures.js';

const TEAM_TINT = [0xc0503a, 0x3a70c0];
const FIELD_TINT = [0xff5a3c, 0x4fa8ff];
const ROOF_CELL = 4;
const WEATHER_BOX = 120;
const wrap = (v: number, c: number) => c + ((((v - c) % WEATHER_BOX) + WEATHER_BOX * 1.5) % WEATHER_BOX) - WEATHER_BOX / 2;

/** computeVertexNormals yields NaN on degenerate triangles; NaNs poison lighting and smear black blocks through bloom. */
export function safeNormals(g: THREE.BufferGeometry) {
  g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const a = n.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) {
    if (!(Number.isFinite(a[i]) && Number.isFinite(a[i + 1]) && Number.isFinite(a[i + 2])) || a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2] < 1e-8) {
      a[i] = 0; a[i + 1] = 1; a[i + 2] = 0;
    }
  }
  n.needsUpdate = true;
}

/** Highest visible surface above each 4 m cell (meshes + BSP, not terrain). Used for indoor-aware weather and the minimap. */
export interface RoofGrid { originX: number; originZ: number; nx: number; nz: number; cell: number; top: Float32Array }

export class WorldView {
  readonly group = new THREE.Group();
  readonly theme: Theme;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  roof: RoofGrid | null = null;
  private sunDir: THREE.Vector3;
  private sky: THREE.Mesh;
  private weather: THREE.Points | null = null;
  private weatherOffsets: Float32Array | null = null;
  private weatherVel = new THREE.Vector3();
  private hazard: THREE.Mesh | null = null;
  private texMats = new Map<number, THREE.MeshStandardMaterial>();

  constructor(readonly map: MapData, private scene: THREE.Scene, private textures: TextureStore | null = null) {
    this.theme = THEMES[map.theme] ?? THEMES.alpine;
    const t = this.theme, env = map.env;
    const fogColor = env?.fogColor ?? t.fog;
    scene.background = new THREE.Color(env?.fogColor ?? t.skyHorizon);
    const fogDensity = env?.fogDensity !== undefined ? THREE.MathUtils.clamp(env.fogDensity * 0.03, 0.00025, 0.0025) : t.fogDensity;
    scene.fog = new THREE.FogExp2(fogColor, fogDensity * (1400 / Math.max(600, settings.viewDistance)));

    const ambient = env?.ambientColor ?? t.ambient;
    this.hemi = new THREE.HemisphereLight(ambient, map.source === 'original' ? 0x6a665e : t.grass, t.ambientIntensity * (map.source === 'original' ? 1.05 : 1));
    this.group.add(this.hemi);
    this.sunDir = env?.sunDir ? new THREE.Vector3(env.sunDir.x, Math.max(0.15, env.sunDir.y), env.sunDir.z).normalize() : new THREE.Vector3(...t.sunDir).normalize();
    const sunInt = t.sunIntensity * (env?.sunIntensity !== undefined ? THREE.MathUtils.clamp(env.sunIntensity, 0.6, 1.5) : 1);
    this.sun = new THREE.DirectionalLight(env?.sunColor ?? t.sun, sunInt);
    this.sun.position.copy(this.sunDir).multiplyScalar(400);
    if (settings.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(settings.quality === 'ultra' ? 4096 : 2048, settings.quality === 'ultra' ? 4096 : 2048);
      const c = this.sun.shadow.camera;
      c.left = -120; c.right = 120; c.top = 120; c.bottom = -120; c.near = 1; c.far = 1200;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
      // UE3-style shadows keep sky/bounce light: a shadowed surface loses ~45% of direct sun, not all of it.
      this.sun.shadow.intensity = 0.55;
    }
    this.group.add(this.sun, this.sun.target);

    this.sky = this.buildSky(fogColor);
    this.group.add(this.sky);
    this.group.add(this.buildTerrain());
    for (const m of this.buildBoxes()) this.group.add(m);
    for (const m of this.buildMeshes()) this.group.add(m);
    if (t.hazard && map.source === 'reborn') this.buildHazard(t.hazard.kind, t.hazard.level);
    this.roof = this.buildRoofGrid();
    const weather = map.source === 'original' ? (env?.snow ? 'snow' : t.weather) : t.weather;
    if (settings.weather && weather && weather !== 'none') this.buildWeather(weather);
    scene.add(this.group);
  }

  private buildSky(fogColor: number): THREE.Mesh {
    const t = this.theme;
    const horizon = new THREE.Color(t.skyHorizon).lerp(new THREE.Color(fogColor), this.map.env?.fogColor !== undefined ? 0.6 : 0);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(t.skyTop) }, horizon: { value: horizon }, sunDir: { value: this.sunDir.clone() }, sunCol: { value: new THREE.Color(this.map.env?.sunColor ?? t.sun) }, night: { value: t.night ? 1 : 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
      fragmentShader: `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; uniform float night;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          float a=h(vec3(i,0.0)), b=h(vec3(i+vec2(1,0),0.0)), c=h(vec3(i+vec2(0,1),0.0)), d=h(vec3(i+vec2(1,1),0.0));
          return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
        void main(){ float y = max(vDir.y, 0.0); vec3 c = mix(horizon, top, pow(y, 0.55));
          vec2 uv = vDir.xz / max(0.12, vDir.y) * 1.6;
          float cl = n2(uv) * 0.55 + n2(uv * 2.7) * 0.3 + n2(uv * 7.0) * 0.15;
          c = mix(c, mix(horizon, vec3(1.0), 0.6), smoothstep(0.55, 0.85, cl) * smoothstep(0.02, 0.25, vDir.y) * (1.0 - night) * 0.55);
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += sunCol * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.25);
          if (night > 0.5) { vec3 q = floor(vDir * 420.0); float st = step(0.9975, h(q)) * smoothstep(0.0, 0.3, vDir.y); c += vec3(st); }
          if (vDir.y < 0.0) c = mix(horizon, horizon * 0.6, min(1.0, -vDir.y * 4.0));
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), mat);
    m.frustumCulled = false;
    m.renderOrder = -1;
    return m;
  }

  private buildTerrain(): THREE.Mesh {
    const T = this.map.terrain, t = this.theme;
    const textured = !!this.textures && !!this.map.terrainLayers?.some((l) => l.tex >= 0);
    const snowy = !!this.map.env?.snow;
    const step = settings.quality === 'low' ? 2 : 1;
    const nx = Math.floor((T.resX - 1) / step) + 1, nz = Math.floor((T.resZ - 1) / step) + 1;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    let lo = Infinity, hi = -Infinity;
    for (const h of T.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
    const range = Math.max(1, hi - lo);
    const cg = new THREE.Color(t.grass), cr = new THREE.Color(t.rock), cs = new THREE.Color(t.snow), ca = new THREE.Color(t.sand);
    const c = new THREE.Color();
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const si = Math.min(T.resX - 1, i * step), sj = Math.min(T.resZ - 1, j * step);
      const x = T.originX + si * T.cellX, z = T.originZ + sj * T.cellZ, y = T.sample(si, sj);
      const k = (j * nx + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const n = T.normalAt(x, z);
      if (textured) {
        // Textures carry the colour; vertex colour adds snow on flats (snow maps) and slope shading.
        c.setRGB(1, 1, 1);
        if (snowy) c.lerp(cs, 0.55 * THREE.MathUtils.smoothstep(n.y, 0.78, 0.93));
        c.multiplyScalar(0.9 + 0.1 * n.y);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
        continue;
      }
      const hf = (y - lo) / range;
      const noise = Math.sin(x * 0.05) * Math.cos(z * 0.043) * 0.5 + 0.5;
      c.copy(cg);
      if (hf < 0.12) c.lerp(ca, 0.6 * (1 - hf / 0.12));
      c.lerp(cr, THREE.MathUtils.smoothstep(1 - n.y, 0.18, 0.42));
      if (hf > t.snowLine) c.lerp(cs, THREE.MathUtils.smoothstep(hf, t.snowLine, t.snowLine + 0.1) * THREE.MathUtils.smoothstep(n.y, 0.55, 0.8));
      c.multiplyScalar(0.9 + noise * 0.2);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    const idx: number[] = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      if (T.holes) {
        let hole = false;
        for (let dj = 0; dj < step && !hole; dj++) for (let di = 0; di < step && !hole; di++) {
          const si = i * step + di, sj = j * step + dj;
          if (si < T.resX && sj < T.resZ && T.holes[sj * T.resX + si]) hole = true;
        }
        if (hole) continue;
      }
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(nx * nz > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const mat = textured ? this.terrainMaterial() : surfaceMaterial(0xffffff, { vertexColors: true, roughness: 0.95, detail: 0.28, scale: 0.12 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Splat-blended terrain: up to five imported layers, each tiled at its original mapping scale. */
  private terrainMaterial(): THREE.MeshStandardMaterial {
    const T = this.map.terrain, layers = this.map.terrainLayers!.slice(0, 5);
    const N = layers.length;
    const blank = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
    let splatTex: THREE.DataTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    if (this.map.terrainSplat && this.map.terrainSplat.length === T.resX * T.resZ * 4) {
      splatTex = new THREE.DataTexture(this.map.terrainSplat as Uint8Array<ArrayBuffer>, T.resX, T.resZ, THREE.RGBAFormat);
      splatTex.magFilter = THREE.LinearFilter; splatTex.minFilter = THREE.LinearFilter;
    }
    splatTex.needsUpdate = true;
    const uniforms = {
      tL: { value: layers.map(() => blank as THREE.Texture) }, tSplat: { value: splatTex },
      uScale: { value: layers.map((l) => 1 / Math.max(1, l.scale)) }, uHas: { value: layers.map(() => 0) },
      uSplat: { value: new THREE.Vector4(T.originX, T.originZ, 1 / (T.cellX * T.resX), 1 / (T.cellZ * T.resZ)) },
      uCellOff: { value: new THREE.Vector2(0.5 / T.resX, 0.5 / T.resZ) },
    };
    layers.forEach((l, i) => {
      const name = l.tex >= 0 ? this.map.textures?.[l.tex] : undefined;
      if (!name) return;
      void this.textures!.get(name).then((tx) => { if (tx) { uniforms.tL.value[i] = tx; uniforms.uHas.value[i] = 1; } });
    });
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0 });
    const ch = ['r', 'g', 'b', 'a'];
    const blend = layers.map((_, i) => `{
        vec3 a = texture2D(tL[${i}], vTXZ * uScale[${i}]).rgb;
        vec3 b = texture2D(tL[${i}], vTXZ * uScale[${i}] * 0.21).rgb;
        vec3 li = mix(a, mix(a, b, 0.5), far);
        ${i === 0 ? 'tc = mix(tc, li, uHas[0]);' : `tc = mix(tc, li, w.${ch[i - 1]} * uHas[${i}]);`}
      }`).join('\n');
    m.customProgramCacheKey = () => `terrain-splat-${N}`;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTXZ;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvTXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vTXZ;
          uniform sampler2D tL[${N}];
          uniform sampler2D tSplat;
          uniform float uScale[${N}];
          uniform float uHas[${N}];
          uniform vec4 uSplat;
          uniform vec2 uCellOff;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec4 w = texture2D(tSplat, (vTXZ - uSplat.xy) * uSplat.zw + uCellOff);
          float far = smoothstep(60.0, 260.0, length(vTXZ - cameraPosition.xz));
          vec3 tc = vec3(0.6);
          ${blend}
          diffuseColor.rgb *= tc * 1.15;`);
    };
    return m;
  }

  private buildBoxes(): THREE.InstancedMesh[] {
    const groups = new Map<string, number[]>();
    this.map.boxes.forEach((b, i) => { const arr = groups.get(b.mat) ?? []; arr.push(i); groups.set(b.mat, arr); });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const out: THREE.InstancedMesh[] = [];
    const m4 = new THREE.Matrix4();
    for (const [mat, list] of groups) {
      const im = new THREE.InstancedMesh(geo, matFor(mat, this.theme.structure), list.length);
      list.forEach((bi, k) => {
        const b = this.map.boxes[bi], a = b.axes, h = b.h;
        m4.set(a[0] * h[0] * 2, a[3] * h[1] * 2, a[6] * h[2] * 2, b.c.x, a[1] * h[0] * 2, a[4] * h[1] * 2, a[7] * h[2] * 2, b.c.y, a[2] * h[0] * 2, a[5] * h[1] * 2, a[8] * h[2] * 2, b.c.z, 0, 0, 0, 1);
        im.setMatrixAt(k, m4);
      });
      im.castShadow = mat !== 'leaves';
      im.receiveShadow = true;
      im.computeBoundingSphere();
      out.push(im);
    }
    return out;
  }

  /** One shared material per imported texture; the texture streams in after the world is visible. */
  private texMaterial(tex: number, tint: string): THREE.MeshStandardMaterial {
    let m = this.texMats.get(tex);
    if (m) return m;
    const mm = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.86, metalness: 0.04, side: THREE.DoubleSide });
    this.texMats.set(tex, mm);
    const name = this.map.textures?.[tex];
    if (name && this.textures) {
      void this.textures.get(name).then((tx) => {
        if (!tx) return;
        mm.map = tx;
        if (tx.userData.packed) {
          // Channel-packed mask: use its luminance as detail over the surface colour.
          mm.color.set(matFor(tint).color).multiplyScalar(1.5);
          mm.customProgramCacheKey = () => 'packed-luminance';
          mm.onBeforeCompile = (sh) => {
            sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
              '#ifdef USE_MAP\n vec4 sdc = texture2D(map, vMapUv); diffuseColor.rgb *= vec3(dot(sdc.rgb, vec3(0.3, 0.59, 0.11))) * 1.2;\n#endif');
          };
        } else mm.color.setRGB(1, 1, 1);
        mm.needsUpdate = true;
      });
    }
    return mm;
  }

  private buildMeshes(): THREE.InstancedMesh[] {
    const { meshes, instances } = this.map;
    if (!meshes?.length || !instances?.length) return [];
    const byMesh = new Map<number, number[]>();
    instances.forEach((it, i) => { const arr = byMesh.get(it.mesh) ?? []; arr.push(i); byMesh.set(it.mesh, arr); });
    const out: THREE.InstancedMesh[] = [];
    const m4 = new THREE.Matrix4();
    const white = new THREE.Color(1, 1, 1);
    for (const [mi, list] of byMesh) {
      const me = meshes[mi];
      if (me.hidden) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(me.positions, 3));
      g.setIndex(new THREE.BufferAttribute(me.indices, 1));
      safeNormals(g);
      g.computeBoundingSphere();
      if (isForceFieldMesh(me.name)) {
        const im = new THREE.InstancedMesh(g, forceFieldMaterial(0xffffff, true), list.length);
        list.forEach((ii, k) => {
          const m = instances[ii].m;
          m4.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
          im.setMatrixAt(k, m4);
          const team = instances[ii].team;
          im.setColorAt(k, new THREE.Color(team === undefined ? 0x5fc8ff : FIELD_TINT[team]));
        });
        im.computeBoundingSphere();
        out.push(im);
        continue;
      }
      const fallback = matFor(me.mat, this.theme.structure);
      // Imported instances may be mirrored (negative scale), so render both faces.
      fallback.side = THREE.DoubleSide;
      let material: THREE.Material | THREE.Material[] = fallback;
      if (me.uvs && me.groups?.length && this.textures) {
        g.setAttribute('uv', new THREE.BufferAttribute(me.uvs, 2));
        const mats: THREE.Material[] = [];
        for (const grp of me.groups) {
          g.addGroup(grp.start, grp.count, mats.length);
          mats.push(grp.tex >= 0 ? this.texMaterial(grp.tex, me.mat) : fallback);
        }
        material = mats;
      }
      const im = new THREE.InstancedMesh(g, material, list.length);
      list.forEach((ii, k) => {
        const m = instances[ii].m;
        m4.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
        im.setMatrixAt(k, m4);
        const team = instances[ii].team;
        im.setColorAt(k, team === undefined ? white : new THREE.Color(1, 1, 1).lerp(new THREE.Color(TEAM_TINT[team]), 0.45));
      });
      im.castShadow = settings.quality !== 'medium' && me.mat !== 'leaves';
      im.receiveShadow = true;
      im.computeBoundingSphere();
      out.push(im);
    }
    return out;
  }

  private buildHazard(kind: 'lava' | 'water' | 'acid', level: number) {
    const color = kind === 'lava' ? 0xff5a1a : kind === 'acid' ? 0x9acd32 : 0x2a5a7a;
    const mat = new THREE.MeshStandardMaterial({ color, emissive: kind === 'lava' ? 0xff3300 : 0x000000, emissiveIntensity: kind === 'lava' ? 1.2 : 0, roughness: kind === 'water' ? 0.15 : 0.6, metalness: 0.1, transparent: kind !== 'lava', opacity: 0.85 });
    this.hazard = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), mat);
    this.hazard.rotation.x = -Math.PI / 2;
    this.hazard.position.y = level;
    this.group.add(this.hazard);
  }

  private buildWeather(kind: 'snow' | 'rain' | 'ash' | 'dust') {
    const n = Math.round(3500 * settings.particles);
    const off = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) off[i] = (Math.random() - 0.5) * WEATHER_BOX;
    this.weatherOffsets = off;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const color = kind === 'snow' ? 0xffffff : kind === 'rain' ? 0x9ab0c8 : kind === 'ash' ? 0x555555 : 0xc8a878;
    this.weather = new THREE.Points(g, new THREE.PointsMaterial({ color, size: kind === 'rain' ? 0.08 : 0.16, transparent: true, opacity: 0.8, depthWrite: false }));
    this.weather.frustumCulled = false;
    this.weatherVel.set(kind === 'dust' ? 6 : 1, kind === 'rain' ? -30 : kind === 'snow' ? -3 : -1.5, kind === 'dust' ? 2 : 0.5);
    this.group.add(this.weather);
  }

  /** Rasterise visible geometry tops into a coarse grid (cell centres inside each triangle's XZ footprint). */
  private buildRoofGrid(): RoofGrid | null {
    const { meshes, instances, terrain: T } = this.map;
    if (!meshes?.length || !instances?.length) return null;
    const cell = ROOF_CELL;
    const nx = Math.ceil(T.width / cell), nz = Math.ceil(T.depth / cell);
    if (nx * nz > 4_000_000) return null;
    const top = new Float32Array(nx * nz).fill(-Infinity);
    const ox = T.originX, oz = T.originZ;
    const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const it of instances) {
      const me = meshes[it.mesh];
      if (me.hidden || !me.collide || isForceFieldMesh(me.name)) continue;
      const p = me.positions, I = me.indices, m = it.m;
      for (let t = 0; t < I.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const o = I[t + k] * 3, x = p[o], y = p[o + 1], z = p[o + 2];
          v[k * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
          v[k * 3 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
          v[k * 3 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
        }
        const minX = Math.min(v[0], v[3], v[6]), maxX = Math.max(v[0], v[3], v[6]);
        const minZ = Math.min(v[2], v[5], v[8]), maxZ = Math.max(v[2], v[5], v[8]);
        const i0 = Math.max(0, Math.floor((minX - ox) / cell)), i1 = Math.min(nx - 1, Math.floor((maxX - ox) / cell));
        const j0 = Math.max(0, Math.floor((minZ - oz) / cell)), j1 = Math.min(nz - 1, Math.floor((maxZ - oz) / cell));
        if (i1 < i0 || j1 < j0 || (i1 - i0 + 1) * (j1 - j0 + 1) > 4096) continue;
        if (i0 === i1 && j0 === j1) { const c = j0 * nx + i0, maxY = Math.max(v[1], v[4], v[7]); if (maxY > top[c]) top[c] = maxY; continue; }
        // Barycentric test at cell centres; height interpolated on the triangle plane.
        const ax = v[0], az = v[2], bx = v[3] - ax, bz = v[5] - az, cx = v[6] - ax, cz = v[8] - az;
        const det = bx * cz - bz * cx;
        if (Math.abs(det) < 1e-6) continue;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = ox + (i + 0.5) * cell - ax, pz = oz + (j + 0.5) * cell - az;
          const s = (px * cz - pz * cx) / det, q = (bx * pz - bz * px) / det;
          if (s < -0.05 || q < -0.05 || s + q > 1.05) continue;
          const y = v[1] + s * (v[4] - v[1]) + q * (v[7] - v[1]);
          const c = j * nx + i;
          if (y > top[c]) top[c] = y;
        }
      }
    }
    return { originX: ox, originZ: oz, nx, nz, cell, top };
  }

  /** Height of the highest structure above (x, z), or -Infinity. */
  roofAt(x: number, z: number): number {
    const r = this.roof;
    if (!r) return -Infinity;
    const i = Math.floor((x - r.originX) / r.cell), j = Math.floor((z - r.originZ) / r.cell);
    if (i < 0 || j < 0 || i >= r.nx || j >= r.nz) return -Infinity;
    return r.top[j * r.nx + i];
  }

  update(cam: THREE.Camera, dt: number, focus: THREE.Vector3) {
    forceFieldTime.value += dt;
    this.sky.position.copy(cam.position);
    if (this.sun.castShadow) {
      // Snap the shadow frustum to whole shadow-map texels in light space so shadows do not swim as the player moves.
      const sc = this.sun.shadow.camera, texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
      const lightRot = new THREE.Matrix4().lookAt(this.sunDir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
      const inv = lightRot.clone().invert();
      const ls = focus.clone().applyMatrix4(inv);
      ls.x = Math.round(ls.x / texel) * texel; ls.y = Math.round(ls.y / texel) * texel;
      const snapped = ls.applyMatrix4(lightRot);
      this.sun.position.copy(snapped).addScaledVector(this.sunDir, 500);
      this.sun.target.position.copy(snapped);
    }
    if (this.weather && this.weatherOffsets) {
      // Particles live in world space and are wrapped into a box around the camera.
      const p = this.weather.geometry.getAttribute('position') as THREE.BufferAttribute;
      const a = p.array as Float32Array, w = this.weatherOffsets;
      const v = this.weatherVel, cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      const T = this.map.terrain;
      for (let i = 0; i < w.length; i += 3) {
        const wx = wrap(w[i] + v.x * dt, cx), wy = wrap(w[i + 1] + v.y * dt, cy), wz = wrap(w[i + 2] + v.z * dt, cz);
        w[i] = wx; w[i + 1] = wy; w[i + 2] = wz;
        const sheltered = wy < this.roofAt(wx, wz) + 0.3 || (!T.isHole(wx, wz) && wy < T.heightAt(wx, wz));
        a[i] = wx; a[i + 1] = sheltered ? -1e5 : wy; a[i + 2] = wz;
      }
      p.needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    for (const m of this.texMats.values()) m.dispose();
  }
}
