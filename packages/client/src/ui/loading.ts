import { MODES, randomTip, type MapData, type ServerInfo } from '@ar/shared';
import { h } from './dom.js';
import { getShot, shotKey } from './mapshots.js';
import { rulesText } from './menus.js';

/**
 * Tribes: Ascend loading screen: logo top centre, NEXT MAP / GAME TYPE in the corners, a full-width map screenshot band
 * in a bevelled green frame with the RULES OF ENGAGEMENT over its left side, then the server name and a gameplay tip.
 */
export class LoadingScreen {
  readonly el: HTMLElement;
  private bar = h('i');
  private label = h('div', { class: 'ld-stage' });
  private band = h('div', { class: 'ld-band' });
  private hasShot = false;

  constructor(parent: HTMLElement, server: ServerInfo, onCancel: () => void) {
    const mode = MODES[server.mode];
    const custom = server.options ? rulesText(server.options) : '';
    this.band.append(h('div', { class: 'ld-shot ld-shot-empty' }),
      h('div', { class: 'ld-roe' }, h('div', { class: 'ld-k' }, 'RULES OF ENGAGEMENT'),
        h('ul', null, (mode?.rules ?? []).map((r) => h('li', null, r))),
        custom ? h('div', { class: 'ld-custom' }, custom) : null));
    this.el = h('div', { class: 'ld-root' },
      h('div', { class: 'ld-frame' },
        h('div', { class: 'ld-top' },
          h('div', { class: 'ld-corner' }, h('div', { class: 'ld-k' }, 'NEXT MAP'), h('div', { class: 'ld-v' }, (server.mapName || 'UNKNOWN').toUpperCase())),
          h('div', { class: 'ld-title' }, h('div', { class: 'w1' }, 'ASCEND'), h('div', { class: 'w2' }, 'REBORN')),
          h('div', { class: 'ld-corner right' }, h('div', { class: 'ld-k' }, 'GAME TYPE'), h('div', { class: 'ld-v' }, (mode?.name ?? server.mode).toUpperCase()))),
        this.band,
        h('div', { class: 'ld-bottom' },
          h('div', { class: 'ld-server' }, server.name.toUpperCase()),
          h('div', { class: 'ld-tip' }, h('div', { class: 'ld-k' }, 'GAMEPLAY TIP'), h('p', null, randomTip(server.mode))),
          h('div', { class: 'ld-progress' }, h('div', { class: 'bar' }, this.bar), this.label,
            h('button', { class: 'ta-mini', onclick: onCancel }, 'CANCEL')))));
    parent.append(this.el);
    void getShot(shotKey(server.map, server.mapSource)).then((b) => { if (b) this.showShot(URL.createObjectURL(b)); });
  }

  private showShot(url: string) {
    this.hasShot = true;
    const img = h('img', { class: 'ld-shot', alt: '', src: url, onload: () => URL.revokeObjectURL(url) });
    this.band.querySelector('.ld-shot')?.replaceWith(img);
  }

  progress(f: number, label: string) {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    this.label.textContent = label.toUpperCase();
  }

  /** Without a captured screenshot yet: a hill-shaded overview of the playable area with the bases marked. */
  setMap(map: MapData) {
    if (this.hasShot) return;
    const t = map.terrain;
    const pts = map.entities.filter((e) => ['flag_stand', 'generator', 'spawn', 'cap_point', 'base_turret', 'inventory'].includes(e.kind));
    let cx = t.originX + t.width / 2, cz = t.originZ + t.depth / 2, half = Math.min(t.width, t.depth) / 2;
    if (pts.length >= 2) {
      const xs = pts.map((e) => e.pos.x), zs = pts.map((e) => e.pos.z);
      cx = (Math.min(...xs) + Math.max(...xs)) / 2; cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      half = Math.max(150, (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2) * 1.3);
    }
    // Wide band (3:1) centred on the action.
    const W = 960, H = 320;
    const x0 = cx - half, z0 = cz - half / 3, sx = (half * 2) / W, sz = ((half * 2) / 3) / H;
    const cv = h('canvas', { width: W, height: H, class: 'ld-shot' });
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(W, H);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) { const v = t.heightAt(x0 + x * sx, z0 + y * sz); if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(1, hi - lo);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wx = x0 + x * sx, wz = z0 + y * sz;
        const hgt = t.heightAt(wx, wz);
        const dx = t.heightAt(wx + sx, wz) - hgt, dz = t.heightAt(wx, wz + sz) - hgt;
        const shade = Math.max(0, Math.min(1, 0.55 + (-dx * 0.7 - dz * 0.7) / Math.max(sx, 1) * 0.35));
        const e = (hgt - lo) / span;
        const i = (y * W + x) * 4;
        img.data[i] = 40 + 90 * shade * (0.6 + e * 0.4);
        img.data[i + 1] = 70 + 150 * shade * (0.6 + e * 0.4);
        img.data[i + 2] = 50 + 80 * shade * (0.6 + e * 0.4);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    for (const e of map.entities) {
      if (e.kind !== 'flag_stand' && e.kind !== 'generator' && e.kind !== 'cap_point') continue;
      const px = (e.pos.x - x0) / sx, py = (e.pos.z - z0) / sz;
      ctx.fillStyle = e.kind === 'cap_point' ? '#f2d16b' : e.team === 0 ? '#ff5a3c' : '#4fb4ff';
      ctx.beginPath();
      ctx.arc(px, py, e.kind === 'flag_stand' ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
    }
    this.band.querySelector('.ld-shot')?.replaceWith(cv);
  }

  remove() { this.el.remove(); }

  /** Milliseconds since the screen appeared. */
  age() { return performance.now() - this.born; }
  private born = performance.now();
}
