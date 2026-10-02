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
  if (m.phase === PHASE.POSTGAME) break;
}
console.log(`${MODES[cfg.mode].name}: simulated ${(m.now).toFixed(0)} s | avg tick ${(total / m.tick).toFixed(2)} ms, worst ${worst.toFixed(1)} ms`);
console.log(`scores ${m.scores.join(':')} | kills ${kills} | max speed ${maxSpeed.toFixed(0)} km/h | events ${JSON.stringify(events)}`);
console.log(`kill causes ${JSON.stringify(causes)}`);
const roles: Record<string, number> = {};
for (const p of m.players.values()) roles[`${p.brain!.role}`] = (roles[p.brain!.role] ?? 0) + p.kills;
console.log('kills by role', JSON.stringify(roles), '| projectiles alive', m.projectiles.size, '| assets', m.assets.length);
void join;
