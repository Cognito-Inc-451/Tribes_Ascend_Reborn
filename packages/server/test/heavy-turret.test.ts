import { describe, expect, it } from 'vitest';
import {
  BTN, ITEM_IDS, PHASE, VEHICLE_TYPES, decodeSnapshot, type InputCmd,
} from '@ar/shared';
import { MapLibrary } from '../src/game/maps.js';
import { Match, type MatchIO } from '../src/game/Match.js';
import { Player } from '../src/game/entities.js';
import type { ServerConfig } from '../src/config.js';

/*
  Player-manned Heavy Turret: deployed from the Technician's Heavy Turret pack,
  entered on deploy, fired with the vehicle gun path, and cleaned up when the
  owner leaves the match or the class.
*/

const CFG: ServerConfig = {
  id: 'test',
  name: 'test',
  mode: 'ctf',
  mapSource: 'reborn',
  maps: ['katabatic'],
  port: 0,
  maxPlayers: 16,
  bots: { fillTo: 0, difficulty: 'recruit' },
};

interface Rec {
  match: Match;
  toasts: string[];
  fx: any[];
}

let seq = 0;

async function makeMatch(): Promise<Rec> {
  const map = await new MapLibrary('__none__').load('katabatic', 'ctf', 'reborn');
  const toasts: string[] = [];
  const fx: any[] = [];
  const io: MatchIO = {
    broadcast: (msg: any) => { if (msg.t === 'fx') fx.push(msg); },
    send: (_p: any, msg: any) => { if (msg.t === 'toast') toasts.push(msg.text); },
    onMatchOver: () => {},
  };
  const match = new Match(CFG, map, io);
  // Warmup ignores damage and ends the match at 10s; run a normal round.
  match.phase = PHASE.PLAYING;
  match.phaseEnd = Number.POSITIVE_INFINITY;
  return { match, toasts, fx };
}

/** Technician with the Heavy Turret pack, spawned and ready (inputs are dropped unless ready). */
function makePlayer(match: Match, id: number, team: number, pack = 'heavy_turret_pack') {
  const p = new Player(id, `P${id}`, null, null);
  match.addPlayer(p);
  match.setTeam(p, team);
  match.setClass(p, 'technician', { pack });
  match.spawn(p);
  p.ready = true;
  return p;
}

function push(p: Player, o: Partial<InputCmd> = {}) {
  p.inputs.push({ seq: ++seq, fwd: 0, strafe: 0, yaw: p.lastCmd.yaw, pitch: p.lastCmd.pitch, buttons: 0, weapon: 0, ...o });
}

function step(match: Match, n = 1) {
  for (let i = 0; i < n; i++) match.step();
}

/** Deploy through the pack button edge (press tick, release tick). */
function deploy(match: Match, p: Player) {
  push(p, { pitch: -0.3, buttons: BTN.PACK });
  match.step();
  push(p, { pitch: -0.3 });
  match.step();
}

const turretOf = (match: Match) => match.vehicles.find((v) => v.type === 'heavy_turret') ?? null;

const wrapPi = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

describe('player-manned heavy turret', () => {
  it('is a pseudo-vehicle type appended to the wire table', () => {
    expect(VEHICLE_TYPES[VEHICLE_TYPES.length - 1]).toBe('heavy_turret');
    expect(ITEM_IDS.indexOf('veh_heavy_turret')).toBeGreaterThan(-1);
    expect(ITEM_IDS.indexOf('heavy_turret_pack')).toBeGreaterThan(-1);
  });

  it('deploys from the pack, plants on the ground and mans the gunner', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    expect(p.loadout.pack).toBe('heavy_turret_pack');
    deploy(match, p);
    const t = turretOf(match);
    expect(t).not.toBeNull();
    expect(t!.owner).toBe(1);
    expect(t!.team).toBe(0);
    expect(t!.clip).toBe(t!.def.weapon.clip);
    expect(p.vehicle).toBe(t);
    expect(t!.driver).toBe(p);
    expect(p.packNext).toBeGreaterThan(match.now);
  });

  it('refuses to be bought at a vehicle pad', async () => {
    const { match, toasts } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    match.buyVehicle(p, 'heavy_turret');
    expect(match.vehicles.length).toBe(0);
    expect(toasts.some((s) => s.includes('deployed from a pack'))).toBe(true);
  });

  it('fires vehicle projectiles while the gunner holds fire', async () => {
    const { match, fx } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    for (let i = 0; i < 40; i++) {
      push(p, { pitch: -0.1, buttons: BTN.FIRE });
      match.step();
    }
    const shots = [...match.projectiles.values()].filter((pr) => pr.item === 'veh_heavy_turret');
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].owner).toBe(1);
    expect(shots[0].team).toBe(0);
    expect(fx.some((m) => m.kind === 'fire' && m.item === 'veh_heavy_turret')).toBe(true);
  });

  it('runs out its clip and reloads', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    // 5 shots at 0.55s refire, then a 4.2s reload: run past the clip.
    for (let i = 0; i < 200; i++) {
      push(p, { pitch: -0.1, buttons: BTN.FIRE });
      match.step();
    }
    expect(t.clip).toBe(t.def.weapon.clip);
    expect(t.reloadUntil).toBeGreaterThan(match.now);
  });

  it('clamps the gun pitch and lerps yaw toward the aim', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    push(p, { pitch: -0.9, buttons: 0 });
    match.step();
    expect(t.pitch).toBeCloseTo(-0.6, 5);
    const yaw0 = t.yaw;
    const target = yaw0 + 1.0;
    for (let i = 0; i < 90; i++) {
      push(p, { yaw: target, pitch: -0.1 });
      match.step();
    }
    expect(Math.abs(wrapPi(target - t.yaw))).toBeLessThan(0.05);
  });

  it('exits with the use key, leaving the emplacement armed and empty', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    push(p, { buttons: BTN.USE });
    match.step();
    expect(p.vehicle).toBeNull();
    expect(t.driver).toBeNull();
    expect(t.gunner).toBeNull();
    expect(match.vehicles).toContain(t);
  });

  it('lets a teammate take the empty seat', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    push(p, { buttons: BTN.USE });
    match.step();
    const mate = makePlayer(match, 2, 0);
    mate.move.pos = { x: t.pos.x + 2, y: t.pos.y, z: t.pos.z };
    push(mate, { buttons: BTN.USE });
    match.step();
    expect(mate.vehicle).toBe(t);
    expect(t.driver).toBe(mate);
  });

  it('lets an enemy take an unmanned emplacement', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    push(p, { buttons: BTN.USE });
    match.step();
    const foe = makePlayer(match, 3, 1);
    foe.move.pos = { x: t.pos.x + 2, y: t.pos.y, z: t.pos.z };
    push(foe, { buttons: BTN.USE });
    match.step();
    expect(foe.vehicle).toBe(t);
    expect(t.team).toBe(1);
  });

  it('survives the empty-vehicle auto-destroy timer', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    const t = turretOf(match)!;
    push(p, { buttons: BTN.USE });
    match.step();
    step(match, 4200); // 70 seconds unoccupied
    expect(match.vehicles).toContain(t);
    expect(t.health).toBe(t.def.health);
  });

  it('is removed when the owner leaves the match', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    expect(turretOf(match)).not.toBeNull();
    match.removePlayer(p);
    expect(turretOf(match)).toBeNull();
  });

  it('is destroyed when the owner is killed', async () => {
    const { match, fx } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    expect(turretOf(match)).not.toBeNull();
    match.kill(p, null, 'veh_heavy_turret');
    expect(turretOf(match)).toBeNull();
    expect(fx.some((m) => m.kind === 'explode' && m.item === 'vehicle_heavy_turret')).toBe(true);
  });

  it('keeps the owner off the wire', async () => {
    const { match } = await makeMatch();
    const p = makePlayer(match, 1, 0);
    deploy(match, p);
    let bytes: Uint8Array | null = null;
    match.buildSnapshots((_p, data) => { bytes ??= data; });
    expect(bytes).not.toBeNull();
    const snap: any = decodeSnapshot(bytes!);
    expect(snap.vehicles.length).toBe(1);
    expect(snap.vehicles[0].type).toBe(VEHICLE_TYPES.indexOf('heavy_turret'));
    expect('owner' in snap.vehicles[0]).toBe(false);
    expect(snap.vehicles[0].driver).toBe(p.id);
  });
});
