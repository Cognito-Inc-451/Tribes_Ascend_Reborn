import { Reassembler, type ServerInfo, type TransportKind } from '@ar/shared';

export interface ClientTransport {
  kind: TransportKind;
  sendReliable(data: Uint8Array): void;
  sendUnreliable(data: Uint8Array): void;
  onMessage: (data: Uint8Array) => void;
  onClose: (reason: string) => void;
  close(): void;
}

export const browserSupportsWebTransport = () => typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function';

/** Which transport this browser will use for a given server (shown in the server browser). */
export function expectedTransport(info: ServerInfo, pref: 'auto' | TransportKind): TransportKind {
  const wtOk = browserSupportsWebTransport() && info.transports.includes('webtransport') && !!info.wtUrl;
  if (pref === 'websocket' || !wtOk) return 'websocket';
  return 'webtransport';
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function connectWT(url: string, certHash: string | undefined, timeoutMs: number): Promise<ClientTransport> {
  type WTCtor = new (url: string, opts?: object) => {
    ready: Promise<void>; closed: Promise<unknown>; close(): void;
    datagrams: { readable: ReadableStream<Uint8Array>; writable?: WritableStream<Uint8Array>; createWritable?: () => WritableStream<Uint8Array> };
    createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  };
  const WT = (globalThis as unknown as { WebTransport: WTCtor }).WebTransport;
  const opts = certHash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(certHash) }] } : {};
  const wt = new WT(url, opts);
  await Promise.race([wt.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('WebTransport timeout')), timeoutMs))]);
  const stream = await wt.createBidirectionalStream();
  const sw = stream.writable.getWriter();
  const dw = (wt.datagrams.createWritable ? wt.datagrams.createWritable() : wt.datagrams.writable!).getWriter();
  const reasm = new Reassembler();
  let closed = false;

  const t: ClientTransport = {
    kind: 'webtransport',
    onMessage: () => {},
    onClose: () => {},
    sendReliable(data) {
      const f = new Uint8Array(data.length + 4);
      new DataView(f.buffer).setUint32(0, data.length, true);
      f.set(data, 4);
      sw.write(f).catch(() => {});
    },
    sendUnreliable(data) { dw.write(data).catch(() => {}); },
    close() { closed = true; try { wt.close(); } catch { /* noop */ } },
  };

  void (async () => {
    const r = wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        const msg = reasm.push(new Uint8Array(value));
        if (msg) t.onMessage(msg);
      }
    } catch { /* closed */ }
  })();
  void (async () => {
    const r = stream.readable.getReader();
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf); merged.set(value, buf.length);
        let off = 0;
        while (merged.length - off >= 4) {
          const len = new DataView(merged.buffer, off, 4).getUint32(0, true);
          if (merged.length - off - 4 < len) break;
          t.onMessage(merged.slice(off + 4, off + 4 + len));
          off += 4 + len;
        }
        buf = merged.slice(off);
      }
    } catch { /* closed */ }
    if (!closed) t.onClose('connection closed');
  })();
  wt.closed.then(() => { if (!closed) t.onClose('connection closed'); }, () => { if (!closed) t.onClose('connection lost'); });
  return t;
}

function connectWS(url: string, timeoutMs: number): Promise<ClientTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, timeoutMs);
    let closed = false;
    const t: ClientTransport = {
      kind: 'websocket',
      onMessage: () => {},
      onClose: () => {},
      sendReliable(data) { if (ws.readyState === ws.OPEN) ws.send(data); },
      sendUnreliable(data) { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 64 * 1024) ws.send(data); },
      close() { closed = true; ws.close(); },
    };
    ws.onopen = () => { clearTimeout(timer); resolve(t); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket error')); };
    ws.onmessage = (e) => t.onMessage(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => { if (!closed) t.onClose(e.reason || 'disconnected'); };
  });
}

export interface ConnectResult { transport: ClientTransport; fellBack: boolean; error?: string }

/** Prefer WebTransport (datagrams) and fall back to WebSocket automatically. */
export async function connect(info: ServerInfo, pref: 'auto' | TransportKind): Promise<ConnectResult> {
  const want = expectedTransport(info, pref);
  if (want === 'webtransport' && info.wtUrl) {
    try {
      return { transport: await connectWT(info.wtUrl, info.certHash, 2500), fellBack: false };
    } catch (e) {
      if (!info.wsUrl) throw e;
      return { transport: await connectWS(info.wsUrl, 5000), fellBack: true, error: (e as Error).message };
    }
  }
  if (!info.wsUrl) throw new Error('Server has no WebSocket endpoint');
  return { transport: await connectWS(info.wsUrl, 5000), fellBack: false };
}
