import * as THREE from 'three';
import { ARMOR_SKINS, CLASSES, ITEMS, TA_SKINS, VOICE_PACKS } from '@ar/shared';
import { voiceManifest } from '../net/node.js';
import { PlayerModel } from '../render/actors.js';
import { models } from '../render/models.js';
import { studioEnvironment } from '../render/renderer.js';
import { saveSettings, settings } from '../settings.js';
import { h } from './dom.js';

/** Imported TA voice packs first, then the generated (speech synthesis) ones. */
export async function voiceOptions(): Promise<{ id: string; name: string }[]> {
  const m = await voiceManifest();
  return [...(m?.packs ?? []).map((p) => ({ id: p.id, name: p.name })), ...VOICE_PACKS.map((v) => ({ id: v.id, name: `${v.name} (synth)` }))];
}

/** Players who never picked a voice get an original TA one when it is imported, not the synthesised default. */
export async function ensureDefaultVoice() {
  if (!settings.voiceAuto) return;
  const packs = (await voiceManifest())?.packs ?? [];
  const pick = packs.find((p) => p.id === 'ta_soldier_male_01') ?? packs[0];
  if (pick && settings.cosmetics.voice !== pick.id) { settings.cosmetics.voice = pick.id; saveSettings(); }
}

export function chooseVoice(id: string) {
  settings.cosmetics.voice = id;
  settings.voiceAuto = false;
  saveSettings();
}

let taModels: boolean | null = null;
/** Whether TA character models are imported (their skins replace the generated ones); loads once, then calls `onReady` if it turned out true. */
export function taModelsReady(onReady?: () => void): boolean {
  if (taModels === null) void models.available().then((k) => { taModels = [...k].some((x) => x.startsWith('pc_')); if (taModels) onReady?.(); });
  return taModels ?? false;
}

export interface SkinOption { name: string; selected: boolean; apply: () => void }

/** Skin choices for a class: TA's own skins when imported, else the generated armour skins. */
export function skinOptions(clsId: string): SkinOption[] {
  const c = settings.cosmetics;
  const idx = CLASSES.findIndex((x) => x.id === clsId);
  const cls = CLASSES[idx] ?? CLASSES[0];
  if (taModels) {
    const cur = Number(c.taSkins?.[idx] ?? 0);
    return (TA_SKINS[cls.id] ?? ['Team Armor']).map((name, i) => ({
      name, selected: cur === i,
      apply: () => { const s = (c.taSkins ?? '').padEnd(CLASSES.length, '0').split(''); s[idx] = String(i); c.taSkins = s.join(''); saveSettings(); },
    }));
  }
  const key = (`skin${cls.armor[0].toUpperCase()}${cls.armor.slice(1)}`) as 'skinLight' | 'skinMedium' | 'skinHeavy';
  return ARMOR_SKINS.map((s) => ({ name: s.name, selected: c[key] === s.id, apply: () => { c[key] = s.id; saveSettings(); } }));
}

export function currentSkinName(clsId: string): string {
  return skinOptions(clsId).find((s) => s.selected)?.name ?? '';
}

export function voiceLabel(id: string): string {
  return id.toUpperCase().replace(/^TA_/, '').replace(/_/g, ' ');
}

/** Stats of an item for the loadout screens (no internal notes: those are for the code, not the player). */
export function statBlock(id: string): HTMLElement {
  const it = ITEMS[id];
  const rows: [string, string][] = [];
  if (it.projectile) {
    const p = it.projectile;
    rows.push(['Direct / splash', `${p.direct} / ${p.splashMax}\u2013${p.splashMin}`], ['Radius', `${p.radius} m`], ['Speed', `${p.speed} m/s (${Math.round(p.speed * 3.6)} km/h)`], ['Inheritance', `${Math.round(p.inherit * 100)}%`]);
  }
  if (it.hitscan) rows.push(['Damage', `${it.hitscan.damage}${it.hitscan.pellets > 1 ? ` \u00d7 ${it.hitscan.pellets}` : ''} \u2192 ${it.hitscan.minDamage}`]);
  if (it.clip) rows.push(['Clip / ammo', `${it.clip} / ${it.ammo}`]);
  if (it.refire) rows.push(['Refire', `${it.refire}s`]);
  return h('div', { class: 'panel stat-block' }, h('div', { class: 'stat-title' }, it.name.toUpperCase()),
    rows.map(([a, b]) => h('div', { class: 'stat-line' }, h('span', { class: 'muted' }, a), h('span', null, b))));
}

let lastTeam = 0;

/** Rotating 3D model of a class with the player's skin, cosmetics and held weapon (drag to turn). Frees itself once removed from the page. */
export class ClassPreview {
  readonly el = h('div', { class: 'ta-preview' });
  disposed = false;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 0.8, 0.1, 50);
  private model: PlayerModel | null = null;
  private key = '';
  private clsId: string = CLASSES[0].id;
  private weapon = '';
  private raf = 0;
  private yaw = 0;
  private t = 0;
  private down = false;
  private seen = false;
  private tabs: HTMLElement[];
  private onUp = () => { this.down = false; };

  constructor(team?: number) {
    if (team === 0 || team === 1) lastTeam = team;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;
    this.scene.environment = studioEnvironment(r);
    this.scene.environmentIntensity = 0.6;
    this.cam.position.set(0, 1.25, 4.4);
    this.cam.lookAt(0, 1, 0);
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x504438, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(2, 4, 3); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe8d0, 0.8); fill.position.set(-2.5, 1.5, 3); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9fe0ff, 1.6); rim.position.set(-3, 2, -3); this.scene.add(rim);
    this.el.append(r.domElement);
    this.tabs = ['BLOOD EAGLE', 'DIAMOND SWORD'].map((n, i) => h('button', { class: `ta-tab ${lastTeam === i ? 'active' : ''}`, onclick: () => { lastTeam = i; this.tabs.forEach((b, k) => b.classList.toggle('active', k === i)); this.build(true); } }, n));
    this.el.append(h('div', { class: 'ta-preview-teams' }, ...this.tabs));
    this.el.addEventListener('mousedown', () => (this.down = true));
    window.addEventListener('mouseup', this.onUp);
    this.el.addEventListener('mousemove', (e) => { if (this.down) this.yaw += e.movementX * 0.01; });
    this.loop();
  }

  /** Show this class holding `weapon` (a rebuild happens only when the class, team, skin or cosmetics changed). */
  show(clsId: string, weapon: string) {
    this.clsId = clsId;
    this.weapon = weapon;
    this.build(false);
  }

  /** The skin or cosmetics changed. */
  rebuild() { this.build(true); }

  private build(force: boolean) {
    const c = settings.cosmetics;
    const idx = Math.max(0, CLASSES.findIndex((x) => x.id === this.clsId));
    const key = [this.clsId, lastTeam, c.taSkins?.[idx], c.skinLight, c.skinMedium, c.skinHeavy, c.weaponFinish, c.jetTrail, c.emblem].join('|');
    if (!force && this.model && key === this.key) { this.model.setWeapon(this.weapon); return; }
    this.key = key;
    if (this.model) { this.scene.remove(this.model.root); this.model.dispose(); }
    this.model = new PlayerModel(idx, lastTeam, c);
    this.model.setWeapon(this.weapon);
    this.scene.add(this.model.root);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.el.isConnected) { if (this.seen) this.dispose(); return; }
    this.seen = true;
    const w = this.el.clientWidth, hh = this.el.clientHeight;
    if (!w || !hh) return;
    const r = this.renderer;
    if (r.domElement.width !== w || r.domElement.height !== hh) {
      r.setSize(w, hh, false);
      r.domElement.style.width = '100%'; r.domElement.style.height = '100%';
      this.cam.aspect = w / hh; this.cam.updateProjectionMatrix();
    }
    this.t += 0.016;
    this.model?.update(0.016, Math.PI + this.yaw + Math.sin(this.t * 0.4) * 0.3, 0, 0x8 | 0x2 * (Math.sin(this.t) > 0.6 ? 1 : 0), 0, null);
    r.render(this.scene, this.cam);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('mouseup', this.onUp);
    this.model?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
