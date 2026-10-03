import * as THREE from 'three';
import type { Vec3 } from '@ar/shared';
import { settings } from '../settings.js';
import { models } from './models.js';

/** One emitter of an imported TA particle system (see tools/ta-import/src/particles.ts). */
interface FxEmitter {
  kind: 'sprite' | 'beam' | 'trail' | 'mesh';
  tex?: string;
  blend: 'add' | 'alpha' | 'mod';
  sub?: [number, number];
  local?: boolean;
  duration: number;
  loops: number;
  delay?: number;
  rate: number;
  bursts: [number, number][];
  life: [number, number];
  size: [number, number];
  sizeY?: [number, number];
  align?: 'velocity' | 'rect';
  sizeLife?: number[];
  color: [number, number, number];
  alpha: number;
  colorLife?: number[][];
  alphaLife?: number[];
  vel: [number, number, number, number, number, number];
  radial?: [number, number];
  accel?: [number, number, number];
  sphere?: [number, number];
  loc?: [number, number, number, number, number, number];
  rot?: [number, number];
  rotRate?: [number, number];
}
export interface ItemFx { trail?: string; explode?: string; shard?: string; beam?: string; light?: number; boomLight?: number }
interface Manifest { systems: Record<string, FxEmitter[]>; items: Record<string, ItemFx> }

const CAP = 3000;
/** TA particle colours are HDR (often 5-50) and meant for its tone mapper; capped so bloom does not blow out. */
const HDR_SCALE = 1, HDR_MAX = 12;
/** Mesh emitters (fireball shells) drawn as sprites: their scale times a ~2.5 m base mesh. */
const MESH_SIZE = 125;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function sample(curve: number[] | undefined, k: number, def: number): number {
  if (!curve?.length) return def;
  const x = Math.min(1, Math.max(0, k)) * (curve.length - 1), i = Math.floor(x), f = x - i;
  return curve[i] + ((curve[Math.min(curve.length - 1, i + 1)] ?? curve[i]) - curve[i]) * f;
}
function sample3(curve: number[][] | undefined, k: number, def: [number, number, number]): [number, number, number] {
  if (!curve?.length) return def;
  const x = Math.min(1, Math.max(0, k)) * (curve.length - 1), i = Math.floor(x), f = x - i, a = curve[i], b = curve[Math.min(curve.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Camera-facing quads for one texture + blend mode, filled from the CPU each frame. */
class Bucket {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(CAP * 3);
  private col = new Float32Array(CAP * 4);
  private ext = new Float32Array(CAP * 3); // size, rotation, frame
  private vel = new Float32Array(CAP * 4); // velocity, length/width (0 = camera-facing)
  n = 0;
  constructor(tex: THREE.Texture | null, blend: FxEmitter['blend'], sub: [number, number]) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iExt', new THREE.InstancedBufferAttribute(this.ext, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iVel', new THREE.InstancedBufferAttribute(this.vel, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: blend === 'add' ? THREE.AdditiveBlending : blend === 'mod' ? THREE.MultiplyBlending : THREE.NormalBlending,
      premultipliedAlpha: blend === 'mod',
      uniforms: { map: { value: tex }, sub: { value: new THREE.Vector2(sub[0], sub[1]) }, hasMap: { value: tex ? 1 : 0 }, additive: { value: blend === 'add' ? 1 : 0 } },
      vertexShader: `attribute vec3 iPos; attribute vec4 iCol; attribute vec3 iExt; attribute vec4 iVel; uniform vec2 sub; varying vec2 vUv; varying vec2 vQ; varying vec4 vCol;
        void main(){
          vQ = position.xy;
          vec2 q;
          vec3 vv = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
          if (iVel.w > 0.0 && length(vv.xy) > 1e-4) {
            // Streak along the screen-space velocity: width across, length along.
            vec2 d = normalize(vv.xy), n = vec2(-d.y, d.x);
            q = (n * position.x + d * position.y * iVel.w) * iExt.x;
          } else {
            // Camera-facing; a negative w stretches the height (rectangle-aligned sprites).
            float c = cos(iExt.y), s = sin(iExt.y), hy = iVel.w < 0.0 ? -iVel.w : 1.0;
            q = vec2(position.x * c - position.y * hy * s, position.x * s + position.y * hy * c) * iExt.x;
          }
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += q;
          float fr = floor(iExt.z), cols = max(1.0, sub.x);
          vec2 cell = vec2(mod(fr, cols), floor(fr / cols));
          vUv = (vec2(position.x + 0.5, 0.5 - position.y) + cell) / max(vec2(1.0), sub);
          vCol = iCol;
          gl_Position = projectionMatrix * mv;
        }`,
      // TA's particle materials mask their tiling textures with soft round falloffs, and opacity rides on the colour.
      fragmentShader: `uniform sampler2D map; uniform float hasMap; uniform float additive; varying vec2 vUv; varying vec2 vQ; varying vec4 vCol;
        void main(){
          vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
          float edge = 1.0 - smoothstep(0.25, 0.5, length(vQ));
          // Particle textures are intensity masks (some pack one per channel); the particle colour tints them.
          float lum = max(t.r, max(t.g, t.b));
          if (additive > 0.5) gl_FragColor = vec4(vec3(lum) * vCol.rgb * edge, 1.0);
          else gl_FragColor = vec4(vCol.rgb * mix(1.0, lum, 0.5), min(t.a, lum) * vCol.a * edge);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
  push(x: number, y: number, z: number, size: number, rot: number, frame: number, r: number, gg: number, b: number, a: number, vx = 0, vy = 0, vz = 0, aspect = 0) {
    if (this.n >= CAP) return;
    const i = this.n++;
    this.vel[i * 4] = vx; this.vel[i * 4 + 1] = vy; this.vel[i * 4 + 2] = vz; this.vel[i * 4 + 3] = aspect;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = gg; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.ext[i * 3] = size; this.ext[i * 3 + 1] = rot; this.ext[i * 3 + 2] = frame;
  }
  flush() {
    const g = this.mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = this.n;
    for (const k of ['iPos', 'iCol', 'iExt', 'iVel']) (g.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.n = 0;
  }
}

interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number; aspect: number; rot: number; rotRate: number }
interface EmitterState { e: FxEmitter; bucket: string; t: number; spawned: number; burstDone: Set<number>; parts: Particle[]; ox: number; oy: number; oz: number }

/** A playing particle system: an explosion (fire and forget) or a trail that follows its projectile until stopped. */
export class FxHandle {
  emitters: EmitterState[] = [];
  stopped = false;
  constructor(public pos: Vec3, public scale: number, readonly oneShot: boolean, readonly gain = 1) {}
  stop() { this.stopped = true; }
}

/** Imported TA weapon effects (trails, explosions, fractal shards) rendered as textured camera-facing sprites. */
export class TaParticles {
  readonly group = new THREE.Group();
  private manifest: Manifest | null = null;
  private loading: Promise<void> | null = null;
  private buckets = new Map<string, Bucket>();
  private handles: FxHandle[] = [];

  /** Loads the effect manifest from the asset servers; retried later while the servers are not known/reachable yet. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      let answered = false;
      for (const base of models.sources) {
        try {
          const r = await fetch(`${base}/assets/fx/manifest.json`, { signal: AbortSignal.timeout(60000) });
          answered = true;
          if (r.ok) { this.manifest = (await r.json()) as Manifest; return; }
        } catch { /* next */ }
      }
      // Not imported anywhere: stay with the built-in effects. Unreachable or unknown servers: try again later.
      if (!answered) setTimeout(() => { this.loading = null; }, 5000);
    })();
    return this.loading;
  }

  item(id: string): ItemFx | undefined {
    if (!this.manifest) void this.load();
    return this.manifest?.items[id];
  }

  private bucket(e: FxEmitter): string {
    const sub: [number, number] = e.sub ?? [1, 1];
    const key = `${e.tex ?? '-'}|${e.blend}|${sub.join('x')}`;
    if (!this.buckets.has(key)) {
      const b = new Bucket(null, e.blend, sub);
      this.buckets.set(key, b);
      this.group.add(b.mesh);
      if (e.tex) void models.textures?.get(e.tex).then((t) => { if (t) { const m = b.mesh.material as THREE.ShaderMaterial; m.uniforms.map.value = t; m.uniforms.hasMap.value = 1; } });
    }
    return key;
  }

  /** Starts system `key` at `pos`; trails skip the projectile's own mesh emitters (the projectile model draws itself). */
  play(key: string | undefined, pos: Vec3, opts: { trail?: boolean; scale?: number; gain?: number } = {}): FxHandle | null {
    const sys = key ? this.manifest?.systems[key] : undefined;
    if (!sys) return null;
    const h = new FxHandle({ ...pos }, opts.scale ?? 1, !opts.trail, opts.gain ?? 1);
    for (const e of sys) {
      if (e.kind === 'beam' || (opts.trail && e.kind === 'mesh')) continue;
      if (!e.tex && e.kind !== 'mesh') continue;
      h.emitters.push({ e, bucket: this.bucket(e), t: -(e.delay ?? 0), spawned: 0, burstDone: new Set(), parts: [], ox: pos.x, oy: pos.y, oz: pos.z });
    }
    if (!h.emitters.length) return null;
    this.handles.push(h);
    return h;
  }

  private spawn(st: EmitterState, h: FxHandle, n: number) {
    const e = st.e, s = h.scale;
    for (let i = 0; i < n; i++) {
      if (Math.random() > settings.particles) continue;
      let x = 0, y = 0, z = 0;
      if (e.loc) { x = rand(e.loc[0], e.loc[3]); y = rand(e.loc[1], e.loc[4]); z = rand(e.loc[2], e.loc[5]); }
      // Random direction for spheres and radial velocity.
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - u * u);
      const dx = rr * Math.cos(a), dy = u, dz = rr * Math.sin(a);
      if (e.sphere) { const r = rand(e.sphere[0], e.sphere[1]) * Math.cbrt(Math.random()); x += dx * r; y += dy * r; z += dz * r; }
      let vx = rand(e.vel[0], e.vel[3]), vy = rand(e.vel[1], e.vel[4]), vz = rand(e.vel[2], e.vel[5]);
      if (e.radial) { const r = rand(e.radial[0], e.radial[1]); vx += dx * r; vy += dy * r; vz += dz * r; }
      const size = rand(e.size[0], e.size[1]) * (e.kind === 'mesh' ? MESH_SIZE : 1) * s;
      const len = e.sizeY ? rand(e.sizeY[0], e.sizeY[1]) * s : size;
      st.parts.push({
        x: (e.local ? 0 : h.pos.x) + x * s, y: (e.local ? 0 : h.pos.y) + y * s, z: (e.local ? 0 : h.pos.z) + z * s,
        vx: vx * s, vy: vy * s, vz: vz * s, age: 0, life: Math.max(0.02, rand(e.life[0], e.life[1])), size,
        aspect: e.align === 'velocity' ? Math.max(0.05, len / Math.max(1e-3, size)) : e.sizeY ? -Math.max(0.05, len / Math.max(1e-3, size)) : 0,
        rot: e.rot ? rand(e.rot[0], e.rot[1]) * Math.PI * 2 : Math.random() * Math.PI * 2, rotRate: e.rotRate ? rand(e.rotRate[0], e.rotRate[1]) * Math.PI * 2 : 0,
      });
    }
  }

  update(dt: number) {
    for (const h of [...this.handles]) {
      let alive = false;
      // Looping emitters of a one-shot effect (explosion) still run their duration only once.
      const loopsOf = (e: FxEmitter) => (e.loops > 0 ? e.loops : h.oneShot ? 1 : Infinity);
      for (const st of h.emitters) {
        const e = st.e;
        st.t += dt;
        const dur = Math.max(0.01, e.duration);
        const loops = loopsOf(e);
        const emitting = !h.stopped && st.t >= 0 && st.t < dur * loops;
        if (emitting) {
          const lt = st.t % dur, loop = Math.floor(st.t / dur);
          e.bursts.forEach(([count, time], bi) => {
            const id = loop * 64 + bi;
            if (lt >= time * dur && !st.burstDone.has(id)) { st.burstDone.add(id); this.spawn(st, h, count); }
          });
          if (e.rate > 0) {
            const want = Math.floor(st.t * e.rate);
            if (want > st.spawned) { this.spawn(st, h, Math.min(32, want - st.spawned)); st.spawned = want; }
          }
        }
        const b = this.buckets.get(st.bucket)!;
        const ox = e.local ? h.pos.x : 0, oy = e.local ? h.pos.y : 0, oz = e.local ? h.pos.z : 0;
        for (let i = st.parts.length - 1; i >= 0; i--) {
          const p = st.parts[i];
          p.age += dt;
          if (p.age >= p.life) { st.parts.splice(i, 1); continue; }
          if (e.accel) { p.vx += e.accel[0] * dt; p.vy += e.accel[1] * dt; p.vz += e.accel[2] * dt; }
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          p.rot += p.rotRate * dt;
          const k = p.age / p.life;
          const c = sample3(e.colorLife, k, e.color);
          const al = Math.max(0, sample(e.alphaLife, k, e.alpha));
          const add = e.blend === 'add';
          const m = (add ? al * HDR_SCALE : HDR_SCALE) * h.gain, cap = add ? HDR_MAX : 1.2;
          const frames = e.sub ? e.sub[0] * e.sub[1] : 1;
          b.push(ox + p.x, oy + p.y, oz + p.z, p.size * sample(e.sizeLife, k, 1), p.rot, Math.min(frames - 1, Math.floor(k * frames)),
            Math.min(cap, c[0] * m), Math.min(cap, c[1] * m), Math.min(cap, c[2] * m), add ? 1 : Math.min(1, al), p.vx, p.vy, p.vz, p.aspect);
        }
        if (st.parts.length || emitting || (st.t < 0 && !h.stopped)) alive = true;
      }
      if (!alive) this.handles.splice(this.handles.indexOf(h), 1);
    }
    for (const b of this.buckets.values()) b.flush();
  }

  clear() {
    this.handles = [];
    for (const b of this.buckets.values()) b.flush();
  }
}
