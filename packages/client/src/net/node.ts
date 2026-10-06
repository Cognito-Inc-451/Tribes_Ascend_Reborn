/// <reference types="vite/client" />
import type { ServerInfo } from '@ar/shared';

declare const __NODE_URL__: string;

/** This machine's node (serves the client build, imported assets and discovered servers). */
export const NODE_URL = (new URLSearchParams(location.search).get('node')
  ?? (import.meta.env.PROD ? location.origin : __NODE_URL__)).replace(/\/$/, '');

export type ServerOrigin = 'local' | 'lan' | 'internet' | 'master';
export interface BrowserServer extends ServerInfo { origin: ServerOrigin; nodeId?: string; host?: string }
export interface DiscoveryStats { lan: number; internet: number; upnp: boolean; publicIp: string | null; dht: boolean }

export async function fetchPeers(): Promise<{ servers: BrowserServer[]; stats: DiscoveryStats | null; nodeOk: boolean }> {
  try {
    const r = await fetch(`${NODE_URL}/peers`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { servers: [], stats: null, nodeOk: false };
    const j = (await r.json()) as { servers: BrowserServer[]; discovery: DiscoveryStats };
    return { servers: j.servers ?? [], stats: j.discovery ?? null, nodeOk: true };
  } catch {
    return { servers: [], stats: null, nodeOk: false };
  }
}

/** A game running on this PC, from the node's point of view. */
export interface HostedGame { id: string; name: string; humans: number; port: number }

/** Games hosted from this PC right now (empty list when the node is unreachable). */
export async function fetchHosted(): Promise<HostedGame[]> {
  try {
    const r = await fetch(`${NODE_URL}/hosted`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    const j = (await r.json()) as { games?: HostedGame[] };
    return j.games ?? [];
  } catch {
    return [];
  }
}

/** Ask the node to shut a hosted game down; returns an error message, or '' on success. */
export async function closeHosted(id: string): Promise<string> {
  try {
    const r = await fetch(`${NODE_URL}/hosted-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(10000) });
    const res = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? '' : (res.error ?? `HTTP ${r.status}`);
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

export interface VoiceManifest { packs: { id: string; name: string; lines: string[] }[]; announcer: string[]; music?: string[]; sfx?: Record<string, number> }
let manifest: Promise<VoiceManifest | null> | null = null;
export function voiceManifest(): Promise<VoiceManifest | null> {
  manifest ??= fetch(`${NODE_URL}/assets/voices/manifest.json`, { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? (r.json() as Promise<VoiceManifest>) : null)).catch(() => null);
  return manifest;
}

/** Asset base URLs to try in order: this machine first (own import), then the host we are playing on. */
export function assetBases(server?: ServerInfo | null): string[] {
  const out = [NODE_URL];
  if (server?.assetsUrl && server.assetsUrl.replace(/\/$/, '') !== NODE_URL) out.push(server.assetsUrl.replace(/\/$/, ''));
  return out;
}
