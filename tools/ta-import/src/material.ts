import { isRef, isRaw, parseObject, parseStruct, parseStructArray, type PropValue } from './props.js';
import type { ExportEntry, UPackage } from './upk.js';

export interface ObjRef { pkg: UPackage; exp: ExportEntry; index: number }

/** Resolves object references across cooked packages (exports directly, imports via the package index). */
export class Resolver {
  private exportCache = new Map<UPackage, Map<string, number>>();
  constructor(private idx: Map<string, string>, private load: (path: string) => UPackage) {}

  get(pkg: UPackage, ref: number): ObjRef | null {
    if (ref > 0) return pkg.exports[ref - 1] ? { pkg, exp: pkg.exports[ref - 1], index: ref } : null;
    if (ref === 0 || !pkg.imports[-ref - 1]) return null;
    const [pkgName, ...rest] = pkg.refPath(ref).split('.');
    const path = this.idx.get(pkgName.toLowerCase());
    if (!path) return null;
    const owner = this.load(path);
    let byPath = this.exportCache.get(owner);
    if (!byPath) {
      byPath = new Map();
      for (let i = 0; i < owner.exports.length; i++) byPath.set(owner.refPath(i + 1), i + 1);
      this.exportCache.set(owner, byPath);
    }
    const i = byPath.get(rest.join('.'));
    return i ? { pkg: owner, exp: owner.exports[i - 1], index: i } : null;
  }

  className(o: ObjRef): string { return o.pkg.className(o.exp); }
  props(o: ObjRef): Map<string, PropValue> | null { return parseObject(o.pkg, o.pkg.exportData(o.exp))?.props ?? null; }
}

const NOT_DIFFUSE = /(_|^)(n|nrm|norm|normal|s|spc|spec|specular|msk|mask|m|e|emi|emis|emissive|em|h|height|ao|rough|detail|noise|cube|env|refl|alpha|opacity)(_?\d*)$/i;
const DIFFUSE = /(_|^)(d|dif|diff|diffuse|c|col|color|colour|albedo|base|tex)(_?\d*)$/i;

function scoreTextureName(n: string): number {
  if (DIFFUSE.test(n)) return 3;
  if (NOT_DIFFUSE.test(n) || /normal|_nrm|spec|_spc|mask|_msk|emiss|_emi|cube|noise|detail/i.test(n)) return -5;
  return 1;
}

function scoreParam(p: string | undefined): number {
  if (!p) return 0;
  if (/mask|spec|norm|emis|rough|detail|noise|alpha|opac|glow|cube|refl/i.test(p)) return -5;
  if (/diff|albedo|base|colou?r|tex/i.test(p)) return 2;
  return 0;
}

const sampleScore = (s: Sample) => scoreTextureName(s.tex?.exp.objectName ?? 'x') + scoreParam(s.param);

/** Finds the texture feeding a material's diffuse (or emissive) input, honouring MIC parameter overrides. */
export function resolveDiffuse(r: Resolver, mat: ObjRef, depth = 0): ObjRef | null {
  if (depth > 6) return null;
  const cls = r.className(mat);
  const P = r.props(mat);
  if (!P) return null;
  if (cls === 'Texture2D') return mat;

  if (cls.startsWith('MaterialInstance')) {
    const overrides = new Map<string, ObjRef>();
    for (const el of parseStructArray(mat.pkg, P.get('TextureParameterValues'))) {
      const name = el.get('ParameterName'), val = el.get('ParameterValue');
      if (typeof name === 'string' && isRef(val)) {
        const t = r.get(mat.pkg, val.ref);
        if (t && r.className(t) === 'Texture2D') overrides.set(name, t);
      }
    }
    const parent = P.get('Parent');
    const base = isRef(parent) ? r.get(mat.pkg, parent.ref) : null;
    if (base) {
      const sample = findDiffuseSample(r, base, depth + 1);
      if (sample?.param && overrides.has(sample.param) && scoreTextureName(overrides.get(sample.param)!.exp.objectName) >= 0) return overrides.get(sample.param)!;
      if (sample?.tex && scoreTextureName(sample.tex.exp.objectName) >= 0) return sample.tex;
    }
    return bestByName([...overrides.values()]) ?? (base ? findDiffuseSample(r, base, depth + 1)?.tex ?? null : null);
  }

  if (cls === 'Material') return findDiffuseSample(r, mat, depth + 1)?.tex ?? null;
  return null;
}

interface Sample { tex: ObjRef | null; param?: string }

function findDiffuseSample(r: Resolver, mat: ObjRef, depth: number): Sample | null {
  if (depth > 6) return null;
  const cls = r.className(mat);
  if (cls.startsWith('MaterialInstance')) {
    const t = resolveDiffuse(r, mat, depth);
    return t ? { tex: t } : null;
  }
  if (cls !== 'Material') return null;
  const P = r.props(mat);
  if (!P) return null;
  for (const input of ['DiffuseColor', 'EmissiveColor']) {
    const s = parseStruct(mat.pkg, P.get(input));
    const ex = s?.get('Expression');
    if (!isRef(ex)) continue;
    const found = walkExpressions(r, mat.pkg, ex.ref);
    if (found) return found;
  }
  // Fallback: any texture sample owned by the material, best name first.
  const candidates: Sample[] = [];
  for (let i = 0; i < mat.pkg.exports.length; i++) {
    const e = mat.pkg.exports[i];
    if (e.outer !== mat.index || !/^MaterialExpressionTextureSample/.test(mat.pkg.className(e))) continue;
    const s = sampleOf(r, { pkg: mat.pkg, exp: e, index: i + 1 });
    if (s?.tex) candidates.push(s);
  }
  candidates.sort((a, b) => sampleScore(b) - sampleScore(a));
  return candidates[0] && sampleScore(candidates[0]) >= 0 ? candidates[0] : null;
}

function sampleOf(r: Resolver, ex: ObjRef): Sample | null {
  const P = r.props(ex);
  if (!P) return null;
  const t = P.get('Texture');
  const tex = isRef(t) ? r.get(ex.pkg, t.ref) : null;
  const param = P.get('ParameterName');
  return { tex: tex && r.className(tex) === 'Texture2D' ? tex : null, param: typeof param === 'string' ? param : undefined };
}

/** Breadth-first through expression inputs until a texture sample is found. */
/** Breadth-first through expression inputs, collecting texture samples; the most diffuse-looking one wins. */
function walkExpressions(r: Resolver, pkg: UPackage, start: number): Sample | null {
  const queue: { pkg: UPackage; ref: number }[] = [{ pkg, ref: start }];
  const seen = new Set<string>();
  const found: Sample[] = [];
  while (queue.length && seen.size < 64) {
    const q = queue.shift()!;
    const key = `${q.pkg.path}:${q.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = r.get(q.pkg, q.ref);
    if (!o) continue;
    const cls = r.className(o);
    if (cls === 'Material' || cls.startsWith('MaterialInstance')) continue;
    if (/^MaterialExpressionTextureSample/.test(cls)) {
      const s = sampleOf(r, o);
      if (s && (s.tex || s.param)) found.push(s);
      continue;
    }
    const P = r.props(o);
    if (!P) continue;
    for (const [, v] of P) {
      if (isRef(v)) { if (v.ref !== 0) queue.push({ pkg: o.pkg, ref: v.ref }); continue; }
      if (!isRaw(v)) continue;
      const s = parseStruct(o.pkg, v);
      const e = s?.get('Expression');
      if (isRef(e) && e.ref !== 0) queue.push({ pkg: o.pkg, ref: e.ref });
    }
  }
  found.sort((a, b) => sampleScore(b) - sampleScore(a));
  return found[0] && sampleScore(found[0]) >= 0 ? found[0] : null;
}

function bestByName(list: ObjRef[]): ObjRef | null {
  let best: ObjRef | null = null, bs = -Infinity;
  for (const t of list) {
    const s = scoreTextureName(t.exp.objectName);
    if (s > bs) { bs = s; best = t; }
  }
  return bs >= 0 ? best : null;
}
