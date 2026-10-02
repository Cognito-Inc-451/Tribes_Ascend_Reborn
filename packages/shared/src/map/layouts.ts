import type { ModeId } from '../data/modes.js';
import { hashString } from '../rng.js';
import type { Feature, MapSpec, PrefabPlacement } from './spec.js';
import type { ThemeId } from './themes.js';

// Reborn layouts: hand-authored approximations of the official map list
// (wiki.tribesdepot.com/wiki/Tribes:_Ascend/Maps_series). Team 0 (Blood Eagle) sits at -Z; point symmetry mirrors team 1.

interface CtfOpts {
  id: string; name: string; theme: ThemeId; modes: ModeId[]; size: number; baseDist: number;
  amp?: number; scale?: number; ridged?: number; baseHill?: number; baseX?: number;
  mid?: Feature[]; extra?: PrefabPlacement[]; towers?: [number, number][]; pad?: [number, number];
  turret2?: [number, number]; genBunker?: [number, number]; flagPlatform?: [number, number];
  blitz?: [number, number][]; cah?: { tag: string; x: number; z: number }[]; scatter?: number;
  wiki?: string; internal?: string[]; edge?: number;
}

const R = Math.PI;

function ctf(o: CtfOpts): MapSpec {
  const bz = -o.baseDist / 2, bx = o.baseX ?? 0;
  const prefabs: PrefabPlacement[] = [
    { prefab: 'main_base', x: bx, z: bz, yaw: R, team: 0 },
  ];
  if (o.pad) prefabs.push({ prefab: 'vehicle_pad', x: bx + o.pad[0], z: bz + o.pad[1], yaw: R, team: 0 });
  if (o.turret2) prefabs.push({ prefab: 'turret_mount', x: bx + o.turret2[0], z: bz + o.turret2[1], yaw: R, team: 0 });
  if (o.genBunker) prefabs.push({ prefab: 'gen_bunker', x: bx + o.genBunker[0], z: bz + o.genBunker[1], yaw: R, team: 0 });
  if (o.flagPlatform) prefabs.push({ prefab: 'flag_platform', x: bx + o.flagPlatform[0], z: bz + o.flagPlatform[1], yaw: R, team: 0 });
  for (const [x, z] of o.towers ?? []) prefabs.push({ prefab: 'tower', x: bx + x, z: bz + z, yaw: R, team: 0 });
  // Blitz: stand 0 is the CTF stand position (on the roof); extra positions rotate in after each capture.
  prefabs.push({ prefab: 'blitz_stand', x: bx, z: bz, yaw: R, team: 0, lift: 7.3, flatten: 0, modes: ['blitz'] });
  for (const [x, z] of o.blitz ?? [[-40, 30], [45, -20], [0, 60], [-25, -45]]) prefabs.push({ prefab: 'blitz_stand', x: bx + x, z: bz + z, yaw: R, team: 0, modes: ['blitz'] });
  for (const c of o.cah ?? []) prefabs.push({ prefab: 'cap_point', x: c.x, z: c.z, yaw: 0, team: 255, tag: c.tag, noMirror: true });
  prefabs.push(...(o.extra ?? []));
  const baseHill = o.baseHill ?? 25;
  const features: Feature[] = [{ type: 'plateau', x: bx, z: bz, r: 90, h: baseHill, edge: 0.6 }, ...(o.mid ?? [])];
  return {
    id: o.id, name: o.name, theme: o.theme, modes: o.modes, size: o.size, res: Math.min(385, Math.round(o.size / 5) + 1),
    seed: hashString(o.id), baseHeight: 0, noise: { amp: o.amp ?? 30, scale: o.scale ?? 320, octaves: 5, ridged: o.ridged },
    edge: { start: 0.78, height: o.edge ?? 180 }, mirror: 'point', features, prefabs, scatter: o.scatter ?? 1,
    wikiRef: o.wiki, internal: o.internal,
  };
}

interface OpenOpts {
  id: string; name: string; theme: ThemeId; modes: ModeId[]; size: number; amp?: number; scale?: number; ridged?: number;
  features?: Feature[]; extra?: PrefabPlacement[]; spawnDist?: number; cah?: { tag: string; x: number; z: number }[];
  scatter?: number; wiki?: string; internal?: string[]; bases?: boolean;
}

function open(o: OpenOpts): MapSpec {
  const sd = o.spawnDist ?? o.size * 0.3;
  const prefabs: PrefabPlacement[] = [
    { prefab: 'rabbit_flag', x: 0, z: 0, noMirror: true },
    { prefab: 'spawn_ring', x: 0, z: -sd, team: 0, len: 16 },
    { prefab: 'tower', x: 0, z: -sd - 30, yaw: R, team: 0 },
    ...(o.cah ?? []).map((c) => ({ prefab: 'cap_point' as const, x: c.x, z: c.z, team: 255, tag: c.tag, noMirror: true })),
    ...(o.extra ?? []),
  ];
  if (o.bases) prefabs.push({ prefab: 'gen_bunker', x: 0, z: -sd - 60, yaw: R, team: 0, modes: ['cah'] });
  return {
    id: o.id, name: o.name, theme: o.theme, modes: o.modes, size: o.size, res: Math.min(321, Math.round(o.size / 4) + 1),
    seed: hashString(o.id), baseHeight: 0, noise: { amp: o.amp ?? 22, scale: o.scale ?? 220, octaves: 5, ridged: o.ridged },
    edge: { start: 0.75, height: 140 }, mirror: 'point', features: o.features ?? [], prefabs, scatter: o.scatter ?? 1.2,
    wikiRef: o.wiki, internal: o.internal,
  };
}

interface ArenaOpts { id: string; name: string; theme: ThemeId; size?: number; amp?: number; extra?: PrefabPlacement[]; features?: Feature[]; wiki?: string; internal?: string[] }

function arena(o: ArenaOpts): MapSpec {
  const size = o.size ?? 420;
  return {
    id: o.id, name: o.name, theme: o.theme, modes: ['arena'], size, res: Math.round(size / 3) + 1, seed: hashString(o.id), baseHeight: 0,
    noise: { amp: o.amp ?? 10, scale: 120, octaves: 4 }, edge: { start: 0.7, height: 90 }, mirror: 'point',
    features: o.features ?? [], scatter: 0.6,
    prefabs: [{ prefab: 'arena_bunker', x: 0, z: -size * 0.33, yaw: R, team: 0 }, ...(o.extra ?? [])],
    wikiRef: o.wiki, internal: o.internal,
  };
}

const W = (p: string) => `https://tribes.fandom.com/wiki/${p}`;

export const LAYOUTS: MapSpec[] = [
  // ---------------- CTF / Blitz / CaH ----------------
  ctf({ id: 'katabatic', name: 'Katabatic', theme: 'ice', modes: ['ctf', 'blitz', 'cah'], size: 2300, baseDist: 1050, amp: 34, ridged: 0.4, baseHill: 45,
    towers: [[-110, 60], [70, 330]], pad: [60, -30], turret2: [30, 40],
    mid: [{ type: 'hill', x: -260, z: -120, r: 120, h: 60 }, { type: 'valley', x: -500, z: 0, x2: 500, z2: 0, r: 70, h: -25 }, { type: 'hill', x: 250, z: -280, r: 90, h: 50 }],
    blitz: [[0, -12], [-22, 10], [16, 18], [0, 4]],
    cah: [{ tag: 'A', x: 0, z: -560 }, { tag: 'B', x: -110, z: -165 }, { tag: 'C', x: 110, z: 165 }, { tag: 'D', x: 0, z: 560 }],
    wiki: W('Katabatic'), internal: ['TrCTF-Katabatic', 'TrCTFBlitz-Katabatic', 'TrCaH-Katabatic'] }),
  ctf({ id: 'arxnovena', name: 'Arx Novena', theme: 'alpine', modes: ['ctf', 'blitz'], size: 1700, baseDist: 720, amp: 26, baseHill: 20,
    genBunker: [-70, -40], flagPlatform: [0, 90], towers: [[90, 60]], pad: [-40, 60],
    extra: [{ prefab: 'arch', x: 0, z: -120, yaw: 0 }, { prefab: 'ruin', x: 120, z: -40 }, { prefab: 'catwalk', x: -60, z: -230, len: 40 }],
    mid: [{ type: 'ridge', x: -300, z: 0, x2: 300, z2: 0, r: 60, h: 20 }],
    wiki: W('Arx_Novena'), internal: ['TrCTF-ArxNovena', 'TrCTFBlitz-ArxNovena'] }),
  ctf({ id: 'bellaomega', name: 'Bella Omega', theme: 'alien', modes: ['ctf', 'blitz'], size: 1900, baseDist: 860, amp: 32, ridged: 0.3, baseHill: 30,
    towers: [[-120, 100]], pad: [70, 30], turret2: [-40, 60],
    mid: [{ type: 'bowl', x: 0, z: 0, r: 220, h: -30 }, { type: 'hill', x: -300, z: -150, r: 110, h: 45 }],
    wiki: W('Bella_Omega'), internal: ['TrCTF-BellaOmega', 'TrCTFBlitz-BellaOmega', 'TrCTF-BellaOmegaNS'] }),
  ctf({ id: 'blueshift', name: 'Blueshift', theme: 'lunar', modes: ['ctf', 'blitz'], size: 1800, baseDist: 800, amp: 28, baseHill: 35,
    towers: [[100, 120]], pad: [-60, 20], turret2: [50, 30],
    mid: [{ type: 'crater', x: 0, z: 0, r: 140, h: 25, noMirror: true }, { type: 'crater', x: -320, z: -160, r: 80, h: 15 }],
    wiki: W('Blueshift'), internal: ['TrCTF-Blueshift', 'TrCTFBlitz-Blueshift'] }),
  ctf({ id: 'crossfire', name: 'Crossfire', theme: 'canyon', modes: ['ctf', 'blitz', 'rabbit'], size: 1700, baseDist: 760, amp: 30, ridged: 0.5, baseHill: 30,
    towers: [[-90, 110]], pad: [60, -20], turret2: [40, 50],
    mid: [{ type: 'channel', x: -600, z: 0, x2: 600, z2: 0, r: 90, h: -30 }],
    extra: [{ prefab: 'bridge', x: 0, z: 0, yaw: 0, len: 150, lift: 12, noMirror: true }, { prefab: 'rabbit_flag', x: 0, z: 0, lift: 12.4, flatten: 0, noMirror: true, modes: ['rabbit'] }, { prefab: 'spawn_ring', x: -200, z: -150, team: 0, modes: ['rabbit'] }],
    wiki: W('Crossfire'), internal: ['TrCTF-Crossfire', 'TrCTFBlitz-Crossfire', 'TrRabbit-Crossfire'] }),
  ctf({ id: 'canyoncrusade', name: 'Canyon Crusade Revival', theme: 'canyon', modes: ['ctf', 'blitz', 'cah'], size: 1600, baseDist: 700, amp: 26, ridged: 0.6, baseHill: 20,
    towers: [[80, 90]], pad: [-60, 0], turret2: [30, 45],
    mid: [{ type: 'valley', x: 0, z: -300, x2: 0, z2: 300, r: 80, h: -20, noMirror: true }, { type: 'ridge', x: -250, z: -100, x2: -250, z2: 100, r: 50, h: 35 }],
    cah: [{ tag: 'A', x: 0, z: -320 }, { tag: 'B', x: 0, z: 0 }, { tag: 'C', x: 0, z: 320 }],
    wiki: W('Canyon_Crusade_Revival'), internal: ['TrCTF-CanyonCrusadeRev', 'TrCTFBlitz-CanyonCrusadeRev', 'TrCaH-CanyonCrusadeRev'] }),
  ctf({ id: 'dangerouscrossing', name: 'Dangerous Crossing', theme: 'desert', modes: ['ctf'], size: 1800, baseDist: 820, amp: 24, baseHill: 30,
    towers: [[-100, 90]], pad: [60, 30], turret2: [-30, 50],
    mid: [{ type: 'channel', x: -700, z: 0, x2: 700, z2: 0, r: 110, h: -45 }],
    extra: [{ prefab: 'bridge', x: 0, z: 0, yaw: 0, len: 200, lift: 20, noMirror: true }, { prefab: 'bridge', x: 300, z: 0, yaw: 0, len: 200, lift: 20 }],
    wiki: W('Dangerous_Crossing'), internal: ['TrCTF-DangerousCrossing'] }),
  ctf({ id: 'drydock', name: 'Drydock', theme: 'industrial', modes: ['ctf', 'blitz'], size: 1800, baseDist: 800, amp: 22, baseHill: 18,
    genBunker: [80, -30], towers: [[-100, 80]], pad: [-50, 30], turret2: [50, 60],
    extra: [{ prefab: 'catwalk', x: -150, z: -150, len: 60 }, { prefab: 'crate_stack', x: 90, z: -200 }, { prefab: 'wall', x: -60, z: -180, len: 40 }],
    mid: [{ type: 'bowl', x: 0, z: 0, r: 260, h: -18, noMirror: true }],
    wiki: W('Drydock'), internal: ['TrCTF-Drydock', 'TrCTFBlitz-Drydock'] }),
  ctf({ id: 'permafrost', name: 'Permafrost', theme: 'ice', modes: ['ctf'], size: 1700, baseDist: 760, amp: 30, ridged: 0.3, baseHill: 30,
    towers: [[90, 100]], pad: [-60, 30], turret2: [30, 40],
    mid: [{ type: 'hill', x: -200, z: -60, r: 100, h: 40 }],
    wiki: W('Permafrost'), internal: ['TrCTF-Permafrost'] }),
  ctf({ id: 'raindance', name: 'Raindance', theme: 'lush', modes: ['ctf', 'cah'], size: 2000, baseDist: 900, amp: 30, baseHill: 25, baseX: -80,
    towers: [[120, 140]], pad: [-70, 20], turret2: [40, 40],
    mid: [{ type: 'hill', x: 0, z: 0, r: 160, h: 35, noMirror: true }, { type: 'valley', x: -400, z: -200, x2: 400, z2: 200, r: 60, h: -20, noMirror: true }],
    cah: [{ tag: 'A', x: -80, z: -450 }, { tag: 'B', x: -200, z: 60 }, { tag: 'C', x: 200, z: -60 }, { tag: 'D', x: 80, z: 450 }],
    wiki: W('Raindance'), internal: ['TrCTF-Raindance', 'TrCaH-Raindance'] }),
  ctf({ id: 'stonehenge', name: 'Stonehenge', theme: 'grassland', modes: ['ctf'], size: 1600, baseDist: 700, amp: 20, baseHill: 25,
    towers: [[-80, 80]], pad: [60, 20], turret2: [30, 40],
    extra: Array.from({ length: 8 }, (_, i) => ({ prefab: 'arch' as const, x: Math.cos((i / 8) * Math.PI) * 60, z: Math.sin((i / 8) * Math.PI) * 60, yaw: (i / 8) * Math.PI + Math.PI / 2 })),
    mid: [{ type: 'plateau', x: 0, z: 0, r: 90, h: 12, noMirror: true }],
    wiki: W('Stonehenge'), internal: ['TrCTF-Stonehenge2'] }),
  ctf({ id: 'sunstar', name: 'Sunstar', theme: 'sunset', modes: ['ctf'], size: 1800, baseDist: 800, amp: 28, ridged: 0.4, baseHill: 30,
    towers: [[100, 90]], pad: [-60, 20], turret2: [40, 50],
    mid: [{ type: 'ridge', x: -200, z: -200, x2: 200, z2: 200, r: 50, h: 30, noMirror: true }],
    wiki: W('Sunstar'), internal: ['TrCTF-SunStar'] }),
  ctf({ id: 'tartarus', name: 'Tartarus', theme: 'hellfire', modes: ['ctf', 'cah'], size: 1800, baseDist: 820, amp: 30, ridged: 0.6, baseHill: 35,
    towers: [[-110, 100]], pad: [60, 20], turret2: [40, 40],
    mid: [{ type: 'channel', x: -500, z: -60, x2: 500, z2: 60, r: 70, h: -40, noMirror: true }],
    cah: [{ tag: 'A', x: 0, z: -420 }, { tag: 'B', x: -220, z: 0 }, { tag: 'C', x: 220, z: 0 }, { tag: 'D', x: 0, z: 420 }],
    wiki: W('Tartarus'), internal: ['TrCTF-Tartarus', 'TrCaH-Tartarus'] }),
  ctf({ id: 'templeruins', name: 'Temple Ruins', theme: 'jungle', modes: ['ctf'], size: 1600, baseDist: 700, amp: 22, baseHill: 20,
    towers: [[90, 80]], pad: [-60, 20], turret2: [30, 45],
    extra: [{ prefab: 'ruin', x: -120, z: -80 }, { prefab: 'ruin', x: 60, z: -140 }, { prefab: 'arch', x: 0, z: -60 }, { prefab: 'pillar', x: -40, z: -200 }],
    wiki: W('Temple_Ruins'), internal: ['TrCTF-RuinsOfHarabec'] }),

  // ---------------- TDM / Rabbit / CaH arenas ----------------
  open({ id: 'drydocknight', name: 'Drydock Night', theme: 'industrial_night', modes: ['cah', 'rabbit', 'tdm'], size: 1200, bases: true,
    extra: [{ prefab: 'catwalk', x: -80, z: -80, len: 50 }, { prefab: 'crate_stack', x: 60, z: -120 }],
    cah: [{ tag: 'A', x: -200, z: 0 }, { tag: 'B', x: 0, z: 0 }, { tag: 'C', x: 200, z: 0 }],
    wiki: W('Drydock_Night'), internal: ['TrTeamRabbit-Drydock', 'TrCaH-Drydock'] }),
  open({ id: 'inferno', name: 'Inferno', theme: 'hellfire', modes: ['rabbit', 'tdm'], size: 1100, ridged: 0.6,
    extra: [{ prefab: 'pillar', x: -120, z: -60 }, { prefab: 'ruin', x: 80, z: -150 }],
    wiki: W('Inferno'), internal: ['TrTeamRabbit-Tartarus'] }),
  open({ id: 'nightabatic', name: 'Nightabatic', theme: 'ice_night', modes: ['rabbit', 'tdm'], size: 1300, ridged: 0.4,
    features: [{ type: 'hill', x: -200, z: -150, r: 100, h: 45 }],
    wiki: W('Nightabatic'), internal: ['TrTeamRabbit-NightKatabatic', 'TrRabbit-NightKatabatic'] }),
  open({ id: 'quicksand', name: 'Quicksand', theme: 'desert', modes: ['rabbit', 'tdm'], size: 1200,
    extra: [{ prefab: 'ruin', x: -100, z: -100 }, { prefab: 'arch', x: 120, z: -60 }],
    wiki: W('Quicksand'), internal: ['TrTeamRabbit-Harabec', 'TrRabbit-Harabec'] }),
  open({ id: 'outskirts', name: 'Outskirts', theme: 'urban', modes: ['rabbit', 'tdm'], size: 1200,
    extra: [{ prefab: 'gen_bunker', x: -120, z: -100, flatten: 12 }, { prefab: 'wall', x: 60, z: -160, len: 40 }],
    wiki: W('Outskirts'), internal: ['TrTeamRabbit-ArxNovena', 'TrRabbit-ArxNovena'] }),
  open({ id: 'outskirts3p', name: 'Outskirts 3P', theme: 'urban', modes: ['cah'], size: 1300, bases: true,
    cah: [{ tag: 'A', x: -250, z: 0 }, { tag: 'B', x: 0, z: 0 }, { tag: 'C', x: 250, z: 0 }],
    wiki: W('Outskirts'), internal: ['TrCaH-ArxOutskirts_3p'] }),
  open({ id: 'sulfurcove', name: 'Sulfur Cove', theme: 'sulfur', modes: ['cah', 'rabbit', 'tdm'], size: 1200, bases: true, ridged: 0.5,
    cah: [{ tag: 'A', x: -220, z: -80 }, { tag: 'B', x: 0, z: 0 }, { tag: 'C', x: 220, z: 80 }],
    wiki: W('Sulfur_Cove'), internal: ['TrTeamRabbit-CrossfireSmall', 'TrRabbit-CrossfireSmall', 'TrCaH-CrossfireSmall'] }),
  open({ id: 'miasma', name: 'Miasma', theme: 'swamp', modes: ['tdm'], size: 1100,
    features: [{ type: 'bowl', x: 0, z: 0, r: 200, h: -15, noMirror: true }],
    wiki: W('Miasma'), internal: ['TrTeamRabbit-BellaOmega'] }),

  // ---------------- Arena ----------------
  arena({ id: 'airarena', name: 'Air Arena', theme: 'arena_steel', size: 520, amp: 4,
    extra: [{ prefab: 'sniper_nest', x: -80, z: 0 }, { prefab: 'catwalk', x: 0, z: -60, len: 60 }, { prefab: 'pillar', x: 60, z: -30 }],
    wiki: W('Air_Arena'), internal: ['TrArena-Airarena'] }),
  arena({ id: 'fraytown', name: 'Fraytown', theme: 'urban', extra: [{ prefab: 'gen_bunker', x: -60, z: -40 }, { prefab: 'wall', x: 40, z: -30, len: 30 }, { prefab: 'crate_stack', x: 0, z: 0, noMirror: true }], wiki: W('Fraytown'), internal: ['TrArena-Fraytown'] }),
  arena({ id: 'hinterlands', name: 'Hinterlands', theme: 'grassland', size: 480, amp: 16, extra: [{ prefab: 'rock', x: -60, z: -30 }, { prefab: 'ruin', x: 50, z: -60 }], wiki: W('Hinterlands'), internal: ['TrArena-Hinterland'] }),
  arena({ id: 'lavaarena', name: 'Lava Arena', theme: 'arena_lava', features: [{ type: 'bowl', x: 0, z: 0, r: 110, h: -14, noMirror: true }], extra: [{ prefab: 'bridge', x: 0, z: 0, yaw: 0, len: 120, lift: 12, noMirror: true }, { prefab: 'pillar', x: -70, z: -50 }], wiki: W('Lava_Arena'), internal: ['TrArena-Lavarena'] }),
  arena({ id: 'undercroft', name: 'Undercroft', theme: 'arena_steel', amp: 6, extra: [{ prefab: 'arch', x: -40, z: -30 }, { prefab: 'wall', x: 50, z: -40, len: 24 }, { prefab: 'catwalk', x: 0, z: 0, len: 40, noMirror: true }], wiki: W('Undercroft'), internal: ['TrArena-Undercroft'] }),
  arena({ id: 'walledin', name: 'Walled In', theme: 'arena_steel', amp: 5,
    extra: [{ prefab: 'wall', x: 0, z: -40, len: 60 }, { prefab: 'wall', x: -60, z: 0, yaw: Math.PI / 2, len: 50 }, { prefab: 'ramp', x: 30, z: -70, len: 16 }],
    wiki: W('Walled_In'), internal: ['TrArena-Walledin'] }),
  arena({ id: 'whiteout', name: 'Whiteout', theme: 'arena_snow', amp: 12, extra: [{ prefab: 'rock', x: -40, z: -40 }, { prefab: 'ice_spike', x: 60, z: -20 }], wiki: W('Whiteout'), internal: ['TrArena-Whiteout'] }),

  // ---------------- Training ----------------
  {
    id: 'skitraining', name: 'Ski Training', theme: 'alpine', modes: ['training'], size: 2000, res: 321, seed: 4242, baseHeight: 0,
    noise: { amp: 50, scale: 260, octaves: 4 }, edge: { start: 0.8, height: 200 }, mirror: 'none', scatter: 0.3,
    features: [{ type: 'plateau', x: 0, z: -700, r: 80, h: 60 }],
    prefabs: [{ prefab: 'tower', x: 0, z: -700, team: 0, yaw: R }, { prefab: 'vehicle_pad', x: 40, z: -680, team: 0, yaw: R, modes: ['training'] }, { prefab: 'spawn_ring', x: 0, z: -700, team: 0, len: 10 }],
    internal: ['TrTraining-SkiTutorial'],
  },
];

export const LAYOUT_BY_ID: Record<string, MapSpec> = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

export function mapsForMode(mode: ModeId): MapSpec[] {
  return LAYOUTS.filter((l) => l.modes.includes(mode));
}
