import * as THREE from 'three';
import { ITEMS, WEAPON_FINISHES, projDef } from '@ar/shared';
import { models, staticModel, weaponModelKey } from './models.js';

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
export function buildViewModel(itemId: string, finishId: string): THREE.Group {
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
  // Swap in the original 3P weapon mesh when imported.
  const key = weaponModelKey(itemId);
  if (key) void models.get(key).then((m) => {
    if (!m || !holder.parent) return;
    const real = staticModel(m, undefined, 0.45);
    real.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    real.position.set(0.15, -0.17, -0.36);
    real.scale.setScalar(0.42);
    g.visible = false;
    holder.add(real);
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

export function disposeViewModel(vm: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  vm.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.userData.sharedGeometry) m.geometry.dispose();
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm);
  });
  for (const m of mats) m.dispose();
}
