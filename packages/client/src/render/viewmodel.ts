import * as THREE from 'three';
import { ITEMS, WEAPON_FINISHES, projDef } from '@ar/shared';
import { settings } from '../settings.js';
import { anims, SeqPlayer, type AnimSet } from './anim.js';
import { models, staticModel, weaponModelKey, type ModelData } from './models.js';
import { isSharedMaterial, markShared, ownMaterial } from './materials.js';

/** Weapon templates built from fixed parameters are cached and shared across viewmodels;
 *  `setViewModelStealth()` mutates them per weapon, so each viewmodel owns clones. */
const matCache = new Map<string, THREE.Material>();
function shared<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = matCache.get(key);
  if (hit) return hit as T;
  const m = markShared(make());
  matCache.set(key, m);
  return m;
}

/** Skinned instance of an imported model in its bind pose, bones by name. */
function skinned(m: ModelData): { mesh: THREE.SkinnedMesh; bones: Map<string, THREE.Bone> } {
  const bones = m.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.p);
    bone.quaternion.fromArray(b.q);
    return bone;
  });
  bones.forEach((b, i) => { const p = m.bones[i].parent; if (p >= 0 && i > 0) bones[p].add(b); });
  const mesh = new THREE.SkinnedMesh(m.geometry, models.materials(m));
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.frustumCulled = false;
  mesh.userData.sharedGeometry = true;
  return { mesh, bones: new Map(bones.map((b) => [b.name, b])) };
}

const LCD_FONT = '"Consolas","Menlo","DejaVu Sans Mono",monospace';

/** TA's first-person ammo LCD phosphor blue (spinfusor glass reads "75 / 2 SAFE" in this blue). */
const LCD_BLUE = 0x4aa8ff;

/** `?wepdebug`: log where each weapon's ammo counter was anchored, for in-engine checks. */
const WEP_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('wepdebug');

/** Hard caps on the ammo panel as a fraction of the frame (width / height). Deliberately generous: a panel
 *  measured close to the eye is only ~3% of the frame at the authored glass, which is unreadable once the
 *  glass glows. 26%/16% keeps it a HUD-sized display, still far from flooding the viewport. */
const FRAME_W = 0.26;
const FRAME_H = 0.16;

/** View frustum used for placement maths: the same 16:9 frustum the renderer builds from `settings.fov`. */
const VIEW_ASPECT = 16 / 9;
const VIEW_VFOV = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(settings.fov) / 2) / VIEW_ASPECT);
const viewHeight = (d: number) => 2 * d * Math.tan(VIEW_VFOV / 2);
const viewWidth = (d: number) => viewHeight(d) * VIEW_ASPECT;

/** Camera-space centre and plane normal (posed quads are already in this space), with the view angles. */
function measureQuad(q: ScreenQuad) {
  const c = q.center.clone();
  const toEye = c.clone().negate();
  const dist = Math.max(1e-6, toEye.length());
  // TA winds the screen glass either way round, so judge the plane, not the winding.
  const n = q.normal.clone();
  if (n.dot(toEye) < 0) n.negate();
  // Screen fraction: how far off the crosshair the glass lands, in half-widths / half-heights.
  const fx = Math.abs(c.x) / (viewWidth(dist) / 2);
  const fy = Math.abs(c.y) / (viewHeight(dist) / 2);
  return {
    c, n, dist,
    facing: n.dot(toEye) / dist,
    off: Math.atan2(Math.hypot(c.x, c.y), -c.z) * 180 / Math.PI,
    fx, fy,
  };
}

/** A flat quad authored on a 1P mesh, in model space: TA's weapon glass / display panel. */
interface ScreenQuad {
  center: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
  w: number;
  h: number;
  display: boolean;
  /** Cluster vertex indices, so the quad can be re-measured in the animated pose. */
  verts: number[];
}

/** Frame of a flat point cloud: the two longest spans give the plane and both axes. */
function fitQuad(pts: THREE.Vector3[]) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.divideScalar(pts.length);
  const e = new THREE.Vector3();
  let d1 = new THREE.Vector3(), d2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      e.copy(pts[j]).sub(pts[i]);
      if (e.lengthSq() > d1.lengthSq()) d1 = e.clone();
    }
  }
  if (d1.lengthSq() < 1e-10) return null;
  d1.normalize();
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      e.copy(pts[j]).sub(pts[i]).addScaledVector(d1, -e.dot(d1));
      if (e.lengthSq() > d2.lengthSq()) d2 = e.clone();
    }
  }
  if (d2.lengthSq() < 1e-10) return null;
  d2.normalize();
  const normal = d1.clone().cross(d2);
  if (normal.lengthSq() < 1e-10) return null;
  normal.normalize();
  const right = d1.clone().addScaledVector(normal, -d1.dot(normal)).normalize();
  const up = normal.clone().cross(right).normalize();
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (const p of pts) {
    e.copy(p).sub(c);
    const du = e.dot(right), dv = e.dot(up), dn = e.dot(normal);
    if (du < u0) u0 = du; if (du > u1) u1 = du;
    if (dv < v0) v0 = dv; if (dv > v1) v1 = dv;
    if (dn < n0) n0 = dn; if (dn > n1) n1 = dn;
  }
  let w = u1 - u0, h = v1 - v0;
  let ax = right, ay = up;
  if (h > w) { [w, h] = [h, w]; ax = up; ay = right.clone().negate(); }
  // Flatness is judged against the quad's *larger* extent. TA builds a screen as several glass tiles stepped in
  // depth along the same plane; measured against the short axis alone (h) those tiles are rejected as "not flat",
  // which silently deleted the one panel the player actually sees.
  const span = Math.max(w, h);
  if (w < 1e-4 || h < 1e-4 || w / h > 12 || Math.max(Math.abs(n0), Math.abs(n1)) > span * 0.5) return null;
  return { center: c, right: ax, up: ay, normal, w, h };
}

/**
 * The authored glass as the game actually renders it. `screenQuads()` measures the mesh in its bind pose, but the
 * weapon is skinned: the Idle pose the player sees swings the glass ~60 deg toward the view axis (measured: 10-36 deg
 * off axis, 13-42 cm from the eye, low-right of the crosshair). Skin the quad's vertices with the animated skeleton
 * and re-fit its frame, so the counter is laid on where the glass really is. Result is in world (camera) space.
 */
function poseQuads(weapon: THREE.SkinnedMesh, quads: ScreenQuad[]): ScreenQuad[] {
  const sk = weapon.skeleton;
  const pos = weapon.geometry.getAttribute('position');
  const si = weapon.geometry.getAttribute('skinIndex');
  const sw = weapon.geometry.getAttribute('skinWeight');
  if (!pos || !si || !sw || !sk.boneMatrices.length) return [];
  const pa = pos.array, sa = si.array, wa = sw.array, bm = sk.boneMatrices;
  const t = new THREE.Vector3();
  const out: ScreenQuad[] = [];
  for (const q of quads) {
    const pts: THREE.Vector3[] = [];
    for (const i of q.verts) {
      const o = new THREE.Vector3();
      const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
      for (let k = 0; k < 4; k++) {
        const wgt = wa[i * 4 + k], b = sa[i * 4 + k];
        if (wgt <= 0 || b >= sk.bones.length) continue;
        const j = b * 16;
        t.set(
          bm[j] * x + bm[j + 1] * y + bm[j + 2] * z + bm[j + 3],
          bm[j + 4] * x + bm[j + 5] * y + bm[j + 6] * z + bm[j + 7],
          bm[j + 8] * x + bm[j + 9] * y + bm[j + 10] * z + bm[j + 11],
        );
        o.addScaledVector(t, wgt);
      }
      pts.push(o);
    }
    const f = fitQuad(pts);
    if (f) out.push({ ...f, display: q.display, verts: q.verts });
  }
  return out;
}

/**
 * TA paints an ammo screen into every 1P weapon: a small scanline-glass quad (`T_FX_ScanLines01`) on 33 of the 38
 * weapons, and a dedicated display panel on the rest (chaingun, phase rifle, repair tool, mirv). Recover those quads
 * from the imported mesh so the counter can be laid exactly onto the screen the artists made.
 */
function screenQuads(m: ModelData): ScreenQuad[] {
  const pos = m.geometry.getAttribute('position');
  const index = m.geometry.getIndex();
  if (!pos || !index) return [];
  const at = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const out: ScreenQuad[] = [];
  const span = m.geometry.boundingBox ? m.geometry.boundingBox.min.distanceTo(m.geometry.boundingBox.max) : 1;
  for (const s of m.sections) {
    // A screen is authored as few as two triangles (a chaingun panel is 2, a thumper glass is 4), so a 6-tri
    // floor threw away whole weapons before any of the shape tests ran.
    if (!/scanlines|display|screen|window/i.test(s.tex) || s.count < 2) continue;
    const display = !/scanlines/i.test(s.tex);
    // TA builds a screen as several coplanar quads (a bezel of separate panels), so cluster
    // the section's triangles by their plane and emit one quad per cluster.
    const clusters: { n: THREE.Vector3; tris: THREE.Vector3[][]; ids: Set<number> }[] = [];
    for (let t = s.first; t + 2 < s.first + s.count; t += 3) {
      const id = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const tri = [at(id[0]), at(id[1]), at(id[2])];
      const n = tri[1].clone().sub(tri[0]).cross(tri[2].clone().sub(tri[0]));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      // TA tiles a screen from separate quads stepped a few mm apart along the bezel. A 0.02-span tolerance split
      // those tiles into single-triangle clusters that every later shape test then threw away (a 4-tri scanline
      // section yielded no candidate at all), so the counter had nowhere to anchor. Cluster generously.
      const hit = clusters.find((c) => c.n.dot(n) > 0.96 && Math.abs(c.tris[0][0].clone().sub(tri[0]).dot(c.n)) < Math.max(span * 0.08, 3e-3));
      if (hit) { hit.tris.push(tri); for (const i of id) hit.ids.add(i); }
      else clusters.push({ n, tris: [tri], ids: new Set(id) });
    }
    for (const { n, tris, ids } of clusters) {
      // A lone triangle is a valid screen: the tiny scanline sections (4-18 tris) are authored as one quad per tile.
      // The quad's "right": its longest edge, squared onto the plane.
      const right = new THREE.Vector3(), e = new THREE.Vector3();
      for (const tri of tris) {
        for (const [p, q] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] as const) {
          e.copy(q).sub(p);
          e.addScaledVector(n, -e.dot(n));
          if (e.lengthSq() > right.lengthSq()) right.copy(e);
        }
      }
      if (right.lengthSq() < 1e-10) continue;
      right.normalize();
      const up = n.clone().cross(right); // right-handed: right x up = normal
      const o = tris[0][0];
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      for (const tri of tris) {
        for (const p of tri) {
          e.copy(p).sub(o);
          const du = e.dot(right), dv = e.dot(up), dn = e.dot(n);
          if (du < u0) u0 = du; if (du > u1) u1 = du;
          if (dv < v0) v0 = dv; if (dv > v1) v1 = dv;
          if (dn < d0) d0 = dn; if (dn > d1) d1 = dn;
        }
      }
      let w = u1 - u0, h = v1 - v0;
      // Counters read wide: a panel authored tall is the same quad seen sideways, so swap its axes.
      let ax = right, ay = up;
      if (h > w) { [w, h] = [h, w]; ax = up; ay = right.clone().negate(); }
      // Keep panel-shaped clusters: reject slivers (thin strips are weapon rails, not screens) and anything
      // that isn't flat. Square-ish quads are fine - scopes and sight windows are authored that way. Flatness
      // is measured against the cluster's larger extent, matching fitQuad().
      const span2 = Math.max(w, h);
      if (w < 1e-4 || h < 1e-4 || w / h > 12 || Math.max(Math.abs(d0), Math.abs(d1)) > span2 * 0.5) continue;
      out.push({
        center: o.clone().addScaledVector(right, (u0 + u1) / 2).addScaledVector(up, (v0 + v1) / 2).addScaledVector(n, (d0 + d1) / 2),
        right: ax, up: ay, normal: n, w, h, display,
        verts: Array.from(ids),
      });
    }
  }
  return out;
}

/** Small emissive readout of the clip, like the counters on TA's first-person weapons. */
class AmmoReadout {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private shown = '';
  private clip = 0; private reserve = 0; private progress = 0;
  constructor(private color: number) {
    this.canvas.width = 256; this.canvas.height = 128;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // depthTest OFF: the authored glass is a thin sliver *inside* the weapon's casing, so a depth-tested panel
    // laid on it is clipped by the gun's own body and disappears (this is why the counter was invisible on
    // soldier/thumper). Flooding is prevented by geometry, not by the depth buffer: layOn() + tame() hard-cap
    // the panel to FRAME_W/FRAME_H of the frame, and placeReadout() only picks glass the eye
    // can see. Polygon offset still biases it toward the eye against the coplanar glass it sits on.
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    // Above the viewmodel's renderOrder 10: the authored glass is an opaque, now self-lit mesh, and a panel
    // sharing its renderOrder loses the tie to depth order - the glass is nearer the eye, so it painted over
    // the digits. Drawing last (with depthTest off) puts the counter on the glass, not behind it.
    this.mesh.renderOrder = 20;
    // Hidden until `placeReadout()` confirms a glass to sit on; an unanchored panel
    // floating in the view reads as a stray rectangle.
    this.mesh.visible = false;
    this.draw();
  }
  /** Cut the panel to the size of the weapon's authored screen (model-space width and height). */
  fit(w: number, h: number) {
    // Re-laid every frame as the weapon pose moves; a canvas redraw plus texture upload for a size that has not
    // changed is pure cost, so only repaint when the cut actually differs.
    if (Math.abs(this.mesh.scale.x - w) < 1e-5 && Math.abs(this.mesh.scale.y - h) < 1e-5) return;
    const cw = 256, ch = Math.round(Math.max(48, Math.min(200, cw / Math.max(1.15, Math.min(8, w / h)))));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.mesh.scale.set(w, h, 1);
    this.draw();
  }
  set(clip: number, reserve: number, progress: number) {
    const s = `${clip}|${reserve}|${Math.round(progress * 100)}`;
    if (s === this.shown) return;
    this.shown = s;
    this.clip = clip; this.reserve = reserve; this.progress = progress;
    this.draw();
  }
  private draw() {
    const g = this.canvas.getContext('2d')!, W = this.canvas.width, H = this.canvas.height;
    // TA's weapon screens are phosphor-blue LCDs ("75 / 2 SAFE" on the spinfusor), so the panel paints a blue
    // screen with blue glyphs; the class accent only tints the inner glow, keeping per-weapon identity.
    const accent = new THREE.Color(this.color).lerp(new THREE.Color(LCD_BLUE), 0.72);
    const c = `#${accent.getHexString()}`;
    const [cr, cg, cb] = [Math.round(accent.r * 255), Math.round(accent.g * 255), Math.round(accent.b * 255)];
    const lw = Math.max(2, Math.round(W / 110)), pad = Math.round(W * 0.07);
    g.clearRect(0, 0, W, H);
    // The panel IS the screen: an opaque LCD field, lit from the upper-left like the in-engine glass. A smoke
    // tint here is what made the weapon read as bare lines with no display.
    const glass = g.createLinearGradient(0, 0, W * 0.35, H);
    glass.addColorStop(0, 'rgba(10,34,62,0.96)');
    glass.addColorStop(0.55, 'rgba(6,20,40,0.96)');
    glass.addColorStop(1, 'rgba(3,10,22,0.96)');
    g.fillStyle = glass; g.fillRect(0, 0, W, H);
    const wash = g.createRadialGradient(W * 0.34, H * 0.5, 0, W * 0.34, H * 0.5, W * 0.45);
    wash.addColorStop(0, `rgba(${cr},${cg},${cb},0.34)`); wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = wash; g.fillRect(0, 0, W, H);
    // Coarse and soft: at 3px/1px the pattern aliases into full-screen scanlines when the panel is large on frame.
    g.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
    // Bezel with corner ticks.
    g.strokeStyle = c; g.globalAlpha = 0.55; g.lineWidth = lw; g.strokeRect(lw, lw, W - 2 * lw, H - 2 * lw);
    const tick = Math.round(W * 0.07);
    g.globalAlpha = 0.95; g.lineWidth = lw * 1.7;
    for (const [x, y, sx, sy] of [[lw, lw, 1, 1], [W - lw, lw, -1, 1], [lw, H - lw, 1, -1], [W - lw, H - lw, -1, -1]] as const) {
      g.beginPath(); g.moveTo(x + sx * tick, y); g.lineTo(x, y); g.lineTo(x, y + sy * tick); g.stroke();
    }
    g.globalAlpha = 1;
    // Clip count, reserve, reload/spinup bar.
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = `bold ${Math.round(H * 0.6)}px ${LCD_FONT}`;
    g.shadowColor = this.clip <= 0 ? '#ff4a38' : c; g.shadowBlur = H * 0.16;
    g.fillStyle = this.clip <= 0 ? '#ff4a38' : c;
    g.fillText(String(this.clip), pad, H * 0.48);
    g.font = `bold ${Math.round(H * 0.28)}px ${LCD_FONT}`;
    g.textAlign = 'right'; g.globalAlpha = 0.8; g.shadowBlur = H * 0.07; g.fillStyle = '#d8eaf0';
    g.fillText(`/ ${this.reserve}`, W - pad, H * 0.62);
    g.globalAlpha = 1; g.shadowBlur = 0;
    if (this.progress > 0 && this.progress < 1) {
      const barY = H - lw * 3, barW = W - 2 * pad;
      g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(pad, barY, barW, lw * 1.6);
      g.fillStyle = c; g.fillRect(pad, barY, barW * this.progress, lw * 1.6);
    }
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.geometry.dispose(); }
}

/**
 * TA's first-person view: the class's arms and the weapon's 1P mesh, both skinned to the 1P skeleton and played by
 * the weapon's 1P AnimSet (Idle, Fire, reload, Retrieve...). Attached at the eye like UE3's first-person mesh.
 */
export class FirstPerson {
  readonly root = new THREE.Group();
  readonly player: SeqPlayer;
  readonly ammo: AmmoReadout;
  private placed = false;
  private wepBone: THREE.Bone | undefined;
  private wepMesh: THREE.SkinnedMesh | null = null;
  /** The authored glass the counter was anchored to, plus the size maths, for per-frame re-laying. */
  private anchor: ScreenQuad | null = null;
  private anchorK = 1;

  constructor(weapon: ModelData, hands: ModelData | null, set: AnimSet, accent: number) {
    const w = skinned(weapon), h = hands ? skinned(hands) : null;
    this.root.add(w.mesh);
    if (h) this.root.add(h.mesh);
    // UE camera space (X forward, Y right, Z up) -> three camera space (-Z forward).
    this.root.rotation.y = Math.PI / 2;
    // Uniform scale toward the eye: same picture, half the distance, so the arms poke through walls far less.
    this.root.scale.setScalar(0.5);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.renderOrder = 10; } });
    this.player = new SeqPlayer(set, h ? [w.bones, h.bones] : [w.bones]);
    this.wepBone = w.bones.get('R_WEP_root') ?? w.bones.get('Prop1');
    this.ammo = new AmmoReadout(accent);
    // The player starts on Idle's first frame: park the readout from that pose, so it sits at the same spot on the
    // weapon every time it is drawn (it then follows the weapon bone through Fire/reload/Retrieve).
    this.player.update(0);
    this.placeReadout(w.mesh, screenQuads(weapon));
    if (!this.player.play('Retrieve', false, 0)) this.player.play('Idle', true, 0);
  }

  /**
   * Lays the counter onto the screen TA authored into the weapon: the display panel where the weapon has one,
   * otherwise the scanline glass nearest the view axis. Weapons with no usable quad fall back to the receiver.
   *
   * Measured in the pose the game actually renders (Idle frame 0, bones skinned, root rotated and scaled), the
   * authored glass sits 10-36 deg off the view axis at 13-42 cm from the eye - on screen, low and right of the
   * crosshair, which is exactly where TA draws the ammo counter. So the counter is laid coplanar with that
   * glass, a few millimetres toward the eye, cut to the glass's own size, and kept upright in screen space so
   * it reads as a display and not as a tilted decal.
   */
  private placeReadout(weapon: THREE.SkinnedMesh, quads: ScreenQuad[]) {
    const bone = this.wepBone;
    // No weapon bone to parent to: the panel can never be laid, so it stays hidden. Log it - a silent
    // early-return here is indistinguishable from "the panel is on the glass but washed out".
    if (!bone) {
      if (WEP_DEBUG) console.log(`[wep] ${weapon.name ?? '?'} NO WEAPON BONE (R_WEP_root/Prop1) - readout not placed`);
      return;
    }
    this.wepMesh = weapon;
    // The root is not attached yet, so world space here is the holder's (camera) space: -Z forward, +Y up,
    // and the player's eye is the origin. Skeleton matrices come from the bones' world matrices, so refresh
    // the bone tree first, then the skinning matrices, then measure the glass in that pose.
    this.root.updateMatrixWorld(true);
    weapon.skeleton.update();
    const posed = poseQuads(weapon, quads);
    // The counter is parented to the weapon bone, so bone-local sizes are multiplied back up by the bone's
    // world scale. A weapon authored at 1:1 in the bone's space with a 0.5 root needs k = 2 to reach the
    // intended world size; a bone carrying its own scale needs less. Clamp it: an unclamped k is what let a
    // panel grow to viewport size.
    const k = THREE.MathUtils.clamp(1 / Math.max(1e-3, bone.getWorldScale(new THREE.Vector3()).x), 0.25, 4);
    let best: ScreenQuad | undefined;
    let bestScore = 0;
    for (const q of posed) {
      const m = measureQuad(q);
      // The counter is only legible on glass the player actually looks at: in front of the eye, square-on
      // enough to read, and inside the frame. Glass near a frame edge is a sight window the player aims
      // *through*; laying a panel there reads as a detached HUD, so it is not a candidate.
      //
      // TA mounts the glass at a real angle: a scope window or a side panel can sit 50-70 deg off the view axis,
      // and a 0.35 facing floor rejected every candidate on several weapons, leaving the counter on the fallback
      // plate floating in mid-air. Keep the test permissive and let the score pick the readable face.
      const skip = m.c.z > -0.10 || m.facing < 0.12 || m.off > 65 || m.fx > 0.92 || m.fy > 0.92;
      // Prefer glass the player actually looks at: square-on, big enough to read a number on, and the
      // dedicated display panel over a sight window. TA mounts the glass 18-33 deg off the view axis (it
      // sits on the weapon's left, angled in toward the eye), so the angle term is a gentle preference,
      // not a hard cut - a 12 deg half-width would reject nearly every authored screen.
      const size = THREE.MathUtils.clamp(q.w * q.h / 9e-4, 0.35, 3);
      // The weapon is held to the RIGHT of the crosshair, so the outer face sits at fx ≈ 0.6-0.75. TA mounts most
      // of the authored glass on the *inner* side (the reported fx=0.32 / x=-0.185 anchor), and that glass is the
      // real screen: a 0.06 penalty there knocked every authored screen out of the contest and left the counter on
      // the fallback plate. Keep a mild preference for the outer face, not a veto.
      const side = m.fx >= 0.45 ? 1 : 0.55;
      // TA's weapon glass is the `T_FX_ScanLines01` section on most guns (assault rifle, thumper, sniper,
      // falcon), so scanline glass is the *real* screen, not a sight window: score it like a display.
      const score = (q.display ? 2.2 : 1.9) * m.facing * size * side / (1 + (m.off / 25) ** 2);
      if (WEP_DEBUG) {
        console.log(`[wep?] ${weapon.name ?? '?'} ${skip ? 'skip' : 'pick'} off=${m.off.toFixed(1)} dist=${m.dist.toFixed(3)} ` +
          `fx=${m.fx.toFixed(2)} fy=${m.fy.toFixed(2)} facing=${m.facing.toFixed(2)} quad=${q.w.toFixed(4)}x${q.h.toFixed(4)} ` +
          `disp=${q.display} score=${score.toFixed(3)} world=(${m.c.x.toFixed(3)},${m.c.y.toFixed(3)},${m.c.z.toFixed(3)})`);
      }
      if (skip) continue;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    if (WEP_DEBUG) console.log(`[wep] ${weapon.name ?? '?'} posed=${posed.length} best=${bestScore.toFixed(3)}`);
    bone.add(this.ammo.mesh);
    // TA mounts the authored glass on the weapon's *inner* side (the reported fx=0.32 / world x=-0.185 anchor),
    // left of the crosshair and partly buried in the casing. That glass IS the original HUD, so it must not be
    // vetoed: the panel is drawn with depthTest off, so the casing cannot clip it, and tame() slides it back
    // inside the frame. Only a weapon with no usable quad at all falls to the receiver plate.
    const bestM = best ? measureQuad(best) : null;
    if (best && bestM) {
      const m = bestM;
      // The authored quad is measured in the mesh's bind-pose space; the frame caps are world units. Convert
      // through the bone's world scale so "fit the glass" and "fit the frame" speak the same units.
      const boneScale = Math.max(1e-3, bone.getWorldScale(new THREE.Vector3()).x);
      // Match the authored screen's own aspect and size, with a floor so tiny glass is still legible.
      const aspect = THREE.MathUtils.clamp(best.w / Math.max(best.h, 1e-4), 1.15, 8);
      const h = THREE.MathUtils.clamp(best.h * boneScale * 0.9, viewHeight(m.dist) * FRAME_H * 0.5, 0.11 / aspect);
      this.layOn(bone, m.c.clone().addScaledVector(m.n, 0.006), m.n, h * aspect, h);
      // Then clamp against the live world transform: the pose the game renders is not the pose measured here,
      // so the panel is shrunk and nudged back into frame rather than discarded.
      const { wp, ws } = this.tame(bone, k);
      this.ammo.mesh.visible = true;
      // Remember the glass: Fire/reload poses and the walk bob carry the weapon bone tens of millimetres off
      // the Idle pose this was measured in, and a counter fixed in bone space drifts off the screen it is
      // supposed to fill. update() re-lays it onto the glass in the live pose every frame.
      this.anchor = best;
      this.anchorK = k;
      if (WEP_DEBUG) {
        console.log(`[wep] ${weapon.name ?? '?'} anchored off=${m.off.toFixed(1)} dist=${m.dist.toFixed(3)} ` +
          `fx=${m.fx.toFixed(2)} fy=${m.fy.toFixed(2)} k=${k.toFixed(2)} boneScale=${bone.getWorldScale(new THREE.Vector3()).x.toFixed(3)} ` +
          `quad=${best.w.toFixed(4)}x${best.h.toFixed(4)} disp=${best.display} ` +
          `world=(${wp.x.toFixed(3)},${wp.y.toFixed(3)},${wp.z.toFixed(3)}) size=(${ws.x.toFixed(4)}x${ws.y.toFixed(4)})`);
      }
    }
    if (!best) {
      // No authored screen we can trust (shocklance, edge-on sights): sit the counter on the receiver
      // where the idle pose holds it, inside the frame and small.
      this.anchor = null;
      const D = 0.42;
      const at = new THREE.Vector3(0.13, -0.11, -D);
      this.layOn(bone, at, at.clone().negate().normalize(), viewWidth(D) * 0.11, viewHeight(D) * 0.055);
      const { wp, ws } = this.tame(bone, k);
      this.ammo.mesh.visible = true;
      if (WEP_DEBUG) {
        console.log(`[wep] ${weapon.name ?? '?'} fallback k=${k.toFixed(2)} boneScale=${bone.getWorldScale(new THREE.Vector3()).x.toFixed(3)} ` +
          `world=(${wp.x.toFixed(3)},${wp.y.toFixed(3)},${wp.z.toFixed(3)}) size=(${ws.x.toFixed(4)}x${ws.y.toFixed(4)})`);
      }
    }
    this.placed = true;
  }

  /**
   * Counter pose for a camera-space point and facing: converted into the bone's space. The basis is built from
   * the glass normal and the screen's up vector, so the counter lies on the glass yet stays upright.
   */
  private layOn(bone: THREE.Bone, at: THREE.Vector3, face: THREE.Vector3, worldW: number, worldH: number) {
    const z = face.clone().normalize();
    const x = new THREE.Vector3(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = z.clone().cross(x).normalize();
    this.ammo.mesh.position.copy(bone.worldToLocal(at));
    const qb = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.ammo.mesh.quaternion.copy(qb.multiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))));
    this.ammo.mesh.frustumCulled = false;
    // Panel size in world units, capped to a fraction of the frame (FRAME_W/FRAME_H) so it can never flood the
    // viewport. The caps are generous enough to keep the digits legible on a glowing glass, while a panel
    // measured close to the eye that is carried out by a bone scale is still reined in by tame().
    const dist = Math.max(0.05, -at.z);
    const s = Math.min(1, (viewWidth(dist) * FRAME_W) / Math.max(worldW, 1e-6), (viewHeight(dist) * FRAME_H) / Math.max(worldH, 1e-6));
    // `fit()` sets the mesh's scale in BONE-LOCAL units, so convert the world size through the bone's world
    // scale (0.5 for the first-person root). Passing world units straight through made the panel half the
    // intended size, and reanchor() - which measures the live *world* scale and feeds it back here - then
    // halved it every frame until it was sub-pixel: the "nothing on the weapon" report.
    const boneScale = Math.max(1e-3, bone.getWorldScale(new THREE.Vector3()).x);
    this.ammo.fit(worldW * s / boneScale, worldH * s / boneScale);
  }

  /**
   * Bring the counter inside the frame. A bone scale or a pose we did not measure can leave the panel off
   * frame or at viewport size, and both read as a detached HUD - so shrink it to the frame caps and slide it
   * back toward the crosshair. Hiding it outright is not an option: an invisible ammo counter is worse than
   * an imperfect one, which is what the earlier "reject if off frame" rule produced.
   */
  private tame(bone: THREE.Bone, k: number) {
    let wp = new THREE.Vector3();
    let ws = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      this.root.updateMatrixWorld(true);
      this.wepMesh?.skeleton.update();
      wp = this.ammo.mesh.getWorldPosition(new THREE.Vector3());
      ws = this.ammo.mesh.getWorldScale(new THREE.Vector3());
      const d = Math.max(0.05, -wp.z);
      const over = Math.max(ws.x / (viewWidth(d) * FRAME_W), ws.y / (viewHeight(d) * FRAME_H));
      // fit() sets the mesh's bone-local scale; ws is the world scale, so convert through the bone scale.
      if (over > 1) this.ammo.fit(ws.x * k / over, ws.y * k / over);
      const dx = Math.max(0, Math.abs(wp.x) - viewWidth(d) * 0.40) * (wp.x < 0 ? -1 : 1);
      const dy = Math.max(0, Math.abs(wp.y) - viewHeight(d) * 0.40) * (wp.y < 0 ? -1 : 1);
      const dz = wp.z > -0.16 ? wp.z + 0.16 : 0;
      if (over <= 1 && !dx && !dy && !dz) break;
      const a = bone.worldToLocal(wp.clone());
      const b = bone.worldToLocal(wp.clone().add(new THREE.Vector3(-dx, -dy, -dz)));
      this.ammo.mesh.position.add(b.sub(a));
    }
    return { wp, ws };
  }

  /**
   * Re-lay the counter onto the authored glass in the pose the weapon is in right now. `placeReadout` measures
   * the Idle frame-0 pose, but Fire/reload/Retrieve and the walk bob swing the weapon bone tens of millimetres
   * and tens of degrees off that pose, and a counter pinned in bone space then floats off the screen it is
   * meant to fill - the "ammo is offset from the glass" report. Re-measuring the anchor quad each frame and
   * re-deriving the placement keeps the panel on the glass through every pose.
   */
  private reanchor() {
    const bone = this.wepBone, weapon = this.wepMesh, q = this.anchor;
    if (!bone || !weapon || !q) return;
    this.root.updateMatrixWorld(true);
    weapon.skeleton.update();
    const [live] = poseQuads(weapon, [q]);
    if (!live) return;
    const m = measureQuad(live);
    // Keep the size the Idle placement settled on (the tame loop may have shrunk it); only the pose moves.
    const ws = this.ammo.mesh.getWorldScale(new THREE.Vector3());
    const d = Math.max(0.05, -m.c.z);
    const s = Math.min(1, (viewWidth(d) * FRAME_W) / Math.max(ws.x, 1e-6), (viewHeight(d) * FRAME_H) / Math.max(ws.y, 1e-6));
    this.layOn(bone, m.c.clone().addScaledVector(m.n, 0.006), m.n, ws.x * s, ws.y * s);
    this.tame(bone, this.anchorK);
  }

  update(dt: number, clip: number, reserve: number, progress = 0) {
    this.player.update(dt);
    this.ammo.set(clip, reserve, progress);
    if (this.placed) this.reanchor();
  }

  dispose() { this.ammo.dispose(); }
}

/** Builds the TA first-person view for an item when its 1P mesh, arms and animations were imported. */
export async function firstPersonFor(itemId: string, armor: 'light' | 'medium' | 'heavy', team: number): Promise<FirstPerson | null> {
  const key = weaponModelKey(itemId);
  if (!key) return null;
  const [wm, hm, set] = await Promise.all([models.get(`${key}_1p`), models.get(`hands_${armor}_${team === 1 ? 1 : 0}`), anims.get(`${key}_1p`)]);
  if (!wm || !set) return null;
  const accent = projDef(itemId)?.color ?? (ITEMS[itemId]?.kind === 'lance' ? 0x9fe8ff : 0x7fffb0);
  return new FirstPerson(wm, hm, set, accent);
}

type Archetype = 'spinfusor' | 'launcher' | 'mortar' | 'sniper' | 'rifle' | 'smg' | 'shotgun' | 'pistol' | 'chaingun' | 'lance' | 'repair' | 'plasma';

function archetype(id: string): Archetype {
  const it = ITEMS[id];
  if (!it) return 'rifle';
  if (it.kind === 'lance') return 'lance';
  if (it.kind === 'repair') return 'repair';
  if (it.spinup) return 'chaingun';
  const model = it.projectile?.model;
  if (model === 'disc') return 'spinfusor';
  if (model === 'mortar') return 'mortar';
  if (model === 'plasma' || model === 'nova') return 'plasma';
  if (it.projectile) return model === 'knife' ? 'pistol' : 'launcher';
  if (it.zoom) return 'sniper';
  if ((it.hitscan?.pellets ?? 1) > 1) return 'shotgun';
  if (/pistol|sn7|falcon|eagle|sparrow|colt/.test(id)) return 'pistol';
  if (/smg|nj4|nj5|rhino|tcn4/.test(id)) return 'smg';
  return 'rifle';
}

/**
 * Procedural first-person weapon: an armored glove holding a weapon shaped after the item's family
 * (spinfusor, launcher, rifle, chain gun, ...) with a glowing accent in the projectile colour.
 */
export function buildViewModel(itemId: string, finishId: string, who?: { armor: 'light' | 'medium' | 'heavy'; team: number }): THREE.Group {
  const g = new THREE.Group();
  const finish = WEAPON_FINISHES.find((f) => f.id === finishId);
  const tint = finish?.tint ?? 0x5a626c;
  // A little emissive fill keeps the weapon readable when the sun is behind the player.
  const metal = ownMaterial(shared(`vm-metal|${tint}|${Math.min(0.6, finish?.metalness ?? 0.6)}`, () => new THREE.MeshStandardMaterial({ color: tint, metalness: Math.min(0.6, finish?.metalness ?? 0.6), roughness: 0.4, emissive: tint, emissiveIntensity: 0.22 })));
  const dark = ownMaterial(shared('vm-dark', () => new THREE.MeshStandardMaterial({ color: 0x30363d, metalness: 0.4, roughness: 0.55, emissive: 0x30363d, emissiveIntensity: 0.25 })));
  const glove = ownMaterial(shared('vm-glove', () => new THREE.MeshStandardMaterial({ color: 0x4a4236, metalness: 0.1, roughness: 0.8, emissive: 0x4a4236, emissiveIntensity: 0.2 })));
  const accentColor = projDef(itemId)?.color ?? (ITEMS[itemId]?.kind === 'lance' ? 0x9fe8ff : ITEMS[itemId]?.kind === 'repair' ? 0x60ff90 : 0xffb547);
  const glow = ownMaterial(shared(`vm-glow|${accentColor}`, () => new THREE.MeshBasicMaterial({ color: accentColor })));

  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const tube = (r: number, len: number, m: THREE.Material, x: number, y: number, z: number, seg = 14, r2 = r) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, len, seg), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const ring = (r: number, t: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 24), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };

  const a = archetype(itemId);
  // Grip and glove (shared).
  box(0.035, 0.09, 0.045, dark, 0, -0.07, 0.05).rotation.x = -0.25;
  box(0.06, 0.07, 0.09, glove, 0.004, -0.085, 0.07);
  box(0.075, 0.08, 0.18, glove, 0.02, -0.12, 0.17).rotation.x = 0.15;

  switch (a) {
    case 'spinfusor': {
      box(0.075, 0.07, 0.34, metal, 0, 0, -0.06);
      box(0.11, 0.025, 0.2, dark, 0, 0.045, -0.12);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.018, 24), glow);
      disc.position.set(0, 0.075, -0.17);
      disc.name = 'spin';
      g.add(disc);
      ring(0.085, 0.01, metal, 0, 0.075, -0.17).rotation.x = Math.PI / 2;
      box(0.015, 0.05, 0.26, metal, 0.06, 0.04, -0.12);
      box(0.015, 0.05, 0.26, metal, -0.06, 0.04, -0.12);
      break;
    }
    case 'launcher':
    case 'mortar': {
      const r = a === 'mortar' ? 0.06 : 0.045;
      box(0.08, 0.08, 0.26, metal, 0, 0, -0.02);
      tube(r, 0.42, metal, 0, 0.04, -0.2);
      tube(r * 0.7, 0.02, glow, 0, 0.04, -0.415);
      ring(r + 0.008, 0.007, glow, 0, 0.04, -0.33);
      box(0.03, 0.03, 0.12, dark, 0, 0.1, -0.08);
      break;
    }
    case 'plasma': {
      box(0.07, 0.075, 0.26, metal, 0, 0, -0.04);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), glow);
      core.position.set(0, 0.06, -0.12);
      g.add(core);
      ring(0.045, 0.008, metal, 0, 0.06, -0.12).rotation.y = Math.PI / 2;
      tube(0.022, 0.24, dark, 0, 0.02, -0.28);
      tube(0.014, 0.02, glow, 0, 0.02, -0.4);
      break;
    }
    case 'sniper': {
      box(0.06, 0.07, 0.3, metal, 0, 0, 0);
      tube(0.014, 0.62, dark, 0, 0.02, -0.42);
      tube(0.028, 0.2, dark, 0, 0.085, -0.06);
      tube(0.02, 0.01, glow, 0, 0.085, -0.165);
      box(0.05, 0.06, 0.16, dark, 0, -0.01, 0.2);
      break;
    }
    case 'chaingun': {
      box(0.11, 0.1, 0.24, metal, 0, 0, -0.02);
      const barrels = new THREE.Group();
      barrels.name = 'spin';
      for (let i = 0; i < 6; i++) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.36, 8), dark);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(i * Math.PI / 3) * 0.032, Math.sin(i * Math.PI / 3) * 0.032, 0);
        barrels.add(b);
      }
      barrels.position.set(0, 0.02, -0.3);
      g.add(barrels);
      ring(0.046, 0.008, metal, 0, 0.02, -0.42);
      box(0.05, 0.08, 0.1, dark, -0.07, -0.02, 0.0);
      break;
    }
    case 'shotgun': {
      box(0.075, 0.075, 0.26, metal, 0, 0, -0.02);
      tube(0.022, 0.32, dark, -0.013, 0.035, -0.26);
      tube(0.022, 0.32, dark, 0.013, 0.035, -0.26);
      box(0.06, 0.04, 0.12, dark, 0, -0.01, -0.22);
      box(0.012, 0.012, 0.1, glow, 0, 0.068, -0.05);
      break;
    }
    case 'pistol': {
      box(0.045, 0.055, 0.2, metal, 0, 0.005, -0.06);
      tube(0.012, 0.06, dark, 0, 0.015, -0.18);
      box(0.008, 0.008, 0.08, glow, 0, 0.035, -0.06);
      break;
    }
    case 'lance':
    case 'repair': {
      box(0.07, 0.07, 0.22, metal, 0, 0, -0.02);
      for (const s of [-1, 1]) {
        const prong = box(0.012, 0.012, 0.2, dark, s * 0.03, 0.03, -0.2);
        prong.rotation.y = -s * 0.12;
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(a === 'lance' ? 0.025 : 0.02, 12, 8), glow);
      tip.position.set(0, 0.03, -0.3);
      g.add(tip);
      break;
    }
    default: { // rifle / smg
      const long = a === 'rifle';
      box(0.06, 0.07, long ? 0.32 : 0.24, metal, 0, 0, -0.04);
      tube(0.013, long ? 0.26 : 0.16, dark, 0, 0.02, long ? -0.33 : -0.24);
      box(0.03, 0.09, 0.05, dark, 0, -0.06, -0.08).rotation.x = 0.2;
      box(0.025, 0.02, 0.12, dark, 0, 0.05, -0.04);
      box(0.01, 0.01, 0.06, glow, 0, 0.064, -0.04);
      if (long) box(0.045, 0.05, 0.12, dark, 0, -0.01, 0.17);
    }
  }
  const holder = new THREE.Group();
  g.position.set(0.2, -0.19, -0.5);
  g.scale.setScalar(0.8);
  g.rotation.y = 0.04;
  holder.add(g);
  holder.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.renderOrder = 10; } });
  // Swap in the original 3P weapon mesh when imported, and TA's full first-person arms + weapon when those are.
  const key = weaponModelKey(itemId);
  let real: THREE.Object3D | null = null;
  // The imported weapon arrives in bind pose (no arms). Shown on its own it flashes as a floating prop for a
  // beat before the posed 1P view lands, so it stays hidden until the arms are on screen.
  const posed = !!who;
  let fpFailed = false;
  let fpPending = posed;
  g.visible = !posed;
  if (key) void models.get(key).then((m) => {
    if (!m || !holder.parent || holder.userData.fp) return;
    real = staticModel(m, undefined, 0.45);
    real.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    real.position.set(0.15, -0.17, -0.36);
    real.scale.setScalar(0.42);
    real.visible = fpFailed || !posed;
    g.visible = !real.visible && !fpPending;
    holder.add(real);
  });
  if (who) void firstPersonFor(itemId, who.armor, who.team).then((fp) => {
    fpPending = false;
    if (!fp) {
      // No 1P arms for this item: fall back to the bind-pose weapon rather than a permanent placeholder.
      fpFailed = true;
      if (real) real.visible = true;
      g.visible = !real;
      return;
    }
    if (!holder.parent) { fp.dispose(); return; }
    holder.userData.fp = fp;
    g.visible = false;
    if (real) real.visible = false;
    holder.add(fp.root);
  });
  return holder;
}

/** Spin barrels / disc of a viewmodel built by buildViewModel. */
export function spinViewModel(vm: THREE.Object3D, amount: number, dt: number) {
  const s = vm.getObjectByName('spin');
  if (!s) return;
  if (s instanceof THREE.Group) s.rotation.z += amount * dt * 40;
  else s.rotation.y += dt * 6;
}

/** Cloaked (stealth pack) first-person view: arms and weapon turn into a faint, shimmering glass silhouette, as in TA. */
export function setViewModelStealth(vm: THREE.Object3D, on: boolean, time: number) {
  if (!on && !vm.userData.stealthed) return;
  vm.userData.stealthed = on;
  const shimmer = 0.26 + Math.sin(time * 5) * 0.05;
  vm.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(mm) ? mm : mm ? [mm] : []) {
      const std = m as THREE.MeshStandardMaterial, u = m.userData;
      u.cloak ??= { opacity: m.opacity, transparent: m.transparent, emissive: std.emissive?.getHex(), ei: std.emissiveIntensity };
      const b = u.cloak as { opacity: number; transparent: boolean; emissive?: number; ei?: number };
      if (on) {
        if (!m.transparent) { m.transparent = true; m.needsUpdate = true; }
        m.opacity = b.opacity * shimmer;
        if (std.emissive) { std.emissive.setHex(0x4a90c8); std.emissiveIntensity = 0.45; }
      } else {
        m.transparent = b.transparent; m.opacity = b.opacity; m.needsUpdate = true;
        if (std.emissive && b.emissive !== undefined) { std.emissive.setHex(b.emissive); std.emissiveIntensity = b.ei ?? 1; }
        delete u.cloak;
      }
    }
  });
}

export function disposeViewModel(vm: THREE.Object3D) {
  (vm.userData.fp as FirstPerson | undefined)?.dispose();
  const mats = new Set<THREE.Material>();
  vm.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.userData.sharedGeometry) m.geometry.dispose();
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm);
  });
  for (const m of mats) if (!isSharedMaterial(m)) m.dispose();
}
