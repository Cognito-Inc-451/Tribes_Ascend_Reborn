import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  buildCollisionWorld, decodeMapData, entitiesForMode, generateMap, LAYOUT_BY_ID, type CollisionWorld, type MapData, type ModeId,
} from '@ar/shared';

export interface LoadedMap {
  id: string;
  name: string;
  source: 'reborn' | 'original';
  data: MapData;
  world: CollisionWorld;
  blob?: Buffer;      // gzipped map blob served to clients for original maps
  file?: string;
  hash?: string;
}

export interface OriginalIndexEntry { id: string; name: string; mode: ModeId; file: string; bytes: number; hash: string }

export class MapLibrary {
  private index: OriginalIndexEntry[] = [];

  constructor(readonly originalDir: string) {
    const idx = join(originalDir, 'index.json');
    if (existsSync(idx)) this.index = JSON.parse(readFileSync(idx, 'utf8')) as OriginalIndexEntry[];
  }

  hasOriginal(id: string, mode: ModeId): boolean {
    return this.index.some((e) => e.id === id && e.mode === mode);
  }

  originals(): OriginalIndexEntry[] { return this.index; }

  load(id: string, mode: ModeId, source: 'reborn' | 'original'): LoadedMap {
    if (source === 'original') {
      const entry = this.index.find((e) => e.id === id && e.mode === mode);
      if (entry) {
        const blob = readFileSync(join(this.originalDir, entry.file));
        const data = decodeMapData(new Uint8Array(gunzipSync(blob)));
        const hash = createHash('sha256').update(blob).digest('hex').slice(0, 24);
        return { id, name: entry.name, source: 'original', data, world: buildCollisionWorld(data), blob, file: entry.file, hash };
      }
      console.warn(`[maps] original ${id}.${mode} not imported (run "npm run ta-import"); falling back to reborn layout`);
    }
    const spec = LAYOUT_BY_ID[id];
    if (!spec) throw new Error(`unknown map ${id}`);
    const data = generateMap(spec);
    data.entities = entitiesForMode(data, mode);
    return { id, name: spec.name, source: 'reborn', data, world: buildCollisionWorld(data) };
  }
}
