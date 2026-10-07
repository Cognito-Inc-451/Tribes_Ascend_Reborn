import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Connection } from './types.js';

class WsConnection implements Connection {
  readonly kind = 'websocket' as const;
  onMessage: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private isAlive = true;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(private ws: WebSocket, readonly remote: string) {
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, isBinary) => {
      const buf = isBinary ? new Uint8Array(data as Buffer) : new TextEncoder().encode(data.toString());
      this.onMessage(buf);
    });
    ws.on('pong', () => { this.isAlive = true; });
    ws.on('close', () => this.cleanup());
    ws.on('error', () => ws.terminate());
    // Detect half-open sockets (NAT drops, laptop sleep) so the player slot is freed promptly.
    this.keepalive = setInterval(() => {
      if (!this.isAlive) { ws.terminate(); return; }
      this.isAlive = false;
      try { ws.ping(); } catch { this.cleanup(); }
    }, 15000);
  }

  private cleanup() {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
    this.onClose();
  }

  sendReliable(data: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data, { binary: true });
  }

  sendUnreliable(data: Uint8Array): void {
    // Drop unreliable traffic when the socket is backed up instead of queueing stale snapshots.
    if (this.ws.bufferedAmount < 256 * 1024) this.sendReliable(data);
  }

  close(reason?: string): void { this.cleanup(); this.ws.close(1000, reason?.slice(0, 120)); }
  backlog(): number { return this.ws.bufferedAmount; }
}

export function startWsServer(port: number, http: (req: IncomingMessage, res: ServerResponse) => void, onConn: (c: Connection) => void): Server {
  const server = createServer(http);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (ws, req) => onConn(new WsConnection(ws, req.socket.remoteAddress ?? '?')));
  server.listen(port);
  return server;
}
