import type { ModeId } from '../data/modes.js';
import { rotY } from '../math.js';
import { makeOBB, type OBB } from '../sim/collision.js';
import type { EntityKind, MapEntity, PrefabId, PrefabPlacement } from './spec.js';

/** Places boxes/entities in prefab-local space (local -Z = front) relative to a ground origin. */
export class PrefabBuilder {
  constructor(
    readonly boxes: OBB[],
    readonly entities: MapEntity[],
    readonly ox: number,
    readonly oy: number,
    readonly oz: number,
    readonly yaw: number,
    readonly team: number,
    readonly s: number,
    readonly modes?: ModeId[],
  ) {}

  box(lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, mat = 'concrete', pitch = 0, roll = 0, lyaw = 0): OBB {
    const s = this.s;
    const r = rotY(lx * s, lz * s, this.yaw);
    const b = makeOBB({ x: this.ox + r.x, y: this.oy + ly * s, z: this.oz + r.z }, [hx * s, hy * s, hz * s], this.yaw + lyaw, pitch, roll, mat);
    this.boxes.push(b);
    return b;
  }

  ent(kind: EntityKind, lx: number, ly: number, lz: number, lyaw = 0, extra: Partial<MapEntity> = {}): void {
    const s = this.s;
    const r = rotY(lx * s, lz * s, this.yaw);
    this.entities.push({ kind, team: this.team, pos: { x: this.ox + r.x, y: this.oy + ly * s, z: this.oz + r.z }, yaw: this.yaw + lyaw, modes: this.modes, ...extra });
  }
}

type PrefabFn = (b: PrefabBuilder, rnd: () => number, p: PrefabPlacement) => void;

const BASE_ONLY: ModeId[] = ['ctf', 'cah'];

const mainBase: PrefabFn = (b) => {
  b.box(0, 0.2, 0, 14, 0.2, 11, 'floor');
  b.box(0, 3.25, 10.6, 14, 3.25, 0.4);
  b.box(-8.5, 3.25, -10.6, 5.5, 3.25, 0.4);
  b.box(8.5, 3.25, -10.6, 5.5, 3.25, 0.4);
  b.box(0, 5.75, -10.6, 3, 0.75, 0.4, 'trim');
  for (const sx of [-1, 1]) {
    b.box(sx * 13.6, 3.25, -6.5, 0.4, 3.25, 4.5);
    b.box(sx * 13.6, 3.25, 6.5, 0.4, 3.25, 4.5);
    b.box(sx * 13.6, 5.75, 0, 0.4, 0.75, 2, 'trim');
    // Interior conduits beside the generator.
    b.box(sx * 5.5, 3.2, 6, 0.8, 3, 0.8, 'metal');
  }
  b.box(0, 6.9, 0, 14.4, 0.4, 11.4, 'roof');
  b.box(0, 7.45, 0, 1.8, 0.15, 1.8, 'trim');
  b.ent('flag_stand', 0, 7.6, 0, 0, { modes: ['ctf'] });
  // Rear tower with radar.
  b.box(0, 13.2, 8, 4, 5.9, 3, 'concrete');
  b.box(0, 19.3, 8, 4.6, 0.25, 3.6, 'roof');
  b.ent('radar', 0, 19.6, 8, 0, { modes: BASE_ONLY });
  // Front ski ramp up to the flag roof.
  const rampLen = 16, rise = 7.3, ang = Math.atan2(rise, rampLen);
  b.box(0, rise / 2 - 0.2, -11 - rampLen / 2, 4, 0.3, Math.hypot(rampLen, rise) / 2, 'pad', -ang);
  b.ent('generator', 0, 0.4, 5.5, Math.PI, { modes: BASE_ONLY });
  b.ent('inventory', -11.6, 0.4, 7.5, Math.PI / 2);
  b.ent('inventory', 11.6, 0.4, 7.5, -Math.PI / 2);
  b.ent('repair_station', -8, 0.4, 9.8, Math.PI);
  b.ent('base_turret', -12.5, 7.3, -9.8, 0, { modes: BASE_ONLY });
  for (const [x, z] of [[-7, -17], [7, -17], [-19, 0], [19, 0], [-8, 16], [8, 16], [-19, 12], [19, 12]]) b.ent('spawn', x, 0.5, z, 0);
  b.ent('bookmark', 0, 12, -30, 0);
};

const tower: PrefabFn = (b) => {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * 3.2, 5.2, sz * 3.2, 0.5, 5.2, 0.5, 'metal');
  b.box(0, 0.15, 0, 3.8, 0.15, 3.8, 'floor');
  b.box(0, 3.4, 3.4, 3.2, 1.6, 0.25);
  b.box(0, 6.2, 0, 3.8, 0.25, 3.8, 'floor');
  b.box(0, 10.6, 0, 4.2, 0.3, 4.2, 'roof');
  b.ent('inventory', 0, 0.3, 2.6, Math.PI);
  for (const [x, z] of [[-6, 0], [6, 0], [0, -6]]) b.ent('spawn', x, 0.5, z);
};

const vehiclePad: PrefabFn = (b) => {
  b.box(0, 0.2, 0, 6.5, 0.2, 6.5, 'pad');
  b.box(0, 1.2, -7.2, 1.2, 1.2, 0.5, 'metal');
  b.ent('vehicle_pad', 0, 0.4, -6.4, 0, { modes: b.modes ?? BASE_ONLY });
};

const turretMount: PrefabFn = (b) => {
  b.box(0, 1.5, 0, 1.3, 1.5, 1.3, 'metal');
  b.ent('base_turret', 0, 3, 0, 0, { modes: BASE_ONLY });
};

const genBunker: PrefabFn = (b) => {
  b.box(0, 0.2, 0, 8, 0.2, 6, 'floor');
  b.box(0, 2.75, 5.7, 8, 2.75, 0.3);
  b.box(-5.5, 2.75, -5.7, 2.5, 2.75, 0.3);
  b.box(5.5, 2.75, -5.7, 2.5, 2.75, 0.3);
  b.box(-7.7, 2.75, 2, 0.3, 2.75, 4);
  b.box(7.7, 2.75, 0, 0.3, 2.75, 6);
  b.box(0, 5.8, 0, 8.4, 0.3, 6.4, 'roof');
  b.ent('generator', 0, 0.4, 2, Math.PI, { modes: BASE_ONLY });
  b.ent('inventory', -6.8, 0.4, 4.6, Math.PI / 2);
  b.ent('repair_station', 5.8, 0.4, 4.6, Math.PI);
};

const flagPlatform: PrefabFn = (b) => {
  b.box(0, 1.4, 0, 5, 1.4, 5, 'concrete');
  b.box(0, 2.95, 0, 1.8, 0.15, 1.8, 'trim');
  b.ent('flag_stand', 0, 3.1, 0, 0, { modes: ['ctf'] });
  const ang = Math.atan2(2.8, 6);
  b.box(0, 1.2, -8, 3, 0.25, Math.hypot(6, 2.8) / 2, 'pad', -ang);
  b.box(0, 1.2, 8, 3, 0.25, Math.hypot(6, 2.8) / 2, 'pad', ang);
};

const capPoint: PrefabFn = (b, _r, p) => {
  b.box(0, 0.25, 0, 4.5, 0.25, 4.5, 'pad');
  b.box(-4.2, 1.6, 0, 0.3, 1.1, 3, 'concrete');
  b.box(4.2, 1.6, 0, 0.3, 1.1, 3, 'concrete');
  b.ent('cap_point', 0, 0.5, 0, 0, { team: 255, tag: p.tag, modes: ['cah'] });
  b.ent('inventory', 0, 0.5, 3.6, Math.PI, { team: 255, modes: ['cah'] });
};

const arenaBunker: PrefabFn = (b) => {
  b.box(0, 0.2, 0, 8, 0.2, 6, 'floor');
  b.box(0, 3, 5.8, 8, 3, 0.3);
  b.box(-7.8, 3, 0, 0.3, 3, 6);
  b.box(7.8, 3, 0, 0.3, 3, 6);
  b.box(0, 3, -5.8, 2, 3, 0.3);
  b.box(0, 6.2, 0, 8.3, 0.3, 6.3, 'roof');
  b.ent('inventory', -5, 0.4, 4.6, Math.PI);
  b.ent('inventory', 5, 0.4, 4.6, Math.PI);
  for (const [x, z] of [[-5, 1], [5, 1], [-3, -2], [3, -2], [-5, -8], [5, -8]]) b.ent('spawn', x, 0.5, z);
};

const rock: PrefabFn = (b, rnd) => {
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const w = 2 + rnd() * 4, h = 1.5 + rnd() * 4, d = 2 + rnd() * 4;
    b.box((rnd() - 0.5) * 6, h * 0.6 - 0.8, (rnd() - 0.5) * 6, w, h, d, 'rock', (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6, rnd() * Math.PI);
  }
};

const iceSpike: PrefabFn = (b, rnd) => {
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const h = 6 + rnd() * 14, w = 0.8 + rnd() * 1.6;
    b.box((rnd() - 0.5) * 5, h * 0.8, (rnd() - 0.5) * 5, w, h, w, 'ice', (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7, rnd() * Math.PI);
  }
};

const pillar: PrefabFn = (b, rnd) => {
  const h = 6 + rnd() * 10;
  b.box(0, h / 2, 0, 1.5 + rnd(), h / 2, 1.5 + rnd(), 'rock', 0, 0, rnd() * Math.PI);
};

const arch: PrefabFn = (b) => {
  b.box(-5, 4, 0, 1.2, 4, 1.2, 'concrete');
  b.box(5, 4, 0, 1.2, 4, 1.2, 'concrete');
  b.box(0, 8.6, 0, 6.4, 0.6, 1.4, 'trim');
};

const bridge: PrefabFn = (b, _r, p) => {
  const len = p.len ?? 40;
  b.box(0, 0, 0, 3, 0.35, len / 2, 'metal');
  b.box(-3, 0.8, 0, 0.1, 0.45, len / 2, 'trim');
  b.box(3, 0.8, 0, 0.1, 0.45, len / 2, 'trim');
};

const wall: PrefabFn = (b, _r, p) => {
  const len = p.len ?? 20;
  b.box(0, 2.5, 0, len / 2, 2.5, 0.6, 'concrete');
};

const ruin: PrefabFn = (b, rnd) => {
  b.box(0, 2, 0, 6, 2 + rnd() * 2, 0.6, 'rock', 0, (rnd() - 0.5) * 0.2);
  b.box(5.4, 1.5, 4, 0.6, 1.5 + rnd() * 2, 4, 'rock');
  b.box(-3, 0.6, 3, 1.4, 0.6, 1.4, 'rock', 0.3, 0.2);
};

const crateStack: PrefabFn = (b, rnd) => {
  b.box(0, 1, 0, 1, 1, 1, 'metal', 0, 0, rnd());
  b.box(2.1, 1, 0.3, 1, 1, 1, 'metal', 0, 0, rnd());
  b.box(1, 3, 0.1, 1, 1, 1, 'metal', 0, 0, rnd());
};

const ramp: PrefabFn = (b, _r, p) => {
  const len = p.len ?? 14, rise = (p.scale ?? 1) * 5;
  const ang = Math.atan2(rise, len);
  b.box(0, rise / 2, 0, 3.5, 0.3, Math.hypot(len, rise) / 2, 'pad', -ang);
};

const rabbitFlag: PrefabFn = (b) => {
  b.box(0, 0.3, 0, 2, 0.3, 2, 'trim');
  b.ent('rabbit_flag', 0, 0.8, 0, 0, { team: 255, modes: ['tdm', 'rabbit'] });
};

const blitzStand: PrefabFn = (b) => {
  b.box(0, 0.15, 0, 1.5, 0.15, 1.5, 'trim');
  b.ent('blitz_stand', 0, 0.3, 0, 0, { modes: ['blitz'] });
};

const spawnRing: PrefabFn = (b, _r, p) => {
  const n = 6, r = (p.len ?? 12);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.ent('spawn', Math.cos(a) * r, 0.5, Math.sin(a) * r, a);
  }
};

const sniperNest: PrefabFn = (b) => {
  b.box(0, 5, 0, 0.6, 5, 0.6, 'metal');
  b.box(0, 10.2, 0, 3, 0.25, 3, 'floor');
  b.box(0, 10.9, -2.9, 3, 0.5, 0.1, 'trim');
};

const catwalk: PrefabFn = (b, _r, p) => {
  const len = p.len ?? 30;
  b.box(0, 6, 0, 2, 0.2, len / 2, 'metal');
  for (let z = -len / 2 + 2; z <= len / 2 - 2; z += 10) b.box(0, 3, z, 0.3, 3, 0.3, 'metal');
};

export const PREFABS: Record<PrefabId, { fn: PrefabFn; flatten: number }> = {
  main_base: { fn: mainBase, flatten: 36 },
  tower: { fn: tower, flatten: 10 },
  vehicle_pad: { fn: vehiclePad, flatten: 11 },
  turret_mount: { fn: turretMount, flatten: 4 },
  gen_bunker: { fn: genBunker, flatten: 14 },
  flag_platform: { fn: flagPlatform, flatten: 16 },
  cap_point: { fn: capPoint, flatten: 8 },
  arena_bunker: { fn: arenaBunker, flatten: 14 },
  rock: { fn: rock, flatten: 0 },
  ice_spike: { fn: iceSpike, flatten: 0 },
  pillar: { fn: pillar, flatten: 0 },
  arch: { fn: arch, flatten: 0 },
  bridge: { fn: bridge, flatten: 0 },
  wall: { fn: wall, flatten: 0 },
  ruin: { fn: ruin, flatten: 0 },
  crate_stack: { fn: crateStack, flatten: 3 },
  ramp: { fn: ramp, flatten: 0 },
  rabbit_flag: { fn: rabbitFlag, flatten: 5 },
  blitz_stand: { fn: blitzStand, flatten: 3 },
  spawn_ring: { fn: spawnRing, flatten: 0 },
  sniper_nest: { fn: sniperNest, flatten: 0 },
  catwalk: { fn: catwalk, flatten: 0 },
};
