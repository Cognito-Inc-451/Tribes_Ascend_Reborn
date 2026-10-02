/** Local career stats (this browser only), modelled on the TA player stats page. */
export interface CareerStats {
  v: 1; created: string; lastPlayed: string; matches: number; wins: number; timePlayed: number;
  timeByArmor: Record<string, number>; timeByMode: Record<string, number>; timeByClass: Record<string, number>;
  kills: number; deaths: number; assists: number; beltKills: number; callinKills: number; meleeKills: number; vehicleKills: number;
  roadkills: number; midairs: number; multikills: number; sprees: number; flagCaps: number; flagReturns: number; flagGrabs: number;
  highSpeedGrabs: number; gensDestroyed: number; fullRegens: number; skiDistance: number; topSpeed: number; vehiclesDestroyed: number;
}

const KEY = 'ascend-reborn:stats:v1';

function fresh(): CareerStats {
  const now = new Date().toISOString();
  return {
    v: 1, created: now, lastPlayed: now, matches: 0, wins: 0, timePlayed: 0, timeByArmor: {}, timeByMode: {}, timeByClass: {},
    kills: 0, deaths: 0, assists: 0, beltKills: 0, callinKills: 0, meleeKills: 0, vehicleKills: 0, roadkills: 0, midairs: 0, multikills: 0,
    sprees: 0, flagCaps: 0, flagReturns: 0, flagGrabs: 0, highSpeedGrabs: 0, gensDestroyed: 0, fullRegens: 0, skiDistance: 0, topSpeed: 0, vehiclesDestroyed: 0,
  };
}

export function loadStats(): CareerStats {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CareerStats> | null;
    if (raw && raw.v === 1) return { ...fresh(), ...raw };
  } catch { /* corrupt: start over */ }
  return fresh();
}

export function saveStats(s: CareerStats) {
  s.lastPlayed = new Date().toISOString();
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function resetStats() { localStorage.removeItem(KEY); }

/** Accumulates one session's events into the career totals. */
export class StatsRecorder {
  readonly s = loadStats();
  private lastKills: number[] = [];
  private lifeKills = 0;
  private spreeCounted = false;
  private lowHealth = false;
  private dirty = 0;

  kill(kind: 'belt' | 'callin' | 'melee' | 'roadkill' | 'other', midair: boolean, inVehicle: boolean) {
    const s = this.s;
    s.kills++;
    if (kind === 'belt') s.beltKills++;
    else if (kind === 'callin') s.callinKills++;
    else if (kind === 'melee') s.meleeKills++;
    else if (kind === 'roadkill') s.roadkills++;
    if (midair) s.midairs++;
    if (inVehicle) s.vehicleKills++;
    const now = performance.now();
    this.lastKills = this.lastKills.filter((t) => now - t < 3000);
    if (this.lastKills.length === 1) s.multikills++;
    this.lastKills.push(now);
    if (++this.lifeKills >= 5 && !this.spreeCounted) { s.sprees++; this.spreeCounted = true; }
  }

  death() { this.s.deaths++; this.lifeKills = 0; this.spreeCounted = false; this.lastKills = []; }
  assist() { this.s.assists++; }
  flag(kind: 'cap' | 'return' | 'grab', speedKmh: number) {
    if (kind === 'cap') this.s.flagCaps++;
    else if (kind === 'return') this.s.flagReturns++;
    else { this.s.flagGrabs++; if (speedKmh >= 150) this.s.highSpeedGrabs++; }
  }

  tick(dt: number, alive: boolean, armor: string, cls: string, mode: string, health: number, maxHealth: number, skiing: boolean, speedKmh: number) {
    const s = this.s;
    s.timePlayed += dt;
    s.timeByMode[mode] = (s.timeByMode[mode] ?? 0) + dt;
    if (alive) {
      s.timeByArmor[armor] = (s.timeByArmor[armor] ?? 0) + dt;
      s.timeByClass[cls] = (s.timeByClass[cls] ?? 0) + dt;
      if (skiing) s.skiDistance += (speedKmh / 3.6) * dt;
      if (speedKmh > s.topSpeed) s.topSpeed = speedKmh;
      if (health < maxHealth * 0.5) this.lowHealth = true;
      else if (this.lowHealth && health >= maxHealth - 0.5) { s.fullRegens++; this.lowHealth = false; }
    } else this.lowHealth = false;
    this.dirty += dt;
    if (this.dirty > 10) this.flush();
  }

  matchEnd(won: boolean) { this.s.matches++; if (won) this.s.wins++; this.flush(); }
  flush() { this.dirty = 0; saveStats(this.s); }
}
