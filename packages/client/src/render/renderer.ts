import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { settings } from '../settings.js';

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

/** Replaces NaN/Inf pixels (they turn into growing black blocks in the bloom mip chain) and clamps fireflies. */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 24.0), 1.0); }`,
};

/** Lightweight display-space grade: contrast, saturation, vignette and an optional sharpen ("full"). */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uSharpen: { value: 0 }, uVignette: { value: 0.28 }, uContrast: { value: 1.06 }, uSaturation: { value: 1.08 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharpen, uVignette, uContrast, uSaturation; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (uSharpen > 0.0) {
        vec3 n = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
          + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        c = c + (c - n * 0.25) * uSharpen;
      }
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.35, 0.85, length(d * vec2(1.0, 0.8)) * 1.25);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0); }`,
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  width = 1;
  height = 1;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.antialias && !settings.bloom, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.toneMappingExposure = 1.05 * settings.brightness;
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
    if (settings.bloom || settings.post !== 'off') {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: settings.antialias ? 4 : 0 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      if (settings.bloom) {
        this.composer.addPass(new ShaderPass(SanitizeShader));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.4, 0.9);
        this.composer.addPass(this.bloom);
      }
      this.composer.addPass(new OutputPass());
      if (settings.post !== 'off') {
        this.grade = new ShaderPass(GradeShader);
        this.grade.uniforms.uSharpen.value = settings.post === 'full' ? 0.35 : 0;
        this.grade.uniforms.uVignette.value = settings.post === 'full' ? 0.32 : 0.22;
        this.composer.addPass(this.grade);
      }
    }
    this.applySaturation();
    this.camera.far = Math.max(1500, settings.viewDistance * 2.5);
    this.resize();
  }

  private sat = 1;
  /** 1 = normal colour, 0 = greyscale (TA greys the world while dead or waiting for players). */
  setSaturation(s: number) {
    if (Math.abs(s - this.sat) < 0.01) return;
    this.sat = s;
    this.applySaturation();
  }

  private applySaturation() {
    if (this.grade) this.grade.uniforms.uSaturation.value = 1.08 * this.sat;
    this.canvas.style.filter = !this.grade && this.sat < 0.99 ? `grayscale(${(1 - this.sat).toFixed(2)})` : '';
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.width = w; this.height = h;
    const pr = Math.max(0.25, Math.min(2.5, settings.renderScale));
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer?.setPixelRatio(pr);
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w * pr, h * pr);
    this.grade?.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr));
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
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
