export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;
export const MAX_PLAYERS = 32;

// Original TA / UE3 uses 50 Unreal units per meter; the sim runs in meters (y-up).
export const UU_PER_METER = 50;
export const MS_TO_KMH = 3.6;

// TA: UE3 world gravity -520 uu/s^2 (Katabatic WorldInfo default); pawns scale it by CustomGravityScaling 0.8.
export const GRAVITY = 10.4;
export const PAWN_GRAVITY_SCALE = 0.8;
// TrPawn.m_fSkiSlopeGravityBoost: gravity along the slope counts double while skiing downhill.
export const SKI_SLOPE_GRAVITY_BOOST = 2;
export const TERMINAL_VELOCITY = 160;
// TrFamilyInfo m_fMaxJetpackThrustSpeed 1000 uu/s, m_fAccelRateAtMaxThrustSpeed 16: jet lift fades as the climb rate nears it.
export const JET_MAX_THRUST_SPEED = 20;
export const JET_THRUST_AT_MAX = 0.16;
// Skiing is frictionless (F/Standard_Equipment); quadratic drag bites above ~175 km/h, plus light drag while airborne.
export const AIR_DRAG_START = 48;
export const AIR_DRAG = 0.0011;
export const AIRBORNE_DRAG = 0.010;

// Air-strafing (Quake/TA): turning mid-air curves the velocity vector. Steering
// authority is the armor's airControl scaled by how sideways the new view is, plus a
// small constant pull so a sustained turn keeps bleeding speed upward.
export const AIR_STRAFE_ACCEL = 14; // m/s^2 of constant pull while steering in the air
export const AIR_STRAFE_FRACTION = 0.7; // fraction of airControl applied to lateral steering
// Skiing keeps its per-armor acceleration cap for normal play; a sustained clean
// downhill run can push past it up to this ceiling (460 km/h = 127.8 m/s).
export const SKI_SPEED_CAP = 128; // m/s
// Slope-flow energy conservation (frictionless-slope model): collision clips the velocity
// tangential to the surface, which bleeds the downhill acceleration. Restoring this share
// of the clipped component along the slope keeps a clean long descent accelerating to the cap.
export const SKI_SLOPE_FLOW = 1.0;

export const HEALTH_REGEN_DELAY = 15;
export const HEALTH_REGEN_RATE = 0.12; // fraction of max per second
export const FALL_DAMAGE_THRESHOLD = 34; // m/s into surface (TrPawn.m_fSplatSpeedMin 1700 uu/s)
export const FALL_DAMAGE_PER_MS = 22;
export const COLLISION_DAMAGE_KMH = 50;

export const RESPAWN_TIME = 5;
export const FLAG_RETURN_TIME = 40;
export const FLAG_THROW_SPEED = 18;
export const FLAG_GRAB_RADIUS = 2.2;
export const FLAG_DRAG_KMH: Record<'light' | 'medium' | 'heavy', number> = { light: 300, medium: 275, heavy: 250 };

export const TEAM_NAMES = ['Blood Eagle', 'Diamond Sword'] as const;
export const TEAM_COLORS = [0xd8412f, 0x2f7fd8] as const;
export const SPECTATOR_TEAM = 255;

export const BOT_TAG = '[BOT]';
