import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUTS, MODES, type ModeId, type Vec3 } from '@ar/shared';
import type { ServerConfig } from '../src/config.js';
import { Player } from '../src/game/entities.js';
import { MapLibrary } from '../src/game/maps.js';
import { Match } from '../src/game/Match.js';

// Spawn audit with the server's real spawn logic: tsx scripts/spawncheck.ts [map-id-prefix]
// Flags spawns that put a player under/inside terrain, inside geometry, or that are unstable after a second of physics.
const only = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const lib = new MapLibrary(resolve(here, '../../../maps-original'));
let total = 0, flagged = 0;
const targets: { id: string; mode: ModeId; source: 'original' | 'reborn' }[] = process.env.REBORN
  ? LAYOUTS.flatMap((l) => l.modes.map((mode) => ({ id: l.id, mode: mode as ModeId, source: 'reborn' as const })))
  : lib.originals().map((e) => ({ id: e.id, mode: e.mode, source: 'original' as const }));
for (const entry of targets) {
  if (only && !entry.id.startsWith(only)) continue;
  if (!MODES[entry.mode]) continue;
  const cfg: ServerConfig = { id: 'chk', name: 'chk', mode: entry.mode, mapSource: entry.source, maps: [entry.id], port: 0, maxPlayers: 32, bots: { fillTo: 0, difficulty: 'veteran' } };
  const map = lib.load(entry.id, entry.mode, entry.source);
  const m = new Match(cfg, map, { broadcast: () => {}, send: () => {}, onMatchOver: () => {} });
  (m as unknown as { phaseEnd: number }).phaseEnd = Infinity;
  const T = map.world.terrain;
  const mi = m as unknown as { validSpawn(e: unknown): boolean; freeSpot(s: Vec3, p: Player): Vec3; spawnPoint(p: Player): { pos: Vec3; yaw: number } };
  const spawns = map.data.entities.filter((e) => e.kind === 'spawn');
  const issues: string[] = [];
  let used = 0;
  const crowd = Number(process.env.CROWD ?? 4);
  for (const e of spawns) {
    if (!mi.validSpawn(e)) continue;
    used++;
    const placed: Player[] = [];
    for (let c = 0; c < crowd; c++) {
    total++;
    const p = new Player(1000 + used * 10 + c, 'chk', null, null);
    p.ready = true;
    m.addPlayer(p);
    placed.push(p);
    m.setTeam(p, e.team === 1 ? 1 : 0);
    mi.spawnPoint = () => ({ pos: mi.freeSpot({ x: e.pos.x, y: e.pos.y + 0.3, z: e.pos.z }, p), yaw: e.yaw });
    m.spawn(p);
    const s = { ...p.move.pos };
    const why: string[] = [];
    const ring = (y: number, r: number) => {
      let worst = -Infinity;
      for (let k = 0; k < 8; k++) {
        const x = s.x + Math.cos((k / 8) * Math.PI * 2) * r, z = s.z + Math.sin((k / 8) * Math.PI * 2) * r;
        if (!T.isHole(x, z)) worst = Math.max(worst, T.heightAt(x, z) - y);
      }
      return worst;
    };
    if (!T.isHole(s.x, s.z) && s.y < T.heightAt(s.x, s.z) - 0.1) why.push(`under-terrain ${(T.heightAt(s.x, s.z) - s.y).toFixed(2)}`);
    const emb = ring(s.y, p.phys.radius);
    if (emb > 0.6) why.push(`terrain-in-capsule ${emb.toFixed(2)}`);
    const eye = s.y + p.phys.height * 0.9;
    if (ring(eye, 0.15) > 0) why.push('eye-in-terrain');
    for (let i = 0; i < 30; i++) m.step();
    const q = p.move.pos;
    if (!p.alive) why.push('died');
    else if (Math.hypot(q.x - s.x, q.z - s.z) > 2.5 || s.y - q.y > 3) why.push(`unstable d=${Math.hypot(q.x - s.x, q.z - s.z).toFixed(1)} dy=${(q.y - s.y).toFixed(1)}`);
    else if (!T.isHole(q.x, q.z) && q.y < T.heightAt(q.x, q.z) - 0.1) why.push('settled-under-terrain');
    if (why.length) { flagged++; issues.push(`#${c} t${e.team} (${e.pos.x.toFixed(0)},${e.pos.y.toFixed(1)},${e.pos.z.toFixed(0)}) -> (${s.x.toFixed(1)},${s.y.toFixed(1)},${s.z.toFixed(1)}) terrain ${T.heightAt(s.x, s.z).toFixed(1)} ${why.join(', ')}`); }
    }
    for (const p of placed) m.removePlayer(p);
  }
  if (issues.length) console.log(`${entry.id}.${entry.mode}: ${issues.length}/${used} (of ${spawns.length}) flagged\n  ${issues.slice(0, 8).join('\n  ')}`);
}
console.log(`spawns checked ${total}, flagged ${flagged}`);
