import type { AssetType } from '../data/assets.js';
import type { ModeId } from '../data/modes.js';
import type { Vec3 } from '../math.js';
import type { OBB } from '../sim/collision.js';
import type { Heightfield } from '../sim/terrain.js';
import type { ThemeId } from './themes.js';

export type EntityKind = AssetType | 'spawn' | 'blitz_stand' | 'rabbit_flag' | 'bookmark';

export interface MapEntity {
  kind: EntityKind;
  team: number;       // 0/1, 255 = neutral
  pos: Vec3;
  yaw: number;
  modes?: ModeId[];   // undefined = all modes
  tag?: string;       // e.g. control point letter
}

export type FeatureType = 'hill' | 'ridge' | 'valley' | 'plateau' | 'bowl' | 'crater' | 'channel';

export interface Feature {
  type: FeatureType;
  x: number; z: number;
  x2?: number; z2?: number;  // ridge / valley / channel endpoint
  r: number;                 // radius / half-width
  h: number;                 // height (negative carves)
  edge?: number;             // plateau edge softness 0..1
  noMirror?: boolean;
}

export type PrefabId =
  | 'main_base' | 'tower' | 'vehicle_pad' | 'turret_mount' | 'gen_bunker' | 'flag_platform' | 'cap_point'
  | 'arena_bunker' | 'rock' | 'ice_spike' | 'pillar' | 'arch' | 'bridge' | 'wall' | 'ruin' | 'crate_stack' | 'ramp'
  | 'rabbit_flag' | 'blitz_stand' | 'spawn_ring' | 'sniper_nest' | 'catwalk';

export interface PrefabPlacement {
  prefab: PrefabId;
  x: number; z: number;
  yaw?: number;
  team?: number;
  lift?: number;      // meters above ground at origin
  flatten?: number;   // flatten radius (0 disables)
  scale?: number;
  len?: number;       // bridge / wall length
  tag?: string;
  modes?: ModeId[];
  noMirror?: boolean;
}

export interface MapSpec {
  id: string;
  name: string;
  theme: ThemeId;
  modes: ModeId[];
  size: number;          // square world width (m)
  res: number;           // heightfield samples per side
  seed: number;
  baseHeight: number;
  noise: { amp: number; scale: number; octaves: number; ridged?: number };
  edge: { start: number; height: number };
  mirror: 'point' | 'none';
  features: Feature[];
  prefabs: PrefabPlacement[];
  scatter: number;       // decoration density multiplier
  wikiRef?: string;
  internal?: string[];   // original package names (TrCTF-Katabatic, ...)
}

export interface MeshAsset {
  name: string;
  positions: Float32Array; // meters, map axes (y-up)
  indices: Uint32Array;
  mat: string;
  collide: boolean;
  /** Collision-only geometry (blocking volumes, invisible BSP). */
  hidden?: boolean;
  /** UV0 per vertex (original maps). */
  uvs?: Float32Array;
  /** Lightmap UVs (the mesh's LightMapCoordinateIndex set) when they differ from UV0. */
  uv2?: Float32Array;
  /**
   * Index ranges per material; `tex` indexes MapData.textures (-1 = untextured), `ntex` the normal map, `fx` liquids or
   * the blend of TA's non-opaque materials (light beams, glows, glass, grime decals).
   */
  groups?: { start: number; count: number; tex: number; ntex?: number; stex?: number; fx?: MeshFx }[];
}

export type MeshFx = 'lava' | 'water' | 'additive' | 'translucent' | 'modulate';

/** Lighting/atmosphere taken from the original level (DominantDirectionalLight, SkyLight, ExponentialHeightFog). */
export interface MapEnv {
  sunDir?: { x: number; y: number; z: number }; // direction towards the sun
  sunColor?: number;
  sunIntensity?: number;
  ambientColor?: number;
  fogColor?: number;
  fogDensity?: number;
  fogStart?: number;
  /** ExponentialHeightFog actor height (m), FogHeightFalloff (UE units), FogMaxOpacity, light-side inscattering colour. */
  fogHeight?: number;
  fogFalloff?: number;
  fogMaxOpacity?: number;
  fogLightColor?: number;
  snow?: boolean;
  /** The sun is a static DirectionalLight, so lightmaps already contain its light (else it is dominant/dynamic). */
  sunBaked?: boolean;
}

export interface TerrainLayer { tex: number; scale: number; ntex?: number; stex?: number }

/**
 * TA's damage volumes (UTKillZVolume, pain-causing PhysicsVolume such as lava): a convex hull given as planes
 * [nx, ny, nz, d, ...] with the inside where n·p <= d, plus its bounds.
 */
export interface MapVolume { kind: 'kill' | 'pain'; dps: number; min: Vec3; max: Vec3; planes: Float32Array }

/**
 * TA accelerators and launch pads (Kismet: Touch volume -> [team check] -> SetVelocity): entering sets a player's
 * velocity to `vel` (map m/s), or multiplies it by `scale` when given. `team` 255 = anyone, else only that team.
 * `cond`: only when that velocity component is above (`gt`) or below `value` (one-way accelerators).
 */
export interface MapBoost {
  min: Vec3; max: Vec3; planes: Float32Array; vel: Vec3; scale?: number; team: number;
  cond?: { axis: 'x' | 'y' | 'z'; gt: boolean; value: number };
}

/**
 * Energy fields that stop players but not shots. `team` 0/1: the defenders, who pass (TA TrTeamBlockerStaticMeshActor);
 * 255: blocks everyone. `gate`: the team whose generator powers it (down while that generator is), else always up.
 */
export interface MapBlocker { instance: number; team: number; gate?: number }

/** Inside a volume (point in map metres). */
export function inVolume(v: { min: Vec3; max: Vec3; planes: Float32Array }, p: Vec3): boolean {
  if (p.x < v.min.x || p.y < v.min.y || p.z < v.min.z || p.x > v.max.x || p.y > v.max.y || p.z > v.max.z) return false;
  const P = v.planes;
  for (let i = 0; i < P.length; i += 4) if (P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z > P[i + 3]) return false;
  return true;
}

/**
 * Affine 3x4 row-major transform: world = M * local + t, packed [m00,m01,m02,tx, m10,m11,m12,ty, m20,m21,m22,tz].
 * `lm`: TA's baked (Lightmass) lighting: `tex` indexes MapData.textures (an sRGB lightmap atlas), lightmap UV ->
 * atlas UV = uv * st.xy + st.zw, and the decoded texel is multiplied by `scale`.
 */
export interface MeshInstance { mesh: number; m: Float32Array; team?: number; lm?: InstanceLightmap }
export interface InstanceLightmap { tex: number; st: [number, number, number, number]; scale: [number, number, number] }

export interface MapData {
  id: string;
  name: string;
  theme: ThemeId;
  source: 'reborn' | 'original';
  modes: ModeId[];
  terrain: Heightfield;
  boxes: OBB[];
  entities: MapEntity[];
  meshes?: MeshAsset[];
  instances?: MeshInstance[];
  killZ?: number;
  /** Texture names served at /assets/tex/<name>.atx by the local node or the host. */
  textures?: string[];
  /** Up to 5 terrain layers; layer 0 is the base, layers 1-4 weighted by terrainSplat RGBA. */
  terrainLayers?: TerrainLayer[];
  terrainSplat?: Uint8Array;
  env?: MapEnv;
  volumes?: MapVolume[];
  boosts?: MapBoost[];
  blockers?: MapBlocker[];
}
