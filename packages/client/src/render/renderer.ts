import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { settings, type ColorGrade } from '../settings.js';
import { installHeightFog } from './fog.js';
import { PostPipeline, structuralKey, type PostOptions } from './post.js';

installHeightFog();

/**
 * The pixel ratio the renderer aims at when adaptive resolution is happy. Tied to the display's
 * own scale factor: a HiDPI panel gets its sharpness, a normal panel stays at 1:1, and a 2x bill
 * on a HiDPI panel is capped because it quadruples the pixel cost for a barely visible gain.
 */
export function renderCeiling(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

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

/**
 * Index into post.ts's TONE_DEFINE. The post chain tone maps inside FINAL_FRAG (three compiles
 * tone mapping out of every draw into a render target), so the shader needs the same curve the
 * renderer is configured with.
 */
const TONE_INDEX: Record<typeof settings.toneMapping, 0 | 1 | 2 | 3> = { aces: 0, agx: 1, neutral: 2, cineon: 3 };

/** Shadow map size per quality step. */
export const SHADOW_RES: Record<typeof settings.shadowQuality, number> = { off: 0, low: 1024, medium: 2048, high: 2048, ultra: 4096 };

/**
 * Is the WebGPU backend available in this browser? Ray tracing needs it (compute shaders and
 * ray-tracing pipelines); the client renders through WebGL today, so the RT toggles resolve to
 * raster fallbacks until a WebGPU renderer lands.
 */
export const webgpuAvailable: boolean = typeof (navigator as { gpu?: unknown }).gpu !== 'undefined';

/**
 * What the three ray-tracing toggles actually buy on this backend. Each one is honoured for real
 * only under WebGPU; on WebGL it degrades to the best raster approximation the chain has, so the
 * player can set the toggles today and get the traced behaviour for free once WebGPU ships.
 */
export interface RtState {
  /** Ray-traced shadows active (WebGPU). On WebGL: soft shadow maps forced on. */
  rtShadows: boolean;
  /** Ray-traced reflections active (WebGPU). On WebGL: screen-space reflections forced on. */
  rtReflections: boolean;
  /** Ray-traced GI active (WebGPU). On WebGL: sky environment IBL + high AO forced on. */
  rtGI: boolean;
  /** True when the toggles resolve to raster fallbacks rather than real tracing. */
  fallback: boolean;
}

export function resolveRt(): RtState {
  const gpu = webgpuAvailable;
  return {
    rtShadows: gpu && settings.rtShadows,
    rtReflections: gpu && settings.rtReflections,
    rtGI: gpu && settings.rtGI,
    fallback: !gpu && (settings.rtShadows || settings.rtReflections || settings.rtGI),
  };
}

/** Ambient intensity with the sky-based IBL installed, versus the neutral studio fallback. */
const SKY_ENV_INTENSITY = 0.7;
const STUDIO_ENV_INTENSITY = 0.35;

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
    this.scene.environmentIntensity = STUDIO_ENV_INTENSITY;
    this.configure();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas() { return this.renderer.domElement; }

  private skyEnv: THREE.Texture | null = null;
  /** Adaptive-resolution multiplier (1 = render at the display's own scale). */
  private adaptScale = 1;
  /**
   * Install a world's prefiltered sky as the scene environment, so PBR ambient comes from the
   * authored sky art (TA's look) instead of the neutral studio room. Pass null to fall back.
   */
  setSkyEnvironment(tex: THREE.Texture | null) {
    if (tex) {
      this.skyEnv = tex;
      this.scene.environment = tex;
      this.scene.environmentIntensity = SKY_ENV_INTENSITY;
    } else {
      this.skyEnv = null;
      this.scene.environment = studioEnvironment(this.renderer);
      this.scene.environmentIntensity = STUDIO_ENV_INTENSITY;
    }
  }

  /**
   * Refresh post-processing after a settings change. The chain is rebuilt only when its
   * *structural* shape changes (targets/defines); slider-only changes are applied in place.
   */
  configure() {
    settings.shadows = settings.shadowQuality !== 'off';
    this.renderer.shadowMap.enabled = settings.shadows;
    const rt = resolveRt();
    // RT Shadows on WebGL: best raster stand-in is the soft shadow filter.
    const shadowType = (settings.softShadows || (!rt.rtShadows && settings.rtShadows)) ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== shadowType) { this.renderer.shadowMap.type = shadowType; this.renderer.shadowMap.needsUpdate = true; }
    this.renderer.toneMapping = TONE[settings.toneMapping] ?? THREE.ACESFilmicToneMapping;
    // With post on, FINAL_FRAG tone maps itself (uExposure carries the brightness) and three
    // applies tone mapping to no draw at all, so keep the renderer's exposure neutral there.
    this.renderer.toneMappingExposure = settings.post === 'off' ? 1.05 * settings.brightness : 1;
    const opts = this.postOptions();
    if (opts) {
      if (this.post && this.post.structuralKey === structuralKey(opts)) {
        this.post.update(opts);
      } else {
        this.post?.dispose();
        this.post = new PostPipeline(this.renderer, opts);
        this.post.sunDir.copy(this.sunDir);
      }
    } else {
      this.post?.dispose();
      this.post = null;
    }
    this.applySaturation();
    this.camera.far = Math.max(1500, settings.viewDistance * 2.5);
    this.resize();
  }

  /** Current settings as post-chain options; null when post-processing is off. */
  private postOptions(): PostOptions | null {
    if (settings.post === 'off') return null;
    const g = GRADES[settings.grade] ?? GRADES.neutral;
    const rt = resolveRt();
    return {
      hdr: settings.hdr, msaa: settings.antialias ? 4 : 0, bloom: settings.bloom ? settings.bloomStrength : 0,
      // RT GI on WebGL falls back to the strongest raster ambient occlusion the chain offers.
      ao: rt.rtGI ? 2 : settings.ao === 'high' ? 2 : settings.ao === 'low' ? 1 : 0, godrays: settings.godrays ? 0.4 : 0, dof: settings.dof,
      // RT Reflections on WebGL falls back to the screen-space reflection pass.
      motionBlur: settings.motionBlur, ssr: settings.ssr || rt.rtReflections, fsr: settings.fsr, frameGen: settings.frameGen,
      // FINAL_FRAG tone maps in-shader, so it carries the exposure the Brightness slider sets
      // (1.05 baseline matches the no-post path).
      exposure: 1.05 * settings.brightness, tone: TONE_INDEX[settings.toneMapping] ?? 0,
      contrast: settings.contrast, saturation: settings.saturation,
      vibrance: settings.vibrance + (g.vibrance ?? 0), temperature: settings.temperature, tint: settings.tint,
      lift: new THREE.Vector3(...g.lift), gamma: new THREE.Vector3(...g.gamma), gain: new THREE.Vector3(...g.gain),
      vignette: settings.vignette, grain: settings.filmGrain, chromatic: settings.chromatic,
      // "Light" post is the cheap chain: no unsharp mask (menus label "full" as "On + sharpen").
      sharpen: settings.post === 'full' ? settings.sharpen : 0,
    };
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

  /** `?gfxlog`: every scene-wide brightness knob at once, for live flicker attribution. */
  brightnessState() {
    return {
      sat: this.sat,
      exposure: this.renderer.toneMappingExposure,
      env: this.scene.environmentIntensity,
      sky: !!this.skyEnv,
      scale: this.adaptScale,
      post: !!this.post,
    };
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.width = w; this.height = h;
    // Adaptive resolution owns the pixel ratio: the display's own scale is the ceiling and the
    // frame-rate controller can only scale that down.
    const pr = Math.max(0.25, Math.min(2.5, renderCeiling() * this.adaptScale));
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.post?.setSize(w * pr, h * pr, w, h);
    this.setFov(settings.fov);
  }

  /** Applied by the frame-rate controller; 1 disables the effect. */
  setAdaptiveScale(scale: number) {
    const s = Math.max(0.25, Math.min(2.5, scale));
    /* The controller moves on a 0.05 grid; anything finer than that is noise. Reacting to
       a 0.002 change re-creates every render target on each step, which drops the motion
       history and makes the whole image flicker. */
    if (Math.abs(s - this.adaptScale) < 0.045) return;
    this.adaptScale = s;
    this.resize();
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

  /** True when the post pipeline is ready to present a frame-generated (interpolated) frame. */
  get wantsGeneratedFrame(): boolean {
    return this.post?.wantsGeneratedFrame === true;
  }

  render() {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.post) this.post.render(this.scene, this.camera, dt);
    else { this.renderer.setRenderTarget(null); this.renderer.render(this.scene, this.camera); }
  }
}

