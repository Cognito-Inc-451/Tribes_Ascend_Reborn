import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MODE_IDS, type ServerInfo } from '@ar/shared';

const PORT = Number(process.env.MASTER_PORT ?? 8787);
const KEY = process.env.MASTER_KEY;
const TTL = 35_000;

interface Entry { info: ServerInfo & { infoUrl?: string }; lastSeen: number; addr: string }
const servers = new Map<string, Entry>();
const hits = new Map<string, { n: number; t: number }>();

function limited(addr: string, max: number): boolean {
  const now = Date.now();
  const h = hits.get(addr);
  if (!h || now - h.t > 10_000) { hits.set(addr, { n: 1, t: now }); return false; }
  return ++h.n > max;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo);
const url = (v: unknown) => {
  const s = str(v, 200);
  if (!s) return undefined;
  try { const u = new URL(s); return ['ws:', 'wss:', 'https:', 'http:'].includes(u.protocol) ? u.toString() : undefined; } catch { return undefined; }
};

function sanitize(raw: Record<string, unknown>): (ServerInfo & { infoUrl?: string }) | null {
  const id = str(raw.id, 48), name = str(raw.name, 64), mode = str(raw.mode, 16);
  if (!id || !name || !mode || !MODE_IDS.includes(mode as never)) return null;
  const transports = Array.isArray(raw.transports) ? raw.transports.filter((t) => t === 'websocket' || t === 'webtransport') : [];
  if (!transports.length) return null;
  return {
    id, name, mode: mode as ServerInfo['mode'], map: str(raw.map, 48) ?? '', mapName: str(raw.mapName, 64) ?? '',
    mapSource: raw.mapSource === 'original' ? 'original' : 'reborn', humans: int(raw.humans, 0, 64), bots: int(raw.bots, 0, 64),
    maxPlayers: int(raw.maxPlayers, 1, 64), transports: transports as ServerInfo['transports'], wsUrl: url(raw.wsUrl), wtUrl: url(raw.wtUrl),
    certHash: typeof raw.certHash === 'string' && /^[0-9a-f]{64}$/.test(raw.certHash) ? raw.certHash : undefined,
    region: str(raw.region, 32), version: int(raw.version, 0, 1000), passworded: raw.passworded === true, infoUrl: url(raw.infoUrl),
  };
}

function readBody(req: IncomingMessage, max = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const addr = req.socket.remoteAddress ?? '?';
  const path = new URL(req.url ?? '/', 'http://x').pathname;

  if (req.method === 'GET' && path === '/servers') {
    if (limited(addr, 120)) { res.writeHead(429).end(); return; }
    const now = Date.now();
    const list = [...servers.values()].filter((e) => now - e.lastSeen < TTL).map((e) => e.info);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(list));
    return;
  }
  if (req.method === 'POST' && path === '/announce') {
    if (KEY && req.headers['x-master-key'] !== KEY) { res.writeHead(403).end(); return; }
    if (limited(`a:${addr}`, 60)) { res.writeHead(429).end(); return; }
    try {
      const info = sanitize(JSON.parse(await readBody(req)) as Record<string, unknown>);
      if (!info) { res.writeHead(400).end('bad server info'); return; }
      const key = `${addr}|${info.id}`;
      servers.set(key, { info, lastSeen: Date.now(), addr });
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  res.writeHead(404).end();
}

createServer((req, res) => { handle(req, res).catch(() => res.writeHead(500).end()); }).listen(PORT, () => {
  console.log(`[master] server list on http://localhost:${PORT}/servers`);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of servers) if (now - e.lastSeen > TTL * 2) servers.delete(k);
  for (const [k, h] of hits) if (now - h.t > 60_000) hits.delete(k);
}, 30_000).unref();
