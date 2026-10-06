import { readFileSync } from 'node:fs';
import { MODE_IDS, type GameOptions, type ModeId } from '@ar/shared';

export type BotDifficulty = 'recruit' | 'adept' | 'veteran' | 'elite' | 'godlike';

export interface ServerConfig {
  id: string;
  name: string;
  mode: ModeId;
  mapSource: 'reborn' | 'original';
  maps: string[];
  port: number;
  wtPort?: number;
  maxPlayers: number;
  bots: { fillTo: number; difficulty: BotDifficulty };
  password?: string;
  skillsMaxed?: boolean;
  region?: string;
  options?: GameOptions;
}

export interface RootConfig {
  master?: string;
  publicHost: string;
  certFile?: string;
  keyFile?: string;
  /** Local node: serves the client + assets and discovers other players' nodes (LAN multicast, BitTorrent DHT). */
  node?: { port?: number; name?: string; lan?: boolean; internet?: boolean; upnp?: boolean; clientOnly?: boolean; relay?: boolean };
  servers: ServerConfig[];
}

export function loadConfig(path: string): RootConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RootConfig;
  if (!Array.isArray(raw.servers) || raw.servers.length === 0) throw new Error('config: no servers');
  for (const s of raw.servers) {
    if (!MODE_IDS.includes(s.mode)) throw new Error(`config: server ${s.id} has unknown mode ${s.mode}`);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`config: server ${s.id} bad port`);
    s.maxPlayers = Math.max(2, Math.min(32, s.maxPlayers ?? 24));
    s.bots ??= { fillTo: 0, difficulty: 'recruit' };
    s.bots.fillTo = Math.max(0, Math.min(s.maxPlayers, s.bots.fillTo));
    s.skillsMaxed ??= true;
  }
  return raw;
}
