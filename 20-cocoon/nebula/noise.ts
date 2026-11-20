import * as THREE from "three/webgpu";
import { mulberry32 } from "../../shared/engine/random";

// The gas's noise, baked once into a small cube that tiles in every direction, so the shader reads a whole fractal in a
// single filtered tap rather than working it out at every step. Four unrelated channels:
//   red    smooth fractal noise, the large structure of the cloud and its filaments when folded into ridges
//   green  Worley billows, rounded knots of gas
//   blue   a second fractal, one of the three that warp the rest
//   alpha  a third fractal, the last of the warp and the dust lanes
const SIZE = 64;
let baked: THREE.Data3DTexture | null = null;

export function nebulaNoise() {
  if (baked) return baked;
  const random = mulberry32(2026_11_20);
  const count = SIZE * SIZE * SIZE;

  // Lattices of random values, one per octave and channel, so the fractal is table lookups rather than hashing.
  const lattice = (period: number) => Float32Array.from({ length: period * period * period }, () => random());
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

  // One feature point per cell, for the billows.
  const CELLS = [4, 8, 16];
  const points = CELLS.map((c) => Float32Array.from({ length: c * c * c * 3 }, () => random()));
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
        channels[1][o] = worley(0, x, y, z) * 0.6 + worley(1, x, y, z) * 0.28 + worley(2, x, y, z) * 0.12;
        channels[2][o] = fbm(fractals[1], x, y, z);
        channels[3][o] = fbm(fractals[2], x, y, z);
      }

  // Each channel stretched to fill the range, from its 2nd to its 98th percentile, so thresholds mean what they say.
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
