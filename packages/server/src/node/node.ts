import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { LAYOUT_BY_ID, MODE_IDS, MODES, PROTOCOL_VERSION, type GameOptions, type ModeId } from '@ar/shared';
import type { GameServer } from '../GameServer.js';
import type { Discovery, NodeInfo, PeerServer } from './discovery.js';
import { relayHttpPath, relayUpgradePath, type RelayServer } from './relay.js';
import type { Social } from './social.js';

export interface HostRequest { name: string; mode: ModeId; maps: string[]; mapSource: 'reborn' | 'original'; maxPlayers: number; options: GameOptions }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.atx': 'application/octet-stream', '.gz': 'application/octet-stream',
};

export interface LocalNodeOptions {
  port: number; nodeId: string; name: string; servers: GameServer[]; assetsDir: string; clientDir: string | null; discovery: Discovery;
  social: Social; host: (req: HostRequest) => Promise<GameServer>; hasOriginal: (map: string, mode: ModeId) => boolean;
  /** Games launched from the in-game HOST GAME menu, and a way to shut one down (empty ones only). */
  hosted?: () => { id: string; name: string; humans: number; port: number }[];
  close?: (id: string) => string;
  log: (s: string) => void;
  /** Relay for NATed hosts (only offered while this node is reachable from the internet). */
  relay?: RelayServer | null; relayOffered?: () => boolean;
}

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a === '::ffff:127.0.0.1');
/** Browser requests must come from a page served on this machine (blocks other websites driving the node). */
const localOrigin = (o: string | undefined) => !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

/**
 * The player's local node: serves the game client, this machine's imported original assets (maps, textures,
 * voices), the list of servers hosted here (/node, read by other nodes) and everything discovered (/peers).
 */
export class LocalNode {
  constructor(private o: LocalNodeOptions) {}

  start() {
    const srv = createServer((req, res) => {
      try { this.handle(req, res); } catch { if (!res.headersSent) res.writeHead(500).end(); }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const relayWss = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
    srv.on('upgrade', (req, sock, head) => {
      const rp = relayUpgradePath(req.url ?? '');
      if (rp) {
        const relay = this.o.relay;
        if (!relay || !(this.o.relayOffered?.() ?? false)) { sock.destroy(); return; }
        relayWss.handleUpgrade(req, sock, head, (ws) => {
          if (rp.kind === 'host') relay.attachHost(ws, req.socket.remoteAddress ?? '?');
          else relay.attachClient(ws, rp.nodeId, rp.serverId);
        });
        return;
      }
      // Only the browser on this machine may speak for this player.
      const okOrigin = localOrigin(req.headers.origin);
      if (req.url !== '/social' || !isLoopback(req.socket.remoteAddress) || !okOrigin) { sock.destroy(); return; }
      wss.handleUpgrade(req, sock, head, (ws) => this.o.social.attach(ws));
    });
    srv.listen(this.o.port, () => this.o.log(`node http://localhost:${this.o.port}${this.o.clientDir ? ' (open this in Chrome to play)' : ''}`));
  }

  nodeInfo(): NodeInfo {
    const offered = !!this.o.relay && (this.o.relayOffered?.() ?? false);
    return {
      app: 'ascend-reborn', v: PROTOCOL_VERSION, nodeId: this.o.nodeId, name: this.o.name, player: this.o.social.presence(), relay: offered || undefined,
      servers: [...this.o.servers.map((s) => s.info()), ...(offered ? this.o.relay!.servers(this.o.port) : [])],
    };
  }

  private local(): PeerServer[] {
    return this.o.servers.map((s) => ({ ...s.info(), assetsUrl: `http://localhost:${this.o.port}`, origin: 'local' as const, nodeId: this.o.nodeId, host: 'localhost' }));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'POST') { void this.handlePost(req, res, p); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

    if (p === '/node') return this.json(res, this.nodeInfo());
    const rh = relayHttpPath(p);
    if (rh) {
      if (!this.o.relay || !(this.o.relayOffered?.() ?? false)) { res.writeHead(404).end(); return; }
      this.o.relay.proxyHttp(rh.nodeId, rh.serverId, rh.path, res);
      return;
    }
    if (p === '/peers') {
      if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
      return this.json(res, { nodeId: this.o.nodeId, discovery: this.o.discovery.stats(), servers: [...this.local(), ...this.o.discovery.servers()] });
    }
    if (p === '/hosted') {
      if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
      return this.json(res, { games: this.o.hosted?.() ?? [] });
    }

    let m = /^\/assets\/tex\/([A-Za-z0-9_]{1,96})(\.hi)?\.atx$/.exec(p);
    if (m) {
      const f = join(this.o.assetsDir, 'textures', `${m[1]}${m[2] ?? ''}.atx`);
      // Most textures have no extra Ultra mips: say so without an error response.
      if (m[2] && !existsSync(f)) { res.writeHead(204, { 'cache-control': 'public, max-age=3600' }).end(); return; }
      return this.file(res, f, true);
    }
    if (p === '/assets/voices/manifest.json') return this.file(res, join(this.o.assetsDir, 'voices', 'manifest.json'), false);
    m = /^\/assets\/voices\/([a-z0-9_]{1,48})\/([A-Za-z0-9_]{1,80})\.ogg$/.exec(p);
    if (m) return this.file(res, join(this.o.assetsDir, 'voices', m[1], `${m[2]}.ogg`), true);
    if (p === '/assets/models/manifest.json') return this.file(res, join(this.o.assetsDir, 'models', 'manifest.json'), false);
    if (p === '/assets/fx/manifest.json') return this.file(res, join(this.o.assetsDir, 'fx', 'manifest.json'), false);
    m = /^\/assets\/ui\/([a-z0-9_]{1,120})\.png$/.exec(p);
    if (m) return this.file(res, join(this.o.assetsDir, 'ui', `${m[1]}.png`), true);
    m = /^\/assets\/models\/([a-z0-9_]{1,48})\.amdl$/.exec(p);
    if (m) return this.file(res, join(this.o.assetsDir, 'models', `${m[1]}.amdl`), true);
    if (p === '/assets/models/anims/manifest.json') return this.file(res, join(this.o.assetsDir, 'models', 'anims', 'manifest.json'), false);
    m = /^\/assets\/models\/anims\/([a-z0-9_]{1,64})\.aanm$/.exec(p);
    if (m) return this.file(res, join(this.o.assetsDir, 'models', 'anims', `${m[1]}.aanm`), true);
    if (p === '/assets/index.json') return this.file(res, join(this.o.assetsDir, 'index.json'), false);
    m = /^\/map\/([a-z0-9_]+\.[a-z]+\.arm\.gz)$/.exec(p);
    if (m) return this.file(res, join(this.o.assetsDir, m[1]), true);

    if (this.o.clientDir) return this.static(res, p);
    res.writeHead(404).end('not found');
  }

  private json(res: ServerResponse, body: unknown) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage, limit: number): Promise<unknown> {
    return new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse, p: string) {
    try {
      if (p === '/social/msg') {
        const body = await this.readBody(req, 8 * 1024);
        const ok = this.o.social.receive(body, req.socket.remoteAddress ?? '');
        res.writeHead(ok ? 200 : 400).end();
        return;
      }
      if (p === '/host') {
        if (!isLoopback(req.socket.remoteAddress) || !localOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
        const r = this.validateHost(await this.readBody(req, 4096));
        if (typeof r === 'string') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: r })); return; }
        const gs = await this.o.host(r);
        this.json(res, { ...gs.info(), assetsUrl: `http://localhost:${this.o.port}`, origin: 'local', nodeId: this.o.nodeId, host: 'localhost' });
        return;
      }
      if (p === '/hosted-close') {
        if (!isLoopback(req.socket.remoteAddress) || !localOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
        const body = await this.readBody(req, 256);
        const id = (body as { id?: unknown })?.id;
        if (typeof id !== 'string') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad request' })); return; }
        const err = this.o.close?.(id) ?? 'no games hosted from this menu';
        res.writeHead(err ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(err ? { error: err } : { closed: id }));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
    }
  }

  private validateHost(raw: unknown): HostRequest | string {
    if (!raw || typeof raw !== 'object') return 'bad request';
    const b = raw as Record<string, unknown>;
    const mode = b.mode as ModeId;
    if (!MODE_IDS.includes(mode)) return 'unknown game type';
    const mapSource = b.mapSource === 'reborn' ? 'reborn' : 'original';
    const maps = (Array.isArray(b.maps) ? b.maps : []).filter((m): m is string => typeof m === 'string' && /^[a-z0-9_]{1,40}$/.test(m))
      .filter((m) => (mapSource === 'original' ? this.o.hasOriginal(m, mode) : !!LAYOUT_BY_ID[m])).slice(0, 16);
    if (!maps.length) return 'no playable map selected';
    const o = (b.options ?? {}) as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    const diffs = ['recruit', 'adept', 'veteran', 'elite', 'godlike'] as const;
    // eslint-disable-next-line no-control-regex
    const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 48) : '';
    return {
      name: name || `${this.o.name}'s ${MODES[mode].name}`, mode, maps, mapSource, maxPlayers: num(b.maxPlayers, 2, 32, 16),
      options: {
        botsPerTeam: num(o.botsPerTeam, 0, 16, 10), botDifficulty: diffs.includes(o.botDifficulty as never) ? (o.botDifficulty as GameOptions['botDifficulty']) : 'recruit',
        infiniteAmmo: o.infiniteAmmo === true, infiniteEnergy: o.infiniteEnergy === true, noFallDamage: o.noFallDamage === true,
        infiniteCallIns: o.infiniteCallIns === true, vehicles: o.vehicles !== false,
        creditMultiplier: typeof o.creditMultiplier === 'number' && Number.isFinite(o.creditMultiplier) ? Math.max(0.25, Math.min(10, o.creditMultiplier)) : 1,
        gravity: typeof o.gravity === 'number' && Number.isFinite(o.gravity) ? Math.max(0.25, Math.min(3, o.gravity)) : 1,
        timeLimit: num(o.timeLimit, 0, 120, MODES[mode].timeLimit), scoreLimit: num(o.scoreLimit, 0, 999, MODES[mode].scoreLimit),
      },
    };
  }

  private file(res: ServerResponse, path: string, immutable: boolean) {
    if (!existsSync(path)) { res.writeHead(404).end('not found'); return; }
    const st = statSync(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
    });
    createReadStream(path).pipe(res);
  }

  private static(res: ServerResponse, p: string) {
    const root = this.o.clientDir!;
    const rel = normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
    let path = resolve(root, rel || 'index.html');
    if (!path.startsWith(resolve(root) + sep) && path !== resolve(root)) { res.writeHead(403).end(); return; }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');
    if (!existsSync(path)) { res.writeHead(404).end(); return; }
    const isIndex = path.endsWith('index.html');
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': isIndex ? 'no-cache' : 'public, max-age=3600' });
    res.end(readFileSync(path));
  }
}
