import * as THREE from 'three';
import { PF } from '@ar/shared';
import { settings } from '../settings.js';
import { anims, animSetFor, TaAnimator } from './anim.js';
import { TextureStore } from './textures.js';

/** Normal-map strength for imported TA models and map meshes. */
export const NORMAL_STRENGTH = 0.9;

export interface ModelBone { name: string; parent: number; q: number[]; p: number[] }
export interface ModelData {
  key: string; bones: ModelBone[]; geometry: THREE.BufferGeometry; sections: { first: number; count: number; tex: string; normal?: string }[];
  /** Model-space direction the mesh faces (characters/vehicles face +Z, weapons +X). */
  forward: THREE.Vector3;
}

function parse(key: string, buf: ArrayBuffer): ModelData | null {
  const v = new DataView(buf);
  const dec = new TextDecoder('latin1');
  if (dec.decode(new Uint8Array(buf, 0, 4)) !== 'AMD1') return null;
  let o = 4;
  const nb = v.getUint16(o, true); o += 2;
  const nv = v.getUint32(o, true); o += 4;
  const ni = v.getUint32(o, true); o += 4;
  const ns = v.getUint16(o, true); o += 2;
  const bones: ModelBone[] = [];
  for (let i = 0; i < nb; i++) {
    const l = v.getUint8(o++);
    const name = dec.decode(new Uint8Array(buf, o, l)); o += l;
    const parent = v.getInt16(o, true); o += 2;
    const f = new Float32Array(buf.slice(o, o + 28)); o += 28;
    bones.push({ name, parent, q: [f[0], f[1], f[2], f[3]], p: [f[4], f[5], f[6]] });
  }
  const pos = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const uv = new Float32Array(buf.slice(o, o + nv * 8)); o += nv * 8;
  const si = new Uint16Array(buf.slice(o, o + nv * 8)); o += nv * 8;
  const swRaw = new Uint8Array(buf, o, nv * 4); o += nv * 4;
  const idx32 = new Uint32Array(buf.slice(o, o + ni * 4)); o += ni * 4;
  const sections: ModelData['sections'] = [];
  for (let i = 0; i < ns; i++) {
    const first = v.getUint32(o, true), count = v.getUint32(o + 4, true); o += 8;
    const l = v.getUint8(o++);
    // "diffuse|normal" (older exports: diffuse only).
    const [tex, normal] = dec.decode(new Uint8Array(buf, o, l)).split('|');
    sections.push({ first, count, tex, normal: normal || undefined }); o += l;
  }
  const sw = new Float32Array(nv * 4);
  for (let i = 0; i < nv * 4; i++) sw[i] = swRaw[i] / 255;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(nv < 65536 ? new THREE.BufferAttribute(Uint16Array.from(idx32), 1) : new THREE.BufferAttribute(idx32, 1));
  sections.forEach((s, i) => g.addGroup(s.first, s.count, i));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // Facing: characters by foot->toe, everything else by the longer horizontal bbox axis.
  const forward = new THREE.Vector3(0, 0, 1);
  const bb = g.boundingBox!;
  if (key.startsWith('wep_')) forward.set(Math.abs(bb.max.x) >= Math.abs(bb.min.x) ? 1 : -1, 0, 0);
  return { key, bones, geometry: g, sections, forward };
}

/** Imported TA models (characters, weapons, vehicles, stations) served by the local node or the host. */
class ModelLibrary {
  private bases: string[] = [];
  private keys: Promise<Set<string>> | null = null;
  private cache = new Map<string, Promise<ModelData | null>>();
  textures: TextureStore | null = null;
  private renderer: THREE.WebGLRenderer | null = null;

  /** Asset servers (local node first, then the host). */
  get sources(): readonly string[] { return this.bases; }

  setup(bases: string[], renderer: THREE.WebGLRenderer) {
    const key = bases.join('|');
    if (this.renderer && key === this.bases.join('|')) return;
    this.bases = bases;
    this.renderer = renderer;
    this.keys = null;
    this.textures = new TextureStore(bases, renderer);
  }

  private manifest(): Promise<Set<string>> {
    this.keys ??= (async () => {
      let failed = false;
      for (const base of this.bases) {
        try {
          const r = await fetch(`${base}/assets/models/manifest.json`, { signal: AbortSignal.timeout(15000) });
          if (r.ok) return new Set(Object.keys(((await r.json()) as { models: Record<string, unknown> }).models));
        } catch { failed = true; }
      }
      // A busy or unreachable node (e.g. while the menu backdrop streams in) must not disable models for the session.
      if (failed) this.keys = null;
      return new Set<string>();
    })();
    return this.keys;
  }

  /** Keys of the imported models (empty when nothing was imported). */
  available(): Promise<Set<string>> { return this.renderer ? this.manifest() : Promise.resolve(new Set()); }

  get(key: string): Promise<ModelData | null> {
    let p = this.cache.get(key);
    if (!p) {
      p = (async () => {
        if (!this.renderer) return null;
        const keys = await this.manifest();
        if (!keys.has(key)) { if (!keys.size) this.cache.delete(key); return null; }
        for (const base of this.bases) {
          try {
            const r = await fetch(`${base}/assets/models/${key}.amdl`, { signal: AbortSignal.timeout(15000) });
            if (!r.ok || !r.body) continue;
            const raw = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            return parse(key, raw);
          } catch { /* next */ }
        }
        return null;
      })();
      this.cache.set(key, p);
    }
    return p;
  }

  materials(m: ModelData, tint?: number, selfLit = 0): THREE.MeshStandardMaterial[] {
    return m.sections.map((s) => {
      // TA's diffuse maps already carry the paint/metal look; without its cube maps, PBR metalness only darkens them.
      const mat = new THREE.MeshStandardMaterial({ color: tint ?? 0xffffff, roughness: 0.68, metalness: 0.06, envMapIntensity: 0.6, side: THREE.DoubleSide });
      if (s.tex && this.textures) void this.textures.get(s.tex).then((t) => {
        if (!t) return;
        mat.map = t;
        if (selfLit) { mat.emissiveMap = t; mat.emissive.setHex(0xffffff); mat.emissiveIntensity = selfLit; }
        mat.needsUpdate = true;
      });
      if (s.normal && this.textures && settings.textureDetail !== 'low') void this.textures.get(s.normal, true).then((t) => {
        if (!t) return;
        mat.normalMap = t;
        // UE3 normal maps are DirectX-style (green down) and our axis swap mirrors the mesh: flip both.
        mat.normalScale.set(-NORMAL_STRENGTH, NORMAL_STRENGTH);
        mat.needsUpdate = true;
      });
      return mat;
    });
  }
}

export const models = new ModelLibrary();

/** Static (bind pose) instance, rotated so the model's front faces -Z like every other actor. */
export function staticModel(m: ModelData, tint?: number, selfLit = 0): THREE.Group {
  const mesh = new THREE.Mesh(m.geometry, models.materials(m, tint, selfLit));
  mesh.userData.sharedGeometry = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const g = new THREE.Group();
  g.rotation.y = Math.atan2(m.forward.x, m.forward.z) + Math.PI;
  g.add(mesh);
  return g;
}

// Item id -> 3P weapon model.
const WEAPON_MODEL: [RegExp, string][] = [
  [/^light_spinfusor$|^blinksfusor$/, 'wep_light_spinfusor'], [/^heavy_spinfusor$|^gladiator$/, 'wep_heavy_spinfusor'], [/twinfusor/, 'wep_twinfusor'], [/spinfusor/, 'wep_spinfusor'],
  [/^heavy_bolt/, 'wep_heavy_bolt_launcher'], [/^bolt_launcher$/, 'wep_bolt_launcher'], [/^auto_shotgun$/, 'wep_auto_shotgun'], [/^sawed_off$/, 'wep_sawed_off'],
  [/shotgun|the_hammer/, 'wep_shotgun'], [/^light_assault_rifle$/, 'wep_lar'], [/assault_rifle|gasts_rifle/, 'wep_assault_rifle'], [/^shocklance$/, 'wep_shocklance'],
  [/^bxt1/, 'wep_sniper'], [/^phase_rifle$/, 'wep_phase_rifle'], [/^sap20$/, 'wep_sap20'], [/^nova_blaster/, 'wep_nova_blaster'], [/^nova_colt$/, 'wep_nova_colt'],
  [/^falcon$/, 'wep_falcon'], [/sn7/, 'wep_sn7'], [/eagle_pistol|sparrow/, 'wep_pistol'], [/rhino_smg/, 'wep_rhino_smg'], [/tcn4/, 'wep_tcn4'], [/^nj5/, 'wep_nj5'],
  [/nj4/, 'wep_nj4'], [/^jackal$/, 'wep_jackal'], [/^arx_buster$/, 'wep_arx_buster'], [/^thumper_d$/, 'wep_thumper_d'], [/^thumper|^tc24$/, 'wep_thumper'],
  [/repair_tool/, 'wep_repair_tool'], [/grenade_launcher|dust_devil/, 'wep_grenade_launcher'], [/^plasma_gun$/, 'wep_plasma_gun'], [/^plasma_cannon$/, 'wep_plasma_cannon'],
  [/fusion_mortar/, 'wep_mortar'], [/^mirv/, 'wep_mirv'], [/x1_lmg/, 'wep_lmg'], [/^chain_/, 'wep_chaingun'], [/saber_launcher|titan_launcher/, 'wep_rocket_launcher'],
  [/throwing_knives/, 'wep_throwing_knives'],
];
export const weaponModelKey = (item: string): string | null => WEAPON_MODEL.find(([re]) => re.test(item))?.[1] ?? null;

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/** Rotate a bone by a world-space rotation (keeps its children attached). */
function rotateWorld(bone: THREE.Object3D, delta: THREE.Quaternion) {
  bone.parent!.getWorldQuaternion(_q);
  _q2.copy(_q).invert().multiply(delta).multiply(_q).multiply(bone.quaternion);
  bone.quaternion.copy(_q2);
  bone.updateMatrixWorld(true);
}

/**
 * Skinned TA character. With TA's animations imported it plays them like the game's AnimTree (TaAnimator) and holds
 * the weapon on the CSO_RHand_01 socket (bone Prop1); otherwise legs, aim and arm IK are procedural.
 */
export class CharacterRig {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private restRootY = 0;
  readonly height: number;
  private gun = new THREE.Group();
  private gunKey = '';
  private phase = 0;
  private wSki = 0;
  private wAir = 0;
  private animator: TaAnimator | null = null;
  private animKey = '';
  private handGun: THREE.Object3D | null = null;
  readonly mats: THREE.MeshStandardMaterial[];

  constructor(m: ModelData, private heavy = false) {
    const bones = m.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.fromArray(b.p);
      bone.quaternion.fromArray(b.q);
      return bone;
    });
    bones.forEach((b, i) => { const p = m.bones[i].parent; if (p >= 0) bones[p].add(b); });
    this.mats = models.materials(m);
    this.mesh = new THREE.SkinnedMesh(m.geometry, this.mats);
    this.mesh.add(bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(bones));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    for (const b of bones) { this.bones.set(b.name, b); this.rest.set(b, b.quaternion.clone()); }
    // Face -Z: derive the model's forward from foot -> toe.
    const foot = this.bones.get('L_Foot'), toe = this.bones.get('L_Toe0');
    const fwd = new THREE.Vector3(0, 0, 1);
    if (foot && toe) {
      foot.getWorldPosition(_v); toe.getWorldPosition(_v2);
      _v2.sub(_v).setY(0);
      if (_v2.lengthSq() > 1e-6) fwd.copy(_v2.normalize());
    }
    const facing = new THREE.Group();
    facing.rotation.y = Math.atan2(fwd.x, fwd.z) + Math.PI;
    facing.add(this.mesh);
    this.root.add(facing, this.gun);
    m.geometry.computeBoundingBox();
    this.height = m.geometry.boundingBox!.max.y;
    this.restRootY = bones[0].position.y;
  }

  /** Swap the 3P weapon in the character's hands (and TA's locomotion set for that weapon type). */
  setWeapon(item: string) {
    const { set, aim } = animSetFor(this.heavy, item);
    const ak = `${set}|${aim}`;
    if (ak !== this.animKey) {
      this.animKey = ak;
      void Promise.all([anims.get(set), anims.get('as_offsets')]).then(([s, off]) => {
        if (this.animKey !== ak || !s) return;
        const first = !this.animator;
        this.animator = new TaAnimator(s, this.bones, off, aim);
        if (!first) this.animator.play('Retrieve');
        this.attachGun();
      });
    }
    const key = weaponModelKey(item) ?? '';
    if (key === this.gunKey) return;
    this.gunKey = key;
    this.animator?.play('Retrieve');
    this.gun.clear();
    if (this.handGun) { this.handGun.removeFromParent(); this.handGun = null; }
    if (!key) return;
    void models.get(key).then((wm) => {
      if (!wm || this.gunKey !== key) return;
      const w = staticModel(wm);
      w.children[0].position.set(0, 0, 0);
      this.gun.add(w);
      // Raw (unrotated) copy for the hand socket: TA attaches weapons to CSO_RHand_01 on Prop1 with no offset.
      const hand = new THREE.Mesh(wm.geometry, models.materials(wm));
      hand.userData.sharedGeometry = true;
      hand.castShadow = true;
      this.handGun = hand;
      this.attachGun();
    });
  }

  private attachGun() {
    const prop = this.bones.get('Prop1');
    if (!this.handGun || !prop || !this.animator) return;
    prop.add(this.handGun);
    this.gun.visible = false;
  }

  /** Upper-body fire animation (TA plays it on the weapon slot when the pawn fires). */
  fire() { this.animator?.play('Fire'); }
  /** Off-hand grenade toss. */
  throwBelt() { this.animator?.play('OffhandGrenade'); }

  /** World position of the CSO_JetPack_C socket (Spine1 + RelativeLocation) once TA animations drive the rig. */
  jetSocket(out: THREE.Vector3): boolean {
    const sp = this.bones.get('Spine1');
    if (!sp || !this.animator) return false;
    sp.updateWorldMatrix(true, false);
    out.set(this.heavy ? 0.2 : 0.16, 0, this.heavy ? 0.36 : 0.2).applyMatrix4(sp.matrixWorld);
    return true;
  }

  private turn(name: string, axis: THREE.Vector3, angle: number) {
    const b = this.bones.get(name);
    if (!b || !angle) return;
    rotateWorld(b, _q.setFromAxisAngle(axis, angle).clone());
  }

  private ik(side: 'L' | 'R', target: THREE.Vector3, pole: THREE.Vector3) {
    const up = this.bones.get(`${side}_UpperArm`), fo = this.bones.get(`${side}_Forearm`), ha = this.bones.get(`${side}_Hand`);
    if (!up || !fo || !ha) return;
    const S = up.getWorldPosition(new THREE.Vector3()), E = fo.getWorldPosition(new THREE.Vector3()), H = ha.getWorldPosition(new THREE.Vector3());
    const a = S.distanceTo(E), b = E.distanceTo(H);
    const toT = _v.copy(target).sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    const dir = toT.normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const perp = _v2.copy(pole).sub(_v3.copy(dir).multiplyScalar(pole.dot(dir))).normalize();
    const elbow = new THREE.Vector3().copy(S).addScaledVector(dir, a * cosA).addScaledVector(perp, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    rotateWorld(up, new THREE.Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), elbow.clone().sub(S).normalize()));
    const E2 = fo.getWorldPosition(new THREE.Vector3()), H2 = ha.getWorldPosition(new THREE.Vector3());
    const want = target.clone().sub(E2).normalize();
    rotateWorld(fo, new THREE.Quaternion().setFromUnitVectors(H2.sub(E2).normalize(), want));
  }

  update(dt: number, pitch: number, flags: number, speed: number, vel?: { x: number; y: number; z: number }) {
    const jet = (flags & PF.JETTING) !== 0, ski = (flags & PF.SKIING) !== 0, ground = (flags & PF.ON_GROUND) !== 0;
    if (this.animator) {
      const q = this.root.getWorldQuaternion(_q);
      const f = _v.set(0, 0, -1).applyQuaternion(q), r = _v2.set(1, 0, 0).applyQuaternion(q);
      const vx = vel?.x ?? 0, vz = vel?.z ?? 0;
      this.animator.update(dt, { fwd: vx * f.x + vz * f.z, right: vx * r.x + vz * r.z, up: vel?.y ?? 0, onGround: ground, skiing: ski && !jet, jetting: jet, pitch });
      return;
    }
    for (const [b, q] of this.rest) b.quaternion.copy(q);
    const rootBone = this.mesh.skeleton.bones[0];
    rootBone.position.y = this.restRootY;
    this.root.updateMatrixWorld(true);
    const rq = this.root.getWorldQuaternion(new THREE.Quaternion());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rq), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rq), upW = new THREE.Vector3(0, 1, 0);
    const s = this.height / 2;
    // Pose weights ease in/out so hopping between ground and air while skiing does not snap the legs.
    const ease = (cur: number, to: number) => cur + (to - cur) * Math.min(1, dt * 9);
    this.wSki = ease(this.wSki, ski && !jet ? 1 : 0);
    this.wAir = ease(this.wAir, !ground && !(ski && !jet) ? 1 : 0);
    const wRun = Math.max(0, 1 - this.wSki - this.wAir) * (ground && speed > 0.8 ? 1 : 0);
    // Legs: a positive angle about `right` swings a limb forward (model faces -Z); calves bend with negative angles.
    if (wRun > 0.01) {
      this.phase += dt * Math.min(11, speed * 1.15);
      const sw = Math.sin(this.phase) * wRun;
      this.turn('L_Thigh', right, sw * 0.6); this.turn('R_Thigh', right, -sw * 0.6);
      this.turn('L_Calf', right, -Math.max(0, -sw) * 0.9); this.turn('R_Calf', right, -Math.max(0, sw) * 0.9);
      this.turn('Spine', right, -0.12 * wRun);
      rootBone.position.y = this.restRootY - Math.abs(Math.cos(this.phase)) * 0.03 * s * wRun;
    }
    if (this.wSki > 0.01) {
      // TA ski stance: crouched, staggered feet, chest over the knees, slight sideways twist.
      const w = this.wSki;
      this.turn('L_Thigh', right, 0.75 * w); this.turn('R_Thigh', right, 0.2 * w);
      this.turn('L_Calf', right, -1.15 * w); this.turn('R_Calf', right, -0.6 * w);
      this.turn('L_Foot', right, 0.3 * w); this.turn('R_Foot', right, 0.25 * w);
      this.turn('Spine', right, -0.38 * w);
      this.turn('Spine', upW, 0.18 * w);
      rootBone.position.y -= 0.1 * s * w;
    }
    if (this.wAir > 0.01) {
      const w = this.wAir * (jet ? 1 : 0.7);
      this.turn('L_Thigh', right, 0.35 * w); this.turn('R_Thigh', right, -0.12 * w);
      this.turn('L_Calf', right, -0.65 * w); this.turn('R_Calf', right, -0.45 * w);
      this.turn('Spine', right, (jet ? -0.15 : -0.05) * w);
    }
    // Aim: bend spine and head with pitch (pitch > 0 looks up).
    this.turn('Spine1', right, pitch * 0.45);
    this.turn('Head', right, pitch * 0.3);
    // Weapon held at the chest, pivoting with aim; hands follow it.
    const chest = this.bones.get('Spine1')?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.3 * s, 0).applyMatrix4(this.root.matrixWorld);
    const aim = fwd.clone().applyAxisAngle(right, pitch);
    const gunPos = chest.clone().addScaledVector(right, 0.17 * s).addScaledVector(upW, 0.12 * s).addScaledVector(aim, 0.28 * s);
    this.gun.position.copy(this.root.worldToLocal(gunPos.clone()));
    this.gun.rotation.set(pitch, 0, 0);
    this.gun.updateMatrixWorld(true);
    this.ik('R', gunPos.clone().addScaledVector(aim, -0.02 * s), right.clone().addScaledVector(upW, -1.5));
    this.ik('L', gunPos.clone().addScaledVector(aim, 0.3 * s).addScaledVector(right, -0.03 * s), right.clone().negate().addScaledVector(upW, -1.5));
  }

  dispose() {
    for (const m of this.mats) m.dispose();
    this.gun.clear();
    this.animKey = 'disposed';
    if (this.handGun) { this.handGun.removeFromParent(); ((this.handGun as THREE.Mesh).material as THREE.Material[]).forEach((m) => m.dispose()); this.handGun = null; }
  }
}
