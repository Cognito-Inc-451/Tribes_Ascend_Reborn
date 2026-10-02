// Source tags: F = tribes.fandom.com, TD = wiki.tribesdepot.com, est = estimated (pending Phase 0 measurement).

export type ItemSlot = 'primary' | 'secondary' | 'belt' | 'pack';
export type ProjectileModel = 'disc' | 'grenade' | 'bolt' | 'plasma' | 'mortar' | 'rocket' | 'knife' | 'mine' | 'nova' | 'saber';

export interface ProjectileDef {
  speed: number;          // m/s
  gravity: number;        // multiplier of world gravity
  inherit: number;        // fraction of shooter velocity added
  lifetime: number;       // s; explodes at end if `explodeOnExpire`
  explodeOnExpire?: boolean;
  radius: number;         // splash radius (m)
  direct: number;         // damage on direct hit
  splashMax: number;
  splashMin: number;
  impulse: number;        // knockback impulse (kg*m/s) at center
  bounce?: number;        // restitution; bounces instead of exploding on terrain
  bounces?: number;       // max bounces before exploding (nova)
  sticky?: boolean;
  fuse?: number;          // explodes after this many seconds regardless
  remote?: boolean;       // detonated by alt fire
  homing?: number;        // turn rate rad/s toward locked target
  split?: { count: number; spread: number; damage: number; radius: number };
  size: number;           // collision radius vs players
  model: ProjectileModel;
  color: number;
}

export interface HitscanDef {
  damage: number;
  minDamage: number;
  falloffStart: number;
  falloffEnd: number;
  pellets: number;
  spread: number; // radians (cone half-angle)
  range: number;
}

export type WeaponKind = 'projectile' | 'hitscan' | 'melee' | 'lance' | 'repair' | 'deploy' | 'passive' | 'toggle' | 'burst';

export interface ItemDef {
  id: string;
  name: string;
  slot: ItemSlot;
  kind: WeaponKind;
  clip: number;
  ammo: number;
  reload: number;
  refire: number;
  spinup?: number;
  burst?: { count: number; interval: number };
  projectile?: ProjectileDef;
  hitscan?: HitscanDef;
  energyCost?: number;   // per shot / activation
  energyDrain?: number;  // per second while toggled
  chargeTime?: number;   // sniper charge
  zoom?: number;         // FOV multiplier when zoomed
  explosive: boolean;    // can damage armored targets
  deploy?: string;       // deployable id
  passive?: Partial<PassiveMods>;
  src: string;
}

export interface PassiveMods {
  health: number; energy: number; regenMult: number; runMult: number; beltExtra: number; healthRegenMult: number; massMult: number;
}

// Impulses are TA MomentumTransfer (uu*kg/s): velocity change = impulse / mass / 50. Gravity is TA CustomGravityScaling.
const disc = (direct: number, splashMax: number, splashMin: number, radius: number, o: Partial<ProjectileDef> = {}): ProjectileDef => ({
  speed: 78.4, gravity: 0, inherit: 0.5, lifetime: 6, radius, direct, splashMax, splashMin, impulse: 85000, size: 0.2, model: 'disc', color: 0x9fe8ff, ...o,
});
const hs = (damage: number, minDamage: number, o: Partial<HitscanDef> = {}): HitscanDef => ({
  damage, minDamage, falloffStart: 20, falloffEnd: 90, pellets: 1, spread: 0.012, range: 400, ...o,
});
const gren = (direct: number, splashMax: number, splashMin: number, radius: number, o: Partial<ProjectileDef> = {}): ProjectileDef => ({
  speed: 28, gravity: 0.5, inherit: 0.5, lifetime: 8, explodeOnExpire: true, radius, direct, splashMax, splashMin, impulse: 85000, bounce: 0.35, fuse: 2, size: 0.15, model: 'grenade', color: 0xffc040, ...o,
});

type W = Omit<ItemDef, 'explosive'> & { explosive?: boolean };
const item = (w: W): ItemDef => ({ explosive: !!w.projectile, ...w });

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(([
  // ---------- Spinfusor family (TD/Spinfusor_Comparison: 78 m/s, 50% inheritance, 6 s life) ----------
  item({ id: 'light_spinfusor', name: 'Light Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.24, refire: 1.24, projectile: disc(770, 550, 275, 7.2), src: 'F/Light_Spinfusor' }),
  item({ id: 'dueling_spinfusor', name: 'Dueling Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.24, refire: 1.24, projectile: disc(880, 550, 275, 6.8), src: 'TD/SC' }),
  item({ id: 'blinksfusor', name: 'Blinksfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.24, refire: 1.24, projectile: disc(770, 550, 275, 6.8, { inherit: 1 }), src: 'TD/SC' }),
  item({ id: 'stealth_spinfusor', name: 'Stealth Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.24, refire: 1.24, projectile: disc(700, 500, 250, 7.2), src: 'TD/SC' }),
  item({ id: 'spinfusor', name: 'Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.5, refire: 1.5, projectile: disc(910, 650, 325, 7.2), src: 'F/Spinfusor' }),
  item({ id: 'spare_spinfusor', name: 'Spare Spinfusor', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.5, refire: 1.5, projectile: disc(660, 600, 300, 7.2), src: 'TD/SC' }),
  item({ id: 'spinfusor_mkd', name: 'Spinfusor MKD', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.5, refire: 1.5, projectile: disc(840, 600, 300, 7.8), src: 'TD/SC' }),
  item({ id: 'spinfusor_mkx', name: 'Spinfusor MK-X', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 29, reload: 1.5, refire: 1.5, projectile: disc(924, 660, 330, 7.2), src: 'TD/SC' }),
  item({ id: 'heavy_spinfusor', name: 'Heavy Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 31, reload: 1.8, refire: 1.8, projectile: disc(1050, 750, 375, 7.2), src: 'TD/SC' }),
  item({ id: 'devastator_spinfusor', name: 'Devastator Spinfusor', slot: 'primary', kind: 'projectile', clip: 1, ammo: 31, reload: 1.8, refire: 1.8, projectile: disc(1204, 700, 350, 7.8), src: 'TD/SC' }),
  item({ id: 'light_twinfusor', name: 'Light Twinfusor', slot: 'primary', kind: 'projectile', clip: 2, ammo: 38, reload: 1.4, refire: 0.35, projectile: disc(532, 380, 190, 6, { impulse: 42500 }), src: 'TD/SC' }),
  item({ id: 'twinfusor', name: 'Twinfusor', slot: 'primary', kind: 'projectile', clip: 2, ammo: 38, reload: 1.6, refire: 0.35, projectile: disc(574, 410, 205, 6, { impulse: 42500 }), src: 'TD/SC' }),
  item({ id: 'heavy_twinfusor', name: 'Heavy Twinfusor', slot: 'secondary', kind: 'projectile', clip: 2, ammo: 38, reload: 1.9, refire: 0.35, projectile: disc(616, 440, 220, 6, { impulse: 45000 }), src: 'TD/SC' }),

  // ---------- Pathfinder ----------
  item({ id: 'bolt_launcher', name: 'Bolt Launcher', slot: 'primary', kind: 'projectile', clip: 1, ammo: 24, reload: 1.3, refire: 1.3, projectile: { speed: 76.4, gravity: 0.4, inherit: 0.5, lifetime: 6, radius: 8, direct: 877, splashMax: 650, splashMin: 325, impulse: 85000, size: 0.2, model: 'bolt', color: 0xff8a3a }, src: 'F/Pathfinder; TA TrProj_BoltLauncher' }),
  item({ id: 'shotgun', name: 'Shotgun', slot: 'secondary', kind: 'hitscan', clip: 6, ammo: 56, reload: 2.2, refire: 0.9, hitscan: hs(80, 30, { pellets: 8, spread: 0.07, falloffStart: 6, falloffEnd: 30, range: 60 }), src: 'TD/Shotgun' }),
  item({ id: 'light_assault_rifle', name: 'Light Assault Rifle', slot: 'secondary', kind: 'burst', clip: 24, ammo: 192, reload: 1.6, refire: 0.42, burst: { count: 3, interval: 0.07 }, hitscan: hs(80, 60), src: 'F/Pathfinder' }),
  item({ id: 'holdout_shotgun', name: 'Holdout Shotgun', slot: 'secondary', kind: 'hitscan', clip: 5, ammo: 45, reload: 2.2, refire: 0.9, hitscan: hs(90, 30, { pellets: 8, spread: 0.08, falloffStart: 5, falloffEnd: 25, range: 50 }), src: 'F/Pathfinder' }),
  item({ id: 'shocklance', name: 'Shocklance', slot: 'secondary', kind: 'lance', clip: 1, ammo: 99, reload: 0, refire: 1.6, energyCost: 10, hitscan: hs(700, 700, { range: 6, spread: 0 }), src: 'F/Shocklance' }),

  // ---------- Sentinel ----------
  item({ id: 'bxt1', name: 'BXT1 Rifle', slot: 'primary', kind: 'hitscan', clip: 6, ammo: 45, reload: 2.0, refire: 1.2, chargeTime: 3, zoom: 0.25, hitscan: hs(500, 10, { spread: 0, falloffStart: 999, falloffEnd: 1000, range: 1200 }), src: 'F/Sentinel' }),
  item({ id: 'bxt1a', name: 'BXT1-A Rifle', slot: 'primary', kind: 'hitscan', clip: 6, ammo: 45, reload: 2.0, refire: 1.0, chargeTime: 2.5, zoom: 0.3, hitscan: hs(500, 10, { spread: 0, falloffStart: 999, falloffEnd: 1000, range: 1200 }), src: 'F/Sentinel' }),
  item({ id: 'phase_rifle', name: 'Phase Rifle', slot: 'primary', kind: 'hitscan', clip: 5, ammo: 37, reload: 2.4, refire: 1.5, energyCost: 0, zoom: 0.25, hitscan: hs(510, 125, { spread: 0, falloffStart: 999, falloffEnd: 1000, range: 1200 }), src: 'TD/Phase_Rifle' }),
  item({ id: 'sap20', name: 'SAP20', slot: 'primary', kind: 'hitscan', clip: 4, ammo: 32, reload: 2.2, refire: 1.4, energyCost: 100, zoom: 0.3, hitscan: hs(575, 575, { spread: 0, falloffStart: 999, falloffEnd: 1000, range: 1200 }), src: 'F/Sentinel' }),
  item({ id: 'nova_blaster', name: 'Nova Blaster', slot: 'secondary', kind: 'projectile', clip: 5, ammo: 40, reload: 1.7, refire: 0.45, projectile: { speed: 90, gravity: 0, inherit: 0.5, lifetime: 3, radius: 1.8, direct: 350, splashMax: 120, splashMin: 40, impulse: 12000, bounces: 2, size: 0.18, model: 'nova', color: 0x7affc8 }, src: 'F/Sentinel,est' }),
  item({ id: 'nova_blaster_mx', name: 'Nova Blaster MX', slot: 'secondary', kind: 'projectile', clip: 7, ammo: 56, reload: 1.7, refire: 0.3, projectile: { speed: 95, gravity: 0, inherit: 0.5, lifetime: 3, radius: 1.6, direct: 250, splashMax: 90, splashMin: 30, impulse: 10000, bounces: 2, size: 0.18, model: 'nova', color: 0x7affc8 }, src: 'F/Sentinel,est' }),
  item({ id: 'falcon', name: 'Falcon', slot: 'secondary', kind: 'hitscan', clip: 12, ammo: 96, reload: 1.3, refire: 0.2, hitscan: hs(65, 47), src: 'F/Sentinel' }),
  item({ id: 'accurized_shotgun', name: 'Accurized Shotgun', slot: 'secondary', kind: 'hitscan', clip: 5, ammo: 45, reload: 2.2, refire: 0.9, hitscan: hs(70, 30, { pellets: 8, spread: 0.045, falloffStart: 8, falloffEnd: 40, range: 70 }), src: 'F/Sentinel' }),

  // ---------- Infiltrator ----------
  item({ id: 'rhino_smg', name: 'Rhino SMG', slot: 'primary', kind: 'hitscan', clip: 30, ammo: 356, reload: 1.2, refire: 0.095, hitscan: hs(70, 49, { spread: 0.03 }), src: 'TD/Rhino_SMG' }),
  item({ id: 'arctic_rhino_smg', name: 'Arctic Rhino SMG', slot: 'primary', kind: 'hitscan', clip: 30, ammo: 356, reload: 1.2, refire: 0.11, hitscan: hs(80, 56, { spread: 0.028 }), src: 'F/Infiltrator' }),
  item({ id: 'jackal', name: 'Jackal', slot: 'primary', kind: 'projectile', clip: 3, ammo: 27, reload: 1.8, refire: 0.5, projectile: { speed: 50, gravity: 0.9, inherit: 0.5, lifetime: 30, radius: 6, direct: 0, splashMax: 400, splashMin: 250, impulse: 30000, sticky: true, remote: true, size: 0.15, model: 'grenade', color: 0xff5050 }, src: 'F/Infiltrator,est' }),
  item({ id: 'sn7', name: 'SN7 Silenced Pistol', slot: 'secondary', kind: 'hitscan', clip: 10, ammo: 80, reload: 1.2, refire: 0.2, hitscan: hs(170, 127), src: 'F/Infiltrator' }),
  item({ id: 'arctic_sn7', name: 'Arctic SN7', slot: 'secondary', kind: 'hitscan', clip: 10, ammo: 80, reload: 1.2, refire: 0.22, hitscan: hs(180, 135), src: 'F/Infiltrator' }),
  item({ id: 'throwing_knives', name: 'Throwing Knives', slot: 'secondary', kind: 'projectile', clip: 3, ammo: 24, reload: 1.5, refire: 0.5, projectile: { speed: 60, gravity: 0.5, inherit: 0.5, lifetime: 4, radius: 2, direct: 375, splashMax: 100, splashMin: 50, impulse: 5000, size: 0.12, model: 'knife', color: 0xcccccc }, src: 'F/Infiltrator,est' }),

  // ---------- Soldier ----------
  item({ id: 'assault_rifle', name: 'Assault Rifle', slot: 'primary', kind: 'hitscan', clip: 28, ammo: 268, reload: 1.71, refire: 0.105, hitscan: hs(80, 60, { spread: 0.022 }), src: 'TD/Assault_Rifle' }),
  item({ id: 'gasts_rifle', name: "Gast's Rifle", slot: 'primary', kind: 'hitscan', clip: 24, ammo: 240, reload: 1.71, refire: 0.12, hitscan: hs(85, 63, { spread: 0.018 }), src: 'F/Soldier' }),
  item({ id: 'thumper_d', name: 'Thumper D', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 26, reload: 1.5, refire: 1.5, projectile: { speed: 70.4, gravity: 0.7, inherit: 0.5, lifetime: 1.2, explodeOnExpire: true, radius: 7.4, direct: 770, splashMax: 550, splashMin: 275, impulse: 70000, size: 0.2, model: 'grenade', color: 0xffa040 }, src: 'TD/Thumper_DX' }),
  item({ id: 'thumper_dx', name: 'Thumper DX', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 26, reload: 1.5, refire: 1.5, projectile: { speed: 70.4, gravity: 0.7, inherit: 0.5, lifetime: 1.2, explodeOnExpire: true, radius: 7.4, direct: 840, splashMax: 600, splashMin: 300, impulse: 70000, size: 0.2, model: 'grenade', color: 0xffa040 }, src: 'TD/Thumper_DX' }),
  item({ id: 'eagle_pistol', name: 'Eagle Pistol', slot: 'secondary', kind: 'hitscan', clip: 8, ammo: 64, reload: 1.3, refire: 0.25, hitscan: hs(100, 39), src: 'F/Soldier' }),

  // ---------- Technician ----------
  item({ id: 'tcn4_smg', name: 'TCN4 SMG', slot: 'primary', kind: 'hitscan', clip: 30, ammo: 300, reload: 1.3, refire: 0.1, hitscan: hs(80, 56, { spread: 0.028 }), src: 'F/Technician' }),
  item({ id: 'tcn4_rockwind', name: 'TCN4 Rockwind', slot: 'primary', kind: 'hitscan', clip: 20, ammo: 220, reload: 1.3, refire: 0.14, hitscan: hs(105, 76, { spread: 0.024 }), src: 'F/Technician' }),
  item({ id: 'thumper', name: 'Thumper', slot: 'primary', kind: 'projectile', clip: 1, ammo: 24, reload: 1.5, refire: 1.5, projectile: { speed: 70.4, gravity: 0.7, inherit: 0.5, lifetime: 2, explodeOnExpire: true, radius: 8, direct: 910, splashMax: 650, splashMin: 329, impulse: 85000, size: 0.2, model: 'grenade', color: 0xffa040 }, src: 'F/Technician; TA TrProj_Thumper' }),
  item({ id: 'tc24', name: 'TC24', slot: 'primary', kind: 'projectile', clip: 3, ammo: 27, reload: 1.8, refire: 0.6, projectile: { speed: 70, gravity: 0.5, inherit: 0.5, lifetime: 0.9, explodeOnExpire: true, radius: 6, direct: 425, splashMax: 425, splashMin: 185, impulse: 30000, size: 0.18, model: 'grenade', color: 0xffd060 }, src: 'F/Technician,est' }),
  item({ id: 'repair_tool', name: 'Improved Repair Tool', slot: 'secondary', kind: 'repair', clip: 1, ammo: 1, reload: 0, refire: 0.1, hitscan: hs(20, 20, { range: 12, spread: 0 }), src: 'TD/Generator (200/s)' }),
  item({ id: 'lr_repair_tool', name: 'Long Range Repair Tool', slot: 'secondary', kind: 'repair', clip: 1, ammo: 1, reload: 0, refire: 0.1, hitscan: hs(15, 15, { range: 25, spread: 0 }), src: 'F/Technician' }),
  item({ id: 'sawed_off', name: 'Sawed-Off Shotgun', slot: 'secondary', kind: 'hitscan', clip: 2, ammo: 30, reload: 1.8, refire: 0.3, hitscan: hs(80, 31, { pellets: 8, spread: 0.09, falloffStart: 4, falloffEnd: 22, range: 40 }), src: 'F/Technician' }),
  item({ id: 'sparrow', name: 'Sparrow', slot: 'secondary', kind: 'hitscan', clip: 12, ammo: 96, reload: 1.2, refire: 0.18, hitscan: hs(90, 35), src: 'F/Technician' }),

  // ---------- Raider ----------
  item({ id: 'arx_buster', name: 'Arx Buster', slot: 'primary', kind: 'burst', clip: 3, ammo: 42, reload: 1.71, refire: 1.0, burst: { count: 3, interval: 0.245 }, projectile: { speed: 76.4, gravity: 0.3, inherit: 0.5, lifetime: 5, radius: 7, direct: 600, splashMax: 600, splashMin: 300, impulse: 68000, size: 0.2, model: 'bolt', color: 0xff6040 }, src: 'TD/Arx_Buster; TA TrProj_ArxBuster' }),
  item({ id: 'grenade_launcher', name: 'Grenade Launcher', slot: 'primary', kind: 'projectile', clip: 5, ammo: 38, reload: 2.0, refire: 0.6, projectile: { speed: 54, gravity: 0.8, inherit: 0.5, lifetime: 1.5, explodeOnExpire: true, radius: 10, direct: 550, splashMax: 550, splashMin: 275, impulse: 68000, bounce: 0.35, size: 0.18, model: 'grenade', color: 0xffc040 }, src: 'TD/Grenade_Launcher; TA TrProj_GrenadeLauncher' }),
  item({ id: 'plasma_gun', name: 'Plasma Gun', slot: 'primary', kind: 'projectile', clip: 10, ammo: 80, reload: 1.8, refire: 0.3, projectile: { speed: 78.4, gravity: 0, inherit: 0.5, lifetime: 4, radius: 5, direct: 500, splashMax: 220, splashMin: 90, impulse: 25000, size: 0.2, model: 'plasma', color: 0x60ff90 }, src: 'F/Raider; TA TrProj_PlasmaGun' }),
  item({ id: 'dust_devil', name: 'Dust Devil', slot: 'primary', kind: 'projectile', clip: 3, ammo: 30, reload: 1.8, refire: 0.5, projectile: { speed: 70, gravity: 0.5, inherit: 0.5, lifetime: 2.5, explodeOnExpire: true, radius: 5, direct: 500, splashMax: 500, splashMin: 325, impulse: 25000, sticky: true, fuse: 1.2, size: 0.18, model: 'grenade', color: 0xd0a060 }, src: 'F/Raider,est' }),
  item({ id: 'nj4_smg', name: 'NJ4 SMG', slot: 'secondary', kind: 'hitscan', clip: 28, ammo: 276, reload: 1.3, refire: 0.105, hitscan: hs(75, 52, { spread: 0.028 }), src: 'TD/NJ4_SMG' }),
  item({ id: 'nj5b_smg', name: 'NJ5-B SMG', slot: 'secondary', kind: 'hitscan', clip: 16, ammo: 160, reload: 1.3, refire: 0.19, hitscan: hs(140, 98, { spread: 0.022 }), src: 'F/Raider' }),
  item({ id: 'desert_nj4', name: 'Desert NJ4 SMG', slot: 'secondary', kind: 'hitscan', clip: 30, ammo: 300, reload: 1.3, refire: 0.09, hitscan: hs(70, 49, { spread: 0.03 }), src: 'F/Raider' }),

  // ---------- Juggernaut ----------
  item({ id: 'fusion_mortar', name: 'Fusion Mortar', slot: 'primary', kind: 'projectile', clip: 1, ammo: 26, reload: 1.8, refire: 1.8, projectile: { speed: 80, gravity: 0.8, inherit: 0.5, lifetime: 20, radius: 13, direct: 1300, splashMax: 1300, splashMin: 600, impulse: 110000, size: 0.3, model: 'mortar', color: 0x8cff4a }, src: 'TD/Fusion_Mortar; TA TrProj_MortarLauncher' }),
  item({ id: 'fusion_mortar_deluxe', name: 'Fusion Mortar Deluxe', slot: 'primary', kind: 'projectile', clip: 1, ammo: 26, reload: 1.8, refire: 1.8, projectile: { speed: 70, gravity: 0.8, inherit: 0.5, lifetime: 20, radius: 14, direct: 1400, splashMax: 1400, splashMin: 700, impulse: 110000, size: 0.3, model: 'mortar', color: 0x8cff4a }, src: 'F/Juggernaut; TA TrProj_LR1Mortar' }),
  item({ id: 'mirv_launcher', name: 'MIRV Launcher', slot: 'primary', kind: 'projectile', clip: 1, ammo: 20, reload: 2.2, refire: 2.2, projectile: { speed: 72, gravity: 0.8, inherit: 0.5, lifetime: 20, radius: 4, direct: 100, splashMax: 100, splashMin: 50, impulse: 20000, split: { count: 4, spread: 7, damage: 450, radius: 11 }, size: 0.3, model: 'mortar', color: 0xb6ff4a }, src: 'F/Juggernaut; TA TrProj_MIRVLauncher' }),
  item({ id: 'x1_lmg', name: 'X1 LMG', slot: 'secondary', kind: 'hitscan', clip: 60, ammo: 360, reload: 2.4, refire: 0.1, spinup: 0.5, hitscan: hs(75, 50, { spread: 0.03 }), src: 'F/Juggernaut' }),

  // ---------- Doombringer ----------
  item({ id: 'chain_gun', name: 'Chain Gun', slot: 'primary', kind: 'hitscan', clip: 250, ammo: 250, reload: 0, refire: 0.105, spinup: 1.4, hitscan: hs(95, 71, { spread: 0.035 }), src: 'TD/Chain_Gun' }),
  item({ id: 'chain_cannon', name: 'Chain Cannon', slot: 'primary', kind: 'hitscan', clip: 200, ammo: 200, reload: 0, refire: 0.13, spinup: 1.2, hitscan: hs(115, 90, { spread: 0.04 }), src: 'F/Doombringer' }),
  item({ id: 'heavy_bolt_launcher', name: 'Heavy Bolt Launcher', slot: 'primary', kind: 'projectile', clip: 1, ammo: 30, reload: 1.6, refire: 1.6, projectile: { speed: 76.4, gravity: 0.4, inherit: 0.5, lifetime: 6, explodeOnExpire: true, radius: 8, direct: 1050, splashMax: 750, splashMin: 375, impulse: 85000, size: 0.25, model: 'bolt', color: 0xff7a2a }, src: 'TD/Heavy_Bolt_Launcher; TA TrProj_HeavyBoltLauncher' }),
  item({ id: 'saber_launcher', name: 'Saber Launcher', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 12, reload: 2.5, refire: 2.5, chargeTime: 3, projectile: { speed: 60, gravity: 0, inherit: 0, lifetime: 10, radius: 4, direct: 1000, splashMax: 1000, splashMin: 400, impulse: 30000, homing: 2.2, size: 0.3, model: 'saber', color: 0xff4040 }, src: 'TD/Saber_Launcher,est' }),
  item({ id: 'titan_launcher', name: 'Titan Launcher', slot: 'secondary', kind: 'projectile', clip: 1, ammo: 20, reload: 1.8, refire: 1.8, projectile: { speed: 80, gravity: 0, inherit: 0.5, lifetime: 1.0, explodeOnExpire: true, radius: 7, direct: 814, splashMax: 650, splashMin: 325, impulse: 60000, size: 0.25, model: 'rocket', color: 0xffb040 }, src: 'F/Doombringer,est' }),

  // ---------- Brute ----------
  item({ id: 'gladiator', name: 'Gladiator', slot: 'primary', kind: 'projectile', clip: 1, ammo: 26, reload: 1.8, refire: 1.8, projectile: { speed: 70, gravity: 0.3, inherit: 0.5, lifetime: 6, radius: 7, direct: 1120, splashMax: 800, splashMin: 300, impulse: 65000, size: 0.25, model: 'disc', color: 0xffe07a }, src: 'F/Brute,est' }),
  item({ id: 'auto_shotgun', name: 'Automatic Shotgun', slot: 'secondary', kind: 'hitscan', clip: 8, ammo: 64, reload: 2.4, refire: 0.3, hitscan: hs(50, 19, { pellets: 8, spread: 0.08, falloffStart: 5, falloffEnd: 25, range: 50 }), src: 'F/Brute' }),
  item({ id: 'nova_colt', name: 'Nova Colt', slot: 'secondary', kind: 'hitscan', clip: 6, ammo: 48, reload: 1.6, refire: 0.3, hitscan: hs(190, 124), src: 'F/Brute' }),
  item({ id: 'plasma_cannon', name: 'Plasma Cannon', slot: 'secondary', kind: 'projectile', clip: 3, ammo: 27, reload: 1.8, refire: 0.9, projectile: { speed: 78.4, gravity: 0, inherit: 0.5, lifetime: 5, radius: 5.5, direct: 575, splashMax: 575, splashMin: 220, impulse: 25000, size: 0.25, model: 'plasma', color: 0x60ff90 }, src: 'F/Brute; TA TrProj_PlasmaCannon' }),
  item({ id: 'the_hammer', name: 'The Hammer', slot: 'secondary', kind: 'hitscan', clip: 4, ammo: 32, reload: 2.2, refire: 0.9, hitscan: hs(60, 25, { pellets: 8, spread: 0.06, falloffStart: 6, falloffEnd: 30, range: 50 }), src: 'F/Brute' }),

  // ---------- Belt items ----------
  item({ id: 'impact_nitron', name: 'Impact Nitron', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: gren(300, 100, 50, 5.5, { bounce: undefined, fuse: undefined, explodeOnExpire: true, impulse: 95000 }), src: 'TD/Impact_Nitron' }),
  item({ id: 'explosive_nitron', name: 'Explosive Nitron', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(650, 650, 190, 7, { bounce: undefined, fuse: undefined, explodeOnExpire: true }), src: 'F/Pathfinder' }),
  item({ id: 'compact_nitron', name: 'Compact Nitron', slot: 'belt', kind: 'projectile', clip: 4, ammo: 4, reload: 0, refire: 0.8, projectile: gren(300, 90, 45, 4.5, { bounce: undefined, fuse: undefined, explodeOnExpire: true, impulse: 80000 }), src: 'F/Pathfinder' }),
  item({ id: 'claymore', name: 'Claymore Mine', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'claymore', src: 'F/Sentinel' }),
  item({ id: 'focused_claymore', name: 'Focused Claymore', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'focused_claymore', src: 'F/Sentinel' }),
  item({ id: 'motion_mine', name: 'Motion Mine', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'motion_mine', src: 'F/Sentinel' }),
  item({ id: 't5_grenade', name: 'T5 Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(812, 580, 330, 7), src: 'F/Sentinel' }),
  item({ id: 'sticky_grenade', name: 'Sticky Grenades', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(1200, 1200, 300, 6, { sticky: true, bounce: undefined }), src: 'F/Infiltrator' }),
  item({ id: 'sticky_xl', name: 'Sticky Grenades XL', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: gren(1000, 1000, 250, 6, { sticky: true, bounce: undefined }), src: 'F/Infiltrator' }),
  item({ id: 'prism_mines', name: 'Prism Mines', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'prism_mine', src: 'F/Infiltrator' }),
  item({ id: 'smoke_grenade', name: 'Smoke Grenades', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, explosive: false, projectile: gren(0, 0, 0, 8, { impulse: 0 }), src: 'F/Infiltrator' }),
  item({ id: 'frag_xl', name: 'Frag Grenade XL', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.87, projectile: gren(1000, 1000, 300, 7), src: 'TD/Frag_Grenade_XL' }),
  item({ id: 'ap_grenade', name: 'Anti-Personnel Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(1200, 1200, 200, 5), src: 'F/Soldier' }),
  item({ id: 'proximity_grenade', name: 'Proximity Grenade', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: gren(620, 620, 200, 6, { fuse: 20, bounce: 0.1 }), src: 'F/Soldier' }),
  item({ id: 'short_fuse_frag', name: 'Short-Fuse Frag', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(900, 900, 250, 6.5, { fuse: 0.9 }), src: 'F/Soldier' }),
  item({ id: 'tcng', name: 'TCNG', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(1000, 1000, 250, 6.5, { bounce: undefined, fuse: undefined, explodeOnExpire: true }), src: 'F/Technician' }),
  item({ id: 'tcng_quickfuse', name: 'TCNG Quickfuse', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(800, 800, 250, 7.5, { bounce: undefined, fuse: undefined, explodeOnExpire: true }), src: 'F/Technician' }),
  item({ id: 'motion_sensor', name: 'Motion Sensor', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'motion_sensor', src: 'F/Technician' }),
  item({ id: 'repair_kit', name: 'Repair Kit', slot: 'belt', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 0.8, deploy: 'repair_kit', src: 'F/Technician' }),
  item({ id: 'emp_grenade', name: 'EMP Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(600, 600, 200, 7, { color: 0x60c0ff }), src: 'F/Raider' }),
  item({ id: 'emp_xl', name: 'EMP Grenade XL', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: gren(500, 500, 180, 7, { color: 0x60c0ff }), src: 'F/Raider' }),
  item({ id: 'cluster_grenade', name: 'Cluster Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(400, 400, 150, 5, { split: { count: 5, spread: 6, damage: 425, radius: 5 } }), src: 'F/Raider' }),
  item({ id: 'whiteout_grenade', name: 'Whiteout Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(50, 50, 15, 10, { color: 0xffffff }), src: 'F/Raider' }),
  item({ id: 'heavy_ap', name: 'Heavy AP Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(1500, 1500, 450, 6), src: 'F/Juggernaut' }),
  item({ id: 'heavy_ap_xl', name: 'Heavy AP XL', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: gren(1300, 1300, 390, 6), src: 'F/Juggernaut' }),
  item({ id: 'spinfusor_disc', name: 'Spinfusor Disc', slot: 'belt', kind: 'projectile', clip: 3, ammo: 3, reload: 0, refire: 0.8, projectile: disc(910, 650, 325, 7.2, { speed: 60 }), src: 'F/Juggernaut' }),
  item({ id: 'frag_grenade', name: 'Frag Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(800, 800, 250, 7), src: 'F/Doombringer' }),
  item({ id: 'mines', name: 'Mines', slot: 'belt', kind: 'deploy', clip: 3, ammo: 3, reload: 0, refire: 0.8, deploy: 'mine', src: 'F/Doombringer' }),
  item({ id: 'defective_frag', name: 'Defective Frag', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(700, 700, 250, 9, { fuse: 2.4 }), src: 'F/Doombringer' }),
  item({ id: 'fractal_grenade', name: 'Fractal Grenade', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(410, 410, 150, 6, { split: { count: 6, spread: 5, damage: 410, radius: 5 } }), src: 'F/Brute' }),
  item({ id: 'extended_fractal', name: 'Extended Fractal', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(390, 390, 140, 6, { split: { count: 8, spread: 7, damage: 390, radius: 5 } }), src: 'F/Brute' }),
  item({ id: 'light_sticky', name: 'Light Sticky', slot: 'belt', kind: 'projectile', clip: 2, ammo: 2, reload: 0, refire: 0.8, projectile: gren(1100, 1100, 300, 5.5, { sticky: true, bounce: undefined }), src: 'F/Brute' }),

  // ---------- Packs ----------
  item({ id: 'energy_recharge_pack', name: 'Energy Recharge Pack', slot: 'pack', kind: 'passive', clip: 0, ammo: 0, reload: 0, refire: 0, passive: { regenMult: 1.12 }, src: 'TD/Energy_Recharge_Pack' }),
  item({ id: 'thrust_pack', name: 'Thrust Pack', slot: 'pack', kind: 'toggle', clip: 0, ammo: 0, reload: 0, refire: 3, energyCost: 40, src: 'F/Thrust_Pack' }),
  item({ id: 'drop_jammer', name: 'Drop Jammer', slot: 'pack', kind: 'deploy', clip: 1, ammo: 1, reload: 0, refire: 1, deploy: 'drop_jammer', src: 'F/Sentinel' }),
  item({ id: 'stealth_pack', name: 'Stealth Pack', slot: 'pack', kind: 'toggle', clip: 0, ammo: 0, reload: 0, refire: 0.5, energyDrain: 6.5, src: 'TD/Stealth_Pack' }),
  item({ id: 'energy_pack', name: 'Energy Pack', slot: 'pack', kind: 'passive', clip: 0, ammo: 0, reload: 0, refire: 0, passive: { energy: 35 }, src: 'F/Soldier' }),
  item({ id: 'utility_pack', name: 'Utility Pack', slot: 'pack', kind: 'passive', clip: 0, ammo: 0, reload: 0, refire: 0, passive: { health: 100, energy: 20, beltExtra: 1, runMult: 1.1 }, src: 'F/Soldier' }),
  item({ id: 'light_turret_pack', name: 'Light Turret', slot: 'pack', kind: 'deploy', clip: 1, ammo: 1, reload: 0, refire: 1, deploy: 'light_turret', src: 'TD/Base_Assets' }),
  item({ id: 'exr_turret_pack', name: 'EXR Turret', slot: 'pack', kind: 'deploy', clip: 1, ammo: 1, reload: 0, refire: 1, deploy: 'exr_turret', src: 'F/Technician' }),
  item({ id: 'shield_pack', name: 'Shield Pack', slot: 'pack', kind: 'toggle', clip: 0, ammo: 0, reload: 0, refire: 0.5, energyDrain: 8, src: 'TD/Shield_Pack' }),
  item({ id: 'jammer_pack', name: 'Jammer Pack', slot: 'pack', kind: 'toggle', clip: 0, ammo: 0, reload: 0, refire: 0.5, energyDrain: 5, src: 'F/Raider' }),
  item({ id: 'regen_pack', name: 'Health Regen Pack', slot: 'pack', kind: 'passive', clip: 0, ammo: 0, reload: 0, refire: 0, passive: { healthRegenMult: 2.5 }, src: 'F/Juggernaut' }),
  item({ id: 'force_field_pack', name: 'Force Field', slot: 'pack', kind: 'deploy', clip: 2, ammo: 2, reload: 0, refire: 1, deploy: 'force_field', src: 'TD/Force_Field' }),
  item({ id: 'survival_pack', name: 'Survival Pack', slot: 'pack', kind: 'passive', clip: 0, ammo: 0, reload: 0, refire: 0, passive: { health: 200, runMult: 1.25, regenMult: 1.15 }, src: 'F/Brute' }),
  item({ id: 'heavy_shield_pack', name: 'Heavy Shield Pack', slot: 'pack', kind: 'toggle', clip: 0, ammo: 0, reload: 0, refire: 0.5, energyDrain: 10, src: 'F/Brute' }),
] as ItemDef[]).map((i) => [i.id, i]));

export const MELEE = { damage: 900, backstabMult: 2, range: 2.6, refire: 0.9, impulse: 18000 };
export const SHOCKLANCE_BACK_MULT = 2;

const pseudo = (o: Partial<ProjectileDef> & Pick<ProjectileDef, 'speed' | 'direct' | 'radius'>): ProjectileDef => ({
  gravity: 0, inherit: 0, lifetime: 5, splashMax: o.direct, splashMin: o.direct * 0.4, impulse: 30000, size: 0.25, model: 'plasma', color: 0xffa040, ...o,
});

/** Projectiles fired by turrets, vehicles and sub-munitions (not player-selectable). */
export const PSEUDO_PROJECTILES: Record<string, ProjectileDef> = {
  veh_gravcycle: pseudo({ speed: 110, direct: 250, radius: 3, splashMax: 200, model: 'rocket', color: 0xffc060, inherit: 1 }),
  veh_beowulf: pseudo({ speed: 70, direct: 2000, radius: 9, splashMax: 1500, gravity: 0.6, model: 'mortar', color: 0xff8030, impulse: 80000, inherit: 0.5 }),
  veh_shrike: pseudo({ speed: 120, direct: 350, radius: 4, splashMax: 300, model: 'plasma', color: 0x80c0ff, inherit: 1 }),
  turret_base: pseudo({ speed: 90, direct: 650, radius: 4, splashMax: 650, model: 'plasma', color: 0xff5040 }),
  turret_exr: pseudo({ speed: 75, direct: 380, radius: 4, splashMax: 380, model: 'plasma', color: 0xffa040 }),
  sub_munition: pseudo({ speed: 20, direct: 450, radius: 7, splashMax: 450, gravity: 1, model: 'grenade', color: 0xb6ff4a, bounce: 0.3, fuse: 1.2, explodeOnExpire: true, lifetime: 3 }),
};

export const ITEM_IDS: string[] = [...Object.keys(ITEMS), ...Object.keys(PSEUDO_PROJECTILES), 'melee', 'none'];
export const ITEM_INDEX: Record<string, number> = Object.fromEntries(ITEM_IDS.map((id, i) => [id, i]));

export function projDef(id: string): ProjectileDef | undefined {
  return ITEMS[id]?.projectile ?? PSEUDO_PROJECTILES[id];
}

export function getItem(id: string): ItemDef {
  const it = ITEMS[id];
  if (!it) throw new Error(`Unknown item ${id}`);
  return it;
}
