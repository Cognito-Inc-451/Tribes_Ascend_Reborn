import * as THREE from 'three';
import { projDef, ITEM_IDS, JET_STYLES, type JetStyle, type ProjSnap, type Vec3 } from '@ar/shared';
import { settings } from '../settings.js';
import { TaParticles, type FxHandle } from './tafx.js';

const MAX_PARTICLES = 4000;

/** CPU-updated point sprites for jets, smoke, sparks and debris. */
export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private col = new Float32Array(MAX_PARTICLES * 3);
  private size = new Float32Array(MAX_PARTICLES);
  private alpha = new Float32Array(MAX_PARTICLES);
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private grow = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private next = 0;

  constructor(blending: THREE.Blending = THREE.AdditiveBlending) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const soft = blending === THREE.NormalBlending;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; varying vec3 vCol; varying float vA; uniform float scale;
        void main(){ vCol = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: soft
        // Smoke: soft-edged puff with a little noise in the falloff.
        ? `varying vec3 vCol; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d) * 4.0; if (r > 1.0) discard;
            float n = fract(sin(dot(floor(gl_PointCoord * 6.0), vec2(12.9898, 78.233))) * 43758.5453);
            gl_FragColor = vec4(vCol * (0.85 + 0.15 * n), vA * 0.55 * (1.0 - r) * (1.0 - r)); }`
        : `varying vec3 vCol; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard; gl_FragColor = vec4(vCol, vA * (1.0 - r*4.0)); }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  emit(p: Vec3, v: Vec3, color: THREE.Color, size: number, life: number, opts: { grow?: number; gravity?: number; spread?: number } = {}) {
    if (Math.random() > settings.particles) return;
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    const s = opts.spread ?? 0;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x + (Math.random() - 0.5) * s; this.vel[i * 3 + 1] = v.y + (Math.random() - 0.5) * s; this.vel[i * 3 + 2] = v.z + (Math.random() - 0.5) * s;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.size[i] = size; this.life[i] = life; this.maxLife[i] = life; this.grow[i] = opts.grow ?? 0; this.grav[i] = opts.gravity ?? 0;
    this.alpha[i] = 1;
  }

  update(dt: number, viewportH: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = viewportH * 0.6;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = Math.max(0, this.size[i] + this.grow[i] * dt);
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i]);
    }
    const g = this.points.geometry;
    for (const n of ['position', 'color', 'size', 'alpha']) (g.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface Transient { obj: THREE.Object3D; t: number; life: number; update?: (k: number) => void; dispose?: () => void }

/** Radial gradient (glow) and soft ring (shockwave) sprite textures, generated once. */
function spriteTex(kind: 'glow' | 'ring'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (kind === 'glow') {
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.18, 'rgba(255,255,255,.85)');
    grad.addColorStop(0.45, 'rgba(255,255,255,.25)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.72, 'rgba(255,255,255,0)');
    grad.addColorStop(0.86, 'rgba(255,255,255,.9)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let GLOW: THREE.Texture | null = null, RING: THREE.Texture | null = null;

const HALO_SIZE: Record<string, number> = { disc: 1.6, grenade: 0.7, bolt: 1.1, plasma: 1.8, mortar: 2.6, rocket: 1.3, knife: 0.5, mine: 0.6, nova: 1.6, saber: 1.6 };
const TRAIL: Record<string, { size: number; life: number; per: number }> = {
  disc: { size: 0.32, life: 0.28, per: 3 }, bolt: { size: 0.22, life: 0.35, per: 2 }, plasma: { size: 0.4, life: 0.3, per: 2 },
  mortar: { size: 0.55, life: 0.45, per: 2 }, rocket: { size: 0.3, life: 0.5, per: 3 }, saber: { size: 0.3, life: 0.4, per: 3 }, nova: { size: 0.3, life: 0.3, per: 2 },
  grenade: { size: 0.12, life: 0.2, per: 1 },
};

const PROJ_GEOMS: Record<string, THREE.BufferGeometry> = {
  disc: new THREE.CylinderGeometry(0.3, 0.3, 0.07, 16),
  grenade: new THREE.SphereGeometry(0.13, 10, 8),
  bolt: new THREE.BoxGeometry(0.12, 0.12, 0.7),
  plasma: new THREE.SphereGeometry(0.22, 10, 8),
  mortar: new THREE.SphereGeometry(0.38, 12, 10),
  rocket: new THREE.ConeGeometry(0.12, 0.6, 8),
  knife: new THREE.BoxGeometry(0.04, 0.02, 0.35),
  mine: new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10),
  nova: new THREE.IcosahedronGeometry(0.2, 1),
  saber: new THREE.ConeGeometry(0.15, 0.8, 8),
};
export class Effects {
  readonly group = new THREE.Group();
  readonly particles = new Particles();
  /** Normal-blended particles so smoke darkens instead of glowing. */
  readonly smoke = new Particles(THREE.NormalBlending);
  /** TA's own weapon effects when imported (trails, explosions, fractal shards). */
  readonly ta = new TaParticles();
  private projMeshes = new Map<number, { mesh: THREE.Mesh; halo: THREE.Sprite; last: THREE.Vector3 | null; model: string; color: THREE.Color; trail: FxHandle | null }>();
  private matCache = new Map<number, THREE.MeshBasicMaterial>();
  private transients: Transient[] = [];
  private lights: THREE.PointLight[] = [];
  private lightIdx = 0;

  constructor() {
    GLOW ??= spriteTex('glow');
    RING ??= spriteTex('ring');
    this.group.add(this.smoke.points, this.particles.points, this.ta.group);
    void this.ta.load();
    const nLights = settings.quality === 'low' ? 1 : 4;
    for (let i = 0; i < nLights; i++) {
      const l = new THREE.PointLight(0xffaa66, 0, 40, 2);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  private glowMat(color: number): THREE.MeshBasicMaterial {
    let m = this.matCache.get(color);
    if (!m) { m = new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }); this.matCache.set(color, m); }
    return m;
  }

  /** Render server projectiles (interpolated/extrapolated by the caller). */
  syncProjectiles(list: { snap: ProjSnap; pos: Vec3 }[], dt: number) {
    const seen = new Set<number>();
    for (const { snap, pos } of list) {
      seen.add(snap.id);
      let e = this.projMeshes.get(snap.id);
      const item = ITEM_IDS[snap.item];
      const def = projDef(item);
      if (!e) {
        const model = def?.model ?? 'grenade';
        const color = new THREE.Color(this.ta.item(item)?.light ?? def?.color ?? 0xffffff);
        const mesh = new THREE.Mesh(PROJ_GEOMS[model] ?? PROJ_GEOMS.grenade, this.glowMat(def?.color ?? 0xffffff));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.8 }));
        halo.scale.setScalar(HALO_SIZE[model] ?? 0.8);
        this.group.add(mesh, halo);
        e = { mesh, halo, last: null, model, color, trail: this.ta.play(this.ta.item(item)?.trail, pos, { trail: true }) };
        this.projMeshes.set(snap.id, e);
      }
      if (e.trail) e.trail.pos = { ...pos };
      e.mesh.position.set(pos.x, pos.y, pos.z);
      e.halo.position.copy(e.mesh.position);
      const v = snap.vel;
      if (e.model === 'disc' || e.model === 'mine') e.mesh.rotation.y += dt * 20;
      else if (Math.hypot(v.x, v.y, v.z) > 0.1) e.mesh.lookAt(pos.x + v.x, pos.y + v.y, pos.z + v.z);
      if (e.model === 'rocket' || e.model === 'saber') e.mesh.rotateX(Math.PI / 2);
      const tr = e.trail ? undefined : TRAIL[e.model];
      if (tr && e.last) {
        // Glowing particle trail along the path travelled this frame (smoke behind rockets and mortars).
        for (let i = 0; i < tr.per; i++) {
          const k = i / tr.per;
          const p = { x: e.last.x + (pos.x - e.last.x) * k, y: e.last.y + (pos.y - e.last.y) * k, z: e.last.z + (pos.z - e.last.z) * k };
          this.particles.emit(p, { x: 0, y: 0.3, z: 0 }, e.color, tr.size, tr.life, { spread: 0.4, grow: -tr.size / tr.life * 0.6 });
        }
        if (e.model === 'rocket' || e.model === 'mortar') this.smoke.emit(pos, { x: 0, y: 0.8, z: 0 }, SMOKE_GREY, 0.5, 1.4, { spread: 0.6, grow: 1.2 });
      }
      (e.last ??= new THREE.Vector3()).set(pos.x, pos.y, pos.z);
    }
    for (const [id, e] of this.projMeshes) {
      if (seen.has(id)) continue;
      this.group.remove(e.mesh, e.halo);
      e.halo.material.dispose();
      e.trail?.stop();
      this.projMeshes.delete(id);
    }
  }

  /** TA's explosion for `item` (with its light) if imported; false to fall back to the generic one. */
  taExplosion(item: string, pos: Vec3, radius: number): boolean {
    const f = this.ta.item(item);
    if (!this.ta.play(f?.explode, pos)) return false;
    const c = f?.boomLight ?? f?.light ?? 0xffaa66;
    // TA's fireball shells are meshes we draw as faint sprites: give every blast a bright core and shockwave.
    this.sprite(pos, GLOW!, 0xffffff, 0.12, (k) => radius * 0.7 * (0.8 + k), (k) => 1 - k);
    this.sprite(pos, GLOW!, c, 0.4, (k) => radius * 0.7 * (1 + k * 1.2), (k) => (1 - k) * 0.8);
    this.sprite(pos, RING!, c, 0.35, (k) => radius * 0.7 * (0.4 + k * 2.2), (k) => (1 - k) * 0.7);
    this.flash(pos, c, 60 + radius * 20, 0.35);
    return true;
  }

  /** A fractal grenade shard: TA's tracer colour from the orb to the hit, and its small blast there. */
  fractalShot(item: string, from: Vec3, to: Vec3) {
    const f = this.ta.item(item);
    this.beam(from, to, f?.light ?? 0x7dff3a, 0.18, 0.05);
    if (!this.ta.play(f?.shard, to, { scale: 0.6, gain: 0.4 })) this.explosion(to, 1.5, f?.light ?? 0x7dff3a);
  }

  /** Additive camera-facing sprite that animates over its life. */
  private sprite(pos: Vec3, tex: THREE.Texture, color: number, life: number, scale: (k: number) => number, opacity: (k: number) => number) {
    const mat = new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const s = new THREE.Sprite(mat);
    s.position.set(pos.x, pos.y, pos.z);
    s.scale.setScalar(scale(0));
    this.group.add(s);
    this.transients.push({ obj: s, t: 0, life, update: (k) => { s.scale.setScalar(scale(k)); mat.opacity = opacity(k); }, dispose: () => mat.dispose() });
  }

  muzzle(pos: Vec3, color = 0xffd890) {
    this.sprite(pos, GLOW!, color, 0.07, (k) => 0.9 + k * 0.5, (k) => 1 - k);
  }

  impact(pos: Vec3, color = 0xffe0a0) {
    const c = new THREE.Color(color);
    for (let i = 0; i < 5; i++) this.particles.emit(pos, { x: 0, y: 2, z: 0 }, c, 0.07, 0.25 + Math.random() * 0.2, { spread: 9, gravity: 14 });
    this.smoke.emit(pos, { x: 0, y: 0.6, z: 0 }, DUST, 0.35, 0.8, { spread: 0.8, grow: 0.9 });
  }

  flash(pos: Vec3, color: number, intensity: number, dur = 0.25) {
    const l = this.lights[this.lightIdx];
    if (!l) return;
    this.lightIdx = (this.lightIdx + 1) % this.lights.length;
    l.position.set(pos.x, pos.y + 1, pos.z);
    l.color.setHex(color);
    l.intensity = intensity;
    this.transients.push({ obj: new THREE.Object3D(), t: 0, life: dur, update: (k) => { l.intensity = intensity * (1 - k); } });
  }

  explosion(pos: Vec3, radius: number, color = 0xffa040) {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sphere.position.set(pos.x, pos.y, pos.z);
    this.group.add(sphere);
    this.transients.push({ obj: sphere, t: 0, life: 0.22, update: (k) => { sphere.scale.setScalar(radius * (0.25 + k * 0.6)); (sphere.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.7; }, dispose: () => (sphere.material as THREE.Material).dispose() });
    // White-hot core, coloured bloom and an expanding shockwave ring.
    this.sprite(pos, GLOW!, 0xffffff, 0.12, (k) => radius * (1.2 + k), (k) => 1 - k);
    this.sprite(pos, GLOW!, color, 0.45, (k) => radius * (1.6 + k * 1.6), (k) => (1 - k) * 0.8);
    this.sprite(pos, RING!, color, 0.4, (k) => radius * (0.6 + k * 3.2), (k) => (1 - k) * 0.9);
    this.flash(pos, color, 60 + radius * 20, 0.35);
    const c = new THREE.Color(color), hot = new THREE.Color(0xfff0c0);
    const n = Math.round(12 + radius * 3);
    for (let i = 0; i < n; i++) {
      const d = { x: Math.random() - 0.5, y: Math.random() * 0.8, z: Math.random() - 0.5 };
      // Fireball puffs, fast sparks with gravity, then lingering smoke.
      this.particles.emit(pos, { x: d.x * radius * 3, y: d.y * radius * 2.5, z: d.z * radius * 3 }, c, radius * 0.35, 0.35 + Math.random() * 0.25, { grow: radius * 0.8 });
      this.particles.emit(pos, { x: d.x * radius * 9, y: (d.y + 0.2) * radius * 7, z: d.z * radius * 9 }, hot, 0.09, 0.5 + Math.random() * 0.5, { gravity: 16 });
      if (i % 2 === 0) this.smoke.emit({ x: pos.x + d.x * radius, y: pos.y + d.y * radius * 0.5, z: pos.z + d.z * radius }, { x: d.x * 2, y: 1.5 + d.y * 2, z: d.z * 2 }, SMOKE_DARK, radius * 0.5, 1.6 + Math.random() * 1.2, { grow: radius * 0.6 });
    }
  }

  tracer(from: Vec3, to: Vec3, color = 0xfff0a0, width = 1) {
    if (settings.tracers) { this.tracerRound(from, to, color); this.impact(to, color); return; }
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 * width, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false;
    this.group.add(line);
    this.transients.push({ obj: line, t: 0, life: 0.05, update: (k) => { (line.material as THREE.LineBasicMaterial).opacity = (1 - k) * 0.35; }, dispose: () => (line.material as THREE.Material).dispose() });
    this.impact(to, color);
  }

  /** A bright streak flying from muzzle to impact at TA bullet speed (21000 uu/s = 420 m/s), with a hot glowing head. */
  private tracerRound(from: Vec3, to: Vec3, color: number) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return;
    const speed = 420, len = Math.min(dist, 7);
    const life = Math.max(0.035, dist / speed);
    const pos = new Float32Array(6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1]), 3));
    const c = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35);
    const mat = new THREE.LineBasicMaterial({ color: c, vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(g, mat);
    line.frustumCulled = false;
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW!, color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    head.scale.setScalar(0.35);
    const grp = new THREE.Group();
    grp.add(line, head);
    this.group.add(grp);
    const ux = dx / dist, uy = dy / dist, uz = dz / dist;
    this.transients.push({
      obj: grp, t: 0, life,
      update: (k) => {
        const d = k * (dist + len * 0.5);
        const hd = Math.min(dist, d), tl = Math.max(0, Math.min(dist, d - len));
        pos[0] = from.x + ux * tl; pos[1] = from.y + uy * tl; pos[2] = from.z + uz * tl;
        pos[3] = from.x + ux * hd; pos[4] = from.y + uy * hd; pos[5] = from.z + uz * hd;
        (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        head.position.set(pos[3], pos[4], pos[5]);
        head.visible = d <= dist;
      },
      dispose: () => { mat.dispose(); g.dispose(); (head.material as THREE.Material).dispose(); },
    });
  }

  beam(from: Vec3, to: Vec3, color: number, life: number, width = 0.15) {
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(width, width, len, 6, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    m.lookAt(to.x, to.y, to.z);
    m.rotateX(Math.PI / 2);
    this.group.add(m);
    this.transients.push({ obj: m, t: 0, life, update: (k) => { (m.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k); }, dispose: () => (m.material as THREE.Material).dispose() });
  }

  /** Smoke and sparks from a badly damaged or destroyed base asset. */
  assetDamage(pos: Vec3, hp: number, destroyed: boolean, type: string, dt: number) {
    if (!destroyed && hp > 0.5) return;
    const rate = destroyed ? 4 : (0.5 - hp) * 8;
    if (Math.random() > rate * dt * settings.particles) return;
    const h = type === 'generator' || type === 'radar' ? 3 : 2;
    this.smoke.emit({ x: pos.x + (Math.random() - 0.5) * 0.8, y: pos.y + h, z: pos.z + (Math.random() - 0.5) * 0.8 }, { x: 0, y: 1.6, z: 0 }, SMOKE_DARK, 0.5, 2.2, { grow: 1, spread: 0.3 });
    if (destroyed && Math.random() < 0.2) this.particles.emit({ x: pos.x, y: pos.y + h * 0.7, z: pos.z }, { x: 0, y: 2, z: 0 }, new THREE.Color(0xffc060), 0.07, 0.4, { spread: 5, gravity: 12 });
  }

  /** Thrust plume style: per-class look for the jetpack exhaust. */
  jetPuff(pos: Vec3, vel: Vec3, color: number, style: JetStyle = 'ion') {
    const st = JET_STYLES[style] ?? JET_STYLES.ion;
    if (st.smoke) {
      // Dense exhaust: soft smoke puffs with the hot core colour bleeding into grey.
      this.smoke.emit(pos, { x: vel.x * 0.25, y: -3.4 + vel.y * 0.25, z: vel.z * 0.25 }, new THREE.Color(color).lerp(new THREE.Color(0x9aa3ad), 0.45), 0.55, 1.05, { spread: 1.1, grow: 2.6 });
      this.particles.emit(pos, { x: vel.x * 0.3, y: -5 + vel.y * 0.3, z: vel.z * 0.3 }, new THREE.Color(color).lerp(new THREE.Color(st.core), 0.6), 0.34, 0.42, { spread: 0.9, grow: 1.1 });
    } else {
      this.particles.emit(pos, { x: vel.x * 0.3, y: -6 + vel.y * 0.3, z: vel.z * 0.3 }, new THREE.Color(color).lerp(new THREE.Color(st.core), st.blend), 0.28 * st.size, 0.3 * st.life, { spread: 1.5, grow: 0.6 * st.life });
    }
  }

  skiSpark(pos: Vec3, vel: Vec3) {
    this.particles.emit(pos, { x: vel.x * 0.5, y: 1.5, z: vel.z * 0.5 }, new THREE.Color(0xfff2c0), 0.08, 0.25, { spread: 3, gravity: 9 });
  }

  update(dt: number, viewportH: number) {
    this.particles.update(dt, viewportH);
    this.smoke.update(dt, viewportH);
    this.ta.update(dt);
    for (const tr of [...this.transients]) {
      tr.t += dt;
      const k = Math.min(1, tr.t / tr.life);
      tr.update?.(k);
      if (k >= 1) {
        this.group.remove(tr.obj);
        // Sprites share one geometry; only dispose geometries owned by meshes and lines.
        if (!(tr.obj instanceof THREE.Sprite)) (tr.obj as THREE.Mesh).geometry?.dispose();
        tr.dispose?.();
        this.transients.splice(this.transients.indexOf(tr), 1);
      }
    }
  }

  clear() {
    for (const e of this.projMeshes.values()) { this.group.remove(e.mesh, e.halo); e.halo.material.dispose(); e.trail?.stop(); }
    this.projMeshes.clear();
    this.ta.clear();
  }
}

const SMOKE_GREY = new THREE.Color(0x8a8a8a);
const SMOKE_DARK = new THREE.Color(0x3a3532);
const DUST = new THREE.Color(0x9a8f80);
