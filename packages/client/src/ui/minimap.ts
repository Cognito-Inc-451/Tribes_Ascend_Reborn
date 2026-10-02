import { AF, ASSET_TYPES, PF, type MapData, type Snapshot } from '@ar/shared';
import type { RoofGrid } from '../render/world.js';
import { settings } from '../settings.js';
import { h } from './dom.js';

const TEAM = ['#e0543f', '#3f8ae0'];
const IMG = 768;

interface Bounds { x0: number; z0: number; size: number }

/** Top-down relief of the playable area (terrain hill-shade + structures), drawn once per map. */
function renderBase(map: MapData, roof: RoofGrid | null, b: Bounds): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = IMG;
  const g = c.getContext('2d')!;
  const img = g.createImageData(IMG, IMG);
  const T = map.terrain;
  let lo = Infinity, hi = -Infinity;
  for (const v of T.heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = Math.max(1, hi - lo);
  const mpp = b.size / IMG;
  for (let v = 0; v < IMG; v++) for (let u = 0; u < IMG; u++) {
    const x = b.x0 + (u + 0.5) * mpp, z = b.z0 + (v + 0.5) * mpp;
    const o = (v * IMG + u) * 4;
    const inside = x >= T.originX && z >= T.originZ && x <= T.originX + T.width && z <= T.originZ + T.depth;
    let r = 18, gg = 22, bb = 28;
    const hole = inside && T.isHole(x, z);
    const th = inside && !hole ? T.heightAt(x, z) : -Infinity;
    if (inside && !hole) {
      const n = T.normalAt(x, z);
      const shade = Math.max(0, n.x * -0.5 + n.y * 0.7 + n.z * -0.5) * 0.9 + 0.25;
      const hf = (th - lo) / range;
      r = (70 + hf * 70) * shade; gg = (78 + hf * 70) * shade; bb = (84 + hf * 66) * shade;
    }
    if (roof) {
      const i = Math.floor((x - roof.originX) / roof.cell), j = Math.floor((z - roof.originZ) / roof.cell);
      const top = i >= 0 && j >= 0 && i < roof.nx && j < roof.nz ? roof.top[j * roof.nx + i] : -Infinity;
      // Buildings and rocks, not tall canopies/arches spanning the map.
      if (top > th + 1.5 && top < th + 35) { const k = Math.min(1, 0.55 + (top - th) / 60); r = 150 * k + 40; gg = 160 * k + 40; bb = 170 * k + 40; }
    }
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function playableBounds(map: MapData): Bounds {
  const T = map.terrain;
  const pts = map.entities.filter((e) => e.kind !== 'bookmark');
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const e of pts) { x0 = Math.min(x0, e.pos.x); x1 = Math.max(x1, e.pos.x); z0 = Math.min(z0, e.pos.z); z1 = Math.max(z1, e.pos.z); }
  if (!pts.length) { x0 = T.originX; x1 = T.originX + T.width; z0 = T.originZ; z1 = T.originZ + T.depth; }
  const pad = Math.max(150, Math.max(x1 - x0, z1 - z0) * 0.25);
  x0 = Math.max(T.originX, x0 - pad); x1 = Math.min(T.originX + T.width, x1 + pad);
  z0 = Math.max(T.originZ, z0 - pad); z1 = Math.min(T.originZ + T.depth, z1 + pad);
  const size = Math.max(x1 - x0, z1 - z0, 100);
  return { x0: (x0 + x1) / 2 - size / 2, z0: (z0 + z1) / 2 - size / 2, size };
}

export interface MapView { x: number; z: number; yaw: number; team: number; myId: number }

/** HUD minimap (rotating, player-centred) and the full overhead map (north-up), sharing one pre-rendered base. */
export class Minimap {
  readonly mini: HTMLCanvasElement;
  readonly big: HTMLElement;
  private bigCanvas: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  private bounds: Bounds;
  private lastDraw = 0;
  bigOpen = false;

  constructor(private map: MapData, roof: () => RoofGrid | null) {
    this.bounds = playableBounds(map);
    this.mini = h('canvas', { class: 'minimap' }) as HTMLCanvasElement;
    this.bigCanvas = h('canvas') as HTMLCanvasElement;
    this.big = h('div', { class: 'bigmap hidden' }, this.bigCanvas, h('div', { class: 'bigmap-title' }, map.name.toUpperCase(), h('small', null, ' · OVERHEAD MAP (B)')));
    // Build lazily so the first frame is not delayed.
    setTimeout(() => { this.base = renderBase(map, roof(), this.bounds); }, 50);
  }

  toggleBig() {
    this.bigOpen = !this.bigOpen;
    this.big.classList.toggle('hidden', !this.bigOpen);
  }

  update(snap: Snapshot | null, me: MapView, now: number) {
    this.mini.classList.toggle('hidden', !settings.minimap);
    if (now - this.lastDraw < (this.bigOpen ? 33 : 50)) return;
    this.lastDraw = now;
    if (settings.minimap) this.drawMini(snap, me);
    if (this.bigOpen) this.drawBig(snap, me);
  }

  private drawMini(snap: Snapshot | null, me: MapView) {
    const px = Math.round(200 * settings.hudScale), dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.mini;
    if (c.width !== px * dpr) { c.width = c.height = px * dpr; c.style.width = c.style.height = `${px}px`; }
    const g = c.getContext('2d')!;
    const R = c.width / 2;
    const rangeM = 230 * settings.minimapZoom;
    const s = R / rangeM;
    const cos = Math.cos(me.yaw), sin = Math.sin(me.yaw);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#12161b'; g.fillRect(0, 0, c.width, c.height);
    if (this.base) {
      const mpp = this.bounds.size / IMG;
      const dx0 = this.bounds.x0 - me.x, dz0 = this.bounds.z0 - me.z;
      g.setTransform(s * cos * mpp, s * sin * mpp, -s * sin * mpp, s * cos * mpp, R + s * (cos * dx0 - sin * dz0), R + s * (sin * dx0 + cos * dz0));
      g.globalAlpha = 0.92;
      g.drawImage(this.base, 0, 0);
      g.globalAlpha = 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const toScreen = (x: number, z: number) => {
      const dx = x - me.x, dz = z - me.z;
      return { x: R + s * (cos * dx - sin * dz), y: R + s * (sin * dx + cos * dz) };
    };
    this.drawIcons(g, snap, me, toScreen, dpr, me.yaw);
    g.restore();
    g.strokeStyle = 'rgba(159,232,255,.55)'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(232,240,248,.8)'; g.font = `${600} ${11 * dpr}px "Chakra Petch", sans-serif`; g.textAlign = 'center';
    const n = toScreen(me.x, me.z - rangeM * 0.86);
    g.fillText('N', n.x, n.y + 4 * dpr);
  }

  private drawBig(snap: Snapshot | null, me: MapView) {
    const c = this.bigCanvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.82);
    if (c.width !== px * dpr) { c.width = c.height = px * dpr; c.style.width = c.style.height = `${px}px`; }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0c0f13'; g.fillRect(0, 0, c.width, c.height);
    if (this.base) g.drawImage(this.base, 0, 0, c.width, c.height);
    const s = c.width / this.bounds.size;
    const toScreen = (x: number, z: number) => ({ x: (x - this.bounds.x0) * s, y: (z - this.bounds.z0) * s });
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const p = (c.width / 8) * i; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, c.height); g.moveTo(0, p); g.lineTo(c.width, p); g.stroke(); }
    this.drawIcons(g, snap, me, toScreen, dpr * 1.25, 0);
  }

  private drawIcons(g: CanvasRenderingContext2D, snap: Snapshot | null, me: MapView, toScreen: (x: number, z: number) => { x: number; y: number }, k: number, rot: number) {
    const glyph = (x: number, z: number, color: string, text: string, size = 9) => {
      const p = toScreen(x, z);
      g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(p.x - size * k * 0.75, p.y - size * k * 0.75, size * k * 1.5, size * k * 1.5);
      g.strokeStyle = color; g.lineWidth = 1.5 * k; g.strokeRect(p.x - size * k * 0.75, p.y - size * k * 0.75, size * k * 1.5, size * k * 1.5);
      g.fillStyle = color; g.font = `700 ${size * k}px "Chakra Petch", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, p.x, p.y + 0.5);
    };
    if (snap) {
      for (const a of snap.assets) {
        const type = ASSET_TYPES[a.type];
        const col = a.team <= 1 ? TEAM[a.team] : '#c8c8c8';
        const dead = (a.flags & AF.DESTROYED) !== 0;
        if (type === 'generator') glyph(a.pos.x, a.pos.z, dead ? '#666' : col, 'G');
        else if (type === 'base_turret') glyph(a.pos.x, a.pos.z, dead ? '#666' : col, 'T', 7);
        else if (type === 'radar') glyph(a.pos.x, a.pos.z, dead ? '#666' : col, 'R', 7);
        else if (type === 'inventory') glyph(a.pos.x, a.pos.z, col, 'I', 6);
        else if (type === 'vehicle_pad') glyph(a.pos.x, a.pos.z, col, 'V', 7);
        else if (type === 'cap_point') glyph(a.pos.x, a.pos.z, col, this.map.entities.find((e) => e.kind === 'cap_point' && Math.hypot(e.pos.x - a.pos.x, e.pos.z - a.pos.z) < 2)?.tag ?? '•', 10);
      }
      for (const p of snap.players) {
        if (!(p.flags & PF.ALIVE) || p.id === me.myId) continue;
        const ally = p.team === me.team;
        if (!ally && !(p.flags & (PF.SPOTTED | PF.HAS_FLAG))) continue;
        const q = toScreen(p.pos.x, p.pos.z);
        g.fillStyle = TEAM[p.team] ?? '#ddd';
        g.beginPath(); g.arc(q.x, q.y, 3.2 * k, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1; g.stroke();
      }
      for (const f of snap.flags) {
        const q = toScreen(f.pos.x, f.pos.z);
        const col = f.team <= 1 ? TEAM[f.team] : '#ffd23a';
        g.save(); g.translate(q.x, q.y);
        g.strokeStyle = '#000'; g.lineWidth = 1.5 * k;
        g.beginPath(); g.moveTo(0, 5 * k); g.lineTo(0, -8 * k); g.stroke();
        g.fillStyle = col; g.beginPath(); g.moveTo(0, -8 * k); g.lineTo(9 * k, -5 * k); g.lineTo(0, -2 * k); g.closePath(); g.fill();
        if (f.state === 2) { g.strokeStyle = '#fff'; g.beginPath(); g.arc(0, 0, 9 * k, 0, Math.PI * 2); g.stroke(); }
        g.restore();
      }
    }
    // Self: arrow pointing along the view direction.
    const c = toScreen(me.x, me.z);
    g.save(); g.translate(c.x, c.y); g.rotate(rot - me.yaw);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, -7 * k); g.lineTo(5 * k, 6 * k); g.lineTo(0, 3 * k); g.lineTo(-5 * k, 6 * k); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }
}
