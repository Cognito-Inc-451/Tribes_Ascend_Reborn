import {
  ACTION_LABELS, ARMOR_BLURB, BANNERS, CLASSES, EMBLEMS, ITEMS, JET_TRAILS, LAYOUT_BY_ID, MODES, NAMEPLATES, PERKS, PERKS_A, PERKS_B,
  PROTOCOL_VERSION, randomTip, WEAPON_FINISHES, validateLoadout, type Action, type GameOptions, type Loadout, type ModeId, type ServerInfo,
} from '@ar/shared';
import { audio } from '../audio/audio.js';
import type { Input } from '../input/input.js';
import { fetchPeers, NODE_URL, type BrowserServer, type DiscoveryStats } from '../net/node.js';
import { social, type ChatMsg } from '../net/social.js';
import { loadStats, resetStats } from '../game/stats.js';
import { expectedTransport, browserSupportsWebTransport } from '../net/transport.js';
import { applyQuality, exportProfile, importProfile, resetBinds, saveSettings, settings, type Quality } from '../settings.js';
import { clear, h, keyLabel } from './dom.js';
import { chooseVoice, ClassPreview, currentSkinName, ensureDefaultVoice, skinOptions, statBlock, taModelsReady, voiceLabel, voiceOptions } from './loadoutkit.js';

declare const __MASTER_URL__: string;
const MASTER = (new URLSearchParams(location.search).get('master') ?? __MASTER_URL__).replace(/\/$/, '');

export interface MenuHooks {
  join(info: ServerInfo): void;
  graphicsChanged(): void;
}

export function logo(): HTMLElement {
  return h('div', { class: 'ta-logo' }, h('div', { class: 'w1' }, 'ASCEND'), h('div', { class: 'w2' }, 'REBORN'),
    h('div', { class: 'w3' }, 'UNOFFICIAL FAN TRIBUTE · NOT AFFILIATED WITH HI-REZ STUDIOS'));
}

function keyHint(key: string, label: string, fn: () => void): HTMLElement {
  return h('button', { class: 'ta-key', onclick: fn }, h('kbd', null, key), label);
}

export function rulesText(o: GameOptions): string {
  const r: string[] = [];
  if (o.botsPerTeam !== undefined) r.push(`${o.botsPerTeam} bots per team (${o.botDifficulty ?? 'adept'})`);
  if (o.infiniteAmmo) r.push('Infinite ammo');
  if (o.infiniteEnergy) r.push('Infinite energy');
  if (o.noFallDamage) r.push('No fall damage');
  if (o.infiniteCallIns) r.push('Infinite call-ins');
  if (o.vehicles === false) r.push('No vehicles');
  if (o.creditMultiplier && o.creditMultiplier !== 1) r.push(`Credits x${o.creditMultiplier}`);
  if (o.gravity && o.gravity !== 1) r.push(`Gravity x${o.gravity}`);
  if (o.timeLimit !== undefined) r.push(o.timeLimit ? `${o.timeLimit} min time limit` : 'No time limit');
  if (o.scoreLimit !== undefined) r.push(o.scoreLimit ? `Score limit ${o.scoreLimit}` : 'No score limit');
  return r.join(' · ');
}

// ---------------------------------------------------------------- menus
interface PanelItem { label: string; sub?: string; badge?: string; badgeKind?: 'gold' | 'blue'; active?: boolean; onClick: (e: MouseEvent) => void; onHover?: () => void }

export class Menus {
  readonly root: HTMLElement;
  private main: HTMLElement;
  private panel: HTMLElement;
  private keys: HTMLElement;
  private account: HTMLElement;
  private status: HTMLElement;
  private ticker: HTMLElement;
  private servers: BrowserServer[] = [];
  private pings = new Map<string, number>();
  private selected: BrowserServer | null = null;
  private stats: DiscoveryStats | null = null;
  private nodeOk = true;
  private back: (() => void) | null = null;
  private login: HTMLElement | null = null;

  constructor(private ui: HTMLElement, private input: Input, private hooks: MenuHooks) {
    this.main = h('div', { class: 'ta-content' });
    this.panel = h('div', { class: 'ta-panel' });
    this.keys = h('div', { class: 'ta-keys' });
    this.account = h('div', { class: 'ta-account' });
    this.status = h('div', { class: 'ta-status' });
    this.ticker = h('div', { class: 'ta-ticker' });
    this.root = h('div', { class: 'ta-root' },
      h('div', { class: 'ta-left' }, logo(), this.panel, this.keys),
      this.main,
      h('div', { class: 'ta-topbar' }, h('span', { class: 'ta-label' }, 'ACCOUNT'), this.account),
      h('div', { class: 'ta-bottombar' }, this.status, this.ticker),
      h('div', { class: 'grain' }));
    ui.append(this.root);
    void ensureDefaultVoice();
    window.addEventListener('keydown', (e) => {
      if (this.root.classList.contains('hidden') || this.login || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Escape' && this.back) { e.preventDefault(); this.back(); }
      if (e.key === 'm' || e.key === 'M') this.showMain();
    });
    social.onChange(() => this.renderAccount());
    this.renderAccount();
    this.tickTip();
    setInterval(() => this.tickTip(), 12000);
    setInterval(() => { if (!this.root.classList.contains('hidden')) void this.refresh(true); }, 5000);
    if (settings.rememberName && settings.loggedIn) { social.connect(settings.name); this.showMain(); } else this.showLogin();
  }

  // ---------------- frame
  private setPanel(title: string, items: PanelItem[], back: (() => void) | null) {
    this.back = back;
    clear(this.panel);
    this.panel.append(h('div', { class: 'ta-panel-head' }, title),
      h('div', { class: 'ta-items' }, items.map((it) => h('button', {
        class: `ta-item ${it.active ? 'active' : ''}`,
        onclick: (e: MouseEvent) => { audio.ensure(); audio.play('click'); it.onClick(e); },
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); if (it.badgeKind === 'blue') it.onClick(e); },
        onmouseenter: it.onHover ?? null,
      }, h('span', { class: 't' }, it.label), it.sub ? h('span', { class: 's' }, it.sub) : null,
      it.badge ? h('span', { class: `ta-badge ${it.badgeKind ?? 'gold'}` }, it.badge) : null))),
      h('div', { class: 'ta-panel-foot' }));
    clear(this.keys);
    if (back) this.keys.append(keyHint('Esc', 'GO BACK', back), keyHint('M', 'MAIN MENU', () => this.showMain()));
  }

  private renderAccount() {
    clear(this.account);
    const online = social.friends.filter((f) => social.online.some((o) => o.id === f.id)).length;
    this.account.append(h('b', null, settings.name), h('span', { class: 'sep' }), h('span', null, 'GOTY'), h('span', { class: 'gold' }, 'ALL UNLOCKED'),
      h('span', { class: 'sep' }), h('span', null, `FRIENDS ${online}/${social.friends.length}`), h('span', { class: social.connected ? 'ok' : 'bad' }, social.connected ? 'ONLINE' : 'OFFLINE'));
  }

  private tickTip() {
    this.ticker.textContent = randomTip(['ctf', 'arena', 'tdm', 'cah', 'rabbit', 'blitz'][Math.floor(Math.random() * 6)] as 'ctf');
  }

  private setStatus() {
    clear(this.status);
    const st = this.stats;
    this.status.append(h('span', { class: 'region' }, this.nodeOk ? `THIS PC · LAN ${st?.lan ?? 0} · NET ${st?.internet ?? 0}` : 'NODE OFFLINE'),
      h('span', { class: 'ta-label' }, 'STATUS'), h('b', null, 'IN LOBBY'));
  }

  // ---------------- login
  private showLogin() {
    this.root.classList.add('ta-login-mode');
    const name = h('input', { type: 'text', value: settings.rememberName ? settings.name : '', maxLength: 20, autofocus: true }) as HTMLInputElement;
    const remember = h('input', { type: 'checkbox', checked: settings.rememberName }) as HTMLInputElement;
    const submit = () => {
      const n = name.value.trim().slice(0, 20);
      if (!n) { name.focus(); return; }
      settings.name = n; settings.rememberName = remember.checked; settings.loggedIn = true; saveSettings();
      audio.ensure(); audio.play('click');
      this.login?.remove(); this.login = null;
      this.root.classList.remove('ta-login-mode');
      social.connect(n);
      this.renderAccount();
      this.showMain();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this.login = h('div', { class: 'ta-login' }, logo(),
      h('div', { class: 'ta-panel' },
        h('div', { class: 'ta-panel-head' }, 'ACCOUNT INFO'),
        h('label', { class: 'ta-field' }, h('span', null, 'CALLSIGN'), name),
        h('label', { class: 'ta-check' }, remember, h('span', null, 'REMEMBER CALLSIGN')),
        h('div', { class: 'ta-panel-foot submit' }, h('button', { class: 'ta-submit', onclick: submit }, 'SUBMIT'))),
      h('div', { class: 'ta-version' }, `ASCEND REBORN · FAN BUILD · PROTOCOL ${PROTOCOL_VERSION}`));
    this.ui.append(this.login);
    setTimeout(() => name.focus(), 50);
  }

  // ---------------- main menu
  showMain() {
    this.setPanel('MAIN MENU (M)', [
      { label: 'PLAY NOW', badge: 'RECOMMENDED', onClick: () => this.showPlay() },
      { label: 'CLASSES', onClick: () => this.showClasses() },
      { label: 'TRAINING', sub: 'SKI TRAINING · OFFLINE PRACTICE', onClick: () => void this.training() },
      { label: 'SOCIAL', sub: 'FRIENDS · GLOBAL CHAT · MESSAGES', onClick: () => this.showSocial('global') },
      { label: 'STATS', sub: 'YOUR CAREER ON THIS PC', onClick: () => this.showStats() },
      { label: 'SETTINGS', onClick: () => this.showSettings() },
      { label: 'CREDITS', onClick: () => this.showAbout() },
      { label: 'LOG OUT', onClick: () => { settings.loggedIn = false; saveSettings(); this.showLogin(); } },
    ], null);
    this.setMain();
    void this.refresh(true);
  }

  private async training() {
    if (!this.servers.length) await this.refresh();
    const t = this.servers.find((s) => s.mode === 'training' && s.origin === 'local');
    if (t) this.hooks.join(t);
    else this.showHost('training');
  }

  /** Best game: most humans (not full), original maps first, then lowest ping; falls back to this PC. */
  private async playNow() {
    if (!this.servers.length) await this.refresh();
    const open = this.servers.filter((s) => s.humans < s.maxPlayers && !s.passworded && s.version === PROTOCOL_VERSION && s.mode !== 'training');
    const score = (s: BrowserServer) => s.humans * 100 + (s.mapSource === 'original' ? 20 : 0) + (s.mode === 'ctf' ? 10 : 0) - (this.pings.get(this.key(s)) ?? 150) / 10 + (s.origin === 'local' ? -5 : 0);
    const best = open.sort((a, b) => score(b) - score(a))[0];
    if (best) this.hooks.join(best);
    else this.showPlay();
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
    this.login?.classList.toggle('hidden', !v);
    if (v) { social.setStatus('In lobby'); void this.refresh(); }
  }

  private setMain(...els: HTMLElement[]) {
    clear(this.main);
    this.main.append(...els);
  }

  // ---------------- server browser
  private tbody = h('tbody');
  private countEl = h('span');
  private filterMode = '';
  private filterWhere: '' | 'local' | 'lan' | 'internet' | 'friends' = '';
  private showEmpty = true;
  private showFull = true;

  private key(s: BrowserServer) { return `${s.nodeId ?? ''}|${s.id}|${s.wsUrl}`; }
  private lastSig = '';

  private playPanel() {
    const modes = ['', ...Object.keys(MODES)];
    const onOff = (v: boolean) => (v ? 'ENABLED' : 'DISABLED');
    this.setPanel('PLAY NOW', [
      { label: 'QUICK MATCH', sub: 'JOIN THE BEST GAME AVAILABLE', badge: 'RECOMMENDED', onClick: () => void this.playNow() },
      { label: 'REFRESH SERVERS', onClick: () => void this.refresh() },
      { label: 'FILTER GAMETYPES', badge: this.filterMode ? MODES[this.filterMode as ModeId].short : 'ALL', badgeKind: 'blue', onClick: (e) => {
        const i = modes.indexOf(this.filterMode);
        this.filterMode = modes[(i + (e.button === 2 ? modes.length - 1 : 1)) % modes.length];
        this.playPanel(); this.renderRows();
      } },
      { label: 'SHOW EMPTY SERVERS', badge: onOff(this.showEmpty), badgeKind: this.showEmpty ? 'gold' : 'blue', onClick: () => { this.showEmpty = !this.showEmpty; this.playPanel(); this.renderRows(); } },
      { label: 'SHOW FULL SERVERS', badge: onOff(this.showFull), badgeKind: this.showFull ? 'gold' : 'blue', onClick: () => { this.showFull = !this.showFull; this.playPanel(); this.renderRows(); } },
      { label: 'HOST GAME', sub: 'LAUNCH A MAP WITH YOUR RULES', onClick: () => this.showHost() },
    ], () => this.showMain());
  }

  showPlay() {
    this.playPanel();
    const tabs = h('div', { class: 'ta-tabs' }, ([['', 'ALL'], ['local', 'THIS PC'], ['lan', 'LAN'], ['internet', 'INTERNET'], ['friends', 'FRIENDS']] as const).map(([k, l]) =>
      h('button', { class: `ta-tab ${this.filterWhere === k ? 'active' : ''}`, onclick: (e: MouseEvent) => {
        this.filterWhere = k;
        for (const b of tabs.children) b.classList.remove('active');
        (e.currentTarget as HTMLElement).classList.add('active');
        this.renderRows();
      } }, l)));
    const table = h('table', { class: 'ta-table' }, h('thead', null, h('tr', null, ...['NAME', 'SLOTS', 'PING', 'TYPE', 'MAP', 'RULES', 'NET'].map((t) => h('th', null, t)))), this.tbody);
    this.setMain(h('div', { class: 'ta-window browser' },
      h('div', { class: 'ta-window-head' }, 'SERVER BROWSER', h('span', { class: 'hint' }, 'Games are found automatically \u2014 no master server, no IP addresses')),
      tabs, h('div', { class: 'table-wrap' }, table),
      h('div', { class: 'ta-window-foot' }, this.countEl,
        h('button', { class: 'ta-submit', onclick: () => this.selected && this.hooks.join(this.selected) }, 'JOIN'))));
    void this.refresh();
  }

  // ---------------- host game
  private hostCfg: { mode: ModeId; map: string; source: 'original' | 'reborn'; options: Required<Omit<GameOptions, 'timeLimit' | 'scoreLimit'>> & { timeLimit: number; scoreLimit: number } } = {
    mode: 'ctf', map: '', source: 'original', options: { botsPerTeam: 10, botDifficulty: 'adept', infiniteAmmo: false, infiniteEnergy: false, noFallDamage: false, infiniteCallIns: false, vehicles: true, creditMultiplier: 1, gravity: 1, timeLimit: -1, scoreLimit: -1 },
  };
  private mapList: { id: string; name: string; mode: string }[] | null = null;

  private async showHost(mode?: ModeId) {
    if (mode) this.hostCfg.mode = mode;
    if (!this.mapList) {
      try {
        const r = await fetch(`${NODE_URL}/assets/index.json`, { signal: AbortSignal.timeout(3000) });
        this.mapList = r.ok ? ((await r.json()) as { id: string; name: string; mode: string }[]) : [];
      } catch { this.mapList = []; }
    }
    const c = this.hostCfg, o = c.options;
    const modeIds = (Object.keys(MODES) as ModeId[]);
    const maps = this.hostMaps();
    if (c.map && !maps.some((m) => m.id === c.map)) c.map = '';
    const mapName = c.map ? maps.find((m) => m.id === c.map)?.name ?? c.map : `ROTATION (${maps.length})`;
    const cycle = <T,>(list: readonly T[], cur: T, e: MouseEvent) => list[(list.indexOf(cur) + (e.button === 2 ? list.length - 1 : 1)) % list.length];
    const skills = ['recruit', 'adept', 'veteran', 'elite', 'godlike'] as const;
    const times = [-1, 0, 5, 10, 15, 20, 30, 45, 60];
    const scores = [-1, 0, 1, 3, 5, 10, 20, 30, 50, 100];
    const lim = (v: number, unit = '') => (v < 0 ? 'DEFAULT' : v === 0 ? 'NONE' : `${v}${unit}`);
    const rerender = () => void this.showHost();
    this.setPanel('HOST GAME', [
      { label: 'GAME TYPE', badge: MODES[c.mode].short ?? c.mode, badgeKind: 'blue', onClick: (e) => { c.mode = cycle(modeIds, c.mode, e); rerender(); } },
      { label: 'MAP SET', badge: c.source === 'original' && this.hasOriginal() ? 'ORIGINAL' : 'REBORN (GENERATED)', badgeKind: 'blue', onClick: () => { c.source = c.source === 'original' ? 'reborn' : 'original'; c.map = ''; rerender(); } },
      { label: 'MAP', badge: mapName.toUpperCase(), badgeKind: 'blue', onClick: (e) => { c.map = cycle(['', ...maps.map((m) => m.id)], c.map, e); rerender(); } },
      { label: 'BOTS PER TEAM', badge: String(o.botsPerTeam), badgeKind: 'blue', onClick: (e) => { o.botsPerTeam = cycle([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16], o.botsPerTeam, e); rerender(); } },
      { label: 'BOT SKILL', badge: o.botDifficulty.toUpperCase(), badgeKind: 'blue', onClick: (e) => { o.botDifficulty = cycle(skills, o.botDifficulty, e); rerender(); } },
      { label: 'TIME LIMIT', badge: lim(o.timeLimit, ' MIN'), badgeKind: 'blue', onClick: (e) => { o.timeLimit = cycle(times, o.timeLimit, e); rerender(); } },
      { label: 'SCORE LIMIT', badge: lim(o.scoreLimit), badgeKind: 'blue', onClick: (e) => { o.scoreLimit = cycle(scores, o.scoreLimit, e); rerender(); } },
      { label: 'INFINITE AMMO', badge: o.infiniteAmmo ? 'ENABLED' : 'DISABLED', badgeKind: o.infiniteAmmo ? 'gold' : 'blue', onClick: () => { o.infiniteAmmo = !o.infiniteAmmo; rerender(); } },
      { label: 'INFINITE ENERGY', badge: o.infiniteEnergy ? 'ENABLED' : 'DISABLED', badgeKind: o.infiniteEnergy ? 'gold' : 'blue', onClick: () => { o.infiniteEnergy = !o.infiniteEnergy; rerender(); } },
      { label: 'FALL DAMAGE', badge: o.noFallDamage ? 'DISABLED' : 'ENABLED', badgeKind: o.noFallDamage ? 'gold' : 'blue', onClick: () => { o.noFallDamage = !o.noFallDamage; rerender(); } },
      { label: 'INFINITE CALL-INS', badge: o.infiniteCallIns ? 'ENABLED' : 'DISABLED', badgeKind: o.infiniteCallIns ? 'gold' : 'blue', onClick: () => { o.infiniteCallIns = !o.infiniteCallIns; rerender(); } },
      { label: 'VEHICLES', badge: o.vehicles ? 'ENABLED' : 'DISABLED', badgeKind: o.vehicles ? 'blue' : 'gold', onClick: () => { o.vehicles = !o.vehicles; rerender(); } },
      { label: 'CREDIT MULTIPLIER', badge: `x${o.creditMultiplier}`, badgeKind: o.creditMultiplier !== 1 ? 'gold' : 'blue', onClick: (e) => { o.creditMultiplier = cycle([0.5, 1, 1.5, 2, 3, 5, 10], o.creditMultiplier, e); rerender(); } },
      { label: 'GRAVITY', badge: `${Math.round(o.gravity * 100)}%`, badgeKind: o.gravity !== 1 ? 'gold' : 'blue', onClick: (e) => { o.gravity = cycle([0.5, 0.75, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 2], o.gravity, e); rerender(); } },
      { label: 'LAUNCH', sub: 'START THE SERVER AND JOIN', badge: 'GO', onClick: () => void this.launch() },
    ], () => this.showPlay());
    const m = MODES[c.mode];
    this.setMain(h('div', { class: 'ta-window' },
      h('div', { class: 'ta-window-head' }, 'HOST GAME', h('span', { class: 'hint' }, 'Click to change \u00b7 right-click for previous')),
      h('div', { class: 'ta-detail' },
        h('h3', null, m.name.toUpperCase()), h('div', { class: 'ta-sub' }, mapName.toUpperCase()),
        h('div', { class: 'ta-label' }, 'RULES OF ENGAGEMENT'),
        h('ul', { class: 'ta-rules' }, m.rules.map((r) => h('li', null, r))),
        h('p', { class: 'muted' }, `Your game is announced to this PC, your LAN${this.stats?.upnp ? ' and the internet' : ''}. It shuts down after 10 minutes without players.`),
        !this.mapList?.length ? h('p', { class: 'muted' }, 'No original maps imported: Reborn maps rotate. Import yours with "npm run ta-import -- --all".') : null)));
  }

  /** Imported original maps for the chosen mode (default), or the generated Reborn layouts when chosen or nothing is imported. */
  private hostMaps(): { id: string; name: string; source: 'original' | 'reborn' }[] {
    const orig = (this.mapList ?? []).filter((m) => m.mode === this.hostCfg.mode).map((m) => ({ id: m.id, name: m.name, source: 'original' as const }));
    return orig.length && this.hostCfg.source === 'original' ? orig : Object.values(LAYOUT_BY_ID).map((l) => ({ id: l.id, name: l.name, source: 'reborn' as const }));
  }

  private hasOriginal() { return (this.mapList ?? []).some((m) => m.mode === this.hostCfg.mode); }

  private launching = false;
  private async launch() {
    if (this.launching) return;
    this.launching = true;
    const c = this.hostCfg, o = c.options;
    const maps = this.hostMaps();
    const body = {
      name: `${settings.name}'s ${MODES[c.mode].name}`, mode: c.mode, maxPlayers: 32,
      maps: c.map ? [c.map] : maps.map((m) => m.id).slice(0, 16),
      mapSource: maps[0]?.source ?? 'reborn',
      options: {
        botsPerTeam: o.botsPerTeam, botDifficulty: o.botDifficulty, infiniteAmmo: o.infiniteAmmo, infiniteEnergy: o.infiniteEnergy, noFallDamage: o.noFallDamage,
        infiniteCallIns: o.infiniteCallIns, vehicles: o.vehicles, creditMultiplier: o.creditMultiplier, gravity: o.gravity,
        timeLimit: o.timeLimit < 0 ? undefined : o.timeLimit, scoreLimit: o.scoreLimit < 0 ? undefined : o.scoreLimit,
      },
    };
    try {
      const r = await fetch(`${NODE_URL}/host`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const res = (await r.json().catch(() => ({}))) as ServerInfo & { error?: string };
      if (!r.ok || !res.wsUrl) throw new Error(res.error ?? `HTTP ${r.status}`);
      this.hooks.join({ ...res, origin: 'local' } as BrowserServer);
    } catch (e) {
      this.setMain(h('div', { class: 'ta-window' }, h('div', { class: 'ta-window-head' }, 'HOST GAME'),
        h('div', { class: 'ta-detail' }, h('h3', null, 'COULD NOT LAUNCH'), h('p', null, String((e as Error).message ?? e)),
          h('p', { class: 'muted' }, 'Hosting needs the game node running on this PC ("npm start").'))));
    } finally { this.launching = false; }
  }

  private async refresh(quiet = false) {
    const { servers, stats, nodeOk } = await fetchPeers();
    let list: BrowserServer[] = servers;
    if (MASTER) {
      try {
        const r = await fetch(`${MASTER}/servers`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) list = list.concat(((await r.json()) as ServerInfo[]).map((s) => ({ ...s, origin: 'master' as const })));
      } catch { /* optional master offline */ }
    }
    this.stats = stats;
    this.nodeOk = nodeOk;
    const seen = new Set<string>();
    this.servers = list.filter((s) => { const k = s.wsUrl ?? s.id; if (seen.has(k)) return false; seen.add(k); return true; });
    if (this.selected) this.selected = this.servers.find((s) => this.key(s) === this.key(this.selected!)) ?? null;
    this.setStatus();
    const sig = this.servers.map((s) => `${this.key(s)}:${s.humans}:${s.bots}:${s.mapName}`).join(',');
    if (!quiet || sig !== this.lastSig) this.renderRows();
    this.lastSig = sig;
    if (!quiet || Math.random() < 0.3) for (const s of this.servers) void this.measurePing(s);
  }

  private async measurePing(s: BrowserServer) {
    const url = s.wsUrl?.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '/info');
    if (!url) return;
    try {
      const t0 = performance.now();
      await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      this.pings.set(this.key(s), Math.round(performance.now() - t0));
      this.scheduleRender();
    } catch { /* unreachable */ }
  }

  private renderPending = 0;
  private scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = window.setTimeout(() => { this.renderPending = 0; this.renderRows(); }, 400);
  }

  private friendsOn(s: BrowserServer): string[] {
    return social.online.filter((p) => p.serverWs && p.serverWs === s.wsUrl && social.isFriend(p.id)).map((p) => p.name);
  }

  private renderRows() {
    clear(this.tbody);
    const list = this.servers.filter((s) => (!this.filterMode || s.mode === this.filterMode)
      && (this.filterWhere === 'friends' ? this.friendsOn(s).length > 0 : !this.filterWhere || s.origin === this.filterWhere)
      && (this.showEmpty || s.humans > 0) && (this.showFull || s.humans < s.maxPlayers))
      .sort((a, b) => b.humans - a.humans || (this.pings.get(this.key(a)) ?? 999) - (this.pings.get(this.key(b)) ?? 999));
    this.countEl.textContent = `${list.length} SERVER${list.length === 1 ? '' : 'S'}`;
    if (!list.length) this.tbody.append(h('tr', null, h('td', { colSpan: 7, class: 'muted', style: 'padding:2em;text-align:center' }, this.nodeOk ? 'Looking for games on this PC, your LAN and the internet…' : 'Start the game node with "npm start" (it hosts servers and finds other players automatically).')));
    const where: Record<string, string> = { local: 'THIS PC', lan: 'LAN', internet: 'INTERNET', master: 'MASTER' };
    for (const s of list) {
      const exp = expectedTransport(s, settings.transport);
      const ping = this.pings.get(this.key(s));
      const friends = this.friendsOn(s);
      const custom = s.options && (s.options.infiniteAmmo || s.options.infiniteEnergy || s.options.noFallDamage || s.options.infiniteCallIns || s.options.vehicles === false || (s.options.creditMultiplier ?? 1) !== 1 || (s.options.gravity ?? 1) !== 1 || s.options.botsPerTeam !== undefined);
      const row = h('tr', { class: `row ${this.selected && this.key(this.selected) === this.key(s) ? 'sel' : ''}`, onclick: () => { this.selected = s; this.renderRows(); }, ondblclick: () => this.hooks.join(s) },
        h('td', null, h('span', { class: `tag loc-${s.origin}` }, where[s.origin] ?? s.origin), ' ', h('span', { class: 'name' }, s.name), s.passworded ? ' \u{1F512}' : '',
          friends.length ? h('span', { class: 'tag friend', title: friends.join(', ') }, `${friends.length} FRIEND${friends.length > 1 ? 'S' : ''}`) : null),
        h('td', null, `${s.humans}/${s.maxPlayers}`, s.bots ? h('span', { class: 'muted' }, ` +${s.bots} bots`) : ''),
        h('td', { class: ping === undefined ? 'muted' : ping < 60 ? 'ping-good' : ping < 130 ? 'ping-mid' : 'ping-bad' }, ping === undefined ? '\u2026' : String(ping)),
        h('td', null, MODES[s.mode]?.name ?? s.mode),
        h('td', null, s.mapName, s.mapSource === 'original' ? null : h('span', { class: 'tag reborn' }, 'REBORN')),
        h('td', { title: custom ? rulesText(s.options!) : 'Standard rules' }, custom ? h('span', { class: 'tag custom' }, 'CUSTOM') : 'Standard'),
        h('td', { title: `Server offers ${s.transports.join(' + ')}. This browser will use ${exp === 'webtransport' ? 'WebTransport (UDP datagrams)' : 'WebSocket (TCP)'}.` },
          h('span', { class: `tag ${exp === 'webtransport' ? 'wt' : 'ws'}` }, exp === 'webtransport' ? 'UDP' : 'TCP')));
      this.tbody.append(row);
    }
  }

  // ---------------- classes
  private cp: ClassPreview | null = null;

  /** The class preview (one WebGL view reused across screens), showing `weapon` or the class's primary. */
  private preview(clsId: string, weapon?: string): ClassPreview {
    if (!this.cp || this.cp.disposed) this.cp = new ClassPreview();
    this.cp.show(clsId, weapon ?? settings.loadouts[clsId]?.primary ?? '');
    return this.cp;
  }

  private loadoutSummary(clsId: string): HTMLElement {
    const lo = settings.loadouts[clsId];
    const perk = (id: string) => PERKS.find((p) => p.id === id)?.name ?? id;
    const rows: [string, string][] = [['PRIMARY', ITEMS[lo.primary]?.name], ['SECONDARY', ITEMS[lo.secondary]?.name], ['BELT', ITEMS[lo.belt]?.name], ['PACK', ITEMS[lo.pack]?.name], ['PERKS', `${perk(lo.perkA)} \u00b7 ${perk(lo.perkB)}`]];
    return h('div', { class: 'ta-loadout' }, h('div', { class: 'ta-label' }, 'LOADOUT'), rows.map(([a, b]) => h('div', { class: 'stat-line' }, h('span', { class: 'muted' }, a), h('span', null, b ?? '-'))));
  }

  showClasses(sel = settings.lastClass) {
    let current = '', timer = 0;
    const show = (id: string) => {
      if (id === current) return;
      current = id;
      const c = CLASSES.find((x) => x.id === id) ?? CLASSES[0];
      this.setMain(h('div', { class: 'ta-window class-view' },
        h('div', { class: 'ta-window-head' }, c.name.toUpperCase(), h('span', { class: 'hint' }, `${c.armor.toUpperCase()} ARMOR \u00b7 ${c.health} HEALTH \u00b7 ${c.energy} ENERGY`)),
        h('div', { class: 'ta-class-body' },
          h('div', { class: 'ta-detail' }, h('p', null, ARMOR_BLURB[c.armor]), this.loadoutSummary(c.id),
            h('button', { class: 'ta-submit', onclick: () => this.showLoadout(c.id) }, 'MODIFY LOADOUT')),
          this.preview(c.id).el)));
    };
    this.setPanel('MODIFY CLASSES', CLASSES.map((c) => ({
      label: c.name.toUpperCase(), sub: `${c.armor.toUpperCase()} \u00b7 ${c.abbrev}`, badge: 'MASTERED', active: c.id === sel,
      onClick: () => { settings.lastClass = c.id; saveSettings(); this.showLoadout(c.id); },
      onHover: () => { clearTimeout(timer); timer = window.setTimeout(() => { if (this.panel.querySelector('.ta-panel-head')?.textContent === 'MODIFY CLASSES') show(c.id); }, 140); },
    })), () => this.showMain());
    show(sel);
  }

  showLoadout(clsId: string, slot: 'primary' | 'secondary' | 'belt' | 'pack' | 'perkA' | 'perkB' | 'skin' | 'voice' | 'more' = 'primary') {
    const cls = CLASSES.find((c) => c.id === clsId) ?? CLASSES[0];
    const lo = settings.loadouts[cls.id];
    const c = settings.cosmetics;
    // With TA models imported the original skins replace the generated ones.
    taModelsReady(() => this.showLoadout(clsId, slot));
    const skinName = currentSkinName(cls.id);
    const itemName = (id: string) => ITEMS[id]?.name ?? id;
    const perkName = (id: string) => PERKS.find((p) => p.id === id)?.name ?? id;
    const go = (s: typeof slot) => this.showLoadout(cls.id, s);
    this.setPanel(cls.name.toUpperCase(), [
      { label: 'PRIMARY WEAPON', sub: itemName(lo.primary).toUpperCase(), active: slot === 'primary', onClick: () => go('primary') },
      { label: 'SECONDARY WEAPON', sub: itemName(lo.secondary).toUpperCase(), active: slot === 'secondary', onClick: () => go('secondary') },
      { label: 'BELT ITEM', sub: itemName(lo.belt).toUpperCase(), active: slot === 'belt', onClick: () => go('belt') },
      { label: 'PACK', sub: itemName(lo.pack).toUpperCase(), active: slot === 'pack', onClick: () => go('pack') },
      { label: 'PRIMARY PERK', sub: perkName(lo.perkA).toUpperCase(), active: slot === 'perkA', onClick: () => go('perkA') },
      { label: 'SECONDARY PERK', sub: perkName(lo.perkB).toUpperCase(), active: slot === 'perkB', onClick: () => go('perkB') },
      { label: 'SKIN', sub: skinName.toUpperCase(), active: slot === 'skin', onClick: () => go('skin') },
      { label: 'VOICE', sub: voiceLabel(c.voice), active: slot === 'voice', onClick: () => go('voice') },
      { label: 'COSMETICS', sub: 'FINISH \u00b7 TRAIL \u00b7 EMBLEM \u00b7 BANNER', active: slot === 'more', onClick: () => go('more') },
    ], () => this.showClasses(cls.id));

    const choices = h('div', { class: 'ta-choices' });
    const info = h('div', { class: 'ta-choice-info' });
    // The preview holds the weapon of the slot being edited; hovering a weapon choice shows that one instead.
    const held = slot === 'secondary' ? lo.secondary : lo.primary;
    const pv = this.preview(cls.id, held);
    const choice = (label: string, selected: boolean, apply: () => void, detail?: () => HTMLElement | null, weapon?: string) => {
      const el = h('button', { class: `ta-choice ${selected ? 'sel' : ''}`, onclick: () => { audio.ensure(); audio.play('click'); apply(); },
        onmouseenter: () => { if (weapon) pv.show(cls.id, weapon); if (detail) { clear(info); const d = detail(); if (d) info.append(d); } },
        onmouseleave: () => { if (weapon) pv.show(cls.id, held); } }, label.toUpperCase());
      if (selected && detail) { const d = detail(); if (d) info.append(d); }
      return el;
    };
    const setLo = (key: keyof Loadout, id: string) => { settings.loadouts[cls.id] = validateLoadout(cls.id, { ...lo, [key]: id }); saveSettings(); go(slot); };
    const perkDesc = (id: string) => h('div', { class: 'panel stat-block' }, h('div', { class: 'stat-title' }, perkName(id).toUpperCase()), h('p', null, PERKS.find((p) => p.id === id)?.desc ?? ''));
    if (slot === 'primary' || slot === 'secondary' || slot === 'belt' || slot === 'pack') {
      const list = { primary: cls.primaries, secondary: cls.secondaries, belt: cls.belts, pack: cls.packs }[slot];
      const weaponSlot = slot === 'primary' || slot === 'secondary';
      choices.append(...list.map((id) => choice(itemName(id), lo[slot] === id, () => setLo(slot, id), () => statBlock(id), weaponSlot ? id : undefined)));
    } else if (slot === 'perkA' || slot === 'perkB') {
      choices.append(...(slot === 'perkA' ? PERKS_A : PERKS_B).map((id) => choice(perkName(id), lo[slot] === id, () => setLo(slot, id), () => perkDesc(id))));
    } else if (slot === 'skin') {
      choices.append(...skinOptions(cls.id).map((s) => choice(s.name, s.selected, () => { s.apply(); go(slot); })));
      if (taModelsReady()) info.append(h('p', { class: 'muted' }, 'Original Tribes: Ascend armour from your import. Everyone sees your choice; Mercenary armour carries a faint team tint.'));
    } else if (slot === 'voice') {
      void voiceOptions().then((list) => choices.append(...list.map((v) => choice(v.name, c.voice === v.id, () => {
        chooseVoice(v.id); audio.ensure(); void audio.vgs('GlobalShazbot', v.id); go(slot);
      }))));
      info.append(h('p', { class: 'muted' }, 'Original voice packs appear after importing them from your own Tribes: Ascend install (npm run ta-import).'));
    } else {
      choices.append(this.cosmeticsForm(cls.id));
    }
    this.setMain(h('div', { class: 'ta-window loadout-view' },
      h('div', { class: 'ta-window-head' }, cls.name.toUpperCase(), h('span', { class: 'hint' }, 'ALL ITEMS UNLOCKED')),
      h('div', { class: 'ta-loadout-body' }, choices, h('div', { class: 'ta-loadout-side' }, pv.el, info))));
  }

  private cosmeticsForm(clsId: string): HTMLElement {
    const c = settings.cosmetics;
    const pick = <T extends { id: string; name: string }>(label: string, list: T[], key: keyof typeof c, swatch?: (x: T) => string) =>
      h('div', { class: 'slot-row' }, h('div', { class: 'ta-label' }, label), h('div', { class: 'opts' }, list.map((x) => h('div', {
        class: `opt ${c[key] === x.id ? 'sel' : ''}`,
        onclick: () => { (c[key] as string) = x.id; saveSettings(); this.showLoadout(clsId, 'more'); },
      }, swatch ? h('span', { style: `display:inline-block;width:10px;height:10px;margin-right:6px;background:${swatch(x)}` }) : null, x.name))));
    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    return h('div', null,
      pick('WEAPON FINISH', WEAPON_FINISHES, 'weaponFinish', (w) => hex(w.tint)), pick('JET TRAIL', JET_TRAILS, 'jetTrail'), pick('EMBLEM', EMBLEMS, 'emblem'),
      pick('NAMEPLATE', NAMEPLATES, 'nameplate'), pick('BANNER', BANNERS, 'banner', (b) => hex(b.from)));
  }

  // ---------------- settings
  private tab: 'video' | 'audio' | 'controls' | 'keybindings' | 'hud' | 'network' = 'video';

  showSettings(tab?: typeof this.tab) {
    if (tab) this.tab = tab;
    const names = { video: 'VIDEO', audio: 'AUDIO', controls: 'CONTROLS', keybindings: 'KEYBINDINGS', hud: 'HUD', network: 'NETWORK' } as const;
    this.setPanel('SETTINGS', (Object.keys(names) as (keyof typeof names)[]).map((t) => ({ label: names[t], active: this.tab === t, onClick: () => this.showSettings(t) })), () => this.showMain());
    const grid = h('div', { class: 'settings-grid' });
    const row = (label: string, el: HTMLElement) => grid.append(h('label', null, label), el);
    const range = (key: keyof typeof settings, min: number, max: number, step: number, fmt: (v: number) => string = (v) => v.toFixed(2), after?: () => void) => {
      const out = h('span', { class: 'muted', style: 'margin-left:.8em' }, fmt(settings[key] as number));
      return h('div', null, h('input', {
        type: 'range', min, max, step, value: settings[key] as number,
        oninput: (e: Event) => { (settings[key] as number) = Number((e.target as HTMLInputElement).value); out.textContent = fmt(settings[key] as number); saveSettings(); after?.(); },
      }), out);
    };
    const check = (key: keyof typeof settings, after?: () => void) => h('input', { type: 'checkbox', checked: !!settings[key], onchange: (e: Event) => { (settings[key] as boolean) = (e.target as HTMLInputElement).checked; saveSettings(); after?.(); } });
    const gfx = () => this.hooks.graphicsChanged();
    const select = <T extends string>(key: keyof typeof settings, opts: [T, string][], after?: () => void) => h('select', {
      onchange: (e: Event) => { (settings[key] as string) = (e.target as HTMLSelectElement).value; saveSettings(); after?.(); },
    }, opts.map(([v, l]) => h('option', { value: v, selected: settings[key] === v }, l)));

    if (this.tab === 'video') {
      const head = (t: string) => grid.append(h('div', { class: 'settings-head' }, t));
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      const signed = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
      const needsPost = () => { if (settings.post === 'off') this.toast('Needs Post-Processing on'); gfx(); };
      row('Graphics Preset', h('select', { onchange: (e: Event) => { applyQuality((e.target as HTMLSelectElement).value as Quality); gfx(); this.showSettings(); } },
        (['low', 'medium', 'high', 'ultra'] as const).map((q) => h('option', { value: q, selected: settings.quality === q }, q.toUpperCase()))));
      row('Display Mode', h('button', { class: 'btn small', onclick: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); } }, document.fullscreenElement ? 'Fullscreen → Windowed' : 'Windowed → Fullscreen'));
      row('Screen Percentage', range('renderScale', 0.4, 2, 0.05, pct, gfx));
      row('Field of View', range('fov', 70, 130, 1, (v) => `${v}°`, gfx));
      row('Anti-Aliasing (MSAA)', check('antialias', () => { gfx(); this.toast('Fully applies after a reload when post-processing is off'); }));
      row('Frame Rate Limit', range('maxFps', 0, 300, 10, (v) => (v ? `${v} fps` : 'Unlimited')));

      head('DETAIL');
      row('Texture Quality', select('textureDetail', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra (original resolution)']], () => this.toast('Applies on next map load')));
      row('Anisotropic Filtering', h('select', { onchange: (e: Event) => { settings.anisotropy = Number((e.target as HTMLSelectElement).value); saveSettings(); this.toast('Applies on next map load'); } },
        [1, 4, 8, 16].map((v) => h('option', { value: v, selected: settings.anisotropy === v }, v === 1 ? 'Off' : `${v}x`))));
      row('World Detail (view distance)', range('viewDistance', 600, 4000, 100, (v) => `${v} m`, gfx));
      row('Water Quality', select('waterQuality', [['low', 'Low'], ['medium', 'Medium (animated)'], ['high', 'High (waves + sky reflections)']], () => this.toast('Applies on next map load')));
      row('Effects Detail', range('particles', 0.2, 1.5, 0.05, pct));
      row('Weather Effects (snow, rain, dust)', check('weather'));
      row('Bullet Tracers', check('tracers'));

      head('LIGHTING');
      row('Baked Lighting (TA lightmaps)', check('bakedLighting', () => this.toast('Applies on next map load')));
      row('Shadow Quality', select('shadowQuality', [['off', 'Off'], ['low', 'Low (1K)'], ['medium', 'Medium (2K)'], ['high', 'High (2K, wider)'], ['ultra', 'Ultra (4K)']], gfx));
      row('Soft Shadows', check('softShadows', gfx));
      row('Volumetric Height Fog', check('volumetricFog', gfx));
      row('God Rays', check('godrays', needsPost));
      row('Ambient Occlusion (SSAO)', select('ao', [['off', 'Off'], ['low', 'Low'], ['high', 'High']], needsPost));
      row('Water Reflections (SSR)', check('ssr', needsPost));

      head('POST-PROCESSING');
      row('Post-Processing', select('post', [['off', 'Off (fastest)'], ['light', 'On'], ['full', 'On + sharpen']], gfx));
      row('HDR Rendering (16-bit)', check('hdr', needsPost));
      row('Tone Mapping', select('toneMapping', [['aces', 'ACES Filmic'], ['agx', 'AgX'], ['neutral', 'Khronos Neutral'], ['cineon', 'Cineon']], gfx));
      row('Bloom', check('bloom', needsPost));
      row('Bloom Intensity', range('bloomStrength', 0.1, 1.5, 0.05, (v) => v.toFixed(2), needsPost));
      row('Depth of Field', check('dof', needsPost));
      row('Motion Blur', range('motionBlur', 0, 1, 0.05, (v) => (v ? pct(v) : 'Off'), needsPost));

      head('COLOR');
      row('Brightness', range('brightness', 0.6, 1.6, 0.02, pct, gfx));
      row('Contrast', range('contrast', 0.7, 1.4, 0.01, (v) => v.toFixed(2), needsPost));
      row('Saturation', range('saturation', 0, 1.6, 0.01, (v) => v.toFixed(2), needsPost));
      row('Vibrance', range('vibrance', -0.5, 1, 0.01, signed, needsPost));
      row('Color Temperature', range('temperature', -1, 1, 0.02, signed, needsPost));
      row('Tint', range('tint', -1, 1, 0.02, signed, needsPost));
      row('Color Grade', select('grade', [['neutral', 'Neutral'], ['ascend', 'Ascend'], ['cinematic', 'Cinematic'], ['vivid', 'Vivid'], ['bleach', 'Bleach Bypass']], needsPost));
      row('Vignette', range('vignette', 0, 1, 0.01, pct, needsPost));
      row('Film Grain', range('filmGrain', 0, 1, 0.01, (v) => (v ? pct(v) : 'Off'), needsPost));
      row('Chromatic Aberration', range('chromatic', 0, 1, 0.01, (v) => (v ? pct(v) : 'Off'), needsPost));
      row('Sharpen', range('sharpen', 0, 1, 0.01, (v) => (v ? pct(v) : 'Off'), needsPost));
    } else if (this.tab === 'audio') {
      const va = () => audio.applyVolumes();
      row('Master Volume', range('masterVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, va));
      row('Music Volume', range('musicVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, va));
      row('Effects Volume', range('effectsVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, va));
      row('Voice (VGS) Volume', range('vgsVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, va));
      const vsel = h('select', { onchange: (e: Event) => { chooseVoice((e.target as HTMLSelectElement).value); audio.ensure(); void audio.vgs('GlobalShazbot', settings.cosmetics.voice); } }) as HTMLSelectElement;
      void voiceOptions().then((list) => vsel.append(...list.map((v) => h('option', { value: v.id, selected: settings.cosmetics.voice === v.id }, v.name))));
      row('Voice Pack', vsel);
    } else if (this.tab === 'controls') {
      row('Mouse Sensitivity', range('sensitivity', 0.1, 5, 0.01));
      row('Invert Mouse', check('invertY'));
      row('Raw Input (no OS acceleration)', check('rawInput'));
      row('Toggle Zoom', check('toggleZoom'));
      row('', h('span', { class: 'muted' }, 'Ski: hold SPACE · Jetpack: right mouse · Overhead map: B · VGS: V'));
    } else if (this.tab === 'keybindings') {
      for (const [action, label] of Object.entries(ACTION_LABELS) as [Action, string][]) {
        const b = h('button', { class: 'btn small bind-btn' }, (settings.binds[action] ?? []).map(keyLabel).join(' / ') || '—');
        b.onclick = () => {
          b.classList.add('listening');
          b.textContent = 'Press a key…';
          this.input.capture = (code) => {
            if (code !== 'Escape') { settings.binds[action] = [code]; saveSettings(); }
            this.input.capture = null;
            this.showSettings();
            return true;
          };
        };
        row(label, b);
      }
      row('', h('button', { class: 'btn small', onclick: () => { resetBinds(); this.showSettings(); } }, 'Reset to Tribes: Ascend defaults'));
    } else if (this.tab === 'hud') {
      row('HUD Scale', range('hudScale', 0.6, 1.6, 0.05, (v) => `${Math.round(v * 100)}%`));
      row('Minimap', check('minimap'));
      row('Minimap Zoom', range('minimapZoom', 0.5, 2.5, 0.05, (v) => `${Math.round(230 * v)} m`));
      row('Crosshair Color', h('input', { type: 'color', value: settings.crosshairColor, oninput: (e: Event) => { settings.crosshairColor = (e.target as HTMLInputElement).value; saveSettings(); } }));
      row('Crosshair Scale', range('crosshairScale', 0.5, 2, 0.05));
      row('Show Speed', check('showSpeed'));
      row('Force Default Skins', check('forceDefaultSkins'));
      row('Profile (export/import)', h('div', { style: 'display:flex;gap:.5em' },
        h('button', { class: 'btn small', onclick: () => { void navigator.clipboard?.writeText(exportProfile()); } }, 'Copy profile'),
        h('button', { class: 'btn small', onclick: () => { const code = prompt('Paste profile code'); if (code && importProfile(code)) this.showSettings(); } }, 'Import')));
    } else {
      row('Transport', h('select', { onchange: (e: Event) => { settings.transport = (e.target as HTMLSelectElement).value as typeof settings.transport; saveSettings(); } },
        h('option', { value: 'auto', selected: settings.transport === 'auto' }, 'Auto (WebTransport → WebSocket)'),
        h('option', { value: 'webtransport', selected: settings.transport === 'webtransport' }, 'Prefer WebTransport'),
        h('option', { value: 'websocket', selected: settings.transport === 'websocket' }, 'WebSocket only')));
      row('Net stats overlay (F10)', check('showNetStats'));
      row('WebTransport in this browser', h('span', null, browserSupportsWebTransport() ? 'Supported' : 'Not supported (Safari/older browsers) — WebSocket will be used'));
      const st = this.stats;
      row('Game discovery', h('span', null, !this.nodeOk ? 'Node offline (run "npm start")' : `LAN multicast + BitTorrent DHT · ${st?.lan ?? 0} LAN / ${st?.internet ?? 0} internet nodes`));
      row('Hosting for internet players', h('span', null, st?.upnp ? `Ports opened automatically (UPnP)${st.publicIp ? ` · public IP ${st.publicIp}` : ''}` : 'Router did not open ports (UPnP off) — LAN players can still join'));
    }
    this.setMain(h('div', { class: 'ta-window' }, h('div', { class: 'ta-window-head' }, names[this.tab]), h('div', { class: 'ta-scroll' }, grid)));
  }

  private toast(text: string) {
    const t = h('div', { class: 'panel', style: 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);padding:.6em 1.2em;z-index:10' }, text);
    this.ui.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  showAbout() {
    this.setMain(h('div', { class: 'ta-window' }, h('div', { class: 'ta-window-head' }, 'CREDITS'), h('div', { class: 'ta-detail ta-scroll', style: 'line-height:1.55;font-size:16px' },
      h('p', null, 'Ascend Reborn is a non-commercial, community fan tribute that recreates the gameplay of Tribes: Ascend (GOTY) in the browser. It is not affiliated with, endorsed by, or connected to Hi-Rez Studios. Tribes and Tribes: Ascend are trademarks of their respective owners.'),
      h('p', null, 'No game assets ship with this project. Each player can import original maps, textures and voice packs from their own Tribes: Ascend install (npm run ta-import); those files stay on that machine and are only used locally or by the games that player hosts.'),
      h('p', null, 'Games are found without any central server: every running copy discovers others on the LAN (multicast) and over the internet via the public BitTorrent DHT, and connects directly.'),
      h('p', { class: 'muted' }, 'Gameplay numbers are sourced from the community wikis (tribes.fandom.com, wiki.tribesdepot.com) and tuned against the original game. Values marked "est" are pending measurement.'),
      h('p', { class: 'muted' }, `Maps: ${Object.keys(LAYOUT_BY_ID).length} reborn layouts. Modes: ${Object.values(MODES).map((m) => m.name).join(', ')}.`))));
  }

  // ---------------- stats
  showStats() {
    const s = loadStats();
    const m = Math.max(1, s.matches);
    const pct = (n: number) => `${s.kills ? ((n / s.kills) * 100).toFixed(2) : '0.00'}%`;
    const dur = (sec: number) => { const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60); return `${d ? `${d} Days ` : ''}${hh} H ${mm} M`; };
    const rows = (list: [string, string | number][]) => h('div', { class: 'st-rows' }, list.map(([a, b]) => h('div', { class: 'stat-line' }, h('span', null, a), h('b', null, String(b)))));
    const armors: [string, string, string][] = [['heavy', 'HEAVY', '#c81e10'], ['light', 'LIGHT', '#10d8e8'], ['medium', 'MEDIUM', '#10a070']];
    const totalArmor = armors.reduce((a, [k]) => a + (s.timeByArmor[k] ?? 0), 0);
    const most = armors.slice().sort((a, b) => (s.timeByArmor[b[0]] ?? 0) - (s.timeByArmor[a[0]] ?? 0))[0];
    // Donut: one arc per armour, proportional to time played.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-110 -110 220 220'); svg.setAttribute('class', 'st-donut');
    let start = -Math.PI / 2;
    for (const [k, , color] of armors) {
      const f = totalArmor ? (s.timeByArmor[k] ?? 0) / totalArmor : 1 / 3;
      if (f <= 0) continue;
      const end = start + f * Math.PI * 2 - (f < 1 ? 0.002 : 0.0001);
      const p = document.createElementNS(NS, 'path');
      const large = end - start > Math.PI ? 1 : 0;
      p.setAttribute('d', `M ${100 * Math.cos(start)} ${100 * Math.sin(start)} A 100 100 0 ${large} 1 ${100 * Math.cos(end)} ${100 * Math.sin(end)}`);
      p.setAttribute('stroke', color); p.setAttribute('stroke-width', '12'); p.setAttribute('fill', 'none');
      svg.append(p);
      start = end;
    }
    const modes = Object.entries(s.timeByMode).sort((a, b) => b[1] - a[1]);
    const totalMode = modes.reduce((a, [, v]) => a + v, 0);
    const table = (list: [string, string, number][], total: number) => h('table', { class: 'st-table' },
      list.map(([name, color, v]) => h('tr', null, h('td', null, name), h('td', null, color ? h('i', { style: `background:${color}` }) : null),
        h('td', null, `${total ? ((v / total) * 100).toFixed(2) : '0.00'}%`), h('td', null, dur(v)))),
      h('tr', { class: 'tot' }, h('td'), h('td'), h('td', null, '100.00%'), h('td', null, dur(total))));
    this.setMain(h('div', { class: 'ta-window st-window' },
      h('div', { class: 'ta-window-head' }, `PLAYERS \u203a ${settings.name.toUpperCase()}`, h('span', { class: 'hint' }, `${s.matches} MATCHES \u00b7 SINCE ${new Date(s.created).toLocaleDateString()}`)),
      h('div', { class: 'st-grid' },
        h('div', null,
          h('h3', null, 'KILL STATS'),
          rows([['Belt Kills', pct(s.beltKills)], ['Callin Kills', pct(s.callinKills)], ['Kills In Vehicle', pct(s.vehicleKills)], ['Melee Kills', pct(s.meleeKills)], ['Midairs', pct(s.midairs)], ['Vehicle Roadkills', pct(s.roadkills)]]),
          h('h3', null, 'MATCH AVERAGES'),
          rows([['K:D', (s.kills / Math.max(1, s.deaths)).toFixed(2)], ['Kills', (s.kills / m).toFixed(1)], ['Deaths', (s.deaths / m).toFixed(1)], ['Assists', (s.assists / m).toFixed(1)],
            ['Flag Caps', (s.flagCaps / m).toFixed(1)], ['Flag Returns', (s.flagReturns / m).toFixed(1)], ['Full Regenerations', (s.fullRegens / m).toFixed(1)],
            ['Midairs', (s.midairs / m).toFixed(1)], ['Multikills', (s.multikills / m).toFixed(1)], ['Ski Distance', `${((s.skiDistance / m) / 1000).toFixed(1)} km`], ['Sprees', (s.sprees / m).toFixed(1)]])),
        h('div', { class: 'st-mid' },
          h('div', { class: 'st-donut-wrap' }, svg, h('div', { class: 'st-most' }, h('small', null, 'MOST PLAYED'), h('b', null, totalArmor ? most[1] : '\u2014'),
            h('span', null, totalArmor ? `${(((s.timeByArmor[most[0]] ?? 0) / totalArmor) * 100).toFixed(2)}% \u00b7 ${dur(s.timeByArmor[most[0]] ?? 0)}` : 'Play a match to start tracking'))),
          table(armors.map(([k, name, color]) => [name, color, s.timeByArmor[k] ?? 0]), totalArmor),
          table(modes.map(([k, v]) => [(MODES[k as ModeId]?.short ?? k).toUpperCase(), '', v]), totalMode)),
        h('div', null,
          h('h3', null, 'BASE STATS'),
          rows([['Total Time Played', dur(s.timePlayed)], ['Matches Completed', s.matches], ['Matches Won', s.wins], ['Kills', s.kills], ['Deaths', s.deaths], ['Assists', s.assists],
            ['Belt Kills', s.beltKills], ['Callin Kills', s.callinKills], ['Melee Kills', s.meleeKills], ['Midairs', s.midairs], ['Multikills', s.multikills], ['Sprees', s.sprees],
            ['Flag Caps', s.flagCaps], ['Flag Returns', s.flagReturns], ['Flag Grabs', s.flagGrabs], ['High Speed Flag Grabs', s.highSpeedGrabs], ['Full Regenerations', s.fullRegens],
            ['Ski Distance', `${(s.skiDistance / 1000).toFixed(1)} km`], ['Top Speed', `${Math.round(s.topSpeed)} km/h`], ['Last Played', new Date(s.lastPlayed).toLocaleString()]]),
          h('button', { class: 'ta-mini', style: 'margin-top:1em', onclick: () => { if (confirm('Reset all local stats?')) { resetStats(); this.showStats(); } } }, 'RESET STATS')))));
  }

  // ---------------- social
  private socialTab: 'global' | 'friends' | 'players' | 'messages' = 'global';
  private dmWith = '';
  private socialOff: (() => void) | null = null;

  showSocial(tab?: typeof this.socialTab, dmWith?: string) {
    if (tab) this.socialTab = tab;
    if (dmWith !== undefined) this.dmWith = dmWith;
    const friendsOnline = social.friends.filter((f) => social.online.some((o) => o.id === f.id)).length;
    this.setPanel('SOCIAL', [
      { label: 'GLOBAL CHAT', sub: 'EVERYONE ON THE NETWORK', active: this.socialTab === 'global', onClick: () => this.showSocial('global') },
      { label: 'FRIENDS', badge: `${friendsOnline} ONLINE`, badgeKind: friendsOnline ? 'gold' : 'blue', active: this.socialTab === 'friends', onClick: () => this.showSocial('friends') },
      { label: 'PLAYERS ONLINE', badge: String(social.online.length), badgeKind: 'blue', active: this.socialTab === 'players', onClick: () => this.showSocial('players') },
      { label: 'MESSAGES', sub: 'PRIVATE · END-TO-END ENCRYPTED', active: this.socialTab === 'messages', onClick: () => this.showSocial('messages') },
    ], () => this.showMain());
    const body = h('div', { class: 'ta-social' });
    const render = () => this.renderSocial(body);
    render();
    this.socialOff?.();
    const off = social.onChange(() => { if (body.isConnected) render(); else off(); });
    this.socialOff = () => { off(); };
    const heads = { global: 'GLOBAL CHAT', friends: 'FRIENDS', players: 'PLAYERS ONLINE', messages: this.dmWith ? `MESSAGES · ${social.nameOf(this.dmWith).toUpperCase()}` : 'MESSAGES' };
    this.setMain(h('div', { class: 'ta-window' }, h('div', { class: 'ta-window-head' }, heads[this.socialTab],
      h('span', { class: 'hint' }, social.connected ? `YOU ARE ${settings.name.toUpperCase()} · ID ${social.myId.slice(0, 6)}` : 'CONNECTING TO YOUR NODE…')), body));
  }

  private renderSocial(body: HTMLElement) {
    const keepInput = body.querySelector('input');
    const draft = keepInput?.value ?? '';
    const hadFocus = keepInput && document.activeElement === keepInput;
    clear(body);
    const playerRow = (id: string, name: string, status: string, serverWs?: string, serverName?: string) => {
      const server = serverWs ? this.servers.find((s) => s.wsUrl === serverWs) : undefined;
      return h('div', { class: 'ta-person' },
        h('span', { class: `dot ${social.online.some((o) => o.id === id) ? 'on' : ''}` }), h('b', null, name),
        h('span', { class: 'muted' }, serverName ? `${status} · ${serverName}` : status),
        h('span', { class: 'grow' }),
        server ? h('button', { class: 'ta-mini', onclick: () => this.hooks.join(server) }, 'JOIN') : null,
        h('button', { class: 'ta-mini', onclick: () => this.showSocial('messages', id) }, 'MESSAGE'),
        social.isFriend(id)
          ? h('button', { class: 'ta-mini', onclick: () => social.removeFriend(id) }, 'REMOVE')
          : h('button', { class: 'ta-mini gold', onclick: () => social.addFriend(id, name) }, 'ADD FRIEND'));
    };
    const chatBox = (msgs: ChatMsg[], send: (t: string) => void, placeholder: string) => {
      const log = h('div', { class: 'ta-chatlog' }, msgs.slice(-150).map((m) => h('div', { class: `ta-line ${m.kind} ${m.mine ? 'mine' : ''}` },
        h('span', { class: 'ts' }, new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        m.kind === 'system' ? null : h('b', { onclick: () => m.from && m.from !== social.myId && this.showSocial('messages', m.from) }, m.name), ' ', m.text)));
      const input = h('input', { type: 'text', maxLength: 200, placeholder, value: draft }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && input.value.trim()) { send(input.value); input.value = ''; } });
      body.append(log, h('div', { class: 'ta-chat-input' }, input, h('button', { class: 'ta-submit', onclick: () => { if (input.value.trim()) { send(input.value); input.value = ''; } } }, 'SEND')));
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; if (hadFocus) input.focus(); });
    };
    if (this.socialTab === 'global') {
      chatBox(social.messages.filter((m) => m.kind === 'global' || m.kind === 'system'), (t) => social.say(t), 'Say something to everyone…');
    } else if (this.socialTab === 'friends') {
      if (!social.friends.length) body.append(h('p', { class: 'muted' }, 'No friends yet. Add players from PLAYERS ONLINE or by clicking a name in chat.'));
      for (const f of social.friends) {
        const o = social.online.find((p) => p.id === f.id);
        body.append(playerRow(f.id, o?.name ?? f.name, o ? o.status : 'Offline', o?.serverWs, o?.serverName));
      }
    } else if (this.socialTab === 'players') {
      if (!social.online.length) body.append(h('p', { class: 'muted' }, 'Nobody else found yet. Players running Ascend Reborn on your LAN or the internet appear here automatically.'));
      for (const p of social.online) body.append(playerRow(p.id, p.name, p.status, p.serverWs, p.serverName));
    } else {
      const threads = new Map<string, ChatMsg>();
      for (const m of social.messages) if (m.kind === 'dm') threads.set(m.mine ? m.to ?? '' : m.from, m);
      const list = h('div', { class: 'ta-threads' }, [...threads.entries()].reverse().map(([id, m]) => h('button', { class: `ta-choice ${id === this.dmWith ? 'sel' : ''}`, onclick: () => this.showSocial('messages', id) },
        social.nameOf(id).toUpperCase(), h('small', null, m.text.slice(0, 40)))));
      if (!threads.size && !this.dmWith) list.append(h('p', { class: 'muted' }, 'Private messages are encrypted end-to-end and go directly to the other player\'s PC.'));
      body.append(list);
      if (this.dmWith) {
        const pane = h('div', { class: 'ta-dm' });
        body.append(pane);
        const save = body;
        body = pane;
        chatBox(social.messages.filter((m) => m.kind === 'dm' && (m.from === this.dmWith || m.to === this.dmWith)), (t) => social.dm(this.dmWith, t), `Message ${social.nameOf(this.dmWith)}…`);
        body = save;
      }
    }
  }
}
