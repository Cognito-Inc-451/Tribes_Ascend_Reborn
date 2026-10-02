import {
  BTN, CLASS_BY_ID, clamp, distSq, FALL_DAMAGE_THRESHOLD, GRAVITY, hlen, ITEMS, mulberry32, PAWN_GRAVITY_SCALE, VGS_BY_ID,
  type InputCmd, type Loadout, type Vec3,
} from '@ar/shared';
import type { BotDifficulty } from '../config.js';
import type { FlagState, Player } from './entities.js';
import type { Match } from './Match.js';

type Role = 'capper' | 'chaser' | 'defender' | 'offense' | 'sniper' | 'roamer' | 'farmer';

interface Skill { reaction: number; aimError: number; turn: number; lead: number; fireAngle: number; vgs: number }

const SKILL: Record<BotDifficulty, Skill> = {
  recruit: { reaction: 0.6, aimError: 0.09, turn: 3, lead: 0.4, fireAngle: 0.2, vgs: 0.3 },
  adept: { reaction: 0.4, aimError: 0.055, turn: 5, lead: 0.7, fireAngle: 0.14, vgs: 0.5 },
  veteran: { reaction: 0.25, aimError: 0.032, turn: 8, lead: 0.9, fireAngle: 0.09, vgs: 0.6 },
  elite: { reaction: 0.15, aimError: 0.018, turn: 12, lead: 1, fireAngle: 0.06, vgs: 0.6 },
  godlike: { reaction: 0.08, aimError: 0.008, turn: 20, lead: 1, fireAngle: 0.04, vgs: 0.6 },
};

const ROLE_LOADOUT: Record<Role, { cls: string; loadout: Partial<Loadout> }> = {
  capper: { cls: 'pathfinder', loadout: { primary: 'light_spinfusor', secondary: 'shotgun', belt: 'impact_nitron', pack: 'energy_recharge_pack', perkA: 'reach', perkB: 'ultra_capacitor_2' } },
  chaser: { cls: 'pathfinder', loadout: { primary: 'light_spinfusor', secondary: 'light_assault_rifle', belt: 'impact_nitron', pack: 'thrust_pack', perkA: 'safe_fall', perkB: 'ultra_capacitor_2' } },
  defender: { cls: 'brute', loadout: { primary: 'heavy_spinfusor', secondary: 'nova_colt', belt: 'fractal_grenade', pack: 'survival_pack', perkA: 'safe_fall', perkB: 'super_heavy' } },
  offense: { cls: 'raider', loadout: { primary: 'arx_buster', secondary: 'nj4_smg', belt: 'emp_grenade', pack: 'shield_pack', perkA: 'safe_fall', perkB: 'egocentric' } },
  sniper: { cls: 'sentinel', loadout: { primary: 'bxt1', secondary: 'falcon', belt: 'claymore', pack: 'energy_recharge_pack', perkA: 'safe_fall', perkB: 'ultra_capacitor_2' } },
  roamer: { cls: 'soldier', loadout: { primary: 'spinfusor', secondary: 'thumper_dx', belt: 'frag_xl', pack: 'energy_pack', perkA: 'safe_fall', perkB: 'ultra_capacitor_2' } },
  farmer: { cls: 'juggernaut', loadout: { primary: 'fusion_mortar', secondary: 'spinfusor_mkd', belt: 'heavy_ap', pack: 'regen_pack', perkA: 'safe_fall', perkB: 'egocentric' } },
};

export const BOT_NAMES = [
  'Vexwind', 'Ironclad', 'Skylark', 'Cinder', 'Halberd', 'Quasar', 'Thistle', 'Brimstone', 'Longshot', 'Nimbus', 'Rampart', 'Sable',
  'Tempest', 'Warden', 'Zephyr', 'Glacier', 'Harrier', 'Kestrel', 'Magpie', 'Obsidian', 'Pylon', 'Ricochet', 'Shale', 'Torrent',
  'Umbra', 'Vanta', 'Wisp', 'Yarrow', 'Anvil', 'Bramble', 'Comet', 'Drift',
];

export class BotBrain {
  role: Role = 'roamer';
  private skill: Skill;
  private rnd: () => number;
  private seq = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private target: Player | null = null;
  private targetSince = 0;
  private nextScan = 0;
  private lastPos: Vec3 = { x: 0, y: 0, z: 0 };
  private stuckCheck = 0;
  private unstickUntil = 0;
  private unstickDir = 1;
  private unstickBack = false;
  private wander: Vec3 | null = null;
  private nextVgs = 0;
  /** The current goal is a flag or flag stand: needs a precise pass, not just "get close". */
  private flagGoal = false;
  /** The goal is a fixed objective (stand, generator, capture point) that may need an indoor route. */
  private staticGoal = false;
  /** Following indoor waypoints: walk/jet precisely, no skiing. */
  private indoor = false;
  private routeKey = '';
  private routeIdx = 0;

  /** Steering target for a fixed objective: the route's entrance first, then its waypoints into the building. */
  private viaRoute(m: Match, p: Player, goal: Vec3): Vec3 {
    this.indoor = false;
    if (!this.staticGoal) return goal;
    const route = m.nav.route(goal);
    if (!route || route.length < 2) return goal;
    const key = `${Math.round(goal.x)},${Math.round(goal.y)},${Math.round(goal.z)}`;
    if (key !== this.routeKey) { this.routeKey = key; this.routeIdx = 0; }
    const pos = p.move.pos;
    const d3 = (a: Vec3) => Math.hypot(a.x - pos.x, a.y + 0.05 - pos.y, a.z - pos.z);
    // Distance to the segment we are walking (waypoints can be far apart on long straight corridors).
    const segDist = (a: Vec3, b: Vec3) => {
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const t = clamp(((pos.x - a.x) * abx + (pos.y - a.y) * aby + (pos.z - a.z) * abz) / Math.max(1e-6, abx * abx + aby * aby + abz * abz), 0, 1);
      return Math.hypot(a.x + abx * t - pos.x, a.y + aby * t - pos.y, a.z + abz * t - pos.z);
    };
    if (this.routeIdx > 0 && segDist(route[this.routeIdx - 1], route[this.routeIdx]) > 10) {
      // Knocked off the route: resume at the nearest waypoint we can see.
      let best = 0, bd = Infinity;
      route.forEach((w, i) => { const d = d3(w); if (d < bd && !m.world.raycast(p.eye(), { x: w.x, y: w.y + 1, z: w.z }, undefined, false)) { bd = d; best = i; } });
      this.routeIdx = best;
    }
    while (this.routeIdx < route.length - 1 && d3(route[this.routeIdx]) < 2.4) this.routeIdx++;
    if (this.routeIdx === 0) {
      if (d3(route[0]) > 5) return route[0];
      this.routeIdx = 1;
    }
    this.indoor = true;
    return route[this.routeIdx];
  }

  constructor(readonly difficulty: BotDifficulty, seed: number) {
    this.skill = SKILL[difficulty];
    this.rnd = mulberry32(seed);
  }

  chooseRole(m: Match, p: Player) {
    const mode = m.mode.id;
    const mates = [...m.players.values()].filter((o) => o !== p && o.isBot && o.team === p.team).map((o) => o.brain!.role);
    const count = (r: Role) => mates.filter((x) => x === r).length;
    let role: Role = 'roamer';
    if (mode === 'ctf' || mode === 'blitz') {
      if (count('capper') < 2) role = 'capper';
      else if (count('defender') < 1) role = 'defender';
      else if (count('chaser') < 1) role = 'chaser';
      else if (mode === 'ctf' && count('offense') < 1) role = 'offense';
      else if (mode === 'ctf' && count('farmer') < 1) role = 'farmer';
      else role = this.rnd() < 0.5 ? 'roamer' : 'chaser';
    } else if (mode === 'arena') role = this.rnd() < 0.3 ? 'chaser' : 'roamer';
    else if (mode === 'cah') role = count('defender') < 2 ? 'defender' : 'roamer';
    else role = this.rnd() < 0.2 ? 'sniper' : this.rnd() < 0.5 ? 'chaser' : 'roamer';
    this.role = role;
    const lo = ROLE_LOADOUT[role];
    m.setClass(p, CLASS_BY_ID[lo.cls].id, lo.loadout);
  }

  private say(m: Match, p: Player, id: string, chance = 1) {
    if (this.rnd() > chance * this.skill.vgs || m.now < this.nextVgs) return;
    const leaf = VGS_BY_ID[id];
    if (!leaf) return;
    this.nextVgs = m.now + 4 + this.rnd() * 6;
    m.io.broadcast({ t: 'vgs', from: p.id, name: p.name, id, team: !leaf.global, voice: p.cosmetics.voice, bot: true }, leaf.global ? undefined : (o) => o.team === p.team);
  }

  onKill(m: Match, self: Player, victim: Player, killer: Player | null) {
    if (victim === self) { this.target = null; if (this.rnd() < 0.15) this.say(m, self, 'GlobalShazbot'); }
    else if (killer === self && this.rnd() < 0.05) this.say(m, self, this.rnd() < 0.5 ? 'GlobalTauntBrag' : 'GlobalWoohoo');
    else if (killer && killer !== self && killer.team === self.team && victim.flag === null && this.rnd() < 0.03) this.say(m, self, 'GlobalComplimentGreatShot');
  }

  onFlagEvent(m: Match, self: Player, kind: 'grab' | 'cap', f: FlagState, who: Player) {
    if (who === self && kind === 'grab') this.say(m, self, 'FlagIHave', 0.9);
    else if (kind === 'grab' && f.team === self.team && this.role === 'chaser') this.say(m, self, 'FlagSelfRetrieve', 0.5);
    else if (kind === 'cap' && who.team === self.team && who !== self) this.say(m, self, 'GlobalComplimentNiceMove', 0.3);
  }

  think(m: Match, p: Player): InputCmd {
    const cmd: InputCmd = { seq: ++this.seq, fwd: 0, strafe: 0, yaw: this.aimYaw, pitch: this.aimPitch, buttons: 0, weapon: 0 };
    if (!p.alive) { cmd.buttons = BTN.FIRE; return cmd; }
    const now = m.now;
    const pos = p.move.pos;

    if (now >= this.nextScan) {
      this.nextScan = now + 0.25 + this.rnd() * 0.1;
      this.scanTargets(m, p);
    }

    const objective = this.goal(m, p);
    const goal = objective ? this.viaRoute(m, p, objective) : null;
    const eye = p.eye();
    const w = p.weapon;
    let fire = false;
    let desiredYaw = this.aimYaw, desiredPitch = 0;

    if (this.target && this.target.alive && now - this.targetSince > this.skill.reaction) {
      const t = this.target;
      const d = w.def;
      const tc = { x: t.move.pos.x, y: t.move.pos.y + (t.move.onGround && d.projectile?.radius ? 0.2 : t.phys.height * 0.55), z: t.move.pos.z };
      let aimPt = tc;
      if (d.projectile) {
        const pr = d.projectile;
        let tt = Math.sqrt(distSq(eye, tc)) / pr.speed;
        for (let i = 0; i < 4; i++) {
          aimPt = {
            x: tc.x + (t.move.vel.x * this.skill.lead - p.move.vel.x * pr.inherit) * tt,
            y: tc.y + (t.move.vel.y * this.skill.lead * (t.move.onGround ? 0 : 1) - p.move.vel.y * pr.inherit) * tt + 0.5 * GRAVITY * pr.gravity * tt * tt,
            z: tc.z + (t.move.vel.z * this.skill.lead - p.move.vel.z * pr.inherit) * tt,
          };
          tt = Math.sqrt(distSq(eye, aimPt)) / pr.speed;
        }
      }
      const dx = aimPt.x - eye.x, dy = aimPt.y - eye.y, dz = aimPt.z - eye.z;
      desiredYaw = Math.atan2(-dx, -dz) + (this.rnd() - 0.5) * this.skill.aimError * 2;
      desiredPitch = Math.atan2(dy, Math.hypot(dx, dz)) + (this.rnd() - 0.5) * this.skill.aimError * 2;
      const dist = Math.hypot(dx, dy, dz);
      const range = d.hitscan ? d.hitscan.range * 0.8 : d.projectile ? d.projectile.speed * 2.5 : 5;
      const err = Math.abs(angDiff(this.aimYaw, desiredYaw)) + Math.abs(this.aimPitch - desiredPitch);
      fire = err < this.skill.fireAngle + 0.02 && dist < range;
      if (dist < 12 && p.weapons[1] && ['hitscan', 'burst'].includes(p.weapons[1].def.kind)) cmd.weapon = 1;
      if (dist < 25 && p.beltCount > 0 && this.rnd() < 0.01) cmd.buttons |= BTN.BELT;
      if (dist < 2.5) cmd.buttons |= BTN.MELEE;
      if (this.role === 'sniper' && dist > 40) cmd.buttons |= BTN.ZOOM;
    } else if (goal) {
      desiredYaw = Math.atan2(-(goal.x - pos.x), -(goal.z - pos.z));
      desiredPitch = -0.05;
    }

    // Smooth aim at the bot's turn rate.
    const maxTurn = this.skill.turn / 60;
    this.aimYaw += clamp(angDiff(this.aimYaw, desiredYaw), -maxTurn, maxTurn);
    this.aimPitch += clamp(desiredPitch - this.aimPitch, -maxTurn, maxTurn);
    this.aimPitch = clamp(this.aimPitch, -1.4, 1.4);
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;
    if (fire && w.clip > 0) cmd.buttons |= BTN.FIRE;
    if (w.def.spinup && this.target) cmd.buttons |= BTN.FIRE;
    if (w.def.kind === 'repair') cmd.weapon = 0;

    if (goal) this.navigate(m, p, goal, cmd);
    if (p.pending && this.rnd() < 0.005) cmd.buttons |= BTN.USE;
    return cmd;
  }

  private scanTargets(m: Match, p: Player) {
    const eye = p.eye();
    let best: Player | null = null, bestScore = Infinity;
    const range = this.role === 'sniper' ? 450 : this.role === 'farmer' ? 300 : 220;
    for (const o of m.players.values()) {
      if (!o.alive || !m.isEnemy(p, o) || o.spectator) continue;
      const d2 = distSq(o.move.pos, p.move.pos);
      if (d2 > range * range) continue;
      const stealthed = o.packActive && o.loadout.pack === 'stealth_pack' && hlen(o.move.vel) < 40;
      if (stealthed && d2 > 30 * 30) continue;
      let score = d2;
      if (o.flag) score *= 0.2;
      if (score >= bestScore) continue;
      if (m.world.raycast(eye, { x: o.move.pos.x, y: o.move.pos.y + 1.2, z: o.move.pos.z })) continue;
      best = o; bestScore = score;
    }
    if (best !== this.target) { this.target = best; this.targetSince = m.now; }
  }

  private goal(m: Match, p: Player): Vec3 | null {
    const mode = m.mode.id;
    const own = m.flags.find((f) => f.team === p.team);
    const enemy = m.flags.find((f) => f.team !== p.team && f.team !== 255);
    this.flagGoal = false;
    this.staticGoal = false;
    if (mode === 'ctf' || mode === 'blitz') {
      if (p.flag && own) { this.flagGoal = true; this.staticGoal = true; return own.home; }
      if (this.role === 'chaser' || this.role === 'defender') {
        if (own && own.state === 1 && own.carrier) return own.carrier.move.pos;
        if (own && own.state === 2) { this.flagGoal = true; return own.pos; }
        if (this.role === 'defender' && own) return this.patrol(m, own.home, 25);
      }
      // Anyone near a dropped own flag returns it.
      if (own && own.state === 2 && distSq(own.pos, p.move.pos) < 120 * 120) { this.flagGoal = true; return own.pos; }
      if (this.role === 'offense') {
        const gen = m.assets.find((a) => a.type === 'generator' && a.team !== p.team && !a.destroyed);
        if (gen) { this.staticGoal = true; return gen.pos; }
      }
      if (this.role === 'farmer') {
        const stand = enemy?.home;
        if (stand) return this.patrol(m, { x: (stand.x + (own?.home.x ?? stand.x)) / 2, y: stand.y, z: (stand.z + (own?.home.z ?? stand.z)) / 2 }, 60);
      }
      if (enemy && enemy.state !== 1) { this.flagGoal = true; this.staticGoal = enemy.state === 0; return enemy.pos; }
      if (enemy?.carrier && enemy.carrier.team === p.team && own) return this.patrol(m, own.home, 60);
      return this.target?.move.pos ?? this.patrol(m, m.flags[0]?.pos ?? p.move.pos, 200);
    }
    if (mode === 'cah') {
      const pts = m.assets.filter((a) => a.type === 'cap_point');
      const want = pts.filter((a) => a.capTeam !== p.team).sort((a, b) => distSq(a.pos, p.move.pos) - distSq(b.pos, p.move.pos));
      if (this.role === 'defender') {
        const mine = pts.filter((a) => a.capTeam === p.team).sort((a, b) => distSq(a.pos, p.move.pos) - distSq(b.pos, p.move.pos));
        if (mine.length) { this.staticGoal = true; return mine[0].pos; }
      }
      if (want.length) { this.staticGoal = true; return want[0].pos; }
      if (pts[0]) this.staticGoal = true;
      return pts[0]?.pos ?? null;
    }
    if (mode === 'rabbit' || mode === 'tdm') {
      const f = m.flags[0];
      if (f?.active && f.state !== 1) { this.flagGoal = true; return f.pos; }
      if (f?.carrier && f.carrier !== p && m.isEnemy(p, f.carrier)) return f.carrier.move.pos;
    }
    if (this.target) return this.target.move.pos;
    let nearest: Player | null = null, nd = Infinity;
    for (const o of m.players.values()) {
      if (!o.alive || !m.isEnemy(p, o)) continue;
      const d = distSq(o.move.pos, p.move.pos);
      if (d < nd) { nd = d; nearest = o; }
    }
    return nearest?.move.pos ?? this.patrol(m, p.move.pos, 150);
  }

  private patrol(m: Match, center: Vec3, radius: number): Vec3 {
    if (!this.wander || distSq(this.wander, center) > radius * radius * 1.5 || distSq(this.wander, center) < 1) {
      const a = this.rnd() * Math.PI * 2, r = radius * (0.3 + this.rnd() * 0.7);
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      this.wander = { x, y: m.world.terrain.heightAt(x, z), z };
    }
    return this.wander;
  }

  private heading = 0;
  private nextSteer = 0;

  /** Whisker steering: keep the direct heading if clear, else pick the most open direction biased toward the goal. */
  private steer(m: Match, p: Player, goal: Vec3, goalYaw: number, dist: number): number {
    const pos = p.move.pos;
    const eye = { x: pos.x, y: pos.y + 1.1, z: pos.z };
    const probe = (a: number, len: number) => {
      const to = { x: eye.x - Math.sin(a) * len, y: eye.y, z: eye.z - Math.cos(a) * len };
      const hit = m.world.raycast(eye, to);
      return hit && hit.normal.y < 0.6 ? hit.t * len : len;
    };
    const want = Math.min(14, dist);
    // Final approach to a flag: re-aim every tick (at capping speed 0.3 s is 10 m of drift).
    if ((this.flagGoal || this.indoor) && dist < 60 && (this.indoor || m.now < this.nextSteer ? true : probe(goalYaw, want) >= want - 0.5)) { this.heading = goalYaw; return goalYaw; }
    if (m.now < this.nextSteer) return this.heading;
    this.nextSteer = m.now + 0.3;
    if (probe(goalYaw, want) >= want - 0.5 || goal.y > pos.y + 20) { this.heading = goalYaw; return goalYaw; }
    let best = goalYaw, bestScore = -Infinity;
    for (let i = 0; i < 16; i++) {
      const a = goalYaw + (i / 16) * Math.PI * 2;
      const score = probe(a, 14) * (1.3 + Math.cos(a - goalYaw));
      if (score > bestScore) { bestScore = score; best = a; }
    }
    this.heading = best;
    return best;
  }

  private navigate(m: Match, p: Player, goal: Vec3, cmd: InputCmd) {
    const pos = p.move.pos;
    const dx = goal.x - pos.x, dz = goal.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (this.wander && dist < 6) this.wander = null;
    let goalYaw = this.steer(m, p, goal, Math.atan2(-dx, -dz), dist);
    // Near a flag, steer the velocity rather than the heading so sideways drift is cancelled instead of orbiting the stand.
    if ((this.flagGoal || this.indoor) && dist < 45 && dist > 0.5) {
      const want = this.indoor ? Math.max(5, Math.min(14, dist * 1.5)) : Math.max(6, Math.min(40, dist * 1.2));
      const ex = (dx / dist) * want - p.move.vel.x, ez = (dz / dist) * want - p.move.vel.z;
      if (Math.hypot(ex, ez) > 1) goalYaw = Math.atan2(-ex, -ez);
    }
    const delta = goalYaw - cmd.yaw;
    let fwd = Math.cos(delta), strafe = -Math.sin(delta);
    const now = m.now;

    if (now > this.stuckCheck) {
      const moved = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
      if (moved < 2 && dist > 8) {
        this.unstickUntil = now + 1.5;
        this.unstickDir = this.rnd() < 0.5 ? -1 : 1;
        const eye = { x: pos.x, y: pos.y + 1.5, z: pos.z };
        this.unstickBack = !!m.world.raycast(eye, { x: eye.x, y: eye.y + 5, z: eye.z });
      }
      this.lastPos = { ...pos };
      this.stuckCheck = now + 2.5;
    }
    if (now < this.unstickUntil) {
      if (this.unstickBack) { fwd = -1; strafe = this.unstickDir * 0.4; }
      else { strafe = this.unstickDir; fwd = -0.3; }
    }

    const speed = hlen(p.move.vel);
    const t = m.world.terrain;
    const hdx = dx / (dist || 1), hdz = dz / (dist || 1);
    const ahead = t.heightAt(pos.x + hdx * 25, pos.z + hdz * 25);
    const here = t.heightAt(pos.x, pos.z);
    const downhill = ahead < here - 1;
    const energyFrac = p.move.energy / p.maxEnergy;
    let buttons = cmd.buttons;

    if (!this.indoor && dist > 25 && (downhill || speed > p.phys.runSpeed * 1.4)) buttons |= BTN.SKI;
    // Approach elevated objectives (roof flags) from the air, like human cappers.
    const approachAlt = dist < 90 && dist > 6 && goal.y > here + 3 ? goal.y + 2.5 : -Infinity;
    let climb = this.indoor ? goal.y - pos.y > 1.2 : goal.y - pos.y > 6 || ahead - here > 4 || pos.y < approachAlt;
    let brake = false;
    if (this.flagGoal && !this.indoor && dist < 220) {
      // Plan the pass: arrive slightly above the flag and let gravity bring us onto it.
      const g = GRAVITY * PAWN_GRAVITY_SCALE;
      const t = dist / Math.max(8, speed);
      const dy = pos.y - (goal.y + 1);
      const fall = -p.move.vel.y * t + 0.5 * g * t * t;
      climb = pos.y < goal.y + 1 + Math.min(25, dist * 0.1) && dy < fall + 1;
      brake = dist < 70 && !p.move.onGround && dy > fall + 2.5;
    }
    const underRoof = now < this.unstickUntil && this.unstickBack;
    const minEnergy = this.flagGoal && dist < 50 ? 0.03 : 0.25;
    if (underRoof) buttons &= ~BTN.JET;
    else if (now < this.unstickUntil) buttons |= BTN.JET;
    else if (brake) buttons &= ~BTN.JET;
    else if (p.move.onGround && climb && energyFrac > Math.max(minEnergy, 0.1) + 0.1) buttons |= BTN.JET;
    else if (!p.move.onGround && energyFrac > minEnergy && (climb || (!this.flagGoal && dist > 80 && speed < 25))) buttons |= BTN.JET;
    else if (p.move.jetting && energyFrac > 0.1 && goal.y - pos.y > 2) buttons |= BTN.JET;
    if (brake) { fwd = -Math.cos(goalYaw - cmd.yaw) * 0.7; strafe = Math.sin(goalYaw - cmd.yaw) * 0.7; }
    // Brake a hard landing with jets when fall damage would apply.
    const vy = p.move.vel.y;
    if (!p.move.onGround && vy < -(FALL_DAMAGE_THRESHOLD - 8) && !p.hasPerk('safe_fall') && pos.y - here < -vy * 1.5) buttons |= BTN.JET;

    // Wall ahead: hop over it.
    if (this.seq % 10 === 0 && dist > 5) {
      const eye = { x: pos.x, y: pos.y + 1.2, z: pos.z };
      if (m.world.raycast(eye, { x: eye.x + hdx * 6, y: eye.y, z: eye.z + hdz * 6 })) { buttons |= BTN.JET | BTN.JUMP; }
    }
    // Arrive gently at close goals (defenders, cappers turning home).
    if (dist < 12 && !p.flag) { fwd *= 0.5; strafe *= 0.5; buttons &= ~BTN.SKI; }

    if (p.flag && (m.mode.id === 'tdm') && this.target && Math.sqrt(distSq(this.target.move.pos, pos)) < 20 && this.rnd() < 0.002) buttons |= BTN.DROP_FLAG;
    if (ITEMS[p.loadout.pack]?.kind === 'toggle' && ['shield_pack', 'stealth_pack'].includes(p.loadout.pack)) {
      const want = this.target !== null ? p.loadout.pack === 'shield_pack' : p.loadout.pack === 'stealth_pack';
      if (want !== p.packActive && this.seq % 30 === 0 && energyFrac > 0.4) buttons |= BTN.PACK;
    }
    cmd.fwd = clamp(fwd, -1, 1);
    cmd.strafe = clamp(strafe, -1, 1);
    cmd.buttons = buttons;
  }
}

function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
