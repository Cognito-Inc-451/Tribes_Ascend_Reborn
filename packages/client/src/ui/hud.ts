import { CLASSES, ITEMS, MEDALS, MODES, NAMEPLATES, TEAM_NAMES, BOT_TAG, type ModeId, type PlayerInfo } from '@ar/shared';
import { NODE_URL } from '../net/node.js';
import { settings } from '../settings.js';
import { clear, h } from './dom.js';

export interface HudState {
  alive: boolean; health: number; maxHealth: number; energy: number; maxEnergy: number; speedKmh: number; cls: string;
  weapons: { name: string; clip: number; ammo: number }[]; slot: number; belt: { name: string; count: number }; pack: { name: string; active: boolean };
  credits: number; reload: number; charge: number; spin: number; respawn: number; scores: [number, number]; timeLeft: number; phase: number;
  mode: ModeId; flagInfo: string[]; yaw: number; zoomed: boolean; weaponKind: string; spectating: string | null; transport: string;
  myScore?: number;
  /** Team-relative top bar: my team (0/1, else 1), flag state per team (0 home, 1 carried, 2 dropped), generator up per team. */
  myTeam: number; teamFlags: (number | null)[]; gens: (boolean | null)[]; armor: string; waiting: boolean;
  /** A respawn click is queued for when the timer runs out. */
  spawnQueued?: boolean;
}

export interface Marker { x: number; y: number; color: string; label: string; dist: number; kind: 'flag' | 'asset' | 'ally' | 'enemy' | 'point' | 'strike' | 'station'; hp?: number; icon?: string }
export interface Plate { x: number; y: number; name: string; team: number; bot: boolean; style: string; hp?: number }

const teamCss = (t: number) => (t === 0 ? 'var(--be)' : t === 1 ? 'var(--ds)' : '#ddd');
export const FRIEND = '#4fd2ff', ENEMY = '#ff3d30';

// TA HUD icons are two-channel masks (red = glyph, blue = frame); recolour them per use.
const iconCache = new Map<string, string | null>();
const iconWaiting = new Map<string, Promise<void>>();
export function hudIcon(name: string, color: string): string | null {
  const key = `${name}|${color}`;
  if (iconCache.has(key)) return iconCache.get(key)!;
  if (!iconWaiting.has(key)) iconWaiting.set(key, (async () => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = `${NODE_URL}/assets/ui/${name}.png`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      const col = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
      for (let i = 0; i < d.data.length; i += 4) {
        const b = d.data[i + 2] / 255, a = d.data[i + 3] / 255;
        const glyph = Math.max(d.data[i] / 255, d.data[i + 1] / 255);
        for (let k = 0; k < 3; k++) d.data[i + k] = Math.min(255, col[k] * glyph + 255 * glyph * 0.2);
        d.data[i + 3] = Math.round(255 * a * Math.min(1, Math.max(glyph, b * 0.1)));
      }
      g.putImageData(d, 0, 0);
      iconCache.set(key, c.toDataURL());
    } catch { iconCache.set(key, null); }
  })());
  return null;
}

/* Kill-feed glyphs. The cooked UI art has no weapon icons, so draw simple silhouettes on a
   canvas and cache them as data URLs (same caching shape as hudIcon, but synchronous). */
type GlyphKind =
  | 'disc' | 'chain' | 'shotgun' | 'rifle' | 'smg' | 'pistol' | 'launcher' | 'melee' | 'knife'
  | 'grenade' | 'mine' | 'repair' | 'deploy' | 'pack' | 'vehicle' | 'fall' | 'hazard'
  | 'strike' | 'suicide' | 'force' | 'turret' | 'headshot' | 'other';

const GLYPH_KINDS: Record<string, GlyphKind> = {
  spinfusor: 'disc', spinfusor_mkd: 'disc', spinfusor_mkx: 'disc', spinfusor_disc: 'disc',
  twinfusor: 'disc', heavy_twinfusor: 'disc', light_twinfusor: 'disc', blinksfusor: 'disc',
  devastator_spinfusor: 'disc', dueling_spinfusor: 'disc', heavy_spinfusor: 'disc',
  light_spinfusor: 'disc', stealth_spinfusor: 'disc', spare_spinfusor: 'disc',
  chain_gun: 'chain', chain_cannon: 'chain',
  shotgun: 'shotgun', accurized_shotgun: 'shotgun', auto_shotgun: 'shotgun',
  holdout_shotgun: 'shotgun', sawed_off: 'shotgun', dust_devil: 'shotgun',
  assault_rifle: 'rifle', light_assault_rifle: 'rifle', gasts_rifle: 'rifle', bxt1: 'rifle',
  bxt1a: 'rifle', phase_rifle: 'rifle', sap20: 'rifle', jackal: 'rifle', sparrow: 'rifle',
  falcon: 'rifle', tc24: 'rifle',
  nj4_smg: 'smg', nj5b_smg: 'smg', desert_nj4: 'smg', rhino_smg: 'smg',
  arctic_rhino_smg: 'smg', tcn4_smg: 'smg', sn7: 'smg', arctic_sn7: 'smg', tcng: 'smg',
  tcng_quickfuse: 'smg', x1_lmg: 'smg', tcn4_rockwind: 'smg',
  eagle_pistol: 'pistol', nova_colt: 'pistol', nova_blaster: 'pistol',
  nova_blaster_mx: 'pistol', arx_buster: 'pistol', gladiator: 'pistol',
  saber_launcher: 'launcher', titan_launcher: 'launcher', bolt_launcher: 'launcher',
  heavy_bolt_launcher: 'launcher', mirv_launcher: 'launcher', grenade_launcher: 'launcher',
  fusion_mortar: 'launcher', fusion_mortar_deluxe: 'launcher', plasma_cannon: 'launcher',
  plasma_gun: 'launcher',
  shocklance: 'melee', the_hammer: 'melee', melee: 'melee', throwing_knives: 'knife',
  ap_grenade: 'grenade', cluster_grenade: 'grenade', compact_nitron: 'grenade',
  defective_frag: 'grenade', emp_grenade: 'grenade', emp_xl: 'grenade',
  explosive_nitron: 'grenade', extended_fractal: 'grenade', fractal_grenade: 'grenade',
  frag_grenade: 'grenade', frag_xl: 'grenade', heavy_ap: 'grenade', heavy_ap_xl: 'grenade',
  impact_nitron: 'grenade', light_sticky: 'grenade', proximity_grenade: 'grenade',
  short_fuse_frag: 'grenade', smoke_grenade: 'grenade', sticky_grenade: 'grenade',
  sticky_xl: 'grenade', t5_grenade: 'grenade', whiteout_grenade: 'grenade',
  claymore: 'mine', focused_claymore: 'mine', mines: 'mine', motion_mine: 'mine',
  prism_mines: 'mine', thumper: 'mine', thumper_d: 'mine', thumper_dx: 'mine',
  drop_jammer: 'deploy', jammer_pack: 'deploy', motion_sensor: 'deploy', supply_drop: 'deploy',
  heavy_turret_pack: 'turret', light_turret_pack: 'turret', exr_turret_pack: 'turret',
  turret_base: 'turret', light_turret: 'turret',
  repair_tool: 'repair', repair_kit: 'repair', lr_repair_tool: 'repair',
  energy_pack: 'pack', energy_recharge_pack: 'pack', force_field_pack: 'pack',
  heavy_shield_pack: 'pack', regen_pack: 'pack', shield_pack: 'pack', stealth_pack: 'pack',
  survival_pack: 'pack', thrust_pack: 'pack', utility_pack: 'pack',
  fall: 'fall', hazard: 'hazard', suicide: 'suicide', killz: 'strike',
  tactical_strike: 'strike', orbital_strike: 'strike', force_field: 'force',
  vehicle_crash: 'vehicle', rollover: 'vehicle',
};

const glyphKindFor = (item: string): GlyphKind =>
  GLYPH_KINDS[item]
  ?? (item.startsWith('veh_') ? (item.endsWith('_gun') ? 'turret' : 'vehicle') : undefined)
  ?? (item.startsWith('vehicle_') ? 'vehicle' : undefined)
  ?? (item.endsWith('_pack') ? 'pack' : undefined)
  ?? 'other';

/** Feed name colours (styles.css .feed .t0/.t1/.tn) so glyphs match the names beside them. */
const feedTint = (team: number) => (team === 0 ? '#ff8a78' : team === 1 ? '#7cb8ff' : '#dddddd');

/* Accolade icons are stored as glyph names (or an item id); resolve either to a drawable glyph. */
const GLYPH_KIND_SET = new Set<string>([
  'disc', 'chain', 'shotgun', 'rifle', 'smg', 'pistol', 'launcher', 'melee', 'knife',
  'grenade', 'mine', 'repair', 'deploy', 'pack', 'vehicle', 'fall', 'hazard',
  'strike', 'suicide', 'force', 'turret', 'headshot', 'other',
]);
const medalGlyph = (icon: string): GlyphKind => (GLYPH_KIND_SET.has(icon) ? icon as GlyphKind : glyphKindFor(icon));

const glyphCache = new Map<string, string>();
function glyphSrc(kind: GlyphKind, color: string): string {
  const key = `${kind}|${color}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 24; c.height = 24;
  const x = c.getContext('2d')!;
  x.translate(12, 12);
  x.lineJoin = 'round'; x.lineCap = 'round';
  const p = new Path2D();
  switch (kind) {
    case 'disc':
      p.arc(-2, 1, 5, 0, Math.PI * 2);
      p.moveTo(4, -3); p.lineTo(10, -5);
      p.moveTo(5, 4); p.lineTo(11, 3);
      break;
    case 'chain':
      p.moveTo(-10, 0); p.lineTo(10, 0);
      p.arc(-4, 0, 1.8, 0, Math.PI * 2);
      p.arc(0, 0, 1.8, 0, Math.PI * 2);
      p.arc(4, 0, 1.8, 0, Math.PI * 2);
      break;
    case 'shotgun':
      p.moveTo(-9, -2); p.lineTo(7, -2);
      p.moveTo(-9, 2); p.lineTo(7, 2);
      p.moveTo(7, 2); p.lineTo(11, 5);
      break;
    case 'rifle':
      p.moveTo(-10, -1); p.lineTo(9, -1);
      p.moveTo(-2, -1); p.lineTo(-3, 6);
      p.moveTo(3, -1); p.lineTo(5, 6);
      p.moveTo(9, -1); p.lineTo(11, -4);
      break;
    case 'smg':
      p.moveTo(-8, -2); p.lineTo(7, -2);
      p.moveTo(-1, -2); p.lineTo(1, 6);
      p.moveTo(7, -2); p.lineTo(10, -2);
      break;
    case 'pistol':
      p.moveTo(-7, -3); p.lineTo(5, -3); p.lineTo(5, 0);
      p.lineTo(1, 7); p.lineTo(-2, 7); p.lineTo(0, 0);
      break;
    case 'launcher':
      p.moveTo(-9, -4); p.lineTo(5, -4); p.lineTo(5, 4); p.lineTo(-9, 4);
      p.moveTo(5, 0); p.lineTo(11, -4);
      p.moveTo(5, 0); p.lineTo(11, 4);
      p.moveTo(-3, 4); p.lineTo(-1, 9);
      break;
    case 'melee':
      p.moveTo(-8, 9); p.lineTo(9, -9);
      p.moveTo(-1, 2); p.lineTo(-6, -2);
      p.moveTo(-6, 7); p.lineTo(-2, 11);
      break;
    case 'knife':
      p.moveTo(-9, 5); p.lineTo(-3, -4);
      p.moveTo(3, 9); p.lineTo(9, -2);
      break;
    case 'grenade':
      p.arc(0, 3, 5, 0, Math.PI * 2);
      p.moveTo(-2, -3); p.lineTo(2, -3);
      p.moveTo(0, -3); p.lineTo(0, -6);
      p.moveTo(2, -6); p.lineTo(6, -9);
      break;
    case 'mine':
      p.arc(0, 3, 6, Math.PI, 0);
      p.moveTo(-9, 3); p.lineTo(9, 3);
      p.moveTo(-4, 3); p.lineTo(-4, -5);
      p.moveTo(4, 3); p.lineTo(4, -5);
      break;
    case 'repair':
      p.moveTo(-6, 0); p.lineTo(6, 0);
      p.moveTo(0, -6); p.lineTo(0, 6);
      break;
    case 'deploy':
      p.moveTo(0, -7); p.lineTo(7, 0); p.lineTo(0, 7); p.lineTo(-7, 0); p.closePath();
      p.moveTo(-9, 10); p.lineTo(9, 10);
      break;
    case 'pack':
      p.moveTo(-6, -7); p.lineTo(6, -7); p.lineTo(6, 6); p.lineTo(-6, 6); p.closePath();
      p.moveTo(-3, 6); p.lineTo(-3, 10);
      p.moveTo(3, 6); p.lineTo(3, 10);
      break;
    case 'vehicle':
      p.moveTo(-10, 5); p.lineTo(10, 5);
      p.moveTo(-10, 5); p.lineTo(-6, -2); p.lineTo(4, -2); p.lineTo(8, 5);
      p.arc(0, -2, 3, Math.PI, 0);
      break;
    case 'fall':
      p.moveTo(0, -9); p.lineTo(0, 5);
      p.moveTo(-4, 1); p.lineTo(0, 5); p.lineTo(4, 1);
      p.moveTo(-7, 9); p.lineTo(7, 9);
      break;
    case 'hazard':
      p.moveTo(0, -8);
      p.quadraticCurveTo(7, 2, 0, 8);
      p.quadraticCurveTo(-7, 2, 0, -8);
      break;
    case 'strike':
      p.moveTo(2, -10); p.lineTo(-5, 1); p.lineTo(0, 1);
      p.lineTo(-3, 10); p.lineTo(6, -2); p.lineTo(1, -2); p.closePath();
      break;
    case 'suicide':
      p.arc(0, 0, 6, 0, Math.PI * 2);
      p.moveTo(-3, -3); p.lineTo(3, 3);
      p.moveTo(-3, 3); p.lineTo(3, -3);
      break;
    case 'force':
      p.arc(0, 4, 7, Math.PI, 0);
      p.moveTo(-9, 4); p.lineTo(9, 4);
      break;
    case 'turret':
      p.moveTo(-7, 7); p.lineTo(7, 7);
      p.arc(0, 3, 5, Math.PI, 0);
      p.moveTo(0, 0); p.lineTo(9, -5);
      break;
    case 'headshot':
      p.arc(0, 0, 5, 0, Math.PI * 2);
      p.moveTo(0, -10); p.lineTo(0, -6);
      p.moveTo(0, 6); p.lineTo(0, 10);
      p.moveTo(-10, 0); p.lineTo(-6, 0);
      p.moveTo(6, 0); p.lineTo(10, 0);
      break;
    default:
      p.moveTo(-9, -1); p.lineTo(8, -1);
      p.moveTo(2, -1); p.lineTo(4, 6);
      break;
  }
  // Dark outline pass first so the glyph stays legible over any HUD background.
  x.strokeStyle = 'rgba(0,0,0,.8)'; x.lineWidth = 4.4; x.stroke(p);
  x.strokeStyle = color; x.lineWidth = 2.1; x.stroke(p);
  const url = c.toDataURL();
  glyphCache.set(key, url);
  return url;
}

export class Hud {
  readonly root: HTMLElement;
  private vitals: HTMLElement;
  private hp: HTMLElement;
  private en: HTMLElement;
  private hpText: HTMLElement;
  private enText: HTMLElement;
  private clsEl: HTMLElement;
  private speedEl: HTMLElement;
  private skibars: HTMLElement[] = [];
  private weaponsEl: HTMLElement;
  private reloadEl: HTMLElement;
  private topbar: HTMLElement;
  private flagsEl: HTMLElement;
  private compass: HTMLElement;
  private compassStrip: HTMLElement;
  private feed: HTMLElement;
  readonly chat: HTMLElement;
  /** Where the client mounts the VGS menu (left column, above the VGS history). */
  readonly vgsSlot: HTMLElement;
  private vgsLog: HTMLElement;
  private toasts: HTMLElement;
  private medalsEl: HTMLElement;
  private markers: HTMLElement;
  private crosshair: HTMLElement;
  private hitmarker: HTMLElement;
  private dmg: HTMLElement;
  private vignette: HTMLElement;
  private respawn: HTMLElement;
  private respawnMain: HTMLElement;
  private net: HTMLElement;
  private pill: HTMLElement;
  private spec: HTMLElement;
  private lastCrossKind = '';
  private beltEl: HTMLElement;
  private spawnEl: HTMLElement;
  private waitEl: HTMLElement;
  private topSig = '';

  constructor(parent: HTMLElement) {
    this.hp = h('i'); this.en = h('i'); this.hpText = h('span'); this.enText = h('span');
    this.clsEl = h('div', { class: 'tv-cls' });
    this.beltEl = h('div', { class: 'tv-belt' });
    this.vitals = h('div', { class: 'tv' },
      h('div', { class: 'tv-hex small' }), h('div', { class: 'tv-hex big' }, this.clsEl), this.beltEl,
      h('div', { class: 'tv-bars' },
        h('div', { class: 'tv-row' }, h('div', { class: 'tv-bar hp' }, this.hp), h('b', null, '+'), this.hpText),
        h('div', { class: 'tv-row' }, h('div', { class: 'tv-bar en' }, this.en), h('b', null, '\u26A1'), this.enText)));
    this.spawnEl = h('div', { class: 'ta-spawnas hidden' });
    this.waitEl = h('div', { class: 'ta-wait hidden' }, 'Waiting for players');
    const sb = h('div', { class: 'skibars' });
    for (let i = 0; i < 12; i++) { const b = h('i'); this.skibars.push(b); sb.append(b); }
    this.speedEl = h('b');
    const speed = h('div', { class: 'speed' }, this.speedEl, h('small', null, 'KM/H'), sb);
    this.weaponsEl = h('div', { class: 'weapons' });
    this.reloadEl = h('div', { class: 'reload hidden' }, h('i'));
    this.topbar = h('div', { class: 'topbar' });
    this.flagsEl = h('div', { class: 'flags' });
    this.compassStrip = h('div', { class: 'strip' });
    this.compass = h('div', { class: 'compass' }, this.compassStrip);
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let r = 0; r < 3; r++) for (let i = 0; i < 24; i++) this.compassStrip.append(h('span', { style: 'display:inline-block;width:30px;text-align:center' }, i % 3 === 0 ? dirs[i / 3] : '·'));
    this.feed = h('div', { class: 'feed' });
    this.chat = h('div', { class: 'chat' });
    this.vgsLog = h('div', { class: 'vgslog' });
    this.vgsSlot = h('div', { class: 'vgsslot' });
    this.toasts = h('div', { class: 'toasts' });
    this.medalsEl = h('div', { class: 'medals' });
    this.markers = h('div', { class: 'markers' });
    this.crosshair = h('div', { class: 'crosshair' });
    this.hitmarker = h('div', { class: 'hitmarker' });
    this.dmg = h('div', { class: 'damage-dir' });
    this.vignette = h('div', { class: 'vignette' });
    this.respawnMain = h('div');
    this.respawn = h('div', { class: 'respawn hidden' }, this.respawnMain, h('div', { class: 'respawn-hint' }, 'I = CLASS \u00b7 P = TEAM'));
    this.net = h('div', { class: 'netstats hidden' });
    this.pill = h('div', { class: 'transport-pill' });
    this.spec = h('div', { class: 'spec-hud hidden' });
    // Left column, top to bottom: net stats (F10), VGS menu, VGS history, chat; stacked so nothing overlaps.
    const left = h('div', { class: 'leftcol' }, this.net, this.vgsSlot, this.vgsLog, h('div', { style: 'flex:1' }), this.chat);
    this.root = h('div', { class: 'hud' }, this.vignette, this.markers, this.crosshair, this.hitmarker, this.dmg, this.reloadEl, this.vitals, speed,
      this.weaponsEl, this.topbar, this.flagsEl, this.compass, this.feed, left, this.toasts, this.medalsEl, this.respawn, this.pill, this.spec, this.spawnEl, this.waitEl);
    parent.append(this.root);
  }

  show(v: boolean) { this.root.classList.toggle('hidden', !v); }

  private crosshairFor(kind: string) {
    if (kind === this.lastCrossKind) return;
    this.lastCrossKind = kind;
    clear(this.crosshair);
    const c = /^#[0-9a-f]{6}$/i.test(settings.crosshairColor) ? settings.crosshairColor : '#ff3b30';
    const s = settings.crosshairScale;
    const svg = (inner: string) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('width', String(64 * s)); el.setAttribute('height', String(64 * s)); el.setAttribute('viewBox', '-32 -32 64 64');
      el.innerHTML = inner.replace(/C/g, c);
      return el;
    };
    // Static SVG markup (no user data) per weapon family.
    if (kind === 'disc') this.crosshair.append(svg('<circle r="9" fill="none" stroke="C" stroke-width="1.5"/><circle r="1.5" fill="C"/><path d="M-18 0h6M12 0h6M0 12v6" stroke="C" stroke-width="1.5"/>'));
    else if (kind === 'grenade') this.crosshair.append(svg('<path d="M-10 -4 L0 6 L10 -4" fill="none" stroke="C" stroke-width="1.5"/><circle r="1.5" fill="C"/><path d="M0 10v4M0 16v3M0 21v2" stroke="C" stroke-width="1.5"/>'));
    else if (kind === 'shotgun') this.crosshair.append(svg('<circle r="16" fill="none" stroke="C" stroke-width="1.2" stroke-dasharray="5 4"/><circle r="1.5" fill="C"/>'));
    else if (kind === 'sniper') this.crosshair.append(svg('<path d="M-30 0h24M6 0h24M0 -30v24M0 6v24" stroke="C" stroke-width="1"/><circle r="1" fill="C"/>'));
    else if (kind === 'melee') this.crosshair.append(svg('<circle r="3" fill="none" stroke="C" stroke-width="1.5"/>'));
    else this.crosshair.append(svg('<path d="M-14 0h8M6 0h8M0 -14v8M0 6v8" stroke="C" stroke-width="1.8"/><circle r="1.2" fill="C"/>'));
  }

  update(s: HudState, markers: Marker[], plates: Plate[], sessionStats: string | null) {
    document.documentElement.style.setProperty('--hud-scale', String(settings.hudScale));
    const alive = s.alive;
    this.vitals.classList.toggle('hidden', !alive);
    this.weaponsEl.classList.toggle('hidden', !alive);
    this.crosshair.classList.toggle('hidden', !alive || s.zoomed && s.weaponKind === 'sniper' ? !alive : false);
    this.hp.style.width = `${Math.max(0, (s.health / Math.max(1, s.maxHealth)) * 100)}%`;
    this.hpText.textContent = `${Math.max(0, Math.round(s.health))}`;
    this.en.style.width = `${Math.max(0, (s.energy / Math.max(1, s.maxEnergy)) * 100)}%`;
    this.enText.textContent = `${Math.round(s.energy)}`;
    const icon = hudIcon(`hud_items_custom_generic_player_${s.armor}`, '#7dffb2');
    if (icon && this.clsEl.dataset.icon !== icon) { this.clsEl.dataset.icon = icon; this.clsEl.style.backgroundImage = `url(${icon})`; this.clsEl.textContent = ''; }
    else if (!icon && !this.clsEl.dataset.icon) this.clsEl.textContent = s.armor[0]?.toUpperCase() ?? '';
    this.beltEl.textContent = `\u00d7${s.belt.count}`;
    this.spawnEl.classList.toggle('hidden', alive || !!s.spectating);
    if (!alive) this.spawnEl.textContent = `SPAWNING AS - ${s.armor.toUpperCase()} (${s.cls.toUpperCase()})`;
    this.waitEl.classList.toggle('hidden', !s.waiting);
    this.vignette.style.boxShadow = `inset 0 0 160px rgba(200,20,10,${alive ? Math.max(0, 0.55 - (s.health / Math.max(1, s.maxHealth))) : 0})`;
    this.speedEl.parentElement!.classList.toggle('hidden', !alive || !settings.showSpeed);
    this.speedEl.textContent = String(Math.round(s.speedKmh));
    const lit = Math.min(12, Math.round(s.speedKmh / 25));
    this.skibars.forEach((b, i) => { b.classList.toggle('on', i < lit); b.classList.toggle('hot', i >= 9 && i < lit); });
    this.crosshairFor(s.weaponKind);

    clear(this.weaponsEl);
    s.weapons.forEach((w, i) => this.weaponsEl.append(h('div', { class: `w ${i === s.slot ? 'active' : ''}` }, `${i + 1} · ${w.name}`)));
    const cur = s.weapons[s.slot];
    if (cur) this.weaponsEl.append(h('div', { class: 'ammo' }, String(cur.clip), h('small', null, ` / ${cur.ammo}`)));
    this.weaponsEl.append(h('div', { class: 'gear' }, h('span', null, `F · ${s.belt.name} ×${s.belt.count}`), h('span', { style: s.pack.active ? 'color:var(--good)' : '' }, `C · ${s.pack.name}`)));
    this.weaponsEl.append(h('div', { class: 'credits' }, `◆ ${s.credits} CREDITS`));

    const bar = s.reload > 0 && s.reload < 1 ? s.reload : s.spin > 0 && s.spin < 1 ? s.spin : s.charge > 0 && s.charge < 1 && s.zoomed ? s.charge : 0;
    this.reloadEl.classList.toggle('hidden', !bar);
    (this.reloadEl.firstChild as HTMLElement).style.width = `${bar * 100}%`;

    const mode = MODES[s.mode];
    const mm = Math.floor(s.timeLeft / 60), ss = Math.floor(s.timeLeft % 60);
    const phaseLabel = s.phase === 0 ? 'WARMUP' : s.phase === 2 ? 'ROUND OVER' : s.phase === 3 ? 'MATCH OVER' : mode.short;
    const timeTxt = Number.isFinite(s.timeLeft) && s.timeLeft < 36000 ? `${mm}:${String(ss).padStart(2, '0')}` : '\u221E';
    const me = s.myTeam === 0 ? 0 : 1, them = 1 - me;
    const flagIcon = (st: number | null) => (st === 1 ? 'hud_items_custom_generic_flag_carried_medium' : st === 2 ? 'hud_items_custom_generic_flag_dropped' : 'hud_items_custom_generic_flag_post');
    const genIcon = (up: boolean | null) => (up === false ? 'hud_items_custom_generic_base_generator1_down' : 'hud_items_custom_generic_base_generator1_up');
    const ico = (name: string, color: string, cls: string) => { const u = hudIcon(name, color); return h('i', { class: `ti ${cls}`, style: u ? `background-image:url(${u})` : '' }); };
    const sig = `${mode.id}|${timeTxt}|${phaseLabel}|${s.scores.join()}|${me}|${s.teamFlags.join()}|${s.gens.join()}|${s.myScore}|${iconCache.size}`;
    if (sig !== this.topSig) {
      this.topSig = sig;
      clear(this.topbar);
      const side = (t: number, color: string, cls: string, mirror: boolean) => {
        const parts = [mode.usesBases && s.gens[t] !== null ? ico(genIcon(s.gens[t]), color, cls) : null, s.teamFlags[t] !== null ? ico(flagIcon(s.teamFlags[t]), color, cls) : null, h('b', { class: `sbox ${cls}` }, String(s.scores[t]))]
          .filter((x): x is HTMLElement => x !== null);
        return mirror ? parts.reverse() : parts;
      };
      const timer = h('div', { class: 'tclock' }, h('i', { class: 'clock' }), timeTxt);
      if (mode.teams) this.topbar.append(...side(me, FRIEND, 'friend', false), h('i', { class: 'arr friend' }), timer, h('i', { class: 'arr enemy' }), ...side(them, ENEMY, 'enemy', true));
      else this.topbar.append(timer);
      this.topbar.append(h('small', { class: 'tphase' }, mode.teams ? phaseLabel : `${phaseLabel}${s.myScore !== undefined ? ` \u00b7 ${s.myScore}/${mode.scoreLimit}` : ''}`));
    }
    clear(this.flagsEl);
    for (const f of s.flagInfo) this.flagsEl.append(h('span', null, f));

    const deg = ((-s.yaw * 180) / Math.PI + 360) % 360;
    this.compassStrip.style.left = `${-(deg / 45) * 90 - 720 + 210}px`;

    clear(this.markers);
    for (const m of markers) {
      const u = m.icon ? hudIcon(m.icon, m.color) : null;
      const el = h('div', { class: `marker ${m.kind} ${u ? 'img' : ''}`, style: `left:${m.x}px;top:${m.y}px;color:${m.color}` },
        h('div', { class: 'icon', style: u ? `background-image:url(${u})` : '' }), m.label ? h('div', null, m.label) : null, h('div', { class: 'd' }, `${Math.round(m.dist)}m`),
        m.hp !== undefined ? h('div', { class: 'hpb' }, h('i', { style: `width:${Math.round(m.hp * 100)}%` })) : null);
      this.markers.append(el);
    }
    for (const p of plates) {
      const style = NAMEPLATES.find((n) => n.id === p.style)?.style ?? 'plain';
      const name = p.bot ? p.name.replace(BOT_TAG, '').trim() : p.name;
      this.markers.append(h('div', { class: `plate ${style}`, style: `left:${p.x}px;top:${p.y}px;color:${teamCss(p.team)}` }, p.bot ? h('span', { class: 'bot' }, 'BOT') : null, name));
    }

    this.respawn.classList.toggle('hidden', alive || !!s.spectating);
    if (!alive && !s.spectating) this.respawnMain.textContent = s.respawn > 0 ? `${s.spawnQueued ? 'DEPLOYING' : 'RESPAWN'} IN ${s.respawn.toFixed(1)}` : 'CLICK TO RESPAWN';
    this.spec.classList.toggle('hidden', !s.spectating);
    if (s.spectating) this.spec.textContent = `SPECTATING ${s.spectating} · LMB/RMB cycle · MMB free cam · Q/E up/down · wheel speed · G gens · F flags · B stands · V vehicles · R fastest`;
    this.net.classList.toggle('hidden', !sessionStats);
    if (sessionStats) this.net.textContent = sessionStats;
    this.pill.textContent = s.transport;
  }

  killFeed(killer: PlayerInfo | undefined, victim: PlayerInfo | undefined, item: string, assist?: PlayerInfo, headshot?: boolean, dist?: number) {
    const name = (p: PlayerInfo | undefined) => h('span', { class: p ? `t${p.team === 255 ? 'n' : p.team}` : 'tn' }, p ? (p.bot ? p.name : p.name) : 'World');
    const weapon = ITEMS[item]?.name ?? ({ melee: 'Melee', fall: 'Impact', killz: 'Out of Bounds', hazard: 'Hazard', suicide: 'Suicide', vehicle_crash: 'Roadkill', force_field: 'Force Field', turret_base: 'Base Turret', light_turret: 'Turret', tactical_strike: 'Tactical Strike', orbital_strike: 'Orbital Strike', supply_drop: 'Supply Drop', veh_heavy_turret: 'Heavy Turret', veh_beowulf_gun: 'Beowulf Gun', veh_shrike_gun: 'Shrike Gun', veh_heavy_turret_gun: 'Heavy Turret Gun', vehicle_beowulf: 'Beowulf', vehicle_gravcycle: 'Grav Cycle', vehicle_shrike: 'Shrike', vehicle_heavy_turret: 'Heavy Turret' } as Record<string, string>)[item] ?? item;
    const by = killer && killer !== victim ? killer : victim;
    const glyph = h('img', { class: 'g', alt: '', src: glyphSrc(glyphKindFor(item), feedTint(by?.team ?? 255)) });
    const hs = headshot ? h('img', { class: 'hs', alt: 'Headshot', title: 'Headshot', src: glyphSrc('headshot', '#ffd166') }) : null;
    const distText = dist !== undefined && dist >= 8 ? h('span', { class: 'd' }, `${Math.round(dist)}m`) : null;
    const row = killer && killer !== victim
      ? h('div', { class: 'k' }, name(killer), assist ? h('span', { class: 'muted' }, ` + ${assist.name}`) : null, glyph, hs, h('span', { class: 'muted' }, ` [${weapon}] `), name(victim), distText)
      : h('div', { class: 'k' }, name(victim), glyph, hs, h('span', { class: 'muted' }, ` [${weapon}]`), distText);
    this.feed.append(row);
    while (this.feed.children.length > 6) this.feed.firstChild?.remove();
    setTimeout(() => row.remove(), 6200);
  }

  chatLine(from: PlayerInfo | undefined, name: string, text: string, team: boolean, vgs: boolean, bot: boolean) {
    const t = from?.team ?? 255;
    const row = h('div', { class: `m ${team ? 'team' : ''} ${vgs ? 'vgs' : ''}` },
      h('span', { class: 'ch' }, team ? '[TEAM] ' : ''), bot ? h('span', { class: 'tag bot', style: 'font-size:9px;margin-right:4px' }, 'BOT') : null,
      h('span', { class: 'nm', style: `color:${teamCss(t)}` }, bot ? name.replace(BOT_TAG, '').trim() : name), ': ', h('span', { class: 'tx' }, text));
    if (vgs) this.addVgs(row); else this.addChat(row);
  }

  /** Last few VGS lines, in their own box above the chat. */
  private addVgs(row: HTMLElement) {
    this.vgsLog.append(row);
    row.addEventListener('animationend', () => row.remove());
    while (this.vgsLog.children.length > 5) this.vgsLog.firstChild?.remove();
  }

  /** Last 10 chat lines; they stay ~30 s (all of them while typing). */
  private addChat(row: HTMLElement) {
    const input = this.chat.querySelector('input');
    if (input) this.chat.insertBefore(row, input); else this.chat.append(row);
    row.addEventListener('animationend', () => { if (!this.chat.classList.contains('open')) row.classList.add('gone'); });
    const lines = [...this.chat.querySelectorAll('.m')];
    for (const l of lines.slice(0, Math.max(0, lines.length - 10))) l.remove();
  }

  /** Global chat and private messages from the player network (outside this match). */
  socialLine(kind: 'global' | 'dm' | 'system', name: string, text: string) {
    const row = h('div', { class: `m social ${kind}` },
      h('span', { class: 'ch' }, kind === 'global' ? '[GLOBAL] ' : kind === 'dm' ? '[PM] ' : ''), name ? h('span', { class: 'nm' }, name) : null, name ? ': ' : '', h('span', { class: 'tx' }, text));
    this.addChat(row);
  }

  toast(text: string) {
    const el = h('div', null, text);
    this.toasts.append(el);
    setTimeout(() => el.remove(), 3600);
  }

  announce(text: string, color = '#fff') {
    const el = h('div', { class: 'announce', style: `color:${color}` }, text);
    this.root.append(el);
    setTimeout(() => el.remove(), 3100);
  }

  /**
   * Accolade ribbon, Tribes: Ascend-style: glyph + medal name + credit value,
   * stacked above the crosshair with the newest at the bottom. Big medals
   * (spree finales, captures, end-of-round) linger longer and glow.
   */
  medal(id: string, team = 255, mine = false) {
    const def = MEDALS[id];
    if (!def) return;
    const row = h(
      'div',
      { class: `medal ${def.tier}${mine ? ' mine' : ''}` },
      h('img', { class: 'g', alt: '', src: glyphSrc(medalGlyph(def.icon), mine ? '#ffd166' : feedTint(team)) }),
      h('span', { class: 'nm' }, def.name),
      h('span', { class: 'cr' }, `+${def.credits}`),
    );
    this.medalsEl.append(row);
    while (this.medalsEl.children.length > 5) this.medalsEl.firstElementChild?.remove();
    setTimeout(() => {
      row.classList.add('out');
      setTimeout(() => row.remove(), 420);
    }, def.tier === 'big' ? 5200 : 3600);
  }

  hit(blue: boolean) {
    this.hitmarker.classList.remove('show', 'blue');
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');
    if (blue) this.hitmarker.classList.add('blue');
  }

  damaged(angle: number) {
    this.dmg.style.transform = `rotate(${angle}rad)`;
    this.dmg.classList.remove('show');
    void this.dmg.offsetWidth;
    this.dmg.classList.add('show');
  }
}

export function scoreboard(players: PlayerInfo[], mode: ModeId, myId: number, scores: [number, number], serverName: string, transport: string): HTMLElement {
  const teams = MODES[mode].teams;
  const table = (list: PlayerInfo[]) => h('table', null,
    h('tr', null, ...['Player', 'Class', 'Score', 'K', 'D', 'A', mode === 'ctf' || mode === 'blitz' ? 'Caps' : '', 'Ping', 'Net'].filter((x) => x !== '' || true).map((t) => h('th', null, t))),
    ...list.sort((a, b) => b.score - a.score).map((p) => h('tr', { class: p.id === myId ? 'me' : '' },
      h('td', null, p.bot ? h('span', { class: 'tag bot', style: 'font-size:9px;margin-right:6px' }, 'BOT') : null, p.bot ? p.name.replace(BOT_TAG, '').trim() : p.name),
      h('td', null, CLASSES.find((c) => c.id === p.cls)?.abbrev ?? ''), h('td', null, String(p.score)), h('td', null, String(p.kills)), h('td', null, String(p.deaths)),
      h('td', null, String(p.assists)), h('td', null, mode === 'ctf' || mode === 'blitz' ? String(p.caps) : ''), h('td', null, p.bot ? '—' : String(p.ping)),
      h('td', null, p.transport === 'bot' ? '' : h('span', { class: `tag ${p.transport === 'webtransport' ? 'wt' : 'ws'}`, style: 'font-size:9px' }, p.transport === 'webtransport' ? 'WT' : 'WS')))));
  const head = h('div', { class: 'sb-head' }, `${serverName} · ${MODES[mode].name} · you are on ${transport}`);
  if (!teams) return h('div', { class: 'scoreboard ffa' }, head, h('div', { class: 'sb-team', style: 'border-color:var(--amber)' }, h('h3', null, 'Players'), table(players.filter((p) => p.team !== 255))));
  return h('div', { class: 'scoreboard' }, head,
    ...[0, 1].map((t) => h('div', { class: 'sb-team', style: `border-color:${teamCss(t)}` }, h('h3', null, h('span', null, TEAM_NAMES[t]), h('span', null, String(scores[t]))), table(players.filter((p) => p.team === t)))),
    h('div', { class: 'sb-head' }, `Spectators: ${players.filter((p) => p.team === 255).map((p) => p.name).join(', ') || 'none'}`));
}
