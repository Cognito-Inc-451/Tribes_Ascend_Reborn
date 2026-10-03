import { AIR_DRAG, AIR_DRAG_START, AIRBORNE_DRAG, GRAVITY, JET_MAX_THRUST_SPEED, JET_THRUST_AT_MAX, PAWN_GRAVITY_SCALE, SKI_SLOPE_GRAVITY_BOOST, TERMINAL_VELOCITY } from '../constants.js';
import type { ArmorPhysics } from '../data/classes.js';
import { inVolume, type MapBoost } from '../map/spec.js';
import type { Vec3 } from '../math.js';
import type { CollisionWorld } from './collision.js';

const PAWN_G = GRAVITY * PAWN_GRAVITY_SCALE;

export const BTN = {
  JET: 1, SKI: 2, JUMP: 4, FIRE: 8, MELEE: 16, BELT: 32, PACK: 64, USE: 128, RELOAD: 256, DROP_FLAG: 512, ZOOM: 1024, SPOT: 2048, ALT: 4096,
} as const;

export interface InputCmd {
  seq: number;
  fwd: number;     // -1..1
  strafe: number;  // -1..1 (+ = right)
  yaw: number;
  pitch: number;
  buttons: number;
  weapon: number;  // selected slot 0 primary,1 secondary,2 belt(throw),3 pack
}

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  energy: number;
  onGround: boolean;
  skiing: boolean;
  jetting: boolean;
  prevButtons: number;
  groundNormal: Vec3;
}

export interface MoveParams {
  phys: ArmorPhysics;
  maxEnergy: number;
  regenMult: number;
  runMult: number;
  massMult: number;
  flagDragSpeed: number; // m/s; 0 = no flag
  canJet: boolean;
  ignoreDynamic?: number;
  team?: number;
  infiniteEnergy?: boolean;
}

export interface MoveResult { impact: number; hitWall: boolean }

export const newMoveState = (pos: Vec3): MoveState => ({
  pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, energy: 100, onGround: false, skiing: false, jetting: false, prevButtons: 0, groundNormal: { x: 0, y: 1, z: 0 },
});

export function wishDir(cmd: InputCmd): Vec3 {
  const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  let x = -sy * cmd.fwd + cy * cmd.strafe;
  let z = -cy * cmd.fwd - sy * cmd.strafe;
  const l = Math.hypot(x, z);
  if (l > 1) { x /= l; z /= l; }
  return { x, y: 0, z };
}

/** One fixed tick of player movement. Shared by client prediction and server authority. */
export function stepMovement(s: MoveState, cmd: InputCmd, p: MoveParams, world: CollisionWorld, dt: number): MoveResult {
  const ph = p.phys;
  const v = s.vel;
  const G = PAWN_G * world.gravityScale;
  const start = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
  const wish = wishDir(cmd);
  const wishLen = Math.hypot(wish.x, wish.z);
  const jetHeld = (cmd.buttons & BTN.JET) !== 0;
  const jetPressed = jetHeld && (s.prevButtons & BTN.JET) === 0;
  const jumpPressed = (cmd.buttons & BTN.JUMP) !== 0 && (s.prevButtons & BTN.JUMP) === 0;
  s.skiing = (cmd.buttons & BTN.SKI) !== 0;
  s.prevButtons = cmd.buttons;

  const startJet = jetPressed && s.energy > ph.jetInitialCost;
  s.jetting = p.canJet && jetHeld && s.energy > 0 && (s.jetting || startJet || !jetPressed);
  if (s.jetting && s.energy <= 0) s.jetting = false;

  if (s.onGround && (jumpPressed || (startJet && p.canJet))) {
    v.y = Math.max(v.y, 0) + ph.jumpSpeed * (jumpPressed ? 1 : 0.5);
    if (startJet) s.energy -= ph.jetInitialCost;
    s.onGround = false;
  }

  const walking = s.onGround && !s.skiing && !s.jetting;

  if (walking) {
    const n = s.groundNormal;
    const run = ph.runSpeed * p.runMult;
    const hx = v.x, hz = v.z;
    const hspeed = Math.hypot(hx, hz);
    if (hspeed > run * 1.05) {
      // Coming off a ski: ground friction bleeds speed quickly.
      const dec = Math.min(hspeed - run, ph.groundFriction * 2.5 * dt);
      v.x -= (hx / hspeed) * dec;
      v.z -= (hz / hspeed) * dec;
      if (wishLen > 0) { v.x += wish.x * 20 * dt; v.z += wish.z * 20 * dt; }
    } else {
      const tx = wish.x * run, tz = wish.z * run;
      const accel = (wishLen > 0 ? 70 : 55) * dt;
      const dx = tx - hx, dz = tz - hz;
      const dl = Math.hypot(dx, dz);
      if (dl <= accel) { v.x = tx; v.z = tz; } else { v.x += (dx / dl) * accel; v.z += (dz / dl) * accel; }
    }
    // Keep velocity tangent to walkable ground so players do not slide while walking.
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    v.x -= vn * n.x; v.y -= vn * n.y; v.z -= vn * n.z;
    if (n.y < 0.6) v.y -= G * dt; // too steep: slide
  } else {
    v.y -= G * dt;
    const along = v.x * wish.x + v.z * wish.z;
    if (s.onGround && s.skiing && !s.jetting) {
      // Frictionless; downhill slope gravity is boosted (TA), uphill is not, so speed carries over crests.
      const n = s.groundNormal;
      const gx = G * n.y * n.x, gy = G * (n.y * n.y - 1), gz = G * n.y * n.z;
      if (v.x * gx + v.y * gy + v.z * gz > 0) {
        const k = (SKI_SLOPE_GRAVITY_BOOST - 1) * dt;
        v.x += gx * k; v.y += gy * k; v.z += gz * k;
      }
      if (wishLen > 0) {
        const hs = Math.hypot(v.x, v.z) || 1;
        const px = -v.z / hs, pz = v.x / hs;
        const lat = wish.x * px + wish.z * pz;
        v.x += px * lat * ph.skiControl * dt;
        v.z += pz * lat * ph.skiControl * dt;
        if (along < ph.skiAccelCap) { const add = Math.min(ph.skiAccel * dt, ph.skiAccelCap - along); v.x += wish.x * add; v.z += wish.z * add; }
      }
    } else if (s.jetting) {
      // Full lift up to half the max thrust speed, fading to 16 % at it: a held jet settles into a steady climb.
      const fade = Math.min(1, Math.max(0, v.y / JET_MAX_THRUST_SPEED - 0.5) * 2);
      v.y += ph.jetAccel * (1 - (1 - JET_THRUST_AT_MAX) * fade) * dt;
      if (wishLen > 0 && along < ph.jetHorizCap) {
        const add = Math.min(ph.jetSideAccel * dt, ph.jetHorizCap - along);
        v.x += wish.x * add; v.z += wish.z * add;
      }
    } else if (wishLen > 0 && along < ph.airSpeedCap) {
      const add = Math.min(ph.airControl * dt, ph.airSpeedCap - along);
      v.x += wish.x * add; v.z += wish.z * add;
    }
  }

  if (s.jetting) s.energy = Math.max(0, s.energy - ph.jetDrain * dt);
  // TA TrPawn.ShouldRechargePowerPool: no recharge while the jet key is held, so an empty tank cannot be pulsed upward.
  else if (!jetHeld) s.energy = Math.min(p.maxEnergy, s.energy + ph.energyRegen * p.regenMult * dt);
  if (p.infiniteEnergy) s.energy = p.maxEnergy;

  let speed = Math.hypot(v.x, v.y, v.z);
  if (!s.onGround && !walking) {
    const k = 1 - AIRBORNE_DRAG * dt;
    v.x *= k; v.y *= k; v.z *= k;
    speed *= k;
  }
  if (!walking && speed > AIR_DRAG_START) {
    const decel = AIR_DRAG * (speed - AIR_DRAG_START) ** 2 * dt;
    const k = Math.max(0, 1 - decel / speed);
    v.x *= k; v.y *= k; v.z *= k;
  }
  if (p.flagDragSpeed > 0) {
    const hs = Math.hypot(v.x, v.z);
    if (hs > p.flagDragSpeed) {
      const k = Math.max(p.flagDragSpeed / hs, 1 - 0.6 * dt);
      v.x *= k; v.z *= k;
    }
  }
  speed = Math.hypot(v.x, v.y, v.z);
  if (speed > TERMINAL_VELOCITY) { const k = TERMINAL_VELOCITY / speed; v.x *= k; v.y *= k; v.z *= k; }

  // Substep to avoid tunnelling at high speed.
  const steps = Math.max(1, Math.ceil((speed * dt) / (ph.radius * 0.8)));
  const sdt = dt / steps;
  let onGround = false, impact = 0, hitWall = false;
  let gn = s.groundNormal;
  for (let i = 0; i < steps; i++) {
    const prev = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
    s.pos.x += v.x * sdt; s.pos.y += v.y * sdt; s.pos.z += v.z * sdt;
    const c = world.resolveCapsule(s.pos, v, ph.radius, ph.height, p.ignoreDynamic, prev, p.team ?? -1);
    if (c.onGround) { onGround = true; gn = c.groundNormal; }
    impact = Math.max(impact, c.impact);
    hitWall ||= c.hitWall;
  }

  // Stick to the ground when walking downhill instead of bouncing off.
  if (!onGround && walking && v.y <= 0.5 && !world.terrain.isHole(s.pos.x, s.pos.z)) {
    const h = world.terrain.heightAt(s.pos.x, s.pos.z);
    const d = s.pos.y - h;
    if (d < 0.35 && d > -0.05) { s.pos.y = h; onGround = true; gn = world.terrain.normalAt(s.pos.x, s.pos.z); }
  }

  // Soft world boundary.
  const t = world.terrain;
  const m = 2;
  if (s.pos.x < t.originX + m) { s.pos.x = t.originX + m; if (v.x < 0) v.x = -v.x * 0.3; }
  if (s.pos.x > t.originX + t.width - m) { s.pos.x = t.originX + t.width - m; if (v.x > 0) v.x = -v.x * 0.3; }
  if (s.pos.z < t.originZ + m) { s.pos.z = t.originZ + m; if (v.z < 0) v.z = -v.z * 0.3; }
  if (s.pos.z > t.originZ + t.depth - m) { s.pos.z = t.originZ + t.depth - m; if (v.z > 0) v.z = -v.z * 0.3; }

  s.onGround = onGround;
  s.groundNormal = gn;
  if (world.boosts.length) applyBoosts(s, start, ph.height, p.team ?? -1, world.boosts);
  return { impact, hitWall };
}

/** TA accelerators / launch pads (Kismet Touch -> SetVelocity): entering one sets (or scales) the velocity. */
function applyBoosts(s: MoveState, from: Vec3, height: number, team: number, boosts: readonly MapBoost[]): void {
  const touching = (b: MapBoost, at: Vec3) => {
    for (const f of [0.1, 0.5, 0.9]) if (inVolume(b, { x: at.x, y: at.y + height * f, z: at.z })) return true;
    return false;
  };
  for (const b of boosts) {
    if (b.team !== 255 && b.team !== team) continue;
    if (!touching(b, s.pos) || touching(b, from)) continue;
    if (b.cond) { const c = s.vel[b.cond.axis]; if (b.cond.gt ? !(c > b.cond.value) : !(c < b.cond.value)) continue; }
    const k = b.scale;
    if (k !== undefined) { s.vel.x *= k; s.vel.y *= k; s.vel.z *= k; }
    else { s.vel.x = b.vel.x; s.vel.y = b.vel.y; s.vel.z = b.vel.z; }
    s.onGround = false;
  }
}
