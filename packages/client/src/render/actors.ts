import * as THREE from 'three';
import {
  ARMOR_SKINS, ASSET_TYPES, ASSETS, CLASSES, EMBLEMS, JET_TRAILS, PF, TEAM_COLORS, VEHICLE_TYPES, WEAPON_FINISHES, AF, taSkinModelKeys,
  type AssetSnap, type CosmeticProfile, type FlagSnap, type VehSnap,
} from '@ar/shared';
import { settings } from '../settings.js';
import { forceFieldMaterial } from './forcefield.js';
import { isSharedMaterial, markShared, ownMaterial, skinMaterial } from './materials.js';
import { CharacterRig, models, staticModel } from './models.js';

const _jet = new THREE.Vector3();

const NEUTRAL = 0xd0d0d0;
export const teamColor = (t: number) => (t === 0 || t === 1 ? TEAM_COLORS[t] : NEUTRAL);

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1: number, r2: number, h: number, s = 12) => new THREE.CylinderGeometry(r1, r2, h, s);

/** Every material an actor builds from fixed parameters is cached here and shared across
 *  instances; anything mutated per instance (stealth fade, team colour, damage dimming) is
 *  cloned out of the cache with `own()` first, so the shared original stays pristine. */
const matCache = new Map<string, THREE.Material>();
function shared<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = matCache.get(key);
  if (hit) return hit as T;
  const m = markShared(make());
  matCache.set(key, m);
  return m;
}

/** Clone a shared material for one actor; `out` records it so the actor disposes it. */
function own<T extends THREE.Material>(mat: T, out?: T[]): T {
  const c = ownMaterial(mat);
  out?.push(c);
  return c;
}

function glowMat(color: number, intensity = 1.5, opacity = 1): THREE.MeshStandardMaterial {
  return shared(`glow|${color}|${intensity}|${opacity}`, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4, transparent: opacity < 1, opacity }));
}

const emblemCache = new Map<string, THREE.CanvasTexture>();
function emblemTexture(id: string): THREE.CanvasTexture {
  let t = emblemCache.get(id);
  if (t) return t;
  const seed = EMBLEMS.find((e) => e.id === id)?.seed ?? 1;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 4; g.lineCap = 'round';
  const sym = Math.floor(rnd() * 3) + 3;
  g.translate(32, 32);
  for (let k = 0; k < sym; k++) {
    g.rotate((Math.PI * 2) / sym);
    g.beginPath(); g.moveTo(0, 4 + rnd() * 6); g.lineTo((rnd() - 0.5) * 16, 14 + rnd() * 12); g.stroke();
    if (rnd() < 0.5) { g.beginPath(); g.arc(0, 20, 3, 0, Math.PI * 2); g.fill(); }
  }
  t = new THREE.CanvasTexture(c);
  emblemCache.set(id, t);
  return t;
}

/** Procedural armour model; proportions vary by armour weight. */
export class PlayerModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private armR: THREE.Group;
  private flames: THREE.Mesh[] = [];
  private flag: THREE.Group;
  private shield: THREE.Mesh;
  private weapon: THREE.Mesh;
  private mats: THREE.Material[] = [];
  private stealthed = false;
  private phase = 0;
  private rig: CharacterRig | null = null;
  private procedural: THREE.Object3D[] = [];
  private disposed = false;
  private weaponItem = '';
  armor: 'light' | 'medium' | 'heavy';

  constructor(clsIndex: number, readonly team: number, cos: CosmeticProfile) {
    const cls = CLASSES[clsIndex] ?? CLASSES[0];
    this.armor = cls.armor;
    const k = cls.armor === 'light' ? 0.85 : cls.armor === 'medium' ? 1 : 1.22;
    const h = cls.armor === 'light' ? 1.85 : cls.armor === 'medium' ? 1.95 : 2.25;
    const skinId = settings.forceDefaultSkins ? 'standard' : cls.armor === 'light' ? cos.skinLight : cls.armor === 'medium' ? cos.skinMedium : cos.skinHeavy;
    const tc = teamColor(team);
    // Stealth fades every material under the root, so this actor owns clones of the shared templates.
    const skin = own(skinMaterial(ARMOR_SKINS.find((s) => s.id === skinId) ?? ARMOR_SKINS[0]), this.mats);
    const accent = own(shared(`accent|${tc}`, () => new THREE.MeshStandardMaterial({ color: tc, roughness: 0.5, metalness: 0.3, emissive: tc, emissiveIntensity: 0.25 })), this.mats);
    const visor = own(glowMat(tc, 2.2), this.mats);
    const dark = own(shared('dark|0x2a2e33', () => new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6, metalness: 0.5 })), this.mats);

    const legH = h * 0.45;
    const torsoH = h * 0.32;
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.body) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Legs pivot at hips.
    const legGeo = box(0.22 * k, legH, 0.26 * k);
    legGeo.translate(0, -legH / 2, 0);
    this.legL = mk(legGeo, skin, -0.14 * k, legH, 0);
    this.legR = mk(legGeo, skin, 0.14 * k, legH, 0);
    mk(box(0.24 * k, 0.12, 0.3 * k), accent, 0, 0.1 - legH, 0.02, this.legL);
    mk(box(0.24 * k, 0.12, 0.3 * k), accent, 0, 0.1 - legH, 0.02, this.legR);
    mk(box(0.44 * k, torsoH, 0.3 * k), skin, 0, legH + torsoH / 2, 0);
    mk(box(0.46 * k, 0.1, 0.32 * k), accent, 0, legH + torsoH * 0.55, 0);
    for (const sx of [-1, 1]) mk(box(0.2 * k, 0.16 * k, 0.28 * k), accent, sx * 0.3 * k, legH + torsoH * 0.95, 0);
    mk(box(0.24 * k, 0.26, 0.28), skin, 0, legH + torsoH + 0.15, 0);
    mk(box(0.2 * k, 0.07, 0.02), visor, 0, legH + torsoH + 0.17, -0.145);
    const emb = new THREE.Mesh(new THREE.PlaneGeometry(0.16 * k, 0.16 * k), own(shared(`emblem|${cos.emblem}|${tc}`, () => new THREE.MeshBasicMaterial({ map: emblemTexture(cos.emblem), transparent: true, color: tc })), this.mats));
    emb.position.set(0, legH + torsoH * 0.6, -0.155 * k);
    emb.rotation.y = Math.PI;
    this.body.add(emb);
    // Jetpack.
    mk(box(0.34 * k, torsoH * 0.9, 0.18 * k), dark, 0, legH + torsoH * 0.5, 0.24 * k);
    const trail = JET_TRAILS.find((j) => j.id === cos.jetTrail) ?? JET_TRAILS[0];
    const flameCol = new THREE.Color(tc).offsetHSL(0, (trail.saturation - 1) * 0.3, (trail.brightness - 1) * 0.25).lerp(new THREE.Color(0xffffff), 0.35);
    const flameMat = own(shared(`flame|${flameCol.getHex()}`, () => new THREE.MeshBasicMaterial({ color: flameCol, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })), this.mats);
    for (const sx of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.07 * k, 0.8, 8), flameMat);
      f.rotation.x = Math.PI;
      f.position.set(sx * 0.1 * k, legH + 0.05, 0.28 * k);
      f.visible = false;
      this.body.add(f);
      this.flames.push(f);
    }
    // Weapon arm.
    this.armR = new THREE.Group();
    this.armR.position.set(0.3 * k, legH + torsoH * 0.85, -0.05);
    this.body.add(this.armR);
    const fin = WEAPON_FINISHES.find((w) => w.id === cos.weaponFinish) ?? WEAPON_FINISHES[0];
    const wmat = own(shared(`wfinish|${fin.tint}|${fin.metalness}`, () => new THREE.MeshStandardMaterial({ color: fin.tint, metalness: fin.metalness, roughness: 0.4 })), this.mats);
    this.weapon = mk(box(0.12, 0.14, 0.7), wmat, 0, -0.1, -0.35, this.armR);
    mk(box(0.14 * k, 0.4, 0.14 * k), skin, 0, -0.15, 0, this.armR);
    // Flag (hidden unless carrying).
    this.flag = new THREE.Group();
    const pole = new THREE.Mesh(cyl(0.025, 0.025, 2.2, 6), dark);
    pole.position.y = 1.1;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), own(shared(`flagcloth|${tc}`, () => new THREE.MeshStandardMaterial({ color: tc, side: THREE.DoubleSide, emissive: tc, emissiveIntensity: 0.3 })), this.mats));
    cloth.position.set(0.45, 1.9, 0);
    this.flag.add(pole, cloth);
    this.flag.position.set(0, legH, 0.3 * k);
    this.flag.visible = false;
    this.body.add(this.flag);
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(h * 0.62, 20, 14), own(glowMat(tc, 0.8, 0.18), this.mats));
    this.shield.position.y = h * 0.5;
    this.shield.visible = false;
    this.root.add(this.body, this.shield);
    this.procedural = this.body.children.filter((c) => c !== this.flag && !this.flames.includes(c as THREE.Mesh));
    const [first, fallback] = taSkinModelKeys(cls.id, team, settings.forceDefaultSkins ? 0 : Number(cos.taSkins?.[clsIndex] ?? 0));
    void models.get(first).then((m) => (m || !fallback ? m : models.get(fallback))).then((m) => {
      if (!m || this.disposed) return;
      this.rig = new CharacterRig(m, cls.armor === 'heavy');
      // Mercenary armour is not team-painted: a faint team cast keeps friend/foe readable.
      if (m.key.includes('_merc')) for (const mat of this.rig.mats) mat.color.lerp(new THREE.Color(tc), 0.14);
      this.root.add(this.rig.root);
      for (const o of this.procedural) o.visible = false;
      for (const f of this.flames) f.position.set(f.position.x, this.rig.height * 0.6, 0.3 * k);
      this.flag.position.set(0, this.rig.height * 0.35, 0.32 * k);
      if (this.weaponItem) this.rig.setWeapon(this.weaponItem);
      if (this.stealthed) { this.stealthed = false; this.applyStealth(true); }
    });
  }

  /** Held item (3P weapon model). */
  setWeapon(item: string) {
    if (item === this.weaponItem) return;
    this.weaponItem = item;
    this.rig?.setWeapon(item);
  }

  private applyStealth(st: boolean) {
    if (st === this.stealthed) return;
    this.stealthed = st;
    this.root.traverse((o) => {
      const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(mm) ? mm : mm ? [mm] : []) {
        m.transparent = st || m.userData.wasTransparent === true || (m as THREE.MeshStandardMaterial).opacity < 1;
        if (!('origOpacity' in m.userData)) { m.userData.origOpacity = m.opacity; m.userData.wasTransparent = m.transparent; }
        m.opacity = st ? 0.07 : m.userData.origOpacity;
        m.needsUpdate = true;
      }
    });
  }

  update(dt: number, yaw: number, pitch: number, flags: number, speed: number, flagTeam: number | null, vel?: { x: number; y: number; z: number }) {
    this.root.rotation.y = yaw;
    this.armR.rotation.x = pitch;
    const jet = (flags & PF.JETTING) !== 0, ski = (flags & PF.SKIING) !== 0, ground = (flags & PF.ON_GROUND) !== 0;
    for (const f of this.flames) {
      f.visible = jet;
      if (jet) f.scale.set(1, 0.7 + Math.random() * 0.6, 1);
    }
    if (ground && !ski && speed > 1) {
      this.phase += dt * Math.min(12, speed * 1.2);
      this.legL.rotation.x = Math.sin(this.phase) * 0.7;
      this.legR.rotation.x = -Math.sin(this.phase) * 0.7;
      this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.04;
    } else if (ski && ground) {
      this.legL.rotation.x = 0.25; this.legR.rotation.x = -0.1;
      this.body.position.y = -0.12;
    } else {
      this.legL.rotation.x = 0.35; this.legR.rotation.x = 0.15;
      this.body.position.y = 0;
    }
    this.flag.visible = flagTeam !== null;
    if (flagTeam !== null) ((this.flag.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(teamColor(flagTeam));
    this.shield.visible = (flags & PF.SHIELD) !== 0;
    this.applyStealth((flags & PF.STEALTH) !== 0);
    this.rig?.update(dt, pitch, flags, speed, vel);
    // Thrust comes out of the jetpack (CSO_JetPack_C), which moves with the animated spine.
    if (jet && this.rig?.jetSocket(_jet)) {
      this.body.worldToLocal(_jet);
      this.flames.forEach((f, i) => f.position.set(_jet.x + (i ? 0.09 : -0.09), _jet.y - 0.45, _jet.z));
    }
  }

  /** Third-person fire / belt-throw animations (TA's upper-body slot). */
  fire() { this.rig?.fire(); }
  throwBelt() { this.rig?.throwBelt(); }

  setWeaponLength(len: number) { this.weapon.scale.z = len; }

  dispose() {
    this.disposed = true;
    this.body.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    // Only this actor's clones are disposed; the shared templates stay alive for other actors.
    for (const m of this.mats) if (!isSharedMaterial(m)) m.dispose();
    this.mats.length = 0;
    this.rig?.dispose();
  }
}

/** Visuals for base assets and deployables. */
const ASSET_MODEL: Record<string, string> = {
  generator: 'generator', inventory: 'stn_inventory', vehicle_pad: 'stn_vehicle', repair_station: 'stn_repair', cap_point: 'cap_point',
  supply_drop: 'supply_drop', force_field: 'dep_forcefield', light_turret: 'dep_turret_light', base_turret: 'dep_turret_heavy', exr_turret: 'dep_turret_rocket',
  drop_jammer: 'dep_jammer', motion_sensor: 'dep_motion_sensor', prism_mine: 'dep_prism_mine', flag_stand: 'flagstand', radar: 'dep_motion_sensor',
};
/** Mesh component Scale of the TA actors (TrPowerGenerator 2.5, base turret 3.25, radar = motion sensor x2). */
const ASSET_SCALE: Record<string, number> = { generator: 2.5, base_turret: 3.25, radar: 2 };
/** Energy sections (beams, field planes) render as translucent force-field surfaces. */
const ENERGY_TEX = /pfx_gradient|forcefield_field|shield_?fx/i;

export class AssetModel {
  readonly root = new THREE.Group();
  private head: THREE.Object3D | null = null;
  private glow: THREE.MeshStandardMaterial;
  private spin: THREE.Object3D | null = null;
  readonly type: string;

  constructor(s: AssetSnap) {
    const type = ASSET_TYPES[s.type];
    this.type = type;
    const def = ASSETS[type];
    const tc = teamColor(s.team);
    // `look()` dims every standard material in the root (and `update()` drives the glow), so
    // this asset owns clones of the shared templates; the force-field shader material is shared.
    this.glow = own(glowMat(tc, 1.4));
    const body = own(shared('asset-body', () => new THREE.MeshStandardMaterial({ color: 0x70767e, roughness: 0.55, metalness: 0.5 })));
    const dark = own(shared('asset-dark', () => new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.6, metalness: 0.6 })));
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = this.root) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const [sx, sy, sz] = def.size;
    switch (type) {
      case 'generator':
        add(cyl(sx * 0.9, sx, 0.4), dark, 0, 0.2);
        add(cyl(sx * 0.55, sx * 0.55, sy * 1.6, 16), this.glow, 0, sy);
        for (const y of [0.5, 1.2, 1.9]) add(new THREE.TorusGeometry(sx * 0.75, 0.08, 8, 24), body, 0, y * sy, 0).rotation.x = Math.PI / 2;
        add(cyl(sx * 0.8, sx * 0.9, 0.3), dark, 0, sy * 2);
        break;
      case 'base_turret': case 'light_turret': case 'exr_turret': {
        add(cyl(sx * 0.7, sx, sy * 1.2), dark, 0, sy * 0.6);
        this.head = new THREE.Group();
        this.head.position.y = sy * 1.3;
        add(box(sx * 1.2, sy * 0.6, sx * 1.2), body, 0, 0, 0, this.head);
        add(box(0.12, 0.12, sx * 1.8), dark, -0.15, 0, -sx, this.head);
        add(box(0.12, 0.12, sx * 1.8), dark, 0.15, 0, -sx, this.head);
        add(box(sx * 0.5, 0.1, 0.05), this.glow, 0, 0.12, -sx * 0.62, this.head);
        this.root.add(this.head);
        break;
      }
      case 'radar':
        add(cyl(0.2, 0.3, sy * 1.8, 8), dark, 0, sy * 0.9);
        this.spin = add(box(sx * 2.2, 0.6, 0.1), body, 0, sy * 1.9);
        add(new THREE.SphereGeometry(0.2, 8, 6), this.glow, 0, sy * 1.9 + 0.4);
        break;
      case 'inventory':
        add(box(sx * 2, sy * 2, sz), body, 0, sy);
        add(box(sx * 1.6, sy * 1.1, 0.05), this.glow, 0, sy * 1.15, -sz / 2 - 0.03);
        break;
      case 'repair_station':
        add(cyl(sx, sx, sy * 2, 8), body, 0, sy);
        add(box(0.5, 0.15, 0.05), own(glowMat(0x40ff80)), 0, sy * 1.5, -sx - 0.02);
        add(box(0.15, 0.5, 0.05), own(glowMat(0x40ff80)), 0, sy * 1.5, -sx - 0.02);
        break;
      case 'vehicle_pad':
        add(box(sx * 2, sy * 2, sz * 2), body, 0, sy);
        add(box(sx * 1.6, sy * 0.8, 0.05), this.glow, 0, sy * 1.3, -sz - 0.03);
        break;
      case 'cap_point':
        add(cyl(0.9, 1.1, 0.3, 16), dark, 0, 0.15);
        add(cyl(0.2, 0.2, sy * 2, 8), body, 0, sy);
        add(new THREE.SphereGeometry(0.45, 16, 10), this.glow, 0, sy * 2 + 0.3);
        this.spin = add(new THREE.TorusGeometry(1.4, 0.06, 6, 32), this.glow, 0, 0.5);
        this.spin.rotation.x = Math.PI / 2;
        break;
      case 'force_field':
        add(box(sx * 2, sy * 2, sz * 2), forceFieldMaterial(tc, false, 1.3), 0, sy).castShadow = false;
        for (const x of [-sx, sx]) add(box(0.15, sy * 2, 0.3), dark, x, sy);
        break;
      case 'supply_drop':
        add(box(sx * 2, sy * 2, sz * 2), body, 0, sy);
        add(box(sx * 2.02, 0.2, sz * 2.02), this.glow, 0, sy * 1.6);
        break;
      default:
        add(box(Math.max(0.2, sx * 2), Math.max(0.1, sy * 2), Math.max(0.1, sz * 2)), dark, 0, sy);
        add(new THREE.SphereGeometry(0.08, 6, 4), this.glow, 0, sy * 2 + 0.05);
    }
    this.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    this.root.rotation.y = s.yaw;
    const key = ASSET_MODEL[type] === 'flagstand' ? `flagstand_${s.team === 1 ? 1 : 0}` : ASSET_MODEL[type];
    if (key) {
      const proc = [...this.root.children];
      void models.get(key).then((m) => {
        if (!m) return;
        for (const o of proc) if (o !== this.head && o !== this.spin) o.visible = false;
        if (this.head) this.head.visible = false;
        if (this.spin && type !== 'cap_point') this.spin.visible = false;
        const g = staticModel(m, undefined, 0, tc);
        this.real = g;
        this.shown = '';
        g.scale.setScalar(ASSET_SCALE[type] ?? 1);
        const mesh = g.children[0] as THREE.Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((mat, i) => (ENERGY_TEX.test(m.sections[i]?.tex ?? '') ? forceFieldMaterial(tc, false, type === 'force_field' ? 1.3 : 0.8) : mat));
        }
        this.root.add(g);
      });
    }
  }

  private real: THREE.Group | null = null;
  private shown = '';

  /** Damaged: scorched; unpowered: dull; destroyed: black and wrecked (turrets and sensors slump, their lights go out). */
  private look(hp: number, powered: boolean, destroyed: boolean) {
    const k = destroyed ? 0.22 : !powered ? 0.6 : 0.55 + 0.45 * Math.min(1, hp / 0.5);
    this.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial || sm === this.glow) continue;
        sm.userData.base ??= sm.color.clone();
        sm.color.copy(sm.userData.base as THREE.Color).multiplyScalar(k);
        sm.userData.baseEm ??= sm.emissiveIntensity;
        sm.emissiveIntensity = destroyed ? 0 : (sm.userData.baseEm as number) * (powered ? 1 : 0.3);
      }
    });
    const slump = this.type === 'base_turret' || this.type === 'radar' || this.type.endsWith('turret');
    const tilt = destroyed ? 0.2 : !powered ? 0.08 : 0;
    if (slump) {
      if (this.real) { this.real.rotation.x = tilt; this.real.position.y = destroyed ? -0.15 : 0; }
      if (this.head) this.head.rotation.x = tilt * 2;
    }
  }

  update(s: AssetSnap, dt: number) {
    const destroyed = (s.flags & AF.DESTROYED) !== 0, powered = (s.flags & AF.POWERED) !== 0;
    this.glow.emissiveIntensity = destroyed ? 0 : powered ? 1.4 : 0.2;
    this.glow.color.setHex(destroyed ? 0x222222 : teamColor(s.team));
    this.glow.emissive.setHex(teamColor(s.team));
    const state = `${destroyed}|${powered}|${Math.round(s.health * 8)}`;
    if (state !== this.shown) { this.shown = state; this.look(s.health, powered, destroyed); }
    if (this.head) this.head.rotation.y = s.yaw - this.root.rotation.y;
    if (this.spin && powered && !destroyed) this.spin.rotation[this.type === 'cap_point' ? 'z' : 'y'] += dt * 1.5;
    this.root.position.set(s.pos.x, s.pos.y, s.pos.z);
  }
}

export class FlagModel {
  readonly root = new THREE.Group();
  private cloth: THREE.Mesh;
  private t = Math.random() * 10;

  constructor(team: number) {
    const tc = teamColor(team);
    // Flag visuals are identical per team and never mutated after construction, so they are shared.
    const pole = new THREE.Mesh(cyl(0.04, 0.04, 2.6, 6), shared('flag-pole', () => new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.7, roughness: 0.4 })));
    pole.position.y = 1.3;
    const g = new THREE.PlaneGeometry(1.1, 0.7, 8, 4);
    this.cloth = new THREE.Mesh(g, shared(`flag-cloth|${tc}`, () => new THREE.MeshStandardMaterial({ color: tc, emissive: tc, emissiveIntensity: 0.45, side: THREE.DoubleSide })));
    this.cloth.position.set(0.55, 2.2, 0);
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.4, 60, 8, 1, true), shared(`flagbeacon|${tc}`, () => new THREE.MeshBasicMaterial({ color: tc, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending })));
    beacon.position.y = 30;
    this.root.add(pole, this.cloth, beacon);
    void models.get(`flag_${team === 1 ? 1 : 0}`).then((m) => {
      if (!m) return;
      pole.visible = false; this.cloth.visible = false;
      const real = staticModel(m, undefined, 0, tc);
      real.position.y = 1;
      this.root.add(real);
    });
  }

  update(f: FlagSnap, dt: number) {
    this.root.visible = f.state !== 1;
    this.root.position.set(f.pos.x, f.pos.y - 1, f.pos.z);
    this.t += dt;
    const p = this.cloth.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + 0.55;
      p.setZ(i, Math.sin(this.t * 6 + x * 5) * 0.08 * x);
    }
    p.needsUpdate = true;
  }
}

export class VehicleModel {
  readonly root = new THREE.Group();
  private turret: THREE.Object3D | null = null;
  readonly type: string;

  constructor(v: VehSnap) {
    this.type = VEHICLE_TYPES[v.type];
    const tc = teamColor(v.team);
    // Vehicle materials are never mutated after construction and vehicles are never disposed,
    // so all four are shared per team.
    const hull = shared('veh-hull', () => new THREE.MeshStandardMaterial({ color: 0x7d858e, metalness: 0.6, roughness: 0.45 }));
    const accent = shared(`veh-accent|${tc}`, () => new THREE.MeshStandardMaterial({ color: tc, emissive: tc, emissiveIntensity: 0.3, metalness: 0.4, roughness: 0.5 }));
    const glow = glowMat(tc, 2);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = this.root) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    if (this.type === 'gravcycle') {
      add(box(0.9, 0.5, 3.2), hull, 0, 0.1);
      add(box(1.4, 0.25, 1.2), accent, 0, -0.1, 0.6);
      add(box(0.7, 0.3, 0.9), hull, 0, 0.45, 0.4);
      add(box(0.3, 0.3, 0.1), glow, 0, 0, 1.62);
      add(box(1.6, 0.08, 0.5), glow, 0, -0.35, -0.6);
    } else if (this.type === 'beowulf') {
      add(box(4.4, 1.2, 6.6), hull, 0, 0.2);
      add(box(4.8, 0.4, 6.8), accent, 0, -0.5);
      this.turret = new THREE.Group();
      this.turret.position.y = 1.2;
      add(box(2.4, 1, 2.6), hull, 0, 0, 0, this.turret);
      add(cyl(0.22, 0.28, 3.6, 10), hull, 0, 0.1, -2.6, this.turret).rotation.x = Math.PI / 2;
      add(box(1.2, 0.15, 0.2), glow, 0, 0.3, -1.3, this.turret);
      this.root.add(this.turret);
    } else {
      add(box(1.2, 0.8, 4.2), hull, 0, 0);
      add(box(6, 0.15, 1.6), accent, 0, 0, 0.6);
      add(box(2, 0.12, 1), hull, 0, 0.2, 2);
      add(box(0.9, 0.5, 1.2), glowMat(0x88ccff, 0.6, 0.6), 0, 0.5, -0.8);
      for (const x of [-2.6, 2.6]) add(box(0.4, 0.3, 0.2), glow, x, 0, 1.45);
    }
    const proc = [...this.root.children];
    void models.get(`veh_${this.type}`).then((m) => {
      if (!m) return;
      for (const o of proc) if (o !== this.turret) o.visible = false;
      if (this.turret) this.turret.visible = false;
      const real = staticModel(m);
      real.position.y = this.type === 'gravcycle' ? -0.6 : this.type === 'beowulf' ? -1.2 : -0.6;
      this.root.add(real);
    });
  }

  update(v: VehSnap, aimYaw: number | null) {
    this.root.position.set(v.pos.x, v.pos.y, v.pos.z);
    this.root.rotation.set(v.pitch, v.yaw, v.roll, 'YXZ');
    if (this.turret && aimYaw !== null) this.turret.rotation.y = aimYaw - v.yaw;
  }
}
