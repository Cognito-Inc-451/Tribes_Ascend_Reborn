import { DEFAULT_BINDS, DEFAULT_COSMETICS, sanitizeCosmetics, CLASSES, validateLoadout, type Action, type CosmeticProfile, type Loadout } from '@ar/shared';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  name: string;
  rememberName: boolean;
  loggedIn: boolean;
  quality: Quality;
  renderScale: number;
  fov: number;
  maxFps: number;
  shadows: boolean;
  bloom: boolean;
  antialias: boolean;
  viewDistance: number;
  particles: number;
  weather: boolean;
  /** Visible travelling rounds for bullet weapons (chainguns, rifles, SMGs, pistols). */
  tracers: boolean;
  textureDetail: 'low' | 'medium' | 'high';
  post: 'off' | 'light' | 'full';
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
  forceDefaultSkins: boolean;
  masterVolume: number;
  effectsVolume: number;
  vgsVolume: number;
  musicVolume: number;
  transport: 'auto' | 'webtransport' | 'websocket';
  binds: Record<Action, string[]>;
  cosmetics: CosmeticProfile;
  lastClass: string;
  loadouts: Record<string, Loadout>;
}

export const QUALITY_PRESETS: Record<Quality, Partial<Settings>> = {
  low: { renderScale: 0.75, shadows: false, bloom: false, antialias: false, viewDistance: 900, particles: 0.35, weather: false, textureDetail: 'low' },
  medium: { renderScale: 1, shadows: false, bloom: false, antialias: true, viewDistance: 1400, particles: 0.7, weather: true, textureDetail: 'medium' },
  high: { renderScale: 1, shadows: true, bloom: true, antialias: true, viewDistance: 2200, particles: 1, weather: true, textureDetail: 'high' },
  ultra: { renderScale: Math.min(2, window.devicePixelRatio || 1), shadows: true, bloom: true, antialias: true, viewDistance: 3200, particles: 1.4, weather: true, textureDetail: 'high' },
};

const DEFAULTS: Settings = {
  name: `Tribal${Math.floor(Math.random() * 900 + 100)}`,
  rememberName: true,
  loggedIn: false,
  quality: 'high',
  ...(QUALITY_PRESETS.high as Required<Pick<Settings, 'renderScale' | 'shadows' | 'bloom' | 'antialias' | 'viewDistance' | 'particles' | 'weather' | 'textureDetail'>>),
  brightness: 1,
  tracers: true,
  post: 'light',
  minimap: true,
  minimapZoom: 1,
  fov: 100,
  maxFps: 0,
  sensitivity: 1,
  invertY: false,
  rawInput: true,
  toggleZoom: false,
  crosshairColor: '#9fe8ff',
  crosshairScale: 1,
  hudScale: 1,
  showSpeed: true,
  showNetStats: false,
  forceDefaultSkins: false,
  masterVolume: 0.8,
  effectsVolume: 0.9,
  vgsVolume: 1,
  musicVolume: 0.4,
  transport: 'auto',
  binds: DEFAULT_BINDS,
  cosmetics: DEFAULT_COSMETICS,
  lastClass: 'pathfinder',
  loadouts: Object.fromEntries(CLASSES.map((c) => [c.id, c.defaultLoadout])),
};

const KEY = 'ascend-reborn:settings:v1';

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s: Settings = { ...DEFAULTS, ...raw, binds: { ...DEFAULT_BINDS, ...(raw.binds ?? {}) } };
    s.cosmetics = sanitizeCosmetics(raw.cosmetics);
    s.loadouts = Object.fromEntries(CLASSES.map((c) => [c.id, validateLoadout(c.id, raw.loadouts?.[c.id] ?? c.defaultLoadout)]));
    s.name = String(s.name).slice(0, 20) || DEFAULTS.name;
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
    if (p.cosmetics) settings.cosmetics = sanitizeCosmetics(p.cosmetics);
    if (p.loadouts) settings.loadouts = Object.fromEntries(CLASSES.map((c) => [c.id, validateLoadout(c.id, p.loadouts?.[c.id] ?? c.defaultLoadout)]));
    if (p.binds) settings.binds = { ...DEFAULT_BINDS, ...p.binds };
    if (typeof p.name === 'string') settings.name = p.name.slice(0, 20);
    saveSettings();
    return true;
  } catch {
    return false;
  }
}
