import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { UU_PER_METER } from '@ar/shared';
import { Resolver, resolveDiffuse, type ObjRef } from './material.js';
import { extractSkeletalMesh, type SkelMeshData } from './skel.js';
import { UPackage } from './upk.js';

/** Third-person models used by the client, keyed by the name the client asks for. */
const MODELS: Record<string, string> = {
  pc_pathfinder_0: 'PC_BloodEagle_Light.Models.SKL_PC_BE_Light', pc_pathfinder_1: 'PC_DiamondSword_Light.Models.SKL_PC_DS_Light',
  pc_sentinel_0: 'PC_BloodEagle_Light.Models.SKL_PC_BE_Light_SNT', pc_sentinel_1: 'PC_DiamondSword_Light.Models.SKL_PC_DS_Light_SNT',
  pc_infiltrator_0: 'PC_BloodEagle_Light.Models.SKL_PC_BE_Light_INF', pc_infiltrator_1: 'PC_DiamondSword_Light.Models.SKL_PC_DS_Light_INF',
  pc_soldier_0: 'PC_BloodEagle_Medium.Models.SKL_PC_BE_Medium', pc_soldier_1: 'PC_DiamondSword_Medium.Models.SKL_PC_DS_Medium',
  pc_technician_0: 'PC_BloodEagle_Medium.Models.SKL_PC_BE_Medium_TCN', pc_technician_1: 'PC_DiamondSword_Medium.Models.SKL_PC_DS_Medium_TCN',
  pc_raider_0: 'PC_BloodEagle_Medium.Models.SKL_PC_BE_Medium_RDR', pc_raider_1: 'PC_DiamondSword_Medium.Models.SKL_PC_DS_Medium_RDR',
  pc_juggernaut_0: 'PC_BloodEagle_Heavy.Models.SKL_PC_BE_Heavy', pc_juggernaut_1: 'PC_DiamondSword_Heavy.Models.SKL_PC_DS_Heavy',
  pc_doombringer_0: 'PC_BloodEagle_Heavy.Models.SKL_PC_BE_Heavy_DMB', pc_doombringer_1: 'PC_DiamondSword_Heavy.Models.SKL_PC_DS_Heavy_DMB',
  pc_brute_0: 'PC_BloodEagle_Heavy.Models.SKL_PC_BE_Heavy_BRT', pc_brute_1: 'PC_DiamondSword_Heavy.Models.SKL_PC_DS_Heavy_BRT',
  // Mercenary skins (not team-specific).
  pc_pathfinder_merc: 'PC_Merc_Pathfinder_B.Models.SKL_PC_Merc_Pathfinder', pc_sentinel_merc: 'PC_Merc_Sentinel.Models.SKL_PC_Merc_Sentinel',
  pc_infiltrator_merc: 'PC_Merc_Infiltrator.Models.SKL_PC_Merc_Infiltrator', pc_infiltrator_merc2: 'PC_Merc_Light.Models.SKL_PC_Merc_Infiltrator',
  pc_soldier_merc: 'PC_Robot_Soldier.Models.SKL_PC_Merc_Soldier', pc_raider_merc: 'PC_Merc_Raider.Models.SKL_PC_Merc_Raider',
  pc_raider_merc2: 'PC_Merc_Medium.Models.SKL_PC_Merc_Raider', pc_technician_merc: 'PC_Merc_Technician.Models.SKL_PC_Merc_TCN',
  pc_juggernaut_merc: 'PC_Merc_Juggernaut.Models.SKL_PC_MERC_Heavy_JGR', pc_doombringer_merc: 'PC_Merc_Doombringer.Models.SKL_PC_MERC_Heavy_DMB',
  pc_brute_merc: 'PC_Merc_Brute.Models.SKL_PC_MERC_Heavy_BRT',
  veh_gravcycle: 'VEH_GravCycle.Models.SKL_VEH_GravCycle', veh_beowulf: 'VEH_Beowulf.Models.SKL_VEH_Beowulf', veh_shrike: 'VEH_Shrike.Models.SKL_VEH_Shrike',
  stn_inventory: 'STN_Inventory.Models.SKL_STN_Inventory', stn_vehicle: 'STN_Vehicle.Models.SKL_STN_Vehicle', stn_repair: 'STN_RepairTool.Models.SKL_STN_RepairTool',
  generator: 'GEN_BaseGenerator.Models.SKL_STN_BaseGenerator', cap_point: 'OBJ_CaHControlPoint.Models.SKL_CaH_TouchBase', supply_drop: 'CI_Resupply.Models.SKL_CI_Resupply',
  flag_0: 'CTF_Flags.BloodEagle.Models.SKL_BE_Flag', flag_1: 'CTF_Flags.DiamondSword.Models.SKL_DS_Flag',
  flagstand_0: 'CTF_Flags.BloodEagle.Models.SKL_BE_FlagStand', flagstand_1: 'CTF_Flags.DiamondSword.Models.SKL_DS_FlagStand',
  dep_forcefield: 'DEP_ForceField_3p.Models.SKL_DEP_ForceField_3p', dep_jammer: 'DEP_Jammer_3p.Models.SKL_DEP_Jammer_3p',
  dep_motion_sensor: 'DEP_MotionSensor_3p.Models.SKL_DEV_MotionSensor_3p', dep_pulse_sensor: 'DEP_PulseSensor_3p.Models.SKL_DEP_PulseSensor_3p',
  dep_prism_mine: 'DEP_PrismMine_3p.Models.SKL_DEP_PrismMine_3p', dep_turret_light: 'DEP_TurretLight_3p.Models.SKL_DEP_TurretLight_3p',
  dep_turret_heavy: 'DEP_TurretHeavy_3p.Models.SKL_DEP_TurretHeavy_3p', dep_turret_rocket: 'DEP_TurretRocket_3p.Models.SKL_DEP_TurretRocket_3p',
  wep_light_spinfusor: 'WEP_LightSpinfusor_3p.Models.SKL_WEP_LightSpinFusor_3p', wep_spinfusor: 'WEP_Spinfusor_3p.Models.SKL_WEP_Spinfusor_3p',
  wep_heavy_spinfusor: 'WEP_HeavySpinfusor_3p.Models.SKL_WEP_HeavySpinFusor_3p', wep_twinfusor: 'WEP_Twinfusor_3p.Medium.SKL_WEP_TwinFusor_3p',
  wep_bolt_launcher: 'WEP_BoltLauncher_3p.Models.SKL_WEP_BoltLauncher_3p', wep_heavy_bolt_launcher: 'WEP_HeavyBoltLauncher_3p.Models.SKL_WEP_HeavyBoltLauncher_3p',
  wep_shotgun: 'WEP_Shotgun_3p.Models.SKL_WEP_Shotgun_3p', wep_auto_shotgun: 'WEP_Shotgun_3p.ALT_AUTO.SKL_WEP_AutoShotgun_3p', wep_sawed_off: 'WEP_Shotgun_3p.ALT_SAWED.SKL_WEP_ShotgunSawedOff_3p',
  wep_assault_rifle: 'WEP_AssaultRifle_3p.Models.SKL_WEP_AssaultRifle_3p', wep_lar: 'WEP_AssaultRifle_3p.ALT_LAR.SKL_WEP_LAR_3p',
  wep_shocklance: 'WEP_ShockLance_3p.Models.SKL_WEP_ShockLance_3p', wep_sniper: 'WEP_SniperRifle_3p.Models.SKL_WEP_SniperRifle_3p',
  wep_phase_rifle: 'WEP_EnergySniperRifle_3p.Models.SKL_WEP_EnergySniperRifle_3p', wep_sap20: 'WEP_EnergySniperRifle_3p.ALT_SAP20.SKL_WEP_SAP20_3p',
  wep_nova_blaster: 'WEP_NovaColt_3p.Blaster.SKL_WEP_Blaster_3p', wep_nova_colt: 'WEP_NovaColt_3p.Models.SKL_WEP_NovaColt_3p',
  wep_falcon: 'WEP_Pistol02_3p.ALT_Falcon.SKL_WEP_Falcon_3p', wep_sn7: 'WEP_Pistol01_3p.WEP_SN7Pistol.SKL_WEP_SN7_3p', wep_pistol: 'WEP_Pistol01_3p.Models.SKL_WEP_Pistol01_3p',
  wep_rhino_smg: 'WEP_SMG_3p.ALT_SIL290.SKL_WEP_SIL290_3p', wep_tcn4: 'WEP_SMG_3p.ALT_TCN4.SKL_WEP_TCN4_3p', wep_nj4: 'WEP_NJ4_3p.Models.SKL_WEP_NJ4_3p', wep_nj5: 'WEP_NJ4_3p.ALT_NJ5.SKL_WEP_NJ5_3p',
  wep_jackal: 'WEP_ArxBuster_3p.ALT_REMOTE.SKL_WEP_ArxBusterRemote_3p', wep_arx_buster: 'WEP_ArxBuster_3p.Models.SKL_WEP_ArxBuster_3p',
  wep_thumper: 'WEP_Thumper_3p.Models.SKL_WEP_Thumper_3p', wep_thumper_d: 'WEP_Thumper_3p.ALT_D.SKL_WEP_ThumperD_3p',
  wep_repair_tool: 'WEP_RepairPack_3p.Models.SKL_WEP_RepairTool_3p', wep_grenade_launcher: 'WEP_GrenadeLauncher_3p.Models.SKL_WEP_GrenadeLauncher_3p',
  wep_plasma_gun: 'WEP_PlasmaGun_3p.Models.SKL_WEP_PlasmaGun_3p', wep_plasma_cannon: 'WEP_PlasmaCannon_3p.Models.SKL_WEP_PlasmaCannon_3p',
  wep_mortar: 'WEP_MortarLauncher_3p.Models.SKL_WEP_MortarLauncher_3p', wep_mirv: 'WEP_MortarLauncher_3p.ALT_Mirv.SKL_WEP_Mirv_3p',
  wep_lmg: 'WEP_LMG_3p.Models.SKL_WEP_LMG_3p', wep_chaingun: 'WEP_Chaingun_3p.Models.SKL_WEP_Chaingun_3p',
  wep_rocket_launcher: 'WEP_RocketLauncher_3p.Models.SKL_WEP_RocketLauncher_3p', wep_throwing_knives: 'WEP_ThrowingKnives_3p.Models.SKL_WEP_ThrowingKnives_3p',
};

const S = 1 / UU_PER_METER;

/**
 * Binary model (gzipped): 'AMD1', u16 bones, u32 verts, u32 indices, u16 sections; bones (name, i16 parent, quat, pos);
 * f32 positions, f32 uvs, u16 skin indices, u8 skin weights, u32 indices; sections (u32 first, u32 count, texture name).
 * Converted to the client's space: metres, y-up (UE y/z swapped, so quaternions become (-x,-z,-y,w)).
 */
function encodeModel(m: SkelMeshData, tex: (string | null)[]): Buffer {
  const enc = new TextEncoder();
  const names = m.bones.map((b) => enc.encode(b.name.slice(0, 60)));
  const secNames = m.sections.map((s) => enc.encode((tex[s.material] ?? '').slice(0, 120)));
  const n = m.positions.length / 3;
  const size = 16 + names.reduce((a, b) => a + 1 + b.length + 2 + 28, 0) + n * (12 + 8 + 8 + 4) + m.indices.length * 4 + secNames.reduce((a, b) => a + 9 + b.length, 0);
  const buf = Buffer.alloc(size);
  let o = 0;
  buf.write('AMD1', 0, 'latin1'); o = 4;
  buf.writeUInt16LE(m.bones.length, o); o += 2;
  buf.writeUInt32LE(n, o); o += 4;
  buf.writeUInt32LE(m.indices.length, o); o += 4;
  buf.writeUInt16LE(m.sections.length, o); o += 2;
  m.bones.forEach((b, i) => {
    buf.writeUInt8(names[i].length, o++); buf.set(names[i], o); o += names[i].length;
    buf.writeInt16LE(b.parent, o); o += 2;
    for (const v of [-b.rot[0], -b.rot[2], -b.rot[1], b.rot[3], b.pos[0] * S, b.pos[2] * S, b.pos[1] * S]) { buf.writeFloatLE(v, o); o += 4; }
  });
  for (let v = 0; v < n; v++) for (const a of [0, 2, 1]) { buf.writeFloatLE(m.positions[v * 3 + a] * S, o); o += 4; }
  for (let i = 0; i < n * 2; i++) { buf.writeFloatLE(m.uvs[i], o); o += 4; }
  for (let i = 0; i < n * 4; i++) { buf.writeUInt16LE(m.skinIndex[i], o); o += 2; }
  for (let i = 0; i < n * 4; i++) buf.writeUInt8(m.skinWeight[i], o++);
  // Axis swap mirrors the mesh: reverse winding to keep faces outward.
  for (let i = 0; i < m.indices.length; i += 3) {
    buf.writeUInt32LE(m.indices[i], o); buf.writeUInt32LE(m.indices[i + 2], o + 4); buf.writeUInt32LE(m.indices[i + 1], o + 8); o += 12;
  }
  m.sections.forEach((s, i) => {
    buf.writeUInt32LE(s.firstIndex, o); buf.writeUInt32LE(s.numTriangles * 3, o + 4); o += 8;
    buf.writeUInt8(secNames[i].length, o++); buf.set(secNames[i], o); o += secNames[i].length;
  });
  return gzipSync(buf.subarray(0, o));
}

function skeletalIndex(cooked: string, cacheFile: string): Map<string, string> {
  const out = existsSync(cacheFile) ? new Map(Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>)) : new Map<string, string>();
  // Rescan only when the model table asks for meshes the cache does not know yet.
  const wanted = new Set(Object.values(MODELS).filter((p) => !out.has(p)));
  if (!wanted.size) return out;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(upk|u)$/i.test(f)) continue;
      try {
        const pkg = new UPackage(p);
        for (let i = 0; i < pkg.exports.length; i++) {
          if (pkg.className(pkg.exports[i]) !== 'SkeletalMesh') continue;
          const path = pkg.refPath(i + 1);
          if (wanted.has(path) && !out.has(path)) out.set(path, p);
        }
      } catch { /* unreadable package */ }
    }
  };
  walk(cooked);
  writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(out)));
  return out;
}

/** Exports characters, weapons, vehicles, stations, flags and deployables to outDir/models (+ manifest.json). */
export function exportModels(cooked: string, outDir: string, resolver: Resolver, load: (path: string) => UPackage,
  onTexture: ((t: ObjRef) => string | null) | undefined, log: (s: string) => void) {
  const dir = join(outDir, 'models');
  mkdirSync(dir, { recursive: true });
  const index = skeletalIndex(cooked, join(dir, '.skeletal-index.json'));
  const manifest: Record<string, { file: string; bones: number; verts: number }> = {};
  let failed = 0;
  for (const [key, path] of Object.entries(MODELS)) {
    const file = index.get(path);
    if (!file) { failed++; continue; }
    const pkg = load(file);
    const i = pkg.exports.findIndex((_, k) => pkg.refPath(k + 1) === path);
    try {
      const m = extractSkeletalMesh(pkg, pkg.exports[i]);
      const tex = m.materials.map((ref) => {
        const mat = resolver.get(pkg, ref);
        const t = mat ? resolveDiffuse(resolver, mat) : null;
        return t && onTexture ? onTexture(t) : null;
      });
      writeFileSync(join(dir, `${key}.amdl`), encodeModel(m, tex));
      manifest[key] = { file: `${key}.amdl`, bones: m.bones.length, verts: m.positions.length / 3 };
    } catch (err) {
      failed++;
      log(`  ! model ${key}: ${(err as Error).message}`);
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ models: manifest }, null, 1));
  log(`models: ${Object.keys(manifest).length} exported${failed ? `, ${failed} missing` : ''}`);
}
