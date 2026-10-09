import type { CosmeticProfile } from '../data/cosmetics.js';
import type { Loadout } from '../data/classes.js';
import type { ModeId } from '../data/modes.js';
import type { Vec3 } from '../math.js';
import type { InputCmd } from '../sim/movement.js';
import { ByteReader, ByteWriter } from './bytes.js';

export const BIN = { INPUT: 1, SNAPSHOT: 2, FRAG: 3, MAPDATA: 4 } as const;

export const PF = {
  ALIVE: 1, JETTING: 2, SKIING: 4, ON_GROUND: 8, HAS_FLAG: 16, STEALTH: 32, SHIELD: 64, SPECTATOR: 128,
  BOT: 256, FIRING: 512, ZOOMED: 1024, JAMMER: 2048, INVULN: 4096, IN_VEHICLE: 8192, RAGE: 16384, SPOTTED: 32768,
} as const;

export const AF = { POWERED: 1, DESTROYED: 2, LEVEL_SHIFT: 2, LEVEL_MASK: 0b11100 } as const;

// ---------- Input ----------
const YAW_SCALE = 65535 / (Math.PI * 2);
const PITCH_SCALE = 20000;

export function encodeInput(cmds: InputCmd[]): Uint8Array {
  const w = new ByteWriter(16 + cmds.length * 14);
  w.u8(BIN.INPUT).u8(cmds.length);
  for (const c of cmds) {
    w.u32(c.seq).i8(Math.round(c.fwd * 127)).i8(Math.round(c.strafe * 127));
    w.u16(Math.round((((c.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) * YAW_SCALE) & 0xffff);
    w.i16(Math.round(Math.max(-1.57, Math.min(1.57, c.pitch)) * PITCH_SCALE));
    w.u16(c.buttons).u8(c.weapon);
  }
  return w.finish();
}

export function decodeInput(data: Uint8Array): InputCmd[] {
  const r = new ByteReader(data);
  r.u8();
  const n = Math.min(r.u8(), 16);
  const out: InputCmd[] = [];
  for (let i = 0; i < n && r.remaining >= 13; i++) {
    const seq = r.u32(), fwd = r.i8() / 127, strafe = r.i8() / 127, yaw = r.u16() / YAW_SCALE, pitch = r.i16() / PITCH_SCALE, buttons = r.u16(), weapon = r.u8();
    out.push({ seq, fwd: clamp1(fwd), strafe: clamp1(strafe), yaw, pitch, buttons, weapon: weapon & 3 });
  }
  return out;
}

const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Quantise a command the same way the wire does, so client prediction matches the server exactly. */
export function quantizeInput(c: InputCmd): InputCmd {
  return decodeInput(encodeInput([c]))[0];
}

// ---------- Snapshot ----------
export interface PlayerSnap {
  id: number; team: number; flags: number; cls: number; item: number; pos: Vec3; vel: Vec3; yaw: number; pitch: number;
  health: number; maxHealth: number; energy: number; vehicle: number; seat: number;
}
export interface SelfSnap {
  ackSeq: number; energy: number; prevButtons: number; gnX: number; gnY: number; gnZ: number;
  ammo: [number, number][]; credits: number; reload: number; charge: number; spin: number; respawn: number; slot: number;
}
export interface ProjSnap { id: number; item: number; owner: number; pos: Vec3; vel: Vec3 }
export interface AssetSnap { id: number; type: number; team: number; health: number; flags: number; pos: Vec3; yaw: number; owner: number }
export interface FlagSnap { id: number; team: number; state: number; carrier: number; pos: Vec3 }
export interface VehSnap { id: number; type: number; team: number; driver: number; gunner: number; pos: Vec3; vel: Vec3; yaw: number; pitch: number; roll: number; health: number; energy: number }
export interface Snapshot {
  tick: number; phase: number; timeLeft: number; scores: [number, number];
  self: SelfSnap | null; players: PlayerSnap[]; projectiles: ProjSnap[]; assets: AssetSnap[]; flags: FlagSnap[]; vehicles: VehSnap[];
}

const V = 20; // velocity quantisation (1/20 m/s)
const wv = (w: ByteWriter, p: Vec3) => w.f32(p.x).f32(p.y).f32(p.z);
const rv = (r: ByteReader): Vec3 => ({ x: r.f32(), y: r.f32(), z: r.f32() });
const wq = (w: ByteWriter, v: Vec3) => w.i16(clampI16(v.x * V)).i16(clampI16(v.y * V)).i16(clampI16(v.z * V));
const rq = (r: ByteReader): Vec3 => ({ x: r.i16() / V, y: r.i16() / V, z: r.i16() / V });
const clampI16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));
const wAng = (w: ByteWriter, a: number) => w.u16(Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) * YAW_SCALE) & 0xffff);
const rAng = (r: ByteReader) => r.u16() / YAW_SCALE;

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new ByteWriter(4096);
  w.u8(BIN.SNAPSHOT).u32(s.tick).u8(s.phase).u16(Math.max(0, Math.min(65535, Math.round(s.timeLeft)))).i16(s.scores[0]).i16(s.scores[1]);
  w.u8(s.self ? 1 : 0);
  if (s.self) {
    const m = s.self;
    w.u32(m.ackSeq).f32(m.energy).u16(m.prevButtons).f32(m.gnX).f32(m.gnY).f32(m.gnZ);
    w.u8(m.ammo.length);
    for (const [c, a] of m.ammo) w.u16(c).u16(a);
    w.u32(m.credits).u8(Math.round(m.reload * 255)).u8(Math.round(m.charge * 255)).u8(Math.round(m.spin * 255)).u8(Math.min(255, Math.ceil(m.respawn * 10))).u8(m.slot);
  }
  w.u8(s.players.length);
  for (const p of s.players) {
    w.u8(p.id).u8(p.team).u16(p.flags).u8(p.cls).u8(p.item);
    wv(w, p.pos); wq(w, p.vel); wAng(w, p.yaw); w.i16(Math.round(p.pitch * PITCH_SCALE));
    w.u16(Math.max(0, Math.round(p.health))).u16(Math.round(p.maxHealth)).u8(Math.max(0, Math.min(255, Math.round(p.energy)))).u8(p.vehicle).u8(p.seat);
  }
  w.u16(s.projectiles.length);
  for (const p of s.projectiles) { w.u16(p.id & 0xffff).u8(p.item).u8(p.owner); wv(w, p.pos); wq(w, p.vel); }
  w.u16(s.assets.length);
  for (const a of s.assets) {
    w.u16(a.id).u8(a.type).u8(a.team).u8(Math.round(Math.max(0, Math.min(1, a.health)) * 255)).u8(a.flags);
    wv(w, a.pos); wAng(w, a.yaw); w.u8(a.owner);
  }
  w.u8(s.flags.length);
  for (const f of s.flags) { w.u8(f.id).u8(f.team).u8(f.state).u8(f.carrier); wv(w, f.pos); }
  w.u8(s.vehicles.length);
  for (const v of s.vehicles) {
    w.u8(v.id).u8(v.type).u8(v.team).u8(v.driver).u8(v.gunner); wv(w, v.pos); wq(w, v.vel);
    wAng(w, v.yaw); w.i16(Math.round(v.pitch * PITCH_SCALE)).i16(Math.round(v.roll * PITCH_SCALE));
    w.u8(Math.round(Math.max(0, Math.min(1, v.health)) * 255)).u8(Math.round(Math.max(0, Math.min(1, v.energy)) * 255));
  }
  return w.finish();
}

export function decodeSnapshot(data: Uint8Array): Snapshot {
  const r = new ByteReader(data);
  r.u8();
  const tick = r.u32(), phase = r.u8(), timeLeft = r.u16(), scores: [number, number] = [r.i16(), r.i16()];
  let self: SelfSnap | null = null;
  if (r.u8()) {
    const ackSeq = r.u32(), energy = r.f32(), prevButtons = r.u16(), gnX = r.f32(), gnY = r.f32(), gnZ = r.f32();
    const n = r.u8();
    const ammo: [number, number][] = [];
    for (let i = 0; i < n; i++) ammo.push([r.u16(), r.u16()]);
    self = { ackSeq, energy, prevButtons, gnX, gnY, gnZ, ammo, credits: r.u32(), reload: r.u8() / 255, charge: r.u8() / 255, spin: r.u8() / 255, respawn: r.u8() / 10, slot: r.u8() };
  }
  const players: PlayerSnap[] = [];
  for (let i = 0, n = r.u8(); i < n; i++) {
    const id = r.u8(), team = r.u8(), flags = r.u16(), cls = r.u8(), item = r.u8();
    const pos = rv(r), vel = rq(r), yaw = rAng(r), pitch = r.i16() / PITCH_SCALE;
    players.push({ id, team, flags, cls, item, pos, vel, yaw, pitch, health: r.u16(), maxHealth: r.u16(), energy: r.u8(), vehicle: r.u8(), seat: r.u8() });
  }
  const projectiles: ProjSnap[] = [];
  for (let i = 0, n = r.u16(); i < n; i++) projectiles.push({ id: r.u16(), item: r.u8(), owner: r.u8(), pos: rv(r), vel: rq(r) });
  const assets: AssetSnap[] = [];
  for (let i = 0, n = r.u16(); i < n; i++) {
    const id = r.u16(), type = r.u8(), team = r.u8(), health = r.u8() / 255, flags = r.u8();
    assets.push({ id, type, team, health, flags, pos: rv(r), yaw: rAng(r), owner: r.u8() });
  }
  const flags: FlagSnap[] = [];
  for (let i = 0, n = r.u8(); i < n; i++) flags.push({ id: r.u8(), team: r.u8(), state: r.u8(), carrier: r.u8(), pos: rv(r) });
  const vehicles: VehSnap[] = [];
  for (let i = 0, n = r.u8(); i < n; i++) {
    const id = r.u8(), type = r.u8(), team = r.u8(), driver = r.u8(), gunner = r.u8(), pos = rv(r), vel = rq(r);
    vehicles.push({ id, type, team, driver, gunner, pos, vel, yaw: rAng(r), pitch: r.i16() / PITCH_SCALE, roll: r.i16() / PITCH_SCALE, health: r.u8() / 255, energy: r.u8() / 255 });
  }
  return { tick, phase, timeLeft, scores, self, players, projectiles, assets, flags, vehicles };
}

// ---------- Datagram fragmentation (WebTransport datagrams are ~1.2 KB max) ----------
export const MAX_DATAGRAM = 1100;

export function fragment(msg: Uint8Array, id: number): Uint8Array[] {
  if (msg.byteLength <= MAX_DATAGRAM) return [msg];
  const chunk = MAX_DATAGRAM - 5;
  const count = Math.ceil(msg.byteLength / chunk);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = msg.subarray(i * chunk, (i + 1) * chunk);
    const f = new Uint8Array(part.byteLength + 5);
    f[0] = BIN.FRAG; f[1] = id & 255; f[2] = (id >> 8) & 255; f[3] = i; f[4] = count;
    f.set(part, 5);
    out.push(f);
  }
  return out;
}

export class Reassembler {
  private parts = new Map<number, { count: number; got: number; chunks: (Uint8Array | undefined)[] }>();

  push(f: Uint8Array): Uint8Array | null {
    if (f[0] !== BIN.FRAG) return f;
    const id = f[1] | (f[2] << 8), idx = f[3], count = f[4];
    if (count === 0 || idx >= count) return null;
    let e = this.parts.get(id);
    if (!e) {
      e = { count, got: 0, chunks: new Array(count) };
      this.parts.set(id, e);
      if (this.parts.size > 8) this.parts.delete(this.parts.keys().next().value!);
    }
    if (!e.chunks[idx]) { e.chunks[idx] = f.slice(5); e.got++; }
    if (e.got < e.count) return null;
    this.parts.delete(id);
    const total = e.chunks.reduce((s, c) => s + c!.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of e.chunks) { out.set(c!, off); off += c!.byteLength; }
    return out;
  }
}

// ---------- JSON control messages ----------
export type TransportKind = 'webtransport' | 'websocket';

export interface ServerInfo {
  id: string; name: string; mode: ModeId; map: string; mapName: string; mapSource: 'reborn' | 'original';
  humans: number; bots: number; maxPlayers: number; transports: TransportKind[];
  wsUrl?: string; wtUrl?: string; certHash?: string; region?: string; version: number; passworded?: boolean;
  /** Host node base URL serving /assets (textures, voices) and /map files. */
  assetsUrl?: string;
  options?: GameOptions;
}

/** Match rules chosen by whoever launches the game. */
export interface GameOptions {
  botsPerTeam?: number;
  botDifficulty?: 'recruit' | 'adept' | 'veteran' | 'elite' | 'godlike';
  infiniteAmmo?: boolean;
  infiniteEnergy?: boolean;
  noFallDamage?: boolean;
  /** Call-ins cost nothing and never recharge (2 s anti-spam per player). */
  infiniteCallIns?: boolean;
  /** Vehicle stations on the map (default on). */
  vehicles?: boolean;
  /** Scales every credit reward (1 = TA default). */
  creditMultiplier?: number;
  /** World gravity multiplier for players, projectiles, flags and vehicles (1 = TA default). */
  gravity?: number;
  timeLimit?: number;   // minutes, 0 = none
  scoreLimit?: number;  // 0 = none
}

export interface PlayerInfo {
  id: number; name: string; team: number; cls: string; score: number; kills: number; deaths: number; assists: number;
  caps: number; returns: number; bot: boolean; ping: number; cosmetics: CosmeticProfile; transport: TransportKind | 'bot';
}

export type C2S =
  | { t: 'hello'; v: number; name: string; cosmetics: Partial<CosmeticProfile>; spectate?: boolean; mapHash?: string; transport: TransportKind }
  | { t: 'team'; team: number; spawn?: boolean }
  | { t: 'class'; cls: string; loadout: Partial<Loadout>; spawn?: boolean }
  | { t: 'cosmetics'; cosmetics: Partial<CosmeticProfile> }
  | { t: 'chat'; text: string; team: boolean }
  | { t: 'vgs'; id: string }
  | { t: 'vote'; yes: boolean }
  | { t: 'callvote'; kind: 'map' | 'kick'; arg: string }
  | { t: 'buyvehicle'; vehicle: string }
  | { t: 'callin'; kind: string; target: Vec3 }
  | { t: 'upgrade'; asset: number }
  | { t: 'suicide' }
  | { t: 'spot' }
  | { t: 'seat'; seat: number }
  | { t: 'spec'; follow: number }
  | { t: 'ping'; c: number; rtt?: number }
  | { t: 'admin'; password: string; cmd: string; arg?: string }
  | { t: 'mapready' };

export type FxKind = 'explode' | 'tracer' | 'fire' | 'melee' | 'lance' | 'repair' | 'deploy' | 'impact' | 'strike_warn' | 'strike' | 'jump' | 'station' | 'fractal';

export interface MapRef { source: 'reborn' | 'original'; id: string; hash?: string; bytes?: number; file?: string }

export type S2C =
  | { t: 'welcome'; id: number; server: ServerInfo; tickRate: number; map: MapRef }
  | { t: 'players'; list: PlayerInfo[] }
  | { t: 'chat'; from: number; name: string; text: string; team: boolean; bot: boolean }
  | { t: 'vgs'; from: number; name: string; id: string; team: boolean; voice: string; bot: boolean }
  | { t: 'kill'; killer: number; victim: number; item: string; assist?: number; headshot?: boolean }
  | { t: 'medal'; id: string; player: number }
  | { t: 'event'; kind: string; team?: number; player?: number; text: string }
  | { t: 'fx'; kind: FxKind; pos: Vec3; to?: Vec3; item?: string; radius?: number; player?: number }
  | { t: 'hit'; target: number; dmg: number; kind: 'player' | 'asset' | 'vehicle'; blueplate?: boolean }
  | { t: 'damaged'; from: Vec3; amount: number }
  | { t: 'match'; phase: number; timeLeft: number; scores: [number, number]; winner?: number; round?: number; mode: ModeId; map: string; mapName: string }
  | { t: 'spawned'; cls: string; loadout: Loadout; yaw?: number }
  | { t: 'pong'; c: number; s: number }
  | { t: 'toast'; text: string }
  | { t: 'vote'; kind: string; arg: string; yes: number; no: number; endsIn: number }
  | { t: 'mapvote'; options: { id: string; name: string }[]; endsIn: number }
  | { t: 'error'; msg: string }
  | { t: 'changemap'; map: MapRef };

export const PHASE = { WARMUP: 0, PLAYING: 1, ROUND_END: 2, POSTGAME: 3 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder();
export const encodeJson = (m: C2S | S2C): Uint8Array => enc.encode(JSON.stringify(m));
export const isJsonFrame = (b: Uint8Array) => b.byteLength > 0 && b[0] === 0x7b;
export function decodeJson<T>(b: Uint8Array): T | null {
  try { return JSON.parse(dec.decode(b)) as T; } catch { return null; }
}
