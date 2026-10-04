import {
  ASSETS, assetDamageMult, BTN, CALLINS, CLASS_BY_ID, CLASSES, clamp, CREDITS, dirFromAngles, distSq, distToCapsule, DT, encodeSnapshot,
  FALL_DAMAGE_PER_MS, FALL_DAMAGE_THRESHOLD, FLAG_DRAG_KMH, FLAG_GRAB_RADIUS, FLAG_RETURN_TIME, FLAG_THROW_SPEED, GRAVITY,
  HEALTH_REGEN_DELAY, HEALTH_REGEN_RATE, hitscanFalloff, ITEM_INDEX, ITEMS, loadoutStats, makeOBB, MELEE, MODES, mulberry32, newMoveState, PF,
  PHASE, projDef, RESPAWN_TIME, SHOCKLANCE_BACK_MULT, segmentVsCapsule, splashDamage, splashKnockback, applyKnockback, stepMovement, THEMES, validateLoadout,
  VEHICLES, advanceProjectile, AF, ASSET_TYPES, VEHICLE_TYPES, UU_PER_METER,
  type AssetType, type CallInType, type InputCmd, type ItemDef, type Loadout, type MapEntity, type ModeDef, type MoveParams,
  type PlayerSnap, type ProjState, type ProjectileDef, type S2C, type Snapshot, type Vec3, type VehicleType, inVolume, type MapVolume,
} from '@ar/shared';
import type { ServerConfig } from '../config.js';
import { makeWeapon, Player, type Asset, type FlagState, type Vehicle } from './entities.js';
import type { LoadedMap } from './maps.js';
import { IndoorRoutes } from './nav.js';

export interface MatchIO {
  broadcast(msg: S2C, filter?: (p: Player) => boolean): void;
  send(p: Player, msg: S2C): void;
  onMatchOver(winner: number): void;
}

interface LiveProj extends ProjState { def: ProjectileDef; prev: Vec3; explosive: boolean; isDisc: boolean; fractal?: { t: number; base: Vec3; next: number } }

const SELF_DAMAGE = 0.5;
const INTERP_DELAY = 0.1;
const MAX_REWIND = 0.35;
const TEAM_ENEMY = (a: number, b: number) => a !== b;

export class Match {
  now = 0;
  tick = 0;
  readonly mode: ModeDef;
  players = new Map<number, Player>();
  projectiles = new Map<number, LiveProj>();
  assets: Asset[] = [];
  vehicles: Vehicle[] = [];
  flags: FlagState[] = [];
  scores: [number, number] = [0, 0];
  phase: number = PHASE.WARMUP;
  phaseEnd = 0;
  roundWins: [number, number] = [0, 0];
  tickets: [number, number] = [0, 0];
  private rng = mulberry32(1234);
  private nextProj = 1;
  private nextAsset = 1;
  private nextVeh = 1;
  private strikes: { at: number; kind: CallInType; pos: Vec3; team: number; owner: number }[] = [];
  private callInCooldown = new Map<string, number>();
  private killZ: number;
  private hazardY: number;
  /** Water maps (no lava): TA lets you swim there, we have no swimming, so the sea returns you to land instead of killing. */
  private waterRescue: boolean;
  readonly nav: IndoorRoutes;
  /** Inventory stations bots go back to when their main weapon runs dry, per team. */
  readonly restock: [Vec3[], Vec3[]] = [[], []];

  constructor(readonly cfg: ServerConfig, readonly map: LoadedMap, readonly io: MatchIO) {
    this.mode = { ...MODES[cfg.mode] };
    this.world.gravityScale = cfg.options?.gravity ?? 1;
    if (cfg.options?.timeLimit !== undefined) this.mode.timeLimit = cfg.options.timeLimit;
    if (cfg.options?.scoreLimit !== undefined) this.mode.scoreLimit = cfg.options.scoreLimit;
    const theme = THEMES[map.data.theme];
    this.killZ = map.data.killZ ?? -Infinity;
    this.hazardY = theme.hazard && map.source === 'reborn' ? theme.hazard.level : -Infinity;
    const fx = new Set((map.data.meshes ?? []).flatMap((m) => (m.groups ?? []).map((g) => g.fx)));
    this.waterRescue = map.source === 'original' && fx.has('water') && !fx.has('lava');
    this.initEntities();
    if (this.mode.id === 'cah') this.setupCaH();
    this.nav = new IndoorRoutes(this.world);
    // Bots need routes into base interiors (generator rooms, CaH points, roofed flag stands).
    for (const a of this.assets) if (a.type === 'generator' || a.type === 'cap_point') this.nav.prepare(a.pos);
    for (const f of this.flags) this.nav.prepare(f.home);
    // Where bots restock: the team's inventory stations closest to its flag that bots can find a way to.
    for (const t of [0, 1]) {
      const home = this.flags.find((f) => f.team === t)?.home;
      const st = this.assets.filter((a) => a.type === 'inventory' && a.team === t);
      if (home) st.sort((a, b) => distSq(a.pos, home) - distSq(b.pos, home));
      // Indoor stations need a route in; outdoor ones (no route needed) are fine as they are. Bots drop a station they cannot reach.
      this.restock[t] = st.filter((a) => { if (this.nav.openSky(a.pos)) return true; this.nav.prepare(a.pos); return !!this.nav.route(a.pos); }).slice(0, 3).map((a) => a.pos);
    }
    this.phase = PHASE.WARMUP;
    this.phaseEnd = this.mode.id === 'training' ? Infinity : 10;
  }

  get world() { return this.map.world; }
  get entities(): MapEntity[] { return this.map.data.entities; }

  // ------------------------------------------------------------------ setup
  private initEntities() {
    const m = this.mode.id;
    for (const e of this.entities) {
      const def = ASSETS[e.kind as AssetType];
      if (!def || e.kind === 'flag_stand') continue;
      if (!this.mode.usesBases && ['generator', 'base_turret', 'radar', 'vehicle_pad'].includes(e.kind)) continue;
      if (e.kind === 'vehicle_pad' && this.cfg.options?.vehicles === false) continue;
      if (e.kind === 'cap_point' && m !== 'cah') continue;
      this.addAsset(e.kind as AssetType, e.team, this.onFloor(e.kind, e.pos), e.yaw, -1, e.tag);
    }
    const stands = (team: number, kind: 'flag_stand' | 'blitz_stand') => this.entities.filter((e) => e.kind === kind && e.team === team).map((e) => ({ ...e.pos }));
    if (m === 'ctf' || m === 'blitz') {
      for (const team of [0, 1]) {
        let list = stands(team, m === 'blitz' ? 'blitz_stand' : 'flag_stand');
        if (!list.length) list = stands(team, 'flag_stand');
        if (!list.length) list = [this.teamCentroid(team)];
        this.flags.push(this.makeFlag(team, list));
      }
    } else if (m === 'rabbit' || m === 'tdm') {
      const rf = this.entities.find((e) => e.kind === 'rabbit_flag');
      const home = rf ? { ...rf.pos } : this.mapCenter();
      const f = this.makeFlag(255, [home]);
      f.active = m === 'rabbit';
      this.flags.push(f);
    }
    if (m === 'arena') this.tickets = [this.mode.respawnTickets ?? 25, this.mode.respawnTickets ?? 25];
  }

  /** TA's goal score is 100 per control point (300/400/500); neutral defences and stations join the nearest point's owner. */
  private setupCaH() {
    const points = this.assets.filter((a) => a.type === 'cap_point');
    if (!points.length) return;
    const opt = this.cfg.options?.scoreLimit;
    if (opt === undefined || opt === MODES.cah.scoreLimit) this.mode.scoreLimit = Math.max(3, points.length) * 100;
    for (const a of this.assets) {
      if (a.team !== 255 || a.owner >= 0 || !['base_turret', 'inventory', 'repair_station', 'radar', 'vehicle_pad'].includes(a.type)) continue;
      let best: Asset | null = null, bd = 130 * 130;
      for (const p of points) { const d = distSq(a.pos, p.pos); if (d < bd) { bd = d; best = p; } }
      if (best) a.capLink = best;
    }
  }

  /** TA station/generator actors sit at their collision-cylinder centre; their meshes are offset 50 uu (1 m) down onto the floor. */
  private onFloor(kind: string, pos: Vec3): Vec3 {
    if (this.map.source === 'original' && ['inventory', 'repair_station', 'vehicle_pad', 'generator'].includes(kind)) return { x: pos.x, y: pos.y - 1, z: pos.z };
    if (kind !== 'cap_point') return { ...pos };
    const hit = this.world.raycast({ x: pos.x, y: pos.y + 0.3, z: pos.z }, { x: pos.x, y: pos.y - 2.5, z: pos.z }, undefined, false);
    return hit && hit.normal.y > 0.6 ? { x: pos.x, y: hit.point.y, z: pos.z } : { ...pos };
  }

  private makeFlag(team: number, stands: Vec3[]): FlagState {
    const home = { ...stands[0] };
    return { id: this.flags.length, team, state: 0, carrier: null, pos: { ...home }, vel: { x: 0, y: 0, z: 0 }, home, droppedAt: 0, stands, standIndex: 0, active: true };
  }

  private teamCentroid(team: number): Vec3 {
    const sp = team <= 1 ? this.teamSpawns(team) : [];
    if (!sp.length) return this.mapCenter();
    const c = sp.reduce((a, e) => ({ x: a.x + e.pos.x, y: a.y + e.pos.y, z: a.z + e.pos.z }), { x: 0, y: 0, z: 0 });
    return { x: c.x / sp.length, y: c.y / sp.length, z: c.z / sp.length };
  }

  private mapCenter(): Vec3 {
    const t = this.world.terrain;
    const x = t.originX + t.width / 2, z = t.originZ + t.depth / 2;
    return { x, y: t.heightAt(x, z) + 1, z };
  }

  addAsset(type: AssetType, team: number, pos: Vec3, yaw: number, owner: number, tag?: string): Asset {
    const def = ASSETS[type];
    const a: Asset = {
      id: this.nextAsset++, type, def, team, pos: { ...pos }, yaw, aimYaw: yaw, health: def.health || 1, maxHealth: def.health || 1, level: 0,
      destroyed: false, destroyedAt: 0, owner, createdAt: this.now, nextFire: 0, box: null, tag, capTeam: type === 'cap_point' ? 255 : undefined,
      armedAt: this.now + 1,
    };
    if (def.solid && (owner >= 0 || def.mass)) {
      a.box = makeOBB({ x: pos.x, y: pos.y + def.size[1], z: pos.z }, [...def.size], yaw, 0, 0, type === 'force_field' ? 'forcefield' : 'metal');
      if (type === 'force_field') a.box.passTeam = team;
      this.world.dynamic.set(a.id, a.box);
    }
    this.assets.push(a);
    return a;
  }

  removeAsset(a: Asset) {
    this.world.dynamic.delete(a.id);
    this.assets = this.assets.filter((x) => x !== a);
  }

  // ------------------------------------------------------------------ players
  addPlayer(p: Player) {
    this.players.set(p.id, p);
  }

  removePlayer(p: Player) {
    if (p.flag) this.dropFlag(p, false);
    if (p.vehicle) this.exitVehicle(p);
    for (const a of this.assets.filter((x) => x.owner === p.id)) this.removeAsset(a);
    this.players.delete(p.id);
    this.lastStart.delete(-1 - p.id);
  }

  /** Smaller team; `self` is left out of the count so re-picking auto-assign does not swap a lone player. */
  autoTeam(self?: Player): number {
    if (!this.mode.teams) return this.rng() < 0.5 ? 0 : 1;
    let a = 0, b = 0;
    for (const p of this.players.values()) { if (p === self) continue; if (p.team === 0) a++; else if (p.team === 1) b++; }
    return a <= b ? 0 : 1;
  }

  setTeam(p: Player, team: number) {
    if (team === 255) {
      if (p.alive) this.kill(p, null, 'none', true);
      p.team = 255; p.spectator = true; p.alive = false;
      return;
    }
    if (team !== 0 && team !== 1) team = this.autoTeam(p);
    if (p.team === team && !p.spectator) return;
    if (p.alive) this.kill(p, null, 'none', true);
    p.team = team;
    p.spectator = false;
    p.respawnAt = this.now + 0.5;
  }

  /** Credits earned, scaled by the host's credit multiplier. */
  private earn(p: Player, amount: number) { p.credits += Math.round(amount * (this.cfg.options?.creditMultiplier ?? 1)); }

  setClass(p: Player, clsId: string, loadout: Partial<Loadout>) {
    const cls = CLASS_BY_ID[clsId] ?? CLASSES[0];
    const lo = validateLoadout(cls.id, loadout);
    if (!p.alive) { p.cls = cls; p.loadout = lo; p.pending = null; }
    else { p.pending = { cls, loadout: lo }; this.io.send(p, { t: 'toast', text: `${cls.name} loadout applies at an inventory station or on respawn` }); }
  }

  /** A Technician's deployed turrets last only while he lives in the class. */
  private dropTurrets(p: Player) {
    for (const a of this.assets.filter((x) => x.owner === p.id && (x.type === 'light_turret' || x.type === 'exr_turret'))) {
      this.io.broadcast({ t: 'fx', kind: 'explode', pos: a.pos, radius: 2, item: `asset_${a.type}` });
      this.removeAsset(a);
    }
  }

  private applyLoadout(p: Player) {
    const lo = p.loadout;
    const s = loadoutStats(p.cls, lo, p.determination, ITEMS[lo.pack]?.passive ?? {});
    p.maxHealth = s.maxHealth;
    p.maxEnergy = s.maxEnergy;
    p.regenMult = s.regenMult;
    p.runMult = s.runMult;
    p.massMult = s.massMult;
    p.weapons = [makeWeapon(lo.primary), makeWeapon(p.repairSwap ? 'repair_tool' : lo.secondary)];
    p.beltCount = ITEMS[lo.belt].clip + s.beltExtra;
    p.packActive = false;
    p.slot = 0;
  }

  private spawnPoint(p: Player): { pos: Vec3; yaw: number } {
    const all = this.entities.filter((e) => e.kind === 'spawn' && this.validSpawn(e));
    let list = this.mode.teams && p.team <= 1 ? this.teamSpawns(p.team).filter((e) => this.validSpawn(e)) : all;
    if (!list.length) list = all;
    if (!list.length) {
      const c = this.mode.teams ? this.teamCentroid(p.team) : this.mapCenter();
      return { pos: this.surfaceAbove(c), yaw: 0 };
    }
    if (this.mode.teams) {
      // TA (UTGame.ChoosePlayerStart / RatePlayerStart): scan the team's starts from a random index and take the first
      // good-enough one (rating >= 30: a primary start that was not the last one used and has no enemy in sight within
      // 60 m), else the best rated. Occupied starts rate lower so a crowd spills over instead of stacking.
      const n = list.length, r0 = Math.floor(this.rng() * n);
      let best = list[r0], bestScore = -Infinity;
      for (let k = 0; k < n; k++) {
        const e = list[(r0 + k) % n];
        let score = e === this.lastStart.get(p.team) || e === this.lastStart.get(-1 - p.id) ? 15 : 30;
        for (const o of this.players.values()) {
          if (!o.alive || o === p) continue;
          const d = Math.hypot(o.move.pos.x - e.pos.x, o.move.pos.y - e.pos.y, o.move.pos.z - e.pos.z);
          if (d < 2) score -= 10;
          if (d < 60 && this.isEnemy(o, p) && !this.world.raycast({ x: e.pos.x, y: e.pos.y + 1, z: e.pos.z }, { x: o.move.pos.x, y: o.move.pos.y + 1.6, z: o.move.pos.z }, undefined, false)) score -= 5 - d / 20;
        }
        if (score >= 30) { best = e; break; }
        if (score > bestScore) { bestScore = score; best = e; }
      }
      this.lastStart.set(p.team, best);
      this.lastStart.set(-1 - p.id, best);
      return { pos: this.freeSpot({ x: best.pos.x, y: best.pos.y + 0.3, z: best.pos.z }, p), yaw: best.yaw };
    }
    // Free-for-all: prefer spawns far from living enemies.
    let best = list[0], bestScore = -Infinity;
    for (let i = 0; i < Math.min(8, list.length); i++) {
      const e = list[Math.floor(this.rng() * list.length)];
      let near = Infinity;
      for (const o of this.players.values()) if (o.alive && this.isEnemy(o, p)) near = Math.min(near, distSq(o.move.pos, e.pos));
      const score = Math.min(near, 1e6) + this.rng() * 400;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return { pos: this.freeSpot({ x: best.pos.x, y: best.pos.y + 0.3, z: best.pos.z }, p), yaw: best.yaw };
  }

  /** Last start used per team (key = team) and per player (key = -1 - id). */
  private lastStart = new Map<number, MapEntity>();

  private spawnHalves: [MapEntity[], MapEntity[]] | null = null;
  /**
   * A team's spawn points. Maps whose starts are not split by team (most TDM / CaH / arena layouts, where TA spawned
   * anywhere) are cut in two along their main axis, so each team spawns on its own half.
   */
  private teamSpawns(team: number): MapEntity[] {
    if (!this.spawnHalves) {
      const sp = this.entities.filter((e) => e.kind === 'spawn');
      const byTeam: [MapEntity[], MapEntity[]] = [sp.filter((e) => e.team === 0), sp.filter((e) => e.team === 1)];
      const mean = (l: MapEntity[]) => ({ x: l.reduce((a, e) => a + e.pos.x, 0) / l.length, z: l.reduce((a, e) => a + e.pos.z, 0) / l.length });
      const c = mean(sp);
      let sxx = 0, sxz = 0, szz = 0;
      for (const e of sp) { const dx = e.pos.x - c.x, dz = e.pos.z - c.z; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const ax = { x: Math.cos(ang), z: Math.sin(ang) };
      const proj = (q: { x: number; z: number }) => (q.x - c.x) * ax.x + (q.z - c.z) * ax.z;
      const ps = sp.map((e) => proj(e.pos));
      const spread = Math.max(...ps) - Math.min(...ps);
      const split = byTeam[0].length >= 2 && byTeam[1].length >= 2 && Math.abs(proj(mean(byTeam[0])) - proj(mean(byTeam[1]))) >= spread * 0.4;
      if (split || sp.length < 2) this.spawnHalves = byTeam;
      else {
        const sorted = [...sp].sort((a, b) => proj(a.pos) - proj(b.pos));
        const half = Math.ceil(sorted.length / 2);
        // Keep a team's own (or its flag's) side when the map gives one.
        const home0 = this.entities.find((e) => e.team === 0 && (e.kind === 'flag_stand' || e.kind === 'generator'))?.pos ?? (byTeam[0].length && byTeam[1].length ? mean(byTeam[0]) : null);
        const flip = home0 ? proj(home0) > 0 : false;
        const lo = sorted.slice(0, half), hi = sorted.slice(half);
        this.spawnHalves = flip ? [hi, lo] : [lo, hi];
      }
    }
    return this.spawnHalves[team] ?? [];
  }

  private spawnValid = new Map<MapEntity, boolean>();
  /** Spawn points from some imported maps sit in missing geometry, inside rocks or past the edge; skip those. */
  private validSpawn(e: MapEntity): boolean {
    let ok = this.spawnValid.get(e);
    if (ok !== undefined) return ok;
    const w = this.world, p = { x: e.pos.x, y: e.pos.y + 1, z: e.pos.z };
    const floor = w.raycast(p, { x: p.x, y: p.y - 7, z: p.z }, undefined, false);
    let inside = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const h = w.raycast(p, { x: p.x + dx * 60, y: p.y + dy * 60, z: p.z + dz * 60 }, undefined, false);
      if (h?.back) inside++;
    }
    ok = !!floor && !floor.back && floor.normal.y > 0.5 && inside < 4 && e.pos.y > this.killZ + 5;
    // Below the terrain surface is only valid inside an interior: something other than terrain must roof the spawn.
    const T = w.terrain;
    if (ok && !T.isHole(p.x, p.z) && p.y < T.heightAt(p.x, p.z) - 0.5) {
      const roof = w.raycast(p, { x: p.x, y: T.heightAt(p.x, p.z) + 1, z: p.z }, undefined, false);
      if (!roof || roof.boxIndex === -1) ok = false;
    }
    this.spawnValid.set(e, ok);
    return ok;
  }

  /** Highest walkable surface at (x, z): spawning there can never put a player inside geometry. */
  private surfaceAbove(c: Vec3): Vec3 {
    const top = Math.max(c.y, this.world.terrain.heightAt(c.x, c.z)) + 400;
    const hit = this.world.raycast({ x: c.x, y: top, z: c.z }, { x: c.x, y: c.y - 200, z: c.z }, undefined, false);
    return { x: c.x, y: (hit ? hit.point.y : this.world.terrain.heightAt(c.x, c.z)) + 0.1, z: c.z };
  }

  private overlaps(pos: Vec3, p: Player): boolean {
    const q = { ...pos }, v = { x: 0, y: 0, z: 0 };
    this.world.resolveCapsule(q, v, p.phys.radius, p.phys.height);
    if (Math.hypot(q.x - pos.x, q.y - pos.y, q.z - pos.z) > 0.04) return true;
    for (const o of this.players.values()) {
      if (o !== p && o.alive && Math.hypot(o.move.pos.x - pos.x, o.move.pos.z - pos.z) < p.phys.radius * 2.2 && Math.abs(o.move.pos.y - pos.y) < p.phys.height) return true;
    }
    return false;
  }

  /** Spawn points can sit inside geometry or on top of another player: settle on the floor, else search a ring of nearby spots. */
  private freeSpot(start: Vec3, p: Player): Vec3 {
    const settle = (s: Vec3): Vec3 => {
      const hit = this.world.raycast({ x: s.x, y: s.y + 1, z: s.z }, { x: s.x, y: s.y - 6, z: s.z }, undefined, false);
      return hit && hit.normal.y > 0.6 ? { x: s.x, y: hit.point.y + 0.05, z: s.z } : s;
    };
    // A start that grazes a rock or bush is pushed clear rather than moved away (or into the air).
    const nudge = (s: Vec3): Vec3 => {
      const q = { ...s }, v = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 2; i++) this.world.resolveCapsule(q, v, p.phys.radius, p.phys.height);
      return Math.hypot(q.x - s.x, q.y - s.y, q.z - s.z) < 0.6 ? q : s;
    };
    const first = nudge(settle(start));
    if (!this.overlaps(first, p)) return first;
    // Ground-level spots all around first; raised ones only when the floor is crowded.
    for (const dy of [0, 1.5, 3]) {
      for (let r = 1.5; r <= 9; r += 1.5) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + r;
          const c = nudge(settle({ x: start.x + Math.cos(a) * r, y: start.y + dy, z: start.z + Math.sin(a) * r }));
          // Must still be reachable: no wall between the spawn point and the candidate.
          if (this.world.raycast({ x: start.x, y: start.y + 1, z: start.z }, { x: c.x, y: c.y + 1, z: c.z }, undefined, false)) continue;
          if (!this.overlaps(c, p)) return c;
        }
      }
    }
    return { x: start.x, y: start.y + 2, z: start.z };
  }

  spawn(p: Player) {
    if (p.pending) { p.cls = p.pending.cls; p.loadout = p.pending.loadout; p.pending = null; }
    p.repairSwap = false;
    this.applyLoadout(p);
    const sp = this.spawnPoint(p);
    p.move = newMoveState(sp.pos);
    p.move.energy = p.maxEnergy;
    p.health = p.maxHealth;
    p.alive = true;
    p.spawnQueued = false;
    p.lastHurt = -999;
    p.damagers.clear();
    p.flag = null;
    p.invulnUntil = this.mode.id === 'arena' ? this.now + 5 : this.now + 1.5;
    p.lastCmd = { ...p.lastCmd, yaw: sp.yaw, pitch: 0 };
    p.history = [];
    p.safe = [{ ...sp.pos }];
    this.io.send(p, { t: 'spawned', cls: p.cls.id, loadout: p.loadout, yaw: sp.yaw });
  }

  isEnemy(a: Player, b: Player): boolean {
    if (a === b) return false;
    if (this.mode.id === 'rabbit') return true;
    return TEAM_ENEMY(a.team, b.team);
  }

  // ------------------------------------------------------------------ main tick
  step(): void {
    this.now += DT;
    this.tick++;
    const playing = this.phase === PHASE.PLAYING || this.phase === PHASE.WARMUP;

    for (const p of this.players.values()) {
      if (p.brain) p.inputs.push(p.brain.think(this, p));
      let n = p.inputs.length > 6 ? 3 : 1;
      if (!p.alive || p.spectator) {
        // Any click in this batch queues the respawn: short clicks between ticks and clicks during the countdown both count.
        for (const c of p.inputs) {
          if ((c.buttons & BTN.FIRE) && !(p.lastCmd.buttons & BTN.FIRE)) p.spawnQueued = true;
          p.lastSeq = Math.max(p.lastSeq, c.seq); p.lastCmd = c;
        }
        p.inputs.length = 0;
        if (!p.spectator && playing && this.canRespawn(p) && this.now >= p.respawnAt && (p.isBot || p.spawnQueued || (p.lastCmd.buttons & BTN.FIRE) || this.now - p.respawnAt > 10)) this.spawn(p);
        continue;
      }
      while (n-- > 0 && p.inputs.length) {
        const cmd = p.inputs.shift()!;
        this.processCommand(p, cmd);
      }
      this.passiveUpdate(p);
    }

    this.stepProjectiles();
    this.stepAssets();
    this.stepVehicles();
    this.stepFlags();
    this.stepStrikes();
    this.stepMode();
  }

  private processCommand(p: Player, cmd: InputCmd) {
    p.lastSeq = cmd.seq;
    p.lastCmd = cmd;
    if (p.vehicle) {
      this.vehicleInput(p, cmd);
      p.prevButtons = cmd.buttons;
      return;
    }
    const params: MoveParams = {
      phys: p.phys, maxEnergy: p.maxEnergy, regenMult: p.regenMult, runMult: p.runMult * (this.now < p.rageUntil ? 1.25 : 1),
      massMult: p.massMult, flagDragSpeed: p.flag ? FLAG_DRAG_KMH[p.cls.armor] / 3.6 : 0, canJet: true, team: p.team,
      infiniteEnergy: this.cfg.options?.infiniteEnergy,
    };
    const res = stepMovement(p.move, cmd, params, this.world, DT);
    if (res.impact > FALL_DAMAGE_THRESHOLD && !p.hasPerk('safe_fall') && !this.cfg.options?.noFallDamage) {
      this.damagePlayer(p, (res.impact - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_MS, null, 'fall', false, null, 0);
    }
    if (!p.alive) return;
    if (p.move.pos.y < this.killZ || p.move.pos.y < this.hazardY) {
      if (p.move.pos.y < this.killZ && this.rescue(p)) return;
      this.kill(p, null, 'killz');
      return;
    }
    this.handleWeapons(p, cmd);
    p.prevButtons = cmd.buttons;
  }

  private passiveUpdate(p: Player) {
    if (!p.alive || p.vehicle) return;
    const packDef = ITEMS[p.loadout.pack];
    if (p.packActive && packDef?.energyDrain) {
      p.move.energy -= packDef.energyDrain * DT;
      if (p.move.energy <= 0) { p.move.energy = 0; p.packActive = false; }
    }
    const delay = HEALTH_REGEN_DELAY * 0.75 * (p.hasPerk('lightweight') ? 3 : 1);
    const noRegen = p.flag && (this.mode.id === 'tdm' || this.mode.id === 'rabbit');
    if (!noRegen && this.now - p.lastHurt > delay && p.health < p.maxHealth) {
      const mult = (packDef?.passive?.healthRegenMult ?? 1) * 1.25;
      p.health = Math.min(p.maxHealth, p.health + p.maxHealth * HEALTH_REGEN_RATE * mult * DT);
    }
    const h = p.history;
    h.push({ t: this.now, x: p.move.pos.x, y: p.move.pos.y, z: p.move.pos.z });
    if (h.length > 40) h.shift();
    if (this.map.data.volumes && this.hazards(p)) return;
    if (this.waterRescue && p.move.onGround && this.now - p.safeAt >= 0.25) {
      p.safeAt = this.now;
      p.safe.push({ x: p.move.pos.x, y: p.move.pos.y, z: p.move.pos.z });
      if (p.safe.length > 5) p.safe.shift();
    }
    this.checkFlagTouch(p);
    this.checkPickups(p);
    if (this.tick % 6 === 0) this.checkStationTouch(p);
  }

  private stationUsed = new Map<number, number>();

  /** Which damage volume (if any) contains a point. */
  volumeAt(pos: Vec3): MapVolume | null {
    for (const v of this.map.data.volumes ?? []) if (inVolume(v, pos)) return v;
    return null;
  }

  /** TA's UTKillZVolume (instant) and pain-causing PhysicsVolumes (lava etc., bPhysicsOnContact: feet or body count). Returns true if the player died. */
  private hazards(p: Player): boolean {
    const pos = p.move.pos;
    const v = this.volumeAt({ x: pos.x, y: pos.y + 0.1, z: pos.z }) ?? this.volumeAt({ x: pos.x, y: pos.y + p.phys.height * 0.5, z: pos.z });
    if (!v) return false;
    if (v.kind === 'pain' && this.rescue(p)) return true;
    if (v.kind === 'kill') this.kill(p, null, 'killz');
    else this.damagePlayer(p, v.dps * DT, null, 'hazard', false, null, 0);
    return !p.alive;
  }

  /** Out of bounds on a water map: back to ground the player stood on a moment ago, for a small health price. */
  private rescue(p: Player): boolean {
    if (!this.waterRescue || p.vehicle || !p.safe.length || p.health <= p.maxHealth * 0.1) return false;
    const s = p.safe[0];
    p.move.pos = { x: s.x, y: s.y + 0.3, z: s.z };
    p.move.vel = { x: 0, y: 0, z: 0 };
    p.move.onGround = false;
    p.lastRescue = this.now;
    p.health -= p.maxHealth * 0.1;
    p.lastHurt = this.now;
    if (!p.isBot) this.io.send(p, { t: 'toast', text: 'OUT OF BOUNDS - returned to the battlefield' });
    return true;
  }
  /** Like TA: walking into a friendly powered inventory station restocks and applies a pending loadout. */
  private checkStationTouch(p: Player) {
    if (p.vehicle || (this.stationUsed.get(p.id) ?? 0) > this.now) return;
    // Bots steer less precisely than players walk in, so they get a little more reach.
    const reach = p.isBot ? 3.5 : 1.6;
    for (const a of this.assets) {
      if (a.type !== 'inventory' || a.destroyed || (a.team !== p.team && a.team !== 255)) continue;
      const dy = p.move.pos.y - a.pos.y;
      if (dy < (p.isBot ? -1.5 : -0.5) || dy > 2 || Math.hypot(a.pos.x - p.move.pos.x, a.pos.z - p.move.pos.z) > reach) continue;
      if (!this.isPowered(a)) return;
      this.stationUsed.set(p.id, this.now + 4);
      this.useStation(p);
      return;
    }
  }

  private useStation(p: Player) {
    if (p.pending) {
      if (p.pending.cls !== p.cls) this.dropTurrets(p);
      p.cls = p.pending.cls; p.loadout = p.pending.loadout; p.pending = null;
    }
    p.repairSwap = false;
    this.applyLoadout(p);
    p.health = p.maxHealth;
    p.move.energy = p.maxEnergy;
    this.io.send(p, { t: 'spawned', cls: p.cls.id, loadout: p.loadout });
    this.io.send(p, { t: 'toast', text: 'Loadout restocked' });
    this.io.broadcast({ t: 'fx', kind: 'station', pos: p.move.pos, player: p.id });
  }

  canRespawn(p: Player): boolean {
    if (this.phase === PHASE.POSTGAME || this.phase === PHASE.ROUND_END) return false;
    if (this.mode.id !== 'arena') return true;
    return this.tickets[p.team] > 0 || p.deaths === 0 || p.diedAt === 0;
  }

  // ------------------------------------------------------------------ weapons
  private handleWeapons(p: Player, cmd: InputCmd) {
    const held = (b: number) => (cmd.buttons & b) !== 0;
    const edge = (b: number) => held(b) && (p.prevButtons & b) === 0;
    const now = this.now;
    if (this.phase === PHASE.POSTGAME) return;

    const want = cmd.weapon & 1;
    if (want !== p.slot && p.weapons[want]) {
      p.slot = want;
      p.switchUntil = now + (p.hasPerk('quick_draw') ? 0.15 : 0.35);
      p.weapons[want].spin = 0;
    }
    const w = p.weapon;
    const d = w.def;
    p.zoomed = held(BTN.ZOOM);

    if (w.reloadUntil > 0 && now >= w.reloadUntil) {
      const take = Math.min(d.clip - w.clip, w.ammo);
      w.clip += take; w.ammo -= take; w.reloadUntil = 0;
    }
    if (edge(BTN.RELOAD) && w.clip < d.clip && w.ammo > 0 && w.reloadUntil === 0 && d.reload > 0) w.reloadUntil = now + d.reload;

    if (d.spinup) w.spin = held(BTN.FIRE) ? Math.min(1, w.spin + DT / d.spinup) : Math.max(0, w.spin - (DT / d.spinup) * 1.5);

    if (w.burstLeft > 0 && now >= w.burstNext && w.clip > 0) {
      this.fireShot(p, d, cmd);
      w.clip--; w.burstLeft--; w.burstNext = now + (d.burst?.interval ?? 0.1);
      if (this.cfg.options?.infiniteAmmo) w.clip = Math.max(w.clip, 1);
      if (w.clip === 0 && w.ammo > 0) { w.burstLeft = 0; w.reloadUntil = now + d.reload; }
    }

    if (held(BTN.FIRE) && now >= p.switchUntil && now >= w.nextFire && w.reloadUntil === 0 && this.phase !== PHASE.ROUND_END) {
      if (d.kind === 'repair') {
        this.repairBeam(p, d, cmd);
        w.nextFire = now + d.refire;
      } else if (w.clip > 0 && (!d.spinup || w.spin >= 1)) {
        const cost = d.energyCost ?? 0;
        if (d.id === 'sap20' ? p.move.energy >= 30 : p.move.energy >= cost) {
          if (d.burst) { w.burstLeft = d.burst.count - 1; w.burstNext = now + d.burst.interval; }
          this.fireShot(p, d, cmd);
          if (d.id === 'sap20' || d.id === 'phase_rifle') p.move.energy = 0;
          else p.move.energy -= cost;
          if (d.kind !== 'lance') w.clip--;
          if (this.cfg.options?.infiniteAmmo) { w.clip = d.clip; w.ammo = Math.max(w.ammo, d.ammo); }
          w.nextFire = now + d.refire;
          w.lastShot = now;
          if (w.clip === 0 && w.ammo > 0) w.reloadUntil = now + (d.burst ? d.reload : Math.max(d.reload, d.refire));
        }
      } else if (w.clip === 0 && w.ammo > 0 && w.reloadUntil === 0) {
        w.reloadUntil = now + d.reload;
      }
    }

    if (edge(BTN.MELEE) && now >= p.meleeNext) { p.meleeNext = now + MELEE.refire; this.melee(p, cmd); }
    if (edge(BTN.BELT) && p.beltCount > 0 && now >= p.beltNext) { p.beltNext = now + ITEMS[p.loadout.belt].refire; this.throwBelt(p, cmd); }
    if (edge(BTN.PACK)) this.usePack(p, cmd);
    if (edge(BTN.DROP_FLAG) && p.flag && this.mode.id !== 'rabbit') this.dropFlag(p, true);
    if (edge(BTN.USE)) this.useAction(p, cmd);
    if (edge(BTN.SPOT)) this.spot(p, cmd);
  }

  private aim(p: Player, cmd: InputCmd): { eye: Vec3; dir: Vec3; muzzle: Vec3 } {
    const eye = p.eye();
    const dir = dirFromAngles(cmd.yaw, cmd.pitch);
    const rx = Math.cos(cmd.yaw), rz = -Math.sin(cmd.yaw);
    const muzzle = { x: eye.x + dir.x * 0.6 + rx * 0.25, y: eye.y - 0.15 + dir.y * 0.6, z: eye.z + dir.z * 0.6 + rz * 0.25 };
    return { eye, dir, muzzle };
  }

  private fireShot(p: Player, d: ItemDef, cmd: InputCmd) {
    p.lastFire = this.now;
    if (this.now < p.invulnUntil && this.mode.id === 'arena') p.invulnUntil = 0;
    if (p.packActive && ITEMS[p.loadout.pack]?.id === 'stealth_pack') { /* firing reveals; handled in snapshot */ }
    const { eye, dir, muzzle } = this.aim(p, cmd);
    if (d.projectile) {
      this.spawnProjectile(p.id, p.team, d.id, d.projectile, muzzle, dir, p.move.vel, d.explosive);
    } else if (d.hitscan) {
      const hsDef = d.hitscan;
      let dmgScale = 1;
      if (d.chargeTime) {
        const charge = Math.min(1, (this.now - p.weapon.lastShot) / d.chargeTime);
        dmgScale = p.zoomed ? 0.4 + 0.6 * charge : 0.4;
      }
      if (d.id === 'phase_rifle') dmgScale = (125 + (510 - 125) * Math.min(1, p.move.energy / 90)) / 510;
      const tracers: Vec3[] = [];
      const rnd = mulberry32(cmd.seq * 7919 + p.id);
      for (let i = 0; i < hsDef.pellets; i++) {
        const sp = hsDef.spread * (p.zoomed ? 0.3 : 1);
        const yaw = cmd.yaw + (rnd() * 2 - 1) * sp, pitch = cmd.pitch + (rnd() * 2 - 1) * sp;
        const dd = hsDef.spread > 0 ? dirFromAngles(yaw, pitch) : dir;
        const end = this.hitscan(p, eye, dd, hsDef.range, (target, dist, point) => {
          let dmg = hitscanFalloff(hsDef.damage, hsDef.minDamage, hsDef.falloffStart, hsDef.falloffEnd, dist) * dmgScale;
          if (d.kind === 'lance' && this.isBehind(p, target)) dmg *= SHOCKLANCE_BACK_MULT;
          if (d.chargeTime || d.id === 'phase_rifle' || d.id === 'sap20') {
            if (point.y > target.move.pos.y + target.phys.height * 0.8) dmg *= 1.5;
          }
          this.damagePlayer(target, dmg, p, d.id, false, dd, 0);
        });
        if (i < 3) tracers.push(end);
      }
      for (const t of tracers) this.io.broadcast({ t: 'fx', kind: d.kind === 'lance' ? 'lance' : 'tracer', pos: muzzle, to: t, item: d.id, player: p.id });
    }
    if (d.projectile) this.io.broadcast({ t: 'fx', kind: 'fire', pos: muzzle, item: d.id, player: p.id }, (o) => o !== p);
  }

  private isBehind(attacker: Player, target: Player): boolean {
    const tf = dirFromAngles(target.lastCmd.yaw, 0);
    const dx = target.move.pos.x - attacker.move.pos.x, dz = target.move.pos.z - attacker.move.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    return (dx / l) * tf.x + (dz / l) * tf.z > 0.5;
  }

  /** Lag-compensated hitscan against players; returns the end point. */
  private hitscan(p: Player, eye: Vec3, dir: Vec3, range: number, onHit: (t: Player, dist: number, point: Vec3) => void): Vec3 {
    const to = { x: eye.x + dir.x * range, y: eye.y + dir.y * range, z: eye.z + dir.z * range };
    const wh = this.world.raycast(eye, to, undefined, true);
    let bestT = wh ? wh.t : 1;
    let best: Player | null = null;
    const rewind = this.now - clamp(p.rtt / 2 + INTERP_DELAY, 0, MAX_REWIND);
    for (const o of this.players.values()) {
      if (!o.alive || !this.isEnemy(p, o)) continue;
      const base = p.isBot ? o.move.pos : this.historicPos(o, rewind);
      const t = segmentVsCapsule(eye, to, base, o.phys.radius, o.phys.height);
      if (t >= 0 && t < bestT) { bestT = t; best = o; }
    }
    const point = { x: eye.x + (to.x - eye.x) * bestT, y: eye.y + (to.y - eye.y) * bestT, z: eye.z + (to.z - eye.z) * bestT };
    if (best) onHit(best, range * bestT, point);
    else this.hitscanAssets(p, eye, point, (a) => this.damageAsset(a, (p.weapon.def.hitscan?.damage ?? 50), p, p.weapon.def.id, false, false));
    return point;
  }

  private hitscanAssets(p: Player, from: Vec3, to: Vec3, onHit: (a: Asset) => void) {
    for (const a of this.assets) {
      if (a.destroyed || a.team === p.team || !a.def.health) continue;
      const c = { x: a.pos.x, y: a.pos.y + a.def.size[1], z: a.pos.z };
      const r = Math.max(...a.def.size);
      if (segmentVsCapsule(from, to, { x: c.x, y: c.y - r, z: c.z }, r, r * 2) >= 0) { onHit(a); return; }
    }
    for (const v of this.vehicles) {
      if (v.team === p.team) continue;
      const r = Math.max(...v.def.size);
      if (segmentVsCapsule(from, to, { x: v.pos.x, y: v.pos.y - r * 0.5, z: v.pos.z }, r, r * 1.5) >= 0) { this.damageVehicle(v, p.weapon.def.hitscan?.damage ?? 50, p, p.weapon.def.id, false); return; }
    }
  }

  private historicPos(o: Player, t: number): Vec3 {
    const h = o.history;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1], b = h[i];
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return o.move.pos;
  }

  spawnProjectile(owner: number, team: number, item: string, def: ProjectileDef, pos: Vec3, dir: Vec3, inheritVel: Vec3 | null, explosive = true): LiveProj {
    const inh = inheritVel ? def.inherit : 0;
    const vel = {
      x: dir.x * def.speed + (inheritVel?.x ?? 0) * inh,
      y: dir.y * def.speed + (inheritVel?.y ?? 0) * inh,
      z: dir.z * def.speed + (inheritVel?.z ?? 0) * inh,
    };
    this.nextProj = (this.nextProj % 65535) + 1;
    const pr: LiveProj = {
      id: this.nextProj, owner, team, item, pos: { ...pos }, vel, age: 0, bounces: 0, stuck: false, stuckTo: -1,
      stuckOffset: { x: 0, y: 0, z: 0 }, resting: false, homingTarget: -1, def, prev: { ...pos }, explosive, isDisc: def.model === 'disc',
    };
    if (def.homing) pr.homingTarget = this.findHomingTarget(owner, pos, dir);
    this.projectiles.set(pr.id, pr);
    return pr;
  }

  private findHomingTarget(owner: number, pos: Vec3, dir: Vec3): number {
    let best = -1, bestDot = 0.9;
    const own = this.players.get(owner);
    for (const v of this.vehicles) {
      if (own && v.team === own.team) continue;
      const dx = v.pos.x - pos.x, dy = v.pos.y - pos.y, dz = v.pos.z - pos.z, l = Math.hypot(dx, dy, dz) || 1;
      const d = (dx * dir.x + dy * dir.y + dz * dir.z) / l;
      if (d > bestDot) { bestDot = d; best = 1000 + v.id; }
    }
    for (const o of this.players.values()) {
      if (!o.alive || o.move.onGround || (own && !this.isEnemy(own, o))) continue;
      const dx = o.move.pos.x - pos.x, dy = o.move.pos.y - pos.y, dz = o.move.pos.z - pos.z, l = Math.hypot(dx, dy, dz) || 1;
      const d = (dx * dir.x + dy * dir.y + dz * dir.z) / l;
      if (d > bestDot) { bestDot = d; best = o.id; }
    }
    return best;
  }

  private stepProjectiles() {
    for (const pr of this.projectiles.values()) {
      pr.prev = { ...pr.pos };
      if (pr.fractal) { this.stepFractal(pr); continue; }
      let homingPos: Vec3 | undefined;
      if (pr.homingTarget >= 1000) homingPos = this.vehicles.find((v) => v.id === pr.homingTarget - 1000)?.pos;
      else if (pr.homingTarget >= 0) { const t = this.players.get(pr.homingTarget); if (t?.alive) homingPos = t.move.pos; }
      if (pr.stuckTo >= 0) {
        const t = this.players.get(pr.stuckTo);
        if (t?.alive) pr.pos = { x: t.move.pos.x + pr.stuckOffset.x, y: t.move.pos.y + pr.stuckOffset.y, z: t.move.pos.z + pr.stuckOffset.z };
      }
      const res = advanceProjectile(pr, pr.def, this.world, DT, homingPos);
      if (res.vanish) { this.projectiles.delete(pr.id); continue; }
      if (!res.explode && !pr.stuck && !pr.resting) {
        const hit = this.projectileVsPlayers(pr);
        if (hit) {
          if (pr.def.sticky) {
            pr.stuck = true; pr.stuckTo = hit.id;
            pr.stuckOffset = { x: pr.pos.x - hit.move.pos.x, y: pr.pos.y - hit.move.pos.y, z: pr.pos.z - hit.move.pos.z };
            pr.vel = { x: 0, y: 0, z: 0 };
            continue;
          }
          const owner = this.players.get(pr.owner) ?? null;
          const dmg = pr.dmgOverride?.direct ?? pr.def.direct;
          if (dmg > 0) this.damagePlayer(hit, dmg, owner, pr.item, pr.explosive, pr.vel, 0, true);
          this.explode(pr, hit);
          continue;
        }
        const vhit = this.projectileVsVehicles(pr);
        if (vhit) { this.explode(pr, null); continue; }
        const ahit = this.projectileVsAssets(pr);
        if (ahit) { this.explode(pr, null); continue; }
      }
      if (pr.def.remote && pr.owner >= 0) {
        const o = this.players.get(pr.owner);
        if (!o?.alive) { this.projectiles.delete(pr.id); continue; }
        if (o.lastCmd.buttons & BTN.ALT) res.explode = true;
      }
      if (pr.def.split && !pr.stuck && pr.vel.y < 0 && pr.def.gravity > 0 && pr.def.model === 'mortar') res.explode = true;
      if (res.explode) this.explode(pr, null);
    }
  }

  private projectileVsPlayers(pr: LiveProj): Player | null {
    let best: Player | null = null, bestT = 2;
    for (const o of this.players.values()) {
      if (!o.alive || o.vehicle) continue;
      if (o.id === pr.owner && pr.age < 0.25) continue;
      const own = this.players.get(pr.owner);
      if (own && o !== own && !this.isEnemy(own, o) && o.team === pr.team) continue;
      const t = segmentVsCapsule(pr.prev, pr.pos, o.move.pos, o.phys.radius + pr.def.size, o.phys.height + pr.def.size);
      if (t >= 0 && t < bestT) { bestT = t; best = o; }
    }
    if (best) pr.pos = { x: pr.prev.x + (pr.pos.x - pr.prev.x) * bestT, y: pr.prev.y + (pr.pos.y - pr.prev.y) * bestT, z: pr.prev.z + (pr.pos.z - pr.prev.z) * bestT };
    return best;
  }

  private projectileVsVehicles(pr: LiveProj): Vehicle | null {
    for (const v of this.vehicles) {
      if (v.team === pr.team && v.driver?.id === pr.owner) continue;
      const r = Math.max(...v.def.size);
      if (segmentVsCapsule(pr.prev, pr.pos, { x: v.pos.x, y: v.pos.y - r * 0.5, z: v.pos.z }, r, r * 1.5) >= 0) return v;
    }
    return null;
  }

  private projectileVsAssets(pr: LiveProj): Asset | null {
    for (const a of this.assets) {
      if (!a.def.solid || a.team === pr.team && a.type !== 'force_field') continue;
      const r = Math.max(...a.def.size);
      if (segmentVsCapsule(pr.prev, pr.pos, { x: a.pos.x, y: a.pos.y, z: a.pos.z }, r * 0.9, a.def.size[1] * 2) >= 0) return a;
    }
    return null;
  }

  /** Fractal grenade after its fuse: rises, fires shards around it, then blows up itself. */
  private stepFractal(pr: LiveProj) {
    const f = pr.def.fractal!, s = pr.fractal!;
    s.t += DT;
    const up = Math.min(1, s.t / f.ascentTime);
    pr.pos = { x: s.base.x, y: s.base.y + f.ascent * (1 - (1 - up) * (1 - up)), z: s.base.z };
    pr.vel = { x: 0, y: 0, z: 0 };
    const end = f.ascentTime + f.duration;
    while (s.t >= s.next && s.next < end) {
      s.next += f.interval;
      const a = this.rng() * Math.PI * 2, r = f.reach * Math.sqrt(this.rng());
      const to = { x: pr.pos.x + Math.cos(a) * r, y: pr.pos.y - this.rng() * f.reachY * 2, z: pr.pos.z + Math.sin(a) * r };
      const hit = this.world.raycast(pr.pos, to);
      const at = hit ? hit.point : to;
      this.io.broadcast({ t: 'fx', kind: 'fractal', pos: pr.pos, to: at, item: pr.item });
      const shard: LiveProj = {
        ...pr, id: -1, pos: at, fractal: undefined, def: { ...pr.def, fractal: undefined, impulse: 20000 },
        dmgOverride: { direct: f.damage, splashMax: f.damage, splashMin: f.damage * 0.3, radius: f.radius },
      };
      this.explode(shard, null, { silent: true });
    }
    if (s.t >= end) this.explode(pr, null, { final: true });
  }

  explode(pr: LiveProj, direct: Player | null, opts: { final?: boolean; silent?: boolean } = {}) {
    const d = pr.def;
    if (d.fractal && !opts.final && !pr.fractal) {
      // TA: the grenade only starts its fractal phase here; damage comes from the shards and the last blast.
      pr.fractal = { t: 0, base: { ...pr.pos }, next: d.fractal.ascentTime };
      pr.vel = { x: 0, y: 0, z: 0 };
      pr.stuck = true;
      return;
    }
    this.projectiles.delete(pr.id);
    const owner = this.players.get(pr.owner) ?? null;
    const radius = pr.dmgOverride?.radius ?? d.radius;
    const sMax = pr.dmgOverride?.splashMax ?? d.splashMax, sMin = pr.dmgOverride?.splashMin ?? d.splashMin;
    if (!opts.silent) this.io.broadcast({ t: 'fx', kind: 'explode', pos: pr.pos, item: pr.item, radius });
    if (pr.item === 'emp_grenade' || pr.item === 'emp_xl') this.empBlast(pr.pos, radius, pr.team);
    if (d.split) {
      for (let i = 0; i < d.split.count; i++) {
        const a = (i / d.split.count) * Math.PI * 2;
        const dir = { x: Math.cos(a) * 0.5, y: 0.7, z: Math.sin(a) * 0.5 };
        const sub = this.spawnProjectile(pr.owner, pr.team, 'sub_munition', projDef('sub_munition')!, { ...pr.pos, y: pr.pos.y + 0.5 }, dir, null);
        sub.vel = { x: dir.x * d.split.spread, y: 6, z: dir.z * d.split.spread };
        sub.dmgOverride = { direct: d.split.damage, splashMax: d.split.damage, splashMin: d.split.damage * 0.3, radius: d.split.radius };
      }
    }
    if (sMax <= 0 && d.impulse <= 0) return;
    for (const o of this.players.values()) {
      if (!o.alive || o === direct) continue;
      const self = o.id === pr.owner;
      if (!self && owner && !this.isEnemy(owner, o) && o.team === pr.team) continue;
      const dist = distToCapsule(pr.pos, o.move.pos, o.phys.radius, o.phys.height);
      if (dist >= radius) continue;
      let dmg = splashDamage(sMax, sMin, radius, dist);
      if (self) dmg *= SELF_DAMAGE * (o.hasPerk('egocentric') ? 0.5 : 1);
      const kick = splashKnockback(pr.pos, o.move.pos, o.phys.height, radius, d.impulse, o.phys.mass * o.massMult, self, d.knockMin, d.selfLift);
      this.damagePlayer(o, dmg, owner, pr.item, pr.explosive, null, 0, false, kick);
    }
    if (direct) {
      const c = { x: direct.move.pos.x, y: direct.move.pos.y + direct.phys.height * 0.5, z: direct.move.pos.z };
      this.applyImpulse(direct, { x: c.x - pr.pos.x + pr.vel.x * 0.01, y: c.y - pr.pos.y + 0.2, z: c.z - pr.pos.z + pr.vel.z * 0.01 }, d.impulse);
    }
    for (const a of [...this.assets]) {
      if (a.destroyed || !a.def.health) continue;
      if (a.team === pr.team && a.owner !== pr.owner) continue;
      const dist = Math.max(0, Math.hypot(a.pos.x - pr.pos.x, a.pos.y + a.def.size[1] - pr.pos.y, a.pos.z - pr.pos.z) - Math.max(...a.def.size));
      if (dist < radius) this.damageAsset(a, splashDamage(sMax, sMin, radius, dist), owner, pr.item, pr.explosive, pr.isDisc);
    }
    for (const v of [...this.vehicles]) {
      if (v.team === pr.team) continue;
      const dist = Math.max(0, Math.hypot(v.pos.x - pr.pos.x, v.pos.y - pr.pos.y, v.pos.z - pr.pos.z) - Math.max(...v.def.size));
      if (dist < radius) this.damageVehicle(v, splashDamage(sMax, sMin, radius, dist), owner, pr.item, pr.explosive);
    }
  }

  private empBlast(pos: Vec3, radius: number, team: number) {
    for (const o of this.players.values()) {
      if (!o.alive || o.team === team) continue;
      if (Math.hypot(o.move.pos.x - pos.x, o.move.pos.y - pos.y, o.move.pos.z - pos.z) < radius) {
        o.move.energy *= 0.3;
        o.packActive = false;
      }
    }
  }

  private applyImpulse(p: Player, dir: Vec3, impulse: number) {
    if (impulse <= 0) return;
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dv = impulse / (p.phys.mass * p.massMult) / UU_PER_METER;
    applyKnockback(p.move, { x: (dir.x / l) * dv, y: (dir.y / l) * dv, z: (dir.z / l) * dv });
  }

  private melee(p: Player, cmd: InputCmd) {
    const { eye, dir } = this.aim(p, cmd);
    this.io.broadcast({ t: 'fx', kind: 'melee', pos: eye, player: p.id });
    for (const o of this.players.values()) {
      if (!o.alive || !this.isEnemy(p, o)) continue;
      const c = { x: o.move.pos.x, y: o.move.pos.y + o.phys.height * 0.5, z: o.move.pos.z };
      const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z, l = Math.hypot(dx, dy, dz);
      if (l > MELEE.range + o.phys.radius || (dx * dir.x + dy * dir.y + dz * dir.z) / (l || 1) < 0.55) continue;
      let dmg = MELEE.damage;
      if (p.hasPerk('close_combat') && this.isBehind(p, o)) dmg *= MELEE.backstabMult;
      if (o.hasPerk('close_combat')) dmg *= 0.4;
      this.damagePlayer(o, dmg, p, 'melee', false, dir, p.hasPerk('sonic_punch') ? 60000 : MELEE.impulse);
      if (p.hasPerk('sonic_punch') && o.flag) this.dropFlag(o, false);
      break;
    }
  }

  private throwBelt(p: Player, cmd: InputCmd) {
    const d = ITEMS[p.loadout.belt];
    if (d.kind === 'deploy' && d.deploy) {
      if (this.placeDeployable(p, d.deploy as AssetType, cmd) && !this.cfg.options?.infiniteAmmo) p.beltCount--;
      return;
    }
    if (!d.projectile) return;
    const { dir, muzzle } = this.aim(p, cmd);
    const tossDir = { x: dir.x, y: dir.y + 0.12, z: dir.z };
    const l = Math.hypot(tossDir.x, tossDir.y, tossDir.z);
    this.spawnProjectile(p.id, p.team, d.id, d.projectile, muzzle, { x: tossDir.x / l, y: tossDir.y / l, z: tossDir.z / l }, p.move.vel, d.explosive);
    if (!this.cfg.options?.infiniteAmmo) p.beltCount--;
    this.io.broadcast({ t: 'fx', kind: 'fire', pos: muzzle, item: d.id, player: p.id }, (o) => o !== p);
  }

  private usePack(p: Player, cmd: InputCmd) {
    const d = ITEMS[p.loadout.pack];
    if (!d || this.now < p.packNext) return;
    if (d.kind === 'toggle') {
      if (d.id === 'thrust_pack') {
        if (p.move.energy < (d.energyCost ?? 40)) return;
        p.move.energy -= d.energyCost ?? 40;
        const dir = dirFromAngles(cmd.yaw, Math.max(cmd.pitch, 0.1));
        p.move.vel.x += dir.x * 16; p.move.vel.y += dir.y * 16 + 2; p.move.vel.z += dir.z * 16;
        p.move.onGround = false;
        p.packNext = this.now + d.refire;
        this.io.broadcast({ t: 'fx', kind: 'jump', pos: p.move.pos, player: p.id, item: d.id });
        return;
      }
      if (!p.packActive && p.move.energy < 5) return;
      p.packActive = !p.packActive;
      p.packNext = this.now + d.refire;
    } else if (d.kind === 'deploy' && d.deploy) {
      if (this.placeDeployable(p, d.deploy as AssetType, cmd)) p.packNext = this.now + 2;
    }
  }

  private placeDeployable(p: Player, type: AssetType, cmd: InputCmd): boolean {
    const def = ASSETS[type];
    const { eye, dir } = this.aim(p, cmd);
    const reach = type === 'force_field' ? 4 : 5;
    const to = { x: eye.x + dir.x * reach, y: eye.y + dir.y * reach, z: eye.z + dir.z * reach };
    const hit = this.world.raycast(eye, to);
    let pos: Vec3;
    if (hit && hit.normal.y > 0.5) pos = hit.point;
    else {
      const fx = eye.x + dir.x * 2.5, fz = eye.z + dir.z * 2.5;
      const down = this.world.raycast({ x: fx, y: eye.y, z: fz }, { x: fx, y: eye.y - 6, z: fz });
      if (!down || down.normal.y < 0.5) { this.io.send(p, { t: 'toast', text: 'Cannot deploy here' }); return false; }
      pos = down.point;
    }
    for (const a of this.assets) {
      if (a.owner >= 0 && distSq(a.pos, pos) < 2.5 * 2.5) { this.io.send(p, { t: 'toast', text: 'Too close to another deployable' }); return false; }
    }
    const mine = this.assets.filter((a) => a.owner === p.id && a.type === type);
    const max = (def.maxPerPlayer ?? 1) + (p.hasPerk('safety_third') && !def.solid ? 1 : 0);
    if (mine.length >= max) this.removeAsset(mine[0]);
    this.addAsset(type, p.team, pos, cmd.yaw, p.id);
    this.io.broadcast({ t: 'fx', kind: 'deploy', pos, player: p.id, item: type });
    return true;
  }

  private useAction(p: Player, cmd: InputCmd) {
    if (p.vehicle) { this.exitVehicle(p); return; }
    for (const v of this.vehicles) {
      if (distSq(v.pos, p.move.pos) > 25 || (v.team !== p.team && (v.driver || v.gunner))) continue;
      if (!v.driver) { this.enterVehicle(p, v, 0); return; }
      if (v.def.seats > 1 && !v.gunner) { this.enterVehicle(p, v, 1); return; }
    }
    let nearest: Asset | null = null, nd = Infinity;
    for (const a of this.assets) {
      if (a.team !== p.team && a.team !== 255) continue;
      const d2 = distSq(a.pos, p.move.pos);
      if (d2 < nd) { nd = d2; nearest = a; }
    }
    if (nearest && nd < 3.5 * 3.5) {
      const a = nearest;
      const powered = this.isPowered(a);
      if ((a.type === 'inventory' || a.type === 'supply_drop') && !a.destroyed) {
        if (a.type === 'inventory' && !powered) { this.io.send(p, { t: 'toast', text: 'Inventory station has no power' }); return; }
        this.stationUsed.set(p.id, this.now + 4);
        this.useStation(p);
        return;
      }
      if (a.type === 'repair_station') {
        p.repairSwap = true;
        p.weapons[1] = makeWeapon('repair_tool');
        this.io.send(p, { t: 'spawned', cls: p.cls.id, loadout: { ...p.loadout, secondary: 'repair_tool' } });
        this.io.send(p, { t: 'toast', text: 'Repair tool equipped (slot 2)' });
        return;
      }
      if (a.type === 'vehicle_pad') {
        if (!powered) { this.io.send(p, { t: 'toast', text: 'Vehicle station has no power' }); return; }
        this.io.send(p, { t: 'event', kind: 'vehicle_menu', text: '' });
        return;
      }
    }
    // Upgrade asset in crosshair.
    const { eye, dir } = this.aim(p, cmd);
    for (const a of this.assets) {
      if (a.team !== p.team || !a.def.upgradeCosts || a.owner >= 0) continue;
      const c = { x: a.pos.x - eye.x, y: a.pos.y + a.def.size[1] - eye.y, z: a.pos.z - eye.z };
      const l = Math.hypot(c.x, c.y, c.z);
      if (l > 8 || (c.x * dir.x + c.y * dir.y + c.z * dir.z) / l < 0.85) continue;
      this.upgradeAsset(p, a);
      return;
    }
  }

  upgradeAsset(p: Player, a: Asset) {
    const costs = a.def.upgradeCosts;
    if (!costs || a.level >= costs.length || a.destroyed) return;
    const cost = costs[a.level];
    if (p.credits < cost) { this.io.send(p, { t: 'toast', text: `Upgrade costs ${cost} credits` }); return; }
    p.credits -= cost;
    a.level++;
    a.maxHealth += a.def.healthPerLevel ?? 0;
    a.health += a.def.healthPerLevel ?? 0;
    this.io.broadcast({ t: 'event', kind: 'upgrade', team: a.team, player: p.id, text: `${p.name} upgraded the ${a.def.name} to level ${a.level + 1}` }, (o) => o.team === a.team);
  }

  private repairBeam(p: Player, d: ItemDef, cmd: InputCmd) {
    const { eye, dir } = this.aim(p, cmd);
    const range = d.hitscan?.range ?? 12;
    const amount = (d.hitscan?.damage ?? 20) * (p.hasPerk('mechanic') ? 1.1 : 1);
    const to = { x: eye.x + dir.x * range, y: eye.y + dir.y * range, z: eye.z + dir.z * range };
    let best: Asset | null = null, bestT = 2;
    for (const a of this.assets) {
      if (!a.def.health) continue;
      const r = Math.max(...a.def.size);
      const t = segmentVsCapsule(eye, to, { x: a.pos.x, y: a.pos.y, z: a.pos.z }, r, a.def.size[1] * 2 + 0.5);
      if (t >= 0 && t < bestT) { bestT = t; best = a; }
    }
    for (const v of this.vehicles) {
      if (v.team !== p.team) continue;
      const r = Math.max(...v.def.size);
      if (segmentVsCapsule(eye, to, { x: v.pos.x, y: v.pos.y - r * 0.5, z: v.pos.z }, r, r * 1.5) >= 0) {
        v.health = Math.min(v.def.health, v.health + amount * 2);
        this.io.broadcast({ t: 'fx', kind: 'repair', pos: eye, to: v.pos, player: p.id });
        return;
      }
    }
    if (!best) return;
    if (best.team !== p.team) {
      if (p.hasPerk('mechanic')) this.damageAsset(best, amount, p, 'repair_tool', true, false);
      return;
    }
    if (best.health >= best.maxHealth && !best.destroyed) return;
    const before = best.health;
    best.health = Math.min(best.maxHealth, best.health + amount);
    this.earn(p, Math.round((best.health - before) * CREDITS.repairPerHp));
    if (best.destroyed && best.health >= best.maxHealth) {
      best.destroyed = false;
      this.io.broadcast({ t: 'event', kind: best.type === 'generator' ? 'gen_up' : 'asset_up', team: best.team, player: p.id, text: `${best.def.name} is back online` }, (o) => o.team === best!.team);
    }
    this.io.broadcast({ t: 'fx', kind: 'repair', pos: eye, to: { x: best.pos.x, y: best.pos.y + best.def.size[1], z: best.pos.z }, player: p.id });
  }

  private spot(p: Player, cmd: InputCmd) {
    const { eye, dir } = this.aim(p, cmd);
    for (const o of this.players.values()) {
      if (!o.alive || !this.isEnemy(p, o)) continue;
      const c = { x: o.move.pos.x - eye.x, y: o.move.pos.y + 1 - eye.y, z: o.move.pos.z - eye.z };
      const l = Math.hypot(c.x, c.y, c.z);
      if ((c.x * dir.x + c.y * dir.y + c.z * dir.z) / l > 0.98 && !this.world.raycast(eye, { x: o.move.pos.x, y: o.move.pos.y + 1, z: o.move.pos.z })) {
        o.spottedUntil = this.now + 8;
        this.io.broadcast({ t: 'event', kind: 'spot', team: p.team, player: o.id, text: `${p.name} spotted ${o.name}` }, (x) => x.team === p.team);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ damage
  damagePlayer(t: Player, amount: number, attacker: Player | null, item: string, explosive: boolean, dir: Vec3 | null, impulse: number, direct = false, kick: Vec3 | null = null) {
    if (!t.alive || amount <= 0 && impulse <= 0 && !kick) return;
    if (this.phase === PHASE.WARMUP && attacker && attacker !== t) return;
    if (this.now < t.invulnUntil && attacker && attacker !== t) return;
    if (attacker && attacker !== t && !this.isEnemy(attacker, t)) return;
    if (kick) applyKnockback(t.move, kick);
    if (dir && impulse > 0) this.applyImpulse(t, dir, impulse);
    if (amount <= 0) return;
    if (t.packActive && ['shield_pack', 'heavy_shield_pack'].includes(t.loadout.pack)) {
      const ratio = t.loadout.pack === 'heavy_shield_pack' ? 8 : 6.5;
      const absorb = Math.min(amount, t.move.energy * ratio);
      t.move.energy -= absorb / ratio;
      amount -= absorb;
      if (t.move.energy <= 0.5) t.packActive = false;
    }
    if (t.hasPerk('potential_energy') && explosive) t.move.energy = Math.min(t.maxEnergy, t.move.energy + amount * 0.02);
    t.health -= amount;
    t.lastHurt = this.now;
    if (attacker && attacker !== t) {
      t.damagers.set(attacker.id, this.now);
      this.io.send(attacker, { t: 'hit', target: t.id, dmg: Math.round(amount), kind: 'player', blueplate: direct && !t.move.onGround && !!projDef(item) });
    }
    if (!t.isBot) this.io.send(t, { t: 'damaged', from: attacker ? attacker.move.pos : t.move.pos, amount: Math.round(amount) });
    if (t.health <= 0) this.kill(t, attacker, item);
  }

  kill(v: Player, killer: Player | null, item: string, silent = false) {
    if (!v.alive) return;
    v.alive = false;
    v.health = 0;
    v.spawnQueued = false;
    v.diedAt = this.now;
    v.respawnAt = this.now + (silent ? 0.5 : RESPAWN_TIME);
    if (v.flag) this.dropFlag(v, false);
    if (v.vehicle) this.exitVehicle(v, true);
    v.packActive = false;
    this.dropTurrets(v);
    if (!silent) v.deaths++;
    if (!v.rewardedSinceDeath) v.determination = Math.min(3, v.determination + (v.hasPerk('determination') ? 1 : 0));
    else v.determination = 0;
    v.rewardedSinceDeath = false;
    if (this.mode.id === 'arena') {
      for (const a of this.assets.filter((x) => x.owner === v.id)) this.removeAsset(a);
      if (!silent) this.tickets[v.team] = Math.max(0, this.tickets[v.team] - 1);
    }
    if (silent) return;

    let assist: Player | undefined;
    for (const [id, t] of v.damagers) {
      if (id === killer?.id || this.now - t > 10) continue;
      const a = this.players.get(id);
      if (a) { a.assists++; this.earn(a, CREDITS.assist); a.score += 5; a.rewardedSinceDeath = true; assist ??= a; }
    }
    if (killer && killer !== v) {
      killer.kills++;
      killer.score += 10;
      this.earn(killer, CREDITS.kill + (killer.hasPerk('bounty_hunter') ? CREDITS.bountyHunterBonus : 0));
      killer.rewardedSinceDeath = true;
      if (killer.hasPerk('survivalist')) { killer.health = Math.min(killer.maxHealth, killer.health + killer.maxHealth * 0.2); killer.move.energy = Math.min(killer.maxEnergy, killer.move.energy + killer.maxEnergy * 0.4); }
    }
    this.modeOnKill(v, killer);
    this.io.broadcast({ t: 'kill', killer: killer?.id ?? -1, victim: v.id, item, assist: assist?.id });
    for (const p of this.players.values()) p.brain?.onKill(this, p, v, killer);
  }

  damageAsset(a: Asset, amount: number, attacker: Player | null, item: string, explosive: boolean, isDisc: boolean) {
    if (a.destroyed || !a.def.health || this.phase === PHASE.WARMUP) return;
    // A team never damages its own base or teammates' deployables (only your own deployables are fair game).
    if (attacker && a.team === attacker.team && a.owner !== attacker.id) return;
    if (a.def.armored && !explosive) return;
    const target = a.type === 'generator' ? 'generator' : a.type.includes('turret') ? 'turret' : 'other';
    amount *= assetDamageMult(explosive, isDisc, target);
    a.health -= amount;
    if (attacker) this.io.send(attacker, { t: 'hit', target: a.id, dmg: Math.round(amount), kind: 'asset' });
    if (a.health > 0) return;
    a.health = 0;
    if (a.owner >= 0 || a.type === 'supply_drop') {
      this.io.broadcast({ t: 'fx', kind: 'explode', pos: a.pos, radius: 4, item: `asset_${a.type}` });
      this.removeAsset(a);
      if (attacker) this.earn(attacker, 50);
      return;
    }
    a.destroyed = true;
    a.destroyedAt = this.now;
    this.io.broadcast({ t: 'fx', kind: 'explode', pos: a.pos, radius: 6, item: `asset_${a.type}` });
    if (attacker) {
      this.earn(attacker, a.type === 'generator' ? CREDITS.genDestroy : CREDITS.turretDestroy);
      attacker.score += a.type === 'generator' ? 20 : 10;
      attacker.rewardedSinceDeath = true;
    }
    this.io.broadcast({ t: 'event', kind: a.type === 'generator' ? 'gen_down' : 'asset_down', team: a.team, player: attacker?.id, text: `${a.team === 0 ? 'Blood Eagle' : 'Diamond Sword'} ${a.def.name} destroyed` });
  }

  isPowered(a: Asset): boolean {
    return !a.def.needsPower || this.teamPowered(a.team);
  }

  /** A base has power while any of its generators stands (or it has none, or the mode has no bases). */
  teamPowered(team: number): boolean {
    if (!this.mode.usesBases) return true;
    const gens = this.assets.filter((g) => g.type === 'generator' && g.team === team);
    return !gens.length || gens.some((g) => !g.destroyed);
  }

  // ------------------------------------------------------------------ assets
  private stepAssets() {
    // Map force fields (TA team blockers, SunStar's flag shields) stand only while the generator powering them does.
    this.map.data.blockers?.forEach((b, i) => {
      const f = this.world.blockers[i];
      if (f) f.off = b.gate !== undefined && !this.teamPowered(b.gate);
    });
    for (const a of [...this.assets]) {
      if (a.def.lifetime && this.now - a.createdAt > a.def.lifetime) { this.removeAsset(a); continue; }
      if (a.type === 'generator' && a.destroyed && a.def.autoRepair) {
        if (this.now - a.destroyedAt > a.def.autoRepair * Math.pow(0.85, a.level)) {
          a.destroyed = false; a.health = a.maxHealth;
          this.io.broadcast({ t: 'event', kind: 'gen_up', team: a.team, text: 'Generator auto-repaired' });
        }
        continue;
      }
      if (a.destroyed) continue;
      const powered = this.isPowered(a);
      switch (a.type) {
        case 'base_turret': case 'light_turret': case 'exr_turret': if (powered) this.turretThink(a); break;
        case 'radar': if (powered) this.radarThink(a); break;
        case 'motion_sensor': this.radarThink(a, true); break;
        case 'repair_kit':
          for (const o of this.players.values()) if (o.alive && o.team === a.team && distSq(o.pos3(), a.pos) < 25) o.health = Math.min(o.maxHealth, o.health + 100 * DT);
          break;
        case 'claymore': case 'focused_claymore': case 'motion_mine': case 'prism_mine': case 'mine': this.mineThink(a); break;
        case 'force_field':
          if (a.box) a.box.noCollide = !powered;
          if (powered) for (const o of this.players.values()) {
            if (!o.alive || o.team === a.team || this.tick % 15 !== 0) continue;
            if (distSq(o.move.pos, a.pos) < 4.5 * 4.5) this.damagePlayer(o, Math.min(800, 240 + Math.hypot(o.move.vel.x, o.move.vel.z) * 12), this.players.get(a.owner) ?? null, 'force_field', false, null, 0);
          }
          break;
        case 'cap_point': this.capPointThink(a); break;
      }
    }
  }

  private turretThink(a: Asset) {
    if (a.team === 255 || this.now < a.nextFire || this.tick % 3 !== 0) return;
    const range = a.def.range ?? 60;
    const muzzle = { x: a.pos.x, y: a.pos.y + a.def.size[1] * 1.6, z: a.pos.z };
    let target: Player | null = null, td = range * range;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === a.team || o.team === 255) continue;
      if (o.packActive && o.loadout.pack === 'stealth_pack' && Math.hypot(o.move.vel.x, o.move.vel.z) < 150 / 3.6) continue;
      const c = { x: o.move.pos.x, y: o.move.pos.y + 1, z: o.move.pos.z };
      const d2 = distSq(c, muzzle);
      if (d2 >= td) continue;
      if (this.world.raycast(muzzle, c, a.id)) continue;
      td = d2; target = o;
    }
    if (!target) return;
    const c = { x: target.move.pos.x, y: target.move.pos.y + 1, z: target.move.pos.z };
    const levelRate = 1 - a.level * 0.1;
    if (a.type === 'light_turret') {
      a.nextFire = this.now + (a.def.refire ?? 0.25);
      const d = Math.sqrt(td);
      this.damagePlayer(target, a.def.damage ?? 65, this.players.get(a.owner) ?? null, 'light_turret', false, null, 0);
      this.io.broadcast({ t: 'fx', kind: 'tracer', pos: muzzle, to: c, item: 'light_turret' });
      void d;
      return;
    }
    const pd = projDef(a.type === 'base_turret' ? 'turret_base' : 'turret_exr')!;
    const lead = this.leadTarget(muzzle, c, target.move.vel, pd.speed);
    const dir = { x: lead.x - muzzle.x, y: lead.y - muzzle.y, z: lead.z - muzzle.z };
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    a.aimYaw = Math.atan2(-dir.x, -dir.z);
    this.spawnProjectile(a.owner, a.team, a.type === 'base_turret' ? 'turret_base' : 'turret_exr', pd, muzzle, { x: dir.x / l, y: dir.y / l, z: dir.z / l }, null);
    this.io.broadcast({ t: 'fx', kind: 'fire', pos: muzzle, item: a.type === 'base_turret' ? 'turret_base' : 'turret_exr' });
    a.nextFire = this.now + (a.def.refire ?? 2) * levelRate;
  }

  leadTarget(from: Vec3, to: Vec3, vel: Vec3, speed: number): Vec3 {
    let t = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / speed;
    for (let i = 0; i < 3; i++) t = Math.hypot(to.x + vel.x * t - from.x, to.y + vel.y * t - from.y, to.z + vel.z * t - from.z) / speed;
    return { x: to.x + vel.x * t, y: to.y + vel.y * t, z: to.z + vel.z * t };
  }

  private radarThink(a: Asset, reveal = false) {
    if (this.tick % 15 !== 0) return;
    const range = (a.def.range ?? 200) * (1 + a.level * 0.3);
    for (const o of this.players.values()) {
      if (!o.alive || o.team === a.team) continue;
      const r = o.hasPerk('stealthy') ? range * 0.1 : range;
      if (!reveal && o.packActive && o.loadout.pack === 'jammer_pack') continue;
      if (distSq(o.move.pos, a.pos) < r * r) o.spottedUntil = Math.max(o.spottedUntil, this.now + 1);
    }
  }

  private mineThink(a: Asset) {
    if (this.now < (a.armedAt ?? 0)) return;
    const trig = a.def.trigger ?? 3;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === a.team) continue;
      if (distSq(o.move.pos, a.pos) > trig * trig) continue;
      if (a.type === 'motion_mine' && Math.hypot(o.move.vel.x, o.move.vel.y, o.move.vel.z) < 120 / 3.6) continue;
      if (a.type === 'claymore' || a.type === 'focused_claymore') {
        const f = dirFromAngles(a.yaw, 0);
        if ((o.move.pos.x - a.pos.x) * f.x + (o.move.pos.z - a.pos.z) * f.z < 0) continue;
      }
      const owner = this.players.get(a.owner) ?? null;
      const fake: LiveProj = {
        id: -1, owner: a.owner, team: a.team, item: a.type, pos: { x: a.pos.x, y: a.pos.y + 0.3, z: a.pos.z }, vel: { x: 0, y: 0, z: 0 }, age: 0, bounces: 0,
        stuck: false, stuckTo: -1, stuckOffset: { x: 0, y: 0, z: 0 }, resting: true, homingTarget: -1, prev: a.pos, explosive: true, isDisc: false,
        def: { speed: 0, gravity: 0, inherit: 0, lifetime: 1, radius: a.def.splash ?? 5, direct: 0, splashMax: a.def.damage ?? 700, splashMin: (a.def.damage ?? 700) * 0.4, impulse: 40000, size: 0.2, model: 'mine', color: 0xff4040 },
      };
      this.removeAsset(a);
      void owner;
      this.explode(fake, null);
      return;
    }
  }

  private capPointThink(a: Asset) {
    const touching = new Set<number>();
    for (const o of this.players.values()) {
      if (!o.alive || o.vehicle) continue;
      const dy = o.move.pos.y - a.pos.y;
      if (Math.hypot(o.move.pos.x - a.pos.x, o.move.pos.z - a.pos.z) < 3.6 && dy > -2 && dy < 4) touching.add(o.team);
    }
    if (touching.size === 1) {
      const team = [...touching][0];
      if (team !== a.capTeam) {
        a.capTeam = team;
        a.team = team;
        for (const d of this.assets) if (d.capLink === a) { d.team = team; d.nextFire = this.now + 1; }
        a.capHeldSince = this.now;
        a.capNextScore = this.now + 5;
        for (const o of this.players.values()) if (o.alive && o.team === team && distSq(o.move.pos, a.pos) < 3.2 * 3.2) { this.earn(o, CREDITS.capPointHold); o.score += 10; o.rewardedSinceDeath = true; }
        this.io.broadcast({ t: 'event', kind: 'cap_point', team, text: `${team === 0 ? 'Blood Eagle' : 'Diamond Sword'} captured point ${a.tag ?? ''}` });
        // Damaged defenses return to half health when a point is taken.
        for (const d of this.assets) if (d.team === team && d.owner < 0 && d.def.health && d.health < d.maxHealth / 2 && distSq(d.pos, a.pos) < 150 * 150) { d.health = d.maxHealth / 2; d.destroyed = false; }
      }
    }
    if (a.capTeam !== undefined && a.capTeam !== 255 && this.phase === PHASE.PLAYING && this.now >= (a.capNextScore ?? Infinity)) {
      this.scores[a.capTeam]++;
      a.capNextScore = this.now + 5;
    }
  }

  // ------------------------------------------------------------------ vehicles
  buyVehicle(p: Player, type: VehicleType) {
    if (!this.mode.vehicles || !p.alive || p.vehicle) return;
    const def = VEHICLES[type];
    if (!def) return;
    const pad = this.assets.filter((a) => a.type === 'vehicle_pad' && a.team === p.team).sort((a, b) => distSq(a.pos, p.move.pos) - distSq(b.pos, p.move.pos))[0];
    if (!pad || distSq(pad.pos, p.move.pos) > 8 * 8) { this.io.send(p, { t: 'toast', text: 'Stand at a vehicle station' }); return; }
    if (!this.isPowered(pad)) { this.io.send(p, { t: 'toast', text: 'Vehicle station has no power' }); return; }
    const cost = Math.round(def.cost * (p.hasPerk('wheel_deal') ? 0.75 : 1));
    if (this.mode.id !== 'training' && p.credits < cost) { this.io.send(p, { t: 'toast', text: `Need ${cost} credits` }); return; }
    if (this.vehicles.filter((v) => v.team === p.team && v.type === type).length >= def.maxPerTeam) { this.io.send(p, { t: 'toast', text: `Team ${def.name} limit reached` }); return; }
    if (this.mode.id !== 'training') p.credits -= cost;
    const vpad = this.entities.filter((e) => e.kind === 'bookmark' && e.tag === 'vpad').sort((a, b) => distSq(a.pos, pad.pos) - distSq(b.pos, pad.pos))[0];
    const f = dirFromAngles(pad.yaw, 0);
    const pos = vpad && distSq(vpad.pos, pad.pos) < 40 * 40 ? { ...vpad.pos, y: vpad.pos.y + 2 } : { x: pad.pos.x - f.x * 6.4, y: pad.pos.y + 2.5, z: pad.pos.z - f.z * 6.4 };
    const v: Vehicle = {
      id: this.nextVeh++ & 255, type, def, team: p.team, pos, vel: { x: 0, y: 0, z: 0 }, yaw: p.lastCmd.yaw, pitch: 0, roll: 0, health: def.health * (p.hasPerk('pilot') ? 1.2 : 1),
      energy: def.energy, driver: null, gunner: null, clip: def.weapon.clip, reloadUntil: 0, nextFire: 0, gunnerNext: 0, emptySince: this.now, box: null,
    };
    this.vehicles.push(v);
    this.enterVehicle(p, v, 0);
  }

  enterVehicle(p: Player, v: Vehicle, seat: number) {
    if (p.flag && this.mode.id === 'ctf') { this.io.send(p, { t: 'toast', text: 'Flag carriers cannot use vehicles' }); return; }
    if (seat === 0) v.driver = p; else v.gunner = p;
    p.vehicle = v; p.seat = seat;
    p.packActive = false;
    v.team = p.team;
  }

  exitVehicle(p: Player, dead = false) {
    const v = p.vehicle;
    if (!v) return;
    if (v.driver === p) v.driver = null;
    if (v.gunner === p) v.gunner = null;
    p.vehicle = null;
    if (!v.driver && !v.gunner) v.emptySince = this.now;
    if (dead) return;
    const side = { x: Math.cos(v.yaw) * (v.def.size[0] + 1.5), z: -Math.sin(v.yaw) * (v.def.size[0] + 1.5) };
    p.move.pos = { x: v.pos.x + side.x, y: v.pos.y + 1, z: v.pos.z + side.z };
    p.move.vel = { ...v.vel };
  }

  switchSeat(p: Player, seat: number) {
    const v = p.vehicle;
    if (!v || seat === p.seat || seat >= v.def.seats) return;
    if (seat === 0 && !v.driver) { v.gunner = null; v.driver = p; p.seat = 0; }
    else if (seat === 1 && !v.gunner) { v.driver = null; v.gunner = p; p.seat = 1; }
  }

  private vehicleInput(p: Player, cmd: InputCmd) {
    const v = p.vehicle!;
    const edge = (b: number) => (cmd.buttons & b) !== 0 && (p.prevButtons & b) === 0;
    if (edge(BTN.USE)) { this.exitVehicle(p); return; }
    if (p.seat === 1) {
      if ((cmd.buttons & BTN.FIRE) && this.now >= v.gunnerNext && v.def.gunner) {
        v.gunnerNext = this.now + v.def.gunner.refire;
        const eye = { x: v.pos.x, y: v.pos.y + v.def.size[1] + 1, z: v.pos.z };
        const dir = dirFromAngles(cmd.yaw + (this.rng() - 0.5) * v.def.gunner.spread, cmd.pitch + (this.rng() - 0.5) * v.def.gunner.spread);
        const end = this.hitscan(p, eye, dir, 300, (t, _d) => this.damagePlayer(t, v.def.gunner!.damage, p, 'veh_beowulf_gun', false, dir, 0));
        if (this.tick % 3 === 0) this.io.broadcast({ t: 'fx', kind: 'tracer', pos: eye, to: end, item: 'veh_beowulf_gun', player: p.id });
      }
      return;
    }
    const d = v.def;
    const turnRate = d.flying ? 2.4 : v.type === 'gravcycle' ? 3.2 : 1.4;
    let dy = cmd.yaw - v.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    v.yaw += clamp(dy, -turnRate * DT, turnRate * DT);
    const boosting = (cmd.buttons & BTN.JET) !== 0 && v.energy > 0;
    if (boosting) v.energy = Math.max(0, v.energy - 25 * DT); else v.energy = Math.min(d.energy, v.energy + 12 * DT);
    const accel = d.accel + (boosting ? d.boostAccel : 0);
    const maxSpeed = d.maxSpeed * (boosting ? 1.3 : 1);
    if (d.flying) {
      v.pitch = clamp(cmd.pitch, -1.2, 1.2);
      const f = dirFromAngles(v.yaw, v.pitch);
      v.vel.x += f.x * cmd.fwd * accel * DT; v.vel.y += f.y * cmd.fwd * accel * DT; v.vel.z += f.z * cmd.fwd * accel * DT;
      const r = { x: Math.cos(v.yaw), z: -Math.sin(v.yaw) };
      v.vel.x += r.x * cmd.strafe * accel * 0.4 * DT; v.vel.z += r.z * cmd.strafe * accel * 0.4 * DT;
      const hs = Math.hypot(v.vel.x, v.vel.y, v.vel.z);
      const g = GRAVITY * this.world.gravityScale;
      v.vel.y += g * DT * Math.min(1, hs / 20) - g * DT;
      if (cmd.buttons & BTN.SKI) v.vel.y -= 10 * DT;
      v.roll = clamp(-dy * 1.5, -0.8, 0.8);
    } else {
      const f = { x: -Math.sin(v.yaw), z: -Math.cos(v.yaw) };
      v.vel.x += f.x * cmd.fwd * accel * DT; v.vel.z += f.z * cmd.fwd * accel * DT;
      if (v.type === 'beowulf') { const r = { x: Math.cos(v.yaw), z: -Math.sin(v.yaw) }; v.vel.x += r.x * cmd.strafe * accel * 0.5 * DT; v.vel.z += r.z * cmd.strafe * accel * 0.5 * DT; }
      v.pitch = clamp(cmd.pitch, -0.6, 0.6);
    }
    const hs = Math.hypot(v.vel.x, v.vel.z);
    if (hs > maxSpeed) { v.vel.x *= maxSpeed / hs; v.vel.z *= maxSpeed / hs; }
    if ((cmd.buttons & BTN.FIRE) && this.now >= v.nextFire && this.now >= v.reloadUntil && v.clip > 0) {
      const pd = projDef(`veh_${v.type}`)!;
      const dir = dirFromAngles(v.type === 'beowulf' ? cmd.yaw : v.yaw, v.type === 'beowulf' ? cmd.pitch : v.pitch);
      const muzzle = { x: v.pos.x + dir.x * (d.size[2] + 1), y: v.pos.y + d.size[1] * 0.8 + dir.y * 2, z: v.pos.z + dir.z * (d.size[2] + 1) };
      this.spawnProjectile(p.id, v.team, `veh_${v.type}`, pd, muzzle, dir, v.vel);
      v.clip--; v.nextFire = this.now + d.weapon.refire;
      if (v.clip <= 0) { v.reloadUntil = this.now + d.weapon.reload; v.clip = d.weapon.clip; }
      // The driver hears their own shots from this too (vehicle fire is not predicted).
      this.io.broadcast({ t: 'fx', kind: 'fire', pos: muzzle, item: `veh_${v.type}`, player: p.id });
    }
  }

  private stepVehicles() {
    for (const v of [...this.vehicles]) {
      const d = v.def;
      if (!d.flying) {
        const h = this.world.terrain.heightAt(v.pos.x, v.pos.z);
        const target = h + d.hover;
        if (v.pos.y < target + 2.5) v.vel.y += ((target - v.pos.y) * 22 - v.vel.y * 5) * DT;
        v.vel.y -= GRAVITY * this.world.gravityScale * DT * (v.pos.y > target + 2.5 ? 1 : 0.15);
        const n = this.world.terrain.normalAt(v.pos.x, v.pos.z);
        const f = { x: -Math.sin(v.yaw), z: -Math.cos(v.yaw) };
        v.pitch = Math.asin(clamp(f.x * n.x + f.z * n.z, -1, 1)) * -1;
        v.roll = 0;
      } else if (!v.driver) {
        v.vel.y -= GRAVITY * this.world.gravityScale * DT;
      }
      const drag = v.driver ? (d.flying ? 0.25 : 0.6) : 1.8;
      v.vel.x *= 1 - drag * DT; v.vel.z *= 1 - drag * DT;
      if (d.flying) v.vel.y *= 1 - 0.5 * DT;
      const prev = { ...v.pos };
      const speed = Math.hypot(v.vel.x, v.vel.y, v.vel.z);
      v.pos.x += v.vel.x * DT; v.pos.y += v.vel.y * DT; v.pos.z += v.vel.z * DT;
      const c = this.world.resolveCapsule(v.pos, v.vel, d.size[0], d.size[1] * 2, undefined, prev);
      if (c.impact > 25) this.damageVehicle(v, (c.impact - 25) * 80, null, 'vehicle_crash', true);
      if (speed > 12) {
        for (const o of this.players.values()) {
          if (!o.alive || o.vehicle || distSq(o.move.pos, v.pos) > (d.size[2] + 1) ** 2) continue;
          if (o.team !== v.team) {
            if (!o.hasPerk('safe_fall')) this.damagePlayer(o, speed * (v.type === 'beowulf' ? 80 : 35), v.driver, 'vehicle_crash', true, v.vel, 0);
          }
          const dir = { x: o.move.pos.x - v.pos.x, y: 1, z: o.move.pos.z - v.pos.z };
          const l = Math.hypot(dir.x, dir.z) || 1;
          o.move.vel.x += (dir.x / l) * speed * 0.6; o.move.vel.y += 4; o.move.vel.z += (dir.z / l) * speed * 0.6;
        }
      }
      for (const occ of [v.driver, v.gunner]) {
        if (!occ) continue;
        occ.move.pos = { x: v.pos.x, y: v.pos.y, z: v.pos.z };
        occ.move.vel = { ...v.vel };
      }
      if (!v.driver && !v.gunner && this.now - v.emptySince > 60) this.destroyVehicle(v, null);
      if (v.pos.y < this.killZ || v.pos.y < this.hazardY || this.volumeAt(v.pos)?.kind === 'kill') this.destroyVehicle(v, null);
    }
  }

  damageVehicle(v: Vehicle, amount: number, attacker: Player | null, item: string, explosive: boolean) {
    if (!explosive || this.phase === PHASE.WARMUP) return;
    amount *= assetDamageMult(true, false, v.type === 'shrike' ? 'shrike' : 'vehicle');
    v.health -= amount;
    if (attacker) this.io.send(attacker, { t: 'hit', target: v.id, dmg: Math.round(amount), kind: 'vehicle' });
    if (v.health <= 0) this.destroyVehicle(v, attacker, item);
  }

  destroyVehicle(v: Vehicle, attacker: Player | null, item = 'vehicle_crash') {
    this.vehicles = this.vehicles.filter((x) => x !== v);
    this.io.broadcast({ t: 'fx', kind: 'explode', pos: v.pos, radius: 8, item: `vehicle_${v.type}` });
    for (const occ of [v.driver, v.gunner]) {
      if (!occ) continue;
      occ.vehicle = null;
      if (occ.hasPerk('pilot')) { occ.move.vel.y += 25; continue; }
      this.kill(occ, attacker, item);
    }
    if (attacker) { this.earn(attacker, 200); attacker.score += 10; }
  }

  // ------------------------------------------------------------------ call-ins
  callIn(p: Player, kind: CallInType, target: Vec3) {
    const def = CALLINS[kind];
    if (!def || !this.mode.callIns || !p.alive || this.phase !== PHASE.PLAYING) return;
    const key = `${p.team}:${kind}`;
    const infinite = !!this.cfg.options?.infiniteCallIns;
    const spamKey = `p${p.id}`;
    if (infinite && (this.callInCooldown.get(spamKey) ?? 0) > this.now) return;
    if (!infinite && (this.callInCooldown.get(key) ?? 0) > this.now) { this.io.send(p, { t: 'toast', text: `${def.name} is recharging` }); return; }
    if (!infinite && p.credits < def.cost) { this.io.send(p, { t: 'toast', text: `${def.name} costs ${def.cost} credits` }); return; }
    const eye = p.eye();
    if (!Number.isFinite(target.x + target.y + target.z) || Math.hypot(target.x - eye.x, target.z - eye.z) > 900) return;
    const dir = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    const hit = this.world.raycast(eye, { x: eye.x + (dir.x / l) * (l + 2), y: eye.y + (dir.y / l) * (l + 2), z: eye.z + (dir.z / l) * (l + 2) });
    if (!hit || Math.hypot(hit.point.x - target.x, hit.point.y - target.y, hit.point.z - target.z) > 6) { this.io.send(p, { t: 'toast', text: 'Target not visible' }); return; }
    if (infinite) this.callInCooldown.set(spamKey, this.now + 2);
    else { p.credits -= def.cost; this.callInCooldown.set(key, this.now + def.cooldown); }
    this.strikes.push({ at: this.now + def.targetTime + (kind === 'orbital_strike' ? 4 : 1.5), kind, pos: hit.point, team: p.team, owner: p.id });
    this.io.broadcast({ t: 'fx', kind: 'strike_warn', pos: hit.point, item: kind, radius: def.radius, player: p.id });
    this.io.broadcast({ t: 'event', kind: 'callin', team: p.team, player: p.id, text: `${p.name} called in a ${def.name}` });
  }

  private stepStrikes() {
    for (const s of [...this.strikes]) {
      if (this.now < s.at) continue;
      this.strikes = this.strikes.filter((x) => x !== s);
      const def = CALLINS[s.kind];
      const owner = this.players.get(s.owner) ?? null;
      this.io.broadcast({ t: 'fx', kind: 'strike', pos: s.pos, item: s.kind, radius: def.radius });
      if (s.kind === 'supply_drop') {
        for (const o of this.players.values()) if (o.alive && Math.hypot(o.move.pos.x - s.pos.x, o.move.pos.z - s.pos.z) < def.radius) this.kill(o, owner, 'supply_drop');
        this.addAsset('supply_drop', s.team, s.pos, 0, s.owner);
        continue;
      }
      for (const o of this.players.values()) {
        if (!o.alive || (owner && !this.isEnemy(owner, o) && o !== owner)) continue;
        if (Math.hypot(o.move.pos.x - s.pos.x, o.move.pos.y - s.pos.y, o.move.pos.z - s.pos.z) < def.radius) this.damagePlayer(o, def.damage, owner, s.kind, true, null, 0);
      }
      for (const a of [...this.assets]) if (a.team !== s.team && distSq(a.pos, s.pos) < def.radius * def.radius) this.damageAsset(a, def.damage, owner, s.kind, true, false);
      for (const v of [...this.vehicles]) if (v.team !== s.team && distSq(v.pos, s.pos) < def.radius * def.radius) this.damageVehicle(v, def.damage, owner, s.kind, true);
    }
  }

  // ------------------------------------------------------------------ flags
  private checkFlagTouch(p: Player) {
    if (this.phase !== PHASE.PLAYING && this.phase !== PHASE.WARMUP) return;
    const reach = FLAG_GRAB_RADIUS * (p.hasPerk('reach') ? 1.5 : 1) + p.phys.radius;
    const c = { x: p.move.pos.x, y: p.move.pos.y + 1, z: p.move.pos.z };
    for (const f of this.flags) {
      if (!f.active || f.state === 1) continue;
      if (distSq(c, f.pos) > reach * reach) continue;
      if ((f as FlagState & { noGrab?: number; noGrabUntil?: number }).noGrab === p.id && this.now < ((f as FlagState & { noGrabUntil?: number }).noGrabUntil ?? 0)) continue;
      if (this.mode.id === 'ctf' || this.mode.id === 'blitz') {
        if (f.team === p.team) {
          if (f.state === 2) this.returnFlag(f, p);
          continue;
        }
        if (p.vehicle) continue;
        this.grabFlag(f, p);
      } else if (!p.flag) {
        this.grabFlag(f, p);
      }
    }
    if ((this.mode.id === 'ctf' || this.mode.id === 'blitz') && p.flag && p.flag.team !== p.team) {
      const own = this.flags.find((f) => f.team === p.team);
      if (own && own.state === 0 && distSq(c, own.home) < (reach + 0.5) ** 2) this.captureFlag(p);
    }
  }

  private grabFlag(f: FlagState, p: Player) {
    const wasHome = f.state === 0;
    f.state = 1; f.carrier = p; p.flag = f;
    p.rewardedSinceDeath = true;
    if (wasHome) { this.earn(p, CREDITS.flagGrab); p.score += 10; }
    if (this.mode.id === 'rabbit') { p.modeScore += 1; }
    this.io.broadcast({ t: 'event', kind: 'flag_grab', team: f.team, player: p.id, text: `${p.name} took the ${this.flagName(f)}` });
    if (f.team <= 1) {
      for (const o of this.players.values()) {
        if (o.alive && o.team === f.team && o.hasPerk('rage') && distSq(o.move.pos, f.home) < 230 * 230) {
          o.rageUntil = this.now + 15; o.health = o.maxHealth; o.move.energy = o.maxEnergy;
        }
      }
    }
    for (const o of this.players.values()) o.brain?.onFlagEvent(this, o, 'grab', f, p);
  }

  private returnFlag(f: FlagState, p: Player | null) {
    f.state = 0; f.carrier = null; f.pos = { ...f.home }; f.vel = { x: 0, y: 0, z: 0 };
    if (p) { p.returns++; this.earn(p, CREDITS.flagReturn); p.score += 10; p.rewardedSinceDeath = true; }
    this.io.broadcast({ t: 'event', kind: 'flag_return', team: f.team, player: p?.id, text: p ? `${p.name} returned the ${this.flagName(f)}` : `The ${this.flagName(f)} was returned` });
  }

  private captureFlag(p: Player) {
    const f = p.flag!;
    p.flag = null;
    p.caps++;
    this.earn(p, CREDITS.flagCapture);
    p.score += 50;
    this.scores[p.team]++;
    if (this.mode.id === 'blitz' && f.stands.length > 1) {
      f.standIndex = (f.standIndex + 1 + Math.floor(this.rng() * (f.stands.length - 1))) % f.stands.length;
      f.home = { ...f.stands[f.standIndex] };
    }
    f.state = 0; f.carrier = null; f.pos = { ...f.home };
    this.io.broadcast({ t: 'event', kind: 'flag_cap', team: p.team, player: p.id, text: `${p.name} captured the ${this.flagName(f)}!` });
    for (const o of this.players.values()) o.brain?.onFlagEvent(this, o, 'cap', f, p);
  }

  dropFlag(p: Player, thrown: boolean) {
    const f = p.flag;
    if (!f) return;
    p.flag = null;
    f.state = 2; f.carrier = null; f.droppedAt = this.now;
    f.pos = { x: p.move.pos.x, y: p.move.pos.y + 1.2, z: p.move.pos.z };
    const aim = dirFromAngles(p.lastCmd.yaw, p.lastCmd.pitch);
    f.vel = thrown
      ? { x: aim.x * FLAG_THROW_SPEED + p.move.vel.x, y: aim.y * FLAG_THROW_SPEED + p.move.vel.y + 3, z: aim.z * FLAG_THROW_SPEED + p.move.vel.z }
      : { x: p.move.vel.x * 0.8, y: p.move.vel.y * 0.8 + 2, z: p.move.vel.z * 0.8 };
    Object.assign(f, { noGrab: p.id, noGrabUntil: this.now + 1 });
    this.io.broadcast({ t: 'event', kind: 'flag_drop', team: f.team, player: p.id, text: `${p.name} dropped the ${this.flagName(f)}` });
  }

  private flagName(f: FlagState): string {
    return f.team === 0 ? 'Blood Eagle flag' : f.team === 1 ? 'Diamond Sword flag' : 'flag';
  }

  private stepFlags() {
    for (const f of this.flags) {
      if (!f.active) continue;
      if (f.state === 1 && f.carrier) {
        f.pos = { x: f.carrier.move.pos.x, y: f.carrier.move.pos.y + 1.4, z: f.carrier.move.pos.z };
        if (this.mode.id === 'rabbit' && this.phase === PHASE.PLAYING && this.tick % (60 * 10) === 0) f.carrier.modeScore += 1;
      } else if (f.state === 2) {
        f.vel.y -= GRAVITY * this.world.gravityScale * DT;
        const next = { x: f.pos.x + f.vel.x * DT, y: f.pos.y + f.vel.y * DT, z: f.pos.z + f.vel.z * DT };
        const hit = this.world.raycast(f.pos, next);
        if (hit) {
          f.pos = { x: hit.point.x + hit.normal.x * 0.1, y: hit.point.y + hit.normal.y * 0.1, z: hit.point.z + hit.normal.z * 0.1 };
          const vn = f.vel.x * hit.normal.x + f.vel.y * hit.normal.y + f.vel.z * hit.normal.z;
          f.vel = { x: (f.vel.x - 1.6 * vn * hit.normal.x) * 0.5, y: (f.vel.y - 1.6 * vn * hit.normal.y) * 0.5, z: (f.vel.z - 1.6 * vn * hit.normal.z) * 0.5 };
          if (Math.hypot(f.vel.x, f.vel.y, f.vel.z) < 1.5) f.vel = { x: 0, y: 0, z: 0 };
        } else f.pos = next;
        if (f.pos.y < this.killZ || f.pos.y < this.hazardY || this.volumeAt(f.pos)?.kind === 'kill' || ((f.team <= 1) && this.now - f.droppedAt > FLAG_RETURN_TIME)) this.returnFlag(f, null);
      }
    }
  }

  private checkPickups(_p: Player) { /* ammo drops are folded into kills (Looter/Survivalist) */ }

  // ------------------------------------------------------------------ modes
  private modeOnKill(v: Player, killer: Player | null) {
    const m = this.mode.id;
    if (this.phase !== PHASE.PLAYING) return;
    if (m === 'tdm') {
      const f = this.flags[0];
      if (!f.active) { f.active = true; f.state = 2; f.pos = { x: v.move.pos.x, y: v.move.pos.y + 1, z: v.move.pos.z }; f.home = { ...f.pos }; f.vel = { x: 0, y: 4, z: 0 }; f.droppedAt = this.now; }
      if (killer && killer !== v) this.scores[killer.team] += f.carrier && f.carrier.team === killer.team ? 2 : 1;
    } else if (m === 'rabbit') {
      if (killer && killer !== v && (killer.flag || v.flag)) killer.modeScore += 1;
    }
  }

  private stepMode() {
    const now = this.now;
    if (this.phase === PHASE.WARMUP && now >= this.phaseEnd) {
      this.phase = PHASE.PLAYING;
      this.phaseEnd = this.mode.timeLimit > 0 ? now + this.mode.timeLimit * 60 : Infinity;
      this.scores = [0, 0];
      for (const p of this.players.values()) { p.kills = p.deaths = p.assists = p.caps = p.returns = 0; p.score = 0; p.modeScore = 0; p.credits = CREDITS.start; if (p.alive) this.kill(p, null, 'none', true); p.respawnAt = now; }
      this.io.broadcast({ t: 'event', kind: 'match_start', text: `${this.mode.name} has begun!` });
      this.broadcastMatch();
      return;
    }
    if (this.phase === PHASE.ROUND_END && now >= this.phaseEnd) {
      this.phase = PHASE.PLAYING;
      this.tickets = [this.mode.respawnTickets ?? 25, this.mode.respawnTickets ?? 25];
      for (const p of this.players.values()) { if (p.alive) this.kill(p, null, 'none', true); p.respawnAt = now; p.diedAt = 0; p.deaths = 0; }
      this.broadcastMatch();
      return;
    }
    if (this.phase !== PHASE.PLAYING) return;

    if (this.mode.id === 'arena') {
      for (const team of [0, 1]) {
        const members = [...this.players.values()].filter((p) => p.team === team && !p.spectator);
        if (!members.length) continue;
        const anyAlive = members.some((p) => p.alive || (this.canRespawn(p) && this.tickets[team] > 0));
        if (!anyAlive && members.every((p) => !p.alive)) {
          const winner = 1 - team;
          this.roundWins[winner]++;
          this.scores = [...this.roundWins] as [number, number];
          this.io.broadcast({ t: 'event', kind: 'round_end', team: winner, text: `${winner === 0 ? 'Blood Eagle' : 'Diamond Sword'} wins the round` });
          if (this.roundWins[winner] >= (this.mode.roundsToWin ?? 2)) { this.endMatch(winner); return; }
          this.phase = PHASE.ROUND_END;
          this.phaseEnd = now + 5;
          this.broadcastMatch();
          return;
        }
      }
    }

    if (this.mode.id === 'rabbit') {
      let top: Player | null = null;
      for (const p of this.players.values()) if (!top || p.modeScore > top.modeScore) top = p;
      if (top && top.modeScore >= this.mode.scoreLimit) { this.endMatch(top.id); return; }
    } else if (this.mode.scoreLimit > 0 && this.mode.id !== 'arena') {
      for (const t of [0, 1]) if (this.scores[t] >= this.mode.scoreLimit) { this.endMatch(t); return; }
    }
    if (now >= this.phaseEnd) {
      const winner = this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1;
      this.endMatch(winner);
    }
    if (this.tick % 60 === 0) this.broadcastMatch();
  }

  endMatch(winner: number) {
    this.phase = PHASE.POSTGAME;
    this.phaseEnd = this.now + 15;
    this.broadcastMatch(winner);
    this.io.onMatchOver(winner);
  }

  broadcastMatch(winner?: number) {
    this.io.broadcast({
      t: 'match', phase: this.phase, timeLeft: Math.max(0, Math.round(this.phaseEnd - this.now)), scores: this.scores, winner,
      round: this.roundWins[0] + this.roundWins[1] + 1, mode: this.mode.id, map: this.map.id, mapName: this.map.name,
    });
  }

  // ------------------------------------------------------------------ snapshots
  private playerSnap(p: Player): PlayerSnap {
    let flags = 0;
    const speed = Math.hypot(p.move.vel.x, p.move.vel.y, p.move.vel.z);
    if (p.alive) flags |= PF.ALIVE;
    if (p.move.jetting) flags |= PF.JETTING;
    if (p.move.skiing) flags |= PF.SKIING;
    if (p.move.onGround) flags |= PF.ON_GROUND;
    if (p.flag) flags |= PF.HAS_FLAG;
    const stealth = p.packActive && p.loadout.pack === 'stealth_pack' && speed < 150 / 3.6 && this.now - p.lastFire > 1 && this.now - p.lastHurt > 0.5;
    if (stealth) flags |= PF.STEALTH;
    if (p.packActive && (p.loadout.pack === 'shield_pack' || p.loadout.pack === 'heavy_shield_pack')) flags |= PF.SHIELD;
    if (p.packActive && p.loadout.pack === 'jammer_pack') flags |= PF.JAMMER;
    if (p.spectator) flags |= PF.SPECTATOR;
    if (p.isBot) flags |= PF.BOT;
    if (p.alive && (p.lastCmd.buttons & BTN.FIRE)) flags |= PF.FIRING;
    if (p.zoomed) flags |= PF.ZOOMED;
    if (this.now < p.invulnUntil) flags |= PF.INVULN;
    if (p.vehicle) flags |= PF.IN_VEHICLE;
    if (this.now < p.rageUntil) flags |= PF.RAGE;
    if (this.now < p.spottedUntil) flags |= PF.SPOTTED;
    return {
      id: p.id, team: p.team, flags, cls: CLASSES.indexOf(p.cls), item: ITEM_INDEX[p.weapon?.def.id ?? 'none'] ?? 0,
      pos: p.move.pos, vel: p.move.vel, yaw: p.lastCmd.yaw, pitch: p.lastCmd.pitch, health: p.health, maxHealth: p.maxHealth,
      energy: p.move.energy, vehicle: p.vehicle ? p.vehicle.id : 255, seat: p.seat,
    };
  }

  buildSnapshots(send: (p: Player, data: Uint8Array) => void) {
    const players = [...this.players.values()].filter((p) => !p.spectator || p.alive).map((p) => this.playerSnap(p));
    const projectiles = [...this.projectiles.values()].map((pr) => ({ id: pr.id, item: ITEM_INDEX[pr.item] ?? 0, owner: pr.owner < 0 ? 255 : pr.owner, pos: pr.pos, vel: pr.vel }));
    const assets = this.assets.map((a) => {
      let flags = 0;
      if (this.isPowered(a)) flags |= AF.POWERED;
      if (a.destroyed) flags |= AF.DESTROYED;
      flags |= (a.level << AF.LEVEL_SHIFT) & AF.LEVEL_MASK;
      return { id: a.id, type: ASSET_TYPES.indexOf(a.type), team: a.team, health: a.health / a.maxHealth, flags, pos: a.pos, yaw: a.type.includes('turret') ? a.aimYaw : a.yaw, owner: a.owner < 0 ? 255 : a.owner };
    });
    const flags = this.flags.filter((f) => f.active).map((f) => ({ id: f.id, team: f.team, state: f.state, carrier: f.carrier ? f.carrier.id : 255, pos: f.pos }));
    const vehicles = this.vehicles.map((v) => ({
      id: v.id, type: VEHICLE_TYPES.indexOf(v.type), team: v.team, driver: v.driver ? v.driver.id : 255, gunner: v.gunner ? v.gunner.id : 255,
      pos: v.pos, vel: v.vel, yaw: v.yaw, pitch: v.pitch, roll: v.roll, health: v.health / v.def.health, energy: v.energy / v.def.energy,
    }));
    const base: Snapshot = { tick: this.tick, phase: this.phase, timeLeft: this.phaseEnd - this.now, scores: this.scores, self: null, players, projectiles, assets, flags, vehicles };
    for (const p of this.players.values()) {
      if (p.isBot || !p.ready) continue;
      const snap: Snapshot = { ...base, self: null };
      if (!p.spectator) {
        snap.self = {
          ackSeq: p.lastSeq >>> 0, energy: p.move.energy, prevButtons: p.prevButtons, gnX: p.move.groundNormal.x, gnY: p.move.groundNormal.y, gnZ: p.move.groundNormal.z,
          ammo: [...p.weapons.map((w) => [w.clip, w.ammo] as [number, number]), [p.beltCount, 0], [p.packActive ? 1 : 0, 0]],
          credits: p.credits, reload: p.weapon && p.weapon.reloadUntil > this.now ? 1 - (p.weapon.reloadUntil - this.now) / Math.max(0.01, p.weapon.def.reload) : 0,
          charge: p.weapon?.def.chargeTime ? Math.min(1, (this.now - p.weapon.lastShot) / p.weapon.def.chargeTime) : 0, spin: p.weapon?.spin ?? 0,
          respawn: p.alive ? 0 : Math.max(0, p.respawnAt - this.now), slot: p.slot,
        };
        // Include the on-ground flag the predictor needs.
        if (p.move.onGround) snap.self.prevButtons |= 0x8000;
      }
      send(p, encodeSnapshot(snap));
    }
  }
}
