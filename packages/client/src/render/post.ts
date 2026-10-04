import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Everything the post chain can do; values come from settings (see Renderer.configure). */
export interface PostOptions {
  hdr: boolean;
  msaa: number;
  bloom: number;          // strength, 0 = off
  ao: 0 | 1 | 2;          // off / SSAO 8 taps / SSAO 16 taps
  godrays: number;        // intensity, 0 = off
  dof: boolean;
  motionBlur: number;     // shutter fraction, 0 = off
  ssr: boolean;           // screen-space reflections on water
  exposure: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;    // -1 cool .. +1 warm
  tint: number;           // -1 green .. +1 magenta
  lift: THREE.Vector3;
  gamma: THREE.Vector3;
  gain: THREE.Vector3;
  vignette: number;
  grain: number;
  chromatic: number;
  sharpen: number;
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** NaN/Inf texels (degenerate normals, depth at silhouettes) must never reach a blur: they grow into black blocks. */
const CLEAN = `
  vec3 clean3(vec3 v) { return (any(isnan(v)) || any(isinf(v))) ? vec3(0.0) : v; }
  float clean1(float v, float def) { return (isnan(v) || isinf(v)) ? def : v; }`;

const VIEWPOS = `
  uniform sampler2D tDepth; uniform mat4 uInvProj;
  vec3 viewPos(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }`;

/** Alchemy-style SSAO from depth only (normals rebuilt from neighbours), at half resolution. */
const AO_FRAG = `varying vec2 vUv; ${VIEWPOS}${CLEAN}
  uniform mat4 uProj; uniform vec2 uTexel; uniform float uRadius; uniform float uIntensity; uniform float uFrame;
  void main() {
    float d0 = texture2D(tDepth, vUv).x;
    vec3 p = viewPos(vUv);
    if (d0 >= 0.99999 || -p.z > 160.0) { gl_FragColor = vec4(1.0); return; }
    vec3 pr = viewPos(vUv + vec2(uTexel.x, 0.0)), pl = viewPos(vUv - vec2(uTexel.x, 0.0));
    vec3 pu = viewPos(vUv + vec2(0.0, uTexel.y)), pd = viewPos(vUv - vec2(0.0, uTexel.y));
    vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
    vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
    vec3 n = normalize(cross(dx, dy));
    if (any(isnan(n)) || any(isinf(n)) || dot(n, n) < 0.5) { gl_FragColor = vec4(1.0); return; }
    float rpx = uRadius * uProj[1][1] * 0.5 / max(0.1, -p.z);
    float rnd = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238, vec2(0.06711056, 0.00583715))));
    float sum = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float f = (float(i) + 0.5) / float(SAMPLES);
      float a = (float(i) + rnd) * 2.39996323;
      vec2 suv = vUv + vec2(cos(a), sin(a)) * sqrt(f) * rpx * vec2(uTexel.x / uTexel.y, 1.0);
      vec3 v = viewPos(suv) - p;
      float vv = dot(v, v);
      sum += max(0.0, dot(v, n) - 0.01 * -p.z) / (vv + 0.02) * (1.0 - smoothstep(uRadius * uRadius * 0.6, uRadius * uRadius * 1.6, vv));
    }
    float ao = clean1(max(0.0, 1.0 - 2.0 * uIntensity * sum / float(SAMPLES)), 1.0);
    gl_FragColor = vec4(vec3(clamp(pow(ao, 1.4), 0.0, 1.0)), 1.0);
  }`;

/** Depth-aware 4x4 blur for the half-resolution AO. */
const AO_BLUR_FRAG = `varying vec2 vUv; ${VIEWPOS}${CLEAN}
  uniform sampler2D tAO; uniform vec2 uTexel;
  void main() {
    float z0 = viewPos(vUv).z, sum = 0.0, w = 0.0;
    for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) + 0.5) * uTexel;
      float k = clean1(1.0 / (1.0 + abs(viewPos(vUv + o).z - z0) * 4.0), 0.0);
      sum += clean1(texture2D(tAO, vUv + o).r, 1.0) * k; w += k;
    }
    gl_FragColor = vec4(vec3(clamp(clean1(sum / max(w, 1e-4), 1.0), 0.0, 1.0)), 1.0);
  }`;

/** God rays, step 1: bright sky around the sun (occluders are black). */
const GOD_MASK_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uAspect;
  void main() {
    float sky = step(0.99999, texture2D(tDepth, vUv).x);
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float glow = exp(-dot(d, d) * 28.0);
    vec3 c = min(clean3(texture2D(tColor, vUv).rgb), vec3(4.0));
    // Only the bright sky around the sun casts shafts, not the whole sky dome.
    c = max(c - vec3(0.85), vec3(0.0));
    gl_FragColor = vec4(c * sky * glow, 1.0);
  }`;

/** God rays, step 2: radial blur toward the sun (run twice with different step sizes). */
const GOD_BLUR_FRAG = `varying vec2 vUv;
  uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep;
  void main() {
    vec2 delta = (vUv - uSun) * uStep / 24.0;
    vec2 uv = vUv; vec3 acc = vec3(0.0); float illum = 1.0, wsum = 0.0;
    for (int i = 0; i < 24; i++) { uv -= delta; acc += texture2D(tSrc, uv).rgb * illum; wsum += illum; illum *= 0.955; }
    gl_FragColor = vec4(acc / wsum, 1.0);
  }`;

/** Half-resolution disc blur used by depth of field. */
const DOF_BLUR_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tColor; uniform vec2 uTexel;
  void main() {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 2.39996323, r = sqrt((float(i) + 0.5) / 16.0) * 5.0;
      acc += min(clean3(texture2D(tColor, vUv + vec2(cos(a), sin(a)) * r * uTexel).rgb), vec3(16.0));
    }
    gl_FragColor = vec4(acc / 16.0, 1.0);
  }`;

/** HDR composite: water SSR, ambient occlusion, depth of field and god rays. */
const COMPOSITE_FRAG = `varying vec2 vUv; ${VIEWPOS}${CLEAN}
  uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tGod; uniform sampler2D tDof;
  uniform mat4 uProj; uniform vec3 uViewUp; uniform float uTime;
  uniform float uAO; uniform vec3 uGod; uniform vec3 uDof; uniform float uSSR;
  void main() {
    vec4 src = texture2D(tColor, vUv);
    // NaN/Inf pixels would turn into growing black blocks in the bloom mip chain.
    vec3 c = any(isnan(src.rgb)) || any(isinf(src.rgb)) ? vec3(0.0) : clamp(src.rgb, 0.0, 48.0);
    float d = texture2D(tDepth, vUv).x;
    vec3 p = viewPos(vUv);
    float dist = length(p);
    #ifdef USE_SSR
    if (src.a < 0.5 && uSSR > 0.0) {
      // Water pixels (alpha marker): march the reflected view ray through the depth buffer.
      vec3 nrm = normalize(uViewUp + 0.035 * vec3(sin(p.x * 1.7 + uTime * 1.3), 0.0, cos(p.z * 1.9 + uTime * 1.1)));
      vec3 r = reflect(normalize(p), nrm);
      vec3 q = p + r * 0.2; float stepLen = max(0.3, dist * 0.02);
      vec3 hit = vec3(0.0); float found = 0.0;
      for (int i = 0; i < 28; i++) {
        q += r * stepLen; stepLen *= 1.12;
        vec4 s = uProj * vec4(q, 1.0); vec2 suv = s.xy / s.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0 || s.w <= 0.0) break;
        float sz = viewPos(suv).z;
        if (q.z < sz && sz - q.z < stepLen * 2.5 + 0.5) {
          vec2 e = smoothstep(0.0, 0.12, suv) * smoothstep(0.0, 0.12, 1.0 - suv);
          hit = texture2D(tColor, suv).rgb; found = e.x * e.y; break;
        }
      }
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-normalize(p), nrm), 0.0), 5.0);
      c = mix(c, hit, found * clamp(fres * 1.6, 0.0, 0.85) * uSSR);
    }
    #endif
    #ifdef USE_AO
    float ao = clamp(clean1(texture2D(tAO, vUv).r, 1.0), 0.0, 1.0);
    c *= mix(1.0, ao, uAO * (1.0 - smoothstep(70.0, 150.0, dist)) * step(d, 0.99999));
    #endif
    #ifdef USE_DOF
    float coc = smoothstep(uDof.x, uDof.x + uDof.y, dist) + (uDof.z > 0.0 ? 1.0 - smoothstep(uDof.z * 0.35, uDof.z * 0.8, dist) : 0.0);
    c = mix(c, clean3(texture2D(tDof, vUv).rgb), clamp(coc, 0.0, 1.0) * step(1.2, dist));
    #endif
    #ifdef USE_GOD
    c += clean3(texture2D(tGod, vUv).rgb) * uGod;
    #endif
    gl_FragColor = vec4(clean3(c), 1.0);
  }`;

/** Display pass: motion blur, chromatic aberration, sharpen, white balance, tone mapping, grade, vignette, grain. */
const FINAL_FRAG = `varying vec2 vUv;
  uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uTexel;
  uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj; uniform float uMotion; uniform float uNearCut;
  uniform float uChromatic; uniform float uSharpen; uniform vec3 uWhite; uniform float uExposure;
  uniform float uContrast; uniform float uSaturation; uniform float uVibrance;
  uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
  uniform float uVignette; uniform float uGrain; uniform float uTime;
  void main() {
    vec2 uv = vUv;
    vec3 c = texture2D(tColor, uv).rgb;
    #ifdef USE_MOTION
    float d = texture2D(tDepth, uv).x;
    vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); wp /= wp.w;
    vec4 pp = uPrevViewProj * wp;
    vec2 vel = (uv - (pp.xy / pp.w * 0.5 + 0.5)) * uMotion;
    float vl = length(vel);
    if (vl > 0.0005 && pp.w > uNearCut) {
      vel *= min(1.0, 0.035 / vl);
      vec3 acc = c;
      for (int i = 1; i < 8; i++) acc += texture2D(tColor, uv - vel * (float(i) / 7.0 - 0.5)).rgb;
      c = acc / 8.0;
    }
    #endif
    if (uSharpen > 0.0) {
      vec3 n = texture2D(tColor, uv + vec2(uTexel.x, 0.0)).rgb + texture2D(tColor, uv - vec2(uTexel.x, 0.0)).rgb
        + texture2D(tColor, uv + vec2(0.0, uTexel.y)).rgb + texture2D(tColor, uv - vec2(0.0, uTexel.y)).rgb;
      c = max(c + (c - n * 0.25) * uSharpen, vec3(0.0));
    }
    if (uChromatic > 0.0) {
      vec2 off = (uv - 0.5) * uChromatic * 0.012;
      c.r = mix(c.r, texture2D(tColor, uv + off).r, 0.85);
      c.b = mix(c.b, texture2D(tColor, uv - off).b, 0.85);
    }
    c *= uWhite * uExposure;
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 g = clamp(gl_FragColor.rgb, 0.0, 1.0);
    g = pow(max(g * uGain + uLift * (1.0 - g), vec3(0.0)), 1.0 / uGamma);
    float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b));
    g = mix(vec3(l), g, uSaturation * (1.0 + uVibrance * (1.0 - sat)));
    g = (g - 0.5) * uContrast + 0.5;
    vec2 vd = uv - 0.5;
    g *= 1.0 - uVignette * smoothstep(0.35, 0.85, length(vd * vec2(1.0, 0.8)) * 1.25);
    if (uGrain > 0.0) {
      float nz = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 917.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      g += nz * uGrain * 0.09 * (1.0 - abs(l - 0.5));
    }
    gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0);
  }`;

function shader(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}, toneMapped = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, toneMapped });
}

/**
 * Custom HDR post chain. One scene render (with depth) feeds depth-only SSAO, screen-space god rays, water SSR,
 * DOF, bloom and camera motion blur; the display pass tone maps and grades. Everything is optional and the
 * expensive buffers run at half or quarter resolution.
 */
export class PostPipeline {
  private scene: THREE.WebGLRenderTarget;
  private comp: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoBlurRT: THREE.WebGLRenderTarget | null = null;
  private godA: THREE.WebGLRenderTarget | null = null;
  private godB: THREE.WebGLRenderTarget | null = null;
  private dofRT: THREE.WebGLRenderTarget | null = null;
  private bloom: UnrealBloomPass | null = null;
  private quad = new FullScreenQuad();
  private aoMat: THREE.ShaderMaterial | null = null;
  private aoBlurMat: THREE.ShaderMaterial | null = null;
  private godMaskMat: THREE.ShaderMaterial | null = null;
  private godBlurMat: THREE.ShaderMaterial | null = null;
  private dofMat: THREE.ShaderMaterial | null = null;
  private compMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial;
  private prevViewProj = new THREE.Matrix4();
  private hasPrev = false;
  private frame = 0;
  private w = 1;
  private h = 1;
  /** Sun direction (towards the sun) and whether god rays should show for this map. */
  sunDir = new THREE.Vector3(0, 1, 0);
  /** Depth-of-field focus override in metres (scoped zoom), 0 = automatic far-field blur only. */
  focus = 0;

  constructor(private renderer: THREE.WebGLRenderer, readonly o: PostOptions) {
    const type = o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type, samples: o.msaa, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    this.comp = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
    if (!o.hdr) this.scene.texture.colorSpace = this.comp.texture.colorSpace = THREE.SRGBColorSpace;
    const common = { tDepth: { value: this.scene.depthTexture }, uInvProj: { value: new THREE.Matrix4() } };
    if (o.ao) {
      this.aoRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
      this.aoBlurRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
      this.aoMat = shader(AO_FRAG, { ...common, uProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.1 }, uIntensity: { value: 1.1 }, uFrame: { value: 0 } }, { SAMPLES: o.ao === 2 ? 16 : 8 });
      this.aoBlurMat = shader(AO_BLUR_FRAG, { ...common, tAO: { value: this.aoRT.texture }, uTexel: { value: new THREE.Vector2() } });
    }
    if (o.godrays > 0) {
      this.godA = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.godB = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.godMaskMat = shader(GOD_MASK_FRAG, { tColor: { value: this.scene.texture }, tDepth: { value: this.scene.depthTexture }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
      this.godBlurMat = shader(GOD_BLUR_FRAG, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 1 } });
    }
    if (o.dof) {
      this.dofRT = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.dofMat = shader(DOF_BLUR_FRAG, { tColor: { value: this.scene.texture }, uTexel: { value: new THREE.Vector2() } });
    }
    const defs: Record<string, string> = {};
    if (o.ao) defs.USE_AO = '';
    if (o.godrays > 0) defs.USE_GOD = '';
    if (o.dof) defs.USE_DOF = '';
    if (o.ssr) defs.USE_SSR = '';
    this.compMat = shader(COMPOSITE_FRAG, {
      ...common, tColor: { value: this.scene.texture }, tAO: { value: this.aoBlurRT?.texture ?? null }, tGod: { value: this.godB?.texture ?? null },
      tDof: { value: this.dofRT?.texture ?? null }, uProj: { value: new THREE.Matrix4() }, uViewUp: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 }, uAO: { value: o.ao === 2 ? 0.85 : 0.7 }, uGod: { value: new THREE.Vector3() }, uDof: { value: new THREE.Vector3(260, 900, 0) }, uSSR: { value: 1 },
    }, defs);
    if (o.bloom > 0) this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), o.bloom, 0.4, 0.9);
    const white = whiteBalance(o.temperature, o.tint);
    this.finalMat = shader(FINAL_FRAG, {
      tColor: { value: this.comp.texture }, tDepth: { value: this.scene.depthTexture }, uTexel: { value: new THREE.Vector2() },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() }, uMotion: { value: 0 }, uNearCut: { value: 1.5 },
      uChromatic: { value: o.chromatic }, uSharpen: { value: o.sharpen }, uWhite: { value: white }, uExposure: { value: o.exposure },
      uContrast: { value: o.contrast }, uSaturation: { value: o.saturation }, uVibrance: { value: o.vibrance },
      uLift: { value: o.lift.clone() }, uGamma: { value: o.gamma.clone() }, uGain: { value: o.gain.clone() },
      uVignette: { value: o.vignette }, uGrain: { value: o.grain }, uTime: { value: 0 },
    }, o.motionBlur > 0 ? { USE_MOTION: '' } : {}, true);
  }

  setSize(w: number, h: number) {
    this.w = Math.max(1, Math.round(w)); this.h = Math.max(1, Math.round(h));
    const hw = Math.max(1, this.w >> 1), hh = Math.max(1, this.h >> 1), qw = Math.max(1, this.w >> 2), qh = Math.max(1, this.h >> 2);
    this.scene.setSize(this.w, this.h);
    this.comp.setSize(this.w, this.h);
    this.aoRT?.setSize(hw, hh); this.aoBlurRT?.setSize(hw, hh);
    this.godA?.setSize(qw, qh); this.godB?.setSize(qw, qh);
    this.dofRT?.setSize(hw, hh);
    this.bloom?.setSize(this.w, this.h);
    this.finalMat.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
    if (this.aoMat) this.aoMat.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
    if (this.aoBlurMat) this.aoBlurMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    if (this.dofMat) this.dofMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.hasPrev = false;
  }

  /** Greyscale while dead/waiting (TA desaturates the world). */
  setSaturation(k: number) { this.finalMat.uniforms.uSaturation.value = this.o.saturation * k; }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number) {
    const r = this.renderer;
    const t = performance.now() / 1000;
    this.frame++;
    camera.updateMatrixWorld();
    const invProj = camera.projectionMatrixInverse;
    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    if (this.aoMat && this.aoBlurMat && this.aoRT && this.aoBlurRT) {
      this.aoMat.uniforms.uInvProj.value.copy(invProj);
      this.aoMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      this.aoMat.uniforms.uFrame.value = this.frame % 64;
      this.pass(this.aoMat, this.aoRT);
      this.aoBlurMat.uniforms.uInvProj.value.copy(invProj);
      this.pass(this.aoBlurMat, this.aoBlurRT);
    }

    const god = this.compMat.uniforms.uGod.value as THREE.Vector3;
    god.set(0, 0, 0);
    if (this.godMaskMat && this.godBlurMat && this.godA && this.godB) {
      const fwd = camera.getWorldDirection(_v);
      const facing = fwd.dot(this.sunDir);
      if (facing > 0.05) {
        const s = _v2.copy(camera.position).addScaledVector(this.sunDir, 2000).project(camera);
        const sun = new THREE.Vector2(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5);
        this.godMaskMat.uniforms.uSun.value.copy(sun);
        this.godMaskMat.uniforms.uAspect.value = this.w / this.h;
        this.pass(this.godMaskMat, this.godA);
        this.godBlurMat.uniforms.uSun.value.copy(sun);
        this.godBlurMat.uniforms.tSrc.value = this.godA.texture; this.godBlurMat.uniforms.uStep.value = 0.9;
        this.pass(this.godBlurMat, this.godB);
        this.godBlurMat.uniforms.tSrc.value = this.godB.texture; this.godBlurMat.uniforms.uStep.value = 0.35;
        this.pass(this.godBlurMat, this.godA);
        // Keep the final result in godB for the composite.
        this.godBlurMat.uniforms.tSrc.value = this.godA.texture; this.godBlurMat.uniforms.uStep.value = 0.12;
        this.pass(this.godBlurMat, this.godB);
        const k = this.o.godrays * THREE.MathUtils.smoothstep(facing, 0.05, 0.6);
        god.set(k, k, k);
      }
    }
    if (this.dofMat && this.dofRT) this.pass(this.dofMat, this.dofRT);

    const cu = this.compMat.uniforms;
    cu.uInvProj.value.copy(invProj);
    cu.uProj.value.copy(camera.projectionMatrix);
    cu.uViewUp.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    cu.uTime.value = t;
    (cu.uDof.value as THREE.Vector3).z = this.focus;
    this.pass(this.compMat, this.comp);
    this.bloom?.render(r, this.comp, this.comp, dt, false);

    const fu = this.finalMat.uniforms;
    const viewProj = _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this.o.motionBlur > 0) {
      fu.uInvViewProj.value.copy(viewProj).invert();
      fu.uPrevViewProj.value.copy(this.hasPrev ? this.prevViewProj : viewProj);
      // Shutter as a fraction of a 60 Hz frame, independent of the actual frame rate.
      fu.uMotion.value = this.o.motionBlur * Math.min(2, (1 / 60) / Math.max(1 / 240, dt));
    }
    this.prevViewProj.copy(viewProj);
    this.hasPrev = true;
    fu.uTime.value = t;
    this.pass(this.finalMat, null);
  }

  dispose() {
    for (const rt of [this.scene, this.comp, this.aoRT, this.aoBlurRT, this.godA, this.godB, this.dofRT]) rt?.dispose();
    this.scene.depthTexture?.dispose();
    for (const m of [this.aoMat, this.aoBlurMat, this.godMaskMat, this.godBlurMat, this.dofMat, this.compMat, this.finalMat]) m?.dispose();
    this.bloom?.dispose();
    this.quad.dispose();
  }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Simple white balance: warm/cool along blue-amber, tint along green-magenta (multipliers in linear light). */
function whiteBalance(temperature: number, tint: number): THREE.Vector3 {
  const t = THREE.MathUtils.clamp(temperature, -1, 1) * 0.12, g = THREE.MathUtils.clamp(tint, -1, 1) * 0.08;
  return new THREE.Vector3(1 + t + g * 0.5, 1 - g, 1 - t + g * 0.5);
}
