import { DEFAULT_BINDS, DEFAULT_COSMETICS, sanitizeCosmetics, sanitizeJetStyles, CLASSES, validateLoadout, type Action, type CosmeticProfile, type JetStyleMap, type Loadout } from '@ar/shared';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';
export type ColorGrade = 'neutral' | 'ascend' | 'cinematic' | 'vivid' | 'bleach';

export interface Settings {
  name: string;
  rememberName: boolean;
  loggedIn: boolean;
  quality: Quality;
  /** Let the renderer shrink/raise its own resolution to hold the frame-rate target. */
  adaptiveResolution: boolean;
  fov: number;
  maxFps: number;
  shadows: boolean;
  shadowQuality: ShadowQuality;
  softShadows: boolean;
  bloom: boolean;
  bloomStrength: number;
  antialias: boolean;
  /** FidelityFX Super Resolution 1.0 - spatial upscaling for performance. */
  fsr: boolean;
  viewDistance: number;
  particles: number;
  weather: boolean;
  /** Visible travelling rounds for bullet weapons (chainguns, rifles, SMGs, pistols). */
  tracers: boolean;
  textureDetail: 'low' | 'medium' | 'high' | 'ultra';
  anisotropy: number;
  waterQuality: 'low' | 'medium' | 'high';
  /** TA's Lightmass lightmaps on imported static meshes. */
  bakedLighting: boolean;
  post: 'off' | 'light' | 'full';
  hdr: boolean;
  toneMapping: 'aces' | 'agx' | 'neutral' | 'cineon';
  ao: 'off' | 'low' | 'high';
  godrays: boolean;
  volumetricFog: boolean;
  /** Depth-of-field strength, 0 = off. */
  dof: number;
  motionBlur: number;
  ssr: boolean;
  /** Frame generation (FSR3/DLSS3-style): the chain reprojects the last two graded frames and presents their
   * motion-compensated midpoint, so the scene renders at maxFps while twice as many frames reach the screen. */
  frameGen: boolean;
  /** Ray-traced shadows. Needs the WebGPU backend; on WebGL this falls back to soft shadow maps. */
  rtShadows: boolean;
  /** Ray-traced reflections. Needs the WebGPU backend; on WebGL this falls back to screen-space reflections. */
  rtReflections: boolean;
  /** Ray-traced global illumination. Needs the WebGPU backend; on WebGL this falls back to sky-env GI + high AO. */
  rtGI: boolean;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  grade: ColorGrade;
  vignette: number;
  filmGrain: number;
  chromatic: number;
  sharpen: number;
  brightness: number;
  minimap: boolean;
  minimapZoom: number;
  sensitivity: number;
  invertY: boolean;
  rawInput: boolean;
  toggleZoom: boolean;
  crosshairColor: string;
  crosshairScale: number;
  hudScale: number;
  showSpeed: boolean;
  showNetStats: boolean;
  /** Revision of the default look a save was migrated to. */
  defaultsRev?: number;
  forceDefaultSkins: boolean;
  masterVolume: number;
  effectsVolume: number;
  vgsVolume: number;
  musicVolume: number;
  transport: 'auto' | 'webtransport' | 'websocket';
  binds: Record<Action, string[]>;
  cosmetics: CosmeticProfile;
  /** Per-class jetpack trail style (keys are class ids). */
  jetStyles: JetStyleMap;
  /** The voice was never picked by the player: it follows the best imported TA voice pack. */
  voiceAuto: boolean;
  lastClass: string;
  loadouts: Record<string, Loadout>;
}

/** Presets only touch performance-relevant options; colour/style choices (grade, grain, ...) stay as the player set them. */
export const QUALITY_PRESETS: Record<Quality, Partial<Settings>> = {
  low: {
    // FSR needs a post chain to live in (it is the tail of it), so "low" keeps the cheap
    // chain on; with post off there is nothing to upscale.
    shadows: false, shadowQuality: 'off', bloom: false, antialias: false, fsr: true, viewDistance: 900, particles: 0.35, weather: false, textureDetail: 'low',
    anisotropy: 1, waterQuality: 'low', post: 'light', hdr: false, ao: 'off', godrays: false, volumetricFog: false, ssr: false, dof: 0,
  },
  medium: {
    shadows: true, shadowQuality: 'low', bloom: true, antialias: true, fsr: false, viewDistance: 1400, particles: 0.7, weather: true, textureDetail: 'medium',
    anisotropy: 4, waterQuality: 'medium', post: 'light', hdr: false, ao: 'off', godrays: false, volumetricFog: true, ssr: false,
  },
  high: {
    shadows: true, shadowQuality: 'high', bloom: true, antialias: true, fsr: false, viewDistance: 2200, particles: 1, weather: true, textureDetail: 'high',
    anisotropy: 8, waterQuality: 'high', post: 'light', hdr: false, ao: 'off', godrays: false, volumetricFog: true, ssr: false,
  },
  ultra: {
    shadows: true, shadowQuality: 'ultra', bloom: true, antialias: true, fsr: false, viewDistance: 3200, particles: 1.4,
    weather: true, textureDetail: 'ultra', anisotropy: 16, waterQuality: 'high', post: 'light', hdr: false, ao: 'off', godrays: false, volumetricFog: true, ssr: true,
  },
};

const DEFAULTS: Settings = {
  name: `Tribal${Math.floor(Math.random() * 900 + 100)}`,
  rememberName: true,
  loggedIn: false,
  quality: 'ultra',
  ...(QUALITY_PRESETS.ultra as Required<Pick<Settings, 'shadows' | 'shadowQuality' | 'bloom' | 'antialias' | 'fsr' | 'viewDistance' | 'particles' | 'weather' | 'textureDetail' | 'anisotropy' | 'waterQuality' | 'post' | 'hdr' | 'ao' | 'godrays' | 'volumetricFog' | 'ssr'>>),
  adaptiveResolution: true,
  shadowQuality: 'high',
  viewDistance: 4000,
  particles: 1,
  // 4x keeps grazing terrain readable at a fraction of the 8x/16x texture-sampling cost.
  anisotropy: 4,
  // SSAO off by default: it read as grime on the snow and the player wanted a clean image out of the box.
  ao: 'off',
  ssr: true,
  frameGen: false,
  rtShadows: false,
  rtReflections: false,
  rtGI: false,
  post: 'full',
  softShadows: true,
  bakedLighting: true,
  bloomStrength: 0.95,
  // Khronos Neutral keeps the authored albedo readable - ACES desaturates the bright snow and the team colours.
  toneMapping: 'neutral',
  // Off by default; the slider (rev 7) lets players dial in a gentle strength. The far-field blur reads
  // heavy at full strength, so the curve in the post chain is capped well below a hard cinematic DOF.
  dof: 0,
  // Off by default: depth-reprojected accumulation smears the in-weapon ammo LCD and the thin authored
  // screen glass into full-frame scanlines while the player moves. The slider stays for those who want it.
  motionBlur: 0,
  contrast: 0.95,
  saturation: 1.28,
  vibrance: 1,
  temperature: 0.56,
  tint: 0,
  // Neutral grade by default: no built-in colour push on top of the neutral tone map.
  grade: 'neutral',
  vignette: 0,
  filmGrain: 0.02,
  chromatic: 0.02,
  sharpen: 0.02,
  brightness: 1.2,
  tracers: true,
  minimap: true,
  minimapZoom: 1,
  fov: 90,
  // 30 fps out of the box; the slider tops out at 60.
  maxFps: 30,
  sensitivity: 1,
  invertY: false,
  rawInput: true,
  toggleZoom: false,
  crosshairColor: '#ff3b30',
  crosshairScale: 1.4,
  hudScale: 1,
  showSpeed: true,
  showNetStats: false,
  defaultsRev: 9,
  forceDefaultSkins: false,
  masterVolume: 0.8,
  effectsVolume: 0.9,
  vgsVolume: 1,
  musicVolume: 0.4,
  transport: 'auto',
  binds: DEFAULT_BINDS,
  cosmetics: DEFAULT_COSMETICS,
  jetStyles: sanitizeJetStyles({}),
  voiceAuto: true,
  lastClass: 'pathfinder',
  loadouts: Object.fromEntries(CLASSES.map((c) => [c.id, c.defaultLoadout])),
};

const KEY = 'ascend-reborn:settings:v1';
const DEFAULTS_REV = 9;
const LOOK_KEYS = ['bloomStrength', 'toneMapping', 'motionBlur', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'grade', 'vignette',
  'filmGrain', 'chromatic', 'sharpen', 'brightness', 'crosshairColor', 'crosshairScale'] as const;
/** Rev 3: quality-per-cost retune of the out-of-the-box defaults. */
const PERF_KEYS = ['anisotropy', 'ao', 'ssr'] as const;
/** Rev 4: UE3's grade is soft and hazy - drop the added punch so the new sky, fog and lightmaps read like the original. */
const GRADE_KEYS = ['bloomStrength', 'contrast', 'saturation', 'vibrance', 'sharpen', 'brightness'] as const;
/** Rev 5: the tuned in-game look - full post chain, ACES grade and the wide FOV the lighting port was matched against. */
const TUNED_KEYS = ['anisotropy', 'ao', 'ssr', 'fov', 'bloomStrength', 'toneMapping', 'motionBlur', 'contrast',
  'saturation', 'vibrance', 'temperature', 'grade', 'vignette', 'chromatic', 'sharpen', 'brightness'] as const;
/** Rev 6: motion blur off - it smeared the in-weapon ammo readout into full-frame scanlines during movement. */
const NO_MOTION_KEYS = ['motionBlur'] as const;
/** Rev 7: HDR off (it banding-smeared the readout and cost a full-res 16-bit chain for no visible gain) and the DOF checkbox became a strength slider. */
const NO_HDR_KEYS = ['hdr', 'dof'] as const;
/** Rev 8: frame generation and the ray-tracing toggles arrive (all off by default; RT needs WebGPU). */
const NEW_RT_KEYS = ['frameGen', 'rtShadows', 'rtReflections', 'rtGI'] as const;
/** Rev 9: the clean-slate look - neutral tone map and grade, SSAO off, 90° FOV, 30 fps cap, 4x anisotropy,
 *  and frame generation / RT GI retired from the defaults (their UI rows are hidden). */
const CLEAN_KEYS = ['toneMapping', 'grade', 'ao', 'fov', 'maxFps', 'anisotropy', 'frameGen', 'rtGI'] as const;
/** Applied in order; each revision is only pushed onto saves made before it, so player tweaks survive. */
const MIGRATIONS: { rev: number, keys: readonly string[] }[] = [
  { rev: 2, keys: LOOK_KEYS },
  { rev: 3, keys: PERF_KEYS },
  { rev: 4, keys: GRADE_KEYS },
  { rev: 5, keys: TUNED_KEYS },
  { rev: 6, keys: NO_MOTION_KEYS },
  { rev: 7, keys: NO_HDR_KEYS },
  { rev: 8, keys: NEW_RT_KEYS },
  { rev: 9, keys: CLEAN_KEYS },
];

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s: Settings = { ...DEFAULTS, ...raw, binds: { ...DEFAULT_BINDS, ...(raw.binds ?? {}) } };
    s.cosmetics = sanitizeCosmetics(raw.cosmetics);
    s.jetStyles = sanitizeJetStyles(raw.jetStyles);
    // Saves from before TA voices were the default hold the old synth default without the player having chosen it.
    s.voiceAuto = raw.voiceAuto ?? (raw.cosmetics?.voice === undefined || raw.cosmetics.voice === 'reborn_vanguard');
    s.loadouts = Object.fromEntries(CLASSES.map((c) => [c.id, validateLoadout(c.id, raw.loadouts?.[c.id] ?? c.defaultLoadout)]));
    s.name = String(s.name).slice(0, 20) || DEFAULTS.name;
    // Older saves only had an on/off shadow switch.
    if (raw.shadowQuality === undefined && raw.shadows === false) s.shadowQuality = 'off';
    s.shadows = s.shadowQuality !== 'off';
    // New defaults are pushed onto saves made before each revision, once, so later player tweaks survive.
    for (const m of MIGRATIONS) {
      if ((raw.defaultsRev ?? 0) < m.rev) {
        for (const k of m.keys) (s as unknown as Record<string, unknown>)[k] = (DEFAULTS as unknown as Record<string, unknown>)[k];
      }
    }
    s.defaultsRev = DEFAULTS_REV;
    return s;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings: Settings = load();
const listeners = new Set<() => void>();

export function saveSettings() {
  localStorage.setItem(KEY, JSON.stringify(settings));
  for (const l of listeners) l();
}

export function onSettingsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyQuality(q: Quality) {
  Object.assign(settings, QUALITY_PRESETS[q], { quality: q });
  saveSettings();
}

export function resetBinds() {
  settings.binds = structuredClone(DEFAULT_BINDS);
  saveSettings();
}

export function exportProfile(): string {
  return btoa(JSON.stringify({ name: settings.name, cosmetics: settings.cosmetics, loadouts: settings.loadouts, binds: settings.binds }));
}

export function importProfile(code: string): boolean {
  try {
    const p = JSON.parse(atob(code.trim())) as Partial<Settings>;
    if (p.cosmetics) { settings.cosmetics = sanitizeCosmetics(p.cosmetics); settings.voiceAuto = false; }
    if (p.loadouts) settings.loadouts = Object.fromEntries(CLASSES.map((c) => [c.id, validateLoadout(c.id, p.loadouts?.[c.id] ?? c.defaultLoadout)]));
    if (p.binds) settings.binds = { ...DEFAULT_BINDS, ...p.binds };
    if (typeof p.name === 'string') settings.name = p.name.slice(0, 20);
    saveSettings();
    return true;
  } catch {
    return false;
  }
}
