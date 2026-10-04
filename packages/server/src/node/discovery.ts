import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MODE_IDS, PROTOCOL_VERSION, type ServerInfo } from '@ar/shared';

/** What a node publishes at GET /node. */
export interface NodeInfo { app: 'ascend-reborn'; v: number; nodeId: string; name: string; servers: ServerInfo[]; player?: Presence; relay?: boolean }

/** The player behind a node (one player per running game). Keys are base64 DER (SPKI). */
export interface Presence { id: string; name: string; status: string; serverWs?: string; serverName?: string; edPub: string; xPub: string }
export interface PeerPlayer extends Presence { host: string; port: number; origin: PeerOrigin }

export type PeerOrigin = 'local' | 'lan' | 'internet';
export interface PeerServer extends ServerInfo { origin: PeerOrigin; nodeId: string; host: string }

interface Peer {
  host: string; port: number; origin: PeerOrigin; nodeId?: string; relay?: boolean;
  lastSeen: number; nextFetch: number; fails: number; servers: PeerServer[]; player?: Presence;
}

const APP = 'ascend-reborn';
const MCAST_ADDR = '239.255.42.99';
const MCAST_PORT = 7771;
const INFO_HASH = createHash('sha1').update(`${APP}/v${PROTOCOL_VERSION}`).digest();
const MAX_PEERS = 256;
const MAX_BODY = 64 * 1024;
/** Public DHT entry points; literal IPs back up DNS (the library's own hostname bootstrap left the routing table empty on current Node). */
const DHT_ROUTERS: [string, number][] = [['router.bittorrent.com', 6881], ['router.utorrent.com', 6881], ['dht.transmissionbt.com', 6881], ['dht.libtorrent.org', 25401]];
const DHT_FALLBACK = ['67.215.246.10:6881', '82.221.103.244:6881', '87.98.162.88:6881', '185.157.221.247:25401'];

export interface DiscoveryOptions {
  nodeId: string; nodePort: number; gamePorts: number[]; lan: boolean; internet: boolean; upnp: boolean; log: (s: string) => void;
}

export const newNodeId = () => randomBytes(8).toString('hex');

// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '').trim().slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function urlPort(u: unknown, scheme: string): number | null {
  if (typeof u !== 'string' || u.length > 200) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== scheme) return null;
    return int(Number(p.port), 1024, 65535);
  } catch { return null; }
}

/** WebSocket path of a remote server: the game port's /ws, or a relay tunnel on the node port. */
function wsPath(u: unknown): string | null {
  try {
    const p = new URL(String(u)).pathname;
    return p === '/ws' || /^\/relay\/c\/[0-9a-f]{16}\/[A-Za-z0-9_-]{1,32}$/.test(p) ? p : null;
  } catch { return null; }
}

/** Rejects addresses an untrusted peer must not make us contact (loopback, private, link-local, multicast). */
function isPublicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  return isIP(ip) === 4 && !isPublicIPv4(ip) && !ip.startsWith('127.') && !ip.startsWith('0.') && Number(ip.split('.')[0]) < 224;
}

export function sanitizePresence(raw: unknown): Presence | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const key = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9+/=]{40,120}$/.test(v) ? v : null);
  const edPub = key(s.edPub), xPub = key(s.xPub);
  if (!edPub || !xPub || typeof s.id !== 'string' || s.id !== playerIdOf(edPub)) return undefined;
  const ws = typeof s.serverWs === 'string' && /^ws:\/\/[\w.[\]:-]{3,80}\/ws$/.test(s.serverWs) ? s.serverWs : undefined;
  return { id: s.id, name: clean(s.name, 20) || 'Tribal', status: clean(s.status, 24) || 'In lobby', serverWs: ws, serverName: ws ? clean(s.serverName, 64) : undefined, edPub, xPub };
}

/** Stable player id: first 16 hex chars of SHA-256 over the Ed25519 public key. */
export const playerIdOf = (edPubB64: string) => createHash('sha256').update(Buffer.from(edPubB64, 'base64')).digest('hex').slice(0, 16);

/** Validates a remote server entry and rewrites its URLs to the address we actually reached the node at. */
export function sanitizeRemote(raw: unknown, host: string, origin: PeerOrigin, nodeId: string, nodePort: number): PeerServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const id = clean(s.id, 32);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  const mode = s.mode as ServerInfo['mode'];
  if (!MODE_IDS.includes(mode)) return null;
  const map = clean(s.map, 40);
  if (!/^[a-z0-9_]{1,40}$/.test(map)) return null;
  const wsPort = urlPort(s.wsUrl, 'ws:');
  const path = wsPath(s.wsUrl);
  if (!wsPort || !path) return null;
  const relayed = path !== '/ws';
  if (relayed && wsPort !== nodePort) return null;
  const wtPort = relayed ? null : urlPort(s.wtUrl, 'https:');
  const certHash = typeof s.certHash === 'string' && /^[0-9a-f]{64}$/.test(s.certHash) ? s.certHash : undefined;
  const transports: ServerInfo['transports'] = wtPort && certHash ? ['webtransport', 'websocket'] : ['websocket'];
  const h = isIP(host) === 6 ? `[${host}]` : host;
  return {
    id, name: clean(s.name, 48) || id, mode, map, mapName: clean(s.mapName, 48) || map,
    mapSource: s.mapSource === 'original' ? 'original' : 'reborn',
    humans: int(s.humans, 0, 64) ?? 0, bots: int(s.bots, 0, 64) ?? 0, maxPlayers: int(s.maxPlayers, 2, 64) ?? 24,
    transports, wsUrl: `ws://${h}:${wsPort}${path}`, wtUrl: wtPort && certHash ? `https://${h}:${wtPort}/game` : undefined, certHash,
    region: clean(s.region, 16) || undefined, version: int(s.version, 0, 1000) ?? 0, passworded: s.passworded === true,
    assetsUrl: `http://${h}:${nodePort}`, origin, nodeId, host,
  };
}

async function fetchCapped(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('response too large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Serverless discovery: every running copy of the game is a node. Nodes find each other on the LAN via UDP
 * multicast and over the internet via the public BitTorrent DHT (no project-run master server), then exchange
 * server lists over plain HTTP (GET /node). UPnP/NAT-PMP opens the ports so remote players can connect.
 */
export class Discovery {
  private peers = new Map<string, Peer>();
  private sock: dgram.Socket | null = null;
  private dht: { announce(h: Buffer, p: number): void; lookup(h: Buffer): void; destroy(): void } | null = null;
  private fetching = 0;
  publicIp: string | null = null;
  upnpOk = false;
  private nat: { map(o: number): Promise<void> } | null = null;

  /** Open TCP+UDP for a game port started after boot (hosted games). */
  async openPort(port: number) {
    try { await this.nat?.map(port); } catch { /* router refused */ }
  }

  constructor(private o: DiscoveryOptions) {}

  async start() {
    if (this.o.lan) this.startLan();
    if (this.o.upnp) await this.startUpnp();
    if (this.o.internet) await this.startDht();
    setInterval(() => this.pump(), 1000).unref();
  }

  /** All servers currently known from other nodes. */
  servers(): PeerServer[] {
    const now = Date.now();
    const out: PeerServer[] = [];
    for (const p of this.peers.values()) {
      if (p.nodeId === this.o.nodeId) continue;
      if (now - p.lastSeen > (p.origin === 'lan' ? 20_000 : 180_000)) continue;
      out.push(...p.servers);
    }
    return out;
  }

  stats() {
    const list = [...this.peers.values()].filter((p) => p.nodeId !== this.o.nodeId && (p.servers.length || p.player));
    return { lan: list.filter((p) => p.origin === 'lan').length, internet: list.filter((p) => p.origin === 'internet').length, upnp: this.upnpOk, publicIp: this.publicIp, dht: !!this.dht && (this.dht as unknown as { nodes?: { toArray(): unknown[] } }).nodes?.toArray().length !== 0 };
  }

  /** Internet nodes offering to relay for hosts behind NAT (most recently reachable first). */
  relays(): string[] {
    const now = Date.now();
    return [...this.peers.values()]
      .filter((p) => p.relay && p.origin === 'internet' && p.fails === 0 && p.nodeId !== this.o.nodeId && now - p.lastSeen < 120_000)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((p) => `http://${isIP(p.host) === 6 ? `[${p.host}]` : p.host}:${p.port}`);
  }

  /** Players behind recently reachable nodes (for friends, chat gossip and DMs). */
  players(): PeerPlayer[] {
    const now = Date.now();
    const out: PeerPlayer[] = [];
    for (const p of this.peers.values()) {
      if (!p.player || p.nodeId === this.o.nodeId || p.fails > 1) continue;
      if (now - p.lastSeen > (p.origin === 'lan' ? 20_000 : 180_000)) continue;
      out.push({ ...p.player, host: p.host, port: p.port, origin: p.origin });
    }
    return out;
  }

  /** Learn about a node that contacted us directly (e.g. by sending a chat message). */
  notePeer(host: string, port: number) {
    const h = host.replace(/^::ffff:/, '');
    this.addPeer(h, port, isPublicIPv4(h) ? 'internet' : 'lan');
  }

  private addPeer(host: string, port: number, origin: PeerOrigin) {
    if (!int(port, 1024, 65535)) return;
    if (origin === 'internet' && !isPublicIPv4(host)) return;
    if (origin === 'lan' && !isPrivateIPv4(host) && !host.startsWith('127.')) return;
    const key = `${host}:${port}`;
    const p = this.peers.get(key);
    if (p) { p.lastSeen = Date.now(); if (origin === 'lan') p.origin = 'lan'; return; }
    if (this.peers.size >= MAX_PEERS) return;
    this.peers.set(key, { host, port, origin, lastSeen: Date.now(), nextFetch: 0, fails: 0, servers: [] });
  }

  private pump() {
    const now = Date.now();
    for (const [key, p] of this.peers) {
      const stale = now - p.lastSeen > (p.origin === 'lan' ? 30_000 : 600_000);
      if (stale || p.fails >= 4) { this.peers.delete(key); continue; }
      if (now < p.nextFetch || this.fetching >= 16) continue;
      p.nextFetch = now + (p.origin === 'lan' ? 4000 : 15_000);
      this.fetching++;
      void this.fetchPeer(p).finally(() => { this.fetching--; });
    }
  }

  private async fetchPeer(p: Peer) {
    try {
      const host = isIP(p.host) === 6 ? `[${p.host}]` : p.host;
      const body = (await fetchCapped(`http://${host}:${p.port}/node`, 2500)) as Partial<NodeInfo>;
      if (body?.app !== APP || typeof body.nodeId !== 'string' || !/^[0-9a-f]{16}$/.test(body.nodeId) || !Array.isArray(body.servers)) throw new Error('bad node');
      p.nodeId = body.nodeId;
      p.relay = body.relay === true;
      p.player = sanitizePresence(body.player);
      const owner = clean(body.name, 32);
      p.servers = body.servers.slice(0, 32).map((s) => sanitizeRemote(s, p.host, p.origin, body.nodeId!, p.port)).filter((s): s is PeerServer => !!s)
        .map((s) => (owner ? { ...s, name: `${owner} · ${s.name}`.slice(0, 64) } : s));
      p.fails = 0;
      p.lastSeen = Date.now();
    } catch {
      p.fails++;
    }
  }

  private startLan() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => { this.o.log(`LAN discovery unavailable: ${e.message}`); sock.close(); this.sock = null; });
    sock.on('message', (msg, rinfo) => {
      if (msg.length > 512) return;
      try {
        const m = JSON.parse(msg.toString('utf8')) as { app?: string; nodeId?: string; port?: number };
        if (m.app !== APP || m.nodeId === this.o.nodeId || typeof m.port !== 'number') return;
        this.addPeer(rinfo.address, m.port, 'lan');
      } catch { /* not ours */ }
    });
    sock.bind(MCAST_PORT, () => {
      try {
        sock.addMembership(MCAST_ADDR);
        sock.setMulticastTTL(1);
        sock.setMulticastLoopback(true);
      } catch (e) { this.o.log(`LAN multicast join failed: ${(e as Error).message}`); }
      const beacon = () => {
        const msg = Buffer.from(JSON.stringify({ app: APP, v: PROTOCOL_VERSION, nodeId: this.o.nodeId, port: this.o.nodePort }));
        sock.send(msg, MCAST_PORT, MCAST_ADDR, () => {});
      };
      beacon();
      setInterval(beacon, 3000).unref();
      this.o.log(`LAN discovery on ${MCAST_ADDR}:${MCAST_PORT}`);
    });
  }

  private async startUpnp() {
    try {
      const { default: NatAPI } = await import('@silentbot1/nat-api');
      const nat = new NatAPI({ enablePMP: true, enableUPNP: true, description: 'Ascend Reborn' });
      await nat.map({ publicPort: this.o.nodePort, privatePort: this.o.nodePort, protocol: 'TCP' });
      for (const port of this.o.gamePorts) await nat.map(port); // TCP (WebSocket) + UDP (WebTransport)
      this.publicIp = await nat.externalIp().catch(() => null);
      this.upnpOk = true;
      this.nat = nat;
      this.o.log(`UPnP/NAT-PMP: opened ports ${[this.o.nodePort, ...this.o.gamePorts].join(', ')}${this.publicIp ? ` on ${this.publicIp}` : ''}`);
      const close = () => { void nat.destroy().catch(() => {}); };
      process.once('SIGINT', () => { close(); process.exit(0); });
      process.once('SIGTERM', () => { close(); process.exit(0); });
    } catch (e) {
      this.o.log(`UPnP/NAT-PMP unavailable (${(e as Error).message ?? e}); LAN play works, internet players need ports ${[this.o.nodePort, ...this.o.gamePorts].join(', ')} forwarded`);
    }
  }

  private async startDht(attempt = 0): Promise<void> {
    try {
      const { default: DHT } = await import('bittorrent-dht');
      const found = new Set<string>(DHT_FALLBACK);
      await Promise.all(DHT_ROUTERS.map(async ([host, port]) => {
        try { for (const ip of await resolve4(host)) found.add(`${ip}:${port}`); } catch { /* the literal IPs still work */ }
      }));
      const dht = new DHT({ bootstrap: [...found] });
      dht.on('peer', (peer: { host: string; port: number }) => this.addPeer(peer.host, peer.port, 'internet'));
      dht.on('error', (e: Error) => this.o.log(`DHT error: ${e.message}`));
      dht.on('warning', () => {});
      dht.listen(0);
      const timers: NodeJS.Timeout[] = [];
      const stop = dht.destroy.bind(dht);
      dht.destroy = (cb?: () => void) => { timers.forEach(clearInterval); stop(cb); };
      dht.on('ready', () => {
        this.o.log('Internet discovery: joined the public BitTorrent DHT');
        const announce = () => dht.announce(INFO_HASH, this.o.nodePort, () => {});
        const lookup = () => dht.lookup(INFO_HASH, () => {});
        announce(); lookup();
        timers.push(setInterval(announce, 5 * 60_000).unref(), setInterval(lookup, 45_000).unref());
      });
      this.dht = dht as unknown as typeof this.dht;
      // No routing nodes after a while means the bootstrap packets were lost: start over.
      setTimeout(() => {
        if (this.dht !== (dht as unknown as typeof this.dht) || dht.nodes.toArray().length > 0) return;
        if (attempt >= 3) { this.o.log('DHT: no nodes reachable (is outbound UDP blocked?); LAN play and direct addresses still work'); return; }
        this.o.log('DHT: no nodes yet, retrying');
        dht.destroy();
        this.dht = null;
        void this.startDht(attempt + 1);
      }, 30_000).unref();
    } catch (e) {
      this.o.log(`DHT unavailable: ${(e as Error).message}`);
    }
  }

  stop() {
    this.sock?.close();
    this.dht?.destroy();
  }
}
