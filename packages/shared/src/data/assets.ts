export type AssetType =
  | 'generator' | 'base_turret' | 'radar' | 'inventory' | 'repair_station' | 'vehicle_pad' | 'flag_stand' | 'cap_point'
  | 'light_turret' | 'exr_turret' | 'force_field' | 'drop_jammer' | 'motion_sensor' | 'repair_kit'
  | 'claymore' | 'focused_claymore' | 'motion_mine' | 'prism_mine' | 'mine' | 'supply_drop';

export interface AssetDef {
  type: AssetType;
  name: string;
  health: number;          // 0 = indestructible
  armored: boolean;        // only explosive damage applies
  needsPower: boolean;
  upgradeCosts?: number[];
  healthPerLevel?: number;
  autoRepair?: number;     // seconds until auto repair when destroyed
  range?: number;
  damage?: number;
  splash?: number;
  refire?: number;
  trigger?: number;        // mine trigger radius (m)
  maxPerPlayer?: number;
  lifetime?: number;
  size: [number, number, number]; // collision box half extents
  solid: boolean;
  src: string;
}

export const ASSETS: Record<AssetType, AssetDef> = {
  generator: { type: 'generator', name: 'Generator', health: 6000, armored: true, needsPower: false, upgradeCosts: [1500, 1500, 2000, 2000], healthPerLevel: 2000, autoRepair: 300, size: [1.6, 1.8, 1.6], solid: true, src: 'TD/Generator' },
  base_turret: { type: 'base_turret', name: 'Base Turret', health: 5000, armored: true, needsPower: true, upgradeCosts: [1500, 1500, 2000, 2000], healthPerLevel: 500, range: 110, damage: 650, splash: 4, refire: 2.2, size: [1.2, 1.2, 1.2], solid: true, src: 'TD/Base_Turret' },
  radar: { type: 'radar', name: 'Radar Sensor', health: 2000, armored: true, needsPower: true, upgradeCosts: [1500, 1500, 2000, 2000], healthPerLevel: 2000, range: 200, size: [1, 2.5, 1], solid: true, src: 'TD/Radar_Sensor' },
  inventory: { type: 'inventory', name: 'Inventory Station', health: 0, armored: true, needsPower: true, size: [0.9, 1.3, 0.6], solid: true, src: 'TD/Inventory_Station' },
  repair_station: { type: 'repair_station', name: 'Repair Station', health: 0, armored: true, needsPower: false, size: [0.5, 1.0, 0.5], solid: true, src: 'F/CTF tips' },
  vehicle_pad: { type: 'vehicle_pad', name: 'Vehicle Station', health: 0, armored: true, needsPower: true, size: [0.8, 1.2, 0.6], solid: true, src: 'F/CTF tips' },
  flag_stand: { type: 'flag_stand', name: 'Flag Stand', health: 0, armored: true, needsPower: false, size: [1.2, 0.3, 1.2], solid: true, src: '' },
  cap_point: { type: 'cap_point', name: 'Control Point', health: 0, armored: true, needsPower: false, size: [0.6, 1.2, 0.6], solid: true, src: 'RulesForCaH' },
  light_turret: { type: 'light_turret', name: 'Light Turret', health: 800, armored: false, needsPower: true, range: 60, damage: 65, refire: 0.25, maxPerPlayer: 1, size: [0.5, 0.6, 0.5], solid: true, src: 'TD/Base_Assets' },
  exr_turret: { type: 'exr_turret', name: 'EXR Turret', health: 1000, armored: false, needsPower: true, range: 70, damage: 380, splash: 4, refire: 1.8, maxPerPlayer: 1, size: [0.5, 0.6, 0.5], solid: true, src: 'F/Technician' },
  force_field: { type: 'force_field', name: 'Force Field', health: 2000, armored: false, needsPower: true, damage: 800, maxPerPlayer: 2, size: [3, 2.2, 0.15], solid: true, src: 'TD/Force_Field' },
  drop_jammer: { type: 'drop_jammer', name: 'Drop Jammer', health: 600, armored: false, needsPower: false, range: 30, maxPerPlayer: 1, size: [0.4, 0.6, 0.4], solid: true, src: 'F/Sentinel' },
  motion_sensor: { type: 'motion_sensor', name: 'Motion Sensor', health: 300, armored: false, needsPower: false, range: 25, maxPerPlayer: 2, size: [0.25, 0.4, 0.25], solid: false, src: 'F/Technician' },
  repair_kit: { type: 'repair_kit', name: 'Repair Kit', health: 300, armored: false, needsPower: false, range: 5, maxPerPlayer: 2, lifetime: 60, size: [0.3, 0.3, 0.3], solid: false, src: 'F/Technician' },
  claymore: { type: 'claymore', name: 'Claymore', health: 100, armored: false, needsPower: false, damage: 700, splash: 5, trigger: 4, maxPerPlayer: 2, size: [0.25, 0.2, 0.1], solid: false, src: 'F/Sentinel' },
  focused_claymore: { type: 'focused_claymore', name: 'Focused Claymore', health: 100, armored: false, needsPower: false, damage: 600, splash: 5, trigger: 6, maxPerPlayer: 2, size: [0.25, 0.2, 0.1], solid: false, src: 'F/Sentinel' },
  motion_mine: { type: 'motion_mine', name: 'Motion Mine', health: 100, armored: false, needsPower: false, damage: 700, splash: 5, trigger: 5, maxPerPlayer: 2, size: [0.25, 0.1, 0.25], solid: false, src: 'F/Sentinel' },
  prism_mine: { type: 'prism_mine', name: 'Prism Mine', health: 100, armored: false, needsPower: false, damage: 800, splash: 4, trigger: 3, maxPerPlayer: 2, size: [0.2, 0.1, 0.2], solid: false, src: 'F/Infiltrator' },
  mine: { type: 'mine', name: 'Mine', health: 100, armored: false, needsPower: false, damage: 700, splash: 5, trigger: 3, maxPerPlayer: 3, size: [0.25, 0.1, 0.25], solid: false, src: 'F/Doombringer' },
  supply_drop: { type: 'supply_drop', name: 'Supply Drop', health: 2000, armored: true, needsPower: false, lifetime: 90, size: [1, 1.4, 1], solid: true, src: 'TD/Call-Ins' },
};

export type VehicleType = 'gravcycle' | 'beowulf' | 'shrike';

export interface VehicleDef {
  type: VehicleType;
  name: string;
  cost: number;
  health: number;
  energy: number;
  seats: number;
  maxPerTeam: number;
  maxSpeed: number;     // m/s
  accel: number;
  boostAccel: number;
  flying: boolean;
  hover: number;        // hover height (m) for ground vehicles
  mass: number;
  size: [number, number, number];
  weapon: { damage: number; splash: number; radius: number; speed: number; clip: number; reload: number; refire: number; gravity: number };
  gunner?: { damage: number; refire: number; spread: number };
  src: string;
}

export const VEHICLES: Record<VehicleType, VehicleDef> = {
  gravcycle: { type: 'gravcycle', name: 'Grav Cycle', cost: 500, health: 1400, energy: 100, seats: 1, maxPerTeam: 4, maxSpeed: 58, accel: 22, boostAccel: 40, flying: false, hover: 1.1, mass: 400, size: [0.9, 0.7, 2.2],
    weapon: { damage: 250, splash: 200, radius: 3, speed: 110, clip: 8, reload: 3.81, refire: 0.2, gravity: 0 }, src: 'TD/Grav_Cycle' },
  beowulf: { type: 'beowulf', name: 'Beowulf', cost: 2500, health: 8000, energy: 70, seats: 2, maxPerTeam: 2, maxSpeed: 32, accel: 10, boostAccel: 18, flying: false, hover: 1.4, mass: 2500, size: [2.4, 1.4, 3.6],
    weapon: { damage: 2000, splash: 1500, radius: 9, speed: 70, clip: 1, reload: 3.82, refire: 3.82, gravity: 0.6 }, gunner: { damage: 100, refire: 0.1, spread: 0.03 }, src: 'TD/Beowulf' },
  shrike: { type: 'shrike', name: 'Shrike', cost: 4000, health: 3200, energy: 70, seats: 1, maxPerTeam: 2, maxSpeed: 55, accel: 20, boostAccel: 35, flying: true, hover: 0, mass: 1200, size: [3, 0.9, 3],
    weapon: { damage: 350, splash: 300, radius: 4, speed: 120, clip: 4, reload: 3.86, refire: 0.3, gravity: 0 }, src: 'TD/Shrike' },
};

export type CallInType = 'tactical_strike' | 'orbital_strike' | 'supply_drop';

export interface CallInDef { type: CallInType; name: string; cost: number; targetTime: number; damage: number; radius: number; cooldown: number; src: string }

export const CALLINS: Record<CallInType, CallInDef> = {
  tactical_strike: { type: 'tactical_strike', name: 'Tactical Strike', cost: 4000, targetTime: 2.5, damage: 10000, radius: 9, cooldown: 60, src: 'TD/Call-Ins' },
  supply_drop: { type: 'supply_drop', name: 'Supply Drop', cost: 2000, targetTime: 1.5, damage: 16000, radius: 2.5, cooldown: 60, src: 'TD/Call-Ins' },
  orbital_strike: { type: 'orbital_strike', name: 'Orbital Strike', cost: 10000, targetTime: 5, damage: 20000, radius: 40, cooldown: 180, src: 'TD/Call-Ins' },
};

export const CREDITS = {
  start: 1000,
  kill: 100,
  assist: 50,
  flagGrab: 100,
  flagCapture: 500,
  flagReturn: 150,
  genDestroy: 400,
  turretDestroy: 200,
  repairPerHp: 0.1,
  capPointHold: 150,
  bountyHunterBonus: 200,
};

// Damage multipliers vs non-player targets (TD/Spinfusor_Comparison, TD/Generator).
export function assetDamageMult(explosive: boolean, isDisc: boolean, target: 'generator' | 'turret' | 'vehicle' | 'shrike' | 'other'): number {
  if (!explosive) return target === 'generator' ? 0.75 : 1;
  switch (target) {
    case 'generator': return isDisc ? 1.25 : 1.2;
    case 'turret': return 1.2;
    case 'vehicle': return 1.2;
    case 'shrike': return 2.5;
    default: return 1;
  }
}
