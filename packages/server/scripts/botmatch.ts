import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, PHASE, type ModeId } from '@ar/shared';
import type { ServerConfig } from '../src/config.js';
import { BotBrain, BOT_NAMES } from '../src/game/bots.js';
import { Player } from '../src/game/entities.js';
import { MapLibrary } from '../src/game/maps.js';
import { Match } from '../src/game/Match.js';

// Headless bot match: tsx scripts/botmatch.ts <mode> <map> <reborn|original> <bots> <seconds>
const [mode = 'ctf', mapId = 'katabatic', source = 'original', nBots = '14', secs = '300'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const lib = new MapLibrary(resolve(here, '../../../maps-original'));
const cfg: ServerConfig = { id: 'sim', name: 'sim', mode: mode as ModeId, mapSource: source as 'reborn', maps: [mapId], port: 0, maxPlayers: 32, bots: { fillTo: 0, difficulty: 'veteran' } };
const t0 = performance.now();
const map = lib.load(mapId, cfg.mode, cfg.mapSource);
console.log(`map ${map.name} (${map.source}) loaded in ${(performance.now() - t0).toFixed(0)} ms, tris ${map.world.tris?.count ?? 0}, entities ${map.data.entities.length}`);

const events: Record<string, number> = {};
const causes: Record<string, number> = {};
let kills = 0;
const m = new Match(cfg, map, {
  broadcast: (msg) => {
    if (msg.t === 'event') events[msg.kind] = (events[msg.kind] ?? 0) + 1;
    if (msg.t === 'kill') {
      kills++; causes[msg.item] = (causes[msg.item] ?? 0) + 1;
      if (process.env.DEBUG_DEATHS && (msg.item === 'killz' || msg.item === 'fall')) {
        const v = m.players.get(msg.victim)!;
        const { x, y, z } = v.move.pos;
        const tb = map.world.terrain;
        console.log(`${msg.item} ${v.name} ${v.brain!.role} pos(${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)}) terrain ${tb.heightAt(x, z).toFixed(0)} hole ${tb.isHole(x, z)} vel(${v.move.vel.x.toFixed(0)},${v.move.vel.y.toFixed(0)},${v.move.vel.z.toFixed(0)})`);
      }
    }
  },
  send: () => {},
  onMatchOver: (w) => console.log(`match over, winner ${w}`),
});
for (let i = 0; i < Number(nBots); i++) {
  const p = new Player(i, `[BOT] ${BOT_NAMES[i % BOT_NAMES.length]}`, null, new BotBrain('veteran', i * 31 + 7));
  p.ready = true;
  m.addPlayer(p);
  m.setTeam(p, m.autoTeam());
  p.brain!.chooseRole(m, p);
}

const ticks = Number(secs) * 60;
let worst = 0, total = 0;
let maxSpeed = 0;
const stuckLast = new Map<number, { x: number; y: number; z: number; alive: boolean; t: number }>();
const stuckSpots = new Map<string, number>();
for (let i = 0; i < ticks; i++) {
  const s = performance.now();
  m.step();
  if (i % 2 === 0) m.buildSnapshots(() => {});
  const dt = performance.now() - s;
  total += dt; worst = Math.max(worst, dt);
  for (const p of m.players.values()) if (p.alive) maxSpeed = Math.max(maxSpeed, Math.hypot(p.move.vel.x, p.move.vel.z) * 3.6);
  if (process.env.DEBUG_CARRIER && i % 60 === 0) {
    for (const p of m.players.values()) {
      if (!p.alive || !p.flag) continue;
      const own = m.flags.find((f) => f.team === p.team)!;
      const d = Math.hypot(own.home.x - p.move.pos.x, own.home.z - p.move.pos.z);
      console.log(`t=${m.now.toFixed(0)} carrier ${p.name} pos(${p.move.pos.x.toFixed(0)},${p.move.pos.y.toFixed(0)},${p.move.pos.z.toFixed(0)}) home(${own.home.x.toFixed(0)},${own.home.y.toFixed(0)},${own.home.z.toFixed(0)}) dHome=${d.toFixed(0)} ownState=${own.state} v=${(Math.hypot(p.move.vel.x, p.move.vel.z) * 3.6).toFixed(0)} vy=${p.move.vel.y.toFixed(1)} e=${p.move.energy.toFixed(0)} g=${p.move.onGround}`);
    }
  }
  if (process.env.DEBUG_CAH && i % 600 === 0) {
    const pts = m.assets.filter((a) => a.type === 'cap_point');
    console.log(`t=${m.now.toFixed(0)} points ${pts.map((a) => `${a.tag}(${a.pos.x.toFixed(0)},${a.pos.y.toFixed(0)},${a.pos.z.toFixed(0)}) team ${a.capTeam}`).join(' ')}`);
    console.log(`  routes ${pts.map((a) => { const r = m.nav.route(a.pos); return r === undefined ? 'pending' : r === null ? 'none' : `${r.length}wp entrance(${r[0].x.toFixed(0)},${r[0].y.toFixed(0)},${r[0].z.toFixed(0)})`; }).join(' | ')}`);
    for (const p of m.players.values()) {
      if (!p.alive) { console.log(`  ${p.name} dead`); continue; }
      const near = pts.map((a) => Math.hypot(a.pos.x - p.move.pos.x, a.pos.y - p.move.pos.y, a.pos.z - p.move.pos.z)).sort((a, b) => a - b)[0];
      console.log(`  ${p.name} t${p.team} ${p.brain!.role} pos(${p.move.pos.x.toFixed(0)},${p.move.pos.y.toFixed(0)},${p.move.pos.z.toFixed(0)}) nearestPt=${near?.toFixed(1)} v=${(Math.hypot(p.move.vel.x, p.move.vel.z) * 3.6).toFixed(0)} e=${p.move.energy.toFixed(0)} g=${p.move.onGround}`);
    }
  }
  if (process.env.DEBUG && i % 600 === 0) {
    for (const p of m.players.values()) {
      if (!p.alive || !['capper', process.env.DEBUG].includes(p.brain!.role)) continue;
      const ef = m.flags.find((f) => f.team !== p.team);
      const d = ef ? Math.hypot(ef.pos.x - p.move.pos.x, ef.pos.z - p.move.pos.z) : -1;
      console.log(`t=${m.now.toFixed(0)} ${p.name} ${p.brain!.role} pos(${p.move.pos.x.toFixed(0)},${p.move.pos.y.toFixed(0)},${p.move.pos.z.toFixed(0)}) dFlag=${d.toFixed(0)} dy=${ef ? (ef.pos.y - p.move.pos.y).toFixed(0) : ''} v=${(Math.hypot(p.move.vel.x, p.move.vel.z) * 3.6).toFixed(0)} e=${p.move.energy.toFixed(0)} g=${p.move.onGround} hp=${p.health.toFixed(0)}`);
    }
  }
  if (process.env.STUCK && i % 600 === 0) {
    // Bots that moved < 3 m over the last 10 s while alive the whole time; "inside" counts back-face hits around them.
    for (const p of m.players.values()) {
      const prev = stuckLast.get(p.id);
      const cur = { x: p.move.pos.x, y: p.move.pos.y, z: p.move.pos.z, alive: p.alive, t: m.now };
      stuckLast.set(p.id, cur);
      if (!prev || !prev.alive || !p.alive || prev.t > m.now - 9) continue;
      const moved = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
      if (moved > 3 || m.now < 20) continue;
      const c = { x: cur.x, y: cur.y + 1, z: cur.z };
      let inside = 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) if (map.world.raycast(c, { x: c.x + dx * 40, y: c.y + dy * 40, z: c.z + dz * 40 }, undefined, false)?.back) inside++;
      const key = `${Math.round(cur.x / 10)},${Math.round(cur.z / 10)}`;
      stuckSpots.set(key, (stuckSpots.get(key) ?? 0) + 1);
      console.log(`t=${m.now.toFixed(0)} STUCK ${p.name} t${p.team} ${p.brain!.role} pos(${cur.x.toFixed(1)},${cur.y.toFixed(1)},${cur.z.toFixed(1)}) moved ${moved.toFixed(1)} g=${p.move.onGround} inside=${inside} terrain=${map.world.terrain.heightAt(cur.x, cur.z).toFixed(1)} w0=${p.weapons[0]?.clip}/${p.weapons[0]?.ammo}`);
      if (process.env.STUCK === 'route' && p.brain!.role === 'offense') {
        const gen = m.assets.find((a) => a.type === 'generator' && a.team !== p.team);
        const r = gen ? m.nav.route(gen.pos) : null;
        const b = p.brain as unknown as { routeIdx: number; indoor: boolean };
        console.log(`   gen(${gen?.pos.x.toFixed(0)},${gen?.pos.y.toFixed(0)},${gen?.pos.z.toFixed(0)}) routeIdx ${b.routeIdx} indoor ${b.indoor} route ${r ? r.map((w) => `(${w.x.toFixed(0)},${w.y.toFixed(0)},${w.z.toFixed(0)})`).join(' ') : r}`);
      }
    }
  }
  if (process.env.DEBUG_GEN && i % 120 === 0 && m.now > 150) {
    for (const p of m.players.values()) {
      if (!p.alive || p.brain!.role !== 'offense') continue;
      const gen = m.assets.find((a) => a.type === 'generator' && a.team !== p.team)!;
      const sight = (p.brain as unknown as { genInSight(m: Match, p: Player, e: unknown): unknown }).genInSight(m, p, p.eye());
      const eye = p.eye(), c = { x: gen.pos.x, y: gen.pos.y + gen.def.size[1], z: gen.pos.z };
      const hit = map.world.raycast(eye, c, gen.id);
      console.log(`t=${m.now.toFixed(0)} ${p.name} d=${Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z).toFixed(1)} sight=${!!sight} hit=${hit ? `(${hit.point.x.toFixed(1)},${hit.point.y.toFixed(1)},${hit.point.z.toFixed(1)})` : '-'} gen(${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}) hp=${Math.round(gen.health)} weapon=${p.weapon.def.id} clip=${p.weapon.clip} buttons=${p.lastCmd.buttons}`);
    }
  }
  if (m.phase === PHASE.POSTGAME) break;
}
if (process.env.STUCK) console.log('stuck spots (10 m cells):', JSON.stringify(Object.fromEntries([...stuckSpots].sort((a, b) => b[1] - a[1]).slice(0, 12))));
console.log(`${MODES[cfg.mode].name}: simulated ${(m.now).toFixed(0)} s | avg tick ${(total / m.tick).toFixed(2)} ms, worst ${worst.toFixed(1)} ms`);
console.log(`scores ${m.scores.join(':')} | kills ${kills} | max speed ${maxSpeed.toFixed(0)} km/h | events ${JSON.stringify(events)}`);
console.log(`kill causes ${JSON.stringify(causes)}`);
const roles: Record<string, number> = {};
for (const p of m.players.values()) roles[`${p.brain!.role}`] = (roles[p.brain!.role] ?? 0) + p.kills;
console.log('kills by role', JSON.stringify(roles), '| projectiles alive', m.projectiles.size, '| assets', m.assets.length);
console.log('generators', m.assets.filter((a) => a.type === 'generator').map((a) => `t${a.team} hp ${Math.round(a.health)}${a.destroyed ? ' (down)' : ''}`).join(', '));
void join;
