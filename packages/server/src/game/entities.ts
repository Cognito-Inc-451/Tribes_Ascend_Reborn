import {
  ARMOR_PHYSICS, ASSETS, CLASSES, DEFAULT_COSMETICS, ITEMS, newMoveState, VEHICLES,
  type AssetDef, type AssetType, type ClassDef, type CosmeticProfile, type InputCmd, type ItemDef, type Loadout, type MoveState,
  type OBB, type TransportKind, type Vec3, type VehicleDef, type VehicleType,
} from '@ar/shared';
import type { Connection } from '../transport/types.js';
import type { BotBrain } from './bots.js';

export interface WeaponState {
  def: ItemDef;
  clip: number;
  ammo: number;
  nextFire: number;
  reloadUntil: number;
  spin: number;
  burstLeft: number;
  burstNext: number;
  lastShot: number;
}

export function makeWeapon(id: string): WeaponState {
  const def = ITEMS[id];
  return { def, clip: def.clip, ammo: Math.max(0, def.ammo - def.clip), nextFire: 0, reloadUntil: 0, spin: 0, burstLeft: 0, burstNext: 0, lastShot: -99 };
}

export interface HistoryEntry { t: number; x: number; y: number; z: number }

export class Player {
  team = 255;
  spectator = true;
  /** Picked SPECTATE on the team screen (kept across map changes). */
  chosenSpectator = false;
  follow = -1;
  cls: ClassDef = CLASSES[0];
  loadout: Loadout = CLASSES[0].defaultLoadout;
  pending: { cls: ClassDef; loadout: Loadout } | null = null;
  cosmetics: CosmeticProfile = DEFAULT_COSMETICS;

  alive = false;
  move: MoveState = newMoveState({ x: 0, y: 0, z: 0 });
  health = 0;
  maxHealth = 1;
  maxEnergy = 100;
  regenMult = 1;
  runMult = 1;
  massMult = 1;
  lastHurt = -999;
  respawnAt = 0;
  diedAt = 0;
  /** A fire click while dead: respawn as soon as the timer allows. */
  spawnQueued = false;

  inputs: InputCmd[] = [];
  lastSeq = -1;
  lastCmd: InputCmd = { seq: 0, fwd: 0, strafe: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
  prevButtons = 0;

  weapons: WeaponState[] = [];
  slot = 0;
  switchUntil = 0;
  beltCount = 0;
  beltNext = 0;
  packActive = false;
  packNext = 0;
  meleeNext = 0;
  repairSwap = false;

  credits = 0;
  score = 0;
  modeScore = 0;
  kills = 0;
  deaths = 0;
  assists = 0;
  caps = 0;
  returns = 0;
  rewardedSinceDeath = true;
  determination = 0;

  flag: FlagState | null = null;
  vehicle: Vehicle | null = null;
  seat = 0;
  damagers = new Map<number, number>();
  invulnUntil = 0;
  zoomed = false;
  lastFire = -99;
  spottedUntil = 0;
  rageUntil = 0;
  history: HistoryEntry[] = [];
  /** Recent grounded positions outside any hazard (oldest first), where the out-of-bounds rescue puts the player back. */
  safe: { x: number; y: number; z: number }[] = [];
  safeAt = 0;
  lastRescue = -99;

  chatTimes: number[] = [];
  vgsTimes: number[] = [];
  msgCount = 0;
  msgWindow = 0;
  rtt = 0.08;
  transport: TransportKind | 'bot';
  ready = false;
  lastVgsReply = 0;

  constructor(readonly id: number, public name: string, public conn: Connection | null, public brain: BotBrain | null) {
    this.transport = conn ? conn.kind : 'bot';
  }

  get isBot(): boolean { return this.brain !== null; }
  get phys() { return ARMOR_PHYSICS[this.cls.armor]; }
  get weapon(): WeaponState { return this.weapons[this.slot] ?? this.weapons[0]; }
  get perks(): string[] { return [this.loadout.perkA, this.loadout.perkB]; }
  hasPerk(id: string): boolean { return this.loadout.perkA === id || this.loadout.perkB === id; }
  eye(): Vec3 { return { x: this.move.pos.x, y: this.move.pos.y + this.phys.height * 0.9, z: this.move.pos.z }; }
  pos3(): Vec3 { return this.move.pos; }
}

export interface FlagState {
  id: number;
  team: number;          // owning team (255 = neutral rabbit/TDM flag)
  state: 0 | 1 | 2;      // home, carried, dropped
  carrier: Player | null;
  pos: Vec3;
  vel: Vec3;
  home: Vec3;
  droppedAt: number;
  stands: Vec3[];        // blitz rotation
  standIndex: number;
  active: boolean;
}

export interface Asset {
  id: number;
  type: AssetType;
  def: AssetDef;
  team: number;
  pos: Vec3;
  yaw: number;
  aimYaw: number;
  health: number;
  maxHealth: number;
  level: number;
  destroyed: boolean;
  destroyedAt: number;
  owner: number;          // player id or -1 for map assets
  createdAt: number;
  nextFire: number;
  box: OBB | null;
  tag?: string;
  capTeam?: number;       // CaH: owning team
  capHeldSince?: number;
  capNextScore?: number;
  armedAt?: number;
}

export interface Vehicle {
  id: number;
  type: VehicleType;
  def: VehicleDef;
  team: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  health: number;
  energy: number;
  driver: Player | null;
  gunner: Player | null;
  clip: number;
  reloadUntil: number;
  nextFire: number;
  gunnerNext: number;
  emptySince: number;
  box: OBB | null;
}

export function vehicleDef(t: VehicleType) { return VEHICLES[t]; }
export function assetDef(t: AssetType) { return ASSETS[t]; }
