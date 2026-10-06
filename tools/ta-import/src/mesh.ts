import { parseObject } from './props.js';
import type { UPackage, ExportEntry } from './upk.js';

export interface MeshSection { material: number; firstIndex: number; numTriangles: number }
export interface MeshData {
  name: string; positions: Float32Array; indices: Uint32Array; bounds: { origin: number[]; extent: number[] };
  /** UV set 0; `uvSets` holds every set (lightmap UVs are usually set 1). */
  uvs: Float32Array | null; uvSets: Float32Array[]; sections: MeshSection[];
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * LOD0 Elements sit right before the position buffer as: element count, then each element
 * (Material, 3 bools, FirstIndex, NumTriangles, MinVertex, MaxVertex, MaterialIndex, Fragments[], u8).
 * Only the count header precedes the whole chain, so the chain is recovered from its tail: the last
 * element ends at `end`, and walking back over records of size 40 + Fragments*8 + 1 stops when the int32
 * before a record equals the elements collected so far - that int32 is the chain's count header.
 * Scanning forward from a guessed offset only ever finds a tail slice, which is why roofs/bridges lost geometry.
 */
function findSections(view: DataView, end: number, nIdx: number): MeshSection[] {
  const valid = (p: number) => {
    if (p < 4 || p + 41 > end) return null;
    const mat = view.getInt32(p, true);
    const b1 = view.getInt32(p + 4, true), b2 = view.getInt32(p + 8, true), b3 = view.getInt32(p + 12, true);
    const first = view.getInt32(p + 16, true), tris = view.getInt32(p + 20, true);
    const frags = view.getInt32(p + 36, true);
    if (b1 > 1 || b2 > 1 || b3 > 1 || b1 < 0 || b2 < 0 || b3 < 0 || first < 0 || tris < 0 || first + tris * 3 > nIdx || frags < 0 || frags > 64) return null;
    return { section: { material: mat, firstIndex: first, numTriangles: tris }, size: 40 + frags * 8 + 1 };
  };
  // Reachable[k] = offsets where a run of exactly k valid elements (ending at `end`) can start.
  const reachable: number[][] = [[end]];
  for (let k = 1; k <= 256; k++) {
    const prev = reachable[k - 1];
    if (!prev.length) break;
    const next = new Set<number>();
    for (const pos of prev) {
      for (let s = 41; s <= 41 + 64 * 8; s += 8) {
        const el = valid(pos - s);
        if (el && el.size === s) next.add(pos - s);
      }
    }
    reachable[k] = [...next];
    if (!next.size) break;
  }
  // The chain is complete when the int32 before its start equals the element count; prefer the longest.
  for (let k = reachable.length - 1; k >= 1; k--) {
    const start = reachable[k].find((p) => p >= 4 && view.getInt32(p - 4, true) === k);
    if (start === undefined) continue;
    const out: MeshSection[] = [];
    let pos = end;
    for (let i = 0; i < k; i++) {
      let found = false;
      for (let s = 41; s <= 41 + 64 * 8; s += 8) {
        const el = valid(pos - s);
        if (el && el.size === s) { out.unshift(el.section); pos -= s; found = true; break; }
      }
      if (!found) break;
    }
    if (out.length === k && pos === start) return out;
  }
  return [];
}

/**
 * Extracts LOD0 geometry from a cooked UE3 StaticMesh by locating the position vertex buffer
 * (stride=12, N, elemSize=12, N), the UV vertex buffer after it and the following 16-bit index buffer (elemSize=2, M).
 */
export function extractStaticMesh(pkg: UPackage, e: ExportEntry): MeshData | null {
  const data = pkg.exportData(e);
  const obj = parseObject(pkg, data);
  if (!obj) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const b = obj.end;
  if (b + 28 > data.length) return null;
  const origin = [view.getFloat32(b, true), view.getFloat32(b + 4, true), view.getFloat32(b + 8, true)];
  const extent = [view.getFloat32(b + 12, true), view.getFloat32(b + 16, true), view.getFloat32(b + 20, true)];
  const lim = Math.max(...extent.map(Math.abs)) * 2 + Math.max(...origin.map(Math.abs)) + 16;

  let posOff = -1, n = 0;
  for (let o = b + 28; o + 16 < data.length; o += 1) {
    if (view.getInt32(o, true) !== 12) continue;
    const cnt = view.getInt32(o + 4, true);
    if (cnt < 3 || cnt > 400000) continue;
    if (view.getInt32(o + 8, true) !== 12 || view.getInt32(o + 12, true) !== cnt) continue;
    const start = o + 16;
    if (start + cnt * 12 > data.length) continue;
    let ok = true;
    for (let i = 0; i < Math.min(cnt * 3, 60); i++) {
      const v = view.getFloat32(start + i * 4, true);
      if (!Number.isFinite(v) || Math.abs(v) > lim) { ok = false; break; }
    }
    if (!ok) continue;
    posOff = start; n = cnt;
    break;
  }
  if (posOff < 0) return null;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) positions[i] = view.getFloat32(posOff + i * 4, true);

  // Vertex buffer: NumTexCoords, Stride, NumVertices, bUseFullPrecisionUVs, then bulk (elemSize, count).
  let uvs: Float32Array | null = null;
  const uvSets: Float32Array[] = [];
  const vb = posOff + n * 12;
  if (vb + 24 <= data.length) {
    const nTex = view.getInt32(vb, true), stride = view.getInt32(vb + 4, true), nv = view.getInt32(vb + 8, true), full = view.getInt32(vb + 12, true);
    const es = view.getInt32(vb + 16, true), cnt = view.getInt32(vb + 20, true);
    const uvBytes = full ? 8 : 4;
    if (nTex >= 1 && nTex <= 8 && nv === n && cnt === n && es === stride && stride >= 8 + nTex * uvBytes && vb + 24 + es * cnt <= data.length) {
      for (let s = 0; s < nTex; s++) {
        const set = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          const o = vb + 24 + i * es + (stride - nTex * uvBytes) + s * uvBytes;
          set[i * 2] = full ? view.getFloat32(o, true) : halfToFloat(view.getUint16(o, true));
          set[i * 2 + 1] = full ? view.getFloat32(o + 4, true) : halfToFloat(view.getUint16(o + 2, true));
        }
        for (let i = 0; i < set.length; i++) if (!Number.isFinite(set[i])) set[i] = 0;
        uvSets.push(set);
      }
      uvs = uvSets[0];
    }
  }

  let idxOff = -1, m = 0;
  for (let o = posOff + n * 12; o + 8 < data.length; o += 1) {
    if (view.getInt32(o, true) !== 2) continue;
    const cnt = view.getInt32(o + 4, true);
    if (cnt < 3 || cnt % 3 !== 0 || cnt > 3000000) continue;
    const start = o + 8;
    if (start + cnt * 2 > data.length) continue;
    let ok = true;
    for (let i = 0; i < Math.min(cnt, 300); i++) if (view.getUint16(start + i * 2, true) >= n) { ok = false; break; }
    if (!ok) continue;
    idxOff = start; m = cnt;
    break;
  }
  if (idxOff < 0) return null;
  const indices = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    const v = view.getUint16(idxOff + i * 2, true);
    if (v >= n) return null;
    indices[i] = v;
  }
  return { name: e.objectName, positions, indices, bounds: { origin, extent }, uvs, uvSets, sections: findSections(view, posOff - 16, m) };
}
