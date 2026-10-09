import * as THREE from 'three';
import {
  AF, angleWrap, ASSET_TYPES, ASSETS, BTN, buildCollisionWorld, CLASSES, DT, ITEM_IDS, ITEM_INDEX, ITEMS, MEDALS, MODES, PF, PHASE, projDef, TEAM_NAMES, VEHICLE_TYPES, VEHICLES, VGS_BY_ID, dirFromAngles, GRAVITY, jetStyleFor,
  makeOBB, type AssetSnap, type CollisionWorld, type InputCmd, type JetStyle, type Loadout, type MapData, type ModeId, type PlayerSnap, type S2C, type Snapshot, type Vec3,
} from '@ar/shared';
import { audio } from '../audio/audio.js';
import type { Input } from '../input/input.js';
import type { Session } from '../net/session.js';
import { AssetModel, FlagModel, PlayerModel, teamColor, VehicleModel } from '../render/actors.js';
import { Effects } from '../render/fx.js';
import { renderCeiling, type Renderer } from '../render/renderer.js';
import { ADAPTIVE_RULE, adaptiveStep, initialAdaptiveState, type AdaptiveState } from '../render/adaptive.js';
import { WorldView } from '../render/world.js';
import { TextureStore } from '../render/textures.js';
import { buildViewModel, disposeViewModel, setViewModelStealth, spinViewModel, type FirstPerson } from '../render/viewmodel.js';
import { assetBases } from '../net/node.js';
import { social, type ChatMsg } from '../net/social.js';
import { saveSettings, settings } from '../settings.js';
import { h } from '../ui/dom.js';
import { ENEMY, FRIEND, Hud, scoreboard, type HudState, type Marker, type Plate } from '../ui/hud.js';
import { classMenu, escMenu, mapVote, teamMenu, vehicleMenu, VgsMenu } from '../ui/ingame.js';
import { captureCanvas, getShot, putShot, shotKey } from '../ui/mapshots.js';
import { Minimap } from '../ui/minimap.js';
import { Predictor } from './predict.js';
import { StatsRecorder } from './stats.js';

const INTERP = 0.1;

/** `?gfxlog`: log every change to the scene-wide brightness knobs, for live flicker attribution. */
const GFX_LOG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('gfxlog');

export interface ClientHooks {
  leave(reason?: string): void;
  openSettings(): void;
}

interface PlayerView { model: PlayerModel; cls: number; team: number; cosKey: string; jetStyle: JetStyle }

export class GameClient {
  readonly world: CollisionWorld;
  private view: WorldView;
  private textures: TextureStore | null;
  private minimap: Minimap;
  private fx = new Effects();
  private hud: Hud;
  private pred: Predictor;
  private players = new Map<number, PlayerView>();
  private assetViews = new Map<number, AssetModel>();
  private flagViews = new Map<number, FlagModel>();
  private vehViews = new Map<number, VehicleModel>();
  /** Smoothed vehicle orientation - snapshots arrive at ~10 Hz and raw angles snap. */
  private vehAngles = new Map<number, { yaw: number; pitch: number; roll: number }>();
  private overlayRoot: HTMLElement;
  private overlay: HTMLElement | null = null;
  private scoreEl: HTMLElement | null = null;
  private voteEl: HTMLElement | null = null;
  private vgs = new VgsMenu();
  private chatInput: HTMLInputElement | null = null;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private disposed = false;
  private phase = 0;
  private timeLeft = 0;
  private timeRef = 0;
  private scores: [number, number] = [0, 0];
  private mode: ModeId;
  private slot = 0;
  private lastSlot = 1;
  private cls = settings.lastClass;
  private loadout: Loadout = settings.loadouts[settings.lastClass];
  private thirdPerson = false;
  private zoomToggled = false;
  private showMarkers = true;
  private spec = { free: true, target: -1, pos: new THREE.Vector3(), yaw: 0, pitch: -0.3, speed: 40 };
  /** Smoothed chase-camera state: bots' aim jitters every tick, and following it raw shakes the view. */
  private chase = { target: -1, yaw: 0, pitch: 0, pos: new THREE.Vector3(), cam: new THREE.Vector3() };
  private deathPos: Vec3 | null = null;
  private nextFireLocal = 0;
  private prevClip = -1;
  private recoil = 0;
  private viewModel: THREE.Group;
  private strikes: { pos: Vec3; until: number; kind: string }[] = [];
  private lastFrameTime = 0;
  private lastRaf = 0;
  private displayPeriod = 16.7;
  private fps = 0;
  private adapt: AdaptiveState = initialAdaptiveState(1);
  private cmdHistory: InputCmd[] = [];
  private landSoundAt = 0;
  private reloadSnd = 0;
  private drawnWeapon = '';
  private wasOnGround = true;
  private wasFalling = false;
  private fellBack: boolean;

  constructor(private r: Renderer, private input: Input, ui: HTMLElement, private session: Session, readonly map: MapData, private hooks: ClientHooks, fellBack: boolean) {
    this.fellBack = fellBack;
    this.mode = session.server.mode;
    this.world = buildCollisionWorld(map);
    this.world.gravityScale = session.server.options?.gravity ?? 1;
    this.textures = map.textures?.length ? new TextureStore(assetBases(session.server), r.renderer) : null;
    audio.setAssetBases(assetBases(session.server));
    this.view = new WorldView(map, r.scene, this.textures, r.renderer);
    r.setSun(this.view.sunDirection);
    this.view.onSkyEnv = (t) => r.setSkyEnvironment(t);
    r.setSkyEnvironment(this.view.setSkyIBL());
    r.scene.add(this.fx.group);
    // Decals need a surface to lie on: prefer the exact geometry the ray hits, fall back to
    // the heightfield when the cast misses every box/triangle (open sky above terrain).
    this.fx.surfaceQuery = (from, to) => {
      const hit = this.world.raycast(from, to, undefined, false);
      if (hit) return { point: hit.point, normal: hit.normal };
      const y = this.map.terrain.heightAt(to.x, to.z);
      if (!Number.isFinite(y)) return null;
      return { point: { x: to.x, y, z: to.z }, normal: this.map.terrain.normalAt(to.x, to.z) };
    };
    this.pred = new Predictor(this.world, !!session.server.options?.infiniteEnergy);
    // The server keeps our last input seq across map changes and drops anything at or below it.
    this.pred.seq = session.inputSeq;
    this.pred.setLoadout(this.cls, this.loadout);
    this.hud = new Hud(ui);
    this.minimap = new Minimap(map, () => this.view.roof);
    this.hud.root.append(this.minimap.mini, this.minimap.big);
    this.overlayRoot = h('div', { class: 'passthrough', style: 'position:absolute;inset:0' });
    ui.append(this.overlayRoot);
    this.hud.vgsSlot.append(this.vgs.el);
    this.viewModel = new THREE.Group();
    r.camera.add(this.viewModel);
    session.onSnapshot = (s) => this.onSnapshot(s);
    session.onJson = (m) => this.onJson(m);
    input.gameActive = true;
    input.capture = (code, e) => this.captureKey(code, e);
    input.clickThrough = () => this.dead();
    // Browsers swallow the Esc that releases the mouse: treat losing the lock as that Esc.
    this.lockOff = input.onLockChange((locked, byUser) => { if (!locked && byUser) this.openEscMenu(); });
    const c = this.centroid();
    this.spec.pos.set(c.x, c.y + 80, c.z);
    session.send({ t: 'class', cls: this.cls, loadout: this.loadout });
    session.send({ t: 'mapready' });
    if (fellBack) this.hud.toast('WebTransport unavailable — fell back to WebSocket');
    if (!session.greeted) { session.greeted = true; this.openClassMenu(); }
    this.socialOff = social.onMessage(this.onSocial);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private centroid(): Vec3 {
    const t = this.map.terrain;
    const x = t.originX + t.width / 2, z = t.originZ + t.depth / 2;
    return { x, y: t.heightAt(x, z), z };
  }

  private introCache = new Map<number, { target: Vec3; camY: number; radius: number }>();
  /** Orbit for the pre-spawn camera: our flag stand / spawn area (map centre when unassigned), high above the tallest surface. */
  private introView(team: number) {
    let v = this.introCache.get(team);
    if (v) return v;
    const ents = this.map.entities;
    const pick = ents.filter((e) => e.kind === 'flag_stand' && e.team === team);
    const spawns = ents.filter((e) => e.kind === 'spawn' && (team > 1 || e.team === team));
    const src = pick.length ? pick : spawns;
    const target = src.length
      ? src.reduce((a, e) => ({ x: a.x + e.pos.x / src.length, y: a.y + e.pos.y / src.length, z: a.z + e.pos.z / src.length }), { x: 0, y: 0, z: 0 })
      : this.centroid();
    const radius = 70;
    let top = target.y;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, x = target.x + Math.cos(a) * radius, z = target.z + Math.sin(a) * radius;
      const hit = this.world.raycast({ x, y: target.y + 600, z }, { x, y: target.y - 200, z }, undefined, false);
      top = Math.max(top, hit ? hit.point.y : this.map.terrain.heightAt(x, z));
    }
    v = { target, camY: Math.max(top + 30, target.y + 45), radius };
    this.introCache.set(team, v);
    return v;
  }

  private vmItem = '';
  private repairFiring = false;
  /** Swap the first-person weapon model when the held weapon changes. */
  private syncViewModel() {
    const item = this.slot === 1 ? this.loadout.secondary : this.loadout.primary;
    const armor = (CLASSES.find((c) => c.id === this.cls) ?? CLASSES[0]).armor;
    const team = this.meSnap()?.team ?? 0;
    const key = `${item}|${settings.cosmetics.weaponFinish}|${armor}|${team}`;
    if (key === this.vmItem) return;
    this.vmItem = key;
    this.repairFiring = false;
    for (const c of [...this.viewModel.children]) { this.viewModel.remove(c); disposeViewModel(c); }
    this.viewModel.add(buildViewModel(item, settings.cosmetics.weaponFinish, { armor, team }));
  }

  /** TA first-person arms/weapon of the held item, once loaded. */
  private get fp(): FirstPerson | undefined { return this.viewModel.children[0]?.userData.fp as FirstPerson | undefined; }
  private lastReload = 0;
  /** `?gfxlog`: timestamp the snapshot has been reporting us dead (0 = alive); 0 when alive. */
  private deadSince = 0;
  /** `?gfxlog`: last logged brightness line, so the log only fires on change. */
  private gfxLine = '';

  // ------------------------------------------------------------------ input
  private captureKey(code: string, e: KeyboardEvent | null): boolean {
    if (this.chatInput) return false;
    if (this.vgs.isOpen) {
      const r = this.vgs.press(code, e?.key);
      if (r && r !== 'close') this.session.send({ t: 'vgs', id: r.id });
      return true;
    }
    if (this.overlay && code === 'Escape') {
      // The same Esc can arrive right after the lost pointer lock opened the menu.
      if (performance.now() - this.escOpenedAt > 300) this.closeOverlay();
      return true;
    }
    void e;
    return false;
  }

  private anyOverlay() { return !!this.overlay || !!this.chatInput; }

  /** Grab the mouse for play, unless a menu (e.g. the team screen on join) needs the cursor. */
  focus() { if (!this.anyOverlay()) this.input.lock(); }

  private closeOverlay(lock = true) {
    this.overlay?.remove();
    this.overlay = null;
    if (lock) this.input.lock();
  }

  private setOverlay(el: HTMLElement) {
    this.overlay?.remove();
    this.overlay = el;
    this.overlayRoot.append(el);
    this.input.unlock();
  }

  openClassMenu() {
    const me = this.session.players.get(this.session.myId);
    if (MODES[this.mode].teams && (me?.team ?? 255) === 255 && !this.teamChosen) { this.openTeamMenu(); return; }
    this.setOverlay(classMenu(this.mode, me?.team ?? 255,
      (t) => { if (t === -2) { this.openTeamMenu(); return; } this.session.send({ t: 'team', team: t }); if (t === 255) this.closeOverlay(); },
      // The server applies the new loadout at an inventory station or on respawn and confirms with 'spawned'.
      (cls, lo) => {
        settings.lastClass = cls; saveSettings();
        this.session.send({ t: 'class', cls, loadout: lo, spawn: true });
        if ((me?.team ?? 255) === 255 && !this.teamChosen) this.session.send({ t: 'team', team: -1, spawn: true });
        this.spawnQueued = true;
        this.closeOverlay();
      },
      () => this.closeOverlay(),
      // Skin and voice changes apply at once for everyone (the server rebroadcasts the player list).
      () => this.session.send({ t: 'cosmetics', cosmetics: settings.cosmetics })));
  }

  private teamChosen = false;
  openTeamMenu() {
    const me = this.session.players.get(this.session.myId);
    const roster = () => [...this.session.players.values()].map((p) => ({ name: p.name, team: p.team, bot: p.bot, score: p.score }));
    this.setOverlay(teamMenu(this.mode, me?.team ?? 255, roster, (t) => {
      // TA drops you in with your current class once you pick a side; the class menu stays on its key.
      this.session.send({ t: 'team', team: t, spawn: t !== 255 });
      if (t !== 255) { this.teamChosen = true; this.spawnQueued = true; }
      this.closeOverlay();
    }, () => this.openClassMenu()));
  }

  /** Dead (not spectating): a click respawns. */
  private dead(): boolean {
    const me = this.meSnap();
    return !!me && !(me.flags & (PF.ALIVE | PF.SPECTATOR)) && me.team !== 255;
  }

  private spawnPulseUntil = 0;
  private spawnQueued = false;
  /** Respawn as soon as the timer allows: one FIRE press, latched by the server (sent once we are dead and on a team). */
  private queueSpawn() { this.spawnPulseUntil = performance.now() + 4000; }

  private openChat(team: boolean) {
    const inp = h('input', { type: 'text', maxLength: 200, placeholder: team ? 'Team chat  ·  /g global  ·  /w name msg  ·  /r reply' : 'All chat  ·  /g global  ·  /w name msg  ·  /r reply', style: 'width:100%' }) as HTMLInputElement;
    this.hud.chat.append(inp);
    this.hud.chat.classList.add('open');
    this.chatInput = inp;
    this.input.unlock();
    setTimeout(() => inp.focus(), 0);
    const close = () => { inp.remove(); this.chatInput = null; this.hud.chat.classList.remove('open'); this.input.lock(); };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const text = inp.value.trim(); if (text) this.sendChat(text, team); close(); }
      else if (e.key === 'Escape') close();
    });
  }

  private lastDm = '';
  private stats = new StatsRecorder();
  private socialOff: (() => void) | null = null;
  private lockOff: (() => void) | null = null;
  private escOpenedAt = 0;

  openEscMenu() {
    if (this.overlay || this.chatInput || this.disposed) return;
    this.vgs.close();
    this.escOpenedAt = performance.now();
    this.setOverlay(escMenu({
      resume: () => this.closeOverlay(), cls: () => this.openClassMenu(), settings: () => { this.closeOverlay(false); this.hooks.openSettings(); },
      disconnect: () => this.hooks.leave(), admin: () => {
        const pw = prompt('Admin password'); if (!pw) return;
        const cmd = prompt('Command (map <id> | kick <name> | bots <n> | end)') ?? '';
        const [c, ...rest] = cmd.split(' ');
        this.session.send({ t: 'admin', password: pw, cmd: c, arg: rest.join(' ') });
      },
    }, this.session.server.name, this.transportLabel()));
  }
  private sendChat(text: string, team: boolean) {
    const cmd = /^\/(g|w|r)\s+(.*)$/i.exec(text);
    if (!cmd) { this.session.send({ t: 'chat', text: text.slice(0, 160), team }); return; }
    const kind = cmd[1].toLowerCase();
    if (kind === 'g') { social.say(cmd[2]); return; }
    let to = this.lastDm, body = cmd[2];
    if (kind === 'w') {
      const lower = body.toLowerCase();
      const p = [...social.online].sort((a, b) => b.name.length - a.name.length).find((o) => lower.startsWith(`${o.name.toLowerCase()} `));
      if (!p) { this.hud.socialLine('system', '', 'No online player with that name. Usage: /w name message'); return; }
      to = p.id; body = body.slice(p.name.length + 1);
    }
    if (!to) { this.hud.socialLine('system', '', 'Nobody to reply to yet.'); return; }
    this.lastDm = to;
    social.dm(to, body);
  }

  private onSocial = (m: ChatMsg) => {
    if (m.kind === 'dm') {
      if (!m.mine) this.lastDm = m.from;
      this.hud.socialLine('dm', m.mine ? `To ${social.nameOf(m.to ?? '')}` : m.name, m.text);
    } else if (m.kind === 'global') this.hud.socialLine('global', m.name, m.text);
    else if (m.kind === 'system') this.hud.socialLine('system', '', m.text);
  };

  private handleActions() {
    const i = this.input;
    if (this.chatInput) return;
    if (i.pressed('menu') && !this.overlay) { this.openEscMenu(); return; }
    if (this.overlay) return;
    // Clicks while dead are latched so a quick tap between sim ticks still respawns.
    if (i.pressed('fire') && this.dead()) this.queueSpawn();
    if (i.pressed('classes') || i.pressed('quickClasses')) { this.openClassMenu(); return; }
    if (i.pressed('teamSelect')) { this.openTeamMenu(); return; }
    if (i.pressed('talk')) { this.openChat(false); return; }
    if (i.pressed('teamTalk') || i.pressed('reply')) { this.openChat(true); return; }
    if (i.pressed('vgs')) { this.vgs.open(); return; }
    if (i.pressed('suicide')) this.session.send({ t: 'suicide' });
    if (i.pressed('netStats')) { settings.showNetStats = !settings.showNetStats; saveSettings(); }
    if (i.pressed('behindView')) this.thirdPerson = !this.thirdPerson;
    if (i.pressed('objectMarkers')) this.showMarkers = !this.showMarkers;
    if (i.pressed('overheadMap')) this.minimap.toggleBig();
    if (i.pressed('voteYes')) this.session.send({ t: 'vote', yes: true });
    if (i.pressed('voteNo')) this.session.send({ t: 'vote', yes: false });
    if (i.pressed('weapon1')) this.selectSlot(0);
    if (i.pressed('weapon2')) this.selectSlot(1);
    if (i.pressed('lastWeapon') || i.pressed('weaponPrev') || i.pressed('weaponNext')) this.selectSlot(1 - this.slot);
    (['seat1', 'seat2', 'seat3', 'seat4'] as const).forEach((a, k) => { if (i.pressed(a)) this.session.send({ t: 'seat', seat: k }); });
    (['callIn1', 'callIn2', 'callIn3'] as const).forEach((a, k) => { if (i.pressed(a)) this.callIn(['tactical_strike', 'supply_drop', 'orbital_strike'][k]); });
    for (let k = 1; k <= 9; k++) {
      if (i.pressed(`class${k}` as 'class1')) {
        const c = CLASSES[k - 1];
        this.cls = c.id; this.loadout = settings.loadouts[c.id]; settings.lastClass = c.id; saveSettings();
        this.session.send({ t: 'class', cls: c.id, loadout: this.loadout });
        this.hud.toast(`${c.name} selected — applies at an inventory station or on respawn`);
      }
    }
    if (settings.toggleZoom && i.pressed('zoom')) this.zoomToggled = !this.zoomToggled;
    this.handleSpectatorKeys();
  }

  private selectSlot(s: number) {
    if (s === this.slot) return;
    this.lastSlot = this.slot;
    this.slot = s;
    audio.play('click');
  }

  private callIn(kind: string) {
    const cam = this.r.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const from = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
    const hit = this.world.raycast(from, { x: from.x + dir.x * 900, y: from.y + dir.y * 900, z: from.z + dir.z * 900 });
    if (!hit) { this.hud.toast('No target'); return; }
    this.session.send({ t: 'callin', kind, target: hit.point });
  }

  // ------------------------------------------------------------------ main loop
  private frame(t: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((n) => this.frame(n));
    if (this.lastRaf) this.displayPeriod = Math.min(50, Math.max(4, this.displayPeriod * 0.9 + (t - this.lastRaf) * 0.1));
    this.lastRaf = t;
    if (settings.maxFps > 0 && t - this.lastFrameTime < 1000 / settings.maxFps - 0.5) {
      // Frame generation presents an interpolated frame on the ticks the frame-rate limit skips,
      // so the display updates at the monitor refresh rate while the scene renders at the capped rate.
      if (this.r.wantsGeneratedFrame && t - this.lastFrameTime >= this.displayPeriod * 0.9) {
        this.r.render();
        this.lastFrameTime = t;
      }
      return;
    }
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.lastFrameTime = t;
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05;
    this.updateAdaptive();
    this.input.pollGamepad(dt);
    this.handleActions();
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 8) { this.fixedTick(); this.acc -= DT; steps++; }
    if (this.acc > DT * 8) this.acc = 0;
    this.render(dt);
    this.updateMusic(t);
    this.input.endFrame();
  }

  /**
   * Hold the frame-rate target by trimming render resolution below the display's own scale.
   * The controller only moves after a sustained trend, so brief hitches never change quality.
   */
  private updateAdaptive() {
    if (!settings.adaptiveResolution) {
      if (this.adapt.scale !== 1) { this.adapt = initialAdaptiveState(1); this.r.setAdaptiveScale(1); }
      return;
    }
    // The frame gate caps measured fps a hair above the frame-rate limit, so aiming at the
    // cap itself would let the controller ratchet down but never climb back. Target below it.
    const cap = settings.maxFps > 0 ? Math.min(settings.maxFps, 120) : 0;
    const target = cap > 0 ? Math.max(20, Math.round(cap * 0.9)) : ADAPTIVE_RULE.target;
    const rule = target === ADAPTIVE_RULE.target ? ADAPTIVE_RULE : { ...ADAPTIVE_RULE, target };
    this.adapt = adaptiveStep(this.adapt, this.fps, renderCeiling(), rule);
    this.r.setAdaptiveScale(this.adapt.scale);
  }

  private combatUntil = 0;
  private nextMusicCheck = 0;
  /** Original dynamic score: calm loop, combat loop after recent fighting, high-intensity loop while carrying the flag. */
  private updateMusic(t: number) {
    if (t < this.nextMusicCheck) return;
    this.nextMusicCheck = t + 1000;
    if (this.phase === PHASE.POSTGAME) return;
    audio.music(this.pred.hasFlag ? 'loop_high' : t < this.combatUntil ? 'loop_med' : 'loop_low', 3);
  }

  private meSnap(): PlayerSnap | undefined {
    return this.session.latest?.players.find((p) => p.id === this.session.myId);
  }

  private fixedTick() {
    const i = this.input;
    const blocked = this.anyOverlay() || this.vgs.isOpen;
    const me = this.meSnap();
    const spectating = !me || (me.flags & PF.SPECTATOR) !== 0 || me.team === 255;
    const held = (a: Parameters<Input['held']>[0]) => !blocked && i.held(a);
    const mv = blocked ? { fwd: 0, strafe: 0 } : i.moveAxes();
    const zoom = settings.toggleZoom ? this.zoomToggled : held('zoom');
    const def = ITEMS[this.slot === 0 ? this.loadout.primary : this.loadout.secondary];
    let b = 0;
    if (held('jet')) b |= BTN.JET;
    if (held('ski')) b |= BTN.SKI;
    if (held('jump')) b |= BTN.JUMP;
    if (held('fire')) b |= BTN.FIRE;
    if (held('melee')) b |= BTN.MELEE;
    if (held('belt') || (!blocked && i.pressed('weapon3'))) b |= BTN.BELT;
    if (held('pack') || (!blocked && i.pressed('weapon4'))) b |= BTN.PACK;
    if (held('use')) b |= BTN.USE;
    if (held('reload')) b |= BTN.RELOAD;
    if (held('dropFlag')) b |= BTN.DROP_FLAG;
    if (held('spot')) b |= BTN.SPOT;
    if (zoom) b |= def?.projectile?.remote ? BTN.ALT : BTN.ZOOM;
    this.input.zoomScale = zoom && def?.zoom ? def.zoom : 1;
    if (spectating) { this.specMove(DT, mv); return; }
    if (this.spawnPulseUntil && this.dead()) {
      if (performance.now() < this.spawnPulseUntil) { b |= BTN.FIRE; this.spawnQueued = true; }
      this.spawnPulseUntil = 0;
    }
    const cmd = this.pred.step({ seq: 0, fwd: mv.fwd, strafe: mv.strafe, yaw: i.yaw, pitch: i.pitch, buttons: b, weapon: this.slot });
    this.cmdHistory.push(cmd);
    if (this.cmdHistory.length > 4) this.cmdHistory.shift();
    this.session.sendInputs(this.cmdHistory.slice(-3));
    this.localFireFx(b, def);
  }

  private localFireFx(buttons: number, def: typeof ITEMS[string] | undefined) {
    const self = this.session.latest?.self;
    if (!def || !self || !this.pred.alive || ((this.meSnap()?.flags ?? 0) & PF.IN_VEHICLE)) return;
    const now = performance.now() / 1000;
    const clip = self.ammo[this.slot]?.[0] ?? 0;
    if (def.kind === 'repair') {
      // The beam is server-side; the tool's own Fire clip loops while the trigger is held.
      const on = (buttons & BTN.FIRE) !== 0;
      if (on !== this.repairFiring) { this.repairFiring = on; this.fp?.player.play(on ? 'Fire' : 'Idle', true, 0.08); }
      return;
    }
    if ((buttons & BTN.FIRE) && now >= this.nextFireLocal && clip > 0 && self.reload === 0 && (!def.spinup || self.spin >= 0.99)) {
      this.nextFireLocal = now + def.refire;
      audio.fire(this.session.myId, def.id);
      this.recoil = Math.min(1, this.recoil + (def.projectile ? 0.8 : 0.35) * (this.fp ? 0.35 : 1));
      this.fp?.player.play('Fire', false, 0.04);
    }
  }

  // ------------------------------------------------------------------ spectator
  private handleSpectatorKeys() {
    const me = this.meSnap();
    if (me && !(me.flags & PF.SPECTATOR) && me.team !== 255) return;
    const snap = this.session.latest;
    if (!snap) return;
    const list = snap.players.filter((p) => p.flags & PF.ALIVE);
    const i = this.input;
    const cycle = (d: number) => {
      if (!list.length) return;
      const idx = list.findIndex((p) => p.id === this.spec.target);
      this.spec.target = list[(idx + d + list.length) % list.length].id;
      this.spec.free = false;
    };
    if (i.pressed('fire')) cycle(1);
    if (i.pressed('jet')) cycle(-1);
    if (i.pressed('freeCam')) { this.spec.free = true; this.spec.target = -1; }
    if (i.pressed('weaponPrev')) this.spec.speed = Math.min(400, this.spec.speed + 20);
    if (i.pressed('weaponNext')) this.spec.speed = Math.max(10, this.spec.speed - 20);
    const jumpTo = (p: Vec3) => { this.spec.free = true; this.spec.pos.set(p.x, p.y + 25, p.z + 35); this.spec.pitch = -0.5; this.spec.yaw = 0; };
    const pick = <T extends { pos: Vec3 }>(arr: T[]) => { if (arr.length) jumpTo(arr[Math.floor(performance.now() / 1000) % arr.length].pos); };
    if (i.pressed('use')) pick(snap.assets.filter((a) => ASSET_TYPES[a.type] === 'generator'));
    if (i.pressed('belt')) pick(snap.flags);
    if (i.pressed('pack')) pick(this.map.entities.filter((e) => e.kind === 'flag_stand'));
    if (i.pressed('vgs')) pick(snap.vehicles);
    if (i.pressed('reload')) {
      const fastest = [...list].sort((a, b) => Math.hypot(b.vel.x, b.vel.z) - Math.hypot(a.vel.x, a.vel.z))[0];
      if (fastest) { this.spec.target = fastest.id; this.spec.free = false; }
    }
  }

  private specMove(dt: number, mv: { fwd: number; strafe: number }) {
    if (!this.spec.free) return;
    const i = this.input;
    this.spec.yaw = i.yaw; this.spec.pitch = i.pitch;
    const f = dirFromAngles(i.yaw, i.pitch);
    const r = { x: Math.cos(i.yaw), z: -Math.sin(i.yaw) };
    const up = (i.held('melee') ? 1 : 0) - (i.held('lastWeapon') ? 1 : 0);
    const s = this.spec.speed * dt;
    this.spec.pos.x += (f.x * mv.fwd + r.x * mv.strafe) * s;
    this.spec.pos.y += (f.y * mv.fwd + up) * s;
    this.spec.pos.z += (f.z * mv.fwd + r.z * mv.strafe) * s;
  }

  // ------------------------------------------------------------------ network
  private onSnapshot(s: Snapshot) {
    const me = s.players.find((p) => p.id === this.session.myId);
    if (me && s.self) {
      this.pred.team = me.team;
      const wasAlive = this.pred.alive;
      this.pred.reconcile(me, s.self, performance.now() / 1000);
      if (!wasAlive && this.pred.alive) { audio.play('spawn'); this.deathPos = null; }
      if (wasAlive && !this.pred.alive && !(me.flags & PF.IN_VEHICLE)) this.deathPos = { ...me.pos };
      const clip = s.self.ammo[this.slot]?.[0] ?? 0;
      this.prevClip = clip;
      if (s.self.slot !== this.slot && performance.now() / 1000 > this.nextFireLocal + 1) { /* server authoritative slot catches up via our input */ }
    }
    this.phase = s.phase;
    this.timeLeft = s.timeLeft;
    this.timeRef = performance.now() / 1000;
    this.scores = s.scores;
    // Mirror deployable collision for prediction.
    const seen = new Set<number>();
    for (const a of s.assets) {
      const def = ASSETS[ASSET_TYPES[a.type]];
      if (!def?.solid || (a.owner === 255 && !def.mass)) continue;
      seen.add(a.id);
      let box = this.world.dynamic.get(a.id);
      if (!box) {
        box = makeOBB({ x: a.pos.x, y: a.pos.y + def.size[1], z: a.pos.z }, [...def.size], a.yaw);
        if (def.type === 'force_field') box.passTeam = a.team;
        this.world.dynamic.set(a.id, box);
      }
      if (def.type === 'force_field') box.noCollide = (a.flags & AF.POWERED) === 0;
    }
    for (const id of [...this.world.dynamic.keys()]) if (!seen.has(id)) this.world.dynamic.delete(id);
    // Map force fields (TA team blockers, SunStar's flag shields) stand while the generator powering them does.
    if (this.map.blockers) {
      const gens = s.assets.filter((a) => ASSET_TYPES[a.type] === 'generator');
      const up = [0, 1].map((t) => { const g = gens.filter((a) => a.team === t); return !g.length || g.some((a) => (a.flags & AF.DESTROYED) === 0); });
      this.map.blockers.forEach((b, i) => {
        const on = b.gate === undefined || !!up[b.gate];
        const f = this.world.blockers[i];
        if (f) f.off = !on;
        this.view.setBlockerUp(i, on);
      });
    }
  }

  private pinfo(id: number) { return this.session.players.get(id); }

  private onJson(m: S2C) {
    const myTeam = this.pinfo(this.session.myId)?.team ?? 255;
    switch (m.t) {
      case 'kill': {
        const snaps = this.session.latest?.players;
        const kp = m.killer !== m.victim ? snaps?.find((p) => p.id === m.killer) : undefined;
        const vp0 = snaps?.find((p) => p.id === m.victim);
        const shotDist = kp && vp0
          ? Math.hypot(kp.pos.x - vp0.pos.x, kp.pos.y - vp0.pos.y, kp.pos.z - vp0.pos.z)
          : undefined;
        this.hud.killFeed(this.pinfo(m.killer), this.pinfo(m.victim), m.item, m.assist !== undefined ? this.pinfo(m.assist) : undefined, m.headshot, shotDist);
        if (m.killer === this.session.myId && m.victim !== m.killer) {
          audio.play('kill'); this.combatUntil = performance.now() + 12000;
          const snaps = this.session.latest?.players;
          const victim = snaps?.find((p) => p.id === m.victim), mine = snaps?.find((p) => p.id === this.session.myId);
          const kind = m.item === 'melee' ? 'melee' : m.item === 'vehicle_crash' ? 'roadkill' : /strike|supply_drop/.test(m.item) ? 'callin' : ITEMS[m.item]?.slot === 'belt' ? 'belt' : 'other';
          this.stats.kill(kind, !!victim && !(victim.flags & PF.ON_GROUND) && !!ITEMS[m.item]?.projectile, !!mine && !!(mine.flags & PF.IN_VEHICLE));
        }
        if (m.victim === this.session.myId) { audio.play('hurt'); audio.sting('death'); this.stats.death(); }
        else {
          const vp = this.session.latest?.players.find((p) => p.id === m.victim);
          if (vp) audio.playKey('death', vp.pos, 0.8);
        }
        if (m.assist === this.session.myId) this.stats.assist();
        break;
      }
      case 'medal': {
        // Only the earner sees their own ribbon; a feed of everyone's medals is spam.
        if (m.player !== this.session.myId) break;
        this.hud.medal(m.id, this.pinfo(m.player)?.team ?? 255, true);
        audio.play(MEDALS[m.id]?.tier === 'big' ? 'flag_cap' : 'blueplate');
        break;
      }
      case 'chat': this.hud.chatLine(this.pinfo(m.from), m.name, m.text, m.team, false, m.bot); break;
      case 'vgs': {
        const leaf = VGS_BY_ID[m.id];
        if (leaf) { this.hud.chatLine(this.pinfo(m.from), m.name, leaf.text, m.team, true, m.bot); void audio.vgs(m.id, m.voice, m.from); }
        break;
      }
      case 'event': this.onEvent(m.kind, m.text, m.team, myTeam, m.player); break;
      case 'fx': this.onFx(m); break;
      case 'hit': this.hud.hit(!!m.blueplate); audio.play(m.blueplate ? 'blueplate' : 'hit'); this.combatUntil = performance.now() + 12000; break;
      case 'damaged': {
        this.combatUntil = performance.now() + 12000;
        const me = this.pred.state.pos;
        const ang = Math.atan2(m.from.x - me.x, m.from.z - me.z) - (this.input.yaw + Math.PI);
        this.hud.damaged(-ang);
        break;
      }
      case 'match':
        this.phase = m.phase; this.timeLeft = m.timeLeft; this.timeRef = performance.now() / 1000; this.scores = m.scores;
        if (m.phase === PHASE.POSTGAME && m.winner !== undefined) {
          const w = m.winner;
          this.hud.announce(MODES[this.mode].teams ? (w < 0 ? 'Draw' : `${TEAM_NAMES[w]} wins`) : `${this.pinfo(w)?.name ?? 'Nobody'} wins`, w >= 0 && w <= 1 ? `#${teamColor(w).toString(16).padStart(6, '0')}` : '#fff');
          this.scoreEl ??= this.buildScoreboard();
          const won = MODES[this.mode].teams ? w === myTeam : w === this.session.myId;
          this.stats.matchEnd(won);
          audio.music(null, 1.5);
          audio.sting(won ? 'victory' : 'defeat');
        }
        break;
      case 'spawned':
        this.cls = m.cls; this.loadout = m.loadout; this.pred.setLoadout(m.cls, m.loadout);
        if (m.yaw !== undefined) { this.input.yaw = m.yaw; this.input.pitch = 0; this.slot = 0; }
        break;
      case 'toast': this.hud.toast(m.text); break;
      case 'vote': this.hud.toast(`Vote ${m.kind} ${m.arg}: ${m.yes} yes / ${m.no} no (F5 no, F6 yes) · ${m.endsIn}s`); break;
      case 'mapvote':
        this.voteEl?.remove();
        this.voteEl = mapVote(m.options, (id) => this.session.send({ t: 'callvote', kind: 'map', arg: id }));
        this.overlayRoot.append(this.voteEl);
        this.input.unlock();
        break;
      case 'error': this.hud.toast(m.msg); break;
    }
  }

  private onEvent(kind: string, text: string, team: number | undefined, myTeam: number, player?: number) {
    const col = team === 0 ? '#ff8a78' : team === 1 ? '#7cb8ff' : '#fff';
    if (MODES[this.mode].teams && /^flag_(grab|cap|return|drop)$/.test(kind) && team !== undefined && team <= 1) {
      // Match announcer (original voice lines when imported). Flag events carry the flag team, captures the capper team.
      const verb = kind.slice(5);
      const mine = player === this.session.myId;
      const ours = verb === 'cap' ? team === myTeam : team !== myTeam;
      const key = mine ? `flag_${verb}_you` : verb === 'return' ? `flag_return_${team === myTeam ? 'ours' : 'theirs'}` : `flag_${verb}_${ours ? 'ours' : 'theirs'}`;
      void audio.announcer(key);
      if (mine && verb !== 'drop') this.stats.flag(verb as 'cap' | 'return' | 'grab', Math.hypot(this.pred.state.vel.x, this.pred.state.vel.y, this.pred.state.vel.z) * 3.6);
      // TA's CTF stingers play for every grab, capture and return, whichever team.
      if (verb === 'cap') audio.sting('sting_capture');
      else if (verb === 'grab') audio.sting('sting_grab');
      else if (verb === 'return') audio.sting('sting_return');
    }
    const stung = settings.musicVolume > 0 && audio.hasMusic('sting_grab');
    switch (kind) {
      case 'flag_grab': if (!stung) audio.play(team === myTeam ? 'denied' : 'flag_grab'); this.hud.announce(text, col); break;
      case 'flag_cap': if (!stung) audio.play('flag_cap'); this.hud.announce(text, col); break;
      case 'flag_return': if (!stung) audio.play('flag_return'); this.hud.toast(text); break;
      case 'flag_drop': audio.play('flag_drop'); this.hud.toast(text); break;
      case 'gen_down': audio.play('gen_down'); this.hud.announce(text, col); break;
      case 'match_start': audio.play('match_start'); this.hud.announce(text); break;
      case 'vehicle_menu': this.setOverlay(vehicleMenu(this.session.latest?.self?.credits ?? 0, (v) => { this.session.send({ t: 'buyvehicle', vehicle: v }); this.closeOverlay(); }, () => this.closeOverlay())); break;
      case 'round_end': this.hud.announce(text, col); break;
      case 'medal_broadcast': this.hud.announce(text, '#ffd166'); break;
      default: this.hud.toast(text);
    }
  }

  /** Where a shot's effect starts: our camera's gun or the rendered body, not the server's slightly older position (visible while strafing). */
  private muzzleFor(m: Extract<S2C, { t: 'fx' }>): Vec3 {
    if (m.player === undefined || (m.item ?? '').startsWith('veh_')) return m.pos;
    if (m.player === this.session.myId && !this.thirdPerson) {
      const q = this.r.camera.quaternion, p = this.r.camera.position;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), r = new THREE.Vector3(1, 0, 0).applyQuaternion(q), u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      return { x: p.x + f.x * 0.8 + r.x * 0.22 - u.x * 0.2, y: p.y + f.y * 0.8 + r.y * 0.22 - u.y * 0.2, z: p.z + f.z * 0.8 + r.z * 0.22 - u.z * 0.2 };
    }
    const v = this.players.get(m.player), sp = this.session.latest?.players.find((p) => p.id === m.player);
    if (!v || !sp) return m.pos;
    const rp = v.model.root.position;
    return { x: rp.x + (m.pos.x - sp.pos.x), y: rp.y + (m.pos.y - sp.pos.y), z: rp.z + (m.pos.z - sp.pos.z) };
  }

  private onFx(m: Extract<S2C, { t: 'fx' }>) {
    const item = m.item ?? '';
    if ((m.kind === 'fire' || m.kind === 'tracer' || m.kind === 'repair') && m.player !== undefined) this.players.get(m.player)?.model.fire();
    switch (m.kind) {
      case 'explode': {
        const def = projDef(item);
        if (!this.fx.taExplosion(item, m.pos, m.radius ?? 4)) this.fx.explosion(m.pos, Math.max(2, (m.radius ?? 4) * 0.6), def?.color ?? 0xffa040);
        audio.playExplosion(item, m.pos, Math.min(1.4, (m.radius ?? 5) / 6));
        break;
      }
      case 'impact': {
        // Vehicle crash / run-over: loudness scales with the impact severity the server reported.
        const vol = Math.min(1.1, Math.max(0.25, (m.radius ?? 1) * 0.45));
        if (!audio.playKey(item === 'rollover' ? 'rollover' : 'impact', m.pos, vol)) audio.play('hurt', m.pos, vol);
        // Scrape the ground where the vehicle slammed; a rollover leaves a wider mark.
        this.fx.decal(m.pos, { x: 0, y: 1, z: 0 }, item === 'rollover' ? 1.6 : Math.min(3, 0.6 + (m.radius ?? 1) * 0.7), 0x1f1811, 9);
        break;
      }
      case 'fractal':
        this.fx.fractalShot(item, m.pos, m.to ?? m.pos);
        if (!audio.playKey('fractal_shot', m.pos, 0.7)) audio.playExplosion(item, m.to ?? m.pos, 0.4);
        break;
      case 'tracer': {
        this.fx.tracer(this.muzzleFor(m), m.to ?? m.pos, item === 'light_turret' ? 0xff8060 : 0xfff0a0);
        const owner = m.player ?? -1;
        if (m.player !== this.session.myId || item.startsWith('veh_')) audio.fire(owner, item, m.pos, 0.6);
        if (m.to) audio.impact(owner, m.to);
        break;
      }
      case 'lance': this.fx.beam(this.muzzleFor(m), m.to ?? m.pos, 0x9fe8ff, 0.15, 0.05); if (m.player !== this.session.myId) audio.play('lance', m.pos); break;
      case 'fire':
        // Vehicle and turret shots are not predicted locally, so their sound comes from here for everyone.
        if (m.player !== this.session.myId || item.startsWith('veh_')) audio.fire(m.player ?? -2, item, m.pos);
        if (m.player !== this.session.myId) this.fx.muzzle(this.muzzleFor(m), projDef(item)?.color ?? 0xffd890);
        break;
      case 'melee': audio.play('melee', m.pos); break;
      case 'repair': this.fx.beam(this.muzzleFor(m), m.to ?? m.pos, 0x60ff90, 0.12, 0.03); if (Math.random() < 0.3) audio.play('repair', m.pos, 0.5); break;
      case 'deploy': {
        const key = /claymore/.test(item) ? 'claymore' : /^(motion_)?mine$/.test(item) ? 'mine' : item;
        if (!audio.playKey(`deploy_${key}`, m.pos)) audio.play('deploy', m.pos);
        break;
      }
      case 'station': if (!audio.playKey('inv_station', m.pos)) audio.play('spawn', m.pos); break;
      case 'jump': if (!(item === 'thrust_pack' && audio.playKey('thrust', m.pos))) audio.play('jump', m.pos); break;
      case 'strike_warn':
        this.strikes.push({ pos: m.pos, until: performance.now() / 1000 + 6, kind: item });
        if (!audio.playKey(`alarm_${item === 'orbital_strike' ? item : 'tactical_strike'}`, m.pos, 1.2)) audio.play('strike_warn', m.pos, 1.2);
        break;
      case 'strike':
        this.fx.explosion(m.pos, (m.radius ?? 10) * 0.8, 0xffe0a0);
        this.fx.beam({ ...m.pos, y: m.pos.y + 400 }, m.pos, 0xfff0c0, 0.8, (m.radius ?? 10) * 0.2);
        if (!audio.playKey(`boom_${item}`, m.pos, 2)) audio.play('explode', m.pos, 2);
        break;
    }
  }

  // ------------------------------------------------------------------ rendering
  private interpolatedPlayers(): { p: PlayerSnap; pos: Vec3; yaw: number; pitch: number }[] {
    const t = this.session.serverNow() - INTERP;
    const br = this.session.bracket(t);
    if (!br) return [];
    const out: { p: PlayerSnap; pos: Vec3; yaw: number; pitch: number }[] = [];
    const prev = new Map(br.a.snap.players.map((p) => [p.id, p]));
    for (const b of br.b.snap.players) {
      let a = prev.get(b.id) ?? b;
      // A respawn (or any teleport) must not be interpolated: the body would slide from the death spot through the terrain.
      if (!(a.flags & PF.ALIVE) || ((a.flags ^ b.flags) & PF.IN_VEHICLE) || Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z) > 40) a = b;
      const k = br.k;
      const pos = k <= 1
        ? { x: a.pos.x + (b.pos.x - a.pos.x) * k, y: a.pos.y + (b.pos.y - a.pos.y) * k, z: a.pos.z + (b.pos.z - a.pos.z) * k }
        : { x: b.pos.x + b.vel.x * (k - 1) * DT * 2, y: b.pos.y + b.vel.y * (k - 1) * DT * 2, z: b.pos.z + b.vel.z * (k - 1) * DT * 2 };
      let dy = b.yaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      out.push({ p: b, pos, yaw: a.yaw + dy * Math.min(1, k), pitch: a.pitch + (b.pitch - a.pitch) * Math.min(1, k) });
    }
    return out;
  }

  /** Poses an in-vehicle player (driver or passenger) at their seat on the vehicle. */
  private placeRider(v: VehicleModel, p: PlayerSnap, yaw: number, seen: Set<number>, dt: number) {
    const isMe = p.id === this.session.myId;
    const info = this.pinfo(p.id);
    const cosKey = JSON.stringify(info?.cosmetics ?? {});
    const clsId = CLASSES[p.cls]?.id ?? this.cls;
    const jetStyle = jetStyleFor(settings.jetStyles, clsId);
    let view = this.players.get(p.id);
    if (!view || view.cls !== p.cls || view.team !== p.team || view.cosKey !== cosKey || view.jetStyle !== jetStyle) {
      if (view) { this.r.scene.remove(view.model.root); view.model.dispose(); }
      view = { model: new PlayerModel(p.cls, p.team, info?.cosmetics ?? settings.cosmetics, jetStyle), cls: p.cls, team: p.team, cosKey, jetStyle };
      this.players.set(p.id, view);
      this.r.scene.add(view.model.root);
    }
    seen.add(p.id);
    // Seat sockets live in hull space, so transform them through the vehicle root (scale and tilt included).
    v.root.updateWorldMatrix(true, false);
    view.model.root.position.copy(v.root.localToWorld(v.seatSocket(p.seat).clone()));
    // Riders face the vehicle, not their own aim; the seated pose comes from the IN_VEHICLE flag.
    view.model.update(dt, yaw, 0, p.flags | PF.IN_VEHICLE, 0, null, { x: 0, y: 0, z: 0 });
    view.model.setWeapon('');
    view.model.root.visible = !isMe || this.thirdPerson;
  }

  private render(dt: number) {
    const snap = this.session.latest;
    const myId = this.session.myId;
    const me = snap?.players.find((p) => p.id === myId);
    const cam = this.r.camera;
    const inVehicle = !!me && (me.flags & PF.IN_VEHICLE) !== 0;
    const spectating = !me || (me.flags & PF.SPECTATOR) !== 0 || me.team === 255;
    const localPos = this.pred.renderPos(dt);
    const phys = { height: this.pred.cls.armor === 'light' ? 1.85 : this.pred.cls.armor === 'medium' ? 1.95 : 2.25 };

    // --- players
    const seen = new Set<number>();
    const interp = this.interpolatedPlayers();
    for (const { p, pos, yaw, pitch } of interp) {
      if (!(p.flags & PF.ALIVE) || (p.flags & PF.IN_VEHICLE)) continue;
      const isMe = p.id === myId;
      const info = this.pinfo(p.id);
      const cosKey = JSON.stringify(info?.cosmetics ?? {});
      const clsId = CLASSES[p.cls]?.id ?? this.cls;
      const jetStyle = jetStyleFor(settings.jetStyles, clsId);
      let v = this.players.get(p.id);
      if (!v || v.cls !== p.cls || v.team !== p.team || v.cosKey !== cosKey || v.jetStyle !== jetStyle) {
        if (v) { this.r.scene.remove(v.model.root); v.model.dispose(); }
        v = { model: new PlayerModel(p.cls, p.team, info?.cosmetics ?? settings.cosmetics, jetStyle), cls: p.cls, team: p.team, cosKey, jetStyle };
        this.players.set(p.id, v);
        this.r.scene.add(v.model.root);
      }
      seen.add(p.id);
      const flagCarried = snap?.flags.find((f) => f.carrier === p.id);
      const rp = isMe ? localPos : pos;
      v.model.root.position.set(rp.x, rp.y, rp.z);
      const flags = isMe ? (p.flags & ~(PF.JETTING | PF.SKIING | PF.ON_GROUND)) | (this.pred.state.jetting ? PF.JETTING : 0) | (this.pred.state.skiing ? PF.SKIING : 0) | (this.pred.state.onGround ? PF.ON_GROUND : 0) : p.flags;
      const speed = isMe ? Math.hypot(this.pred.state.vel.x, this.pred.state.vel.z) : Math.hypot(p.vel.x, p.vel.z);
      v.model.update(dt, isMe ? this.input.yaw : yaw, isMe ? this.input.pitch : pitch, flags, speed, flagCarried ? flagCarried.team : null, isMe ? this.pred.state.vel : p.vel);
      v.model.setWeapon(isMe ? (this.slot === 1 ? this.loadout.secondary : this.loadout.primary) : ITEM_IDS[p.item] ?? '');
      v.model.root.visible = !isMe || this.thirdPerson;
      if ((flags & PF.JETTING) && jetStyle !== 'off' && Math.random() < 0.9 * settings.particles) {
        this.fx.jetPuff({ x: rp.x, y: rp.y + 1.05, z: rp.z }, isMe ? this.pred.state.vel : p.vel, teamColor(p.team), jetStyle);
      }
      if ((flags & PF.SKIING) && (flags & PF.ON_GROUND) && speed > 20 && Math.random() < 0.4) this.fx.skiSpark(rp, isMe ? this.pred.state.vel : p.vel);
    }
    for (const [id, v] of this.players) if (!seen.has(id)) { this.r.scene.remove(v.model.root); v.model.dispose(); this.players.delete(id); }

    // --- assets, flags, vehicles (latest snapshot is fine for slow objects)
    if (snap) {
      const aSeen = new Set<number>();
      for (const a of snap.assets) {
        aSeen.add(a.id);
        let v = this.assetViews.get(a.id);
        if (!v) { v = new AssetModel(a); this.assetViews.set(a.id, v); this.r.scene.add(v.root); }
        v.update(a, dt);
        this.fx.assetDamage(a.pos, a.health, (a.flags & AF.DESTROYED) !== 0, ASSET_TYPES[a.type], dt);
      }
      for (const [id, v] of this.assetViews) if (!aSeen.has(id)) { this.r.scene.remove(v.root); this.assetViews.delete(id); }
      const fSeen = new Set<number>();
      for (const f of snap.flags) {
        fSeen.add(f.id);
        let v = this.flagViews.get(f.id);
        if (!v) { v = new FlagModel(f.team); this.flagViews.set(f.id, v); this.r.scene.add(v.root); }
        v.update(f, dt);
      }
      for (const [id, v] of this.flagViews) if (!fSeen.has(id)) { this.r.scene.remove(v.root); this.flagViews.delete(id); }
      const vSeen = new Set<number>();
      const t = this.session.serverNow() - INTERP;
      const br = this.session.bracket(t);
      for (const veh of snap.vehicles) {
        vSeen.add(veh.id);
        let v = this.vehViews.get(veh.id);
        if (!v) { v = new VehicleModel(veh); this.vehViews.set(veh.id, v); this.r.scene.add(v.root); }
        const a = br?.a.snap.vehicles.find((x) => x.id === veh.id), b = br?.b.snap.vehicles.find((x) => x.id === veh.id);
        const vs = a && b && br ? { ...b, pos: { x: a.pos.x + (b.pos.x - a.pos.x) * Math.min(1, br.k), y: a.pos.y + (b.pos.y - a.pos.y) * Math.min(1, br.k), z: a.pos.z + (b.pos.z - a.pos.z) * Math.min(1, br.k) } } : veh;
        // Ease the quantized snapshot angles toward their target: raw 10 Hz angles make the bike snap.
        let ang = this.vehAngles.get(veh.id);
        if (!ang) { ang = { yaw: veh.yaw, pitch: veh.pitch, roll: veh.roll }; this.vehAngles.set(veh.id, ang); }
        const ka = 1 - Math.exp(-dt * 14);
        ang.yaw += angleWrap(vs.yaw - ang.yaw) * ka;
        ang.pitch += (vs.pitch - ang.pitch) * ka;
        ang.roll += (vs.roll - ang.roll) * ka;
        const driver = snap.players.find((p) => p.id === veh.gunner) ?? snap.players.find((p) => p.id === veh.driver);
        v.update({ ...vs, yaw: ang.yaw, pitch: ang.pitch, roll: ang.roll }, driver ? (driver.id === myId ? this.input.yaw : driver.yaw) : null);
        // The bike rides solo: its frame is too narrow for a second body to read as anything but a block.
        if (VEHICLE_TYPES[veh.type] !== 'gravcycle') {
          for (const p of snap.players) {
            if (p.vehicle !== veh.id || !(p.flags & PF.IN_VEHICLE)) continue;
            this.placeRider(v, p, ang.yaw, seen, dt);
          }
        }
      }
      for (const [id, v] of this.vehViews) if (!vSeen.has(id)) { this.r.scene.remove(v.root); this.vehViews.delete(id); this.vehAngles.delete(id); }

      // --- projectiles: remote interpolated, own extrapolated to the present
      const projT = this.session.serverNow() - INTERP;
      const pb = this.session.bracket(projT);
      const lead = this.session.rtt / 2 + INTERP;
      const localShots = this.pred.localShots;
      // Our predicted shots replace the server's copies; keep hiding those for a round trip after ours burst.
      const nowMs = performance.now();
      for (const s of localShots) this.localShotUntil.set(s.st.item, nowMs + this.session.rtt * 1000 + 200);
      const plist = snap.projectiles.filter((pr) => !(pr.owner === myId && (this.localShotUntil.get(ITEM_IDS[pr.item]) ?? 0) > nowMs)).map((pr) => {
        let pos = pr.pos;
        const def = projDef(ITEM_IDS[pr.item]);
        if (pr.owner === myId) {
          const age = (this.session.serverNow() - snap.tick / 60);
          const tt = Math.min(0.4, lead + Math.max(0, age));
          pos = { x: pr.pos.x + pr.vel.x * tt, y: pr.pos.y + pr.vel.y * tt - 0.5 * GRAVITY * this.world.gravityScale * (def?.gravity ?? 0) * tt * tt, z: pr.pos.z + pr.vel.z * tt };
        } else if (pb) {
          const a = pb.a.snap.projectiles.find((x) => x.id === pr.id), b = pb.b.snap.projectiles.find((x) => x.id === pr.id);
          if (a && b) pos = { x: a.pos.x + (b.pos.x - a.pos.x) * Math.min(1, pb.k), y: a.pos.y + (b.pos.y - a.pos.y) * Math.min(1, pb.k), z: a.pos.z + (b.pos.z - a.pos.z) * Math.min(1, pb.k) };
        }
        return { snap: pr, pos };
      });
      for (const s of localShots) plist.push({ snap: { id: s.vid, item: ITEM_INDEX[s.st.item] ?? 0, owner: myId, pos: s.st.pos, vel: s.st.vel }, pos: s.st.pos });
      this.fx.syncProjectiles(plist, dt);
    }

    // --- camera
    const yaw = this.input.yaw, pitch = this.input.pitch;
    let focus = new THREE.Vector3(localPos.x, localPos.y, localPos.z);
    const zoomDef = ITEMS[this.slot === 0 ? this.loadout.primary : this.loadout.secondary];
    const zooming = (settings.toggleZoom ? this.zoomToggled : this.input.held('zoom')) && !this.anyOverlay();
    this.r.setFov(settings.fov, zooming ? (zoomDef?.zoom ?? 0.6) : 1);
    this.viewModel.visible = !spectating && this.pred.alive && !this.thirdPerson && !inVehicle && !(zooming && zoomDef?.zoom);
    if (spectating) {
      if (!this.spec.free) {
        const tgt = interp.find((x) => x.p.id === this.spec.target);
        if (tgt) {
          const c = this.chase;
          if (c.target !== tgt.p.id) { c.target = tgt.p.id; c.yaw = tgt.yaw; c.pitch = tgt.pitch; c.pos.set(tgt.pos.x, tgt.pos.y, tgt.pos.z); }
          const ka = 1 - Math.exp(-dt * 4), kp = 1 - Math.exp(-dt * 12);
          let dy = tgt.yaw - c.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          c.yaw += dy * ka;
          c.pitch += (tgt.pitch - c.pitch) * ka;
          c.pos.lerp(new THREE.Vector3(tgt.pos.x, tgt.pos.y, tgt.pos.z), kp);
          const d = dirFromAngles(c.yaw, Math.min(0.2, c.pitch) - 0.25);
          const want = new THREE.Vector3(c.pos.x - d.x * 7, c.pos.y + 2.4 - d.y * 7, c.pos.z - d.z * 7);
          if (c.cam.distanceToSquared(want) > 400) c.cam.copy(want); else c.cam.lerp(want, kp);
          cam.position.copy(c.cam);
          cam.lookAt(c.pos.x, c.pos.y + 1.4, c.pos.z);
          focus.copy(c.pos);
        } else this.spec.free = true;
      }
      if (this.spec.free) {
        cam.position.copy(this.spec.pos);
        cam.rotation.set(this.spec.pitch, this.spec.yaw, 0, 'YXZ');
        focus = this.spec.pos.clone();
      }
    } else if (inVehicle && me) {
      const veh = snap?.vehicles.find((v) => v.id === me.vehicle);
      const vv = veh ? this.vehViews.get(veh.id) : undefined;
      const base = vv ? vv.root.position : new THREE.Vector3(me.pos.x, me.pos.y, me.pos.z);
      const size: [number, number, number] = veh ? VEHICLES[VEHICLE_TYPES[veh.type]].size : [1, 1, 1];
      // Same treatment as the on-foot chase cam: sit on the ray the vehicle's gun fires along,
      // with no vertical lift, so the screen-center crosshair and the shot agree (the old +3.5
      // lift put the view above the shot line, exactly like the +0.8 lift did on foot).
      // Beowulf mortar and gunner hitscan both aim at the mouse; gravcycle and Shrike fire along
      // the hull, so their camera follows the hull angles (which lag the mouse while turning).
      // Use the eased hull angles here too: the raw snapshot angles arrive at ~10 Hz and would
      // shake the camera in steps that the hull itself no longer shows.
      const vang = veh ? this.vehAngles.get(veh.id) : undefined;
      const ay = veh && veh.type !== 1 ? (vang?.yaw ?? veh.yaw) : yaw;
      const ap = veh && veh.type !== 1 ? (vang?.pitch ?? veh.pitch) : pitch;
      const d = dirFromAngles(ay, ap);
      // Shot origin: gunner hitscan fires from the turret eye, driver fire from the muzzle height.
      const eye = { x: base.x, y: base.y + (me.seat === 1 ? size[1] + 1 : size[1] * 0.8), z: base.z };
      const back = veh?.type === 1 ? 14 : 9;
      const hit = this.world.raycast(eye, { x: eye.x - d.x * back, y: eye.y - d.y * back, z: eye.z - d.z * back });
      let dist = hit ? Math.max(1.5, back * (hit.t - 0.05)) : back;
      // The eye sits inside the hull, so a world raycast alone would let the camera end up buried
      // in it once the lift is gone. Keep it outside the hull box: the support radius of an
      // oriented box along the view ray is its exact half-extent in that direction.
      const hull = makeOBB({ x: base.x, y: base.y + size[1], z: base.z }, size, vang?.yaw ?? veh?.yaw ?? 0, vang?.pitch ?? veh?.pitch ?? 0, vang?.roll ?? veh?.roll ?? 0);
      const ax = hull.axes;
      const r = Math.abs(d.x * ax[0] + d.y * ax[1] + d.z * ax[2]) * size[0]
        + Math.abs(d.x * ax[3] + d.y * ax[4] + d.z * ax[5]) * size[1]
        + Math.abs(d.x * ax[6] + d.y * ax[7] + d.z * ax[8]) * size[2];
      dist = Math.max(dist, r + 1.2);
      cam.position.set(eye.x - d.x * dist, eye.y - d.y * dist, eye.z - d.z * dist);
      cam.rotation.set(ap, ay, 0, 'YXZ');
      focus = base.clone();
    } else if (!this.pred.alive) {
      if (this.deathPos) {
        const c = this.deathPos;
        const t = performance.now() / 4000;
        cam.position.set(c.x + Math.cos(t) * 12, c.y + 6, c.z + Math.sin(t) * 12);
        cam.lookAt(c.x, c.y + 1, c.z);
      } else {
        // Not spawned yet: slow flyover above our base, always clear of terrain and structures.
        const o = this.introView(me?.team ?? 255);
        const t = performance.now() / 9000;
        cam.position.set(o.target.x + Math.cos(t) * o.radius, o.camY, o.target.z + Math.sin(t) * o.radius);
        cam.lookAt(o.target.x, o.target.y, o.target.z);
        focus.set(o.target.x, o.target.y, o.target.z);
      }
    } else {
      const eye = { x: localPos.x, y: localPos.y + phys.height * 0.9, z: localPos.z };
      if (this.thirdPerson) {
        const d = dirFromAngles(yaw, pitch);
        // Chase cam sits exactly ON the aim ray behind the eye: the screen-center ray then coincides
        // with the eye's aim line, so the crosshair, disc and hitscan all agree. Any vertical lift
        // here (the old +0.8) makes the view parallel to but above the aim, and shots land low.
        const hit = this.world.raycast(eye, { x: eye.x - d.x * 5, y: eye.y - d.y * 5, z: eye.z - d.z * 5 });
        // Floor the pull-in at 1.2 m: with no lift the camera rides the body axis, so closer than the
        // capsule radius (heavy is 0.7) it ends up inside our own model against a wall.
        const k = hit ? Math.max(0.24, hit.t - 0.05) : 1;
        const dist = 5 * k;
        cam.position.set(eye.x - d.x * dist, eye.y - d.y * dist, eye.z - d.z * dist);
        // Orientation comes from the aim angles, not lookAt: the view direction matches the crosshair
        // exactly (lookAt + the chase offset tilted the view ~9° off the aim), and extreme pitch no
        // longer degenerates the lookAt roll.
        cam.rotation.set(pitch, yaw, 0, 'YXZ');
      } else {
        // TA's walk shake lives on the *camera*: a footfall bob and a hair of roll. Keeping it here
        // (instead of on the viewmodel) means the weapon and its ammo readout stay steady on screen.
        // Gated to walking pace on level ground: sprinting/jetting must stay rock steady, and a slope already
        // moves the eye on its own, so shaking there reads as a view wobble rather than a footfall.
        const speed = Math.hypot(this.pred.state.vel.x, this.pred.state.vel.z);
        const flat = Math.min(1, Math.max(0, (this.pred.state.groundNormal.y - 0.85) / 0.12));
        const walkGate = Math.min(1, Math.max(0, (speed - 1.5) / 5)) * flat;
        const shake = this.pred.state.onGround && !this.pred.state.skiing ? Math.sin(performance.now() / 240) * walkGate : 0;
        // Flat-ground walking must not move the camera at all; keep a whisper of bob only on rough ground.
        const rough = 1 - flat;
        cam.position.set(eye.x, eye.y + shake * 0.018 * rough, eye.z);
        cam.rotation.set(pitch, yaw, shake * 0.0015 * rough, 'YXZ');
      }
    }
    this.recoil *= Math.exp(-dt * 10);
    // Viewmodel bob kept gentle: TA's first-person weapon drifts only a couple of pixels while walking. A
    // faster, taller sine read as a view shake, and the panel parented to the weapon bone shook with it.
    //
    // Gated to rough ground, like the camera shake above: on a flat floor the eye is steady, so any weapon
    // drift is the only motion in frame - at 5 mm and ~3 Hz that is exactly the "micro vibration when running
    // on a flat surface" report. `flat` is derived from the server's ground normal, which jitters by a few
    // hundredths even on a true plane, so the gate is squared to crush that residual.
    const walkSpeed = Math.hypot(this.pred.state.vel.x, this.pred.state.vel.z);
    const groundFlat = Math.min(1, Math.max(0, (this.pred.state.groundNormal.y - 0.985) / 0.012));
    const bobGate = Math.min(1, Math.max(0, (walkSpeed - 2.5) / 8)) * (1 - groundFlat) * (1 - groundFlat);
    const bob = this.pred.state.onGround && !this.pred.state.skiing ? Math.sin(performance.now() / 190) * bobGate * 0.004 : 0;
    this.viewModel.position.set(0, bob, this.recoil * 0.06);
    this.viewModel.rotation.x = this.recoil * 0.07;
    if (this.viewModel.visible) {
      this.syncViewModel();
      spinViewModel(this.viewModel, this.session.latest?.self?.spin ?? 0, dt);
      const self = this.session.latest?.self, fp = this.fp;
      if (fp) {
        const rl = self?.reload ?? 0;
        if (rl > 0 && this.lastReload === 0) fp.player.play('reload', false, 0.1);
        this.lastReload = rl;
        fp.update(dt);
      }
      setViewModelStealth(this.viewModel, !!me && (me.flags & PF.STEALTH) !== 0, performance.now() / 1000);
    }

    // --- audio
    const speedMs = Math.hypot(this.pred.state.vel.x, this.pred.state.vel.y, this.pred.state.vel.z);
    const alive = this.pred.alive && !spectating;
    audio.setListener({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, dirFromAngles(yaw, pitch));
    audio.setLoop('jet', alive && this.pred.state.jetting ? 0.35 : 0, 500 + speedMs * 6);
    audio.setLoop('ski', alive && this.pred.state.skiing && this.pred.state.onGround ? Math.min(0.3, speedMs / 120) : 0, 2500 + speedMs * 30);
    audio.setLoop('wind', alive ? Math.min(0.35, Math.max(0, speedMs - 15) / 150) : 0, 200 + speedMs * 8);
    audio.setLoop('spin', alive && (this.session.latest?.self?.spin ?? 0) > 0.05 ? 0.12 : 0, 900 + (this.session.latest?.self?.spin ?? 0) * 1800);
    // Landing (TA's "step" sample) only after a real fall: standing still lets ground contact flicker
    // per tick, which used to play footsteps at random while idle.
    const falling = this.pred.state.vel.y < -1.4;
    if (alive && this.pred.state.onGround && !this.wasOnGround && this.wasFalling && performance.now() - this.landSoundAt > 300) {
      audio.play('land', undefined, 0.5);
      this.landSoundAt = performance.now();
    }
    this.wasOnGround = this.pred.state.onGround;
    this.wasFalling = falling;
    // Weapon draw and reload parts (original samples).
    const wid = this.slot === 1 ? this.loadout.secondary : this.loadout.primary;
    if (alive && !inVehicle) {
      const rl = this.session.latest?.self?.reload ?? 0;
      if (rl > 0 && this.reloadSnd === 0) audio.reload(wid, ITEMS[wid]?.reload ?? rl);
      this.reloadSnd = rl;
      if (wid !== this.drawnWeapon) { if (this.drawnWeapon) audio.retrieve(wid); this.drawnWeapon = wid; }
    } else { this.reloadSnd = 0; this.drawnWeapon = ''; }
    audio.tick((snap?.vehicles ?? []).map((v) => {
      const type = VEHICLE_TYPES[v.type];
      const p = this.vehViews.get(v.id)?.root.position ?? v.pos;
      return { id: v.id, type, pos: { x: p.x, y: p.y, z: p.z }, speed: Math.hypot(v.vel.x, v.vel.y, v.vel.z), maxSpeed: VEHICLES[type]?.maxSpeed ?? 40, driven: v.driver !== 255 };
    }));

    this.view.update(cam, dt, focus);
    this.fx.update(dt, this.r.height);
    this.minimap.update(snap, { x: (spectating ? cam.position.x : localPos.x), z: (spectating ? cam.position.z : localPos.z), yaw: spectating ? this.spec.yaw : yaw, team: me?.team ?? 255, myId: this.session.myId }, performance.now());
    this.updateHud(snap, me, interp, spectating, dt);
    this.r.render();
    this.maybeCaptureShot(spectating);
  }

  private shotState: 'check' | 'want' | 'done' = 'check';
  private localShotUntil = new Map<string, number>();
  private enteredAt = performance.now();
  /** First visit to a map: grab the pre-spawn flyover (full colour) as the loading-screen picture. */
  private maybeCaptureShot(spectating: boolean) {
    if (this.shotState === 'check') {
      this.shotState = 'done';
      void getShot(shotKey(this.map.id, this.map.source)).then((b) => { if (!b) this.shotState = 'want'; });
      return;
    }
    if (this.shotState !== 'want' || spectating || this.pred.alive || this.deathPos) return;
    if (performance.now() - this.enteredAt < 4500) return;
    this.shotState = 'done';
    this.r.setSaturation(1);
    this.r.render();
    void captureCanvas(this.r.canvas).then((b) => { if (b) void putShot(shotKey(this.map.id, this.map.source), b); });
  }

  private project(p: Vec3): { x: number; y: number } | null {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.r.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.r.width, y: (-v.y * 0.5 + 0.5) * this.r.height };
  }

  private transportLabel(): string {
    return this.session.transport.kind === 'webtransport' ? 'WEBTRANSPORT · UDP' : `WEBSOCKET · TCP${this.fellBack ? ' (fallback)' : ''}`;
  }

  private buildScoreboard(): HTMLElement {
    const el = scoreboard([...this.session.players.values()], this.mode, this.session.myId, this.scores, this.session.server.name, this.transportLabel());
    this.overlayRoot.append(el);
    return el;
  }

  private updateHud(snap: Snapshot | null, me: PlayerSnap | undefined, interp: { p: PlayerSnap; pos: Vec3 }[], spectating: boolean, dt: number) {
    const self = snap?.self;
    const lo = this.loadout;
    const cam = this.r.camera.position;
    const markers: Marker[] = [];
    const plates: Plate[] = [];
    const myTeam = me?.team ?? 255;
    if (this.showMarkers && snap) {
      const rel = (t: number) => (t === myTeam ? FRIEND : t <= 1 ? ENEMY : '#dddddd');
      for (const f of snap.flags) {
        // The carrier never sees his own flag icon and name: they would sit on (and lag behind) his camera.
        if (f.state === 1 && f.carrier === this.session.myId) continue;
        const pt = this.project({ ...f.pos, y: f.pos.y + 1.5 });
        const carrier = f.carrier !== 255 ? this.pinfo(f.carrier) : undefined;
        if (pt) markers.push({ ...pt, kind: 'flag', color: rel(f.team), icon: f.state === 1 ? 'hud_items_custom_generic_flag_carried_medium' : f.state === 2 ? 'hud_items_custom_generic_flag_dropped' : 'hud_items_custom_generic_flag_post', label: f.state === 1 ? (carrier?.name ?? 'Carried') : f.state === 2 ? 'DROPPED' : '', dist: Math.hypot(f.pos.x - cam.x, f.pos.y - cam.y, f.pos.z - cam.z) });
      }
      const STATION_ICON: Record<string, string> = { inventory: 'hud_items_custom_generic_inventory', vehicle_pad: 'hud_items_custom_generic_vehicle_station', repair_station: 'hud_items_custom_generic_repair' };
      for (const a of snap.assets) {
        const type = ASSET_TYPES[a.type];
        const down = (a.flags & AF.DESTROYED) !== 0;
        const d = Math.hypot(a.pos.x - cam.x, a.pos.z - cam.z);
        let icon: string | undefined, kind: Marker['kind'] = 'asset', label = '';
        if (type === 'generator') { icon = down ? 'hud_items_custom_generic_base_generator1_down' : 'hud_items_custom_generic_base_generator1_up'; label = down ? 'GEN DOWN' : ''; }
        else if (type === 'cap_point') { kind = 'point'; label = `POINT ${this.map.entities.find((e) => e.kind === 'cap_point' && Math.hypot(e.pos.x - a.pos.x, e.pos.z - a.pos.z) < 2)?.tag ?? ''}`; }
        else if (type === 'base_turret' && d < 260) icon = down ? 'hud_items_custom_generic_base_turret1_down' : 'hud_items_custom_generic_base_turret1';
        else if (type === 'radar' && d < 260) icon = down ? 'hud_items_custom_generic_base_sensor1_down' : 'hud_items_custom_generic_base_sensor1';
        else if (STATION_ICON[type] && a.team === myTeam && d < 220) { icon = STATION_ICON[type]; kind = 'station'; }
        else continue;
        const pt = this.project({ ...a.pos, y: a.pos.y + (type === 'generator' ? 3 : 2.6) });
        if (!pt) continue;
        markers.push({ ...pt, kind, icon, color: type === 'cap_point' ? `#${teamColor(a.team).toString(16).padStart(6, '0')}` : rel(a.team), label, dist: d, hp: type === 'generator' ? a.health : undefined });
      }
      const now = performance.now() / 1000;
      this.strikes = this.strikes.filter((s) => s.until > now);
      for (const s of this.strikes) { const pt = this.project(s.pos); if (pt) markers.push({ ...pt, kind: 'strike', color: '#ff4030', label: 'INCOMING STRIKE', dist: Math.hypot(s.pos.x - cam.x, s.pos.z - cam.z) }); }
    }
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.r.camera.quaternion);
    for (const { p, pos } of interp) {
      if (p.id === this.session.myId || !(p.flags & PF.ALIVE) || (p.flags & PF.STEALTH && p.team !== myTeam)) continue;
      const head = { x: pos.x, y: pos.y + 2.5, z: pos.z };
      const d = Math.hypot(head.x - cam.x, head.y - cam.y, head.z - cam.z);
      const ally = p.team === myTeam && MODES[this.mode].teams;
      const toP = new THREE.Vector3(head.x - cam.x, head.y - cam.y, head.z - cam.z).normalize();
      const aimed = toP.dot(fwd) > 0.995;
      if (!(ally && d < 600) && !((p.flags & PF.SPOTTED) && d < 800) && !(aimed && d < 250)) continue;
      const pt = this.project(head);
      if (!pt) continue;
      const info = this.pinfo(p.id);
      plates.push({ ...pt, name: info?.name ?? `#${p.id}`, team: p.team, bot: !!(p.flags & PF.BOT) || !!info?.bot, style: info?.cosmetics.nameplate ?? 'plain' });
    }
    const w = (id: string, k: number) => ({ name: ITEMS[id]?.name ?? id, clip: self?.ammo[k]?.[0] ?? 0, ammo: self?.ammo[k]?.[1] ?? 0 });
    const curDef = ITEMS[this.slot === 0 ? lo.primary : lo.secondary];
    const kind = !curDef ? 'default' : curDef.chargeTime || curDef.zoom ? 'sniper' : curDef.projectile?.model === 'disc' ? 'disc' : curDef.projectile && curDef.projectile.gravity > 0.3 ? 'grenade' : curDef.hitscan && curDef.hitscan.pellets > 1 ? 'shotgun' : 'default';
    const flagInfo = (snap?.flags ?? []).map((f) => `${f.team <= 1 ? TEAM_NAMES[f.team].split(' ')[0].toUpperCase() : 'FLAG'}: ${f.state === 0 ? 'HOME' : f.state === 1 ? `TAKEN (${this.pinfo(f.carrier)?.name ?? '?'})` : 'DROPPED'}`);
    const specTarget = spectating ? (this.spec.free ? 'FREE CAM' : this.pinfo(this.spec.target)?.name ?? 'FREE CAM') : null;
    const state: HudState = {
      alive: (this.pred.alive || (!!me && (me.flags & PF.IN_VEHICLE) !== 0)) && !spectating, health: me?.health ?? 0, maxHealth: me?.maxHealth ?? 1, energy: self?.energy ?? this.pred.state.energy,
      maxEnergy: this.pred.params().maxEnergy, speedKmh: Math.hypot(this.pred.state.vel.x, this.pred.state.vel.y, this.pred.state.vel.z) * 3.6,
      cls: CLASSES.find((c) => c.id === this.cls)?.name ?? '', weapons: [w(lo.primary, 0), w(lo.secondary, 1)], slot: this.slot,
      belt: { name: ITEMS[lo.belt]?.name ?? '', count: self?.ammo[2]?.[0] ?? 0 }, pack: { name: ITEMS[lo.pack]?.name ?? '', active: (self?.ammo[3]?.[0] ?? 0) > 0 },
      credits: self?.credits ?? 0, reload: self?.reload ?? 0, charge: self?.charge ?? 0, spin: self?.spin ?? 0, respawn: self?.respawn ?? 0,
      scores: this.scores, timeLeft: Math.max(0, this.timeLeft - (performance.now() / 1000 - this.timeRef)), phase: this.phase, mode: this.mode,
      flagInfo, yaw: this.input.yaw, zoomed: this.input.zoomScale < 1, weaponKind: kind, spectating: specTarget, transport: this.transportLabel(),
      myScore: this.pinfo(this.session.myId)?.score,
      myTeam,
      teamFlags: [0, 1].map((t) => snap?.flags.find((f) => f.team === t)?.state ?? null),
      gens: [0, 1].map((t) => { const g = snap?.assets.filter((a) => ASSET_TYPES[a.type] === 'generator' && a.team === t) ?? []; return g.length ? g.some((a) => !(a.flags & AF.DESTROYED)) : null; }),
      armor: CLASSES.find((c) => c.id === this.cls)?.armor ?? 'light',
      waiting: this.phase === PHASE.WARMUP,
      spawnQueued: (this.spawnQueued &&= !this.pred.alive),
    };
    const net = settings.showNetStats ? [
      `transport  ${this.session.transport.kind}${this.fellBack ? ' (fallback)' : ''}`,
      `rtt        ${Math.round(this.session.rtt * 1000)} ms`,
      `fps        ${Math.round(this.fps)}`,
      `render     ${Math.round(renderCeiling() * this.adapt.scale * 100)}%${this.adapt.scale < 0.995 ? ' (adaptive)' : ''}`,
      `snapshots  ${this.session.snapsIn}`,
      `in / out   ${(this.session.bytesIn / 1024).toFixed(0)} / ${(this.session.bytesOut / 1024).toFixed(0)} KB`,
      `corrections ${this.pred.corrections}`,
      `pending    ${this.pred.pending.length}`,
    ].join('\n') : null;
    this.hud.update(state, markers, plates, net);
    this.stats.tick(dt, state.alive, state.armor, this.cls, this.mode, state.health, state.maxHealth, this.pred.state.skiing && this.pred.state.onGround, state.speedKmh);
    // Driving counts as alive (the predicted pawn is parked while in a vehicle).
    // Snapshot gaps, respawn handoffs and spectate switches can drop `me`/PF.ALIVE for a frame or two. The
    // grey-out is a *scene-wide* filter, so a one-frame dropout greys every player at once - the reported
    // "all players go black, flicker, then back". Require the dead state to hold for a beat before grading.
    const dead = !me || !(me.flags & PF.ALIVE);
    if (dead) { if (!this.deadSince) this.deadSince = performance.now(); } else { this.deadSince = 0; }
    const deadGrey = dead && performance.now() - this.deadSince > 250;
    this.r.setSaturation(spectating ? 1 : deadGrey ? 0.12 : state.waiting ? 0.2 : 1);
    if (GFX_LOG) {
      const b = this.r.brightnessState();
      const line = `${b.sat}|${b.exposure}|${b.env}|${b.sky}|${b.scale}|${b.post}|${dead}|${spectating}|${state.waiting}|${me?.flags ?? -1}`;
      if (line !== this.gfxLine) {
        this.gfxLine = line;
        console.log(`[gfx] sat=${b.sat} exposure=${b.exposure.toFixed(3)} env=${b.env.toFixed(2)} sky=${b.sky} scale=${b.scale.toFixed(3)} post=${b.post} dead=${dead} spec=${spectating} warmup=${state.waiting} flags=${me?.flags ?? -1}`);
      }
    }
    const wantScores = this.input.held('scores') && !this.anyOverlay() || this.phase === PHASE.POSTGAME;
    if (wantScores) { this.scoreEl?.remove(); this.scoreEl = this.buildScoreboard(); }
    else if (this.scoreEl) { this.scoreEl.remove(); this.scoreEl = null; }
    if (this.phase !== PHASE.POSTGAME && this.voteEl) { this.voteEl.remove(); this.voteEl = null; }
  }

  graphicsChanged() {
    this.r.configure();
    this.view.applyGraphics();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.view.onSkyEnv = null;
    this.view.dispose();
    this.r.setSkyEnvironment(null);
    this.textures?.dispose();
    this.r.scene.remove(this.fx.group);
    this.fx.clear();
    for (const v of this.players.values()) this.r.scene.remove(v.model.root);
    for (const v of this.assetViews.values()) this.r.scene.remove(v.root);
    for (const v of this.flagViews.values()) this.r.scene.remove(v.root);
    for (const v of this.vehViews.values()) this.r.scene.remove(v.root);
    this.r.camera.remove(this.viewModel);
    this.stats.flush();
    this.r.setSaturation(1);
    disposeViewModel(this.viewModel);
    this.hud.root.remove();
    this.overlayRoot.remove();
    this.vgs.el.remove();
    this.socialOff?.();
    this.lockOff?.();
    this.session.inputSeq = this.pred.seq;
    this.input.capture = null;
    this.input.clickThrough = null;
    this.input.gameActive = false;
    this.input.unlock();
    for (const l of ['jet', 'ski', 'wind', 'spin'] as const) audio.setLoop(l, 0);
    audio.stopGameplayLoops();
  }
}

export type { AssetSnap };
