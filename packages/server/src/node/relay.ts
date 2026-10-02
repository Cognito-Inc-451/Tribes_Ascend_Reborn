import type { ServerResponse } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { MODE_IDS, type ServerInfo } from '@ar/shared';

/*
 * NAT fallback (TURN-like): a host whose router refused UPnP/NAT-PMP keeps one outbound WebSocket to a publicly
 * reachable node (the relay). The relay lists the host's servers as its own and forwards each player's WebSocket
 * (and map downloads) over that link. No project-run server: any node with open ports can relay (opt out: AR_RELAY=0).
 *
 * Link frames (binary): u8 type, u32 stream, payload. Registration is a JSON text frame.
 */
const OPEN = 1, DATA = 2, CLOSE = 3, HTTP = 4, HTTP_HEAD = 5, HTTP_END = 6;
const MAX_HOSTS = 8, MAX_STREAMS_PER_HOST = 24, MAX_FRAME = 64 * 1024, MAX_HTTP_BYTES = 64 * 1024 * 1024;

const frame = (type: number, stream: number, payload?: Uint8Array | string) => {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload ?? new Uint8Array(0);
  const b = Buffer.allocUnsafe(5 + body.length);
  b[0] = type; b.writeUInt32LE(stream, 1); b.set(body, 5);
  return b;
};
const toBuf = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d as ArrayBuffer));
// eslint-disable-next-line no-control-regex
const clean = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, n) : '');

interface RelayedServer { id: string; info: Partial<ServerInfo> }
interface HostLink { ws: WebSocket; nodeId: string; name: string; servers: RelayedServer[]; streams: Map<number, WebSocket | ServerResponse>; next: number; ip: string }

/** Runs on publicly reachable nodes. */
export class RelayServer {
  private hosts = new Map<string, HostLink>();
  constructor(private log: (s: string) => void) {}

  get count() { return this.hosts.size; }

  attachHost(ws: WebSocket, ip: string) {
    let link: HostLink | null = null;
    const perIp = [...this.hosts.values()].filter((h) => h.ip === ip).length;
    if (this.hosts.size >= MAX_HOSTS || perIp >= 2) { ws.close(1013, 'relay full'); return; }
    ws.on('message', (data, isBinary) => {
      const buf = toBuf(data);
      if (!isBinary) {
        let msg: { t?: string; nodeId?: unknown; name?: unknown; servers?: unknown };
        try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
        if (msg.t !== 'register' || typeof msg.nodeId !== 'string' || !/^[0-9a-f]{16}$/.test(msg.nodeId) || !Array.isArray(msg.servers)) return;
        if (!link) {
          if (this.hosts.has(msg.nodeId)) { ws.close(1008, 'duplicate'); return; }
          link = { ws, nodeId: msg.nodeId, name: '', servers: [], streams: new Map(), next: 1, ip };
          this.hosts.set(link.nodeId, link);
          this.log(`relay: hosting servers for ${msg.nodeId} (${ip})`);
        }
        link.name = clean(msg.name, 32);
        link.servers = msg.servers.slice(0, 8).map((s) => sanitizeRelayed(s)).filter((s): s is RelayedServer => !!s);
        return;
      }
      if (!link || buf.length < 5) return;
      const type = buf[0], stream = buf.readUInt32LE(1), payload = buf.subarray(5);
      const peer = link.streams.get(stream);
      if (!peer) return;
      if (peer instanceof WebSocket) {
        if (type === DATA && peer.readyState === peer.OPEN && peer.bufferedAmount < 1 << 20) peer.send(payload, { binary: true });
        else if (type === CLOSE) { link.streams.delete(stream); peer.close(1000); }
        return;
      }
      if (type === HTTP_HEAD) {
        const status = payload.readUInt16LE(0);
        if (!peer.headersSent) peer.writeHead(status, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
      } else if (type === DATA) peer.write(payload);
      else if (type === HTTP_END || type === CLOSE) { link.streams.delete(stream); if (!peer.headersSent) peer.writeHead(502); peer.end(); }
    });
    const drop = () => {
      if (!link) return;
      for (const s of link.streams.values()) { if (s instanceof WebSocket) s.close(1001, 'host gone'); else { if (!s.headersSent) s.writeHead(502); s.end(); } }
      this.hosts.delete(link.nodeId);
      this.log(`relay: ${link.nodeId} disconnected`);
      link = null;
    };
    ws.on('close', drop);
    ws.on('error', () => ws.terminate());
  }

  private open(nodeId: string, serverId: string): { link: HostLink; stream: number } | null {
    const link = this.hosts.get(nodeId);
    if (!link || !link.servers.some((s) => s.id === serverId) || link.streams.size >= MAX_STREAMS_PER_HOST) return null;
    const stream = link.next++;
    return { link, stream };
  }

  /** A player connecting to a relayed server. */
  attachClient(ws: WebSocket, nodeId: string, serverId: string) {
    const o = this.open(nodeId, serverId);
    if (!o) { ws.close(1013, 'server not available'); return; }
    const { link, stream } = o;
    link.streams.set(stream, ws);
    link.ws.send(frame(OPEN, stream, serverId));
    ws.on('message', (data) => {
      const b = toBuf(data);
      if (b.length <= MAX_FRAME && link.ws.readyState === link.ws.OPEN && link.ws.bufferedAmount < 4 << 20) link.ws.send(frame(DATA, stream, b));
    });
    ws.on('close', () => { if (link.streams.delete(stream) && link.ws.readyState === link.ws.OPEN) link.ws.send(frame(CLOSE, stream)); });
    ws.on('error', () => ws.terminate());
  }

  /** Map downloads for relayed servers (GET .../map/<file>). */
  proxyHttp(nodeId: string, serverId: string, path: string, res: ServerResponse) {
    const o = this.open(nodeId, serverId);
    if (!o) { res.writeHead(404).end(); return; }
    o.link.streams.set(o.stream, res);
    o.link.ws.send(frame(HTTP, o.stream, `${serverId}\n${path}`));
    res.on('close', () => { if (o.link.streams.delete(o.stream) && o.link.ws.readyState === o.link.ws.OPEN) o.link.ws.send(frame(CLOSE, o.stream)); });
  }

  /** Relayed servers as advertised in this node's /node (remote nodes rewrite the host part). */
  servers(nodePort: number): ServerInfo[] {
    const out: ServerInfo[] = [];
    for (const h of this.hosts.values()) for (const s of h.servers) {
      out.push({
        ...(s.info as ServerInfo), id: s.id, name: `${h.name ? `${h.name} · ` : ''}${s.info.name ?? s.id} (relay)`.slice(0, 64),
        transports: ['websocket'], wsUrl: `ws://relay:${nodePort}/relay/c/${h.nodeId}/${s.id}`, wtUrl: undefined, certHash: undefined,
      });
    }
    return out;
  }
}

function sanitizeRelayed(raw: unknown): RelayedServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const id = clean(s.id, 32);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !MODE_IDS.includes(s.mode as never)) return null;
  const map = clean(s.map, 40);
  if (!/^[a-z0-9_]{1,40}$/.test(map)) return null;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    id, info: {
      name: clean(s.name, 48) || id, mode: s.mode as ServerInfo['mode'], map, mapName: clean(s.mapName, 48) || map,
      mapSource: s.mapSource === 'original' ? 'original' : 'reborn', humans: n(s.humans, 0, 64, 0), bots: n(s.bots, 0, 64, 0),
      maxPlayers: n(s.maxPlayers, 2, 64, 16), version: n(s.version, 0, 1000, 0), passworded: s.passworded === true,
    },
  };
}

/** Runs on a host behind NAT: keeps a link to a relay and bridges streams to its own game servers on 127.0.0.1. */
export class RelayClient {
  private ws: WebSocket | null = null;
  private relay: string | null = null;
  private local = new Map<number, WebSocket | AbortController>();
  private pending = new Map<number, Buffer[]>();
  private stopped = false;

  constructor(private o: {
    nodeId: string; name: string; log: (s: string) => void;
    servers: () => { info: ServerInfo; port: number }[];
    pickRelay: (avoid: Set<string>) => string | null;
  }) {}

  /** Relay base URL in use (http://host:port), if connected. */
  get current() { return this.ws?.readyState === WebSocket.OPEN ? this.relay : null; }

  start() {
    const avoid = new Set<string>();
    const tick = () => {
      if (this.stopped) return;
      if (!this.ws) {
        const r = this.o.pickRelay(avoid);
        if (r) this.connect(r, avoid);
      } else if (this.ws.readyState === WebSocket.OPEN) this.register();
    };
    setInterval(tick, 10_000).unref();
    setTimeout(tick, 3000).unref();
  }

  stop() { this.stopped = true; this.ws?.close(); }

  private register() {
    const servers = this.o.servers().map((s) => s.info);
    this.ws?.send(JSON.stringify({ t: 'register', nodeId: this.o.nodeId, name: this.o.name, servers }));
  }

  private connect(base: string, avoid: Set<string>) {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/relay/host`, { maxPayload: MAX_FRAME + 16, handshakeTimeout: 5000 });
    this.ws = ws;
    this.relay = base;
    ws.on('open', () => { this.o.log(`relay: players can reach this PC's games through ${base}`); this.register(); });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const b = toBuf(data);
      if (b.length < 5) return;
      const type = b[0], stream = b.readUInt32LE(1), payload = b.subarray(5);
      if (type === OPEN) this.openStream(stream, payload.toString());
      else if (type === DATA) {
        const l = this.local.get(stream);
        if (l instanceof WebSocket) {
          if (l.readyState === l.OPEN) l.send(payload, { binary: true });
          else if (l.readyState === l.CONNECTING) { const q = this.pending.get(stream) ?? []; if (q.length < 64) q.push(Buffer.from(payload)); this.pending.set(stream, q); }
        }
      }
      else if (type === CLOSE) { const l = this.local.get(stream); this.local.delete(stream); if (l instanceof WebSocket) l.close(); else l?.abort(); }
      else if (type === HTTP) { const [sid, path] = payload.toString().split('\n'); void this.httpStream(stream, sid, path); }
    });
    ws.on('close', (code) => {
      for (const l of this.local.values()) { if (l instanceof WebSocket) l.close(); else l.abort(); }
      this.local.clear();
      if (this.ws === ws) { this.ws = null; this.relay = null; }
      if (code !== 1000) avoid.add(base);
    });
    ws.on('error', () => ws.terminate());
  }

  private send(type: number, stream: number, payload?: Uint8Array | string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame(type, stream, payload));
  }

  private openStream(stream: number, serverId: string) {
    const s = this.o.servers().find((x) => x.info.id === serverId);
    if (!s) { this.send(CLOSE, stream); return; }
    const l = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { maxPayload: MAX_FRAME });
    this.local.set(stream, l);
    l.on('open', () => { for (const q of this.pending.get(stream) ?? []) l.send(q, { binary: true }); this.pending.delete(stream); });
    l.on('message', (d) => this.send(DATA, stream, toBuf(d)));
    l.on('close', () => { this.pending.delete(stream); if (this.local.delete(stream)) this.send(CLOSE, stream); });
    l.on('error', () => l.terminate());
  }

  private async httpStream(stream: number, serverId: string, path: string) {
    const s = this.o.servers().find((x) => x.info.id === serverId);
    if (!s || !/^\/map\/[a-z0-9_]+\.[a-z]+\.arm\.gz$/.test(path ?? '')) { this.send(CLOSE, stream); return; }
    const ac = new AbortController();
    this.local.set(stream, ac);
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { signal: ac.signal });
      const head = Buffer.alloc(2); head.writeUInt16LE(r.status, 0);
      this.send(HTTP_HEAD, stream, head);
      let sent = 0;
      if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        for (let i = 0; i < chunk.length; i += 32 * 1024) this.send(DATA, stream, chunk.subarray(i, i + 32 * 1024));
        sent += chunk.length;
        if (sent > MAX_HTTP_BYTES) break;
      }
    } catch { /* aborted or local server gone */ }
    if (this.local.delete(stream)) this.send(HTTP_END, stream);
  }
}

/** Upgrade routing for /relay/* WebSockets on the node's port. */
export function relayUpgradePath(url: string): { kind: 'host' } | { kind: 'client'; nodeId: string; serverId: string } | null {
  if (url === '/relay/host') return { kind: 'host' };
  const m = /^\/relay\/c\/([0-9a-f]{16})\/([A-Za-z0-9_-]{1,32})$/.exec(url);
  return m ? { kind: 'client', nodeId: m[1], serverId: m[2] } : null;
}

export function relayHttpPath(path: string): { nodeId: string; serverId: string; path: string } | null {
  const m = /^\/relay\/c\/([0-9a-f]{16})\/([A-Za-z0-9_-]{1,32})(\/map\/[a-z0-9_]+\.[a-z]+\.arm\.gz)$/.exec(path);
  return m ? { nodeId: m[1], serverId: m[2], path: m[3] } : null;
}
