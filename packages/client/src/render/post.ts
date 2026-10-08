import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * The subset of options that changes the *shape* of the chain (render targets and shader defines).
 * Everything else is a plain uniform and can be applied to a live pipeline with `update()`.
 */
export interface PostStructure {
  hdr: boolean;
  msaa: number;
  bloom: number;          // strength, 0 = off
  ao: 0 | 1 | 2;          // off / SSAO 8 taps / SSAO 16 taps
  godrays: number;        // intensity, 0 = off
  dof: number;            // strength, 0 = off
  motionBlur: number;     // shutter fraction, 0 = off
  ssr: boolean;           // screen-space reflections on water
  taa: boolean;           // temporal anti-aliasing
  fsr: boolean;           // FSR upscaling
}

/** Everything the post chain can do; values come from settings (see Renderer.configure). */
export interface PostOptions extends PostStructure {
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
  renderScale: number;    // for FSR
}

/** Stable key for the structural shape of the chain; equal keys mean "no rebuild needed". */
export function structuralKey(o: PostStructure): string {
  return [o.hdr ? 1 : 0, o.msaa, o.ao, o.dof > 0 ? 1 : 0, o.ssr ? 1 : 0, o.bloom > 0 ? 1 : 0, o.godrays > 0 ? 1 : 0, o.motionBlur > 0 ? 1 : 0, o.taa ? 1 : 0, o.fsr ? 1 : 0].join('|');
}

/** Buffer sizes for the chain: full / half (AO, DOF) / quarter (god rays, bloom near) / eighth (bloom wide). */
export function chainSizes(w: number, h: number) {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  return {
    w: W, h: H,
    hw: Math.max(1, W >> 1), hh: Math.max(1, H >> 1),
    qw: Math.max(1, W >> 2), qh: Math.max(1, H >> 2),
    ww: Math.max(1, W >> 3), wh: Math.max(1, H >> 3),
  };
}

/** TAA jitter sequence (8-sample rotated grid). */
export const TAA_JITTER = [
  [0.25, 0.25], [-0.75, -0.75], [-0.25, 0.75], [0.75, -0.25],
  [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5],
];

/**
 * Shared shader prelude. Declared before the first fragment template that interpolates them -
 * these are `const`, so a template evaluated at module load would hit the temporal dead zone.
 */
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

/** YCoCg-A round trip used by the TAA clamp. Inverse is R = Y+Co+Cg, G = Y-Cg, B = Y-Co+Cg. */
const YCOCG = `
  vec3 toYcocg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(0.25, -0.5, 0.25))); }
  vec3 fromYcocg(vec3 c) { return vec3(c.x + c.y + c.z, c.x - c.z, c.x - c.y + c.z); }`;

/** FSR 1.0 EASU (Edge-Adaptive Spatial Upscaling) - simplified version. */
const FSR_EASU_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tInput; uniform vec2 uInputSize; uniform vec2 uOutputSize; uniform float uSharpness;
  // FSR EASU constants
  const float PI = 3.14159265359;
  vec4 sample(vec2 uv) { return texture2D(tInput, uv); }
  void main() {
    vec2 inputSize = uInputSize;
    vec2 outputSize = uOutputSize;
    vec2 ratio = inputSize / outputSize;
    vec2 uv = vUv * ratio;
    vec2 px = vec2(1.0) / inputSize;
    // Sample 5x5 neighborhood
    vec4 c[25];
    int idx = 0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        c[idx++] = sample(uv + vec2(float(x), float(y)) * px);
      }
    }
    // Luma weights
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float l[25];
    for (int i = 0; i < 25; i++) l[i] = dot(c[i].rgb, luma);
    // Edge detection
    float gx = (l[1] + l[6] * 2.0 + l[11] - l[3] - l[8] * 2.0 - l[13]) * 0.25;
    float gy = (l[11] + l[12] * 2.0 + l[13] - l[1] - l[2] * 2.0 - l[3]) * 0.25;
    float grad = length(vec2(gx, gy));
    // Directional weights
    float w[4];
    w[0] = 1.0 / (1.0 + abs(l[7] - l[12])); // N
    w[1] = 1.0 / (1.0 + abs(l[11] - l[13])); // E
    w[2] = 1.0 / (1.0 + abs(l[12] - l[7])); // S
    w[3] = 1.0 / (1.0 + abs(l[13] - l[11])); // W
    float wsum = w[0] + w[1] + w[2] + w[3];
    w[0] /= wsum; w[1] /= wsum; w[2] /= wsum; w[3] /= wsum;
    // Reconstruct
    vec3 col = c[7].rgb * w[0] + c[11].rgb * w[1] + c[12].rgb * w[2] + c[13].rgb * w[3];
    // Sharpening
    if (uSharpness > 0.0) {
      vec3 sharp = col - (c[7].rgb + c[11].rgb + c[12].rgb + c[13].rgb) * 0.25;
      col += sharp * uSharpness;
    }
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

/** FSR 1.0 RCAS (Robust Contrast-Adaptive Sharpening). */
const FSR_RCAS_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tInput; uniform vec2 uInputSize; uniform float uSharpness;
  void main() {
    vec2 px = vec2(1.0) / uInputSize;
    vec4 c0 = texture2D(tInput, vUv);
    vec4 c1 = texture2D(tInput, vUv + vec2(px.x, 0.0));
    vec4 c2 = texture2D(tInput, vUv - vec2(px.x, 0.0));
    vec4 c3 = texture2D(tInput, vUv + vec2(0.0, px.y));
    vec4 c4 = texture2D(tInput, vUv - vec2(0.0, px.y));
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float l0 = dot(c0.rgb, luma);
    float l1 = dot(c1.rgb, luma);
    float l2 = dot(c2.rgb, luma);
    float l3 = dot(c3.rgb, luma);
    float l4 = dot(c4.rgb, luma);
    float minL = min(min(min(l1, l2), l3), l4);
    float maxL = max(max(max(l1, l2), l3), l4);
    float l0Clamped = clamp(l0, minL, maxL);
    float sharp = (l0 - l0Clamped) * uSharpness;
    vec3 col = c0.rgb + vec3(sharp);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

/**
 * Bloom response for a given strength. TA's bloom is a soft haze around highlights, not a glow:
 * a high soft-knee threshold (only real highlights bloom) with a wide, low-intensity spread.
 */
export function bloomParams(strength: number, hdr = true): { threshold: number; knee: number; intensity: number } {
  const s = Math.max(0, Math.min(2, strength));
  /* 8-bit linear targets clip at 1.0, so the knee/threshold must sit below the ceiling
     or nothing passes the bright-pass and bloom silently disappears. */
  return hdr
    ? { threshold: 1.0, knee: 0.8, intensity: s * 0.85 }
    : { threshold: 0.72, knee: 0.25, intensity: s * 0.95 };
}

/** Simple white balance: warm/cool along blue-amber, tint along green-magenta (multipliers in linear light). */
export function whiteBalance(temperature: number, tint: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, temperature)) * 0.12, g = Math.max(-1, Math.min(1, tint)) * 0.08;
  return [1 + t + g * 0.5, 1 - g, 1 - t + g * 0.5];
}

/** Temporal Anti-Aliasing: blends current frame with history using velocity-based reprojection. */
const TAA_FRAG = `varying vec2 vUv;${CLEAN}${YCOCG}
  uniform sampler2D tColor; uniform sampler2D tHistory; uniform sampler2D tDepth; uniform sampler2D tVelocity;
  uniform mat4 uInvProj; uniform mat4 uPrevViewProj; uniform vec2 uJitter; uniform vec2 uJitterPrev;
  uniform vec2 uTexel; uniform float uSharpness; uniform float uBlend;
  void main() {
    vec2 uv = vUv;
    vec4 curr = texture2D(tColor, uv);
    float d = texture2D(tDepth, uv).x;
    if (d >= 0.99999) { gl_FragColor = curr; return; }
    vec4 vel = texture2D(tVelocity, uv);
    // Velocity is the NDC-space motion of this pixel. The scene was rendered with this frame's
    // sub-pixel jitter and the history with the previous frame's, so undo the current jitter and
    // re-apply the previous one to land on the matching texel of the history buffer.
    vec2 reprojUv = clamp(uv + 0.5 * vel.xy + (uJitterPrev - uJitter), vec2(0.0), vec2(1.0));
    vec4 hist = texture2D(tHistory, reprojUv);
    // Neighborhood clamping (YCoCg) to reject ghosting
    vec3 currYcocg = toYcocg(curr.rgb);
    vec3 histYcocg = toYcocg(hist.rgb);
    vec3 minYcocg = currYcocg, maxYcocg = currYcocg;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 nuv = uv + vec2(float(x), float(y)) * uTexel;
      vec3 nycocg = toYcocg(texture2D(tColor, nuv).rgb);
      minYcocg = min(minYcocg, nycocg);
      maxYcocg = max(maxYcocg, nycocg);
    }
    vec3 clamped = clamp(histYcocg, minYcocg, maxYcocg);
    vec3 blended = mix(currYcocg, clamped, uBlend);
    // Sharpening: unsharp-mask the current frame and recover detail the blend removed
    if (uSharpness > 0.0) {
      vec3 n = texture2D(tColor, uv + vec2(uTexel.x, 0.0)).rgb + texture2D(tColor, uv - vec2(uTexel.x, 0.0)).rgb
        + texture2D(tColor, uv + vec2(0.0, uTexel.y)).rgb + texture2D(tColor, uv - vec2(0.0, uTexel.y)).rgb;
      n *= 0.25;
      vec3 sharp = toYcocg(n);
      blended = mix(blended, currYcocg + (currYcocg - sharp) * uSharpness, uSharpness);
    }
    gl_FragColor = vec4(fromYcocg(blended), 1.0);
  }`;

/** Velocity buffer generation for TAA and motion blur. */
const VELOCITY_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tDepth; uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj;
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.99999) { gl_FragColor = vec4(0.0); return; }
    vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); wp /= wp.w;
    vec4 pp = uPrevViewProj * wp;
    vec2 vel = (vUv - (pp.xy / pp.w * 0.5 + 0.5));
    gl_FragColor = vec4(vel, 0.0, 1.0);
  }`;

/** Distance haze: how far out the world starts losing saturation and drifting cool (metres). */
export function hazeParams(): { near: number; far: number; amount: number } {
  return { near: 120, far: 900, amount: 0.45 };
}

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

/** God rays, step 2: radial blur toward the sun (run three times with shrinking step sizes). */
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

/**
 * HDR composite: water SSR, ambient occlusion, depth of field, god rays and the distance haze, in one pass.
 * The haze (TA's signature) desaturates and cools distant geometry so the world fades into the sky.
 */
const COMPOSITE_FRAG = `varying vec2 vUv; ${VIEWPOS}${CLEAN}
  uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tGod; uniform sampler2D tDof;
  uniform mat4 uProj; uniform vec3 uViewUp; uniform float uTime;
  uniform float uAO; uniform vec3 uGod; uniform vec3 uDof; uniform float uSSR;
  uniform float uDofAmt;    // 0..1 depth-of-field strength from the slider
  uniform vec3 uHaze;  // x = near m, y = far m, z = amount
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
    float coc = (smoothstep(uDof.x, uDof.x + uDof.y, dist) + (uDof.z > 0.0 ? 1.0 - smoothstep(uDof.z * 0.35, uDof.z * 0.8, dist) : 0.0)) * uDofAmt;
    c = mix(c, clean3(texture2D(tDof, vUv).rgb), clamp(coc, 0.0, 1.0) * step(1.2, dist));
    #endif
    #ifdef USE_GOD
    c += clean3(texture2D(tGod, vUv).rgb) * uGod;
    #endif
    // Distance haze: pull distant pixels toward a desaturated, cool-tinted version of themselves.
    float hf = smoothstep(uHaze.x, uHaze.y, dist) * step(d, 0.99999) * uHaze.z;
    float hl = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 cool = mix(vec3(hl), c, 0.72) * vec3(0.94, 0.985, 1.07);
    c = mix(c, cool, hf);
    gl_FragColor = vec4(clean3(c), 1.0);
  }`;

/** Bloom, step 1: soft-knee highlight extract, 5-tap downsample from full res into the quarter-res buffer. */
const BLOOM_BRIGHT_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tColor; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
  void main() {
    vec2 t = uTexel * 2.0;
    vec3 c = clean3(texture2D(tColor, vUv).rgb)
      + clean3(texture2D(tColor, vUv + vec2(t.x, t.y)).rgb)
      + clean3(texture2D(tColor, vUv - vec2(t.x, t.y)).rgb)
      + clean3(texture2D(tColor, vUv + vec2(t.x, -t.y)).rgb)
      + clean3(texture2D(tColor, vUv - vec2(t.x, -t.y)).rgb);
    c = min(c / 5.0, vec3(48.0));
    float l = max(c.r, max(c.g, c.b));
    float lo = max(uThreshold - uKnee, 0.0), hi = max(uThreshold + uKnee, lo + 1e-4);
    float k = clamp((l - lo) / (hi - lo), 0.0, 1.0);
    float w = k * k * clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
    gl_FragColor = vec4(max(c * w, vec3(0.0)), 1.0);
  }`;

/** Separable 9-tap gaussian; `uDir` carries both direction and radius (in source texels). */
const BLOOM_BLUR_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tSrc; uniform vec2 uDir;
  void main() {
    vec3 acc = clean3(texture2D(tSrc, vUv).rgb) * 0.297; float w = 0.297;
    for (int i = 1; i < 5; i++) {
      float k = exp(-float(i * i) * 0.35);
      vec2 d = uDir * float(i);
      acc += clean3(texture2D(tSrc, vUv + d).rgb) * k + clean3(texture2D(tSrc, vUv - d).rgb) * k;
      w += 2.0 * k;
    }
    gl_FragColor = vec4(acc / w, 1.0);
  }`;

/** Quarter -> eighth res consolidation (5-tap cross), seeds the wide haze level. */
const BLOOM_DOWN_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tSrc; uniform vec2 uTexel;
  void main() {
    vec2 t = uTexel * 1.5;
    vec3 c = clean3(texture2D(tSrc, vUv).rgb)
      + clean3(texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb)
      + clean3(texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb)
      + clean3(texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb)
      + clean3(texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb);
    gl_FragColor = vec4(max(c / 5.0, vec3(0.0)), 1.0);
  }`;

/**
 * Display pass: motion blur, chromatic aberration, sharpen, bloom composite, white balance, tone mapping,
 * grade, vignette, grain. One full-resolution pass; the bloom buffers are sampled here, never composited on GPU.
 */
const FINAL_FRAG = `varying vec2 vUv;${CLEAN}
  uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uTexel;
  uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj; uniform float uMotion; uniform float uNearCut;
  uniform float uChromatic; uniform float uSharpen; uniform vec3 uWhite; uniform float uExposure;
  uniform float uContrast; uniform float uSaturation; uniform float uVibrance;
  uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
  uniform float uVignette; uniform float uGrain; uniform float uTime;
  #ifdef USE_BLOOM
  uniform sampler2D tBloomNear; uniform sampler2D tBloomWide; uniform float uBloom;
  #endif
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
    #ifdef USE_BLOOM
    // Near level keeps highlight definition, wide level is the soft haze; blend, then add in linear HDR.
    vec3 bl = mix(clean3(texture2D(tBloomNear, uv).rgb), clean3(texture2D(tBloomWide, uv).rgb), 0.55);
    c += bl * uBloom;
    #endif
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
 * Custom HDR post chain. One scene render (with depth) feeds depth-only SSAO, screen-space god rays,
 * water SSR, DOF and a two-level bloom; a single composite pass folds in the distance haze, and a
 * single display pass composites the bloom and tone maps/grades. All auxiliary buffers are half,
 * quarter or eighth resolution, and the chain is rebuilt only when its structural key changes.
 */
export class PostPipeline {
  private scene: THREE.WebGLRenderTarget;
  private comp: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoBlurRT: THREE.WebGLRenderTarget | null = null;
  private godA: THREE.WebGLRenderTarget | null = null;
  private godB: THREE.WebGLRenderTarget | null = null;
  private dofRT: THREE.WebGLRenderTarget | null = null;
  private bloomNear: THREE.WebGLRenderTarget | null = null;
  private bloomNearB: THREE.WebGLRenderTarget | null = null;
  private bloomWide: THREE.WebGLRenderTarget | null = null;
  private bloomWideB: THREE.WebGLRenderTarget | null = null;
  // TAA
  /** TAA history ping-pong: the pass reads one target and writes the other, so a texture is
   *  never bound while it is the active render target (WebGL feedback loop). */
  private historyRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private historyIndex = 0;
  private velocityRT: THREE.WebGLRenderTarget | null = null;
  private taaMat: THREE.ShaderMaterial | null = null;
  private velocityMat: THREE.ShaderMaterial | null = null;
  private taaEnabled = false;
  private taaFirst = true;
  private jitterIndex = 0;
  // FSR
  private fsrEnabled = false;
  private fsrEasuRT: THREE.WebGLRenderTarget | null = null;
  private fsrInputRT: THREE.WebGLRenderTarget | null = null;
  private fsrEasuMat: THREE.ShaderMaterial | null = null;
  private fsrRcasMat: THREE.ShaderMaterial | null = null;
  private quad = new FullScreenQuad();
  private aoMat: THREE.ShaderMaterial | null = null;
  private aoBlurMat: THREE.ShaderMaterial | null = null;
  private godMaskMat: THREE.ShaderMaterial | null = null;
  private godBlurMat: THREE.ShaderMaterial | null = null;
  private dofMat: THREE.ShaderMaterial | null = null;
  private bloomBrightMat: THREE.ShaderMaterial | null = null;
  private bloomBlurMat: THREE.ShaderMaterial | null = null;
  private bloomDownMat: THREE.ShaderMaterial | null = null;
  private compMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial;
  private prevViewProj = new THREE.Matrix4();
  private hasPrev = false;
  private frame = 0;
  private sizes = chainSizes(1, 1);
  private key: string;
  private sat = 1;
  private opts: PostOptions;
  /** Sun direction (towards the sun) and whether god rays should show for this map. */
  sunDir = new THREE.Vector3(0, 1, 0);
  /** Depth-of-field focus override in metres (scoped zoom), 0 = automatic far-field blur only. */
  focus = 0;

  constructor(private renderer: THREE.WebGLRenderer, o: PostOptions) {
    this.opts = o;
    this.key = structuralKey(o);
    /* HDR off only narrows the chain to 8-bit; the targets stay *linear* in both modes.
       three.js writes raw linear values into render targets (it never sRGB-encodes them),
       and an sRGB-flagged 8-bit target uploads as SRGB8_ALPHA8, which *decodes* on every
       sample: midtones get squared, anything above 1 is already clipped, water collapses
       to black and players go dark. The final pass is the sole tone-mapper/encoder. */
    const type = o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type, samples: o.msaa, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    this.comp = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
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
    if (o.dof > 0) {
      this.dofRT = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.dofMat = shader(DOF_BLUR_FRAG, { tColor: { value: this.scene.texture }, uTexel: { value: new THREE.Vector2() } });
    }
    const bp = bloomParams(o.bloom, o.hdr);
    if (o.bloom > 0) {
      this.bloomNear = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.bloomNearB = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.bloomWide = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.bloomWideB = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
      this.bloomBrightMat = shader(BLOOM_BRIGHT_FRAG, { tColor: { value: this.comp.texture }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: bp.threshold }, uKnee: { value: bp.knee } });
      this.bloomBlurMat = shader(BLOOM_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
      this.bloomDownMat = shader(BLOOM_DOWN_FRAG, { tSrc: { value: this.bloomNear.texture }, uTexel: { value: new THREE.Vector2() } });
    }
    const defs: Record<string, string> = {};
    if (o.ao) defs.USE_AO = '';
    if (o.godrays > 0) defs.USE_GOD = '';
    if (o.dof > 0) defs.USE_DOF = '';
    if (o.ssr) defs.USE_SSR = '';
        if (o.taa) defs.USE_TAA = '';
        const haze = hazeParams();
        this.compMat = shader(COMPOSITE_FRAG, {
          ...common, tColor: { value: this.scene.texture }, tAO: { value: this.aoBlurRT?.texture ?? null }, tGod: { value: this.godB?.texture ?? null },
          tDof: { value: this.dofRT?.texture ?? null }, uProj: { value: new THREE.Matrix4() }, uViewUp: { value: new THREE.Vector3(0, 1, 0) },
          uTime: { value: 0 }, uAO: { value: o.ao === 2 ? 0.85 : 0.7 }, uGod: { value: new THREE.Vector3() }, uDof: { value: new THREE.Vector3(260 - 170 * Math.min(1, o.dof), 900 - 500 * Math.min(1, o.dof), 0) }, uDofAmt: { value: Math.min(1, o.dof) }, uSSR: { value: 1 },
          uHaze: { value: new THREE.Vector3(haze.near, haze.far, haze.amount) },
        }, defs);
    const finalDefs: Record<string, string> = {};
    if (o.motionBlur > 0) finalDefs.USE_MOTION = '';
    if (o.bloom > 0) finalDefs.USE_BLOOM = '';
    const white = whiteBalance(o.temperature, o.tint);
    this.finalMat = shader(FINAL_FRAG, {
      tColor: { value: this.comp.texture }, tDepth: { value: this.scene.depthTexture }, uTexel: { value: new THREE.Vector2() },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() }, uMotion: { value: 0 }, uNearCut: { value: 1.5 },
      uChromatic: { value: o.chromatic }, uSharpen: { value: o.sharpen }, uWhite: { value: new THREE.Vector3(...white) }, uExposure: { value: o.exposure },
      uContrast: { value: o.contrast }, uSaturation: { value: o.saturation }, uVibrance: { value: o.vibrance },
      uLift: { value: o.lift.clone() }, uGamma: { value: o.gamma.clone() }, uGain: { value: o.gain.clone() },
      uVignette: { value: o.vignette }, uGrain: { value: o.grain }, uTime: { value: 0 },
      tBloomNear: { value: this.bloomNear?.texture ?? null }, tBloomWide: { value: this.bloomWide?.texture ?? null }, uBloom: { value: bp.intensity },
    }, finalDefs, true);

      // TAA setup (structural flag from settings)
      this.taaEnabled = o.taa;
        if (this.taaEnabled) {
          const type = o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
          // Two history targets: the resolve reads one and writes the other each frame.
          this.historyRT = [new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false }), new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false })];
          this.velocityRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
          this.velocityMat = shader(VELOCITY_FRAG, { tDepth: { value: this.scene.depthTexture }, uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() } });
          this.taaMat = shader(TAA_FRAG, {
            tColor: { value: this.comp.texture }, tHistory: { value: this.historyRT[0].texture }, tDepth: { value: this.scene.depthTexture }, tVelocity: { value: this.velocityRT.texture },
            uInvProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
            uJitter: { value: new THREE.Vector2() }, uJitterPrev: { value: new THREE.Vector2() },
            uTexel: { value: new THREE.Vector2() }, uSharpness: { value: 0.3 }, uBlend: { value: 0.9 },
          });
        }

        // FSR setup (structural flag from settings; only meaningful below native scale)
        this.fsrEnabled = o.fsr && o.renderScale < 1.0;
        if (this.fsrEnabled) {
          const type = o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
          this.fsrEasuRT = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
          this.fsrEasuMat = shader(FSR_EASU_FRAG, {
            tInput: { value: this.comp.texture }, uInputSize: { value: new THREE.Vector2() }, uOutputSize: { value: new THREE.Vector2() }, uSharpness: { value: 0.5 },
          });
          this.fsrInputRT = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
          this.fsrRcasMat = shader(FSR_RCAS_FRAG, {
            tInput: { value: this.fsrEasuRT.texture }, uInputSize: { value: new THREE.Vector2() }, uSharpness: { value: 0.3 },
          });
        }

        this.setSize(1, 1);
      }

  /** Structural key of the live pipeline; compare with `structuralKey(options)` to decide on a rebuild. */
  get structuralKey(): string { return this.key; }

  setSize(w: number, h: number) {
    const s = chainSizes(w, h);
    this.sizes = s;
    this.scene.setSize(s.w, s.h);
    this.comp.setSize(s.w, s.h);
    this.aoRT?.setSize(s.hw, s.hh); this.aoBlurRT?.setSize(s.hw, s.hh);
    this.godA?.setSize(s.qw, s.qh); this.godB?.setSize(s.qw, s.qh);
    this.dofRT?.setSize(s.hw, s.hh);
    this.bloomNear?.setSize(s.qw, s.qh); this.bloomNearB?.setSize(s.qw, s.qh);
    this.bloomWide?.setSize(s.ww, s.wh); this.bloomWideB?.setSize(s.ww, s.wh);
      this.historyRT?.[0].setSize(s.w, s.h);
      this.historyRT?.[1].setSize(s.w, s.h);
      this.velocityRT?.setSize(s.w, s.h);
      this.taaFirst = true;
      this.fsrEasuRT?.setSize(s.w / this.opts.renderScale, s.h / this.opts.renderScale);
      this.fsrInputRT?.setSize(s.w, s.h);
      this.finalMat.uniforms.uTexel.value.set(1 / s.w, 1 / s.h);
      if (this.aoMat) this.aoMat.uniforms.uTexel.value.set(1 / s.w, 1 / s.h);
      if (this.aoBlurMat) this.aoBlurMat.uniforms.uTexel.value.set(1 / s.hw, 1 / s.hh);
      if (this.dofMat) this.dofMat.uniforms.uTexel.value.set(1 / s.hw, 1 / s.hh);
      if (this.bloomBrightMat) this.bloomBrightMat.uniforms.uTexel.value.set(1 / s.w, 1 / s.h);
      if (this.bloomDownMat) this.bloomDownMat.uniforms.uTexel.value.set(1 / s.qw, 1 / s.qh);
      if (this.taaMat) this.taaMat.uniforms.uTexel.value.set(1 / s.w, 1 / s.h);
      this.hasPrev = false;
    }

  /**
   * Apply non-structural option changes (every slider) to the live pipeline.
   * Returns false when the structural key differs and a rebuild is required.
   */
  update(o: PostOptions): boolean {
    const key = structuralKey(o);
    if (key !== this.key) return false;
    this.opts = o;
    const fu = this.finalMat.uniforms;
    const white = whiteBalance(o.temperature, o.tint);
    (fu.uWhite.value as THREE.Vector3).set(white[0], white[1], white[2]);
    fu.uExposure.value = o.exposure;
    fu.uContrast.value = o.contrast;
    fu.uSaturation.value = o.saturation * this.sat;
    fu.uVibrance.value = o.vibrance;
    fu.uChromatic.value = o.chromatic;
    fu.uSharpen.value = o.sharpen;
    fu.uVignette.value = o.vignette;
    fu.uGrain.value = o.grain;
    (fu.uLift.value as THREE.Vector3).copy(o.lift);
    (fu.uGamma.value as THREE.Vector3).copy(o.gamma);
    (fu.uGain.value as THREE.Vector3).copy(o.gain);
    if (this.bloomBrightMat && this.bloomNear) {
      const bp = bloomParams(o.bloom, this.opts.hdr);
      this.bloomBrightMat.uniforms.uThreshold.value = bp.threshold;
      this.bloomBrightMat.uniforms.uKnee.value = bp.knee;
      fu.uBloom.value = bp.intensity;
    }
    this.compMat.uniforms.uAO.value = o.ao === 2 ? 0.85 : 0.7;
    this.compMat.uniforms.uSSR.value = 1;
    // DOF strength: higher values focus closer and blur harder. 0 = off (chain rebuilt without USE_DOF).
    const dof = Math.min(1, Math.max(0, o.dof));
    this.compMat.uniforms.uDofAmt.value = dof;
    (this.compMat.uniforms.uDof.value as THREE.Vector3).set(260 - 170 * dof, 900 - 500 * dof, this.focus);
    return true;
  }

  /** Greyscale while dead/waiting (TA desaturates the world). */
  setSaturation(k: number) {
    this.sat = k;
    this.finalMat.uniforms.uSaturation.value = this.opts.saturation * k;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number) {
    const r = this.renderer;
    const t = performance.now() / 1000;
    const s = this.sizes;
    this.frame++;
    camera.updateMatrixWorld();

      // TAA sub-pixel jitter. The camera's own projection matrix is left untouched: the jitter
      // lives only in the matrices the post chain uses, so gameplay raycasts and the next frame's
      // base projection are never affected (and the jitter cannot accumulate frame over frame).
      let invProj = camera.projectionMatrixInverse;
      const jitterProj = this.taaEnabled;
      let jitter = TAA_JITTER[0];
      let jitterPrev = TAA_JITTER[0];
      if (jitterProj) {
        jitter = TAA_JITTER[this.jitterIndex % TAA_JITTER.length];
        jitterPrev = TAA_JITTER[(this.jitterIndex - 1 + TAA_JITTER.length) % TAA_JITTER.length];
        this.jitterIndex++;
        _baseProj.copy(camera.projectionMatrix);
        camera.projectionMatrix.elements[2] += jitter[0] * 2.0 / s.w;
        camera.projectionMatrix.elements[6] += jitter[1] * 2.0 / s.h;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        invProj = camera.projectionMatrixInverse;
      }

      r.setRenderTarget(this.scene);
      r.render(scene, camera);

      // Generate velocity buffer for TAA and motion blur
      if (this.velocityMat && this.velocityRT) {
        this.velocityMat.uniforms.uInvViewProj.value.copy(this.prevViewProj).invert();
        this.velocityMat.uniforms.uPrevViewProj.value.copy(this.hasPrev ? this.prevViewProj : camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse));
        this.pass(this.velocityMat, this.velocityRT);
      }

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
        const p = _v2.copy(camera.position).addScaledVector(this.sunDir, 2000).project(camera);
        const sun = _vz.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
        this.godMaskMat.uniforms.uSun.value.copy(sun);
        this.godMaskMat.uniforms.uAspect.value = s.w / s.h;
        this.pass(this.godMaskMat, this.godA);
        this.godBlurMat.uniforms.uSun.value.copy(sun);
        this.godBlurMat.uniforms.tSrc.value = this.godA.texture; this.godBlurMat.uniforms.uStep.value = 0.9;
        this.pass(this.godBlurMat, this.godB);
        this.godBlurMat.uniforms.tSrc.value = this.godB.texture; this.godBlurMat.uniforms.uStep.value = 0.35;
        this.pass(this.godBlurMat, this.godA);
        // Keep the final result in godB, which the composite samples.
        this.godBlurMat.uniforms.tSrc.value = this.godA.texture; this.godBlurMat.uniforms.uStep.value = 0.12;
        this.pass(this.godBlurMat, this.godB);
        const k = this.opts.godrays * THREE.MathUtils.smoothstep(facing, 0.05, 0.6);
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

    // Bloom: quarter-res highlight extract + separable blur, consolidated to eighth res for the wide haze.
    if (this.bloomBrightMat && this.bloomBlurMat && this.bloomDownMat && this.bloomNear && this.bloomNearB && this.bloomWide && this.bloomWideB) {
      this.bloomBrightMat.uniforms.tColor.value = this.comp.texture;
      this.pass(this.bloomBrightMat, this.bloomNear);
      const dir = this.bloomBlurMat.uniforms.uDir.value as THREE.Vector2;
      this.bloomBlurMat.uniforms.tSrc.value = this.bloomNear.texture; dir.set(1.4 / s.qw, 0);
      this.pass(this.bloomBlurMat, this.bloomNearB);
      this.bloomBlurMat.uniforms.tSrc.value = this.bloomNearB.texture; dir.set(0, 1.4 / s.qh);
      this.pass(this.bloomBlurMat, this.bloomNear);
      this.bloomDownMat.uniforms.tSrc.value = this.bloomNear.texture;
      this.pass(this.bloomDownMat, this.bloomWide);
      this.bloomBlurMat.uniforms.tSrc.value = this.bloomWide.texture; dir.set(0, 2.6 / s.wh);
      this.pass(this.bloomBlurMat, this.bloomWideB);
      this.bloomBlurMat.uniforms.tSrc.value = this.bloomWideB.texture; dir.set(2.6 / s.ww, 0);
      this.pass(this.bloomBlurMat, this.bloomWide);
    }

    const fu = this.finalMat.uniforms;
    const viewProj = _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Last frame's jittered view-projection, captured before it is overwritten below.
    const prevViewProj = _m2.copy(this.prevViewProj);
    const firstFrame = !this.hasPrev;
    if (this.opts.motionBlur > 0) {
      fu.uInvViewProj.value.copy(viewProj).invert();
      fu.uPrevViewProj.value.copy(firstFrame ? viewProj : prevViewProj);
      // Shutter as a fraction of a 60 Hz frame, independent of the actual frame rate.
      fu.uMotion.value = this.opts.motionBlur * Math.min(2, (1 / 60) / Math.max(1 / 240, dt));
    }
    this.prevViewProj.copy(viewProj);
    this.hasPrev = true;
    fu.uTime.value = t;

        // TAA resolve pass. History is seeded from the current frame the first time (and after
        // every resize), so frame one never blends 90% of uninitialised texture data.
        const taaMat = this.taaMat, history = this.historyRT, velocityRT = this.velocityRT;
        const taaRan = this.taaEnabled && !!taaMat && !!history && !!velocityRT;
        if (taaMat && history && velocityRT && this.taaEnabled) {
          // Read the previous history, write the other target (a texture must never be
          // bound while it is the active render target).
          const src = history[this.historyIndex];
          const dst = history[1 - this.historyIndex];
          this.historyIndex = 1 - this.historyIndex;
          taaMat.uniforms.uJitter.value.set(jitter[0] / s.w, jitter[1] / s.h);
          taaMat.uniforms.uJitterPrev.value.set(jitterPrev[0] / s.w, jitterPrev[1] / s.h);
          taaMat.uniforms.uTexel.value.set(1 / s.w, 1 / s.h);
          taaMat.uniforms.uInvProj.value.copy(invProj);
          taaMat.uniforms.uPrevViewProj.value.copy(firstFrame ? viewProj : prevViewProj);
          taaMat.uniforms.tColor.value = this.comp.texture;
          taaMat.uniforms.tHistory.value = src.texture;
          taaMat.uniforms.tDepth.value = this.scene.depthTexture;
          taaMat.uniforms.tVelocity.value = velocityRT.texture;
          taaMat.uniforms.uBlend.value = this.taaFirst ? 0 : 0.9;
          this.pass(taaMat, dst);
          this.taaFirst = false;
        }

        // Everything is graded through the final pass (tone mapping, colour space, white balance,
        // contrast, vignette, grain, chromatic aberration, sharpen, motion blur); FSR, when active,
        // then upscales the graded image to the display resolution.
        fu.tColor.value = taaRan && history ? history[this.historyIndex].texture : this.comp.texture;
        if (this.fsrEnabled && this.fsrEasuMat && this.fsrRcasMat && this.fsrInputRT && this.fsrEasuRT) {
          const ow = this.fsrEasuRT.width, oh = this.fsrEasuRT.height;
          this.pass(this.finalMat, this.fsrInputRT);
          this.fsrEasuMat.uniforms.tInput.value = this.fsrInputRT.texture;
          this.fsrEasuMat.uniforms.uInputSize.value.set(s.w, s.h);
          this.fsrEasuMat.uniforms.uOutputSize.value.set(ow, oh);
          this.fsrEasuMat.uniforms.uSharpness.value = 0.5;
          this.pass(this.fsrEasuMat, this.fsrEasuRT);
          this.fsrRcasMat.uniforms.tInput.value = this.fsrEasuRT.texture;
          this.fsrRcasMat.uniforms.uInputSize.value.set(ow, oh);
          this.fsrRcasMat.uniforms.uSharpness.value = 0.3;
          this.pass(this.fsrRcasMat, null);
        } else {
          this.pass(this.finalMat, null);
        }

        if (jitterProj) {
          // Hand the game back its unjittered camera.
          camera.projectionMatrix.copy(_baseProj);
          camera.projectionMatrixInverse.copy(_baseProj).invert();
        }
      }

  dispose() {
    for (const rt of [this.scene, this.comp, this.aoRT, this.aoBlurRT, this.godA, this.godB, this.dofRT,
          this.bloomNear, this.bloomNearB, this.bloomWide, this.bloomWideB, this.velocityRT, this.fsrEasuRT, this.fsrInputRT]) rt?.dispose();
    for (const rt of this.historyRT ?? []) rt.dispose();
    this.scene.depthTexture?.dispose();
    for (const m of [this.aoMat, this.aoBlurMat, this.godMaskMat, this.godBlurMat, this.dofMat,
          this.bloomBrightMat, this.bloomBlurMat, this.bloomDownMat, this.compMat, this.finalMat, this.taaMat, this.velocityMat, this.fsrEasuMat, this.fsrRcasMat]) m?.dispose();
    this.quad.dispose();
  }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _vz = new THREE.Vector2(), _m = new THREE.Matrix4();
const _baseProj = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
