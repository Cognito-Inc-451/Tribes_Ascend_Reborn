import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { settings, type ColorGrade } from '../settings.js';
import { installHeightFog } from './fog.js';
import { PostPipeline } from './post.js';

installHeightFog();

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** Neutral prefiltered environment: gives PBR materials ambient specular/diffuse so unlit sides are not black. */
export function studioEnvironment(r: THREE.WebGLRenderer): THREE.Texture {
  let t = envCache.get(r);
  if (!t) {
    const pmrem = new THREE.PMREMGenerator(r);
    t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    envCache.set(r, t);
  }
  return t;
}

/** Lift / gamma / gain looks applied in display space after tone mapping. */
const GRADES: Record<ColorGrade, { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number]; vibrance?: number }> = {
  neutral: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] },
  // Slightly cool shadows, warm highlights: close to TA's own colour treatment.
  ascend: { lift: [0, 0.004, 0.014], gamma: [1, 1, 1], gain: [1.03, 1.0, 0.97] },
  cinematic: { lift: [0, 0.016, 0.03], gamma: [1.0, 1.0, 0.97], gain: [1.07, 0.99, 0.9] },
  vivid: { lift: [0, 0, 0], gamma: [1.02, 1.02, 1.02], gain: [1.03, 1.03, 1.03], vibrance: 0.3 },
  bleach: { lift: [0.01, 0.01, 0.01], gamma: [1.08, 1.08, 1.08], gain: [1.04, 1.04, 1.04], vibrance: -0.35 },
};

const TONE: Record<typeof settings.toneMapping, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, cineon: THREE.CineonToneMapping,
};

/** Shadow map size per quality step. */
export const SHADOW_RES: Record<typeof settings.shadowQuality, number> = { off: 0, low: 1024, medium: 2048, high: 2048, ultra: 4096 };

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private post: PostPipeline | null = null;
  private lastFrame = performance.now();
  width = 1;
  height = 1;

  constructor(private container: HTMLElement) {
    // MSAA happens in the post chain's render target when post-processing is on.
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.antialias && settings.post === 'off', powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = TONE[settings.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = settings.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 6000);
    this.scene.add(this.camera);
    this.scene.environment = studioEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.35;
    this.configure();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas() { return this.renderer.domElement; }

  /** Rebuild post-processing after a settings change. */
  configure() {
    settings.shadows = settings.shadowQuality !== 'off';
    this.renderer.shadowMap.enabled = settings.shadows;
    const shadowType = settings.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== shadowType) { this.renderer.shadowMap.type = shadowType; this.renderer.shadowMap.needsUpdate = true; }
    this.renderer.toneMapping = TONE[settings.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05 * settings.brightness;
    this.post?.dispose();
    this.post = null;
    if (settings.post !== 'off') {
      const g = GRADES[settings.grade] ?? GRADES.neutral;
      this.post = new PostPipeline(this.renderer, {
        hdr: settings.hdr, msaa: settings.antialias ? 4 : 0, bloom: settings.bloom ? settings.bloomStrength : 0,
        ao: settings.ao === 'high' ? 2 : settings.ao === 'low' ? 1 : 0, godrays: settings.godrays ? 0.4 : 0, dof: settings.dof,
        motionBlur: settings.motionBlur, ssr: settings.ssr, exposure: 1, contrast: settings.contrast, saturation: settings.saturation,
        vibrance: settings.vibrance + (g.vibrance ?? 0), temperature: settings.temperature, tint: settings.tint,
        lift: new THREE.Vector3(...g.lift), gamma: new THREE.Vector3(...g.gamma), gain: new THREE.Vector3(...g.gain),
        vignette: settings.vignette, grain: settings.filmGrain, chromatic: settings.chromatic, sharpen: settings.post === 'full' ? Math.max(0.35, settings.sharpen) : settings.sharpen,
      });
      this.post.sunDir.copy(this.sunDir);
    }
    this.applySaturation();
    this.camera.far = Math.max(1500, settings.viewDistance * 2.5);
    this.resize();
  }

  private sunDir = new THREE.Vector3(0, 1, 0);
  /** Direction towards the sun (god rays). */
  setSun(dir: THREE.Vector3) {
    this.sunDir.copy(dir).normalize();
    this.post?.sunDir.copy(this.sunDir);
  }

  /** Scoped zoom focus distance for depth of field (0 = none). */
  setFocus(m: number) { if (this.post) this.post.focus = m; }

  private sat = 1;
  /** 1 = normal colour, 0 = greyscale (TA greys the world while dead or waiting for players). */
  setSaturation(s: number) {
    if (Math.abs(s - this.sat) < 0.01) return;
    this.sat = s;
    this.applySaturation();
  }

  private applySaturation() {
    this.post?.setSaturation(this.sat);
    this.canvas.style.filter = !this.post && this.sat < 0.99 ? `grayscale(${(1 - this.sat).toFixed(2)})` : '';
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.width = w; this.height = h;
    const pr = Math.max(0.25, Math.min(2.5, settings.renderScale));
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.post?.setSize(w * pr, h * pr);
    this.setFov(settings.fov);
  }

  /** TA-style horizontal FOV, converted for any aspect ratio (ultrawide keeps the same vertical feel). */
  setFov(hfovDeg: number, zoom = 1) {
    const aspect = this.width / Math.max(1, this.height);
    const baseAspect = 16 / 9;
    const h = THREE.MathUtils.degToRad(hfovDeg) * zoom;
    const v = 2 * Math.atan(Math.tan(h / 2) / baseAspect);
    this.camera.fov = THREE.MathUtils.radToDeg(v);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  render() {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.post) this.post.render(this.scene, this.camera, dt);
    else { this.renderer.setRenderTarget(null); this.renderer.render(this.scene, this.camera); }
  }
}
