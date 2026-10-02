// Two-node social test: run two nodes (7770 and 7775, see second-node.json), then: node tools/e2e/social-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { WebSocket } = require('ws');

const open = (port, name) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${port}/social`, { headers: { origin: `http://localhost:${port}` } });
  const st = { ws, id: '', presence: [], msgs: [] };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'me') { st.id = m.id; resolve(st); }
    if (m.t === 'presence') st.presence = m.players;
    if (m.t === 'msg') st.msgs.push(m.msg);
    if (m.t === 'error') console.log(`[${name}] error:`, m.msg);
  });
  ws.on('error', reject);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(250); } console.log('TIMEOUT:', what); return false; };

const a = await open(7770, 'Alice');
const b = await open(7775, 'Bob');
console.log('ids', a.id, b.id);
await until(() => a.presence.some((p) => p.id === b.id) && b.presence.some((p) => p.id === a.id), 30000, 'presence');
console.log('A sees', a.presence.map((p) => `${p.name}(${p.status})`).join(', '));
console.log('B sees', b.presence.map((p) => `${p.name}(${p.status})`).join(', '));
a.ws.send(JSON.stringify({ t: 'say', text: 'hello network' }));
const g = await until(() => b.msgs.some((m) => m.kind === 'global' && m.text === 'hello network'), 8000, 'global');
console.log('global delivered:', g);
a.ws.send(JSON.stringify({ t: 'dm', to: b.id, text: 'secret hi' }));
const d = await until(() => b.msgs.some((m) => m.kind === 'dm' && m.text === 'secret hi' && m.from === a.id), 8000, 'dm');
console.log('dm delivered:', d);
b.ws.send(JSON.stringify({ t: 'status', status: 'In match', serverWs: 'ws://localhost:7790/ws', serverName: 'LAN Test Miasma' }));
await until(() => a.presence.some((p) => p.id === b.id && p.status === 'In match'), 15000, 'status');
console.log('A sees Bob as', JSON.stringify(a.presence.find((p) => p.id === b.id)));
a.ws.close(); b.ws.close();
process.exit(g && d ? 0 : 1);
