// Original cosmetic designs. Everything is unlocked; team colour always drives accent zones so readability is preserved.

export type SkinPattern = 'solid' | 'camo' | 'plating' | 'hex' | 'stripes' | 'glyph' | 'digital' | 'circuit';
export type SkinMaterial = 'matte' | 'metal' | 'weathered';

export interface ArmorSkin { id: string; name: string; pattern: SkinPattern; base: number; secondary: number; material: SkinMaterial; patternScale: number }
export interface WeaponFinish { id: string; name: string; tint: number; pattern: SkinPattern; metalness: number }
export interface JetTrail { id: string; name: string; saturation: number; brightness: number; sparkle: number }
export interface Emblem { id: string; name: string; seed: number }
export interface Nameplate { id: string; name: string; style: 'plain' | 'bracket' | 'chevron' | 'underline' }
export interface Banner { id: string; name: string; from: number; to: number }
export interface VoicePack { id: string; name: string; pitch: number; rate: number; radio: number; voiceHint: string }

export const ARMOR_SKINS: ArmorSkin[] = [
  { id: 'standard', name: 'Standard Issue', pattern: 'plating', base: 0xa2a8ae, secondary: 0x5d636b, material: 'metal', patternScale: 1 },
  { id: 'tundra', name: 'Tundra Camo', pattern: 'camo', base: 0xb8c2cc, secondary: 0x7d8894, material: 'matte', patternScale: 1.4 },
  { id: 'dune', name: 'Dune Runner', pattern: 'stripes', base: 0xb49a6e, secondary: 0x86704c, material: 'weathered', patternScale: 1 },
  { id: 'hexweave', name: 'Hexweave', pattern: 'hex', base: 0x9eaab2, secondary: 0x4f5a62, material: 'metal', patternScale: 1.2 },
  { id: 'glyphcarver', name: 'Glyph Carver', pattern: 'glyph', base: 0xb0a59a, secondary: 0x6a5f58, material: 'weathered', patternScale: 1 },
  { id: 'datamesh', name: 'Datamesh', pattern: 'digital', base: 0xa0acae, secondary: 0x56606a, material: 'matte', patternScale: 1.6 },
  { id: 'tracewire', name: 'Tracewire', pattern: 'circuit', base: 0xa4aab2, secondary: 0x5a6068, material: 'metal', patternScale: 1 },
  { id: 'veteran', name: 'Scarred Veteran', pattern: 'solid', base: 0xb0a698, secondary: 0x5f574d, material: 'weathered', patternScale: 1 },
];

export const WEAPON_FINISHES: WeaponFinish[] = [
  { id: 'factory', name: 'Factory', tint: 0x9aa0a6, pattern: 'solid', metalness: 0.7 },
  { id: 'gunmetal', name: 'Gunmetal', tint: 0x6b7178, pattern: 'plating', metalness: 0.85 },
  { id: 'brass', name: 'Brass Works', tint: 0xb89a5a, pattern: 'solid', metalness: 0.9 },
  { id: 'frost', name: 'Frostbite', tint: 0xc8d6e0, pattern: 'hex', metalness: 0.5 },
  { id: 'carbon', name: 'Carbon Weave', tint: 0x55595e, pattern: 'digital', metalness: 0.3 },
  { id: 'ivory', name: 'Ivory', tint: 0xd8d2c4, pattern: 'glyph', metalness: 0.2 },
];

export const JET_TRAILS: JetTrail[] = [
  { id: 'standard', name: 'Standard', saturation: 1, brightness: 1, sparkle: 0 },
  { id: 'plasma', name: 'Plasma Burn', saturation: 1.2, brightness: 1.25, sparkle: 0.2 },
  { id: 'ember', name: 'Ember Stream', saturation: 0.8, brightness: 0.95, sparkle: 0.6 },
  { id: 'ion', name: 'Ion Wake', saturation: 1.4, brightness: 1.1, sparkle: 0.35 },
  { id: 'ghost', name: 'Pale Ghost', saturation: 0.5, brightness: 1.3, sparkle: 0.1 },
];

export const EMBLEMS: Emblem[] = Array.from({ length: 16 }, (_, i) => ({ id: `emblem_${i}`, name: `Sigil ${String.fromCharCode(65 + i)}`, seed: 1000 + i * 7919 }));

export const NAMEPLATES: Nameplate[] = [
  { id: 'plain', name: 'Plain', style: 'plain' },
  { id: 'bracket', name: 'Bracketed', style: 'bracket' },
  { id: 'chevron', name: 'Chevron', style: 'chevron' },
  { id: 'underline', name: 'Underline', style: 'underline' },
];

export const BANNERS: Banner[] = [
  { id: 'steel', name: 'Steel', from: 0x3a4048, to: 0x1c1f24 },
  { id: 'dawn', name: 'Dawn', from: 0x6a4a3a, to: 0x201818 },
  { id: 'glacier', name: 'Glacier', from: 0x3a5a6a, to: 0x14202a },
  { id: 'moss', name: 'Moss', from: 0x40503a, to: 0x161c14 },
  { id: 'dusk', name: 'Dusk', from: 0x4a3a60, to: 0x18141f },
];

export const VOICE_PACKS: VoicePack[] = [
  { id: 'reborn_vanguard', name: 'Vanguard', pitch: 0.9, rate: 1.05, radio: 0.6, voiceHint: 'male' },
  { id: 'reborn_valkyrie', name: 'Valkyrie', pitch: 1.15, rate: 1.05, radio: 0.6, voiceHint: 'female' },
  { id: 'reborn_warden', name: 'Warden', pitch: 0.75, rate: 0.95, radio: 0.8, voiceHint: 'male' },
  { id: 'reborn_spark', name: 'Spark', pitch: 1.35, rate: 1.2, radio: 0.4, voiceHint: 'female' },
  { id: 'reborn_automaton', name: 'Automaton', pitch: 0.6, rate: 0.9, radio: 1, voiceHint: 'any' },
];

export interface CosmeticProfile {
  skinLight: string; skinMedium: string; skinHeavy: string; weaponFinish: string; jetTrail: string;
  emblem: string; nameplate: string; banner: string; voice: string;
  /** Original TA skin per class (CLASSES order), one digit each: 0 team armour, 1 Mercenary, 2 Mercenary variant. */
  taSkins: string;
}

/** TA character skins by class id (index = digit in `taSkins`); they need models imported with ta-import. */
export const TA_SKINS: Record<string, string[]> = {
  pathfinder: ['Team Armor', 'Mercenary'], sentinel: ['Team Armor', 'Mercenary'], infiltrator: ['Team Armor', 'Mercenary', 'Mercenary (Light)'],
  soldier: ['Team Armor', 'Mercenary'], raider: ['Team Armor', 'Mercenary', 'Mercenary (Medium)'], technician: ['Team Armor', 'Mercenary'],
  juggernaut: ['Team Armor', 'Mercenary'], doombringer: ['Team Armor', 'Mercenary'], brute: ['Team Armor', 'Mercenary'],
};

/** Model key for a class/team/skin; falls back to the team model when the variant was not imported. */
export function taSkinModelKeys(clsId: string, team: number, skin: number): string[] {
  const teamKey = `pc_${clsId}_${team === 1 ? 1 : 0}`;
  if (skin <= 0 || !TA_SKINS[clsId]?.[skin]) return [teamKey];
  return [`pc_${clsId}_merc${skin === 2 ? '2' : ''}`, teamKey];
}

export const DEFAULT_COSMETICS: CosmeticProfile = {
  skinLight: 'standard', skinMedium: 'standard', skinHeavy: 'standard', weaponFinish: 'factory', jetTrail: 'standard',
  emblem: 'emblem_0', nameplate: 'plain', banner: 'steel', voice: 'reborn_vanguard', taSkins: '',
};

const ids = <T extends { id: string }>(a: T[]) => new Set(a.map((x) => x.id));
const SETS = {
  skin: ids(ARMOR_SKINS), weapon: ids(WEAPON_FINISHES), jet: ids(JET_TRAILS), emblem: ids(EMBLEMS),
  nameplate: ids(NAMEPLATES), banner: ids(BANNERS), voice: ids(VOICE_PACKS),
};

/** Server-side sanitising: unknown IDs fall back to defaults. */
export function sanitizeCosmetics(p: Partial<CosmeticProfile> | undefined): CosmeticProfile {
  const d = DEFAULT_COSMETICS;
  const ok = (v: unknown, s: Set<string>, def: string) => (typeof v === 'string' && s.has(v) ? v : def);
  return {
    skinLight: ok(p?.skinLight, SETS.skin, d.skinLight), skinMedium: ok(p?.skinMedium, SETS.skin, d.skinMedium),
    skinHeavy: ok(p?.skinHeavy, SETS.skin, d.skinHeavy), weaponFinish: ok(p?.weaponFinish, SETS.weapon, d.weaponFinish),
    jetTrail: ok(p?.jetTrail, SETS.jet, d.jetTrail), emblem: ok(p?.emblem, SETS.emblem, d.emblem),
    nameplate: ok(p?.nameplate, SETS.nameplate, d.nameplate), banner: ok(p?.banner, SETS.banner, d.banner),
    voice: typeof p?.voice === 'string' && ORIGINAL_VOICE.test(p.voice) ? p.voice : ok(p?.voice, SETS.voice, d.voice),
    taSkins: typeof p?.taSkins === 'string' && /^[0-2]{0,16}$/.test(p.taSkins) ? p.taSkins : '',
  };
}

/** Voice packs imported from a local Tribes: Ascend install (ta-import); each client plays them from its own copy. */
export const ORIGINAL_VOICE = /^ta_[a-z0-9_]{1,40}$/;

export function relLuminance(hex: number): number {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: number, b: number): number {
  const la = relLuminance(a), lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Rejects skins that could read as stealth (too dark) or wash out team accents. */
export function validateSkinReadability(skin: ArmorSkin, teamColors: readonly number[]): boolean {
  if (relLuminance(skin.base) < 0.08) return false;
  return teamColors.every((t) => contrastRatio(skin.base, t) >= 1.3);
}
