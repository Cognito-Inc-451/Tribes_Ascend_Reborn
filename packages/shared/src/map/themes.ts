export type ThemeId =
  | 'ice' | 'ice_night' | 'alpine' | 'canyon' | 'industrial' | 'industrial_night' | 'hellfire' | 'lush' | 'alien'
  | 'sunset' | 'grassland' | 'swamp' | 'jungle' | 'desert' | 'sulfur' | 'lunar' | 'urban' | 'arena_steel' | 'arena_lava' | 'arena_snow';

export interface Theme {
  id: ThemeId;
  skyTop: number; skyHorizon: number; fog: number; fogDensity: number;
  sunDir: [number, number, number]; sun: number; sunIntensity: number; ambient: number; ambientIntensity: number;
  grass: number; rock: number; snow: number; sand: number;
  snowLine: number;   // fraction of height range above which snow blends in (1 = none)
  structure: number; trim: number; glow: number;
  scatter: 'ice_spikes' | 'rocks' | 'pillars' | 'trees' | 'crystals' | 'none';
  hazard?: { kind: 'lava' | 'water' | 'acid'; level: number };
  night?: boolean;
  weather?: 'snow' | 'rain' | 'ash' | 'dust' | 'none';
}

const t = (x: Partial<Theme> & Pick<Theme, 'id'>): Theme => ({
  skyTop: 0x5a8ac0, skyHorizon: 0xc8d8e8, fog: 0xc0cfdc, fogDensity: 0.0006,
  sunDir: [0.4, 0.8, 0.3], sun: 0xfff4e0, sunIntensity: 2.2, ambient: 0xb0c4d8, ambientIntensity: 0.9,
  grass: 0x7d8a5a, rock: 0x6f6a62, snow: 0xeef3f8, sand: 0xb8a882, snowLine: 1,
  structure: 0x8a8e94, trim: 0x3a3f46, glow: 0x9fe8ff, scatter: 'rocks', weather: 'none', ...x,
});

export const THEMES: Record<ThemeId, Theme> = {
  ice: t({ id: 'ice', skyTop: 0x6f9ccc, skyHorizon: 0xdfe8f0, fog: 0xd8e2ec, fogDensity: 0.0005, grass: 0xc8d4de, rock: 0x7c8894, snow: 0xf4f8fc, snowLine: 0.15, scatter: 'ice_spikes', weather: 'snow' }),
  ice_night: t({ id: 'ice_night', skyTop: 0x0a1020, skyHorizon: 0x223452, fog: 0x1a2436, fogDensity: 0.0009, sun: 0x9fb6ff, sunIntensity: 0.9, ambient: 0x5064a0, ambientIntensity: 0.7, grass: 0x8a9ab0, rock: 0x4c5664, snow: 0xc4d0e4, snowLine: 0.15, scatter: 'ice_spikes', night: true, weather: 'snow' }),
  alpine: t({ id: 'alpine', skyTop: 0x4f86c6, skyHorizon: 0xd6e4f0, grass: 0x6f8a4e, rock: 0x7a7470, snowLine: 0.7, scatter: 'rocks' }),
  canyon: t({ id: 'canyon', skyTop: 0x5a92cc, skyHorizon: 0xf0d8b8, fog: 0xe4c8a4, grass: 0xa8744a, rock: 0x9c5a38, sand: 0xc89a6a, scatter: 'pillars', weather: 'dust' }),
  industrial: t({ id: 'industrial', skyTop: 0x6a8ab0, skyHorizon: 0xd0d8e0, grass: 0x6a7456, rock: 0x68666a, structure: 0x7c8088, scatter: 'rocks', hazard: { kind: 'water', level: -8 } }),
  industrial_night: t({ id: 'industrial_night', skyTop: 0x0c1220, skyHorizon: 0x28324a, fog: 0x1c2232, fogDensity: 0.001, sun: 0xa0b8ff, sunIntensity: 0.8, ambient: 0x505a80, ambientIntensity: 0.7, grass: 0x4a5444, rock: 0x4a484e, night: true, hazard: { kind: 'water', level: -8 } }),
  hellfire: t({ id: 'hellfire', skyTop: 0x3a1a14, skyHorizon: 0xa0482a, fog: 0x6a2c1c, fogDensity: 0.0009, sun: 0xffb080, sunIntensity: 1.6, ambient: 0x904030, ambientIntensity: 0.8, grass: 0x4a3a32, rock: 0x3a2e2a, sand: 0x5a4034, glow: 0xff7030, scatter: 'pillars', hazard: { kind: 'lava', level: -12 }, weather: 'ash' }),
  lush: t({ id: 'lush', skyTop: 0x607890, skyHorizon: 0xb0bcc4, fog: 0xa8b4bc, fogDensity: 0.0008, grass: 0x4e7a3a, rock: 0x5e625a, scatter: 'trees', weather: 'rain' }),
  alien: t({ id: 'alien', skyTop: 0x6a5aa0, skyHorizon: 0xe0c0d8, fog: 0xc8b0cc, grass: 0x8a9a5a, rock: 0x7a6a7a, scatter: 'crystals' }),
  sunset: t({ id: 'sunset', skyTop: 0x4a3a70, skyHorizon: 0xf0a060, fog: 0xe0a078, sunDir: [0.8, 0.25, 0.2], sun: 0xffc080, grass: 0x8a7a4a, rock: 0x7a5a4a, scatter: 'rocks' }),
  grassland: t({ id: 'grassland', skyTop: 0x4a8ad0, skyHorizon: 0xd8e8f4, grass: 0x6a9a48, rock: 0x8a8a84, scatter: 'rocks' }),
  swamp: t({ id: 'swamp', skyTop: 0x4a5a4a, skyHorizon: 0x98a88a, fog: 0x7a8a6a, fogDensity: 0.0014, grass: 0x4a5a32, rock: 0x4a4a3a, scatter: 'trees', hazard: { kind: 'acid', level: -6 } }),
  jungle: t({ id: 'jungle', skyTop: 0x5a8aa0, skyHorizon: 0xc8dcc8, fog: 0xa8c0a8, fogDensity: 0.0009, grass: 0x3e6a2e, rock: 0x6a6a5a, structure: 0x8a8470, scatter: 'trees' }),
  desert: t({ id: 'desert', skyTop: 0x5a94d4, skyHorizon: 0xf4e4c4, fog: 0xe8d8b4, grass: 0xc8aa74, rock: 0xa08058, sand: 0xd8bc88, scatter: 'rocks', weather: 'dust' }),
  sulfur: t({ id: 'sulfur', skyTop: 0x7a7a4a, skyHorizon: 0xe0d890, fog: 0xc8c070, fogDensity: 0.0011, grass: 0xb8a848, rock: 0x6a6440, scatter: 'crystals', hazard: { kind: 'acid', level: -6 } }),
  lunar: t({ id: 'lunar', skyTop: 0x0a0c1a, skyHorizon: 0x3a4a6a, fog: 0x2a3450, fogDensity: 0.0005, sun: 0xd8e4ff, ambient: 0x6070a0, grass: 0x8a8e9a, rock: 0x5a5e6a, snow: 0xaab4c4, scatter: 'crystals', night: true }),
  urban: t({ id: 'urban', skyTop: 0x5a86b6, skyHorizon: 0xd8dce4, grass: 0x7a8060, rock: 0x7a7672, structure: 0x9a9894, scatter: 'rocks' }),
  arena_steel: t({ id: 'arena_steel', skyTop: 0x3a4a6a, skyHorizon: 0xa0b0c4, grass: 0x6a6e74, rock: 0x5a5e64, scatter: 'pillars' }),
  arena_lava: t({ id: 'arena_lava', skyTop: 0x2a1410, skyHorizon: 0x904020, fog: 0x5a2416, fogDensity: 0.0012, sun: 0xffa070, ambient: 0x803020, grass: 0x3a2c28, rock: 0x2e2420, glow: 0xff6020, scatter: 'pillars', hazard: { kind: 'lava', level: -3 }, weather: 'ash' }),
  arena_snow: t({ id: 'arena_snow', skyTop: 0x8aa8c8, skyHorizon: 0xf0f4f8, fog: 0xe8eef4, fogDensity: 0.0016, grass: 0xdce4ec, rock: 0x8894a0, snowLine: 0, scatter: 'ice_spikes', weather: 'snow' }),
};
