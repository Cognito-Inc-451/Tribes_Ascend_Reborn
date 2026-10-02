import { parseObject } from './props.js';
import { Reader, type ExportEntry, type UPackage } from './upk.js';

export interface SkelBone { name: string; parent: number; rot: [number, number, number, number]; pos: [number, number, number] }
export interface SkelSection { material: number; firstIndex: number; numTriangles: number }
export interface SkelMeshData {
  name: string;
  bones: SkelBone[];
  materials: number[];
  positions: Float32Array; // UE units, UE axes
  uvs: Float32Array;
  skinIndex: Uint16Array;  // 4 global bone indices per vertex
  skinWeight: Uint8Array;  // 4 weights per vertex (sum 255)
  indices: Uint32Array;
  sections: SkelSection[];
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return 0;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

const fail = (why: string): never => { throw new Error(why); };

/** Parses LOD0 of a cooked UE3 (file version 805) USkeletalMesh: reference skeleton, GPU-skin vertices and indices. */
export function extractSkeletalMesh(pkg: UPackage, e: ExportEntry): SkelMeshData {
  const data = pkg.exportData(e);
  const obj = parseObject(pkg, data);
  if (!obj) fail('properties');
  const r = new Reader(data, obj!.end);
  r.skip(28); // FBoxSphereBounds
  const nMat = r.i32();
  if (nMat < 0 || nMat > 64) fail(`materials ${nMat}`);
  const materials: number[] = [];
  for (let i = 0; i < nMat; i++) materials.push(r.i32());
  r.skip(24); // MeshOrigin, RotOrigin
  const nBones = r.i32();
  if (nBones < 1 || nBones > 1024) fail(`bones ${nBones}`);
  const bones: SkelBone[] = [];
  for (let i = 0; i < nBones; i++) {
    const name = pkg.nameAt(r.i32(), r.i32());
    r.u32(); // flags
    const rot: [number, number, number, number] = [r.f32(), r.f32(), r.f32(), r.f32()];
    const pos: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    r.i32(); // NumChildren
    const parent = r.i32();
    r.u32(); // BoneColor
    if (i > 0 && (parent < 0 || parent >= i)) fail(`bone ${i} parent ${parent}`);
    bones.push({ name, parent: i === 0 ? -1 : parent, rot, pos });
  }
  r.i32(); // SkeletalDepth
  const nLod = r.i32();
  if (nLod < 1 || nLod > 8) fail(`lods ${nLod}`);

  const nSec = r.i32();
  if (nSec < 1 || nSec > 64) fail(`sections ${nSec}`);
  const sections: SkelSection[] = [];
  for (let i = 0; i < nSec; i++) {
    const material = r.u16(); r.u16(); // MaterialIndex, ChunkIndex
    const firstIndex = r.i32();
    const numTriangles = r.u16();
    r.u8(); // TriangleSorting
    sections.push({ material, firstIndex, numTriangles });
  }
  const idxSize = r.i32(), nIdx = r.i32();
  if (idxSize !== 2 || nIdx < 3 || nIdx > 3_000_000) fail(`index buffer ${idxSize}x${nIdx}`);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = r.u16();

  r.skip(r.i32() * 2); // ActiveBoneIndices
  const nChunk = r.i32();
  if (nChunk < 1 || nChunk > 64) fail(`chunks ${nChunk}`);
  const chunks: { first: number; count: number; bones: number[] }[] = [];
  for (let i = 0; i < nChunk; i++) {
    const first = r.i32();
    r.skip(r.i32() * 61); // RigidVertices (stripped when cooked)
    r.skip(r.i32() * 68); // SoftVertices
    const nb = r.i32();
    const map: number[] = [];
    for (let k = 0; k < nb; k++) map.push(r.u16());
    const nRigid = r.i32(), nSoft = r.i32();
    r.i32(); // MaxBoneInfluences
    chunks.push({ first, count: nRigid + nSoft, bones: map });
  }
  r.i32(); // Size
  const nVerts = r.i32();
  r.skip(r.i32()); // RequiredBones
  const bulkFlags = r.u32(); r.i32(); const bulkSize = r.i32(); r.i32();
  if (!(bulkFlags & 1) && bulkSize > 0) r.skip(bulkSize); // RawPointIndices
  r.i32(); // NumTexCoords
  const nUV = r.i32(), fullUV = r.i32();
  r.i32(); // bUsePackedPosition: set by the cooker but ignored on PC (stride below proves full floats)
  r.skip(24); // MeshExtension, MeshOrigin
  const stride = r.i32(), count = r.i32();
  const want = 28 + nUV * (fullUV ? 8 : 4);
  if (stride !== want || count !== nVerts) fail(`vertex buffer stride ${stride} (want ${want}) count ${count}/${nVerts}`);

  const positions = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  const skinIndex = new Uint16Array(count * 4), skinWeight = new Uint8Array(count * 4);
  const vertChunk = new Int16Array(count).fill(-1);
  chunks.forEach((c, ci) => { for (let v = c.first; v < c.first + c.count && v < count; v++) vertChunk[v] = ci; });
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let v = 0; v < count; v++) {
    const o = r.off + v * stride;
    const map = chunks[Math.max(0, vertChunk[v])].bones;
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = map[data[o + 8 + k]] ?? 0;
      skinWeight[v * 4 + k] = data[o + 12 + k];
    }
    positions[v * 3] = view.getFloat32(o + 16, true);
    positions[v * 3 + 1] = view.getFloat32(o + 20, true);
    positions[v * 3 + 2] = view.getFloat32(o + 24, true);
    uvs[v * 2] = fullUV ? view.getFloat32(o + 28, true) : halfToFloat(view.getUint16(o + 28, true));
    uvs[v * 2 + 1] = fullUV ? view.getFloat32(o + 32, true) : halfToFloat(view.getUint16(o + 30, true));
  }
  for (const i of indices) if (i >= count) fail('index out of range');
  return { name: e.objectName, bones, materials, positions, uvs, skinIndex, skinWeight, indices, sections };
}
