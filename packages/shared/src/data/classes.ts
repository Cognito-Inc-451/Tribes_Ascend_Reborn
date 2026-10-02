export type Armor = 'light' | 'medium' | 'heavy';

export interface ArmorPhysics {
  runSpeed: number;     // m/s (TD/<Armor>_Armor)
  mass: number;         // kg
  radius: number;
  height: number;
  jumpSpeed: number;
  jetAccel: number;     // upward m/s^2 while jetting
  jetSideAccel: number; // horizontal m/s^2 from jets toward wish dir
  jetHorizCap: number;  // jets stop adding horizontal speed past this (m/s)
  jetDrain: number;     // energy per second
  jetInitialCost: number;
  airControl: number;   // m/s^2 without jets
  airSpeedCap: number;
  skiControl: number;   // lateral steering accel while skiing
  skiAccel: number;     // TA m_fAirAccelSpeed * m_fFISkiAccelPct (m/s^2)
  skiAccelCap: number;  // TA m_fFISkiAccelCapSpeedThreshold (m/s)
  energyRegen: number;  // per second
  groundFriction: number;
}

export const ARMOR_PHYSICS: Record<Armor, ArmorPhysics> = {
  // jetAccel lowered by the gravity change (15 -> 8.32) so net jet lift is unchanged; jump = TA JumpZ 322 uu/s; masses from TrFamilyInfo.
  light: { runSpeed: 10, mass: 100, radius: 0.5, height: 1.85, jumpSpeed: 6.44, jetAccel: 20.3, jetSideAccel: 11, jetHorizCap: 34, jetDrain: 30, jetInitialCost: 3, airControl: 5, airSpeedCap: 22, skiControl: 4, skiAccel: 3.9, skiAccelCap: 48, energyRegen: 13, groundFriction: 9 },
  medium: { runSpeed: 8.8, mass: 120, radius: 0.58, height: 1.95, jumpSpeed: 6.44, jetAccel: 18.3, jetSideAccel: 9.5, jetHorizCap: 30, jetDrain: 30, jetInitialCost: 3, airControl: 4.4, airSpeedCap: 19, skiControl: 3.5, skiAccel: 1.95, skiAccelCap: 40, energyRegen: 13, groundFriction: 9 },
  heavy: { runSpeed: 7.2, mass: 160, radius: 0.7, height: 2.25, jumpSpeed: 6.44, jetAccel: 15.3, jetSideAccel: 8, jetHorizCap: 26, jetDrain: 28, jetInitialCost: 3, airControl: 3.8, airSpeedCap: 16, skiControl: 3, skiAccel: 1.3, skiAccelCap: 34, energyRegen: 12, groundFriction: 9 },
};

export interface ClassDef {
  id: string;
  abbrev: string;
  name: string;
  armor: Armor;
  health: number;  // mastered value (all unlocked)
  energy: number;
  primaries: string[];
  secondaries: string[];
  belts: string[];
  packs: string[];
  defaultLoadout: Loadout;
  src: string;
}

export interface Loadout { primary: string; secondary: string; belt: string; pack: string; perkA: string; perkB: string }

const cls = (c: Omit<ClassDef, 'defaultLoadout'> & { perkA?: string; perkB?: string }): ClassDef => ({
  ...c,
  defaultLoadout: { primary: c.primaries[0], secondary: c.secondaries[0], belt: c.belts[0], pack: c.packs[0], perkA: c.perkA ?? 'safe_fall', perkB: c.perkB ?? 'ultra_capacitor_2' },
});

export const CLASSES: ClassDef[] = [
  cls({ id: 'pathfinder', abbrev: 'PTH', name: 'Pathfinder', armor: 'light', health: 900, energy: 110,
    primaries: ['light_spinfusor', 'bolt_launcher', 'dueling_spinfusor', 'light_twinfusor', 'blinksfusor'],
    secondaries: ['shotgun', 'light_assault_rifle', 'holdout_shotgun', 'shocklance'],
    belts: ['impact_nitron', 'explosive_nitron', 'compact_nitron'], packs: ['energy_recharge_pack', 'thrust_pack'], perkA: 'reach', src: 'F/Pathfinder' }),
  cls({ id: 'sentinel', abbrev: 'SEN', name: 'Sentinel', armor: 'light', health: 900, energy: 100,
    primaries: ['bxt1', 'phase_rifle', 'bxt1a', 'sap20'],
    secondaries: ['nova_blaster', 'falcon', 'nova_blaster_mx', 'accurized_shotgun', 'shocklance'],
    belts: ['claymore', 't5_grenade', 'focused_claymore', 'motion_mine'], packs: ['energy_recharge_pack', 'drop_jammer'], src: 'F/Sentinel' }),
  cls({ id: 'infiltrator', abbrev: 'INF', name: 'Infiltrator', armor: 'light', health: 1000, energy: 110,
    primaries: ['rhino_smg', 'stealth_spinfusor', 'jackal', 'arctic_rhino_smg'],
    secondaries: ['sn7', 'throwing_knives', 'arctic_sn7', 'shocklance'],
    belts: ['sticky_grenade', 'prism_mines', 'smoke_grenade', 'sticky_xl'], packs: ['stealth_pack'], perkA: 'close_combat', src: 'F/Infiltrator' }),
  cls({ id: 'soldier', abbrev: 'SLD', name: 'Soldier', armor: 'medium', health: 1300, energy: 105,
    primaries: ['assault_rifle', 'spinfusor', 'gasts_rifle', 'twinfusor'],
    secondaries: ['thumper_d', 'eagle_pistol', 'thumper_dx', 'spare_spinfusor', 'shocklance'],
    belts: ['frag_xl', 'ap_grenade', 'proximity_grenade', 'short_fuse_frag'], packs: ['energy_pack', 'utility_pack'], src: 'F/Soldier' }),
  cls({ id: 'technician', abbrev: 'TCN', name: 'Technician', armor: 'medium', health: 1300, energy: 110,
    primaries: ['tcn4_smg', 'thumper', 'tcn4_rockwind', 'tc24'],
    secondaries: ['repair_tool', 'sawed_off', 'sparrow', 'lr_repair_tool', 'shocklance'],
    belts: ['tcng', 'motion_sensor', 'tcng_quickfuse', 'repair_kit'], packs: ['light_turret_pack', 'exr_turret_pack'], perkA: 'mechanic', src: 'F/Technician' }),
  cls({ id: 'raider', abbrev: 'RDR', name: 'Raider', armor: 'medium', health: 1300, energy: 110,
    primaries: ['arx_buster', 'grenade_launcher', 'plasma_gun', 'dust_devil'],
    secondaries: ['nj4_smg', 'nj5b_smg', 'desert_nj4', 'shocklance'],
    belts: ['emp_grenade', 'whiteout_grenade', 'cluster_grenade', 'emp_xl'], packs: ['shield_pack', 'jammer_pack'], src: 'F/Raider' }),
  cls({ id: 'juggernaut', abbrev: 'JUG', name: 'Juggernaut', armor: 'heavy', health: 2600, energy: 90,
    primaries: ['fusion_mortar', 'mirv_launcher', 'fusion_mortar_deluxe'],
    secondaries: ['spinfusor_mkd', 'x1_lmg', 'spinfusor_mkx', 'heavy_twinfusor', 'shocklance'],
    belts: ['heavy_ap', 'spinfusor_disc', 'heavy_ap_xl'], packs: ['regen_pack'], src: 'F/Juggernaut' }),
  cls({ id: 'doombringer', abbrev: 'DMB', name: 'Doombringer', armor: 'heavy', health: 2500, energy: 90,
    primaries: ['chain_gun', 'heavy_bolt_launcher', 'chain_cannon'],
    secondaries: ['saber_launcher', 'titan_launcher', 'shocklance'],
    belts: ['frag_grenade', 'mines', 'defective_frag'], packs: ['force_field_pack'], src: 'F/Doombringer' }),
  cls({ id: 'brute', abbrev: 'BRT', name: 'Brute', armor: 'heavy', health: 2600, energy: 85,
    primaries: ['heavy_spinfusor', 'gladiator', 'devastator_spinfusor'],
    secondaries: ['auto_shotgun', 'nova_colt', 'plasma_cannon', 'the_hammer', 'shocklance'],
    belts: ['fractal_grenade', 'light_sticky', 'extended_fractal'], packs: ['energy_pack', 'heavy_shield_pack', 'survival_pack'], src: 'F/Brute' }),
];

export const CLASS_BY_ID: Record<string, ClassDef> = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
export const classIndex = (id: string): number => CLASSES.findIndex((c) => c.id === id);

export function validateLoadout(classId: string, l: Partial<Loadout>): Loadout {
  const c = CLASS_BY_ID[classId] ?? CLASSES[0];
  const pick = (v: string | undefined, list: string[], d: string) => (v && list.includes(v) ? v : d);
  return {
    primary: pick(l.primary, c.primaries, c.defaultLoadout.primary),
    secondary: pick(l.secondary, c.secondaries, c.defaultLoadout.secondary),
    belt: pick(l.belt, c.belts, c.defaultLoadout.belt),
    pack: pick(l.pack, c.packs, c.defaultLoadout.pack),
    perkA: pick(l.perkA, PERKS_A, c.defaultLoadout.perkA),
    perkB: pick(l.perkB, PERKS_B, c.defaultLoadout.perkB),
  };
}

export interface PerkDef { id: string; name: string; slot: 'A' | 'B'; desc: string }

export interface LoadoutStats { maxHealth: number; maxEnergy: number; regenMult: number; runMult: number; massMult: number; healthRegenMult: number; beltExtra: number }

/** Derived stats for a class + loadout; shared so client prediction matches the server. */
export function loadoutStats(cls: ClassDef, lo: Loadout, determination = 0, packPassive: { health?: number; energy?: number; regenMult?: number; runMult?: number; healthRegenMult?: number; beltExtra?: number } = {}): LoadoutStats {
  const has = (p: string) => lo.perkA === p || lo.perkB === p;
  let energy = cls.energy + (packPassive.energy ?? 0);
  if (has('ultra_capacitor_1')) energy += 10;
  if (has('ultra_capacitor_2')) energy += 10;
  return {
    maxHealth: cls.health + (packPassive.health ?? 0) + determination * 100,
    maxEnergy: energy,
    regenMult: packPassive.regenMult ?? 1,
    runMult: packPassive.runMult ?? 1,
    massMult: (has('lightweight') ? 0.7 : 1) * (has('super_heavy') ? 1.3 : 1),
    healthRegenMult: packPassive.healthRegenMult ?? 1,
    beltExtra: (packPassive.beltExtra ?? 0) + (has('safety_third') ? 1 : 0) + (has('looter') ? 1 : 0),
  };
}

export const PERKS: PerkDef[] = [
  { id: 'ultra_capacitor_1', name: 'Ultra Capacitor I', slot: 'A', desc: '+10 energy.' },
  { id: 'reach', name: 'Reach', slot: 'A', desc: 'Larger flag and ammo pickup range.' },
  { id: 'safe_fall', name: 'Safe Fall', slot: 'A', desc: 'Immune to fall damage and vehicle run-over.' },
  { id: 'wheel_deal', name: 'Wheel Deal', slot: 'A', desc: 'Cheaper vehicles, more vehicle energy.' },
  { id: 'bounty_hunter', name: 'Bounty Hunter', slot: 'A', desc: '+200 credits per kill.' },
  { id: 'close_combat', name: 'Close Combat', slot: 'A', desc: '-60% melee damage taken, 2x backstab damage.' },
  { id: 'looter', name: 'Looter', slot: 'A', desc: '+100% ammo from drops, +1 belt item.' },
  { id: 'stealthy', name: 'Stealthy', slot: 'A', desc: '-90% radar detection range.' },
  { id: 'safety_third', name: 'Safety Third', slot: 'A', desc: '+1 belt item, larger belt radius.' },
  { id: 'rage', name: 'Rage', slot: 'A', desc: 'Refill and speed boost when your flag is grabbed nearby.' },
  { id: 'determination', name: 'Determination', slot: 'B', desc: '+100 HP per unrewarded death (max 300).' },
  { id: 'egocentric', name: 'Egocentric', slot: 'B', desc: 'Less self-damage.' },
  { id: 'pilot', name: 'Pilot', slot: 'B', desc: '+20% vehicle health, ejection seat.' },
  { id: 'potential_energy', name: 'Potential Energy', slot: 'B', desc: 'Explosive damage taken becomes energy.' },
  { id: 'survivalist', name: 'Survivalist', slot: 'B', desc: 'Ammo drops heal health and energy.' },
  { id: 'super_heavy', name: 'Super Heavy', slot: 'B', desc: 'More mass, less knockback.' },
  { id: 'ultra_capacitor_2', name: 'Ultra Capacitor II', slot: 'B', desc: '+10 energy.' },
  { id: 'quick_draw', name: 'Quick Draw', slot: 'B', desc: 'Faster weapon swap.' },
  { id: 'mechanic', name: 'Mechanic', slot: 'B', desc: '+10% repair rate; repair tool damages enemy assets.' },
  { id: 'sonic_punch', name: 'Sonic Punch', slot: 'B', desc: 'Melee knockback, forces flag drop.' },
  { id: 'lightweight', name: 'Lightweight', slot: 'B', desc: '-30% mass, 3x health regen delay.' },
];
// Mechanic/close_combat are listed in both slots in some patches; keep them selectable in A too.
export const PERKS_A = PERKS.filter((p) => p.slot === 'A').map((p) => p.id).concat(['mechanic']);
export const PERKS_B = PERKS.filter((p) => p.slot === 'B').map((p) => p.id);
