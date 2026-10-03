import { describe, expect, it } from 'vitest';
import {
  ARMOR_PHYSICS, BTN, CollisionWorld, DT, GRAVITY, Heightfield, ITEMS, JET_MAX_THRUST_SPEED, LAYOUTS, PAWN_GRAVITY_SCALE, SKI_SLOPE_GRAVITY_BOOST, advanceProjectile, applyKnockback, buildCollisionWorld,
  decodeInput, decodeMapData, decodeSnapshot, encodeInput, encodeMapData, encodeSnapshot, fragment, generateMap, inVolume, newMoveState, quantizeInput, Reassembler,
  splashKnockback, stepMovement, validateSkinReadability, ARMOR_SKINS, TEAM_COLORS, type InputCmd, type MoveParams, type ProjState,
} from '../src/index.js';

const params = (armor: 'light' | 'medium' | 'heavy' = 'light'): MoveParams => ({
  phys: ARMOR_PHYSICS[armor], maxEnergy: 100, regenMult: 1, runMult: 1, massMult: 1, flagDragSpeed: 0, canJet: true,
});

function slopeWorld(angleDeg: number): CollisionWorld {
  const res = 201, size = 2000;
  const h = new Float32Array(res * res);
  const k = Math.tan((angleDeg * Math.PI) / 180);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) h[j * res + i] = -(-size / 2 + j * (size / (res - 1))) * k;
  return new CollisionWorld(new Heightfield(size, size, res, res, h), []);
}

const cmd = (seq: number, buttons = 0, fwd = 0): InputCmd => ({ seq, fwd, strafe: 0, yaw: Math.PI, pitch: 0, buttons, weapon: 0 });

describe('movement', () => {
  it('skiing down a 30 degree slope gains boosted pawn gravity * sin(30) per second (TA)', () => {
    const world = slopeWorld(30);
    const s = newMoveState({ x: 0, y: world.terrain.heightAt(0, -600) + 0.01, z: -600 });
    s.onGround = true;
    for (let i = 0; i < 60; i++) stepMovement(s, cmd(i, BTN.SKI), params(), world, DT);
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    const g = GRAVITY * PAWN_GRAVITY_SCALE * SKI_SLOPE_GRAVITY_BOOST;
    expect(speed).toBeGreaterThan(g * 0.5 * 0.85);
    expect(speed).toBeLessThan(g * 0.5 * 1.1);
  });

  it('skiing on flat ground keeps speed (frictionless)', () => {
    const world = slopeWorld(0);
    const s = newMoveState({ x: 0, y: 0, z: 0 });
    s.onGround = true;
    s.vel.z = 40;
    for (let i = 0; i < 120; i++) stepMovement(s, cmd(i, BTN.SKI), params(), world, DT);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeGreaterThan(39.5);
  });

  it('walking without ski bleeds high speed', () => {
    const world = slopeWorld(0);
    const s = newMoveState({ x: 0, y: 0, z: 0 });
    s.onGround = true;
    s.vel.z = 40;
    for (let i = 0; i < 120; i++) stepMovement(s, cmd(i, 0), params(), world, DT);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeLessThan(15);
  });

  it('jetting drains energy at the armor rate and lifts the player', () => {
    const world = slopeWorld(0);
    const s = newMoveState({ x: 0, y: 0, z: 0 });
    s.onGround = true;
    s.energy = 100;
    for (let i = 0; i < 60; i++) stepMovement(s, cmd(i, BTN.JET), params(), world, DT);
    expect(s.pos.y).toBeGreaterThan(5);
    expect(100 - s.energy).toBeGreaterThan(ARMOR_PHYSICS.light.jetDrain * 0.9);
  });

  it('held jets settle into a climb below the TA max thrust speed', () => {
    const world = slopeWorld(0);
    const s = newMoveState({ x: 0, y: 0, z: 0 });
    s.onGround = true;
    for (let i = 0; i < 360; i++) stepMovement(s, cmd(i, BTN.JET), { ...params(), infiniteEnergy: true }, world, DT);
    expect(s.vel.y).toBeGreaterThan(12);
    expect(s.vel.y).toBeLessThan(JET_MAX_THRUST_SPEED);
  });

  it('scales pawn and projectile gravity with the host setting', () => {
    const fall = (scale: number) => {
      const world = slopeWorld(0);
      world.gravityScale = scale;
      const s = newMoveState({ x: 0, y: 100, z: 0 });
      for (let i = 0; i < 60; i++) stepMovement(s, cmd(i), params(), world, DT);
      const p: ProjState = { id: 1, owner: 0, team: 0, item: 'x', pos: { x: 0, y: 100, z: 0 }, vel: { x: 0, y: 0, z: 0 }, age: 0, bounces: 0, stuck: false, stuckTo: -1, stuckOffset: { x: 0, y: 0, z: 0 }, resting: false, homingTarget: -1 };
      for (let i = 0; i < 60; i++) advanceProjectile(p, { ...ITEMS.spinfusor.projectile!, gravity: 1, lifetime: 10 }, world, DT);
      return [s.vel.y, p.vel.y];
    };
    const [pawn1, proj1] = fall(1), [pawn2, proj2] = fall(1.5);
    expect(pawn2 / pawn1).toBeCloseTo(1.5, 1);
    expect(proj2 / proj1).toBeCloseTo(1.5, 2);
  });

  it('is deterministic for identical input streams', () => {
    const world = slopeWorld(20);
    const run = () => {
      const s = newMoveState({ x: 3, y: world.terrain.heightAt(3, -300), z: -300 });
      for (let i = 0; i < 300; i++) stepMovement(s, quantizeInput({ ...cmd(i, i % 90 < 40 ? BTN.SKI : BTN.JET, 1), strafe: Math.sin(i / 10) }), params('medium'), world, DT);
      return s;
    };
    const a = run(), b = run();
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
  });
});

describe('projectiles', () => {
  it('spinfusor disc covers 78 m/s with no drop', () => {
    const world = slopeWorld(0);
    const def = ITEMS.spinfusor.projectile!;
    const p: ProjState = { id: 1, owner: 0, team: 0, item: 'spinfusor', pos: { x: 0, y: 10, z: 0 }, vel: { x: 0, y: 0, z: -def.speed }, age: 0, bounces: 0, stuck: false, stuckTo: -1, stuckOffset: { x: 0, y: 0, z: 0 }, resting: false, homingTarget: -1 };
    for (let i = 0; i < 60; i++) advanceProjectile(p, def, world, DT);
    expect(p.pos.z).toBeCloseTo(-78, 0);
    expect(p.pos.y).toBeCloseTo(10, 3);
  });

  it('disc jumps follow TA: own splash x1.5, full impulse near the centre, grounded kicks lifted', () => {
    const ph = ARMOR_PHYSICS.light, d = ITEMS.light_spinfusor.projectile!;
    // Disc at a light's feet: 85000 * 1.5 / 100 kg / 50 = 25.5 m/s.
    const k = splashKnockback({ x: 0.3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, ph.height, d.radius, d.impulse, ph.mass, true, d.knockMin, d.selfLift)!;
    expect(Math.hypot(k.x, k.y, k.z)).toBeCloseTo(25.5, 1);
    // Enemies get the plain impulse, fading only past the inner part of the radius.
    const e = splashKnockback({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, ph.height, d.radius, d.impulse, ph.mass, false, d.knockMin)!;
    expect(Math.hypot(e.x, e.y, e.z)).toBeCloseTo(17, 1);
    expect(splashKnockback({ x: 8, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, ph.height, d.radius, d.impulse, ph.mass, false, d.knockMin)).toBeNull();
    // A sideways kick on the ground still pops the player up (UE3 bExtraMomentumZ).
    const s = { vel: { x: 0, y: 0, z: 0 }, onGround: true };
    applyKnockback(s, { x: 20, y: 0, z: 0 });
    expect(s.vel.y).toBeCloseTo(8, 5);
    expect(s.onGround).toBe(false);
  });
});

describe('map mechanics', () => {
  const flat = () => {
    const m = generateMap(LAYOUTS.find((l) => l.id === 'walledin')!);
    m.terrain = new Heightfield(400, 400, 5, 5, new Float32Array(25), -200, -200);
    m.boxes = [];
    return m;
  };
  const cube = (c: { x: number; y: number; z: number }, r: number) => ({
    min: { x: c.x - r, y: c.y - r, z: c.z - r }, max: { x: c.x + r, y: c.y + r, z: c.z + r },
    planes: new Float32Array([1, 0, 0, c.x + r, -1, 0, 0, -(c.x - r), 0, 1, 0, c.y + r, 0, -1, 0, -(c.y - r), 0, 0, 1, c.z + r, 0, 0, -1, -(c.z - r)]),
  });

  it('accelerators set velocity on entry, only for their team', () => {
    const m = flat();
    m.boosts = [{ ...cube({ x: 0, y: 1, z: 0 }, 2), vel: { x: 50, y: 0, z: 0 }, team: 0 }];
    const world = buildCollisionWorld(decodeMapData(encodeMapData(m)));
    for (const [team, boosted] of [[0, true], [1, false]] as const) {
      const s = newMoveState({ x: -4, y: 0, z: 0 });
      s.onGround = true;
      s.vel.x = 20;
      for (let i = 0; i < 12; i++) stepMovement(s, cmd(i, BTN.SKI), { ...params(), team }, world, DT);
      expect(s.vel.x > 40).toBe(boosted);
    }
  });

  it('team force fields stop attackers, pass defenders, and drop with power', () => {
    const m = flat();
    // A 10 x 10 m wall in the x = 0 plane.
    m.meshes = [{ name: 'ASE_ForceField_Collision', mat: 'glass', collide: true, positions: new Float32Array([0, 0, -5, 0, 10, -5, 0, 10, 5, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }];
    m.instances = [{ mesh: 0, m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), team: 1 }];
    m.blockers = [{ instance: 0, team: 1, gate: 1 }];
    const world = buildCollisionWorld(decodeMapData(encodeMapData(m)));
    const run = (team: number) => {
      const s = newMoveState({ x: -3, y: 0, z: 0 });
      s.onGround = true;
      for (let i = 0; i < 60; i++) { s.vel.x = 10; stepMovement(s, cmd(i, BTN.SKI), { ...params(), team }, world, DT); }
      return s.pos.x;
    };
    expect(run(0)).toBeLessThan(0);
    expect(run(1)).toBeGreaterThan(2);
    world.blockers[0].off = true;
    expect(run(0)).toBeGreaterThan(2);
  });

  it('round-trips lightmap UVs and per-instance lightmaps', () => {
    const m = flat();
    m.meshes = [{ name: 'wall', mat: 'concrete', collide: true, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), uvs: new Float32Array(6), uv2: new Float32Array([0, 0, 1, 0, 0, 1]),
      groups: [{ start: 0, count: 3, tex: 0 }] }];
    m.instances = [{ mesh: 0, m: new Float32Array(12), lm: { tex: 1, st: [0.5, 0.25, 0.125, 0.75], scale: [2, 2, 2] } }];
    m.textures = ['T_Wall', 'LM_test_ctf_0'];
    const d = decodeMapData(encodeMapData(m));
    expect(Array.from(d.meshes![0].uv2!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(d.instances![0].lm).toEqual({ tex: 1, st: [0.5, 0.25, 0.125, 0.75], scale: [2, 2, 2] });
  });
});

describe('maps', () => {
  it('generates every reborn layout deterministically', () => {
    for (const spec of LAYOUTS) {
      const a = generateMap(spec);
      expect(a.entities.length).toBeGreaterThan(0);
      expect(Number.isFinite(a.terrain.heightAt(0, 0))).toBe(true);
    }
    const k1 = generateMap(LAYOUTS[0]), k2 = generateMap(LAYOUTS[0]);
    expect(k1.terrain.heights).toEqual(k2.terrain.heights);
    expect(k1.boxes.length).toBe(k2.boxes.length);
  });

  it('CTF layouts have two flag stands and two generators', () => {
    for (const spec of LAYOUTS.filter((l) => l.modes.includes('ctf'))) {
      const m = generateMap(spec);
      const stands = m.entities.filter((e) => e.kind === 'flag_stand');
      expect(new Set(stands.map((s) => s.team))).toEqual(new Set([0, 1]));
      expect(m.entities.filter((e) => e.kind === 'generator').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('round-trips map blobs', () => {
    const m = generateMap(LAYOUTS.find((l) => l.id === 'walledin')!);
    const d = decodeMapData(encodeMapData(m));
    expect(d.boxes.length).toBe(m.boxes.length);
    expect(d.entities.length).toBe(m.entities.length);
    expect(Math.abs(d.terrain.heightAt(10, 10) - m.terrain.heightAt(10, 10))).toBeLessThan(0.05);
  });

  it('round-trips damage volumes, normal maps and liquid tags', () => {
    const m = generateMap(LAYOUTS.find((l) => l.id === 'walledin')!);
    // Unit cube volume around the origin (inside where n·p <= d).
    const planes = new Float32Array([1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1]);
    m.volumes = [{ kind: 'pain', dps: 200, min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 }, planes }];
    m.meshes = [{ name: 'lava_pool', mat: 'rock', collide: true, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), uvs: new Float32Array(6),
      groups: [{ start: 0, count: 3, tex: 0, ntex: 1, fx: 'lava' }] }];
    m.textures = ['T_Lava_DIF', 'T_Lava_NRM'];
    const d = decodeMapData(encodeMapData(m));
    expect(d.volumes?.length).toBe(1);
    expect(d.volumes![0].kind).toBe('pain');
    expect(inVolume(d.volumes![0], { x: 0.5, y: 0, z: -0.5 })).toBe(true);
    expect(inVolume(d.volumes![0], { x: 1.5, y: 0, z: 0 })).toBe(false);
    expect(d.meshes![0].groups![0]).toMatchObject({ tex: 0, ntex: 1, fx: 'lava' });
  });
});

describe('protocol', () => {
  it('round-trips inputs and snapshots, and reassembles fragments', () => {
    const cmds = [cmd(7, BTN.JET | BTN.SKI, 1)];
    expect(decodeInput(encodeInput(cmds))[0].buttons).toBe(BTN.JET | BTN.SKI);
    const snap = encodeSnapshot({
      tick: 5, phase: 1, timeLeft: 300, scores: [1, 2], self: null, assets: [], flags: [], vehicles: [],
      players: Array.from({ length: 32 }, (_, i) => ({ id: i, team: i % 2, flags: 1, cls: 0, item: 0, pos: { x: i, y: 1, z: 2 }, vel: { x: 1, y: 2, z: 3 }, yaw: 1, pitch: 0.2, health: 900, maxHealth: 900, energy: 100, vehicle: 255, seat: 0 })),
      projectiles: Array.from({ length: 40 }, (_, i) => ({ id: i, item: 0, owner: 1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } })),
    });
    const frags = fragment(snap, 42);
    expect(frags.length).toBeGreaterThan(1);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frags.reverse()) out = r.push(f) ?? out;
    const back = decodeSnapshot(out!);
    expect(back.players.length).toBe(32);
    expect(back.players[5].pos.x).toBe(5);
  });
});

describe('cosmetics', () => {
  it('every armor skin stays readable against both team colors', () => {
    for (const s of ARMOR_SKINS) expect(validateSkinReadability(s, TEAM_COLORS)).toBe(true);
  });
});
