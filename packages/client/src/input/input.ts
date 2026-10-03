import type { Action } from '@ar/shared';
import { settings } from '../settings.js';

const RAD_PER_COUNT = 0.0022;

export class Input {
  yaw = 0;
  pitch = 0;
  gameActive = false;
  /** When set, raw key presses go to this handler (chat, VGS, bind capture) instead of game actions. */
  capture: ((code: string, e: KeyboardEvent | null) => boolean) | null = null;
  /** When it returns true, the click that grabs the pointer also counts as a press (click-to-respawn). */
  clickThrough: (() => boolean) | null = null;
  private down = new Set<string>();
  private edges = new Set<string>();
  private listeners = new Set<(code: string) => void>();
  private locked = false;
  /** Set while we release the pointer ourselves, so a lost lock can be told apart from the player pressing Esc. */
  private releasing = false;
  private gpPrev: boolean[] = [];

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => this.onDown(e.code, e));
    window.addEventListener('keyup', (e) => this.onUp(e.code));
    el.addEventListener('mousedown', (e) => {
      if (this.gameActive && !this.locked) { this.lock(); if (!this.clickThrough?.()) return; }
      this.onDown(`Mouse${e.button}`, null);
    });
    window.addEventListener('mouseup', (e) => this.onUp(`Mouse${e.button}`));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      const code = e.deltaY < 0 ? 'WheelUp' : 'WheelDown';
      this.edges.add(code);
      for (const l of this.listeners) l(code);
    }, { passive: true });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.gameActive) return;
      const s = RAD_PER_COUNT * settings.sensitivity * this.zoomScale;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s * (settings.invertY ? -1 : 1);
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.down.clear();
      const byUser = !this.locked && !this.releasing;
      if (!this.locked) this.releasing = false;
      for (const l of this.lockListeners) l(this.locked, byUser);
    });
    window.addEventListener('blur', () => this.down.clear());
  }

  zoomScale = 1;
  private lockListeners = new Set<(locked: boolean, byUser: boolean) => void>();
  /** `byUser`: the browser released the pointer (Esc, focus loss) rather than unlock(). Returns an unsubscribe. */
  onLockChange(fn: (locked: boolean, byUser: boolean) => void) { this.lockListeners.add(fn); return () => { this.lockListeners.delete(fn); }; }
  get isLocked() { return this.locked; }

  lock() {
    const el = this.el as HTMLElement & { requestPointerLock(o?: object): Promise<void> | void };
    try {
      const r = el.requestPointerLock(settings.rawInput ? { unadjustedMovement: true } : undefined);
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => el.requestPointerLock());
    } catch { el.requestPointerLock(); }
  }

  unlock() { if (document.pointerLockElement) { this.releasing = true; document.exitPointerLock(); } }

  onPress(fn: (code: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private onDown(code: string, e: KeyboardEvent | null) {
    if (this.capture && this.capture(code, e)) { e?.preventDefault(); return; }
    const t = e?.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (this.gameActive && e && (code === 'Tab' || code.startsWith('F') && code.length <= 3 || code === 'AltLeft' || code === 'Slash' || code === 'Quote')) e.preventDefault();
    if (!this.down.has(code)) this.edges.add(code);
    this.down.add(code);
    for (const l of this.listeners) l(code);
  }

  private onUp(code: string) { this.down.delete(code); }

  held(a: Action): boolean {
    for (const k of settings.binds[a] ?? []) if (this.down.has(k)) return true;
    return this.gamepadHeld(a);
  }

  pressed(a: Action): boolean {
    for (const k of settings.binds[a] ?? []) if (this.edges.has(k)) return true;
    return false;
  }

  endFrame() { this.edges.clear(); }

  // ---- gamepad (standard mapping) ----
  private gp: Gamepad | null = null;
  pollGamepad(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    this.gp = [...pads].find((p) => p && p.connected) ?? null;
    if (!this.gp || !this.gameActive) return;
    const ax = this.gp.axes;
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    this.yaw -= dz(ax[2] ?? 0) * 3.2 * dt * settings.sensitivity * this.zoomScale;
    this.pitch -= dz(ax[3] ?? 0) * 2.4 * dt * settings.sensitivity * this.zoomScale * (settings.invertY ? -1 : 1);
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    const b = this.gp.buttons.map((x) => x.pressed);
    const map: [number, string][] = [[0, 'GP_A'], [1, 'GP_B'], [2, 'GP_X'], [3, 'GP_Y'], [4, 'GP_LB'], [5, 'GP_RB'], [6, 'GP_LT'], [7, 'GP_RT'], [9, 'GP_START'], [12, 'GP_UP'], [13, 'GP_DOWN']];
    for (const [i, code] of map) if (b[i] && !this.gpPrev[i]) this.edges.add(code);
    this.gpPrev = b;
  }

  private gamepadHeld(a: Action): boolean {
    const gp = this.gp;
    if (!gp || !this.gameActive) return false;
    const ax = gp.axes, b = gp.buttons;
    switch (a) {
      case 'forward': return (ax[1] ?? 0) < -0.3;
      case 'back': return (ax[1] ?? 0) > 0.3;
      case 'left': return (ax[0] ?? 0) < -0.3;
      case 'right': return (ax[0] ?? 0) > 0.3;
      case 'fire': return !!b[7]?.pressed;
      case 'jet': return !!b[6]?.pressed;
      case 'ski': return !!b[0]?.pressed;
      case 'jump': return !!b[1]?.pressed;
      case 'belt': return !!b[5]?.pressed;
      case 'pack': return !!b[4]?.pressed;
      case 'use': return !!b[2]?.pressed;
      case 'scores': return !!b[8]?.pressed;
      default: return false;
    }
  }

  moveAxes(): { fwd: number; strafe: number } {
    let fwd = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    let strafe = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const gp = this.gp;
    if (gp && this.gameActive && fwd === 0 && strafe === 0) {
      const x = gp.axes[0] ?? 0, y = gp.axes[1] ?? 0;
      if (Math.hypot(x, y) > 0.2) { fwd = -y; strafe = x; }
    }
    return { fwd, strafe };
  }
}
