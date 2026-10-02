import { describe, expect, it } from 'vitest';
import {
  ARMOR_PHYSICS, BTN, CollisionWorld, DT, GRAVITY, Heightfield, ITEMS, LAYOUTS, PAWN_GRAVITY_SCALE, SKI_SLOPE_GRAVITY_BOOST, advanceProjectile, decodeInput, decodeMapData,
  decodeSnapshot, encodeInput, encodeMapData, encodeSnapshot, fragment, generateMap, newMoveState, quantizeInput, Reassembler,
  stepMovement, validateSkinReadability, ARMOR_SKINS, TEAM_COLORS, type InputCmd, type MoveParams, type ProjState,
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
