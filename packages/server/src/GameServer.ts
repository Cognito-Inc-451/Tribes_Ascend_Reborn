import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  BIN, BOT_TAG, decodeInput, decodeJson, encodeJson, fragment, isJsonFrame, LAYOUT_BY_ID, MODES, PHASE, PROTOCOL_VERSION,
  sanitizeCosmetics, TICK_RATE, VGS_BY_ID, VEHICLE_TYPES,
  type C2S, type CallInType, type MapRef, type PlayerInfo, type S2C, type ServerInfo, type VehicleType,
} from '@ar/shared';
import type { RootConfig, ServerConfig } from './config.js';
import { BotBrain, BOT_NAMES } from './game/bots.js';
import { Player } from './game/entities.js';
import type { LoadedMap, MapLibrary } from './game/maps.js';
import { Match } from './game/Match.js';
import type { Connection } from './transport/types.js';
import { startWsServer } from './transport/ws.js';
import { startWtServer, type WtHandle } from './transport/wt.js';

const SNAPSHOT_EVERY = TICK_RATE / 30;
/** Player slots bots always leave open for humans. */
const BOT_FREE_SLOTS = 2;
const ADMIN_HASH = process.env.ADMIN_PASSWORD ? createHash('sha256').update(process.env.ADMIN_PASSWORD).digest() : null;

function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class GameServer {
  private match!: Match;
  private map!: LoadedMap;
  private mapIndex = 0;
  private conns = new Map<Connection, Player>();
  private nextBotName = 0;
  private wt: WtHandle | null = null;
  private snapId = 0;
  private lastPlayersBroadcast = 0;
  private mapVotes = new Map<number, string>();
  private voteOptions: string[] = [];
  private vote: { kind: 'map' | 'kick'; arg: string; yes: Set<number>; no: Set<number>; ends: number } | null = null;
  private log: (s: string) => void;
  assetsUrl: string | undefined;

  constructor(readonly cfg: ServerConfig, readonly root: RootConfig, readonly lib: MapLibrary, private cert: { cert: string; key: string; hash: string | null }) {
    this.log = (s) => console.log(`[${cfg.id}] ${s}`);
    // Original servers only rotate maps imported for this mode (TA shipped most maps for a subset of modes).
    const orig = cfg.mapSource === 'original' ? cfg.maps.filter((m) => lib.hasOriginal(m, cfg.mode)) : [];
    const maps = orig.length ? orig : cfg.maps.filter((m) => LAYOUT_BY_ID[m]);
    if (!maps.length) throw new Error(`${cfg.id}: no playable maps`);
    const dropped = cfg.maps.filter((m) => !maps.includes(m));
    if (dropped.length && orig.length) this.log(`skipping maps without an imported ${cfg.mode} variant: ${dropped.join(', ')}`);
    cfg.maps = maps;
  }

  async start() {
    this.loadMap(this.cfg.maps[0]);
    this.httpServer = startWsServer(this.cfg.port, (req, res) => this.http(req, res), (c) => this.accept(c));
    if (this.cfg.wtPort) this.wt = await startWtServer(this.cfg.wtPort, this.cert.cert, this.cert.key, (c) => this.accept(c), this.log);
    this.log(`listening ws://${this.root.publicHost}:${this.cfg.port}/ws${this.wt ? ` + https://${this.root.publicHost}:${this.cfg.wtPort}/game (WebTransport)` : ''} | ${MODES[this.cfg.mode].name} on ${this.map.name} (${this.map.source})`);
    this.runLoop();
    this.announceTimer = setInterval(() => this.announce(), 10_000);
    this.announceTimer.unref();
    void this.announce();
  }

  private httpServer: ReturnType<typeof startWsServer> | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  lastHuman = Date.now();

  stop() {
    this.stopped = true;
    for (const c of this.conns.keys()) c.close('server closed');
    this.httpServer?.close();
    this.wt?.stop();
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.log('stopped');
  }

  // ---------------------------------------------------------------- info
  info(): ServerInfo {
    const players = [...this.conns.values()];
    const bots = [...this.match.players.values()].filter((p) => p.isBot).length;
    const transports: ServerInfo['transports'] = this.wt ? ['webtransport', 'websocket'] : ['websocket'];
    // The QUIC listener binds IPv4 only; browsers may resolve "localhost" to ::1.
    const wtHost = this.root.publicHost === 'localhost' ? '127.0.0.1' : this.root.publicHost;
    return {
      id: this.cfg.id, name: this.cfg.name, mode: this.cfg.mode, map: this.map.id, mapName: this.map.name, mapSource: this.map.source,
      humans: players.length, bots, maxPlayers: this.cfg.maxPlayers, transports,
      wsUrl: `ws://${this.root.publicHost}:${this.cfg.port}/ws`,
      wtUrl: this.wt ? `https://${wtHost}:${this.cfg.wtPort}/game` : undefined,
      certHash: this.cert.hash ?? undefined, region: this.cfg.region, version: PROTOCOL_VERSION, passworded: !!this.cfg.password,
      assetsUrl: this.assetsUrl, options: this.cfg.options,
    };
  }

  private async announce() {
    if (!this.root.master) return;
    try {
      await fetch(`${this.root.master}/announce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.MASTER_KEY ? { 'x-master-key': process.env.MASTER_KEY } : {}) },
        body: JSON.stringify({ ...this.info(), infoUrl: `http://${this.root.publicHost}:${this.cfg.port}/info` }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* master offline */ }
  }

  private http(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.info()));
      return;
    }
    const m = /^\/map\/([a-z0-9_]+\.[a-z]+\.arm\.gz)$/.exec(url.pathname);
    if (m && this.map.file === m[1] && this.map.blob) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': this.map.blob.length }).end(this.map.blob);
      return;
    }
    res.writeHead(404).end('not found');
  }

  // ---------------------------------------------------------------- map / match
  private loadMap(id: string) {
    this.map = this.lib.load(id, this.cfg.mode, this.cfg.mapSource);
    const previous = this.match ? [...this.match.players.values()] : [];
    this.match = new Match(this.cfg, this.map, {
      broadcast: (msg, filter) => this.broadcast(msg, filter),
      send: (p, msg) => this.send(p, msg),
      onMatchOver: () => this.onMatchOver(),
    });
    for (const p of previous) {
      Object.assign(p, { alive: false, flag: null, vehicle: null, inputs: [], kills: 0, deaths: 0, assists: 0, caps: 0, returns: 0, score: 0, modeScore: 0, credits: 0, respawnAt: 0, spawnQueued: false, determination: 0 });
      // Timers are in match time, which restarts at 0 on the new map.
      Object.assign(p, { lastHurt: -999, diedAt: 0, switchUntil: 0, beltNext: 0, packNext: 0, meleeNext: 0, packActive: false, invulnUntil: 0, lastFire: -99, spottedUntil: 0, rageUntil: 0, lastVgsReply: 0, history: [], chatTimes: [], vgsTimes: [] });
      p.damagers.clear();
      if (!p.isBot) p.ready = false;
      this.match.addPlayer(p);
      if (p.brain) { p.brain.newMatch(); p.brain.chooseRole(this.match, p); }
    }
    this.mapVotes.clear();
  }

  private mapRef(): MapRef {
    return { source: this.map.source, id: this.map.id, hash: this.map.hash, bytes: this.map.blob?.length, file: this.map.file };
  }

  private onMatchOver() {
    const others = this.cfg.maps.filter((m) => m !== this.map.id);
    this.voteOptions = [...others].sort(() => Math.random() - 0.5).slice(0, 3);
    if (!this.voteOptions.length) this.voteOptions = [this.map.id];
    this.broadcast({ t: 'mapvote', options: this.voteOptions.map((id) => ({ id, name: LAYOUT_BY_ID[id]?.name ?? id })), endsIn: 15 });
    for (const p of this.match.players.values()) if (p.isBot && Math.random() < 0.5) this.mapVotes.set(p.id, this.voteOptions[Math.floor(Math.random() * this.voteOptions.length)]);
  }

  private changeMap(id?: string) {
    let next = id;
    if (!next) {
      const tally = new Map<string, number>();
      for (const v of this.mapVotes.values()) tally.set(v, (tally.get(v) ?? 0) + 1);
      next = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!next) { this.mapIndex = (this.cfg.maps.indexOf(this.map.id) + 1) % this.cfg.maps.length; next = this.cfg.maps[this.mapIndex]; }
    }
    this.log(`changing map to ${next}`);
    this.loadMap(next);
    this.broadcast({ t: 'changemap', map: this.mapRef() });
  }

  // ---------------------------------------------------------------- loop
  private runLoop() {
    const stepMs = 1000 / TICK_RATE;
    let last = performance.now();
    let acc = 0;
    const loop = () => {
      if (this.stopped) return;
      const now = performance.now();
      acc += now - last;
      last = now;
      let n = 0;
      while (acc >= stepMs && n < 5) {
        this.tick();
        acc -= stepMs;
        n++;
      }
      if (acc > stepMs * 5) acc = 0;
      setTimeout(loop, Math.max(1, stepMs - acc - 1));
    };
    loop();
  }

  private tick() {
    const m = this.match;
    try {
      m.step();
    } catch (e) {
      this.log(`tick error: ${(e as Error).stack}`);
    }
    if (m.tick % SNAPSHOT_EVERY === 0) {
      this.snapId = (this.snapId + 1) & 0xffff;
      m.buildSnapshots((p, data) => {
        const c = p.conn;
        if (!c) return;
        if (c.kind === 'webtransport') for (const f of fragment(data, this.snapId)) c.sendUnreliable(f);
        else c.sendUnreliable(data);
      });
    }
    if (m.phase === PHASE.POSTGAME && m.now >= m.phaseEnd) this.changeMap();
    if (m.tick % 60 === 0) this.fillBots();
    if (m.now - this.lastPlayersBroadcast > 2) { this.lastPlayersBroadcast = m.now; this.broadcastPlayers(); }
    if (this.vote && m.now >= this.vote.ends) this.resolveVote();
  }

  private fillBots() {
    const humans = [...this.match.players.values()].filter((p) => !p.isBot).length;
    if (humans) this.lastHuman = Date.now();
    const bots = [...this.match.players.values()].filter((p) => p.isBot);
    const fixed = this.cfg.options?.botsPerTeam;
    // Bots keep their numbers and only give up slots as the server nears full, keeping room for joining humans.
    const target = fixed !== undefined ? fixed * (MODES[this.cfg.mode].teams ? 2 : 1) : this.cfg.bots.fillTo;
    const want = Math.max(0, Math.min(target, this.cfg.maxPlayers - humans - BOT_FREE_SLOTS));
    if (bots.length < want) this.addBot();
    else if (bots.length > want) {
      const counts = [0, 1].map((t) => [...this.match.players.values()].filter((p) => p.team === t).length);
      const victim = bots.find((b) => b.team === (counts[0] > counts[1] ? 0 : 1)) ?? bots[0];
      this.match.removePlayer(victim);
      this.broadcastPlayers();
    }
  }

  private allocId(): number {
    for (let i = 0; i < 250; i++) if (!this.match.players.has(i)) return i;
    return -1;
  }

  private addBot() {
    const id = this.allocId();
    if (id < 0) return;
    const name = `${BOT_TAG} ${BOT_NAMES[this.nextBotName++ % BOT_NAMES.length]}`;
    const p = new Player(id, name, null, new BotBrain(this.cfg.bots.difficulty, id * 7919 + Date.now()));
    p.ready = true;
    const voices = this.botVoices();
    p.cosmetics = sanitizeCosmetics({ voice: voices[id % voices.length] });
    this.match.addPlayer(p);
    this.match.setTeam(p, this.match.autoTeam());
    p.brain!.chooseRole(this.match, p);
  }

  private voiceList: string[] | null = null;
  /** Original voice packs when imported on this host (clients without them fall back to speech synthesis). */
  private botVoices(): string[] {
    if (this.voiceList) return this.voiceList;
    const fallback = ['reborn_vanguard', 'reborn_valkyrie', 'reborn_warden', 'reborn_spark', 'reborn_automaton'];
    try {
      const m = JSON.parse(readFileSync(join(this.lib.originalDir, 'voices', 'manifest.json'), 'utf8')) as { packs?: { id: string }[] };
      const ids = (m.packs ?? []).map((p) => p.id).filter((id) => /^ta_[a-z0-9_]+$/.test(id));
      this.voiceList = ids.length ? ids : fallback;
    } catch {
      this.voiceList = fallback;
    }
    return this.voiceList;
  }

  // ---------------------------------------------------------------- connections
  private accept(c: Connection) {
    let hello = false;
    const timer = setTimeout(() => { if (!hello) c.close('handshake timeout'); }, 8000);
    let window = Date.now(), count = 0;
    c.onMessage = (data) => {
      const t = Date.now();
      if (t - window > 1000) { window = t; count = 0; }
      if (++count > 400) { c.close('flood'); return; }
      if (count > 250) return;
      const p = this.conns.get(c);
      if (!p) {
        if (!isJsonFrame(data)) return;
        const msg = decodeJson<C2S>(data);
        if (msg?.t !== 'hello') return;
        hello = true;
        clearTimeout(timer);
        this.onHello(c, msg);
        return;
      }
      if (data[0] === BIN.INPUT) {
        for (const cmd of decodeInput(data)) {
          if (cmd.seq <= p.lastSeq || p.inputs.some((x) => x.seq === cmd.seq)) continue;
          p.inputs.push(cmd);
        }
        p.inputs.sort((a, b) => a.seq - b.seq);
        if (p.inputs.length > 30) p.inputs.splice(0, p.inputs.length - 30);
        return;
      }
      if (isJsonFrame(data)) {
        const msg = decodeJson<C2S>(data);
        if (msg && typeof msg === 'object' && typeof msg.t === 'string') this.onJson(p, msg);
      }
    };
    c.onClose = () => {
      clearTimeout(timer);
      const p = this.conns.get(c);
      if (!p) return;
      this.conns.delete(c);
      this.match.removePlayer(p);
      this.broadcast({ t: 'event', kind: 'leave', player: p.id, text: `${p.name} left the game` });
      this.broadcastPlayers();
    };
  }

  private onHello(c: Connection, msg: Extract<C2S, { t: 'hello' }>) {
    if (msg.v !== PROTOCOL_VERSION) { c.sendReliable(encodeJson({ t: 'error', msg: `Protocol mismatch (server ${PROTOCOL_VERSION})` })); c.close('version'); return; }
    const humans = this.conns.size;
    if (humans >= this.cfg.maxPlayers) { c.sendReliable(encodeJson({ t: 'error', msg: 'Server is full' })); c.close('full'); return; }
    // Make room by removing a bot if needed.
    if (this.match.players.size >= this.cfg.maxPlayers) {
      const bot = [...this.match.players.values()].find((p) => p.isBot);
      if (bot) this.match.removePlayer(bot);
    }
    const id = this.allocId();
    if (id < 0) { c.close('full'); return; }
    let name = sanitizeText(msg.name, 20).replace(/\[\s*bot\s*\]/gi, '').trim() || 'Player';
    if (name.length < 2) name = `Player${id}`;
    const taken = new Set([...this.match.players.values()].map((p) => p.name.toLowerCase()));
    let final = name, k = 2;
    while (taken.has(final.toLowerCase())) final = `${name.slice(0, 17)}${k++}`;
    const p = new Player(id, final, c, null);
    p.cosmetics = sanitizeCosmetics(msg.cosmetics);
    this.conns.set(c, p);
    this.match.addPlayer(p);
    this.send(p, { t: 'welcome', id, server: this.info(), tickRate: TICK_RATE, map: this.mapRef() });
    this.log(`${final} joined via ${c.kind} from ${c.remote}`);
  }

  private onJson(p: Player, msg: C2S) {
    const m = this.match;
    switch (msg.t) {
      case 'mapready':
        if (!p.ready) {
          p.ready = true;
          if (p.chosenSpectator) m.setTeam(p, 255);
          else if (p.team === 255) m.setTeam(p, m.autoTeam());
          else { p.spectator = false; p.respawnAt = m.now; }
          m.broadcastMatch();
          this.broadcastPlayers();
          this.broadcast({ t: 'event', kind: 'join', player: p.id, text: `${p.name} joined the game` });
        }
        break;
      case 'team': {
        const team = Number(msg.team);
        p.chosenSpectator = team === 255;
        if (team === 255) m.setTeam(p, 255);
        else if (team === 0 || team === 1) m.setTeam(p, team);
        else m.setTeam(p, m.autoTeam(p));
        // Picking a side from the team screen deploys as soon as the respawn delay allows.
        if (msg.spawn && !p.alive && !p.spectator) p.spawnQueued = true;
        this.broadcastPlayers();
        break;
      }
      case 'class':
        if (typeof msg.cls === 'string') m.setClass(p, msg.cls, typeof msg.loadout === 'object' && msg.loadout ? msg.loadout : {});
        if (p.alive && p.pending) this.send(p, { t: 'toast', text: 'Loadout will apply at an inventory station or on respawn' });
        if (msg.spawn && !p.alive && !p.spectator) p.spawnQueued = true;
        break;
      case 'cosmetics':
        if (typeof msg.cosmetics === 'object' && msg.cosmetics) { p.cosmetics = sanitizeCosmetics(msg.cosmetics); this.broadcastPlayers(); }
        break;
      case 'chat': {
        const text = sanitizeText(msg.text, 160);
        if (!text) return;
        p.chatTimes = p.chatTimes.filter((t) => m.now - t < 5);
        if (p.chatTimes.length >= 5) { this.send(p, { t: 'toast', text: 'You are sending messages too fast' }); return; }
        p.chatTimes.push(m.now);
        const team = !!msg.team;
        this.broadcast({ t: 'chat', from: p.id, name: p.name, text, team, bot: false }, team ? (o) => o.team === p.team : undefined);
        break;
      }
      case 'vgs': {
        const leaf = typeof msg.id === 'string' ? VGS_BY_ID[msg.id] : undefined;
        if (!leaf) return;
        p.vgsTimes = p.vgsTimes.filter((t) => m.now - t < 4);
        if (p.vgsTimes.length >= 4) return;
        p.vgsTimes.push(m.now);
        this.broadcast({ t: 'vgs', from: p.id, name: p.name, id: leaf.id, team: !leaf.global, voice: p.cosmetics.voice, bot: false }, leaf.global ? undefined : (o) => o.team === p.team);
        break;
      }
      case 'buyvehicle':
        if (VEHICLE_TYPES.includes(msg.vehicle as VehicleType)) m.buyVehicle(p, msg.vehicle as VehicleType);
        break;
      case 'callin':
        if (['tactical_strike', 'orbital_strike', 'supply_drop'].includes(msg.kind) && msg.target && typeof msg.target === 'object') {
          m.callIn(p, msg.kind as CallInType, { x: Number(msg.target.x), y: Number(msg.target.y), z: Number(msg.target.z) });
        }
        break;
      case 'upgrade': {
        const a = m.assets.find((x) => x.id === msg.asset);
        if (a && a.team === p.team && p.alive && Math.hypot(a.pos.x - p.move.pos.x, a.pos.z - p.move.pos.z) < 12) m.upgradeAsset(p, a);
        break;
      }
      case 'suicide':
        if (p.alive) m.kill(p, null, 'suicide');
        break;
      case 'seat':
        m.switchSeat(p, Number(msg.seat) | 0);
        break;
      case 'spec':
        p.follow = Number(msg.follow) | 0;
        break;
      case 'ping': {
        if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) p.rtt = Math.max(0, Math.min(0.5, msg.rtt));
        this.send(p, { t: 'pong', c: Number(msg.c) || 0, s: m.now });
        break;
      }
      case 'callvote': {
        const arg = sanitizeText(msg.arg, 40);
        if (m.phase === PHASE.POSTGAME && msg.kind === 'map') { if (this.voteOptions.includes(arg)) this.mapVotes.set(p.id, arg); return; }
        if (this.vote) { this.send(p, { t: 'toast', text: 'A vote is already running' }); return; }
        if (msg.kind === 'map' && !this.cfg.maps.includes(arg)) return;
        if (msg.kind === 'kick' && ![...m.players.values()].some((o) => o.name === arg && !o.isBot)) return;
        this.vote = { kind: msg.kind, arg, yes: new Set([p.id]), no: new Set(), ends: m.now + 30 };
        this.broadcast({ t: 'vote', kind: msg.kind, arg, yes: 1, no: 0, endsIn: 30 });
        break;
      }
      case 'vote':
        if (!this.vote) return;
        (msg.yes ? this.vote.yes : this.vote.no).add(p.id);
        (msg.yes ? this.vote.no : this.vote.yes).delete(p.id);
        this.broadcast({ t: 'vote', kind: this.vote.kind, arg: this.vote.arg, yes: this.vote.yes.size, no: this.vote.no.size, endsIn: Math.round(this.vote.ends - m.now) });
        if (this.vote.yes.size > this.conns.size / 2) this.resolveVote();
        break;
      case 'admin':
        this.admin(p, msg.password, msg.cmd, msg.arg);
        break;
    }
  }

  private resolveVote() {
    const v = this.vote;
    this.vote = null;
    if (!v) return;
    const pass = v.yes.size > this.conns.size / 2;
    this.broadcast({ t: 'toast', text: `Vote ${v.kind} ${v.arg} ${pass ? 'passed' : 'failed'} (${v.yes.size}/${v.no.size})` });
    if (!pass) return;
    if (v.kind === 'map') this.changeMap(v.arg);
    else {
      const target = [...this.conns].find(([, p]) => p.name === v.arg);
      target?.[0].close('vote kicked');
    }
  }

  private admin(p: Player, password: unknown, cmd: unknown, arg?: unknown) {
    if (!ADMIN_HASH || typeof password !== 'string') { this.send(p, { t: 'toast', text: 'Admin is disabled' }); return; }
    const h = createHash('sha256').update(password).digest();
    if (!timingSafeEqual(h, ADMIN_HASH)) { this.send(p, { t: 'toast', text: 'Bad admin password' }); this.log(`bad admin password from ${p.name}`); return; }
    const a = sanitizeText(arg, 40);
    switch (cmd) {
      case 'map': if (this.cfg.maps.includes(a) || LAYOUT_BY_ID[a]) this.changeMap(a); break;
      case 'kick': [...this.conns].find(([, o]) => o.name === a || String(o.id) === a)?.[0].close('kicked by admin'); break;
      case 'bots': this.cfg.bots.fillTo = Math.max(0, Math.min(this.cfg.maxPlayers, Number(a) | 0)); break;
      case 'end': this.match.endMatch(-1); break;
    }
    this.log(`admin ${p.name}: ${String(cmd)} ${a}`);
  }

  // ---------------------------------------------------------------- output
  send(p: Player, msg: S2C) {
    p.conn?.sendReliable(encodeJson(msg));
  }

  broadcast(msg: S2C, filter?: (p: Player) => boolean) {
    const data = encodeJson(msg);
    for (const p of this.match.players.values()) {
      if (!p.conn || !p.ready && msg.t !== 'changemap' && msg.t !== 'welcome') continue;
      if (filter && !filter(p)) continue;
      p.conn.sendReliable(data);
    }
  }

  private broadcastPlayers() {
    const list: PlayerInfo[] = [...this.match.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.spectator ? 255 : p.team, cls: p.cls.id, score: this.cfg.mode === 'rabbit' ? p.modeScore : p.score, kills: p.kills, deaths: p.deaths, assists: p.assists,
      caps: p.caps, returns: p.returns, bot: p.isBot, ping: Math.round(p.rtt * 1000), cosmetics: p.cosmetics, transport: p.transport,
    }));
    this.broadcast({ t: 'players', list });
  }
}
