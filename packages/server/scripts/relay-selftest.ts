import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeJson, encodeJson, isJsonFrame, PROTOCOL_VERSION } from '@ar/shared';
import { RelayClient, RelayServer, relayHttpPath, relayUpgradePath } from '../src/node/relay.js';

// Local end-to-end check of the relay: relay node on :7795, a "NATed host" bridging to the running ctf-original server (:7777).
const log = (s: string) => console.log(`[test] ${s}`);
const relay = new RelayServer(log);
const wss = new WebSocketServer({ noServer: true });
const srv = createServer((req, res) => {
  const rh = relayHttpPath(new URL(req.url ?? '/', 'http://x').pathname);
  if (rh) relay.proxyHttp(rh.nodeId, rh.serverId, rh.path, res); else res.writeHead(404).end();
});
srv.on('upgrade', (req, sock, head) => {
  const rp = relayUpgradePath(req.url ?? '');
  if (!rp) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => (rp.kind === 'host' ? relay.attachHost(ws, '127.0.0.1') : relay.attachClient(ws, rp.nodeId, rp.serverId)));
});
srv.listen(7795);

const info = await (await fetch('http://127.0.0.1:7777/info')).json();
const nodeId = '0123456789abcdef';
const client = new RelayClient({ nodeId, name: 'TestHost', log, servers: () => [{ info, port: 7777 }], pickRelay: () => 'http://127.0.0.1:7795' });
client.start();
await new Promise((r) => setTimeout(r, 4500));
console.log('relayed servers:', relay.servers(7795).map((s) => `${s.name} -> ${s.wsUrl}`));

const ws = new WebSocket(`ws://127.0.0.1:7795/relay/c/${nodeId}/${info.id}`);
ws.binaryType = 'nodebuffer';
let gotWelcome = false, snaps = 0;
ws.on('open', () => ws.send(encodeJson({ t: 'hello', v: PROTOCOL_VERSION, name: 'RelayTest', cosmetics: {}, transport: 'websocket' })));
ws.on('message', (d: Buffer) => {
  const u = new Uint8Array(d);
  if (isJsonFrame(u)) { const m = decodeJson(u) as { t: string; map?: { file?: string } }; if (m.t === 'welcome') { gotWelcome = true; console.log('welcome via relay, map', m.map?.file); void testMap(m.map?.file); } }
  else snaps++;
});
async function testMap(file?: string) {
  if (!file) return;
  const r = await fetch(`http://127.0.0.1:7795/relay/c/${nodeId}/${info.id}/map/${file}`);
  const b = await r.arrayBuffer();
  console.log(`map via relay: HTTP ${r.status}, ${b.byteLength} bytes`);
}
await new Promise((r) => setTimeout(r, 5000));
console.log(`welcome=${gotWelcome} binary frames=${snaps}`);
ws.close(); client.stop(); srv.close();
process.exit(gotWelcome ? 0 : 1);

