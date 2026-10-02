import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
  randomBytes, sign, verify, type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { playerIdOf, type Discovery, type Presence } from './discovery.js';

/** Global chat line or private message as delivered to clients. */
export interface ChatMsg { kind: 'global' | 'dm'; id: string; from: string; name: string; to?: string; text: string; ts: number; mine?: boolean }

/** Wire form between nodes. Global lines are signed; DMs are signed and AES-GCM encrypted with an X25519 shared key. */
interface WireMsg {
  kind: 'global' | 'dm'; id: string; from: string; name: string; ts: number; edPub: string; xPub: string; sig: string; hops: number;
  text?: string; to?: string; nonce?: string; ct?: string; replyPort?: number;
}

const MAX_TEXT = 200;
// eslint-disable-next-line no-control-regex
const cleanText = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

interface Identity { edPriv: KeyObject; edPub: string; xPriv: KeyObject; xPub: string; id: string }

/** One identity per node port, so extra nodes on the same PC count as separate players. */
function loadIdentity(dir: string, port: number): Identity {
  const path = join(dir, port === 7770 ? 'identity.json' : `identity-${port}.json`);
  let raw: { ed: string; x: string } | null = null;
  if (existsSync(path)) try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { raw = null; }
  if (!raw) {
    const ed = generateKeyPairSync('ed25519'), x = generateKeyPairSync('x25519');
    raw = { ed: ed.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), x: x.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
  }
  const edPriv = createPrivateKey({ key: Buffer.from(raw.ed, 'base64'), format: 'der', type: 'pkcs8' });
  const xPriv = createPrivateKey({ key: Buffer.from(raw.x, 'base64'), format: 'der', type: 'pkcs8' });
  const edPub = createPublicKey(edPriv).export({ format: 'der', type: 'spki' }).toString('base64');
  const xPub = createPublicKey(xPriv).export({ format: 'der', type: 'spki' }).toString('base64');
  return { edPriv, edPub, xPriv, xPub, id: playerIdOf(edPub) };
}

const signedPart = (m: WireMsg) => JSON.stringify([m.kind, m.id, m.from, m.name, m.ts, m.edPub, m.xPub, m.text ?? '', m.to ?? '', m.nonce ?? '', m.ct ?? '']);
const pubKey = (b64: string) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

/**
 * Friends, global chat and private messages without a central server. Each node has a persistent Ed25519/X25519
 * identity; global lines spread by gossip between discovered nodes, DMs go straight to the recipient's node.
 */
export class Social {
  readonly me: Identity;
  name = 'Tribal';
  status = 'In lobby';
  server: { ws: string; name: string } | null = null;
  private clients = new Set<WebSocket>();
  private seen = new Map<string, number>();
  private history: ChatMsg[] = [];
  private dms: ChatMsg[] = [];
  private rate = new Map<string, { t: number; n: number }>();

  constructor(dir: string, private discovery: Discovery, private nodePort: number, private log: (s: string) => void) {
    this.me = loadIdentity(dir, nodePort);
    setInterval(() => this.pushPresence(), 5000).unref();
    setInterval(() => { const cut = Date.now() - 3600_000; for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k); }, 600_000).unref();
  }

  presence(): Presence {
    return { id: this.me.id, name: this.name, status: this.status, serverWs: this.server?.ws, serverName: this.server?.name, edPub: this.me.edPub, xPub: this.me.xPub };
  }

  // ------------------------------------------------------------ local client (browser) side
  attach(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      if (!this.clients.size) { this.status = 'Away'; this.server = null; }
    });
    ws.on('message', (data) => {
      if (String(data).length > 1024) return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t === 'hello') { this.name = cleanText(m.name, 20) || 'Tribal'; this.sendTo(ws, { t: 'me', id: this.me.id, name: this.name }); this.sendTo(ws, { t: 'history', msgs: [...this.history, ...this.dms] }); this.pushPresence(); }
      else if (m.t === 'status') {
        this.status = cleanText(m.status, 24) || 'In lobby';
        const wsUrl = typeof m.serverWs === 'string' && /^ws:\/\/[\w.[\]:-]{3,80}\/ws$/.test(m.serverWs) ? m.serverWs : null;
        this.server = wsUrl ? { ws: wsUrl, name: cleanText(m.serverName, 64) } : null;
      } else if (m.t === 'say') void this.sayGlobal(cleanText(m.text, MAX_TEXT));
      else if (m.t === 'dm' && typeof m.to === 'string') void this.sendDm(m.to, cleanText(m.text, MAX_TEXT));
    });
  }

  private sendTo(ws: WebSocket, msg: unknown) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  private broadcastLocal(msg: unknown) { for (const c of this.clients) this.sendTo(c, msg); }

  private pushPresence() {
    // A friend hosting on their own PC reports ws://localhost:...; reach it through their node's address instead.
    const fix = (ws: string | undefined, host: string) => ws?.replace(/^ws:\/\/(localhost|127\.0\.0\.1):/, `ws://${isIP(host) === 6 ? `[${host}]` : host}:`);
    this.broadcastLocal({ t: 'presence', players: this.discovery.players().map(({ id, name, status, serverWs, serverName, origin, host }) => ({ id, name, status, serverWs: fix(serverWs, host), serverName, origin })) });
  }

  // ------------------------------------------------------------ outgoing
  private wire(kind: WireMsg['kind'], extra: Partial<WireMsg>): WireMsg {
    const m: WireMsg = { kind, id: randomBytes(12).toString('hex'), from: this.me.id, name: this.name, ts: Date.now(), edPub: this.me.edPub, xPub: this.me.xPub, sig: '', hops: 0, replyPort: this.nodePort, ...extra };
    m.sig = sign(null, Buffer.from(signedPart(m)), this.me.edPriv).toString('base64');
    return m;
  }

  private async sayGlobal(text: string) {
    if (!text || !this.allow(this.me.id)) return;
    const m = this.wire('global', { text });
    this.seen.set(m.id, Date.now());
    this.deliverGlobal(m, true);
    await this.gossip(m);
  }

  private async sendDm(to: string, text: string) {
    if (!text || !/^[0-9a-f]{16}$/.test(to)) return;
    const peer = this.discovery.players().find((p) => p.id === to);
    if (!peer) { this.broadcastLocal({ t: 'error', msg: 'That player is offline.' }); return; }
    const key = this.sharedKey(peer.xPub);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
    const m = this.wire('dm', { to, nonce: nonce.toString('base64'), ct: ct.toString('base64') });
    const local: ChatMsg = { kind: 'dm', id: m.id, from: this.me.id, name: this.name, to, text, ts: m.ts, mine: true };
    this.dms.push(local); if (this.dms.length > 200) this.dms.shift();
    this.broadcastLocal({ t: 'msg', msg: local });
    if (!(await this.post(peer.host, peer.port, m))) this.broadcastLocal({ t: 'error', msg: `Could not reach ${peer.name}.` });
  }

  private sharedKey(theirXPub: string): Buffer {
    const secret = diffieHellman({ privateKey: this.me.xPriv, publicKey: pubKey(theirXPub) });
    return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('ascend-reborn-dm'), 32));
  }

  private async gossip(m: WireMsg, except?: string) {
    const targets = this.discovery.players().filter((p) => p.id !== except && p.id !== m.from).slice(0, 48);
    await Promise.all(targets.map((p) => this.post(p.host, p.port, m)));
  }

  private async post(host: string, port: number, m: WireMsg): Promise<boolean> {
    try {
      const h = isIP(host) === 6 ? `[${host}]` : host;
      const r = await fetch(`http://${h}:${port}/social/msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m), signal: AbortSignal.timeout(3000), redirect: 'error' });
      return r.ok;
    } catch { return false; }
  }

  // ------------------------------------------------------------ incoming from other nodes
  private allow(sender: string): boolean {
    const now = Date.now();
    const r = this.rate.get(sender) ?? { t: now, n: 0 };
    r.n = Math.max(0, r.n - (now - r.t) / 1000);
    r.t = now;
    if (r.n >= 5) return false;
    r.n++;
    this.rate.set(sender, r);
    return true;
  }

  /** Validate a message posted by another node. Returns false for malformed or forged input. */
  receive(raw: unknown, remoteHost: string): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const m = raw as WireMsg;
    if ((m.kind !== 'global' && m.kind !== 'dm') || typeof m.id !== 'string' || !/^[0-9a-f]{24}$/.test(m.id)) return false;
    if (typeof m.edPub !== 'string' || typeof m.xPub !== 'string' || typeof m.sig !== 'string' || typeof m.ts !== 'number' || typeof m.name !== 'string') return false;
    if (this.seen.has(m.id)) return true;
    if (Math.abs(Date.now() - m.ts) > 10 * 60_000) return false;
    try {
      if (playerIdOf(m.edPub) !== m.from) return false;
      if (!verify(null, Buffer.from(signedPart(m)), pubKey(m.edPub), Buffer.from(m.sig, 'base64'))) return false;
    } catch { return false; }
    if (!this.allow(m.from)) return false;
    this.seen.set(m.id, Date.now());
    if (typeof m.replyPort === 'number' && Number.isInteger(m.replyPort)) this.discovery.notePeer(remoteHost, m.replyPort);
    const name = cleanText(m.name, 20) || 'Tribal';
    if (m.kind === 'global') {
      const text = cleanText(m.text, MAX_TEXT);
      if (!text) return false;
      this.deliverGlobal({ ...m, name, text }, false);
      if ((m.hops ?? 0) < 3) void this.gossip({ ...m, hops: (m.hops ?? 0) + 1 }, m.from);
      return true;
    }
    if (m.to !== this.me.id || typeof m.nonce !== 'string' || typeof m.ct !== 'string') return false;
    try {
      const buf = Buffer.from(m.ct, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.sharedKey(m.xPub), Buffer.from(m.nonce, 'base64'));
      d.setAuthTag(buf.subarray(buf.length - 16));
      const text = cleanText(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'), MAX_TEXT);
      const msg: ChatMsg = { kind: 'dm', id: m.id, from: m.from, name, to: m.to, text, ts: m.ts };
      this.dms.push(msg); if (this.dms.length > 200) this.dms.shift();
      this.broadcastLocal({ t: 'msg', msg });
      return true;
    } catch { return false; }
  }

  private deliverGlobal(m: WireMsg, mine: boolean) {
    const msg: ChatMsg = { kind: 'global', id: m.id, from: m.from, name: m.name, text: m.text ?? '', ts: m.ts, mine };
    this.history.push(msg);
    if (this.history.length > 150) this.history.shift();
    this.broadcastLocal({ t: 'msg', msg });
  }
}
