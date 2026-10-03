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
  // Wear/overlay layers multiply over the real diffuse (TA's base metals: DIF_Overlay2 x DIF1); last resort only.
  if (/overlay|detail|grunge|scratch/i.test(n) && !/normal|_nrm|mask|_msk/i.test(n)) return 0;
  if (DIFFUSE.test(n)) return 3;
  if (NOT_DIFFUSE.test(n) || /normal|_nrm|spec|_spc|mask|_msk|emiss|_emi|cube|noise|detail/i.test(n)) return -5;
  return 1;
}

function scoreParam(p: string | undefined): number {
  if (!p) return 0;
  if (/overlay|detail|grunge|dirt|wear/i.test(p)) return -3;
  if (/mask|spec|norm|emis|rough|detail|noise|alpha|opac|glow|cube|refl/i.test(p)) return -5;
  if (/diff|dif\d|^dif|albedo|base|colou?r|tex/i.test(p)) return 2;
  return 0;
}

const sampleScore = (s: Sample) => scoreTextureName(s.tex?.exp.objectName ?? 'x') + scoreParam(s.param);

/** Texture parameter overrides along a MIC chain (the most derived instance wins), and the base Material. */
function micChain(r: Resolver, mat: ObjRef): { overrides: Map<string, ObjRef>; base: ObjRef | null } {
  const overrides = new Map<string, ObjRef>();
  let cur: ObjRef | null = mat;
  for (let d = 0; d < 8 && cur; d++) {
    const cls = r.className(cur);
    if (cls === 'Material') return { overrides, base: cur };
    if (!cls.startsWith('MaterialInstance')) break;
    const P = r.props(cur);
    if (!P) break;
    for (const el of parseStructArray(cur.pkg, P.get('TextureParameterValues'))) {
      const name = el.get('ParameterName'), val = el.get('ParameterValue');
      if (typeof name !== 'string' || !isRef(val) || overrides.has(name)) continue;
      const t = r.get(cur.pkg, val.ref);
      if (t && r.className(t) === 'Texture2D') overrides.set(name, t);
    }
    const parent = P.get('Parent');
    cur = isRef(parent) ? r.get(cur.pkg, parent.ref) : null;
  }
  return { overrides, base: null };
}

/** Finds the texture feeding a material's diffuse (or emissive) input, honouring MIC parameter overrides. */
export function resolveDiffuse(r: Resolver, mat: ObjRef, depth = 0): ObjRef | null {
  if (depth > 6) return null;
  const cls = r.className(mat);
  const P = r.props(mat);
  if (!P) return null;
  if (cls === 'Texture2D') return mat;

  if (cls.startsWith('MaterialInstance')) {
    const { overrides, base } = micChain(r, mat);
    if (base) {
      // Every sample of the base material's diffuse (then emissive) graph, with the instance's textures swapped in.
      const BP = r.props(base);
      for (const input of ['DiffuseColor', 'EmissiveColor']) {
        const ex = parseStruct(base.pkg, BP?.get(input))?.get('Expression');
        if (!isRef(ex)) continue;
        const found = samplesFrom(r, base.pkg, ex.ref).map((s) => ({ tex: (s.param && overrides.get(s.param)) || s.tex, param: s.param }));
        found.sort((a, b) => sampleScore(b) - sampleScore(a));
        if (found[0]?.tex && sampleScore(found[0]) >= 0) return found[0].tex;
      }
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

const NORMAL_NAME = /(_|^)(n|nrm|norm|normal|nm)(_?\d*)$|normal|_nrm/i;
const NORMAL_PARAM = /norm|nrm/i;

/** Every texture sample reachable from one material input (breadth-first, unscored). */
function samplesFrom(r: Resolver, pkg: UPackage, start: number): Sample[] {
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
    if (/^MaterialExpressionTextureSample/.test(cls)) { const s = sampleOf(r, o); if (s && (s.tex || s.param)) found.push(s); continue; }
    const P = r.props(o);
    if (!P) continue;
    for (const [, v] of P) {
      if (isRef(v)) { if (v.ref !== 0) queue.push({ pkg: o.pkg, ref: v.ref }); continue; }
      if (!isRaw(v)) continue;
      const e = parseStruct(o.pkg, v)?.get('Expression');
      if (isRef(e) && e.ref !== 0) queue.push({ pkg: o.pkg, ref: e.ref });
    }
  }
  return found;
}

/** The sample feeding a base Material's Normal input (normal-looking names first). */
function normalSample(r: Resolver, mat: ObjRef, depth: number): Sample | null {
  if (depth > 6) return null;
  const cls = r.className(mat);
  const P = r.props(mat);
  if (!P) return null;
  if (cls.startsWith('MaterialInstance')) {
    const parent = P.get('Parent');
    const base = isRef(parent) ? r.get(mat.pkg, parent.ref) : null;
    return base ? normalSample(r, base, depth + 1) : null;
  }
  if (cls !== 'Material') return null;
  const ex = parseStruct(mat.pkg, P.get('Normal'))?.get('Expression');
  if (!isRef(ex)) return null;
  const found = samplesFrom(r, mat.pkg, ex.ref);
  const named = found.find((s) => (s.tex && NORMAL_NAME.test(s.tex.exp.objectName)) || (s.param && NORMAL_PARAM.test(s.param)));
  return named ?? found[0] ?? null;
}

/** Normal map of a material (MIC overrides honoured), or null. */
export function resolveNormal(r: Resolver, mat: ObjRef, depth = 0): ObjRef | null {
  if (depth > 6) return null;
  const cls = r.className(mat);
  const P = r.props(mat);
  if (!P) return null;
  if (cls.startsWith('MaterialInstance')) {
    const overrides = new Map<string, ObjRef>();
    for (const el of parseStructArray(mat.pkg, P.get('TextureParameterValues'))) {
      const name = el.get('ParameterName'), val = el.get('ParameterValue');
      if (typeof name === 'string' && isRef(val)) {
        const t = r.get(mat.pkg, val.ref);
        if (t && r.className(t) === 'Texture2D') overrides.set(name, t);
      }
    }
    const s = normalSample(r, mat, depth + 1);
    if (s?.param && overrides.has(s.param)) return overrides.get(s.param)!;
    for (const [name, t] of overrides) if (NORMAL_PARAM.test(name) || NORMAL_NAME.test(t.exp.objectName)) return t;
    if (s?.tex) return s.tex;
    const parent = P.get('Parent');
    const base = isRef(parent) ? r.get(mat.pkg, parent.ref) : null;
    return base ? resolveNormal(r, base, depth + 1) : null;
  }
  if (cls === 'Material') return normalSample(r, mat, depth + 1)?.tex ?? null;
  return null;
}

const SPEC_NAME = /(_|^)(s|spc|spec|specular)(_?\d*)$|_spc|_spec/i;

/** Specular map of a material: the sample feeding the base Material's SpecularColor, with MIC overrides swapped in. */
export function resolveSpecular(r: Resolver, mat: ObjRef): ObjRef | null {
  const { overrides, base } = micChain(r, mat);
  if (!base) return null;
  const ex = parseStruct(base.pkg, r.props(base)?.get('SpecularColor'))?.get('Expression');
  if (!isRef(ex)) return null;
  const found = samplesFrom(r, base.pkg, ex.ref).map((s) => ({ tex: (s.param && overrides.get(s.param)) || s.tex, param: s.param }));
  const pick = found.find((s) => s.tex && (SPEC_NAME.test(s.tex.exp.objectName) || /spec|spc/i.test(s.param ?? ''))) ?? found[0];
  // Flat white/black masks carry no detail.
  if (!pick?.tex || /white|black|grey|gray/i.test(pick.tex.exp.objectName)) return null;
  return pick.tex;
}

/** Liquids the client draws with its own shaders: TA's lava and water materials are unlit/translucent panners. */
export function materialFx(r: Resolver, mat: ObjRef): 'lava' | 'water' | undefined {
  let cur: ObjRef | null = mat;
  for (let d = 0; d < 6 && cur; d++) {
    const n = cur.exp.objectName;
    if (/lava|magma|molten/i.test(n) && !/rock|cliff|clift|stone|miner|harvest|particle/i.test(n)) return 'lava';
    if (/water|ocean|river|puddle|lake|waterfall/i.test(n) && !/plant|aqueduct|tank|crate|wall|bottle|drop/i.test(n)) return 'water';
    const P = r.props(cur);
    const parent = P?.get('Parent');
    cur = isRef(parent) ? r.get(cur.pkg, parent.ref) : null;
  }
  return undefined;
}

/**
 * Blend of a material's base Material (instances inherit it): TA's light beams, glows and holograms are additive or
 * unlit translucent (drawn as glows), glass is lit translucent, grime decals modulate. Opaque/masked -> undefined.
 */
export function materialBlend(r: Resolver, mat: ObjRef): 'additive' | 'translucent' | 'modulate' | undefined {
  let cur: ObjRef | null = mat;
  for (let d = 0; d < 8 && cur; d++) {
    const P = r.props(cur);
    if (!P) return undefined;
    if (r.className(cur) === 'Material') {
      const b = P.get('BlendMode'), unlit = P.get('LightingModel') === 'MLM_Unlit';
      if (b === 'BLEND_Additive' || b === 3) return 'additive';
      if (b === 'BLEND_Modulate' || b === 'BLEND_ModulateAndAdd' || b === 4) return 'modulate';
      if (b === 'BLEND_Translucent' || b === 'BLEND_AlphaComposite' || b === 2) return unlit ? 'additive' : 'translucent';
      return undefined;
    }
    const parent = P.get('Parent');
    cur = isRef(parent) ? r.get(cur.pkg, parent.ref) : null;
  }
  return undefined;
}
