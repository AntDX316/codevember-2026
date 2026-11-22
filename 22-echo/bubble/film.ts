import * as THREE from "three/webgpu";
import { abs, atan, clamp, cross, dot, exp, float, floor, Fn, instancedArray, instanceIndex, int, max, mix, mx_noise_float, normalize, tan, uniform, vec3 } from "three/tsl";
import { clock, stirAt, hold } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The soap film. Its colour is real thin-film interference: light reflected off the film's two faces, one of them
// flipped half a wave, adds or cancels by wavelength as the thickness changes. A table worked out once on the processor
// gives the colour reflected for every thickness and angle, summed over the spectrum through the eye's colour response.
//
// Its thickness is a live field over the bubble, on the six faces of a cube pushed out onto the sphere, moved on the GPU
// each frame. The film drains under gravity (thin at the top, thick below), thin patches float up, a slow turbulence
// marbles it, and passing waves drag it round and stir eddies into it.

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

// How aged the film is: 0 fresh and thick, 1 drained thin, with black film opening at the top.
export const age = uniform(0.45) as any;
export const step = uniform(1 / 60) as any;

// The film's resting thickness by height: thin at the crown, thick in the belly, all of it thinner as it ages.
const resting = (n: any) => {
  const down = n.y.negate().mul(0.5).add(0.5) as any;
  const thick = mix(float(1.05), float(0.62), age) as any;
  const crown = mix(float(0.2), float(0.02), age) as any;
  return mix(crown, thick, down.pow(1.4));
};

// A face's frame: the way out, and right and up across it, as in the mesh.
const faceFrame = (face: any) => {
  const sx = face.equal(int(0)).select(float(1), float(-1)) as any;
  const sy = face.equal(int(2)).select(float(1), float(-1)) as any;
  const sz = face.equal(int(4)).select(float(1), float(-1)) as any;
  const isX = face.lessThan(int(2)) as any;
  const isY = face.lessThan(int(4)).and(isX.not()) as any;
  const out = isX.select(vec3(sx, 0, 0), isY.select(vec3(0, sy, 0), vec3(0, 0, sz))) as any;
  const right = isX.select(vec3(0, 0, sx.negate()), isY.select(vec3(1, 0, 0), vec3(sz, 0, 0))) as any;
  const up = isX.select(vec3(0, 1, 0), isY.select(vec3(0, 0, sy.negate()), vec3(0, 1, 0))) as any;
  return { out, right, up };
};

export function makeField(cells: number) {
  const N = cells;
  const count = 6 * N * N;
  const now = instancedArray(count, "float") as any;
  const next = instancedArray(count, "float") as any;

  // The field at direction d, read smoothly from the cell grid of the face it falls on.
  const sample = (buffer: any, d: any) => {
    const ax = abs(d.x) as any;
    const ay = abs(d.y) as any;
    const az = abs(d.z) as any;
    const isX = ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az)) as any;
    const isY = ay.greaterThanEqual(az).and(isX.not()) as any;
    const face = isX.select(d.x.greaterThan(0).select(int(0), int(1)), isY.select(d.y.greaterThan(0).select(int(2), int(3)), d.z.greaterThan(0).select(int(4), int(5)))).toVar() as any;
    const { out, right, up } = faceFrame(face);
    const along = dot(d, out) as any;
    const a = dot(d, right).div(along) as any;
    const b = dot(d, up).div(along) as any;
    const u = clamp(atan(a).mul(4 / Math.PI).add(1).mul(0.5 * N).sub(0.5), 0, N - 1.001).toVar() as any;
    const v = clamp(atan(b).mul(4 / Math.PI).add(1).mul(0.5 * N).sub(0.5), 0, N - 1.001).toVar() as any;
    const i = int(floor(u)) as any;
    const j = int(floor(v)) as any;
    const fu = u.sub(floor(u)) as any;
    const fv = v.sub(floor(v)) as any;
    const base = face.mul(N * N).add(j.mul(N)).add(i).toVar() as any;
    const h00 = buffer.element(base) as any;
    const h10 = buffer.element(base.add(1)) as any;
    const h01 = buffer.element(base.add(N)) as any;
    const h11 = buffer.element(base.add(N + 1)) as any;
    return mix(mix(h00, h10, fu), mix(h01, h11, fu), fv);
  };

  const cellDir = () => {
    const face = int(instanceIndex.div(N * N)).toVar() as any;
    const rest = int(instanceIndex.mod(N * N)) as any;
    const i = rest.mod(N) as any;
    const j = rest.div(N) as any;
    const { out, right, up } = faceFrame(face);
    const a = tan(float(i).add(0.5).mul(2 / N).sub(1).mul(Math.PI / 4)) as any;
    const b = tan(float(j).add(0.5).mul(2 / N).sub(1).mul(Math.PI / 4)) as any;
    return normalize(out.add(right.mul(a)).add(up.mul(b))).toVar() as any;
  };

  // A stream function's gradient by forward differences: crossed with the normal, a flow that only ever turns.
  const curl = (n: any, p: any) => {
    const e = 0.03;
    const f0 = mx_noise_float(p) as any;
    const g = vec3(mx_noise_float(p.add(vec3(e, 0, 0))).sub(f0), mx_noise_float(p.add(vec3(0, e, 0))).sub(f0), mx_noise_float(p.add(vec3(0, 0, e))).sub(f0)).div(e) as any;
    return cross(n, g);
  };

  const seed = Fn(() => {
    const n = cellDir();
    const marble = mx_noise_float(n.mul(3.1)).mul(0.18).add(mx_noise_float(n.mul(7.3).add(4.1)).mul(0.08)) as any;
    now.element(instanceIndex).assign(max(resting(n).add(marble), float(0.01)));
  })().compute(count);

  const advect = Fn(() => {
    const n = cellDir();
    const here = now.element(instanceIndex) as any;
    const t = clock as any;
    // Slow turbulence in two sizes, both drifting so the vortices wander and are reborn.
    const big = curl(n, n.mul(1.5).add(vec3(t.mul(0.021), t.mul(-0.013), t.mul(0.017)))).mul(0.05) as any;
    const fine = curl(n, n.mul(3.6).add(vec3(t.mul(-0.03), t.mul(0.02), t.mul(0.025)).add(7.7))).toVar() as any;
    // Thin film is lighter: patches thinner than their height's rest float up, thicker ones sink, in plumes.
    const upward = vec3(0, 1, 0).sub(n.mul(n.y)) as any;
    const buoy = upward.mul(resting(n).sub(here).mul(0.32)) as any;
    // The waves: each ring drags the film along as it passes and leaves eddies spinning in its wake.
    const stir = stirAt(n);
    const wake = fine.mul(stir.w.mul(1.1).add(0.018)) as any;
    // A held tone gathers the film into its pattern's bands.
    const bands = hold.flow(n) as any;
    const flow = big.add(wake).add(buoy).add(stir.xyz.mul(0.9)).add(bands).toVar() as any;
    const from = normalize(n.sub(flow.mul(step))) as any;
    const moved = sample(now, from).toVar() as any;
    // Slowly back towards the resting drainage, with a faint marbling sown in so the flow always has something to fold.
    const sown = mx_noise_float(n.mul(4.2).add(vec3(0, t.mul(0.04), 0))).mul(0.12) as any;
    const settle = float(1).sub(exp(step.mul(-0.045))) as any;
    moved.addAssign(resting(n).add(sown).sub(moved).mul(settle));
    next.element(instanceIndex).assign(clamp(moved, 0.005, 1.25));
  })().compute(count);

  const copy = Fn(() => {
    now.element(instanceIndex).assign(next.element(instanceIndex));
  })().compute(count);

  return { N, now, seed, advect, copy, sample: (d: any) => sample(now, d) };
}

export type Field = ReturnType<typeof makeField>;

