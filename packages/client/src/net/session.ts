import {
  BIN, decodeJson, decodeSnapshot, encodeInput, encodeJson, isJsonFrame, PROTOCOL_VERSION,
  type C2S, type InputCmd, type PlayerInfo, type S2C, type ServerInfo, type Snapshot,
} from '@ar/shared';
import { settings } from '../settings.js';
import type { ClientTransport } from './transport.js';

export interface TimedSnapshot { snap: Snapshot; recvAt: number; serverTime: number }

/** Protocol state for one connection: handshake, snapshot buffer, server clock, RTT. */
export class Session {
  myId = -1;
  /** The join screens (team / class) were shown: map changes keep your team and drop you straight in, as in TA. */
  greeted = false;
  /** Next input sequence number; carried from map to map within one connection. */
  inputSeq = 1;
  server: ServerInfo;
  tickRate = 60;
  players = new Map<number, PlayerInfo>();
  snapshots: TimedSnapshot[] = [];
  latest: Snapshot | null = null;
  rtt = 0.08;
  clockOffset = 0; // serverTime - performance.now()/1000
  private clockInit = false;
  bytesIn = 0;
  bytesOut = 0;
  snapsIn = 0;
  private pingTimer: number;
  onJson: (msg: S2C) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  onClose: (reason: string) => void = () => {};

  constructor(readonly transport: ClientTransport, info: ServerInfo) {
    this.server = info;
    transport.onMessage = (d) => this.handle(d);
    transport.onClose = (r) => { clearInterval(this.pingTimer); this.onClose(r); };
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now(), rtt: this.rtt }), 1000);
  }

  hello() {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: settings.name, cosmetics: settings.cosmetics, transport: this.transport.kind });
  }

  send(msg: C2S) {
    const d = encodeJson(msg);
    this.bytesOut += d.length;
    this.transport.sendReliable(d);
  }

  sendInputs(cmds: InputCmd[]) {
    const d = encodeInput(cmds);
    this.bytesOut += d.length;
    this.transport.sendUnreliable(d);
  }

  /** Estimated current server time (seconds). */
  serverNow(): number { return performance.now() / 1000 + this.clockOffset; }

  private handle(d: Uint8Array) {
    this.bytesIn += d.length;
    if (d[0] === BIN.SNAPSHOT) {
      const snap = decodeSnapshot(d);
      // Drop late duplicates; a tick far behind the latest means a new match after a map change.
      if (this.latest && snap.tick <= this.latest.tick && this.latest.tick - snap.tick < 300) return;
      this.snapsIn++;
      const now = performance.now() / 1000;
      const serverTime = snap.tick / this.tickRate;
      const offset = serverTime + this.rtt / 2 - now;
      if (!this.clockInit) { this.clockOffset = offset; this.clockInit = true; }
      else this.clockOffset += (offset - this.clockOffset) * (offset > this.clockOffset ? 0.25 : 0.05);
      this.latest = snap;
      this.snapshots.push({ snap, recvAt: now, serverTime });
      if (this.snapshots.length > 40) this.snapshots.shift();
      this.onSnapshot(snap);
      return;
    }
    if (!isJsonFrame(d)) return;
    const msg = decodeJson<S2C>(d);
    if (!msg) return;
    if (msg.t === 'welcome') { this.myId = msg.id; this.server = { ...this.server, ...msg.server }; this.tickRate = msg.tickRate; }
    else if (msg.t === 'players') { this.players = new Map(msg.list.map((p) => [p.id, p])); }
    else if (msg.t === 'pong') { const r = (performance.now() - msg.c) / 1000; this.rtt = this.rtt * 0.7 + r * 0.3; }
    else if (msg.t === 'changemap') { this.snapshots = []; this.latest = null; this.clockInit = false; }
    this.onJson(msg);
  }

  /** Two snapshots bracketing `t` (server seconds) plus the blend factor. */
  bracket(t: number): { a: TimedSnapshot; b: TimedSnapshot; k: number } | null {
    const s = this.snapshots;
    if (!s.length) return null;
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].serverTime <= t) {
        const a = s[i - 1], b = s[i];
        return { a, b, k: Math.min(1.5, (t - a.serverTime) / Math.max(1e-4, b.serverTime - a.serverTime)) };
      }
    }
    return { a: s[0], b: s[0], k: 0 };
  }

  close() {
    clearInterval(this.pingTimer);
    this.transport.close();
  }
}
