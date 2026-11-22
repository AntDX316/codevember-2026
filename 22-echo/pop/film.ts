import * as THREE from "three/webgpu";
import { abs, dot, float, max, mix, normalize, pow, smoothstep, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The soap film's colour is real thin-film interference: light reflected off the film's two faces, one of them flipped
// half a wave, adds or cancels by wavelength as the thickness changes. A table worked out once on the processor gives
// the colour reflected for every thickness and angle, summed over the spectrum through the eye's colour response.
// (From the bubble version.)

// Thickest film in the table, in nanometres, and how much the field's 1 stands for.
const MOST = 1500;
export const SCALE = 1100;
const INDEX = 1.33;

// CIE 1931 colour matching, by Wyman, Sloan and Shirley's sums of skewed Gaussians.
function lobe(l: number, mu: number, below: number, above: number) {
  const t = (l - mu) / (l < mu ? below : above);
  return Math.exp(-0.5 * t * t);
}
const cmf = (l: number) => [
  1.056 * lobe(l, 599.8, 37.9, 31) + 0.362 * lobe(l, 442, 16, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
  0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
  1.217 * lobe(l, 437, 11.8, 36) + 0.681 * lobe(l, 459, 26, 13.8)
];
const toRgb = (x: number, y: number, z: number) => [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];

// The reflected colour by thickness (across) and the cosine of the angle of incidence (up), as linear RGB with white 1.
export function filmTable() {
  const W = 512;
  const H = 32;
  const lambdas: number[] = [];
  for (let l = 380; l <= 780; l += 5) lambdas.push(l);
  const curves = lambdas.map(cmf);
  let ySum = 0;
  for (const c of curves) ySum += c[1];
  const white = toRgb(...(curves.reduce((s, c) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]).map((v) => v / ySum) as [number, number, number]));
  const data = new Uint16Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const cosi = Math.max(j / (H - 1), 0.001);
    const sini2 = 1 - cosi * cosi;
    const cost = Math.sqrt(1 - sini2 / (INDEX * INDEX));
    const rs = (cosi - INDEX * cost) / (cosi + INDEX * cost);
    const rp = (INDEX * cosi - cost) / (INDEX * cosi + cost);
    for (let i = 0; i < W; i++) {
      const d = (i / (W - 1)) * MOST;
      let X = 0;
      let Y = 0;
      let Z = 0;
      lambdas.forEach((l, k) => {
        const cd = Math.cos((4 * Math.PI * INDEX * d * cost) / l);
        // Airy's sum for a film between two equal media: the two faces' reflections, and every bounce between them.
        const airy = (r: number) => {
          const r2 = r * r;
          return (2 * r2 * (1 - cd)) / (1 + r2 * r2 - 2 * r2 * cd);
        };
        const R = 0.5 * (airy(rs) + airy(rp));
        X += R * curves[k][0];
        Y += R * curves[k][1];
        Z += R * curves[k][2];
      });
      const rgb = toRgb(X / ySum, Y / ySum, Z / ySum);
      for (let c = 0; c < 3; c++) data[(j * W + i) * 4 + c] = THREE.DataUtils.toHalfFloat(Math.max(0, rgb[c] / white[c]));
      data[(j * W + i) * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, most: MOST };
}


// The studio the bubble mirrors, all maths: near black, a big warm softbox up to the left, a tall cool strip to the right,
// a dim wide card behind the eye that fills the bubble's face with faint colour, and a warm rim light behind.
const KEY = [-0.5, 0.72, 0.48] as const;
export function studio(r: any, scale = 1) {
  const panel = (centre: readonly [number, number, number], upHint: [number, number, number], halfW: number, halfH: number, soft: number) => {
    const c = vec3(...centre).normalize() as any;
    const across = normalize(vec3(...upHint).cross(c)) as any;
    const upward = c.cross(across) as any;
    const along = max(dot(r, c), float(0.001)) as any;
    const x = abs(dot(r, across).div(along)) as any;
    const y = abs(dot(r, upward).div(along)) as any;
    const inside = float(1).sub(smoothstep(halfW - soft, halfW + soft, x)).mul(float(1).sub(smoothstep(halfH - soft, halfH + soft, y))) as any;
    return inside.mul(smoothstep(0, 0.2, dot(r, c)));
  };
  const key = panel(KEY, [0, 0, -1], 0.44, 0.3, 0.1) as any;
  const keyCore = panel(KEY, [0, 0, -1], 0.34, 0.21, 0.05) as any;
  const strip = panel([1, 0.08, -0.15], [0, 1, 0], 0.07, 1.2, 0.05) as any;
  const rim = panel([-0.45, 0.25, -0.86], [0, 1, 0], 0.09, 0.9, 0.06) as any;
  const card = panel([0.12, 0.05, 1], [0, 1, 0], 0.9, 0.7, 0.5) as any;
  const top = panel([0.1, 1, 0.3], [0, 0, -1], 0.9, 0.55, 0.45) as any;
  const glow = pow(max(dot(r, vec3(...KEY).normalize()), float(0)), float(3)) as any;
  const dome = mix(vec3(0.004, 0.0045, 0.006), vec3(0.03, 0.032, 0.04), smoothstep(-0.7, 0.9, r.y)) as any;
  return dome
    .add(vec3(1, 0.93, 0.85).mul(key.mul(1.5).add(keyCore.mul(2.4)).add(glow.mul(0.02))))
    .add(vec3(0.72, 0.84, 1).mul(strip.mul(2.2)))
    .add(vec3(1, 0.8, 0.62).mul(rim.mul(1.7)))
    .add(vec3(0.6, 0.64, 0.72).mul(card.mul(0.01)))
    .add(vec3(0.9, 0.92, 1).mul(top.mul(0.32)))
    .mul(scale);
}
