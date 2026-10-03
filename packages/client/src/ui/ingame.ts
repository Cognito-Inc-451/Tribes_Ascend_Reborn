import { CALLINS, CLASSES, ITEMS, MODES, PERKS, PERKS_A, PERKS_B, TEAM_NAMES, VEHICLES, VGS_ROOT, isVgsNode, validateLoadout, type Loadout, type ModeId, type VgsLeaf, type VgsNode } from '@ar/shared';
import { audio } from '../audio/audio.js';
import { NODE_URL } from '../net/node.js';
import { saveSettings, settings } from '../settings.js';
import { clear, h, layoutChar } from './dom.js';

export function overlay(...children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'overlay-center' }, h('div', { class: 'panel modal' }, ...children));
}

export interface RosterEntry { name: string; team: number; bot: boolean; score: number }

/** TA team selection: two team panels with rosters, auto-assign and spectate. */
export function teamMenu(mode: ModeId, myTeam: number, roster: () => RosterEntry[], onTeam: (t: number) => void, onClose: () => void): HTMLElement {
  const pick = (t: number) => { audio.play('click'); onTeam(t); };
  const lists: HTMLElement[] = [h('div', { class: 'ig-team-list' }), h('div', { class: 'ig-team-list' })];
  const counts: HTMLElement[] = [h('div', { class: 'ig-team-count' }), h('div', { class: 'ig-team-count' })];
  const refresh = () => {
    for (const t of [0, 1]) {
      const list = roster().filter((p) => p.team === t).sort((a, b) => b.score - a.score);
      counts[t].textContent = `${list.length} PLAYER${list.length === 1 ? '' : 'S'}`;
      clear(lists[t]);
      lists[t].append(...list.slice(0, 16).map((p) => h('div', null, p.bot ? h('span', { class: 'tag bot' }, 'BOT') : null, ' ', p.name)));
    }
  };
  const side = (t: number) => h('button', { class: `ig-team t${t} ${myTeam === t ? 'mine' : ''}`, onclick: () => pick(t) },
    h('img', { class: 'ig-team-art', alt: '', src: `${NODE_URL}/assets/ui/tribeshud_tr_ingamemenu_${t === 0 ? 'id' : 'i16'}.png`, onerror: (e: Event) => (e.target as HTMLElement).remove() }),
    h('div', { class: 'ig-team-crest' }, t === 0 ? 'BE' : 'DS'),
    h('div', { class: 'ig-team-name' }, TEAM_NAMES[t].toUpperCase()),
    counts[t], lists[t],
    h('div', { class: 'ig-team-join' }, myTeam === t ? 'CURRENT TEAM' : 'JOIN TEAM'));
  const el = h('div', { class: 'ig-screen' },
    h('div', { class: 'ig-head' }, h('span', null, 'SELECT TEAM'), h('small', null, MODES[mode].name.toUpperCase())),
    h('div', { class: 'ig-teams' }, side(0), h('div', { class: 'ig-or' }, 'OR'), side(1)),
    h('div', { class: 'ig-foot' },
      h('button', { class: 'ta-submit', onclick: () => pick(-1) }, 'AUTO-ASSIGN'),
      h('button', { class: 'ta-mini', onclick: () => pick(255) }, 'SPECTATE'),
      myTeam === 0 || myTeam === 1 ? h('button', { class: 'ta-mini', onclick: onClose }, 'CLOSE') : null));
  refresh();
  const timer = setInterval(() => { if (el.isConnected) refresh(); else clearInterval(timer); }, 1000);
  return el;
}

/** TA in-game class & loadout: classes (left), loadout slots (middle), choices + stats (right), DEPLOY. */
export function classMenu(mode: ModeId, team: number, onTeam: (t: number) => void, onPick: (cls: string, lo: Loadout) => void, onClose: () => void): HTMLElement {
  let cls = CLASSES.find((c) => c.id === settings.lastClass) ?? CLASSES[0];
  let slot: keyof Loadout = 'primary';
  const root = h('div', { class: 'ig-screen' });
  const itemName = (id: string) => ITEMS[id]?.name ?? id;
  const perkName = (id: string) => PERKS.find((p) => p.id === id)?.name ?? id;
  const render = () => {
    clear(root);
    const lo = settings.loadouts[cls.id];
    const classes = h('div', { class: 'ta-panel ig-col' }, h('div', { class: 'ta-panel-head' }, 'CLASSES'),
      h('div', { class: 'ta-items' }, (['light', 'medium', 'heavy'] as const).flatMap((armor) => [
        h('div', { class: 'ig-armor' }, `${armor.toUpperCase()} ARMOR`),
        ...CLASSES.filter((c) => c.armor === armor).map((c) => h('button', { class: `ta-item ${c.id === cls.id ? 'active' : ''}`, onclick: () => { audio.play('click'); cls = c; settings.lastClass = c.id; saveSettings(); render(); } },
          h('span', { class: 't' }, c.name.toUpperCase()), h('span', { class: 's' }, `${c.health} HP \u00b7 ${c.energy} EN`), h('span', { class: 'ta-badge blue' }, String(CLASSES.indexOf(c) + 1)))),
      ])));
    const slots: [keyof Loadout, string, string][] = [
      ['primary', 'PRIMARY WEAPON', itemName(lo.primary)], ['secondary', 'SECONDARY WEAPON', itemName(lo.secondary)], ['belt', 'BELT ITEM', itemName(lo.belt)],
      ['pack', 'PACK', itemName(lo.pack)], ['perkA', 'PRIMARY PERK', perkName(lo.perkA)], ['perkB', 'SECONDARY PERK', perkName(lo.perkB)],
    ];
    const loadout = h('div', { class: 'ta-panel ig-col' }, h('div', { class: 'ta-panel-head' }, `${cls.name.toUpperCase()} LOADOUT`),
      h('div', { class: 'ta-items' }, slots.map(([k, label, val]) => h('button', { class: `ta-item ${slot === k ? 'active' : ''}`, onclick: () => { audio.play('click'); slot = k; render(); } },
        h('span', { class: 't' }, label), h('span', { class: 's' }, val.toUpperCase())))));
    const list = slot === 'perkA' ? PERKS_A : slot === 'perkB' ? PERKS_B : { primary: cls.primaries, secondary: cls.secondaries, belt: cls.belts, pack: cls.packs }[slot];
    const info = h('div', { class: 'ig-info' });
    const describe = (id: string) => {
      clear(info);
      const it = ITEMS[id], perk = PERKS.find((p) => p.id === id);
      info.append(h('div', { class: 'stat-title' }, (it?.name ?? perk?.name ?? id).toUpperCase()));
      if (perk) info.append(h('p', null, perk.desc));
      if (it?.projectile) info.append(h('p', null, `${it.projectile.direct} direct \u00b7 ${it.projectile.splashMax} splash \u00b7 ${it.projectile.radius} m radius \u00b7 ${Math.round(it.projectile.speed * 3.6)} km/h`));
      else if (it?.hitscan) info.append(h('p', null, `${it.hitscan.damage}${it.hitscan.pellets > 1 ? ` \u00d7 ${it.hitscan.pellets}` : ''} damage \u00b7 ${it.clip ?? '-'} clip`));
    };
    const choices = h('div', { class: 'ta-panel ig-col wide' }, h('div', { class: 'ta-panel-head' }, slots.find(([k]) => k === slot)![1]),
      h('div', { class: 'ta-choices' }, list.map((id) => h('button', {
        class: `ta-choice ${lo[slot] === id ? 'sel' : ''}`,
        onmouseenter: () => describe(id),
        onclick: () => { audio.play('click'); settings.loadouts[cls.id] = validateLoadout(cls.id, { ...lo, [slot]: id }); saveSettings(); render(); },
      }, (slot === 'perkA' || slot === 'perkB' ? perkName(id) : itemName(id)).toUpperCase()))), info);
    describe(lo[slot]);
    root.append(
      h('div', { class: 'ig-head' }, h('span', null, 'SELECT CLASS'), h('small', null, `${MODES[mode].name.toUpperCase()}${MODES[mode].teams && (team === 0 || team === 1) ? ` \u00b7 ${TEAM_NAMES[team].toUpperCase()}` : ''}`)),
      h('div', { class: 'ig-cols' }, classes, loadout, choices),
      h('div', { class: 'ig-foot' },
        MODES[mode].teams ? h('button', { class: 'ta-mini', onclick: () => onTeam(-2) }, 'CHANGE TEAM') : null,
        h('button', { class: 'ta-mini', onclick: onClose }, 'CLOSE'),
        h('button', { class: 'ta-submit', onclick: () => { audio.play('click'); onPick(cls.id, settings.loadouts[cls.id]); } }, 'DEPLOY')));
  };
  render();
  return root;
}

export function escMenu(actions: { resume: () => void; cls: () => void; settings: () => void; disconnect: () => void; admin: () => void }, serverName: string, transport: string): HTMLElement {
  return overlay(
    h('h2', { style: 'margin-bottom:.4em' }, 'Paused'),
    h('div', { class: 'muted', style: 'margin-bottom:1.2em' }, `${serverName} · ${transport}`),
    h('div', { style: 'display:flex;flex-direction:column;gap:.5em;max-width:320px' },
      h('button', { class: 'btn primary', onclick: actions.resume }, 'Resume'),
      h('button', { class: 'btn', onclick: actions.cls }, 'Class & Team'),
      h('button', { class: 'btn', onclick: actions.settings }, 'Settings'),
      h('button', { class: 'btn', onclick: actions.admin }, 'Admin'),
      h('button', { class: 'btn ghost', onclick: actions.disconnect }, 'Disconnect')));
}

export function vehicleMenu(credits: number, onBuy: (v: string) => void, onClose: () => void): HTMLElement {
  return overlay(
    h('h2', null, 'Vehicle Station'),
    h('div', { class: 'muted' }, `Credits: ${credits}`),
    h('div', { class: 'choice-list' }, Object.values(VEHICLES).map((v) => h('div', { class: 'choice', onclick: () => onBuy(v.type) },
      h('div', { class: 'n' }, v.name.toUpperCase()), h('div', { class: 'muted' }, `${v.health} HP · ${v.seats} seat${v.seats > 1 ? 's' : ''} · ${Math.round(v.maxSpeed * 3.6)} km/h`),
      h('div', { class: 'c' }, `◆ ${v.cost}`)))),
    h('div', { class: 'muted', style: 'margin-top:1em;font-size:13px' }, `Call-ins (keys 5–7, aim at a target): ${Object.values(CALLINS).map((c) => `${c.name} ◆${c.cost}`).join(' · ')}`),
    h('div', { style: 'text-align:right;margin-top:1em' }, h('button', { class: 'btn ghost', onclick: onClose }, 'Close')));
}

export function mapVote(options: { id: string; name: string }[], onVote: (id: string) => void): HTMLElement {
  return h('div', { class: 'panel', style: 'position:absolute;left:50%;bottom:12%;transform:translateX(-50%);padding:1em 1.4em' },
    h('h3', { style: 'margin-bottom:.5em' }, 'Vote for the next map'),
    h('div', { class: 'choice-list' }, options.map((o) => h('div', { class: 'choice', onclick: (e: Event) => { onVote(o.id); (e.currentTarget as HTMLElement).style.borderColor = 'var(--amber)'; } }, h('div', { class: 'n' }, o.name)))));
}

/** Walks the VGS tree by key presses (V, then letters). */
export class VgsMenu {
  node: VgsNode | null = null;
  readonly el = h('div', { class: 'vgs hidden' });

  open() { this.node = VGS_ROOT; this.render(); }
  close() { this.node = null; this.el.classList.add('hidden'); }
  get isOpen() { return this.node !== null; }

  /** `key` is the event's character, so VGS letters follow the keyboard layout (AZERTY's Z is "Z", not "W"). */
  press(code: string, key?: string): VgsLeaf | 'close' | null {
    if (!this.node) return null;
    if (code === 'Escape' || code === 'Backspace') { this.close(); return 'close'; }
    const physical = code.replace(/^(Key|Digit)/, '');
    const k = key?.length === 1 ? key.toUpperCase() : (layoutChar(code) ?? '').toUpperCase();
    // Latin letters/digits as typed; non-Latin layouts (Cyrillic, Greek...) fall back to the key's position.
    const letter = /^[A-Z0-9]$/.test(k) ? k : !k || /\p{L}/u.test(k) ? physical : k;
    const child = this.node.children.find((c) => c.key === letter);
    if (!child) return null;
    if (isVgsNode(child)) { this.node = child; this.render(); return null; }
    this.close();
    return child;
  }

  private render() {
    const n = this.node!;
    this.el.classList.remove('hidden');
    this.el.replaceChildren(h('h3', null, n.label === 'Root Menu' ? 'Voice Game System' : n.label),
      ...n.children.map((c) => h('div', null, h('b', null, c.key), isVgsNode(c) ? `${c.label} ▸` : c.text)));
  }
}
