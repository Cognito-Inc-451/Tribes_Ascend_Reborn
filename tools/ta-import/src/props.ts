import { Reader, type UPackage } from './upk.js';

export interface Vec { x: number; y: number; z: number }
export interface Rot { pitch: number; yaw: number; roll: number }
export type PropValue = number | string | boolean | Vec | Rot | { ref: number } | { raw: Uint8Array };

export interface ParsedObject { props: Map<string, PropValue>; end: number }

const KNOWN_TYPES = new Set([
  'IntProperty', 'FloatProperty', 'BoolProperty', 'ByteProperty', 'NameProperty', 'StrProperty', 'ObjectProperty',
  'ComponentProperty', 'ClassProperty', 'StructProperty', 'ArrayProperty', 'MapProperty', 'InterfaceProperty', 'DelegateProperty',
]);

export function tryParse(pkg: UPackage, data: Uint8Array, start: number): ParsedObject | null {
  const r = new Reader(data, start);
  const props = new Map<string, PropValue>();
  for (let guard = 0; guard < 400; guard++) {
    if (r.remaining < 8) return null;
    const ni = r.i32(), nn = r.i32();
    if (ni < 0 || ni >= pkg.names.length) return null;
    const name = pkg.nameAt(ni, nn);
    if (pkg.names[ni].name === 'None') return { props, end: r.off };
    if (r.remaining < 16) return null;
    const ti = r.i32(); r.i32();
    if (ti < 0 || ti >= pkg.names.length) return null;
    const type = pkg.names[ti].name;
    if (!KNOWN_TYPES.has(type)) return null;
    const size = r.i32();
    const arrayIndex = r.i32();
    if (size < 0 || size > r.remaining) return null;
    const key = arrayIndex > 0 ? `${name}[${arrayIndex}]` : name;
    let structName = '';
    if (type === 'StructProperty') { const si = r.i32(); r.i32(); structName = pkg.names[si]?.name ?? ''; }
    if (type === 'BoolProperty') { props.set(key, pkg.version >= 673 ? r.u8() !== 0 : r.i32() !== 0); continue; }
    if (type === 'ByteProperty' && pkg.version >= 633) { r.i32(); r.i32(); }
    const valStart = r.off;
    switch (type) {
      case 'IntProperty': props.set(key, r.i32()); break;
      case 'FloatProperty': props.set(key, r.f32()); break;
      case 'ByteProperty': props.set(key, size === 1 ? r.u8() : pkg.nameAt(r.i32(), r.i32())); break;
      case 'NameProperty': props.set(key, pkg.nameAt(r.i32(), r.i32())); break;
      case 'ObjectProperty': case 'ComponentProperty': case 'ClassProperty': props.set(key, { ref: r.i32() }); break;
      case 'StrProperty': props.set(key, r.fstring()); break;
      case 'StructProperty':
        if ((structName === 'Vector' && size === 12)) props.set(key, { x: r.f32(), y: r.f32(), z: r.f32() });
        else if (structName === 'Rotator' && size === 12) props.set(key, { pitch: r.i32(), yaw: r.i32(), roll: r.i32() });
        else props.set(key, { raw: data.subarray(valStart, valStart + size) });
        break;
      default: props.set(key, { raw: data.subarray(valStart, valStart + size) });
    }
    r.off = valStart + size;
  }
  return null;
}

/** Parse tagged properties; the pre-property header varies (NetIndex, actor state frame, component templates), so probe offsets. */
export function parseObject(pkg: UPackage, data: Uint8Array): ParsedObject | null {
  for (const start of [4, 8, 12, 0, 16, 20]) {
    const p = tryParse(pkg, data, start);
    if (p && p.props.size > 0) return p;
  }
  for (let start = 1; start < 64; start++) {
    const p = tryParse(pkg, data, start);
    if (p && p.props.size > 0) return p;
  }
  return tryParse(pkg, data, 4);
}

export const isVec = (v: PropValue | undefined): v is Vec => typeof v === 'object' && v !== null && 'x' in v;
export const isRot = (v: PropValue | undefined): v is Rot => typeof v === 'object' && v !== null && 'yaw' in v;
export const isRef = (v: PropValue | undefined): v is { ref: number } => typeof v === 'object' && v !== null && 'ref' in v;
export const isRaw = (v: PropValue | undefined): v is { raw: Uint8Array } => typeof v === 'object' && v !== null && 'raw' in v;

/** Tagged properties of a struct value (e.g. ExpressionInput, ColorMaterialInput). */
export function parseStruct(pkg: UPackage, v: PropValue | undefined): Map<string, PropValue> | null {
  if (!isRaw(v)) return null;
  return tryParse(pkg, v.raw, 0)?.props ?? null;
}

/** Elements of an array-of-structs property: count, then tagged properties per element. */
export function parseStructArray(pkg: UPackage, v: PropValue | undefined): Map<string, PropValue>[] {
  if (!isRaw(v) || v.raw.length < 4) return [];
  const raw = v.raw;
  const n = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, true);
  const out: Map<string, PropValue>[] = [];
  let off = 4;
  for (let i = 0; i < n && i < 256; i++) {
    const p = tryParse(pkg, raw, off);
    if (!p) break;
    out.push(p.props);
    off = p.end;
  }
  return out;
}
