import { addBaseFieldBlockers, decodeMapData, entitiesForMode, generateMap, LAYOUT_BY_ID, MODES, type MapData, type MapRef, type ModeId } from '@ar/shared';
import { NODE_URL } from '../net/node.js';

const DB = 'ascend-reborn-maps';

async function sha24(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/** Players who imported the same original map locally skip the download (only if byte-identical to the host's). */
async function fromLocalNode(ref: MapRef): Promise<ArrayBuffer | null> {
  if (!ref.file || !ref.hash) return null;
  try {
    const r = await fetch(`${NODE_URL}/map/${ref.file}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return (await sha24(buf)) === ref.hash ? buf : null;
  } catch { return null; }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('maps');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction('maps').objectStore('maps').get(key);
      r.onsuccess = () => resolve((r.result as ArrayBuffer) ?? null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function cachePut(key: string, data: ArrayBuffer) {
  try {
    const db = await openDb();
    db.transaction('maps', 'readwrite').objectStore('maps').put(data, key);
  } catch { /* storage unavailable */ }
}

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/** Server-hosted original maps are downloaded from the game server (HTTP) and cached by hash. */
export async function loadMap(ref: MapRef, mode: ModeId, serverHttp: string, onProgress: (f: number, label: string) => void): Promise<MapData> {
  if (ref.source === 'reborn') {
    onProgress(0.3, 'Generating terrain');
    await new Promise((r) => setTimeout(r, 16));
    const spec = LAYOUT_BY_ID[ref.id];
    if (!spec) throw new Error(`Unknown map layout ${ref.id}`);
    const map = generateMap(spec);
    map.entities = entitiesForMode(map, mode);
    return map;
  }
  const key = `${ref.id}.${mode}.${ref.hash}`;
  let gz = await cacheGet(key);
  if (!gz) {
    onProgress(0.05, 'Checking local install');
    gz = await fromLocalNode(ref);
  }
  if (!gz) {
    const res = await fetch(`${serverHttp}/map/${ref.file}`);
    if (!res.ok || !res.body) throw new Error(`Map download failed (${res.status})`);
    const total = ref.bytes ?? (Number(res.headers.get('content-length')) || 1);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(0.9, got / total), `Downloading map ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    gz = buf.buffer;
    void cachePut(key, gz);
  }
  onProgress(0.95, 'Unpacking map');
  const map = decodeMapData(await gunzip(gz));
  if (MODES[mode].usesBases) addBaseFieldBlockers(map);
  return map;
}
