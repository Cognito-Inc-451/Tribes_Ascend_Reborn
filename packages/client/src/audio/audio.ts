import { ITEMS, ORIGINAL_VOICE, VOICE_PACKS, VGS_BY_ID, type Vec3 } from '@ar/shared';
import { NODE_URL, voiceManifest } from '../net/node.js';
import { settings } from '../settings.js';

type SoundName =
  | 'disc' | 'explode' | 'bullet' | 'rifle' | 'shotgun' | 'grenade' | 'plasma' | 'mortar' | 'bolt' | 'hit' | 'blueplate' | 'kill'
  | 'flag_grab' | 'flag_cap' | 'flag_return' | 'flag_drop' | 'denied' | 'jump' | 'melee' | 'turret' | 'repair' | 'deploy'
  | 'strike_warn' | 'spawn' | 'land' | 'click' | 'lance' | 'hurt' | 'gen_down' | 'match_start';

/** Items without their own imported samples borrow a close relative's. */
const SFX_ALIAS: Record<string, string> = { blinksfusor: 'light_spinfusor', lr_repair_tool: 'repair_tool' };

/** Synth sound -> imported original sample key (weapon families borrow a representative TA weapon). */
const SAMPLE_FOR: Partial<Record<SoundName, string>> = {
  explode: 'explode', hit: 'hit', blueplate: 'blueplate', melee: 'melee', click: 'click', denied: 'denied', land: 'step', gen_down: 'gen_powerdown',
  kill: 'kill_confirm', flag_drop: 'flag_drop',
  disc: 'fire_spinfusor', bolt: 'fire_bolt_launcher', bullet: 'fire_assault_rifle', rifle: 'fire_bxt1', shotgun: 'fire_shotgun', grenade: 'throw',
  plasma: 'fire_plasma_gun', mortar: 'fire_fusion_mortar', lance: 'fire_shocklance', turret: 'fire_light_turret', repair: 'fire_repair_tool',
  deploy: 'deploy_mine', spawn: 'respawn',
};

interface FireLoop { item: string; src: AudioBufferSourceNode | null; gain: GainNode; panner: PannerNode | null; last: number; hold: number; vol: number }
interface Engine {
  type: string;
  srcs: AudioScheduledSourceNode[];
  idle: GainNode;
  fast: GainNode;
  panner: PannerNode;
}

/** Procedural WebAudio sound engine: all effects are synthesised (no game assets). */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private vgsGain!: GainNode;
  private noise!: AudioBuffer;
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }>();
  private packFiles = new Map<string, boolean>();
  private voiceCache = new Map<string, Promise<AudioBuffer | null>>();
  private voiceBases: string[] = [NODE_URL];
  private lastAnnounce = 0;
  private musicGain!: GainNode;
  private musicKeys: Set<string> | null = null;
  private wantedMusic: string | null = null;
  private track: { key: string; el: HTMLAudioElement; gain: GainNode } | null = null;
  /** Imported original sound effects: key -> number of variants. */
  private sfx: Record<string, number> = {};
  private vgsBy = new Map<number, AudioBufferSourceNode>();
  private fireLoops = new Map<number, FireLoop>();
  private lastShot = new Map<number, { item: string; at: number }>();
  private lastImpact = new Map<number, number>();
  private engines = new Map<number, Engine>();

  /** Whether an original sample was imported for `key`. */
  has(key: string): boolean { return !!this.sfx[key]; }

  /** Plays an original sample by key (random variant); false when there is none. */
  playKey(key: string, pos?: Vec3, vol = 1): boolean { return this.playSample(key, pos, vol); }

  /** Plays variant `n` (1-based) of a sample after `delay` seconds. */
  private playVariant(key: string, n: number, delay: number, vol = 1) {
    if (!this.ctx || !this.sfx[key]) return;
    const o = this.out(undefined, vol);
    if (!o) return;
    void this.loadVoice(`sfx/${key}_${n}`).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(o);
      src.start(this.ctx.currentTime + delay);
    });
  }

  /** The weapon's original reload parts (mag out, mag in, ...) spread over the reload. */
  reload(item: string, seconds: number) {
    const n = this.sfx[`reload_${item}`] ?? 0;
    for (let k = 0; k < n; k++) this.playVariant(`reload_${item}`, k + 1, (k / n) * Math.max(0.3, seconds) * 0.85, 0.7);
  }

  /** Weapon draw sound. */
  retrieve(item: string) { this.playSample(`retrieve_${item}`, undefined, 0.6); }

  private panner(pos: Vec3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 12;
    p.rolloffFactor = 1.1;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    return p;
  }

  private far(pos: Vec3 | undefined, d: number): boolean {
    return !!pos && Math.hypot(pos.x - this.listenerPos.x, pos.y - this.listenerPos.y, pos.z - this.listenerPos.z) > d;
  }

  /**
   * A shot by `owner` (player id, or a negative id for turrets). Automatic weapons with an original fire loop play
   * TA's attack transient, hold the loop while shots keep coming and end with the tail; others play one sample per
   * shot (shotgun pellets and duplicate tracers of the same shot are merged).
   */
  fire(owner: number, item: string, pos?: Vec3, vol = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const prev = this.lastShot.get(owner);
    if (prev && prev.item === item && now - prev.at < 0.03) return;
    this.lastShot.set(owner, { item, at: now });
    const key = this.sfx[`fireloop_${item}`] ? item : SFX_ALIAS[item] && this.sfx[`fireloop_${SFX_ALIAS[item]}`] ? SFX_ALIAS[item] : null;
    if (!key) { this.playWeapon(item, pos, vol); return; }
    let l = this.fireLoops.get(owner);
    if (l && l.item !== key) { this.endFireLoop(owner); l = undefined; }
    if (!l) {
      if (this.far(pos, 700)) return;
      const gain = this.ctx.createGain();
      gain.gain.value = vol;
      const panner = pos ? this.panner(pos) : null;
      if (panner) gain.connect(panner).connect(this.fx); else gain.connect(this.fx);
      // Network shots arrive in bursts, so remote loops wait a little longer before ending.
      const entry: FireLoop = { item: key, src: null, gain, panner, last: now, hold: pos ? 0.3 : 0.2, vol };
      this.fireLoops.set(owner, entry);
      this.playSample(`fire_${key}`, pos, vol);
      void this.sample(`fireloop_${key}`).then((buf) => {
        if (!buf || !this.ctx || this.fireLoops.get(owner) !== entry) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(gain);
        src.start();
        entry.src = src;
      });
      l = entry;
    }
    l.last = now;
    if (pos && l.panner) {
      l.panner.positionX.setValueAtTime(pos.x, now); l.panner.positionY.setValueAtTime(pos.y, now); l.panner.positionZ.setValueAtTime(pos.z, now);
    }
  }

  private endFireLoop(owner: number) {
    const l = this.fireLoops.get(owner);
    if (!l || !this.ctx) return;
    this.fireLoops.delete(owner);
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(0, t, 0.025);
    try { l.src?.stop(t + 0.15); } catch { /* not started */ }
    setTimeout(() => l.gain.disconnect(), 400);
    const pos = l.panner ? { x: l.panner.positionX.value, y: l.panner.positionY.value, z: l.panner.positionZ.value } : undefined;
    this.playSample(`firetail_${l.item}`, pos, l.vol);
  }

  /** Bullet impact where a hitscan shot ended (once per shot). */
  impact(owner: number, pos: Vec3) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - (this.lastImpact.get(owner) ?? -1) < 0.06) return;
    this.lastImpact.set(owner, now);
    this.playSample('impact', pos, 0.35);
  }

  /**
   * Per-frame upkeep: ends fire loops whose owner stopped shooting, and runs each vehicle's engine (idle and fast
   * loops crossfaded by speed; silent when nobody drives it).
   */
  tick(vehicles: { id: number; type: string; pos: Vec3; speed: number; maxSpeed: number; driven: boolean }[]) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [owner, l] of this.fireLoops) if (now - l.last > l.hold) this.endFireLoop(owner);
    const seen = new Set<number>();
    for (const v of vehicles) {
      // Recorded loops cover every vehicle; the manned emplacement borrows the base generator hum.
      const idleKey = `veh_${v.type}_idle`;
      const donor = this.sfx[idleKey] ? idleKey : v.type === 'heavy_turret' && this.sfx['gen_hum'] ? 'gen_hum' : null;
      if (!donor || this.far(v.pos, 450)) continue;
      seen.add(v.id);
      let e = this.engines.get(v.id);
      if (!e) {
        const panner = this.panner(v.pos);
        const idle = this.ctx.createGain(), fast = this.ctx.createGain();
        idle.gain.value = 0; fast.gain.value = 0;
        idle.connect(panner); fast.connect(panner);
        panner.connect(this.fx);
        const eng: Engine = { type: v.type, srcs: [], idle, fast, panner };
        e = eng;
        this.engines.set(v.id, eng);
        for (const [key, g] of [[donor, idle], [`veh_${v.type}_fast`, fast]] as const) {
          void this.sample(key).then((buf) => {
            if (!buf || !this.ctx || this.engines.get(v.id) !== eng) return;
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.connect(g);
            src.start(0, Math.random() * buf.duration);
            eng.srcs.push(src);
          });
        }
        if (v.driven) this.playSample(`veh_${v.type}_start`, v.pos, 0.7);
      }
      const k = Math.min(1, v.speed / Math.max(1, v.maxSpeed));
      const on = v.driven ? 1 : 0;
      e.idle.gain.setTargetAtTime(on * (1 - k * 0.7) * 0.45, now, 0.15);
      e.fast.gain.setTargetAtTime(on * k * 0.6, now, 0.15);
      e.panner.positionX.setValueAtTime(v.pos.x, now); e.panner.positionY.setValueAtTime(v.pos.y, now); e.panner.positionZ.setValueAtTime(v.pos.z, now);
    }
    for (const [id, e] of this.engines) {
      if (seen.has(id)) continue;
      this.engines.delete(id);
      for (const s of e.srcs) { try { s.stop(); } catch { /* ended */ } }
      e.panner.disconnect();
    }
  }

  /** Silences every loop owned by gameplay (fire loops, engines), e.g. when leaving a match. */
  stopGameplayLoops() {
    for (const owner of [...this.fireLoops.keys()]) this.endFireLoop(owner);
    this.tick([]);
  }

  private sample(key: string): Promise<AudioBuffer | null> {
    const n = this.sfx[key] ?? 0;
    return n ? this.loadVoice(`sfx/${key}_${1 + Math.floor(Math.random() * n)}`) : Promise.resolve(null);
  }

  /** Plays an imported sample if one exists for `key`; returns false so callers can synthesise instead. */
  private playSample(key: string, pos?: Vec3, vol = 1): boolean {
    if (!this.ctx || !this.sfx[key]) return false;
    const o = this.out(pos, vol);
    if (!o) return true;
    void this.sample(key).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(o);
      src.start();
    });
    return true;
  }

  /** Replace a synthesised noise loop with the original looping sample. */
  private async upgradeLoop(name: string, key: string) {
    const l = this.loops.get(name);
    const buf = await this.sample(key);
    if (!l || !buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(l.gain);
    src.start(0, Math.random() * buf.duration);
    l.src.stop();
    l.filter.disconnect();
    l.src = src;
  }

  /** Streams an imported music file (low memory compared to decoding minutes of PCM) through the music bus. */
  private musicEl(key: string, loop: boolean) {
    const ctx = this.ctx!;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.loop = loop;
    const bases = [...this.voiceBases];
    let i = 0;
    const next = () => { if (i < bases.length) el.src = `${bases[i++]}/assets/voices/music/${key}.ogg`; };
    el.addEventListener('error', next);
    next();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain).connect(this.musicGain);
    return { el, gain };
  }

  private stopTrack(tr: { el: HTMLAudioElement; gain: GainNode }, fade: number) {
    const t = this.ctx!.currentTime;
    tr.gain.gain.cancelScheduledValues(t);
    tr.gain.gain.setValueAtTime(tr.gain.gain.value, t);
    tr.gain.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { tr.el.pause(); tr.el.removeAttribute('src'); tr.el.load(); tr.gain.disconnect(); }, fade * 1000 + 150);
  }

  /** Crossfade to a looping music track (null = silence). Only plays tracks imported from the original game. */
  music(key: string | null, fade = 2.5) {
    this.wantedMusic = key;
    if (!this.ctx || !this.musicKeys || (this.track?.key ?? null) === key) return;
    if (this.track) this.stopTrack(this.track, fade);
    this.track = null;
    if (!key || !this.musicKeys.has(key)) return;
    const tr = this.musicEl(key, true);
    const t = this.ctx.currentTime;
    tr.gain.gain.setValueAtTime(0, t);
    tr.gain.gain.linearRampToValueAtTime(1, t + fade);
    void tr.el.play().catch(() => { /* autoplay blocked until a user gesture */ });
    this.track = { key, ...tr };
  }

  /** Whether an original music track / stinger was imported. */
  hasMusic(key: string): boolean { return !!this.musicKeys?.has(key); }

  /** One-shot musical stinger; ducks the current loop while it plays. */
  sting(key: string) {
    if (!this.ctx || !this.musicKeys?.has(key) || settings.musicVolume <= 0) return;
    const tr = this.musicEl(key, false);
    tr.gain.gain.value = 1;
    const loop = this.track?.gain.gain, t = this.ctx.currentTime;
    loop?.cancelScheduledValues(t);
    loop?.setValueAtTime(loop.value, t);
    loop?.linearRampToValueAtTime(0.3, t + 0.3);
    tr.el.addEventListener('ended', () => {
      const now = this.ctx!.currentTime;
      if (this.track?.gain.gain === loop) loop?.linearRampToValueAtTime(1, now + 1.5);
      this.stopTrack(tr, 0.05);
    }, { once: true });
    void tr.el.play().catch(() => { /* ignore */ });
  }

  /** Where imported voice lines can be fetched: this machine's node first, then the host's. */
  setAssetBases(bases: string[]) { this.voiceBases = bases; }

  private loadVoice(path: string): Promise<AudioBuffer | null> {
    let p = this.voiceCache.get(path);
    if (!p) {
      p = (async () => {
        for (const base of this.voiceBases) {
          try {
            const r = await fetch(`${base}/assets/voices/${path}.ogg`, { signal: AbortSignal.timeout(4000) });
            if (r.ok && this.ctx) return await this.ctx.decodeAudioData(await r.arrayBuffer());
          } catch { /* next source */ }
        }
        return null;
      })();
      this.voiceCache.set(path, p);
    }
    return p;
  }

  private playBuffer(buf: AudioBuffer, radio: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (radio > 0) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.5 + radio;
      src.connect(bp).connect(this.vgsGain);
    } else src.connect(this.vgsGain);
    src.start();
    return src;
  }

  /** Match announcer (flag events); only plays when original lines were imported. */
  async announcer(key: string) {
    if (!this.ctx || settings.vgsVolume <= 0 || !/^[a-z_]{1,40}$/.test(key)) return;
    const now = performance.now();
    if (now - this.lastAnnounce < 700) return;
    this.lastAnnounce = now;
    const buf = await this.loadVoice(`announcer/${key}`);
    if (buf) this.playBuffer(buf, 0);
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    this.master.connect(comp).connect(ctx.destination);
    this.fx = ctx.createGain();
    this.fx.connect(this.master);
    this.vgsGain = ctx.createGain();
    this.vgsGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.connect(this.master);
    void voiceManifest().then((m) => {
      this.musicKeys = new Set(m?.music ?? []);
      this.sfx = m?.sfx ?? {};
      this.music(this.wantedMusic);
      for (const [loop, key] of [['jet', 'jet'], ['ski', 'ski'], ['wind', 'wind'], ['spin', 'spin']] as const) if (this.sfx[key]) void this.upgradeLoop(loop, key);
    });
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (const name of ['jet', 'ski', 'wind', 'spin']) this.makeLoop(name);
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = settings.masterVolume;
    this.fx.gain.value = settings.effectsVolume;
    this.vgsGain.gain.value = settings.vgsVolume;
    this.musicGain.gain.value = settings.musicVolume * 0.7;
  }

  private makeLoop(name: string) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = name === 'ski' ? 'highpass' : name === 'spin' ? 'bandpass' : 'lowpass';
    filter.frequency.value = name === 'jet' ? 700 : name === 'ski' ? 3000 : name === 'spin' ? 1800 : 400;
    filter.Q.value = name === 'spin' ? 8 : 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.fx);
    src.start();
    this.loops.set(name, { src, gain, filter });
  }

  setLoop(name: 'jet' | 'ski' | 'wind' | 'spin', level: number, freq?: number) {
    const l = this.loops.get(name);
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(level, t, 0.05);
    if (freq) l.filter.frequency.setTargetAtTime(freq, t, 0.08);
  }

  private listenerPos: Vec3 = { x: 0, y: 0, z: 0 };

  setListener(pos: Vec3, fwd: Vec3) {
    if (!this.ctx) return;
    this.listenerPos = pos;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    }
  }

  private out(pos?: Vec3, vol = 1): AudioNode | null {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    if (pos) {
      const d = Math.hypot(pos.x - this.listenerPos.x, pos.y - this.listenerPos.y, pos.z - this.listenerPos.z);
      if (d > 700) return null;
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 12;
      p.rolloffFactor = 1.1;
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      g.connect(p).connect(this.fx);
    } else g.connect(this.fx);
    return g;
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, delay = 0, q = 0.8) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
  }

  play(name: SoundName, pos?: Vec3, vol = 1) {
    if (!this.ctx) return;
    const key = SAMPLE_FOR[name];
    if (key && this.playSample(key, pos, vol)) return;
    const o = this.out(pos, vol);
    if (!o) return;
    switch (name) {
      case 'disc': this.tone(o, 'sine', 260, 70, 0.28, 0.7); this.burst(o, 'bandpass', 2400, 600, 0.22, 0.35); break;
      case 'bolt': this.tone(o, 'square', 180, 60, 0.3, 0.35); this.burst(o, 'lowpass', 3000, 300, 0.3, 0.5); break;
      case 'explode': this.burst(o, 'lowpass', 2600, 120, 0.9, 1.1); this.tone(o, 'sine', 90, 35, 0.6, 0.9); break;
      case 'bullet': this.burst(o, 'highpass', 2500, 1200, 0.06, 0.5); this.tone(o, 'square', 900, 300, 0.03, 0.12); break;
      case 'rifle': this.burst(o, 'highpass', 4000, 800, 0.12, 0.8); this.tone(o, 'sawtooth', 1400, 150, 0.2, 0.3); break;
      case 'shotgun': this.burst(o, 'lowpass', 5000, 400, 0.25, 1); this.tone(o, 'sine', 140, 50, 0.15, 0.5); break;
      case 'grenade': this.burst(o, 'bandpass', 900, 300, 0.2, 0.3); break;
      case 'plasma': this.tone(o, 'sawtooth', 520, 180, 0.22, 0.25); this.tone(o, 'sine', 1040, 360, 0.2, 0.15); break;
      case 'mortar': this.tone(o, 'sine', 120, 40, 0.5, 0.9); this.burst(o, 'lowpass', 800, 100, 0.4, 0.5); break;
      case 'hit': this.tone(o, 'sine', 2100, 1800, 0.05, 0.35); break;
      case 'blueplate': this.tone(o, 'sine', 1318, 1318, 0.7, 0.4); this.tone(o, 'sine', 1760, 1760, 0.6, 0.3, 0.06); this.tone(o, 'triangle', 2637, 2637, 0.4, 0.15, 0.1); break;
      case 'kill': this.tone(o, 'triangle', 880, 880, 0.12, 0.35); this.tone(o, 'triangle', 1320, 1320, 0.2, 0.35, 0.1); break;
      case 'flag_grab': [523, 659, 784].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.25, 0.4, i * 0.09)); break;
      case 'flag_cap': [523, 659, 784, 1046].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.4, 0.45, i * 0.12)); break;
      case 'flag_return': [784, 659, 523].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.25, 0.35, i * 0.09)); break;
      case 'flag_drop': this.tone(o, 'square', 440, 220, 0.3, 0.2); break;
      case 'denied': this.tone(o, 'square', 140, 120, 0.25, 0.25); break;
      case 'jump': this.burst(o, 'bandpass', 700, 1400, 0.25, 0.3); break;
      case 'melee': this.burst(o, 'lowpass', 1200, 200, 0.15, 0.7); this.tone(o, 'sine', 160, 60, 0.15, 0.5); break;
      case 'lance': this.tone(o, 'sawtooth', 2400, 300, 0.25, 0.35); this.burst(o, 'highpass', 6000, 3000, 0.2, 0.4); break;
      case 'turret': this.tone(o, 'square', 700, 200, 0.12, 0.25); break;
      case 'repair': this.tone(o, 'sine', 1200 + Math.random() * 200, 1500, 0.08, 0.08); break;
      case 'deploy': this.tone(o, 'square', 300, 300, 0.05, 0.3); this.tone(o, 'square', 450, 450, 0.05, 0.3, 0.07); break;
      case 'strike_warn': for (let i = 0; i < 4; i++) this.tone(o, 'sawtooth', 600, 1200, 0.45, 0.25, i * 0.5); break;
      case 'spawn': this.tone(o, 'sine', 200, 900, 0.4, 0.3); break;
      case 'land': this.burst(o, 'lowpass', 600, 80, 0.2, 0.6); break;
      case 'click': this.tone(o, 'square', 1200, 1200, 0.02, 0.1); break;
      case 'hurt': this.burst(o, 'lowpass', 900, 200, 0.18, 0.5); break;
      case 'gen_down': this.tone(o, 'sawtooth', 300, 60, 1.4, 0.4); break;
      case 'match_start': [392, 523, 659, 784].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.35, 0.4, i * 0.15)); break;
    }
  }

  playWeapon(item: string, pos?: Vec3, vol = 1) {
    if (this.playSample(`fire_${item}`, pos, vol) || (SFX_ALIAS[item] && this.playSample(`fire_${SFX_ALIAS[item]}`, pos, vol))) return;
    if (ITEMS[item]?.slot === 'belt' && this.playSample('throw', pos, vol)) return;
    if (/spinfusor|twinfusor|disc|gladiator/.test(item)) this.play('disc', pos, vol);
    else if (/bolt/.test(item)) this.play('bolt', pos, vol);
    else if (/mortar|mirv|beowulf/.test(item)) this.play('mortar', pos, vol);
    else if (/plasma|nova|shrike|turret/.test(item)) this.play('plasma', pos, vol);
    else if (/shotgun|hammer|sawed/.test(item)) this.play('shotgun', pos, vol);
    else if (/bxt|phase|sap20|rifle_?$|colt|eagle|falcon|sn7|sparrow/.test(item)) this.play('rifle', pos, vol);
    else if (/lance/.test(item)) this.play('lance', pos, vol);
    else if (/grenade|nitron|thumper|launcher|tc24|jackal|devil|knives|frag|sticky|fractal|ap|tcng|emp|cluster|whiteout|buster|titan|saber|gravcycle/.test(item)) this.play('grenade', pos, vol);
    else this.play('bullet', pos, vol);
  }

  /** Projectile explosion: the weapon's own original sound, else the generic one. */
  playExplosion(item: string, pos?: Vec3, vol = 1) {
    if (!this.playSample(`boom_${item}`, pos, vol) && !(SFX_ALIAS[item] && this.playSample(`boom_${SFX_ALIAS[item]}`, pos, vol))) this.play('explode', pos, vol);
  }

  // ------------------------------------------------------------ VGS
  private async hasPackFiles(pack: string): Promise<boolean> {
    if (this.packFiles.has(pack)) return this.packFiles.get(pack)!;
    let ok = false;
    try { ok = (await fetch(`/voicepacks/${pack}/manifest.json`, { method: 'HEAD' })).ok; } catch { ok = false; }
    this.packFiles.set(pack, ok);
    return ok;
  }

  /** VGS line; a new line from the same player cuts the previous one off ("I am the... Shazbot!"). */
  async vgs(id: string, packId: string, from = -1) {
    const leaf = VGS_BY_ID[id];
    if (!leaf || settings.vgsVolume <= 0) return;
    if (this.ctx && ORIGINAL_VOICE.test(packId)) {
      const buf = await this.loadVoice(`${packId}/${id}`);
      if (buf) {
        try { this.vgsBy.get(from)?.stop(); } catch { /* already ended */ }
        const src = this.playBuffer(buf, 0);
        if (from >= 0) { this.vgsBy.set(from, src); src.onended = () => { if (this.vgsBy.get(from) === src) this.vgsBy.delete(from); }; }
        return;
      }
    }
    const pack = VOICE_PACKS.find((v) => v.id === packId) ?? VOICE_PACKS[0];
    if (this.ctx && (await this.hasPackFiles(pack.id))) {
      try {
        const buf = await this.ctx.decodeAudioData(await (await fetch(`/voicepacks/${pack.id}/${id}.ogg`)).arrayBuffer());
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.5 + pack.radio;
        src.connect(bp).connect(this.vgsGain);
        src.start();
        return;
      } catch { /* fall back to speech */ }
    }
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(leaf.text.replace(/!/g, '.'));
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    const pick = voices.find((v) => pack.voiceHint !== 'any' && v.name.toLowerCase().includes(pack.voiceHint)) ?? voices[VOICE_PACKS.indexOf(pack) % Math.max(1, voices.length)];
    if (pick) u.voice = pick;
    u.pitch = pack.pitch;
    u.rate = pack.rate;
    u.volume = settings.vgsVolume * settings.masterVolume;
    speechSynthesis.speak(u);
  }
}

export const audio = new AudioEngine();
