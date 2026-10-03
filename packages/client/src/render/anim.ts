import * as THREE from 'three';

/** One imported TA AnimSet (see tools/ta-import/src/anim.ts): tracks in the client's space. */
export interface AnimSeq { name: string; frames: number; length: number; pos: Float32Array[]; rot: Float32Array[] }
export interface AnimSet { bones: string[]; seqs: Map<string, AnimSeq> }

function parse(buf: ArrayBuffer): AnimSet | null {
  const v = new DataView(buf);
  const dec = new TextDecoder('latin1');
  if (dec.decode(new Uint8Array(buf, 0, 4)) !== 'AAN1') return null;
  let o = 4;
  const str = () => { const l = v.getUint8(o++); const s = dec.decode(new Uint8Array(buf, o, l)); o += l; return s; };
  const nb = v.getUint16(o, true); o += 2;
  const bones: string[] = [];
  for (let i = 0; i < nb; i++) bones.push(str());
  const ns = v.getUint16(o, true); o += 2;
  const seqs = new Map<string, AnimSeq>();
  for (let s = 0; s < ns; s++) {
    const name = str();
    const frames = v.getUint16(o, true); o += 2;
    const length = v.getFloat32(o, true); o += 4;
    const pos: Float32Array[] = [], rot: Float32Array[] = [];
    for (let t = 0; t < nb; t++) {
      const np = v.getUint16(o, true), nr = v.getUint16(o + 2, true); o += 4;
      pos.push(new Float32Array(buf.slice(o, o + np * 12))); o += np * 12;
      rot.push(new Float32Array(buf.slice(o, o + nr * 16))); o += nr * 16;
    }
    seqs.set(name.toLowerCase(), { name, frames, length, pos, rot });
  }
  return { bones, seqs };
}

/** Loads animation sets from the node(s) that serve the imported models. */
export class AnimLibrary {
  private bases: string[] = [];
  private keys: Promise<Set<string>> | null = null;
  private cache = new Map<string, Promise<AnimSet | null>>();

  setup(bases: string[]) {
    if (bases.join('|') === this.bases.join('|')) return;
    this.bases = bases;
    this.keys = null;
    this.cache.clear();
  }

  private manifest(): Promise<Set<string>> {
    this.keys ??= (async () => {
      let failed = false;
      for (const base of this.bases) {
        try {
          const r = await fetch(`${base}/assets/models/anims/manifest.json`, { signal: AbortSignal.timeout(15000) });
          if (r.ok) return new Set(Object.keys(((await r.json()) as { sets: Record<string, unknown> }).sets));
        } catch { failed = true; }
      }
      if (failed) this.keys = null;
      return new Set<string>();
    })();
    return this.keys;
  }

  get(key: string): Promise<AnimSet | null> {
    let p = this.cache.get(key);
    if (!p) {
      p = (async () => {
        const keys = await this.manifest();
        if (!keys.has(key)) { if (!keys.size) this.cache.delete(key); return null; }
        for (const base of this.bases) {
          try {
            const r = await fetch(`${base}/assets/models/anims/${key}.aanm`, { signal: AbortSignal.timeout(20000) });
            if (!r.ok || !r.body) continue;
            return parse(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
          } catch { /* next */ }
        }
        return null;
      })();
      this.cache.set(key, p);
    }
    return p;
  }
}

export const anims = new AnimLibrary();

/** TA's per-weapon locomotion sets (PC_Male.AnimSets) and aim-offset profiles (AS_Offsets). */
export function animSetFor(heavy: boolean, item: string): { set: string; aim: string } {
  const pick = (light: [string, string], hv: [string, string]) => (heavy ? { set: hv[0], aim: hv[1] } : { set: light[0], aim: light[1] });
  if (/spinfusor|twinfusor|blinksfusor/.test(item)) return pick(['as_pc_3p_litemed_spinfusor', 'LightMed_Spinfusor'], ['as_pc_3p_heavy_spinfusor', 'Heavy_Spinfusor']);
  if (/assault_rifle|gasts_rifle|^lar/.test(item)) return pick(['as_pc_3p_litemed_assaultrifle', 'LightMed_AssaultRifle'], ['as_pc_3p_heavy_lmg', 'Heavy_LMG']);
  if (/smg|nj4|nj5|tcn4|rhino|jackal/.test(item)) return pick(['as_pc_3p_litemed_smg', 'LightMed_SMG'], ['as_pc_3p_heavy_pistol', 'Heavy_SMG']);
  if (/colt|pistol|sparrow|falcon|sn7|nova_blaster|eagle/.test(item)) return pick(['as_pc_3p_litemed_pistol', 'LightMed_Pistol'], ['as_pc_3p_heavy_pistol', 'Heavy_Pistol']);
  if (/shotgun|sawed_off|hammer/.test(item)) return pick(['as_pc_3p_litemed_shotgun', 'LightMed_Shotgun'], ['as_pc_3p_heavy_shotgun', 'Heavy_Shotgun']);
  if (/bxt1|phase_rifle|sap20|sniper/.test(item)) return pick(['as_pc_3p_litemed_energysniperrifle', 'LightMed_PhaseRifle'], ['as_pc_3p_heavy', 'Heavy_Spinfusor']);
  if (/throwing_knives/.test(item)) return pick(['as_pc_3p_litemed_throwingknives', 'LightMed_ThrowingKnife'], ['as_pc_3p_heavy', 'Heavy_Spinfusor']);
  if (/chain_gun|chaingun/.test(item)) return pick(['as_pc_3p_litemed_assaultrifle', 'LightMed_AssaultRifle'], ['as_pc_3p_heavy_chaingun', 'Heavy_ChainGun']);
  if (/x1_lmg|lmg/.test(item)) return pick(['as_pc_3p_litemed_assaultrifle', 'LightMed_AssaultRifle'], ['as_pc_3p_heavy_lmg', 'Heavy_LMG']);
  if (/mortar|mirv/.test(item)) return pick(['as_pc_3p_litemed_grenadelauncher', 'LightMed_GrenadeLauncher'], ['as_3p_heavy_mortarlauncher', 'Heavy_MortarLauncher']);
  if (/saber|titan|rocket/.test(item)) return pick(['as_pc_3p_litemed_grenadelauncher', 'LightMed_GrenadeLauncher'], ['as_pc_3p_heavy_sabrelauncher', 'Heavy_SabreLauncher']);
  if (/grenade_launcher|thumper|tc24|dust_devil|bolt|arx|plasma|burst/.test(item)) return pick(['as_pc_3p_litemed_grenadelauncher', 'LightMed_GrenadeLauncher'], ['as_pc_3p_heavy_grenadelaucher', 'Heavy_Grenadelauncher']);
  return pick(['as_pc_3p_litemed_spinfusor', 'LightMed_Spinfusor'], ['as_pc_3p_heavy_spinfusor', 'Heavy_Spinfusor']);
}

/** Movement state that drives the blend tree each frame. */
export interface AnimState {
  /** Velocity in the character's frame (m/s): fwd = facing, right, up. */
  fwd: number; right: number; up: number;
  onGround: boolean; skiing: boolean; jetting: boolean;
  /** Aim pitch in radians (positive = up). */
  pitch: number;
}

const DIR8 = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
const DIR4 = ['F', 'R', 'B', 'L'];
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** Weights over evenly spaced directions for a heading angle (0 = forward, +pi/2 = right). */
function dirWeights(angle: number, n: number): [number, number, number, number] {
  const a = ((angle / (Math.PI * 2)) * n + n * 8) % n;
  const i0 = Math.floor(a) % n, i1 = (i0 + 1) % n, f = a - Math.floor(a);
  return [i0, 1 - f, i1, f];
}

interface Pose { q: Float32Array; p: Float32Array; w: Float32Array }

/**
 * Blends TA's locomotion sequences like its AnimTree: 8-way run and ski blends, 4-way flight with up/down,
 * idle, landing, upper-body one-shots (fire, reload, weapon switch, grenade toss) and the AS_Offsets aim poses.
 */
export class TaAnimator {
  private boneIdx: (THREE.Bone | null)[] = [];
  private upper: boolean[] = [];
  private acc: Pose;
  private tmp: Pose;
  private phase = { run: 0, ski: 0, fly: 0, idle: 0 };
  private mode = { ground: 1, ski: 0, air: 0 };
  private oneShot: { seq: AnimSeq; t: number; upper: boolean } | null = null;
  private aimUp: Float32Array | null = null;
  private aimDown: Float32Array | null = null;
  private wasGround = true;

  constructor(private set: AnimSet, bones: Map<string, THREE.Bone>, offsets: AnimSet | null, aimProfile: string) {
    const n = set.bones.length;
    this.boneIdx = set.bones.map((b) => bones.get(b) ?? null);
    // Upper body = Spine1 and everything below it (TA's upper-body slot and aim offsets start there).
    const spine = bones.get('Spine1');
    this.upper = this.boneIdx.map((b) => { for (let o: THREE.Object3D | null = b; o; o = o.parent) if (o === spine) return true; return false; });
    const mk = (): Pose => ({ q: new Float32Array(n * 4), p: new Float32Array(n * 3), w: new Float32Array(n) });
    this.acc = mk(); this.tmp = mk();
    if (offsets) this.setAim(offsets, aimProfile);
  }

  private setAim(off: AnimSet, profile: string) {
    const find = (s: string) => off.seqs.get(`${profile}_${s}`.toLowerCase()) ?? off.seqs.get(`${profile}_aim${s}`.toLowerCase());
    const cc = find('CC'), cu = find('CU'), cd = find('CD');
    if (!cc || !cu || !cd) return;
    // Per-bone local delta from the centre pose: delta = inverse(CC) * pose.
    const delta = (pose: AnimSeq) => {
      const out = new Float32Array(this.set.bones.length * 4);
      this.set.bones.forEach((name, i) => {
        const t = off.bones.indexOf(name);
        out[i * 4 + 3] = 1;
        if (t < 0 || !this.upper[i]) return;
        const a = cc.rot[t], b = pose.rot[t];
        _q.set(a[0], a[1], a[2], a[3]).invert();
        _q2.set(b[0], b[1], b[2], b[3]);
        _q.multiply(_q2);
        out[i * 4] = _q.x; out[i * 4 + 1] = _q.y; out[i * 4 + 2] = _q.z; out[i * 4 + 3] = _q.w;
      });
      return out;
    };
    this.aimUp = delta(cu); this.aimDown = delta(cd);
  }

  private seq(name: string): AnimSeq | null { return this.set.seqs.get(name.toLowerCase()) ?? null; }

  /** Upper-body one-shots: Fire, reload, Retrieve (weapon switch), OffhandGrenade. */
  play(name: string, full = false) {
    const s = this.seq(name);
    if (s) this.oneShot = { seq: s, t: 0, upper: !full };
  }

  /** Sample a sequence at time t (looping) into `out` with weight w (sign-aligned accumulation). */
  private sample(s: AnimSeq, t: number, w: number, out: Pose, mask?: boolean[]) {
    if (w <= 0.001) return;
    const fps = s.frames / s.length;
    const f = ((t % s.length) + s.length) % s.length * fps;
    const i0f = Math.floor(f), a = f - i0f;
    for (let b = 0; b < this.boneIdx.length; b++) {
      if (!this.boneIdx[b] || (mask && !mask[b])) continue;
      const R = s.rot[b], P = s.pos[b];
      const nr = R.length >> 2, np = (P.length / 3) | 0;
      let x: number, y: number, z: number, ww: number;
      if (nr === 1) { x = R[0]; y = R[1]; z = R[2]; ww = R[3]; } else {
        const i0 = (i0f % nr) * 4, i1 = ((i0f + 1) % nr) * 4;
        const d = R[i0] * R[i1] + R[i0 + 1] * R[i1 + 1] + R[i0 + 2] * R[i1 + 2] + R[i0 + 3] * R[i1 + 3] < 0 ? -1 : 1;
        x = R[i0] + (R[i1] * d - R[i0]) * a; y = R[i0 + 1] + (R[i1 + 1] * d - R[i0 + 1]) * a;
        z = R[i0 + 2] + (R[i1 + 2] * d - R[i0 + 2]) * a; ww = R[i0 + 3] + (R[i1 + 3] * d - R[i0 + 3]) * a;
      }
      const qo = b * 4;
      // Align hemispheres with what is already accumulated so opposite-sign quaternions do not cancel out.
      const dot = out.q[qo] * x + out.q[qo + 1] * y + out.q[qo + 2] * z + out.q[qo + 3] * ww;
      const sw = dot < 0 ? -w : w;
      out.q[qo] += x * sw; out.q[qo + 1] += y * sw; out.q[qo + 2] += z * sw; out.q[qo + 3] += ww * sw;
      const po = b * 3;
      if (np === 1) { out.p[po] += P[0] * w; out.p[po + 1] += P[1] * w; out.p[po + 2] += P[2] * w; } else {
        const j0 = (i0f % np) * 3, j1 = ((i0f + 1) % np) * 3;
        out.p[po] += (P[j0] + (P[j1] - P[j0]) * a) * w; out.p[po + 1] += (P[j0 + 1] + (P[j1 + 1] - P[j0 + 1]) * a) * w;
        out.p[po + 2] += (P[j0 + 2] + (P[j1 + 2] - P[j0 + 2]) * a) * w;
      }
      out.w[b] += w;
    }
  }

  private blendDirs(prefix: string, dirs: string[], angle: number, t: number, w: number, out: Pose) {
    const [i0, w0, i1, w1] = dirWeights(angle, dirs.length);
    const a = this.seq(prefix + dirs[i0]), b = this.seq(prefix + dirs[i1]);
    if (a) this.sample(a, t * a.length, w * w0, out);
    if (b) this.sample(b, t * b.length, w * w1, out);
  }

  update(dt: number, s: AnimState) {
    const hs = Math.hypot(s.fwd, s.right);
    const angle = Math.atan2(s.right, s.fwd);
    // Mode weights ease like the AnimTree's blend-by-physics nodes.
    const target = s.skiing ? 'ski' : s.onGround ? 'ground' : 'air';
    const k = Math.min(1, dt * 8);
    for (const m of ['ground', 'ski', 'air'] as const) this.mode[m] += ((m === target ? 1 : 0) - this.mode[m]) * k;
    if (s.onGround && !this.wasGround && !s.skiing && s.up < -6) this.play('SoftLand', true);
    this.wasGround = s.onGround;

    const runF = this.seq('RunF'), skiF = this.seq('SkiingF'), flyF = this.seq('FlyF'), idle = this.seq('Idle');
    if (runF) this.phase.run = (this.phase.run + (dt * THREE.MathUtils.clamp(hs / 8.5, 0.55, 1.8)) / runF.length) % 1;
    if (skiF) this.phase.ski = (this.phase.ski + dt / skiF.length) % 1;
    if (flyF) this.phase.fly = (this.phase.fly + dt / flyF.length) % 1;
    if (idle) this.phase.idle = (this.phase.idle + dt / idle.length) % 1;

    const acc = this.acc;
    acc.q.fill(0); acc.p.fill(0); acc.w.fill(0);
    // Ground: idle <-> 8-way run by speed.
    if (this.mode.ground > 0.01) {
      const run = THREE.MathUtils.smoothstep(hs, 0.4, 2.2);
      if (idle) this.sample(idle, this.phase.idle * idle.length, this.mode.ground * (1 - run), acc);
      this.blendDirs('Run', DIR8, angle, this.phase.run, this.mode.ground * run, acc);
    }
    // Skiing: 8-way ski poses (SkiIdle when nearly stopped).
    if (this.mode.ski > 0.01) {
      const fast = THREE.MathUtils.smoothstep(hs, 3, 9);
      this.blendDirs('Skiing', DIR8, angle, this.phase.ski, this.mode.ski * fast, acc);
      this.blendDirs('SkiIdle', DIR8, angle, this.phase.ski, this.mode.ski * (1 - fast), acc);
    }
    // Air: 4-way flight, up when thrusting upward, down when dropping, idle hover when slow.
    if (this.mode.air > 0.01) {
      const wUp = s.jetting ? THREE.MathUtils.smoothstep(s.up, 1, 6) : 0;
      const wDown = THREE.MathUtils.smoothstep(-s.up, 6, 14) * (1 - wUp);
      const moving = THREE.MathUtils.smoothstep(hs, 2, 8) * (1 - wUp - wDown);
      const flyU = this.seq('FlyU'), flyD = this.seq('FlyD'), flyIdle = this.seq('FlyIdle');
      if (flyU) this.sample(flyU, this.phase.fly * flyU.length, this.mode.air * wUp, acc);
      if (flyD) this.sample(flyD, this.phase.fly * flyD.length, this.mode.air * wDown, acc);
      this.blendDirs('Fly', DIR4, angle, this.phase.fly, this.mode.air * moving, acc);
      if (flyIdle) this.sample(flyIdle, this.phase.fly * flyIdle.length, this.mode.air * Math.max(0, 1 - wUp - wDown - moving), acc);
    }
    // One-shots override the upper body (or everything for landings) with short fades.
    const os = this.oneShot;
    if (os) {
      os.t += dt;
      const L = os.seq.length;
      if (os.t >= L) this.oneShot = null;
      else {
        const fade = Math.min(1, os.t / 0.08, (L - os.t) / 0.15);
        const tmp = this.tmp;
        tmp.q.fill(0); tmp.p.fill(0); tmp.w.fill(0);
        this.sample(os.seq, os.t, 1, tmp, os.upper ? this.upper : undefined);
        for (let b = 0; b < this.boneIdx.length; b++) {
          if (!tmp.w[b]) continue;
          const tw = fade, aw = acc.w[b] || 1;
          for (let c = 0; c < 4; c++) acc.q[b * 4 + c] = acc.q[b * 4 + c] / aw;
          const dot = acc.q[b * 4] * tmp.q[b * 4] + acc.q[b * 4 + 1] * tmp.q[b * 4 + 1] + acc.q[b * 4 + 2] * tmp.q[b * 4 + 2] + acc.q[b * 4 + 3] * tmp.q[b * 4 + 3];
          const sg = dot < 0 ? -1 : 1;
          for (let c = 0; c < 4; c++) acc.q[b * 4 + c] = acc.q[b * 4 + c] * (1 - tw) + tmp.q[b * 4 + c] * sg * tw;
          for (let c = 0; c < 3; c++) acc.p[b * 3 + c] = (acc.p[b * 3 + c] / aw) * (1 - tw) + tmp.p[b * 3 + c] * tw;
          acc.w[b] = 1;
        }
      }
    }
    // Write the pose, then layer the aim offset (TA AimOffset: up/down poses relative to centre).
    const u = THREE.MathUtils.clamp(s.pitch / (Math.PI * 0.45), -1, 1);
    const aim = u >= 0 ? this.aimUp : this.aimDown;
    for (let b = 0; b < this.boneIdx.length; b++) {
      const bone = this.boneIdx[b];
      const w = acc.w[b];
      if (!bone || w <= 0) continue;
      bone.quaternion.set(acc.q[b * 4], acc.q[b * 4 + 1], acc.q[b * 4 + 2], acc.q[b * 4 + 3]).normalize();
      bone.position.set(acc.p[b * 3] / w, acc.p[b * 3 + 1] / w, acc.p[b * 3 + 2] / w);
      if (aim && this.upper[b]) {
        _q.set(aim[b * 4], aim[b * 4 + 1], aim[b * 4 + 2], aim[b * 4 + 3]);
        _q2.identity().slerp(_q, Math.abs(u));
        bone.quaternion.multiply(_q2);
      }
    }
  }
}

/** Sample one sequence at time t (seconds, looped or clamped) for track b: writes quaternion and position. */
function sampleTrack(s: AnimSeq, b: number, t: number, loop: boolean, q: THREE.Quaternion, p: THREE.Vector3): boolean {
  const R = s.rot[b], P = s.pos[b];
  if (!R?.length) return false;
  const tt = loop ? ((t % s.length) + s.length) % s.length : Math.min(Math.max(t, 0), s.length);
  const f = s.length > 0 ? (tt / s.length) * Math.max(1, s.frames - (loop ? 0 : 1)) : 0;
  const i0f = Math.floor(f), a = f - i0f;
  const nr = R.length >> 2, np = (P.length / 3) | 0;
  const r0 = Math.min(i0f, nr - 1) % nr, r1 = loop ? (i0f + 1) % nr : Math.min(i0f + 1, nr - 1);
  if (nr === 1) q.set(R[0], R[1], R[2], R[3]);
  else {
    q.set(R[r0 * 4], R[r0 * 4 + 1], R[r0 * 4 + 2], R[r0 * 4 + 3]);
    _q2.set(R[r1 * 4], R[r1 * 4 + 1], R[r1 * 4 + 2], R[r1 * 4 + 3]);
    q.slerp(_q2, a);
  }
  if (np === 1) p.set(P[0], P[1], P[2]);
  else if (np > 1) {
    const j0 = Math.min(i0f, np - 1), j1 = loop ? (i0f + 1) % np : Math.min(i0f + 1, np - 1);
    p.set(P[j0 * 3] + (P[j1 * 3] - P[j0 * 3]) * a, P[j0 * 3 + 1] + (P[j1 * 3 + 1] - P[j0 * 3 + 1]) * a, P[j0 * 3 + 2] + (P[j1 * 3 + 2] - P[j0 * 3 + 2]) * a);
  }
  return true;
}

const _sq = new THREE.Quaternion(), _sp = new THREE.Vector3(), _fq = new THREE.Quaternion(), _fp = new THREE.Vector3();

/**
 * Plays TA's first-person sequences (Idle loop, Fire, reload, Retrieve, Putaway, ...) on one or more skeletons that
 * share bone names (the 1P arms and the 1P weapon), cross-fading between clips and falling back to Idle.
 */
export class SeqPlayer {
  private tracks: THREE.Bone[][] = [];
  private cur: { s: AnimSeq; t: number; loop: boolean } | null = null;
  private prev: { s: AnimSeq; t: number; loop: boolean } | null = null;
  private fade = 0;
  private fadeLen = 0.12;
  speed = 1;

  constructor(private set: AnimSet, skeletons: Map<string, THREE.Bone>[]) {
    this.tracks = set.bones.map((n) => skeletons.map((m) => m.get(n)).filter((b): b is THREE.Bone => !!b));
    this.play('Idle', true, 0);
  }

  has(name: string) { return this.set.seqs.has(name.toLowerCase()); }

  /** Start a clip; one-shots return to Idle when they end. Returns false when the set has no such clip. */
  play(name: string, loop = false, fade = 0.1): boolean {
    const s = this.set.seqs.get(name.toLowerCase());
    if (!s) return false;
    this.prev = fade > 0 ? this.cur : null;
    this.cur = { s, t: 0, loop };
    this.fade = 0; this.fadeLen = fade;
    return true;
  }

  get playing(): string { return this.cur?.s.name ?? ''; }

  update(dt: number) {
    const c = this.cur;
    if (!c) return;
    c.t += dt * this.speed;
    if (this.prev) this.prev.t += dt * this.speed;
    if (!c.loop && c.t >= c.s.length) { if (!this.play('Idle', true, 0.15)) c.t = c.s.length; }
    const cur = this.cur!;
    this.fade = Math.min(1, this.fade + (this.fadeLen > 0 ? dt / this.fadeLen : 1));
    const w = this.prev ? this.fade : 1;
    if (w >= 1) this.prev = null;
    for (let b = 0; b < this.tracks.length; b++) {
      const bones = this.tracks[b];
      if (!bones.length || !sampleTrack(cur.s, b, cur.t, cur.loop, _sq, _sp)) continue;
      if (this.prev && sampleTrack(this.prev.s, b, this.prev.t, this.prev.loop, _fq, _fp)) { _fq.slerp(_sq, w); _sq.copy(_fq); _fp.lerp(_sp, w); _sp.copy(_fp); }
      for (const bone of bones) { bone.quaternion.copy(_sq); bone.position.copy(_sp); }
    }
  }
}
