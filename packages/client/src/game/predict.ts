import {
  advanceProjectile, applyKnockback, ARMOR_PHYSICS, BTN, CLASSES, dirFromAngles, DT, FLAG_DRAG_KMH, ITEMS, loadoutStats, newMoveState, PF, quantizeInput,
  splashKnockback, stepMovement,
  type ClassDef, type CollisionWorld, type InputCmd, type Loadout, type MoveParams, type MoveState, type PlayerSnap, type ProjectileDef,
  type ProjState, type SelfSnap, type Vec3,
} from '@ar/shared';

interface LocalProj { st: ProjState; def: ProjectileDef; vid: number }

/** Client-side prediction of the local player with server reconciliation. */
export class Predictor {
  state: MoveState = newMoveState({ x: 0, y: 0, z: 0 });
  pending: InputCmd[] = [];
  seq = 1;
  cls: ClassDef = CLASSES[0];
  loadout: Loadout = CLASSES[0].defaultLoadout;
  private stats = loadoutStats(CLASSES[0], CLASSES[0].defaultLoadout);
  hasFlag = false;
  private rage = false;
  team = 0;
  alive = false;
  /** Visual error offset blended out after corrections. */
  errorOffset: Vec3 = { x: 0, y: 0, z: 0 };
  corrections = 0;
  lastCorrection = 0;
  /** Own explosive shots simulated locally so disc jumps respond instantly. */
  private shots: LocalProj[] = [];
  private nextVid = -1;
  /** Own predicted projectiles: drawn instead of the server's copies, which start from an older position. */
  get localShots(): readonly LocalProj[] { return this.shots; }
  /** Predicted knockback per input seq, re-applied when replaying unacknowledged inputs. */
  private kicks = new Map<number, Vec3>();
  private nextFire = [0, 0];
  private clip = [1, 1];
  private slot = 0;
  private clock = 0;
  private beltNext = 0;
  private beltCount = 0;
  private beltHeld = false;

  constructor(public world: CollisionWorld, private infiniteEnergy = false) {}

  setLoadout(clsId: string, lo: Loadout) {
    this.cls = CLASSES.find((c) => c.id === clsId) ?? CLASSES[0];
    this.loadout = lo;
    this.stats = loadoutStats(this.cls, lo, 0, ITEMS[lo.pack]?.passive ?? {});
  }

  params(): MoveParams {
    return {
      phys: ARMOR_PHYSICS[this.cls.armor], maxEnergy: this.stats.maxEnergy, regenMult: this.stats.regenMult,
      runMult: this.stats.runMult * (this.rage ? 1.25 : 1), massMult: this.stats.massMult,
      flagDragSpeed: this.hasFlag ? FLAG_DRAG_KMH[this.cls.armor] / 3.6 : 0, canJet: true, team: this.team, infiniteEnergy: this.infiniteEnergy,
    };
  }

  step(raw: InputCmd): InputCmd {
    const cmd = quantizeInput({ ...raw, seq: this.seq++ });
    this.clock += DT;
    if (this.alive) {
      stepMovement(this.state, cmd, this.params(), this.world, DT);
      this.predictShots(cmd);
    }
    this.pending.push(cmd);
    if (this.pending.length > 180) this.pending.shift();
    return cmd;
  }

  private predictShots(cmd: InputCmd) {
    const slot = cmd.weapon & 1;
    if (slot !== this.slot) { this.slot = slot; this.nextFire[slot] = Math.max(this.nextFire[slot], this.clock + 0.35); }
    const item = ITEMS[slot === 0 ? this.loadout.primary : this.loadout.secondary];
    const pd = item?.projectile;
    if ((cmd.buttons & BTN.FIRE) && pd && pd.radius > 0 && pd.impulse > 0 && !item.spinup && !item.burst && this.clock >= this.nextFire[slot] && this.clip[slot] > 0) {
      this.nextFire[slot] = this.clock + item.refire;
      this.clip[slot]--;
      this.launch(item.id, pd, cmd, dirFromAngles(cmd.yaw, cmd.pitch));
    }
    // Belt grenades too (same toss as the server), so nade jumps respond instantly.
    const beltDown = (cmd.buttons & BTN.BELT) !== 0, beltEdge = beltDown && !this.beltHeld;
    this.beltHeld = beltDown;
    const belt = ITEMS[this.loadout.belt], bd = belt?.projectile;
    if (beltEdge && bd && bd.radius > 0 && bd.impulse > 0 && !bd.sticky && !bd.remote && this.beltCount > 0 && this.clock >= this.beltNext) {
      this.beltNext = this.clock + belt.refire;
      this.beltCount--;
      const d = dirFromAngles(cmd.yaw, cmd.pitch), l = Math.hypot(d.x, d.y + 0.12, d.z);
      this.launch(belt.id, bd, cmd, { x: d.x / l, y: (d.y + 0.12) / l, z: d.z / l });
    }
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const sh = this.shots[i];
      const res = advanceProjectile(sh.st, sh.def, this.world, DT);
      if (res.vanish) { this.shots.splice(i, 1); continue; }
      if (!res.explode) continue;
      this.shots.splice(i, 1);
      if (sh.def.remote) continue;
      const ph = ARMOR_PHYSICS[this.cls.armor];
      const kick = splashKnockback(sh.st.pos, this.state.pos, ph.height, sh.def.radius, sh.def.impulse, ph.mass * this.stats.massMult, true, sh.def.knockMin, sh.def.selfLift);
      if (kick) { this.applyKick(kick); this.kicks.set(cmd.seq, kick); }
    }
  }

  /** Spawn a predicted projectile from the same muzzle the server uses (Match.aim). */
  private launch(item: string, pd: ProjectileDef, cmd: InputCmd, dir: Vec3) {
    const s = this.state, h = ARMOR_PHYSICS[this.cls.armor].height;
    const aim = dirFromAngles(cmd.yaw, cmd.pitch);
    const rx = Math.cos(cmd.yaw), rz = -Math.sin(cmd.yaw);
    const pos = { x: s.pos.x + aim.x * 0.6 + rx * 0.25, y: s.pos.y + h * 0.9 - 0.15 + aim.y * 0.6, z: s.pos.z + aim.z * 0.6 + rz * 0.25 };
    const vel = { x: dir.x * pd.speed + s.vel.x * pd.inherit, y: dir.y * pd.speed + s.vel.y * pd.inherit, z: dir.z * pd.speed + s.vel.z * pd.inherit };
    this.shots.push({ def: pd, vid: this.nextVid--, st: { id: 0, owner: -1, team: this.team, item, pos, vel, age: 0, bounces: 0, stuck: false, stuckTo: -1, stuckOffset: { x: 0, y: 0, z: 0 }, resting: false, homingTarget: -1 } });
  }

  private applyKick(k: Vec3) {
    applyKnockback(this.state, k);
  }

  reconcile(me: PlayerSnap, self: SelfSnap, now: number) {
    this.hasFlag = (me.flags & PF.HAS_FLAG) !== 0;
    this.rage = (me.flags & PF.RAGE) !== 0;
    const wasAlive = this.alive;
    this.alive = (me.flags & PF.ALIVE) !== 0 && (me.flags & PF.IN_VEHICLE) === 0;
    this.pending = this.pending.filter((c) => c.seq > self.ackSeq);
    for (const k of this.kicks.keys()) if (k <= self.ackSeq) this.kicks.delete(k);
    for (let i = 0; i < 2; i++) if (self.ammo[i]) this.clip[i] = Math.max(this.clip[i], self.ammo[i][0]);
    if (self.ammo[2]) this.beltCount = Math.max(this.beltCount, self.ammo[2][0]);
    if (!this.alive) { this.shots.length = 0; this.kicks.clear(); }
    const before = { ...this.state.pos };
    const s = this.state;
    s.pos = { ...me.pos };
    s.vel = { ...me.vel };
    s.energy = self.energy;
    s.onGround = (self.prevButtons & 0x8000) !== 0;
    s.prevButtons = self.prevButtons & 0x7fff;
    s.groundNormal = { x: self.gnX, y: self.gnY, z: self.gnZ };
    s.jetting = (me.flags & PF.JETTING) !== 0;
    s.skiing = (me.flags & PF.SKIING) !== 0;
    if (this.alive) for (const c of this.pending) {
      stepMovement(s, c, this.params(), this.world, DT);
      const k = this.kicks.get(c.seq);
      if (k) this.applyKick(k);
    }
    const ex = before.x - s.pos.x, ey = before.y - s.pos.y, ez = before.z - s.pos.z;
    const err = Math.hypot(ex, ey, ez);
    if (!wasAlive || err > 8) this.errorOffset = { x: 0, y: 0, z: 0 };
    else if (err > 0.02) {
      this.errorOffset = { x: this.errorOffset.x + ex, y: this.errorOffset.y + ey, z: this.errorOffset.z + ez };
      if (err > 0.25) { this.corrections++; this.lastCorrection = now; }
    }
  }

  renderPos(dt: number): Vec3 {
    // Decay the prediction error gently. A fast decay (12/s) drains the offset in a few frames, and with a
    // server snapshot every 50ms the residual error arrives as a fresh step each time - on flat ground, where
    // the server's terrain snap pins the player to exactly h, the per-snapshot error is a repeating vertical
    // tick, which the player sees as a vibration while walking. Slower decay spreads each correction over
    // ~0.3s so consecutive corrections blend into one smooth glide.
    const k = Math.exp(-dt * 4.5);
    // Horizontal error is a position correction the eye should absorb quickly. Vertical error on a flat floor is
    // mostly the server re-snapping the player to the terrain height, so a fast decay turns each 50ms snapshot
    // into a visible up/down tick (walking vibration). Bleed the vertical component out slowly so consecutive
    // snaps blend into one smooth glide.
    const ky = Math.exp(-dt * 1.1);
    this.errorOffset = { x: this.errorOffset.x * k, y: this.errorOffset.y * ky, z: this.errorOffset.z * k };
    return { x: this.state.pos.x + this.errorOffset.x, y: this.state.pos.y + this.errorOffset.y, z: this.state.pos.z + this.errorOffset.z };
  }
}

export const buttonsFrom = (h: (b: keyof typeof BTN) => boolean): number => {
  let b = 0;
  for (const k of Object.keys(BTN) as (keyof typeof BTN)[]) if (h(k)) b |= BTN[k];
  return b;
};
