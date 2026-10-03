import * as THREE from 'three';
import { ITEMS, WEAPON_FINISHES, projDef } from '@ar/shared';
import { anims, SeqPlayer, type AnimSet } from './anim.js';
import { models, staticModel, weaponModelKey, type ModelData } from './models.js';

/** Skinned instance of an imported model in its bind pose, bones by name. */
function skinned(m: ModelData): { mesh: THREE.SkinnedMesh; bones: Map<string, THREE.Bone> } {
  const bones = m.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.p);
    bone.quaternion.fromArray(b.q);
    return bone;
  });
  bones.forEach((b, i) => { const p = m.bones[i].parent; if (p >= 0 && i > 0) bones[p].add(b); });
  const mesh = new THREE.SkinnedMesh(m.geometry, models.materials(m));
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.frustumCulled = false;
  mesh.userData.sharedGeometry = true;
  return { mesh, bones: new Map(bones.map((b) => [b.name, b])) };
}

/** Small emissive readout of the clip, like the counters on TA's first-person weapons. */
class AmmoReadout {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private shown = '';
  constructor(private color: number) {
    this.canvas.width = 128; this.canvas.height = 64;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.018), mat);
    this.mesh.renderOrder = 12;
    this.set(0, 0);
  }
  set(clip: number, reserve: number) {
    const s = `${clip}|${reserve}`;
    if (s === this.shown) return;
    this.shown = s;
    const g = this.canvas.getContext('2d')!;
    const c = `#${new THREE.Color(this.color).lerp(new THREE.Color(0xffffff), 0.25).getHexString()}`;
    g.clearRect(0, 0, 128, 64);
    g.fillStyle = 'rgba(6,14,18,0.55)';
    g.fillRect(2, 2, 124, 60);
    g.strokeStyle = c; g.globalAlpha = 0.6; g.lineWidth = 2; g.strokeRect(3, 3, 122, 58); g.globalAlpha = 1;
    g.font = 'bold 40px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = clip === 0 ? '#ff5040' : c; g.shadowColor = g.fillStyle; g.shadowBlur = 10;
    g.fillText(String(clip), 10, 34);
    g.font = 'bold 18px monospace'; g.textAlign = 'right'; g.shadowBlur = 4; g.globalAlpha = 0.75;
    g.fillText(String(reserve), 120, 44);
    g.globalAlpha = 1;
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.geometry.dispose(); }
}

/**
 * TA's first-person view: the class's arms and the weapon's 1P mesh, both skinned to the 1P skeleton and played by
 * the weapon's 1P AnimSet (Idle, Fire, reload, Retrieve...). Attached at the eye like UE3's first-person mesh.
 */
export class FirstPerson {
  readonly root = new THREE.Group();
  readonly player: SeqPlayer;
  readonly ammo: AmmoReadout;
  private placed = false;
  private wepBone: THREE.Bone | undefined;

  constructor(weapon: ModelData, hands: ModelData | null, set: AnimSet, accent: number) {
    const w = skinned(weapon), h = hands ? skinned(hands) : null;
    this.root.add(w.mesh);
    if (h) this.root.add(h.mesh);
    // UE camera space (X forward, Y right, Z up) -> three camera space (-Z forward).
    this.root.rotation.y = Math.PI / 2;
    // Uniform scale toward the eye: same picture, half the distance, so the arms poke through walls far less.
    this.root.scale.setScalar(0.5);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.renderOrder = 10; } });
    this.player = new SeqPlayer(set, h ? [w.bones, h.bones] : [w.bones]);
    this.wepBone = w.bones.get('R_WEP_root') ?? w.bones.get('Prop1');
    this.ammo = new AmmoReadout(accent);
    // The player starts on Idle's first frame: park the readout from that pose, so it sits at the same spot on the
    // weapon every time it is drawn (it then follows the weapon bone through Fire/reload/Retrieve).
    this.player.update(0);
    this.placeReadout(w.mesh);
    if (!this.player.play('Retrieve', false, 0)) this.player.play('Idle', true, 0);
  }

  /** On top of the weapon's receiver in the idle pose: a little behind its middle, left of its centre line. */
  private placeReadout(weapon: THREE.SkinnedMesh) {
    const bone = this.wepBone;
    if (!bone) return;
    // The root is not attached yet, so world space here is the holder's (camera) space: -Z forward, +Y up.
    this.root.updateMatrixWorld(true);
    weapon.computeBoundingBox();
    const box = weapon.boundingBox!.clone().applyMatrix4(weapon.matrixWorld);
    const size = box.getSize(new THREE.Vector3());
    const at = new THREE.Vector3(box.min.x + size.x * 0.35, box.max.y + 0.008, box.min.z + size.z * 0.62);
    bone.add(this.ammo.mesh);
    bone.worldToLocal(at);
    this.ammo.mesh.position.copy(at);
    // Face the eye, leaning back a little.
    const qb = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.ammo.mesh.quaternion.copy(qb.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.35)));
    this.ammo.mesh.scale.setScalar(1 / Math.max(1e-3, bone.getWorldScale(new THREE.Vector3()).x));
    this.placed = true;
  }

  update(dt: number, clip: number, reserve: number) {
    this.player.update(dt);
    this.ammo.set(clip, reserve);
  }

  dispose() { this.ammo.dispose(); }
}

/** Builds the TA first-person view for an item when its 1P mesh, arms and animations were imported. */
export async function firstPersonFor(itemId: string, armor: 'light' | 'medium' | 'heavy', team: number): Promise<FirstPerson | null> {
  const key = weaponModelKey(itemId);
  if (!key) return null;
  const [wm, hm, set] = await Promise.all([models.get(`${key}_1p`), models.get(`hands_${armor}_${team === 1 ? 1 : 0}`), anims.get(`${key}_1p`)]);
  if (!wm || !set) return null;
  const accent = projDef(itemId)?.color ?? (ITEMS[itemId]?.kind === 'lance' ? 0x9fe8ff : 0x7fffb0);
  return new FirstPerson(wm, hm, set, accent);
}

type Archetype = 'spinfusor' | 'launcher' | 'mortar' | 'sniper' | 'rifle' | 'smg' | 'shotgun' | 'pistol' | 'chaingun' | 'lance' | 'repair' | 'plasma';

function archetype(id: string): Archetype {
  const it = ITEMS[id];
  if (!it) return 'rifle';
  if (it.kind === 'lance') return 'lance';
  if (it.kind === 'repair') return 'repair';
  if (it.spinup) return 'chaingun';
  const model = it.projectile?.model;
  if (model === 'disc') return 'spinfusor';
  if (model === 'mortar') return 'mortar';
  if (model === 'plasma' || model === 'nova') return 'plasma';
  if (it.projectile) return model === 'knife' ? 'pistol' : 'launcher';
  if (it.zoom) return 'sniper';
  if ((it.hitscan?.pellets ?? 1) > 1) return 'shotgun';
  if (/pistol|sn7|falcon|eagle|sparrow|colt/.test(id)) return 'pistol';
  if (/smg|nj4|nj5|rhino|tcn4/.test(id)) return 'smg';
  return 'rifle';
}

/**
 * Procedural first-person weapon: an armored glove holding a weapon shaped after the item's family
 * (spinfusor, launcher, rifle, chain gun, ...) with a glowing accent in the projectile colour.
 */
export function buildViewModel(itemId: string, finishId: string, who?: { armor: 'light' | 'medium' | 'heavy'; team: number }): THREE.Group {
  const g = new THREE.Group();
  const finish = WEAPON_FINISHES.find((f) => f.id === finishId);
  const tint = finish?.tint ?? 0x5a626c;
  // A little emissive fill keeps the weapon readable when the sun is behind the player.
  const metal = new THREE.MeshStandardMaterial({ color: tint, metalness: Math.min(0.6, finish?.metalness ?? 0.6), roughness: 0.4, emissive: tint, emissiveIntensity: 0.22 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x30363d, metalness: 0.4, roughness: 0.55, emissive: 0x30363d, emissiveIntensity: 0.25 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x4a4236, metalness: 0.1, roughness: 0.8, emissive: 0x4a4236, emissiveIntensity: 0.2 });
  const accentColor = projDef(itemId)?.color ?? (ITEMS[itemId]?.kind === 'lance' ? 0x9fe8ff : ITEMS[itemId]?.kind === 'repair' ? 0x60ff90 : 0xffb547);
  const glow = new THREE.MeshBasicMaterial({ color: accentColor });

  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const tube = (r: number, len: number, m: THREE.Material, x: number, y: number, z: number, seg = 14, r2 = r) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, len, seg), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const ring = (r: number, t: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 24), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };

  const a = archetype(itemId);
  // Grip and glove (shared).
  box(0.035, 0.09, 0.045, dark, 0, -0.07, 0.05).rotation.x = -0.25;
  box(0.06, 0.07, 0.09, glove, 0.004, -0.085, 0.07);
  box(0.075, 0.08, 0.18, glove, 0.02, -0.12, 0.17).rotation.x = 0.15;

  switch (a) {
    case 'spinfusor': {
      box(0.075, 0.07, 0.34, metal, 0, 0, -0.06);
      box(0.11, 0.025, 0.2, dark, 0, 0.045, -0.12);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.018, 24), glow);
      disc.position.set(0, 0.075, -0.17);
      disc.name = 'spin';
      g.add(disc);
      ring(0.085, 0.01, metal, 0, 0.075, -0.17).rotation.x = Math.PI / 2;
      box(0.015, 0.05, 0.26, metal, 0.06, 0.04, -0.12);
      box(0.015, 0.05, 0.26, metal, -0.06, 0.04, -0.12);
      break;
    }
    case 'launcher':
    case 'mortar': {
      const r = a === 'mortar' ? 0.06 : 0.045;
      box(0.08, 0.08, 0.26, metal, 0, 0, -0.02);
      tube(r, 0.42, metal, 0, 0.04, -0.2);
      tube(r * 0.7, 0.02, glow, 0, 0.04, -0.415);
      ring(r + 0.008, 0.007, glow, 0, 0.04, -0.33);
      box(0.03, 0.03, 0.12, dark, 0, 0.1, -0.08);
      break;
    }
    case 'plasma': {
      box(0.07, 0.075, 0.26, metal, 0, 0, -0.04);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), glow);
      core.position.set(0, 0.06, -0.12);
      g.add(core);
      ring(0.045, 0.008, metal, 0, 0.06, -0.12).rotation.y = Math.PI / 2;
      tube(0.022, 0.24, dark, 0, 0.02, -0.28);
      tube(0.014, 0.02, glow, 0, 0.02, -0.4);
      break;
    }
    case 'sniper': {
      box(0.06, 0.07, 0.3, metal, 0, 0, 0);
      tube(0.014, 0.62, dark, 0, 0.02, -0.42);
      tube(0.028, 0.2, dark, 0, 0.085, -0.06);
      tube(0.02, 0.01, glow, 0, 0.085, -0.165);
      box(0.05, 0.06, 0.16, dark, 0, -0.01, 0.2);
      break;
    }
    case 'chaingun': {
      box(0.11, 0.1, 0.24, metal, 0, 0, -0.02);
      const barrels = new THREE.Group();
      barrels.name = 'spin';
      for (let i = 0; i < 6; i++) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.36, 8), dark);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(i * Math.PI / 3) * 0.032, Math.sin(i * Math.PI / 3) * 0.032, 0);
        barrels.add(b);
      }
      barrels.position.set(0, 0.02, -0.3);
      g.add(barrels);
      ring(0.046, 0.008, metal, 0, 0.02, -0.42);
      box(0.05, 0.08, 0.1, dark, -0.07, -0.02, 0.0);
      break;
    }
    case 'shotgun': {
      box(0.075, 0.075, 0.26, metal, 0, 0, -0.02);
      tube(0.022, 0.32, dark, -0.013, 0.035, -0.26);
      tube(0.022, 0.32, dark, 0.013, 0.035, -0.26);
      box(0.06, 0.04, 0.12, dark, 0, -0.01, -0.22);
      box(0.012, 0.012, 0.1, glow, 0, 0.068, -0.05);
      break;
    }
    case 'pistol': {
      box(0.045, 0.055, 0.2, metal, 0, 0.005, -0.06);
      tube(0.012, 0.06, dark, 0, 0.015, -0.18);
      box(0.008, 0.008, 0.08, glow, 0, 0.035, -0.06);
      break;
    }
    case 'lance':
    case 'repair': {
      box(0.07, 0.07, 0.22, metal, 0, 0, -0.02);
      for (const s of [-1, 1]) {
        const prong = box(0.012, 0.012, 0.2, dark, s * 0.03, 0.03, -0.2);
        prong.rotation.y = -s * 0.12;
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(a === 'lance' ? 0.025 : 0.02, 12, 8), glow);
      tip.position.set(0, 0.03, -0.3);
      g.add(tip);
      break;
    }
    default: { // rifle / smg
      const long = a === 'rifle';
      box(0.06, 0.07, long ? 0.32 : 0.24, metal, 0, 0, -0.04);
      tube(0.013, long ? 0.26 : 0.16, dark, 0, 0.02, long ? -0.33 : -0.24);
      box(0.03, 0.09, 0.05, dark, 0, -0.06, -0.08).rotation.x = 0.2;
      box(0.025, 0.02, 0.12, dark, 0, 0.05, -0.04);
      box(0.01, 0.01, 0.06, glow, 0, 0.064, -0.04);
      if (long) box(0.045, 0.05, 0.12, dark, 0, -0.01, 0.17);
    }
  }
  const holder = new THREE.Group();
  g.position.set(0.2, -0.19, -0.5);
  g.scale.setScalar(0.8);
  g.rotation.y = 0.04;
  holder.add(g);
  holder.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.renderOrder = 10; } });
  // Swap in the original 3P weapon mesh when imported, and TA's full first-person arms + weapon when those are.
  const key = weaponModelKey(itemId);
  let real: THREE.Object3D | null = null;
  if (key) void models.get(key).then((m) => {
    if (!m || !holder.parent || holder.userData.fp) return;
    real = staticModel(m, undefined, 0.45);
    real.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    real.position.set(0.15, -0.17, -0.36);
    real.scale.setScalar(0.42);
    g.visible = false;
    holder.add(real);
  });
  if (who) void firstPersonFor(itemId, who.armor, who.team).then((fp) => {
    if (!fp) return;
    if (!holder.parent) { fp.dispose(); return; }
    holder.userData.fp = fp;
    g.visible = false;
    if (real) real.visible = false;
    holder.add(fp.root);
  });
  return holder;
}

/** Spin barrels / disc of a viewmodel built by buildViewModel. */
export function spinViewModel(vm: THREE.Object3D, amount: number, dt: number) {
  const s = vm.getObjectByName('spin');
  if (!s) return;
  if (s instanceof THREE.Group) s.rotation.z += amount * dt * 40;
  else s.rotation.y += dt * 6;
}

/** Cloaked (stealth pack) first-person view: arms and weapon turn into a faint, shimmering glass silhouette, as in TA. */
export function setViewModelStealth(vm: THREE.Object3D, on: boolean, time: number) {
  if (!on && !vm.userData.stealthed) return;
  vm.userData.stealthed = on;
  const shimmer = 0.26 + Math.sin(time * 5) * 0.05;
  vm.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(mm) ? mm : mm ? [mm] : []) {
      const std = m as THREE.MeshStandardMaterial, u = m.userData;
      u.cloak ??= { opacity: m.opacity, transparent: m.transparent, emissive: std.emissive?.getHex(), ei: std.emissiveIntensity };
      const b = u.cloak as { opacity: number; transparent: boolean; emissive?: number; ei?: number };
      if (on) {
        if (!m.transparent) { m.transparent = true; m.needsUpdate = true; }
        m.opacity = b.opacity * shimmer;
        if (std.emissive) { std.emissive.setHex(0x4a90c8); std.emissiveIntensity = 0.45; }
      } else {
        m.transparent = b.transparent; m.opacity = b.opacity; m.needsUpdate = true;
        if (std.emissive && b.emissive !== undefined) { std.emissive.setHex(b.emissive); std.emissiveIntensity = b.ei ?? 1; }
        delete u.cloak;
      }
    }
  });
}

export function disposeViewModel(vm: THREE.Object3D) {
  (vm.userData.fp as FirstPerson | undefined)?.dispose();
  const mats = new Set<THREE.Material>();
  vm.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.userData.sharedGeometry) m.geometry.dispose();
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm);
  });
  for (const m of mats) m.dispose();
}
