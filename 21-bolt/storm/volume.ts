import * as THREE from "three/webgpu";
import { mulberry32 } from "../../shared/engine/random";
import { BASE, BOX, MOON } from "./state";

// Everything heavy about the cloud is worked out once, behind the loader, and kept in two small 3D textures, so that
// the shader reads a whole cloud and its lighting in one filtered tap a step.
//
// noise (64³, tiles every way): red Perlin–Worley billows, green fine Worley to wear the edges, blue and alpha smooth
// fractals for the rain's streaks and the sea's ripples.
//
// cloud (96 × 72 × 88 over BOX): red the density; green how much moonlight gets through to each point; blue how much
// light from below (a strike) reaches up into it; alpha how open each point is to the air round it, for the soft
// light that bounces about inside.

const N = 64;
const CX = 96;
const CY = 84;
const CZ = 88;

export type StormVolume = {
  noise: THREE.Data3DTexture;
  cloud: THREE.Data3DTexture;
  // Points well inside the cloud, for flashes to start from: x, y, z in turn.
  inside: Float32Array;
  // The density at a world point, for finding where a tap meets the cloud.
  densityAt: (x: number, y: number, z: number) => number;
};

let baked: Promise<StormVolume> | null = null;

export function bakeStorm() {
  baked ??= bake();
  return baked;
}

// A breath for the page every so often, so the loader keeps turning while this works.
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function bake(): Promise<StormVolume> {
  const random = mulberry32(2026_11_21);
  let last = performance.now();
  const maybeBreathe = async () => {
    if (performance.now() - last > 28) {
      await breathe();
      last = performance.now();
    }
  };

  // --- The noise ---
  const count = N * N * N;
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const lattice = (period: number) => Float32Array.from({ length: period * period * period }, () => random());
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
    const xa = wrap(x0, period);
    const xb = wrap(x0 + 1, period);
    const ya = wrap(y0, period) * period;
    const yb = wrap(y0 + 1, period) * period;
    const za = wrap(z0, period) * period * period;
    const zb = wrap(z0 + 1, period) * period * period;
    const near = (table[xa + ya + za] * (1 - u) + table[xb + ya + za] * u) * (1 - v) + (table[xa + yb + za] * (1 - u) + table[xb + yb + za] * u) * v;
    const far = (table[xa + ya + zb] * (1 - u) + table[xb + ya + zb] * u) * (1 - v) + (table[xa + yb + zb] * (1 - u) + table[xb + yb + zb] * u) * v;
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
  const CELLS = [4, 8, 16, 32];
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
          const d = dx * dx + dy * dy + dz * dz;
          if (d < nearest) nearest = d;
        }
    return 1 - Math.min(1, Math.sqrt(nearest));
  };

  const channels = [0, 1, 2, 3].map(() => new Float32Array(count));
  for (let k = 0, o = 0; k < N; k++) {
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++, o++) {
        const x = i / N;
        const y = j / N;
        const z = k / N;
        const f = fbm(fractals[0], x, y, z);
        const billows = worley(0, x, y, z) * 0.625 + worley(1, x, y, z) * 0.25 + worley(2, x, y, z) * 0.125;
        channels[0][o] = f * 0.5 + billows * 0.5 + f * billows * 0.6;
        channels[1][o] = worley(1, x, y, z) * 0.625 + worley(2, x, y, z) * 0.25 + worley(3, x, y, z) * 0.125;
        channels[2][o] = fbm(fractals[1], x, y, z);
        channels[3][o] = fbm(fractals[2], x, y, z);
      }
    await maybeBreathe();
  }
  // Each channel stretched from its 2nd to its 98th percentile, so thresholds mean what they say.
  const noiseData = new Uint8Array(count * 4);
  channels.forEach((values, channel) => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(count * 0.02)];
    const high = sorted[Math.floor(count * 0.98)];
    for (let i = 0; i < count; i++) {
      const v = Math.max(0, Math.min(1, (values[i] - low) / (high - low)));
      values[i] = v;
      noiseData[i * 4 + channel] = v * 255;
    }
  });
  await maybeBreathe();

  // The noise, read back here with a filter, to shape the cloud.
  const sampleNoise = (values: Float32Array, x: number, y: number, z: number) => {
    const fx = x * N - 0.5;
    const fy = y * N - 0.5;
    const fz = z * N - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const u = fx - x0;
    const v = fy - y0;
    const w = fz - z0;
    const xa = wrap(x0, N);
    const xb = wrap(x0 + 1, N);
    const ya = wrap(y0, N) * N;
    const yb = wrap(y0 + 1, N) * N;
    const za = wrap(z0, N) * N * N;
    const zb = wrap(z0 + 1, N) * N * N;
    const near = (values[xa + ya + za] * (1 - u) + values[xb + ya + za] * u) * (1 - v) + (values[xa + yb + za] * (1 - u) + values[xb + yb + za] * u) * v;
    const far = (values[xa + ya + zb] * (1 - u) + values[xb + ya + zb] * u) * (1 - v) + (values[xa + yb + zb] * (1 - u) + values[xb + yb + zb] * u) * v;
    return near * (1 - w) + far * w;
  };

  // --- The shape: a towering cumulonimbus, as a signed distance (negative inside) ---
  const smin = (a: number, b: number, k: number) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  };
  // The towers: the main updraft, broad and tallest, punching into the anvil, and a flanking line of smaller ones
  // stepping down upwind of it, each a stack of rounded heads that narrows as it climbs.
  const TOWERS = [
    { x: 0.4, z: 0.1, top: 16.6, r: 4.2, lean: 0.1 },
    { x: 2.6, z: -2.8, top: 13.2, r: 3.0, lean: 0.09 },
    { x: -4.7, z: 1.9, top: 11.0, r: 2.8, lean: 0.08 },
    { x: -7.7, z: 3.3, top: 8.4, r: 2.1, lean: 0.06 },
    { x: -9.8, z: 4.2, top: 6.3, r: 1.4, lean: 0.05 }
  ];
  const heads: number[][] = [];
  for (const tower of TOWERS) {
    for (let y = BASE + tower.r * 0.55; y < tower.top - 0.4; y += 0.85) {
      const h = (y - BASE) / (tower.top - BASE);
      const r = tower.r * (1 - 0.32 * h * h) * (0.92 + random() * 0.16);
      heads.push([tower.x + (y - BASE) * tower.lean + (random() - 0.5) * 0.5, Math.min(y, tower.top - r * 0.8), tower.z + (random() - 0.5) * 0.5, r]);
    }
    // Turrets: smaller heads pushing out of its sides, more of them higher up.
    const count = Math.round(tower.r * 4);
    for (let t = 0; t < count; t++) {
      const h = Math.pow(random(), 0.7);
      const y = BASE + 0.8 + h * (tower.top - BASE - 1.2);
      const angle = random() * Math.PI * 2;
      const reach = tower.r * (1 - 0.32 * h * h) * (0.6 + random() * 0.3);
      heads.push([tower.x + (y - BASE) * tower.lean + Math.cos(angle) * reach, y, tower.z + Math.sin(angle) * reach, tower.r * (0.32 + random() * 0.18) * (1 - h * 0.35)]);
    }
  }
  // The anvil, blown downwind (+x): an ellipse in plan, thick over the tower and thin at its far edge.
  const ANVIL = { x: 5.0, rx: 8.6, rz: 6.6 };
  const anvilAt = (x: number, z: number) => Math.hypot((x - ANVIL.x) / ANVIL.rx, z / ANVIL.rz);
  const anvilTop = (r: number) => 17.0 + r * 0.2;
  const anvilBottom = (x: number, r: number) => 15.0 + r * r * 1.3 + Math.max(0, (x - ANVIL.x) / ANVIL.rx) * 0.6;
  // Mammatus: pouches hanging from the underside of the anvil downwind, on a jittered grid.
  const pouches: number[][] = [];
  for (let gx = -4; gx <= 14; gx += 1.2)
    for (let gz = -7; gz <= 7; gz += 1.2) {
      const x = gx + (random() - 0.5) * 0.8;
      const z = gz + (random() - 0.5) * 0.8;
      const r = anvilAt(x, z);
      if (x < 3.5 || r < 0.35 || r > 0.88 || random() < 0.2) continue;
      pouches.push([x, anvilBottom(x, r) - 0.2 - random() * 0.3, z, 0.4 + random() * 0.28]);
    }
  const sdf = (x: number, y: number, z: number) => {
    let d = 1e3;
    for (const [hx, hy, hz, hr] of heads) {
      const dx = x - hx;
      const dy = (y - hy) * 1.1;
      const dz = z - hz;
      d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - hr, 1.3);
    }
    const r = anvilAt(x, z);
    const edge = (r - 1) * ANVIL.rz;
    const dv = Math.max(y - anvilTop(r), anvilBottom(x, r) - y);
    d = smin(d, Math.max(edge, dv), 1.4);
    // The overshooting top, a dome punching up through the anvil above the main updraft.
    const ox = x - 1.6;
    const oy = (y - 17.2) * 1.35;
    const oz = z - 0.1;
    d = smin(d, Math.sqrt(ox * ox + oy * oy + oz * oz) - 2.3, 1.0);
    for (const [px, py, pz, pr] of pouches) {
      const dx = x - px;
      const dz = z - pz;
      if (Math.abs(dx) > 1.5 || Math.abs(dz) > 1.5) continue;
      const dy = (y - py) * 0.9;
      d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - pr, 0.45);
    }
    return d;
  };

  const size = new THREE.Vector3().subVectors(BOX.max, BOX.min);
  const vx = size.x / CX;
  const vy = size.y / CY;
  const vz = size.z / CZ;
  const total = CX * CY * CZ;
  const density = new Float32Array(total);
  const insideList: number[] = [];
  for (let k = 0; k < CZ; k++) {
    for (let j = 0; j < CY; j++)
      for (let i = 0; i < CX; i++) {
        const x = BOX.min.x + (i + 0.5) * vx;
        const y = BOX.min.y + (j + 0.5) * vy;
        const z = BOX.min.z + (k + 0.5) * vz;
        const d = sdf(x, y, z);
        if (d > 2.2) continue;
        // Billows in the tower, long fibres smeared downwind in the anvil.
        const anvil = THREE.MathUtils.smoothstep(y, 14.2, 15.6);
        const billow = sampleNoise(channels[0], x / 6.5 + 0.31, y / 5.5, z / 6.5 + 0.17) * 0.88 + sampleNoise(channels[0], x / 2.9 + 0.7, y / 2.6, z / 2.9) * 0.12;
        const fibre = sampleNoise(channels[0], x / 19 + 0.6, y / 3.2, z / 13) * 0.6 + sampleNoise(channels[2], x / 9, y / 2.6, z / 6) * 0.4;
        const n = billow * (1 - anvil) + fibre * anvil;
        const shaped = -d + (n - 0.5) * (2.6 - anvil * 1.1);
        // The base: flat and dark, lowered a little under the updraft into a wall cloud.
        const lowered = BASE - 0.7 * Math.exp(-((x - 0.7) * (x - 0.7) + (z - 0.4) * (z - 0.4)) / 3.0);
        const floor = THREE.MathUtils.smoothstep(y, lowered - 0.15, lowered + 0.45);
        const v = Math.max(0, Math.min(1, shaped * 0.85)) * floor;
        density[i + j * CX + k * CX * CY] = v;
        if (v > 0.85 && random() < 0.02) insideList.push(x, y, z);
      }
    await maybeBreathe();
  }

  // --- The light, marched through the density once, here ---
  const at = (x: number, y: number, z: number) => {
    const i = Math.floor((x - BOX.min.x) / vx);
    const j = Math.floor((y - BOX.min.y) / vy);
    const k = Math.floor((z - BOX.min.z) / vz);
    if (i < 0 || j < 0 || k < 0 || i >= CX || j >= CY || k >= CZ) return 0;
    return density[i + j * CX + k * CX * CY];
  };
  const depthToward = (x: number, y: number, z: number, dx: number, dy: number, dz: number, steps: number, step: number, grow: number) => {
    let sum = 0;
    let s = step;
    let t = s * 0.5;
    for (let n = 0; n < steps; n++) {
      sum += at(x + dx * t, y + dy * t, z + dz * t) * s;
      t += s;
      s *= grow;
    }
    return sum;
  };
  // Six directions round each point, tipped toward the sky, for how open it is.
  const AROUND = [
    [0, 1, 0],
    [0.8, 0.45, 0],
    [-0.8, 0.45, 0],
    [0, 0.45, 0.8],
    [0, 0.45, -0.8],
    [0, -1, 0]
  ].map((v) => new THREE.Vector3(...v).normalize());
  const cloudData = new Uint8Array(total * 4);
  for (let k = 0; k < CZ; k++) {
    for (let j = 0; j < CY; j++)
      for (let i = 0; i < CX; i++) {
        const o = i + j * CX + k * CX * CY;
        const x = BOX.min.x + (i + 0.5) * vx;
        const y = BOX.min.y + (j + 0.5) * vy;
        const z = BOX.min.z + (k + 0.5) * vz;
        const moon = depthToward(x, y, z, MOON.x, MOON.y, MOON.z, 14, 0.22, 1.18);
        const below = depthToward(x, y, z, 0, -1, 0, 10, 0.2, 1.15);
        let open = 0;
        for (const a of AROUND) open += Math.exp(-depthToward(x, y, z, a.x, a.y, a.z, 6, 0.3, 1.25) * 0.9);
        cloudData[o * 4] = density[o] * 255;
        cloudData[o * 4 + 1] = Math.exp(-moon * 0.6) * 255;
        cloudData[o * 4 + 2] = Math.exp(-below * 0.6) * 255;
        cloudData[o * 4 + 3] = (open / AROUND.length) * 255;
      }
    await maybeBreathe();
  }

  const noise = new THREE.Data3DTexture(noiseData, N, N, N);
  noise.format = THREE.RGBAFormat;
  noise.type = THREE.UnsignedByteType;
  noise.minFilter = THREE.LinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
  noise.needsUpdate = true;

  const cloud = new THREE.Data3DTexture(cloudData, CX, CY, CZ);
  cloud.format = THREE.RGBAFormat;
  cloud.type = THREE.UnsignedByteType;
  cloud.minFilter = THREE.LinearFilter;
  cloud.magFilter = THREE.LinearFilter;
  cloud.wrapS = cloud.wrapT = cloud.wrapR = THREE.ClampToEdgeWrapping;
  cloud.needsUpdate = true;

  return { noise, cloud, inside: Float32Array.from(insideList), densityAt: at };
}
