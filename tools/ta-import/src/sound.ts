import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEMS } from '@ar/shared';
import { parseObject } from './props.js';
import type { UPackage } from './upk.js';

export interface VoicePackInfo { id: string; name: string; lines: string[] }
export interface VoiceManifest { packs: VoicePackInfo[]; announcer: string[]; music?: string[]; sfx?: Record<string, number> }

// Music shipped with the game: Drydock's dynamic score (low/med/high intensity loops), end-of-match themes and CTF stingers.
const MUSIC: Record<string, string> = {
  MUS_Map_Drydock_Low_LP: 'loop_low', MUS_Map_Drydock_Med_LP: 'loop_med', MUS_Map_Drydock_High_LP: 'loop_high',
  MUS_IWinButItsStillWar_Master: 'victory', MUS_Lose: 'defeat', MUS_Death: 'death', MUS_Flag_03: 'flag',
  UI_CTF_FlagCaptured: 'sting_capture', UI_CTF_FlagPickedUp: 'sting_grab', UI_CTF_FlagReturned: 'sting_return',
};

// Our weapon ids -> AUD_WEP_* sound group (first match wins).
const WEAPON_GROUP: [RegExp, string][] = [
  [/^light_spinfusor$/, 'Spinfusor_Light'], [/^heavy_spinfusor$|^gladiator$/, 'Spinfusor_Heavy'], [/twinfusor/, 'Twinfusor_Light'], [/spinfusor/, 'Spinfusor'],
  [/^heavy_bolt/, 'BoltLauncher_Heavy'], [/^bolt_launcher$/, 'BoltLauncher'], [/^auto_shotgun$/, 'Shotgun_Auto'], [/^sawed_off$/, 'Shotgun_SawedOff'],
  [/shotgun|the_hammer/, 'Shotgun'], [/assault_rifle|gasts_rifle/, 'AssaultRifle'], [/^shocklance$/, 'ShockLance'], [/^bxt1/, 'LaserRifle'],
  [/^phase_rifle$/, 'PhaseRifle'], [/^sap20$/, 'SAP20'], [/^nova_blaster/, 'NovaBlaster'], [/^nova_colt$/, 'NovaColt'], [/^falcon$/, 'Falcon_Auto_Pistol'],
  [/sn7/, 'SN7_Pistol'], [/sparrow/, 'Sparrow'], [/eagle_pistol/, 'Pistol'], [/^nj5/, 'SMG_NJ5'], [/nj4/, 'SMG_NJ4'], [/smg|tcn4/, 'SMG'],
  [/^jackal$/, 'ArxBuster_Remote'], [/^arx_buster$/, 'ArxBuster'],
  [/^thumper_d$/, 'Thumper_D'], [/^thumper/, 'Thumper'], [/^tc24$/, 'TC24'], [/grenade_launcher|dust_devil/, 'GrenadeLauncher'], [/^plasma_gun$/, 'PlasmaGun'],
  [/^plasma_cannon$/, 'PlasmaCannon'], [/fusion_mortar/, 'FusionMortar'], [/^mirv/, 'MirvLauncher'], [/x1_lmg/, 'LMG'], [/^chain_/, 'Chaingun'],
  [/saber_launcher|titan_launcher/, 'SaberLauncher'],
];
const VEHICLE_GROUP: Record<string, string> = { gravcycle: 'AUD_VEH_GravBike', beowulf: 'AUD_VEH_Beowulf', shrike: 'AUD_VEH_Shrike' };
// Generic effects: key -> [group.subgroup prefix, wave-name filter].
const GENERIC: Record<string, [string, RegExp]> = {
  explode: ['AUD_WEP_Grenade.Explosion', /./], gen_explode: ['AUD_ENV_PowerGenerator.Explosion', /./], jet: ['AUD_PC_JetPack.Loop', /3P_LP/],
  ski: ['AUD_PC_Movement.Skiing', /Skiing_Fast$/], wind: ['AUD_PC_Movement.Speed', /./], step: ['AUD_PC_Movement.Footstep', /Dirt_Run_0[1-4]$/],
  fall: ['AUD_PC_Notifications.Fall_Damage', /./], hit: ['AUD_PC_Notifications.Impact__Notify', /./], blueplate: ['AUD_PC_Notifications.Headshot', /ImpactOnPawnNotify_Headshot$/],
  melee: ['AUD_WEP_MercMelee.Swing', /MercPunch_Swing_\d$/], melee_hit: ['AUD_WEP_MercMelee.Melee_Impact', /./], click: ['Aud_menu.Loadout_Menu', /ButtonPress/],
  rollover: ['Aud_menu.Loadout_Menu', /ButtonRollover/], denied: ['AUD_UI_VehicleStation.Vehicle_Access', /Denied/], low_health: ['AUD_PC_Notifications.Health', /LowHealth/],
  ammo: ['AUD_PC_Notifications.Pick_Up_Ammo', /./], respawn: ['AUD_PC_Notifications.Respawn', /./], spin: ['AUD_WEP_Chaingun.Spin', /3P_Spin_LP$/],
  vehicle_station: ['AUD_UI_VehicleStation.Use_Station', /Station_[1-3]$/], chat: ['Aud_menu.ChatMessage_Sent', /./],
  // Players, flags, kills.
  death: ['AUD_PC_Voice.Death', /Death_(Med|Long)_0[1-2]$/], impact: ['AUD_PC_BulletImpact.Terrain', /(Concrete|Rock)_[12]$/],
  flag_drop: ['AUD_ENV_FlagBounce.Flag_Bounce', /./], kill_confirm: ['AUD_UI_Player.Accolade_Gained', /./], thrust: ['AUD_PC_BlinkPack.Activate', /Activate_1$/],
  // Base: stations and generators.
  inv_station: ['AUD_ENV_InventortStation.Activate', /InventoryStation_2$/], gen_powerdown: ['AUD_ENV_PowerGenerator.Power_Down', /./],
  gen_hum: ['AUD_ENV_PowerGenerator.Engine_Loop', /_LP_4$/],
  boom_asset_generator: ['AUD_ENV_PowerGenerator.Explosion', /./], boom_asset_base_turret: ['AUD_DEP_HeavyTurret.Explosion', /./],
  boom_asset_radar: ['AUD_DEP_OmniSensor.Explosion', /Explosion_\d$/], fire_turret_base: ['AUD_DEP_HeavyTurret.Fire', /./],
  boom_turret_base: ['AUD_DEP_HeavyTurret.Projectile_Impact', /./],
  // Deployables.
  fire_light_turret: ['AUD_WEP_LightTurret.Fire', /./], fire_turret_exr: ['AUD_WEP_EXR_Turret.Fire', /Fire_1$/],
  boom_turret_exr: ['AUD_WEP_EXR_Turret.Projectile_Explosion', /./],
  deploy_light_turret: ['AUD_WEP_LightTurret.Deploy', /./], deploy_exr_turret: ['AUD_WEP_EXR_Turret.Deploy', /./],
  deploy_force_field: ['AUD_DEP_Shield.Deploy', /./], deploy_drop_jammer: ['AUD_DEP_Jammer.Deploy', /./], deploy_motion_sensor: ['AUD_DEP_OmniSensor.Deploy', /./],
  deploy_repair_kit: ['AUD_DEP_RepairKit.Deploy', /Deploy_[12]$/], deploy_mine: ['AUD_WEP_Mine.Deploy', /./], deploy_claymore: ['AUD_DEP_360Mine.Deploy', /./],
  deploy_prism_mine: ['AUD_WEP_Prism_Mine.Activate', /./],
  boom_asset_light_turret: ['AUD_WEP_LightTurret.Explosion', /./], boom_asset_exr_turret: ['AUD_WEP_EXR_Turret.Explosion', /./],
  boom_asset_force_field: ['AUD_DEP_Shield.Explosion', /./], boom_asset_drop_jammer: ['AUD_DEP_Jammer.Explosion', /./],
  boom_asset_motion_sensor: ['AUD_DEP_MotionSensor.Explosion', /./], boom_asset_repair_kit: ['AUD_DEP_RepairKit.Explosion', /./],
  boom_asset_supply_drop: ['AUD_CallIn_Support_inventory.Deployable_Destroyed', /./],
  // Call-ins.
  alarm_orbital_strike: ['AUD_CallIn_Orbital_Strike.CallIn_Confirmed', /./], alarm_tactical_strike: ['AUD_CallIn_Support_inventory.CallIn_Confirmed', /./],
  boom_orbital_strike: ['AUD_CallIn_Orbital_Strike.Impact', /Impact_Explosion_\d$/], boom_tactical_strike: ['AUD_CallIn_Tactical_Strike.Impact', /Projectile_Impact_\d$/],
  boom_supply_drop: ['AUD_CallIn_Support_inventory.Impact', /DeliveryPod_Impact_1$/],
  // Vehicles (gunner seat, the rest per vehicle below).
  fire_veh_beowulf_gun: ['AUD_VEH_Beowulf.Passenger_Fire', /Passenger_Fire_3$/],
};

/** Weapon fire/explosion sounds per item plus generic effects -> outDir/sfx/<key>_<n>.ogg. Returns variant counts. */
export function extractSfx(pkg: UPackage, itemIds: string[], outDir: string, log: (s: string) => void): Record<string, number> {
  const dir = join(outDir, 'sfx');
  mkdirSync(dir, { recursive: true });
  const waves: { path: string; i: number }[] = [];
  for (let i = 0; i < pkg.exports.length; i++) if (pkg.className(pkg.exports[i]) === 'SoundNodeWave') waves.push({ path: pkg.refPath(i + 1), i });
  const out: Record<string, number> = {};
  const save = (key: string, list: { i: number }[], max: number) => {
    let n = 0;
    for (const w of list) {
      if (n >= max) break;
      const ogg = oggOf(pkg, w.i);
      if (!ogg) continue;
      writeFileSync(join(dir, `${key}_${++n}.ogg`), ogg);
    }
    if (n) out[key] = n;
  };
  const leaf = (w: { path: string }) => w.path.split('.').pop() ?? '';
  const sub = (w: { path: string }) => w.path.split('.')[1] ?? '';
  // Third-person variants first: they are what other players hear and carry the full shot.
  const pref3P = <T extends { path: string }>(list: T[]) => [...list].sort((a, b) => Number(/3P/.test(leaf(b))) - Number(/3P/.test(leaf(a))));
  for (const [key, [prefix, re]] of Object.entries(GENERIC)) save(key, waves.filter((w) => w.path.startsWith(`${prefix}.`) && re.test(w.path)), 4);
  for (const [veh, group] of Object.entries(VEHICLE_GROUP)) {
    const inGroup = waves.filter((w) => w.path.startsWith(`${group}.`));
    const of = (s: RegExp, l: RegExp = /./) => inGroup.filter((w) => s.test(sub(w)) && l.test(leaf(w)));
    save(`fire_veh_${veh}`, of(/^Fire$/), 2);
    save(`boom_veh_${veh}`, of(/^(Impact|Projectile)_Explosion$/), 3);
    save(`boom_vehicle_${veh}`, of(/^(Vehicle_)?Explosion$/), 3);
    save(`veh_${veh}_idle`, of(/^Engine_LP$/, /Idle/i), 1);
    save(`veh_${veh}_fast`, of(/^Engine_LP$/, /Fast(_LP_1)?$/i), 1);
    save(`veh_${veh}_start`, of(/^Buildup$/), 1);
  }
  for (const id of itemIds) {
    const group = WEAPON_GROUP.find(([re]) => re.test(id))?.[1];
    if (!group) continue;
    const inGroup = waves.filter((w) => w.path.startsWith(`AUD_WEP_${group}.`));
    const fireW = inGroup.filter((w) => /^Fire(_Tail)?$/i.test(sub(w)));
    // Automatic weapons in TA: an attack transient, a loop while the trigger is held, a tail on release.
    const loops = pref3P(fireW.filter((w) => /_LP(_\d+)?$|Loop_\d+$/i.test(leaf(w)) && !/Spin|Scifi|Tech/i.test(leaf(w))));
    const tails = pref3P(fireW.filter((w) => /Tail/i.test(leaf(w))));
    const shots = fireW.filter((w) => /^Fire$/i.test(sub(w)) && !/_LP|Loop|Foley|Tail|Spin|BulletEject|Reload|Clip|Mech/i.test(leaf(w)));
    const attacks = pref3P(shots.filter((w) => /Attack/i.test(leaf(w))));
    const full = pref3P(shots.filter((w) => !/Attack/i.test(leaf(w))));
    const auto = (ITEMS[id]?.refire ?? 1) < 0.2;
    if (auto && loops.length) {
      save(`fire_${id}`, attacks.length ? attacks : full, 2);
      save(`fireloop_${id}`, loops, 1);
      save(`firetail_${id}`, tails, 1);
    } else save(`fire_${id}`, auto && attacks.length ? attacks : full.length ? full : attacks, 3);
    save(`boom_${id}`, inGroup.filter((w) => /Explosion/i.test(sub(w))), 3);
    // Reload parts in order (mag out, mag in, ...), and the draw sound.
    save(`reload_${id}`, inGroup.filter((w) => /^reload$/i.test(sub(w))).sort((a, b) => leaf(a).localeCompare(leaf(b))), 4);
    save(`retrieve_${id}`, inGroup.filter((w) => /^Retrieve$/i.test(sub(w))), 2);
  }
  log(`sfx: ${Object.keys(out).length} sounds (${Object.values(out).reduce((a, b) => a + b, 0)} files)`);
  return out;
}

/** Export the music waves found in the given packages to outDir/music and add them to the voice manifest. */
export function extractMusic(pkgs: UPackage[], outDir: string, log: (s: string) => void): string[] {
  const found: string[] = [];
  mkdirSync(join(outDir, 'music'), { recursive: true });
  for (const pkg of pkgs) {
    for (let i = 0; i < pkg.exports.length; i++) {
      const e = pkg.exports[i];
      const key = MUSIC[e.objectName];
      if (!key || found.includes(key) || pkg.className(e) !== 'SoundNodeWave') continue;
      const ogg = oggOf(pkg, i);
      if (!ogg) continue;
      writeFileSync(join(outDir, 'music', `${key}.ogg`), ogg);
      found.push(key);
    }
  }
  log(`music: ${found.length} tracks (${found.join(', ')})`);
  return found;
}

// Wave name (after AUD_VGS_) -> VGS id where the simple "drop underscores" rule does not apply.
const SPECIAL: Record<string, string> = {
  Attack_Attack: 'Attack', Attack_AttackWait: 'AttackWait', Base_EnemyInBase: 'EnemyInBase', Flag_IRetrieve: 'FlagSelfRetrieve',
  Respond_RespondWait: 'GlobalRespondWait', SelfAttack_Attack: 'SelfAttack', SelfDefend_Defend: 'SelfDefend',
  Enemy_Generator: 'EnemyGeneratorDestroyed', Enemy_Sensors: 'EnemySensorsDestroyed', Enemy_Turrets: 'EnemyTurretsDestroyed', Enemy_Vehicle: 'EnemyVehicleDestroyed',
  Upgrade_Sensor: 'UpgradeSensors', Upgrade_Turret: 'UpgradeTurrets', UpgradeSelf_Generator: 'SelfUpgradeGenerator',
  UpgradeSelf_Sensor: 'SelfUpgradeSensors', UpgradeSelf_Turret: 'SelfUpgradeTurrets',
};

export function vgsIdFromWave(wave: string): string | null {
  const w = wave.replace(/^AUD_VGS_/, '');
  if (SPECIAL[w]) return SPECIAL[w];
  let m = /^CaH_(ILL_)?(ATTACK|DEFEND)_([A-E])$/.exec(w);
  if (m) return `${m[1] ? 'Self' : ''}${m[2] === 'ATTACK' ? 'Attack' : 'Defend'}Point${m[3]}`;
  m = /^(Compliment|Respond|Taunt)_(\w+)$/.exec(w);
  if (m) return `Global${m[1]}${m[2]}`;
  if (/^Warn_Context_/.test(w)) return null;
  return w.replace(/_/g, '');
}

// Match announcer wave -> event key used by the client.
const ANNOUNCER: Record<string, string> = {
  OurFlagHasBeenReturned: 'flag_return_ours', TheEnemyFlagHasBeenReturned: 'flag_return_theirs',
  OurTeamHasCapturedTheEnemyFlag: 'flag_cap_ours', TheEnemyHasCapturedOurFlag: 'flag_cap_theirs', YouHaveCapturedTheEnemyFlag: 'flag_cap_you',
  OurTeamHasTheEnemyFlag: 'flag_grab_ours', TheEnemyHasOurFlag: 'flag_grab_theirs', YouHaveTheEnemyFlag: 'flag_grab_you',
  OurTeamHasDroppedTheEnemyFlag: 'flag_drop_ours', TheEnemyHasDroppedOurFlag: 'flag_drop_theirs', YouHaveDroppedTheEnemyFlag: 'flag_drop_you',
  YouHaveReturnedOurFlag: 'flag_return_you',
};

function oggOf(pkg: UPackage, i: number): Uint8Array | null {
  const data = pkg.exportData(pkg.exports[i]);
  const obj = parseObject(pkg, data);
  if (!obj) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = obj.end;
  // RawData, CompressedPCData (Ogg Vorbis), Xbox360, PS3 bulk blocks.
  for (let k = 0; k < 4 && o + 16 <= data.length; k++) {
    const flags = v.getUint32(o, true), size = v.getInt32(o + 8, true);
    const at = o + 16;
    if (!(flags & 1) && size > 4 && data[at] === 0x4f && data[at + 1] === 0x67 && data[at + 2] === 0x67 && data[at + 3] === 0x53) return data.slice(at, at + size);
    o = at + (flags & 1 ? 0 : Math.max(0, size));
  }
  return null;
}

const packName = (group: string, sourcePath: string | undefined): string => {
  const m = sourcePath ? /VO \d+ - ([^\\/]+)/.exec(sourcePath) : null;
  if (m) return m[1].trim();
  return group.replace(/^AUD_VGS_(DLC_)?/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
};

/** Export VGS voice packs and match announcer lines from TribesGame.u as .ogg files plus manifest.json. */
export function extractVoices(pkg: UPackage, outDir: string, log: (s: string) => void): VoiceManifest {
  const packs = new Map<string, VoicePackInfo>();
  const announcer: string[] = [];
  for (let i = 0; i < pkg.exports.length; i++) {
    const e = pkg.exports[i];
    if (pkg.className(e) !== 'SoundNodeWave') continue;
    const path = pkg.refPath(i + 1).split('.');
    const group = path[0];
    if (group.startsWith('AUD_VGS_')) {
      const id = vgsIdFromWave(e.objectName);
      if (!id) continue;
      const packId = `ta_${group.replace(/^AUD_VGS_/, '').toLowerCase()}`;
      let pack = packs.get(packId);
      if (!pack) {
        const src = parseObject(pkg, pkg.exportData(e))?.props.get('SourceFilePath');
        pack = { id: packId, name: packName(group, typeof src === 'string' ? src : undefined), lines: [] };
        packs.set(packId, pack);
      }
      const ogg = oggOf(pkg, i);
      if (!ogg) continue;
      mkdirSync(join(outDir, packId), { recursive: true });
      writeFileSync(join(outDir, packId, `${id}.ogg`), ogg);
      pack.lines.push(id);
    } else if (group === 'AUD_VOX_MatchAnnouncer') {
      const key = ANNOUNCER[e.objectName.replace(/^AUD_VOX_MatchAnnouncer_CTF_/, '')];
      const ogg = key ? oggOf(pkg, i) : null;
      if (!key || !ogg) continue;
      mkdirSync(join(outDir, 'announcer'), { recursive: true });
      writeFileSync(join(outDir, 'announcer', `${key}.ogg`), ogg);
      announcer.push(key);
    }
  }
  const manifest: VoiceManifest = { packs: [...packs.values()].filter((p) => p.lines.length).sort((a, b) => a.name.localeCompare(b.name)), announcer };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`voices: ${manifest.packs.length} packs (${manifest.packs.reduce((n, p) => n + p.lines.length, 0)} lines), ${announcer.length} announcer lines`);
  return manifest;
}
