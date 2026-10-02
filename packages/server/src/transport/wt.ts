import { randomBytes } from 'node:crypto';
import { FrameDecoder, frame, type Connection } from './types.js';

type AnySession = {
  ready: Promise<void>;
  closed: Promise<unknown>;
  close(info?: { closeCode?: number; reason?: string }): void;
  datagrams: { readable: ReadableStream<Uint8Array>; createWritable?: () => WritableStream<Uint8Array>; writable?: WritableStream<Uint8Array> };
  incomingBidirectionalStreams: ReadableStream<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  peerAddress?: string;
};

class WtConnection implements Connection {
  readonly kind = 'webtransport' as const;
  onMessage: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private streamWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pendingReliable: Uint8Array[] = [];
  private backlogBytes = 0;
  private closed = false;

  constructor(private session: AnySession, readonly remote: string) {
    const w = session.datagrams.createWritable ? session.datagrams.createWritable() : session.datagrams.writable;
    this.dgWriter = w ? w.getWriter() : null;
    void this.readDatagrams();
    void this.acceptStreams();
    session.closed.then(() => this.finish(), () => this.finish());
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private async readDatagrams() {
    const reader = this.session.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.onMessage(new Uint8Array(value));
      }
    } catch { /* session closed */ }
  }

  private async acceptStreams() {
    const reader = this.session.incomingBidirectionalStreams.getReader();
    try {
      const { value: stream } = await reader.read();
      if (!stream) return;
      this.streamWriter = stream.writable.getWriter();
      for (const p of this.pendingReliable) void this.writeReliable(p);
      this.pendingReliable = [];
      const dec = new FrameDecoder();
      const sr = stream.readable.getReader();
      for (;;) {
        const { value, done } = await sr.read();
        if (done) break;
        if (value && !dec.push(new Uint8Array(value), (f) => this.onMessage(f), 256 * 1024)) { this.close('frame too large'); break; }
      }
    } catch { /* closed */ }
    this.finish();
  }

  private async writeReliable(data: Uint8Array) {
    if (!this.streamWriter) return;
    const f = frame(data);
    this.backlogBytes += f.length;
    try { await this.streamWriter.write(f); } catch { /* closed */ }
    this.backlogBytes -= f.length;
  }

  sendReliable(data: Uint8Array): void {
    if (this.closed) return;
    if (!this.streamWriter) this.pendingReliable.push(data);
    else void this.writeReliable(data);
  }

  sendUnreliable(data: Uint8Array): void {
    if (this.closed || !this.dgWriter) return;
    this.dgWriter.write(data).catch(() => {});
  }

  close(reason?: string): void {
    try { this.session.close({ closeCode: 0, reason: reason?.slice(0, 100) }); } catch { /* ignore */ }
    this.finish();
  }

  backlog(): number { return this.backlogBytes; }
}

export interface WtHandle { stop(): void }

/** Starts an HTTP/3 WebTransport listener at `https://host:port/game`. Returns null if the native module is unavailable. */
export async function startWtServer(port: number, cert: string, key: string, onConn: (c: Connection) => void, log: (s: string) => void): Promise<WtHandle | null> {
  let mod: { Http3Server: new (args: object) => { startServer(): void; stopServer(): void; ready: Promise<unknown>; sessionStream(path: string): ReadableStream<AnySession> } };
  try {
    const modName = '@fails-components/webtransport';
    mod = (await import(modName)) as typeof mod;
  } catch (e) {
    log(`WebTransport unavailable (${(e as Error).message}); WebSocket only.`);
    return null;
  }
  let server: InstanceType<typeof mod.Http3Server>;
  try {
    server = new mod.Http3Server({ port, host: '0.0.0.0', secret: randomBytes(16).toString('hex'), cert, privKey: key, defaultDatagramsReadableMode: 'bytes' });
    server.startServer();
    const ok = await Promise.race([server.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
    if (!ok) { log(`WebTransport listener on UDP ${port} did not start; WebSocket only.`); try { server.stopServer(); } catch { /* ignore */ } return null; }
  } catch (e) {
    log(`WebTransport failed to start (${(e as Error).message}); WebSocket only.`);
    return null;
  }
  void (async () => {
    const reader = server.sessionStream('/game').getReader();
    for (;;) {
      const { value: session, done } = await reader.read();
      if (done) break;
      if (!session) continue;
      session.ready.then(() => onConn(new WtConnection(session, session.peerAddress ?? '?')), () => {});
    }
  })();
  return { stop: () => server.stopServer() };
}
