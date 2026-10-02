import { parseObject } from './props.js';
import type { UPackage, ExportEntry } from './upk.js';

// UE3 EPolyFlags subset.
const PF_INVISIBLE = 0x1;
const PF_NOT_SOLID = 0x8;
const PF_PORTAL = 0x04000000;

export interface ModelPolys {
  /** UE-space points (UU). */
  points: Float32Array;
  /** Convex polygons as point-index lists, split by how they should be used. */
  visibleSolid: number[][];
  visibleNonSolid: number[][];
  invisibleSolid: number[][];
}

/**
 * Parse a cooked UE3 (v805, TA) UModel: Bounds, bulk Vectors/Points/Nodes, Surfs (TTransArray: owner + array),
 * bulk Verts. Each BSP node with NumVertices > 0 carries one convex polygon.
 */
export function extractModel(pkg: UPackage, exp: ExportEntry): ModelPolys | null {
  const data = pkg.exportData(exp);
  const obj = parseObject(pkg, data);
  if (!obj) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = obj.end + 28; // FBoxSphereBounds
  const bulk = (es: number) => {
    if (o + 8 > data.length || v.getInt32(o, true) !== es) return null;
    const n = v.getInt32(o + 4, true);
    const start = o + 8;
    if (n < 0 || start + es * n > data.length) return null;
    o = start + es * n;
    return { start, n };
  };
  if (!bulk(12)) return null; // Vectors
  const pts = bulk(12);
  const nodes = pts && bulk(64);
  if (!pts || !nodes || !nodes.n) return null;

  // Surfs: optional owner ref, then count and 60-byte elements; confirm by the Verts header that follows.
  let surfStart = -1, nSurf = 0;
  for (const skip of [4, 0]) {
    const c = o + skip;
    if (c + 4 > data.length) continue;
    const n = v.getInt32(c, true);
    const after = c + 4 + n * 60;
    if (n >= 0 && after + 8 <= data.length && v.getInt32(after, true) === 24) { surfStart = c + 4; nSurf = n; o = after; break; }
  }
  if (surfStart < 0) return null;
  const verts = bulk(24);
  if (!verts) return null;

  const points = new Float32Array(pts.n * 3);
  for (let i = 0; i < pts.n * 3; i++) points[i] = v.getFloat32(pts.start + i * 4, true);

  const out: ModelPolys = { points, visibleSolid: [], visibleNonSolid: [], invisibleSolid: [] };
  for (let k = 0; k < nodes.n; k++) {
    const b = nodes.start + k * 64;
    const nv = data[b + 54];
    if (nv < 3) continue;
    const pool = v.getInt32(b + 16, true), iSurf = v.getInt32(b + 20, true);
    if (pool < 0 || pool + nv > verts.n) continue;
    const flags = iSurf >= 0 && iSurf < nSurf ? v.getUint32(surfStart + iSurf * 60 + 4, true) : 0;
    if (flags & PF_PORTAL) continue;
    const poly: number[] = [];
    for (let i = 0; i < nv; i++) {
      const p = v.getInt32(verts.start + (pool + i) * 24, true);
      if (p < 0 || p >= pts.n) { poly.length = 0; break; }
      poly.push(p);
    }
    if (poly.length < 3) continue;
    if (flags & PF_INVISIBLE) { if (!(flags & PF_NOT_SOLID)) out.invisibleSolid.push(poly); }
    else if (flags & PF_NOT_SOLID) out.visibleNonSolid.push(poly);
    else out.visibleSolid.push(poly);
  }
  return out;
}
