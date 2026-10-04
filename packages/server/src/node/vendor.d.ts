declare module 'bittorrent-dht' {
  import { EventEmitter } from 'node:events';
  export default class DHT extends EventEmitter {
    constructor(opts?: Record<string, unknown>);
    listen(port?: number, cb?: () => void): void;
    announce(infoHash: Buffer | string, port: number, cb?: (err?: Error) => void): void;
    lookup(infoHash: Buffer | string, cb?: (err?: Error, n?: number) => void): void;
    destroy(cb?: () => void): void;
    nodes: { toArray(): unknown[] };
  }
}

declare module '@silentbot1/nat-api' {
  export default class NatAPI {
    constructor(opts?: { enablePMP?: boolean; enableUPNP?: boolean; ttl?: number; description?: string; upnpPermanentFallback?: boolean });
    map(opts: number | { publicPort: number; privatePort: number; protocol?: 'TCP' | 'UDP' | null; ttl?: number; description?: string }): Promise<void>;
    unmap(port: number): Promise<void>;
    externalIp(): Promise<string>;
    destroy(): Promise<void>;
  }
}
