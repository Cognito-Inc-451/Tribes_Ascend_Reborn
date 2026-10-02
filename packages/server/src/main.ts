import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ServerConfig } from './config.js';
import { GameServer } from './GameServer.js';
import { MapLibrary } from './game/maps.js';
import { Discovery, newNodeId } from './node/discovery.js';
import { LocalNode, type HostRequest } from './node/node.js';
import { RelayClient, RelayServer } from './node/relay.js';
import { Social } from './node/social.js';
import { getCertificate } from './transport/certs.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const cfgPath = resolve(opt('config') ?? process.env.AR_CONFIG ?? join(repoRoot, 'config', 'servers.json'));
const root = loadConfig(cfgPath);
if (process.env.PUBLIC_HOST) root.publicHost = process.env.PUBLIC_HOST;
if (process.env.MASTER_URL) root.master = process.env.MASTER_URL;
const only = opt('only')?.split(',');
const assetsDir = resolve(process.env.AR_MAPS_ORIGINAL ?? join(repoRoot, 'maps-original'));
const lib = new MapLibrary(assetsDir);

const cert = await getCertificate(root.certFile ?? process.env.CERT_FILE, root.keyFile ?? process.env.KEY_FILE, root.publicHost);
if (cert.hash) console.log(`[certs] generated 13-day ECDSA WebTransport certificate (sha-256 ${cert.hash.slice(0, 16)}…)`);
console.log(`[maps] ${lib.originals().length} original map files available`);

const nodeCfg = root.node ?? {};
const nodePort = Number(process.env.AR_NODE_PORT ?? nodeCfg.port ?? 7770);
// Client mode: no dedicated servers from the config; you browse/join games and can still host one from the menu.
const clientMode = args.includes('--client') || process.env.AR_CLIENT === '1' || nodeCfg.clientOnly === true;
if (clientMode) console.log('[node] client mode: not running dedicated servers (HOST GAME still works)');
const started: GameServer[] = [];
for (const s of clientMode ? [] : root.servers) {
  if (only && !only.includes(s.id)) continue;
  try {
    const gs = new GameServer(s, root, lib, cert);
    gs.assetsUrl = `http://localhost:${nodePort}`;
    await gs.start();
    started.push(gs);
  } catch (e) {
    console.error(`[${s.id}] failed to start: ${(e as Error).message}`);
  }
}

if (!args.includes('--no-node')) {
  const nodeId = newNodeId();
  const log = (s: string) => console.log(`[node] ${s}`);
  const off = (env: string) => process.env[env] === '0' || process.env[env] === 'false';
  const discovery = new Discovery({
    nodeId, nodePort, gamePorts: started.map((s) => s.cfg.port), log,
    lan: (nodeCfg.lan ?? true) && !off('AR_LAN'),
    internet: (nodeCfg.internet ?? true) && !off('AR_DHT') && !args.includes('--offline'),
    upnp: (nodeCfg.upnp ?? true) && !off('AR_UPNP') && !args.includes('--offline'),
  });
  const dist = join(repoRoot, 'packages', 'client', 'dist');
  const social = new Social(assetsDir, discovery, nodePort, log);
  const hosted = new Set<GameServer>();
  const host = async (r: HostRequest): Promise<GameServer> => {
    if (hosted.size >= 4) throw new Error('already hosting 4 games; close one first');
    const used = new Set(started.map((s) => s.cfg.port));
    let port = 7800;
    while (used.has(port) && port < 7832) port++;
    if (port >= 7832) throw new Error('no free port');
    const cfg: ServerConfig = {
      id: `host-${port}`, name: r.name, mode: r.mode, mapSource: r.mapSource, maps: r.maps, port, wtPort: port, maxPlayers: r.maxPlayers,
      bots: { fillTo: 0, difficulty: r.options.botDifficulty ?? 'adept' }, options: r.options, skillsMaxed: true,
    };
    const gs = new GameServer(cfg, root, lib, cert);
    gs.assetsUrl = `http://localhost:${nodePort}`;
    await gs.start();
    started.push(gs);
    hosted.add(gs);
    void discovery.openPort(port);
    return gs;
  };
  setInterval(() => {
    for (const gs of hosted) {
      if (Date.now() - gs.lastHuman < 10 * 60_000) continue;
      gs.stop();
      hosted.delete(gs);
      started.splice(started.indexOf(gs), 1);
    }
  }, 60_000).unref();
  const internet = (nodeCfg.internet ?? true) && !off('AR_DHT') && !args.includes('--offline');
  const relayOn = (nodeCfg.relay ?? true) && !off('AR_RELAY') && internet;
  const relay = relayOn ? new RelayServer(log) : null;
  const name = (nodeCfg.name ?? hostname()).slice(0, 32);
  new LocalNode({
    port: nodePort, nodeId, name, servers: started, assetsDir,
    clientDir: existsSync(join(dist, 'index.html')) ? dist : null, discovery, social, host, hasOriginal: (m, mode) => lib.hasOriginal(m, mode), log,
    relay, relayOffered: () => discovery.upnpOk,
  }).start();
  void discovery.start().then(() => {
    // Behind a NAT that refused UPnP/NAT-PMP/PCP: let internet players in through a relay node instead.
    if (!relayOn || discovery.upnpOk) return;
    log('no port mapping: hosted games will be reachable from the internet through a relay node when one is found');
    new RelayClient({
      nodeId, name, log,
      servers: () => started.map((gs) => ({ info: gs.info(), port: gs.cfg.port })),
      pickRelay: (avoid) => discovery.relays().find((r) => !avoid.has(r)) ?? null,
    }).start();
  });
}
