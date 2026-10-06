/** Jetpack thrust plume styles. Players pick one per class; the look drives the client's plume emitters. */
export type JetStyle = 'ion' | 'fire' | 'smoke' | 'plasma' | 'vortex' | 'off';

export interface JetStyleDef {
  id: JetStyle;
  name: string;
  /** Hot core colour the team colour is blended toward. */
  core: number;
  /** 0..1 blend from team colour toward the core colour. */
  blend: number;
  /** Emit dense soft smoke instead of (or on top of) additive glow. */
  smoke: boolean;
  /** Relative puff size and lifetime multipliers. */
  size: number;
  life: number;
  /** Nozzle flame cone size as multipliers of the stock flame (wider/taller plume). */
  width: number;
  length: number;
}

export const JET_STYLES: Record<JetStyle, JetStyleDef> = {
  ion: { id: 'ion', name: 'Ion (standard)', core: 0x9fd8ff, blend: 0.55, smoke: false, size: 1.15, life: 1.1, width: 1.15, length: 1.15 },
  fire: { id: 'fire', name: 'Fire', core: 0xffb257, blend: 0.72, smoke: true, size: 1.2, life: 1.35, width: 1.5, length: 1.25 },
  smoke: { id: 'smoke', name: 'Dust', core: 0xcfd6de, blend: 0.85, smoke: true, size: 1.35, life: 1.6, width: 1.2, length: 0.85 },
  plasma: { id: 'plasma', name: 'Plasma', core: 0xff7ad9, blend: 0.8, smoke: false, size: 1.45, life: 1.25, width: 1.7, length: 1.4 },
  vortex: { id: 'vortex', name: 'Void', core: 0x8f6bff, blend: 0.9, smoke: false, size: 1.0, life: 1.5, width: 0.9, length: 1.75 },
  off: { id: 'off', name: 'No trail', core: 0x000000, blend: 0, smoke: false, size: 0, life: 0, width: 0, length: 0 },
};

export const JET_STYLE_IDS: JetStyle[] = Object.keys(JET_STYLES) as JetStyle[];

/** The stock trail each class flies out of the box. */
export const DEFAULT_JET_STYLE: Record<string, JetStyle> = {
  pathfinder: 'ion',
  sentinel: 'ion',
  infiltrator: 'vortex',
  soldier: 'smoke',
  technician: 'smoke',
  raider: 'fire',
  juggernaut: 'fire',
  doombringer: 'plasma',
  brute: 'plasma',
};

export type JetStyleMap = Record<string, JetStyle>;

export function jetStyleFor(map: Partial<JetStyleMap> | undefined, cls: string): JetStyle {
  const s = map?.[cls];
  return s && s in JET_STYLES ? s : DEFAULT_JET_STYLE[cls] ?? 'ion';
}

export function sanitizeJetStyles(raw: unknown): JetStyleMap {
  const out: JetStyleMap = {};
  for (const cls of Object.keys(DEFAULT_JET_STYLE)) {
    const v = (raw as Record<string, unknown> | null)?.[cls];
    out[cls] = typeof v === 'string' && v in JET_STYLES ? (v as JetStyle) : DEFAULT_JET_STYLE[cls];
  }
  return out;
}
