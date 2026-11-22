import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";
import { mulberry32 } from "../../shared/engine/random";

// The cloud's body is a handful of soft lobes that wander slowly, worked out here on the processor each frame and handed
// to the shader, so the same lobes decide where a tap lands and where the echoes come from: each lobe is a dense knot
// that answers a passing pulse with an echo of its own.
export const LOBES = 6;
// Every shell of light at once: the first few slots are pulses sent by the hand, the rest their echoes.
export const PRIMARIES = 6;
export const SLOTS = 24;
// How fast a pulse runs out through the smoke, and its echoes, in units a second; and how far each goes before it is spent.
export const SPEED = 1.45;
export const ECHO_SPEED = 1.05;
export const REACH = 3.4;
export const ECHO_REACH = 1.7;
// The ball the smoke lives in.
export const BOUNDS = 1.95;

type Lobe = { base: THREE.Vector3; size: number; phase: THREE.Vector3; rate: THREE.Vector3; swing: number };

const random = mulberry32(2026_11_22);
const LOBE_SPECS: Lobe[] = [
  [0, 0.05, 0, 0.78],
  [0.62, 0.28, 0.1, 0.56],
  [-0.58, -0.12, 0.22, 0.6],
  [0.14, -0.5, -0.32, 0.52],
  [-0.2, 0.55, -0.28, 0.5],
  [0.38, -0.22, 0.5, 0.46]
].map(([x, y, z, size]) => ({
  base: new THREE.Vector3(x, y, z),
  size,
  phase: new THREE.Vector3(random() * 6.3, random() * 6.3, random() * 6.3),
  rate: new THREE.Vector3(0.09 + random() * 0.08, 0.07 + random() * 0.08, 0.08 + random() * 0.08),
  swing: 0.16 + random() * 0.1
}));

export const nebula = {
  time: uniform(0),
  frame: uniform(0),
  density: uniform(1),
  // One past the last shell still alive, so the shader loops over no more than it must.
  top: uniform(0, "int"),
  // The same for the hand's own pulses, the only ones that push the smoke.
  pushes: uniform(0, "int"),
  // The noise drifting slowly upward and round, as smoke does.
  drift: uniform(new THREE.Vector3()),
  // Each lobe: centre (xyz) and size (w).
  lobes: uniformArray(
    Array.from({ length: LOBES }, () => new THREE.Vector4()),
    "vec4"
  ),
  // Each shell: where it started (xyz) and when (w); and its strength, speed, kind (0 the hand's, 1 an echo) and tint.
  origins: uniformArray(
    Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, 0, -99)),
    "vec4"
  ),
  shells: uniformArray(
    Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 1, 0, 0)),
    "vec4"
  )
};

const centres = Array.from({ length: LOBES }, () => new THREE.Vector3());

// Where every lobe is at time t, written into the uniforms and kept for the processor's own use.
export function placeLobes(t: number) {
  const list = nebula.lobes.array as THREE.Vector4[];
  LOBE_SPECS.forEach((l, k) => {
    const c = centres[k].set(
      l.base.x + Math.sin(t * l.rate.x + l.phase.x) * l.swing,
      l.base.y + Math.sin(t * l.rate.y + l.phase.y) * l.swing * 0.8,
      l.base.z + Math.sin(t * l.rate.z + l.phase.z) * l.swing
    );
    const size = l.size * (1 + 0.08 * Math.sin(t * 0.31 + l.phase.y));
    list[k].set(c.x, c.y, c.z, size);
  });
}

export const lobeCentre = (k: number) => centres[k];
export const lobeSize = (k: number) => (nebula.lobes.array as THREE.Vector4[])[k].w;

// The lobes' sum at a point, as the shader works it out before the noise.
export function envelope(p: THREE.Vector3) {
  const list = nebula.lobes.array as THREE.Vector4[];
  let sum = 0;
  for (const l of list) {
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    const dz = p.z - l.z;
    sum += Math.exp(-(dx * dx + dy * dy + dz * dz) / (l.w * l.w));
  }
  return sum;
}

// The smoke's noise, baked once into a small cube that tiles: red a smooth fractal, green rounded Worley billows, blue
// and alpha two more fractals that warp the rest.
const SIZE = 64;
let baked: THREE.Data3DTexture | null = null;

export function smokeNoise() {
  if (baked) return baked;
  const rnd = mulberry32(2026_22);
  const count = SIZE * SIZE * SIZE;
  const lattice = (period: number) => Float32Array.from({ length: period * period * period }, () => rnd());
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const smooth = (table: Float32Array, period: number, x: number, y: number, z: number) => {
    const fx = x * period;
    const fy = y * period;
    const fz = z * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const e = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const u = e(fx - x0);
    const v = e(fy - y0);
    const w = e(fz - z0);
    const at = (a: number, b: number, c: number) => table[wrap(x0 + a, period) + wrap(y0 + b, period) * period + wrap(z0 + c, period) * period * period];
    const near = (at(0, 0, 0) * (1 - u) + at(1, 0, 0) * u) * (1 - v) + (at(0, 1, 0) * (1 - u) + at(1, 1, 0) * u) * v;
    const far = (at(0, 0, 1) * (1 - u) + at(1, 0, 1) * u) * (1 - v) + (at(0, 1, 1) * (1 - u) + at(1, 1, 1) * u) * v;
    return near * (1 - w) + far * w;
  };
  const PERIODS = [4, 8, 16, 32];
  const fractals = [0, 1, 2].map(() => PERIODS.map((p) => lattice(p)));
  const fbm = (tables: Float32Array[], x: number, y: number, z: number) => {
    let sum = 0;
    let amplitude = 0.5;
    for (let o = 0; o < PERIODS.length; o++) {
      sum += smooth(tables[o], PERIODS[o], x, y, z) * amplitude;
      amplitude *= 0.5;
    }
    return sum / 0.9375;
  };
  const CELLS = [4, 8, 16];
  const points = CELLS.map((c) => Float32Array.from({ length: c * c * c * 3 }, () => rnd()));
  const worley = (level: number, x: number, y: number, z: number) => {
    const cells = CELLS[level];
    const table = points[level];
    const cx = x * cells;
    const cy = y * cells;
    const cz = z * cells;
    const hx = Math.floor(cx);
    const hy = Math.floor(cy);
    const hz = Math.floor(cz);
    let nearest = 9;
    for (let c = -1; c <= 1; c++)
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) {
          const i = (wrap(hx + a, cells) + wrap(hy + b, cells) * cells + wrap(hz + c, cells) * cells * cells) * 3;
          const dx = hx + a + table[i] - cx;
          const dy = hy + b + table[i + 1] - cy;
          const dz = hz + c + table[i + 2] - cz;
          nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
        }
    return 1 - Math.min(1, Math.sqrt(nearest));
  };
  const channels = [0, 1, 2, 3].map(() => new Float32Array(count));
  for (let k = 0, o = 0; k < SIZE; k++)
    for (let j = 0; j < SIZE; j++)
      for (let i = 0; i < SIZE; i++, o++) {
        const x = i / SIZE;
        const y = j / SIZE;
        const z = k / SIZE;
        channels[0][o] = fbm(fractals[0], x, y, z);
        channels[1][o] = worley(0, x, y, z) * 0.55 + worley(1, x, y, z) * 0.3 + worley(2, x, y, z) * 0.15;
        channels[2][o] = fbm(fractals[1], x, y, z);
        channels[3][o] = fbm(fractals[2], x, y, z);
      }
  const data = new Uint8Array(count * 4);
  channels.forEach((values, channel) => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(count * 0.02)];
    const high = sorted[Math.floor(count * 0.98)];
    for (let i = 0; i < count; i++) data[i * 4 + channel] = Math.max(0, Math.min(1, (values[i] - low) / (high - low))) * 255;
  });
  baked = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  baked.format = THREE.RGBAFormat;
  baked.type = THREE.UnsignedByteType;
  baked.minFilter = THREE.LinearFilter;
  baked.magFilter = THREE.LinearFilter;
  baked.wrapS = baked.wrapT = baked.wrapR = THREE.RepeatWrapping;
  baked.needsUpdate = true;
  return baked;
}

// A tile of blue noise, made by void and cluster: every value from 0 to 1 once, spread so that no two near values sit
// close together. Each pixel starts its march at its own value, so the leftover banding is a fine, even grain that the
// history averages away, without the clumps white noise leaves.
const BLUE = 64;
let blue: THREE.DataTexture | null = null;

export function blueNoise() {
  if (blue) return blue;
  const n = BLUE * BLUE;
  const rnd = mulberry32(64);
  const on = new Uint8Array(n);
  const energy = new Float32Array(n);
  const R = 6;
  const kernel: number[] = [];
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) kernel.push(Math.exp(-(x * x + y * y) / (2 * 1.9 * 1.9)));
  const splat = (i: number, sign: number) => {
    const px = i % BLUE;
    const py = (i / BLUE) | 0;
    let k = 0;
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++, k++) {
        const j = ((px + x + BLUE) % BLUE) + ((py + y + BLUE) % BLUE) * BLUE;
        energy[j] += kernel[k] * sign;
      }
  };
  const tightest = () => {
    let best = -1;
    let at = 0;
    for (let i = 0; i < n; i++)
      if (on[i] && energy[i] > best) {
        best = energy[i];
        at = i;
      }
    return at;
  };
  const emptiest = () => {
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < n; i++)
      if (!on[i] && energy[i] < best) {
        best = energy[i];
        at = i;
      }
    return at;
  };
  // A first scatter, relaxed until the tightest point is also the emptiest place to put it.
  const seeds = Math.floor(n * 0.1);
  for (let s = 0; s < seeds; s++) {
    let i = Math.floor(rnd() * n);
    while (on[i]) i = Math.floor(rnd() * n);
    on[i] = 1;
    splat(i, 1);
  }
  for (let guard = 0; guard < n; guard++) {
    const t = tightest();
    on[t] = 0;
    splat(t, -1);
    const e = emptiest();
    on[e] = 1;
    splat(e, 1);
    if (e === t) break;
  }
  const rank = new Int32Array(n);
  const initial = on.slice();
  const initialEnergy = energy.slice();
  for (let r = seeds - 1; r >= 0; r--) {
    const t = tightest();
    on[t] = 0;
    splat(t, -1);
    rank[t] = r;
  }
  on.set(initial);
  energy.set(initialEnergy);
  for (let r = seeds; r < n; r++) {
    const e = emptiest();
    on[e] = 1;
    splat(e, 1);
    rank[e] = r;
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.floor(((rank[i] + 0.5) / n) * 256);
    data.set([v, v, v, 255], i * 4);
  }
  blue = new THREE.DataTexture(data, BLUE, BLUE, THREE.RGBAFormat, THREE.UnsignedByteType);
  blue.minFilter = THREE.NearestFilter;
  blue.magFilter = THREE.NearestFilter;
  blue.wrapS = blue.wrapT = THREE.RepeatWrapping;
  blue.generateMipmaps = false;
  blue.needsUpdate = true;
  return blue;
}
export const BLUE_SIZE = BLUE;
