import './styles.css';
import * as THREE from 'three';
import { generateMap, decodeMapData, LAYOUT_BY_ID, type MapData, type S2C, type ServerInfo } from '@ar/shared';
import { audio } from './audio/audio.js';
import { GameClient } from './game/client.js';
import { loadMap } from './game/maploader.js';
import { Input } from './input/input.js';
import { NODE_URL } from './net/node.js';
import { social } from './net/social.js';
import { connect } from './net/transport.js';
import { Session } from './net/session.js';
import { Renderer } from './render/renderer.js';
import { models } from './render/models.js';
import { anims } from './render/anim.js';
import { TextureStore } from './render/textures.js';
import { LM_UNIFORMS, WorldView } from './render/world.js';
import { settings } from './settings.js';
import { h } from './ui/dom.js';
import { LoadingScreen } from './ui/loading.js';
import { Menus } from './ui/menus.js';

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const renderer = new Renderer(gameEl);
const input = new Input(renderer.canvas);
models.setup([NODE_URL], renderer.renderer);
anims.setup([NODE_URL]);

// ---------------------------------------------------------------- menu backdrop: slow flyover (an imported original map when available)
let backdrop: { view: WorldView; raf: number; tex: TextureStore | null } | null = null;
let backdropToken = 0;

async function originalBackdrop(): Promise<MapData | null> {
  try {
    const idx = (await (await fetch(`${NODE_URL}/assets/index.json`, { signal: AbortSignal.timeout(2000) })).json()) as { id: string; mode: string; file: string }[];
    const pick = ['katabatic.ctf', 'arxnovena.ctf', 'drydock.ctf', 'crossfire.ctf', 'tartarus.ctf', 'bellaomega.ctf'].map((k) => idx.find((e) => `${e.id}.${e.mode}` === k)).filter(Boolean);
    const e = pick[Math.floor(Math.random() * pick.length)];
    if (!e) return null;
    const r = await fetch(`${NODE_URL}/map/${e.file}`, { signal: AbortSignal.timeout(8000) });
    const raw = await new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return decodeMapData(new Uint8Array(raw));
  } catch { return null; }
}

function startBackdrop() {
  if (backdrop) return;
  const token = ++backdropToken;
  void (async () => {
    const orig = await originalBackdrop();
    if (token !== backdropToken || backdrop) return;
    const ids = ['katabatic', 'arxnovena', 'tartarus', 'raindance', 'bellaomega', 'crossfire'];
    const map: MapData = orig ?? generateMap(LAYOUT_BY_ID[ids[Math.floor(Math.random() * ids.length)]]);
    const tex = orig?.textures?.length ? new TextureStore([NODE_URL], renderer.renderer) : null;
    const view = new WorldView(map, renderer.scene, tex, renderer.renderer);
    renderer.setSun(view.sunDirection);
    view.onSkyEnv = (t) => renderer.setSkyEnvironment(t);
    renderer.setSkyEnvironment(view.setSkyIBL());
    const pts = map.entities.filter((e) => e.kind === 'flag_stand' || e.kind === 'generator' || e.kind === 'spawn');
    const cx = pts.length ? pts.reduce((a, e) => a + e.pos.x, 0) / pts.length : 0;
    const cz = pts.length ? pts.reduce((a, e) => a + e.pos.z, 0) / pts.length : 0;
    const spread = pts.length ? Math.max(...pts.map((e) => Math.hypot(e.pos.x - cx, e.pos.z - cz))) : 300;
    const t0 = performance.now();
    const loop = () => {
      if (!backdrop) return;
      backdrop.raf = requestAnimationFrame(loop);
      const t = (performance.now() - t0) / 1000;
      const r = Math.max(120, spread * 0.75);
      const x = cx + Math.cos(t * 0.02) * r, z = cz + Math.sin(t * 0.02) * r;
      const y = map.terrain.heightAt(x, z) + 60;
      renderer.camera.position.set(x, y, z);
      renderer.camera.lookAt(cx, map.terrain.heightAt(cx, cz) + 20, cz);
      view.update(renderer.camera, 1 / 60, renderer.camera.position);
      renderer.render();
    };
    backdrop = { view, tex, raf: requestAnimationFrame(loop) };
  })();
}
function stopBackdrop() {
  backdropToken++;
  if (!backdrop) return;
  cancelAnimationFrame(backdrop.raf);
  backdrop.view.onSkyEnv = null;
  backdrop.view.dispose();
  backdrop.tex?.dispose();
  renderer.setSkyEnvironment(null);
  backdrop = null;
}

// ---------------------------------------------------------------- app flow
let client: GameClient | null = null;
// Test hook for the e2e scripts (?debug): camera/renderer access for graphics captures.
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __ar: unknown }).__ar = { renderer, settings, lightmap: LM_UNIFORMS, client: () => client, gfx: () => { renderer.configure(); client?.graphicsChanged(); } };
let session: Session | null = null;
let loading: LoadingScreen | null = null;

const menus = new Menus(uiEl, input, {
  join: (info) => void join(info),
  graphicsChanged: () => { renderer.configure(); client?.graphicsChanged(); if (backdrop) { stopBackdrop(); startBackdrop(); } },
});

function showConnecting(info: ServerInfo, detail: string, progress = 0) {
  loading ??= new LoadingScreen(uiEl, info, () => leave('Cancelled'));
  loading.progress(progress, detail);
}

function hideConnecting() { loading?.remove(); loading = null; }

async function join(info: ServerInfo) {
  audio.ensure();
  leave();
  menus.show(false);
  showConnecting(info, `Negotiating ${info.transports.includes('webtransport') ? 'WebTransport' : 'WebSocket'}`);
  await connectAndWire(info, 0);
}

/** Server-initiated closes that mean "you must not come back" - never reconnect on these. */
const FINAL_CLOSES = ['vote kicked', 'kicked by admin', 'server closed', 'full', 'version', 'flood'];
const MAX_RECONNECT = 3;

async function connectAndWire(info: ServerInfo, attempt: number): Promise<void> {
  try {
    const { transport, fellBack, error } = await connect(info, settings.transport);
    const s = new Session(transport, info);
    session = s;
    showConnecting(info, `Connected via ${transport.kind === 'webtransport' ? 'WebTransport' : 'WebSocket'}${fellBack ? ` (fallback: ${error})` : ''}`, 0.1);
    s.onClose = (reason) => { if (session === s) void handleDrop(info, reason, attempt); };
    s.onJson = (msg: S2C) => {
      if (msg.t === 'error') leave(msg.msg);
      if (msg.t === 'welcome') void enterMap(s, msg.map, fellBack, true);
    };
    s.hello();
  } catch (e) {
    // A transient connect failure (UDP blip, server mid-tick) gets the same retry ladder as a drop.
    if (attempt < MAX_RECONNECT && loading) {
      showConnecting(info, `Connection failed: ${(e as Error).message}. Retrying (${attempt + 1}/${MAX_RECONNECT})…`, 0.02 * (attempt + 1));
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      if (session || !loading) return; // cancelled or a new join took over
      return connectAndWire(info, attempt + 1);
    }
    leave(`Could not connect: ${(e as Error).message}`);
  }
}

/** Transport drop: ride out transient QUIC/WS losses by re-joining the same server (fresh spawn). */
async function handleDrop(info: ServerInfo, reason: string, attempt: number): Promise<void> {
  const s = session;
  session = null;
  s?.close();
  if (attempt >= MAX_RECONNECT || FINAL_CLOSES.some((r) => reason.includes(r))) {
    leave(`Disconnected: ${reason}`);
    return;
  }
  const next = attempt + 1;
  showConnecting(info, `Connection lost (${reason}). Reconnecting (${next}/${MAX_RECONNECT})…`, 0.02 * next);
  await new Promise((r) => setTimeout(r, 400 * next));
  if (session || !loading) return; // cancelled or a new join took over
  client?.dispose();
  client = null;
  await connectAndWire(info, next);
}

async function enterMap(s: Session, ref: Extract<S2C, { t: 'welcome' }>['map'], fellBack: boolean, first = false) {
  const httpBase = s.server.wsUrl?.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '') ?? '';
  const info = { ...s.server, map: ref.id, mapSource: ref.source, mapName: (first && s.server.mapName) || LAYOUT_BY_ID[ref.id]?.name || ref.id.replace(/(^|_)([a-z])/g, (_, a: string, b: string) => `${a ? ' ' : ''}${b.toUpperCase()}`) };
  try {
    if (!loading) showConnecting(info, 'Changing map', 0.05);
    const map = await loadMap(ref, s.server.mode, httpBase, (f, label) => showConnecting(info, label, 0.1 + f * 0.85));
    if (session !== s) return;
    loading?.setMap(map);
    showConnecting(info, 'Building world', 0.98);
    await new Promise((r) => setTimeout(r, 16));
    stopBackdrop();
    client?.dispose();
    const pending: S2C[] = [];
    s.onJson = (m) => pending.push(m);
    client = new GameClient(renderer, input, uiEl, s, map, {
      leave: (reason) => leave(reason),
      openSettings: () => { menus.show(true); menus.showSettings(); settingsFromGame = true; },
    }, fellBack);
    const inner = s.onJson;
    s.onJson = (m) => {
      if (m.t === 'changemap') { client?.dispose(); client = null; void enterMap(s, m.map, fellBack); return; }
      inner(m);
    };
    for (const m of pending) s.onJson(m);
    const shown = loading?.age() ?? 1e9;
    if (shown < 2500) await new Promise((r) => setTimeout(r, 2500 - shown));
    if (session !== s) return;
    hideConnecting();
    social.setStatus('In match', s.server.wsUrl, s.server.name);
    client?.focus();
  } catch (e) {
    leave(`Map load failed: ${(e as Error).message}`);
  }
}

let settingsFromGame = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && settingsFromGame && client) { settingsFromGame = false; menus.show(false); client.openEscMenu(); }
});

function leave(reason?: string) {
  hideConnecting();
  client?.dispose();
  client = null;
  const s = session;
  session = null;
  s?.close();
  if (!backdrop) startBackdrop();
  audio.music('loop_low');
  menus.show(true);
  if (reason) {
    const toast = h('div', { class: 'panel', style: 'position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:.7em 1.4em;z-index:10' }, reason);
    uiEl.append(toast);
    setTimeout(() => toast.remove(), 5000);
  }
}

renderer.scene.fog = new THREE.FogExp2(0xc0cfdc, 0.0005);

/** TA's own startup splash (imported from TribesGame/Splash/PC/Splash.bmp); skipped when not imported. */
function splash() {
  const img = new Image();
  img.alt = '';
  const el = h('div', { class: 'ar-splash' }, img);
  document.body.append(el);
  const out = (delay: number) => { setTimeout(() => el.classList.add('out'), delay); setTimeout(() => el.remove(), delay + 900); };
  img.onload = () => { el.classList.add('ready'); out(1700); };
  img.onerror = () => out(0);
  img.src = `${NODE_URL}/assets/ui/splash.png`;
}
splash();
startBackdrop();
audio.music('loop_low');
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });
