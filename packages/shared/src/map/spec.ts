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
  /** Index ranges per material; `tex` indexes MapData.textures (-1 = untextured). */
  groups?: { start: number; count: number; tex: number }[];
}

/** Lighting/atmosphere taken from the original level (DominantDirectionalLight, SkyLight, ExponentialHeightFog). */
export interface MapEnv {
  sunDir?: { x: number; y: number; z: number }; // direction towards the sun
  sunColor?: number;
  sunIntensity?: number;
  ambientColor?: number;
  fogColor?: number;
  fogDensity?: number;
  fogStart?: number;
  snow?: boolean;
}

export interface TerrainLayer { tex: number; scale: number }

/** Affine 3x4 row-major transform: world = M * local + t, packed [m00,m01,m02,tx, m10,m11,m12,ty, m20,m21,m22,tz]. */
export interface MeshInstance { mesh: number; m: Float32Array; team?: number }

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
}
