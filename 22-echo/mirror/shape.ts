import * as THREE from "three/webgpu";
import { abs, clamp, dot, float, length, max, min, sin, texture3D, vec2, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The bubble's shape, as a distance field worked out exactly in the tracer and on the processor alike: the letters A
// and I drawn as strokes, each stroke a fat round rod a little plumper in its middle, squashed slightly front to back,
// all melted together with a smooth minimum so the joins swell like a balloon's. (The strokes are the pop version's.)

export const R = 0.205;
const FLAT = 0.82;
const SMOOTH = 0.085;
const SEGMENTS: [number, number, number, number][] = [
  // A: two legs to a rounded apex, and the bar.
  [-1.45, -0.9, -0.65, 0.9],
  [0.15, -0.9, -0.65, 0.9],
  [-1.08, -0.36, -0.22, -0.36],
  // I: the stem, and a serif top and bottom so it never reads as an l.
  [0.82, -0.9, 0.82, 0.9],
  [0.5, 0.9, 1.14, 0.9],
  [0.5, -0.9, 1.14, -0.9]
];
const SHIFT = -(-1.45 - R + 1.14 + R) / 2;
const segs = SEGMENTS.map(([ax, ay, bx, by]) => ({ ax: ax + SHIFT, ay, bx: bx + SHIFT, by, dx: bx - ax, dy: by - ay, len2: (bx - ax) ** 2 + (by - ay) ** 2 }));

// A box round the letters in their own space, with room for the most they swell, wobble and are blown.
export const BOUNDS = new THREE.Vector3(1.6 + R * 1.4 + 0.15, 0.9 + R * 1.4 + 0.15, R * FLAT * 1.4 + 0.2);

// A breeze on the film: it comes and goes in slow gusts, and while it blows, ripples run along the letters, pushing the
// film in and out the way a soap bubble shivers in a draught. Worked the same on the processor (for picking) and in the
// tracer, as a shift of the point the letters are measured at.
const gust = (t: number) => 0.6 + 0.4 * Math.sin(t * 0.21) * Math.sin(t * 0.47 + 1.3);
export function wind(x: number, y: number, z: number, t: number, out: THREE.Vector3) {
  const g = gust(t);
  return out.set(
    g * 0.02 * Math.sin(y * 2.1 - t * 2 + z * 3),
    g * 0.022 * Math.sin(x * 2.6 - t * 3),
    g * (0.06 * Math.sin(x * 1.9 - t * 2.4 + y * 0.7) + 0.024 * Math.sin(y * 3.3 + x * 1.4 - t * 3.6))
  );
}
// The gust depends on time alone, so the tracer works it out once a leg and passes it in.
export const gustNode = (t: any) => sin(t.mul(0.21)).mul(sin(t.mul(0.47).add(1.3))).mul(0.4).add(0.6) as any;
const windNode = (p: any, t: any, g: any = gustNode(t)) => {
  return vec3(
    sin(p.y.mul(2.1).sub(t.mul(2)).add(p.z.mul(3))).mul(0.02),
    sin(p.x.mul(2.6).sub(t.mul(3))).mul(0.022),
    sin(p.x.mul(1.9).sub(t.mul(2.4)).add(p.y.mul(0.7)))
      .mul(0.06)
      .add(sin(p.y.mul(3.3).add(p.x.mul(1.4)).sub(t.mul(3.6))).mul(0.024))
  ).mul(g) as any;
};
const blown = new THREE.Vector3();

// The distance on the processor, for picking and for scattering droplets. `fat` plumps the rods as it is pumped.
export function field(x: number, y: number, z: number, fat = 0) {
  const zz = z / FLAT;
  let d = 1e9;
  for (const s of segs) {
    const t = Math.min(1, Math.max(0, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.len2));
    const px = x - s.ax - s.dx * t;
    const py = y - s.ay - s.dy * t;
    const e = Math.sqrt(px * px + py * py + zz * zz) * FLAT - R * (1 + fat) * (1 + 0.32 * t * (1 - t));
    const h = Math.max(SMOOTH - Math.abs(d - e), 0) / SMOOTH;
    d = Math.min(d, e) - h * h * SMOOTH * 0.25;
  }
  return d;
}

export function gradient(x: number, y: number, z: number, out: THREE.Vector3, fat = 0) {
  const e = 0.0015;
  return out.set(field(x + e, y, z, fat) - field(x - e, y, z, fat), field(x, y + e, z, fat) - field(x, y - e, z, fat), field(x, y, z + e, fat) - field(x, y, z - e, fat)).divideScalar(2 * e);
}

// Where a ray in the letters' own space first comes within `margin` of them, as blown at `time`, or null.
export function march(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3, fat: number, margin: number, time: number) {
  let t = 0;
  for (let i = 0; i < 160; i++) {
    out.copy(origin).addScaledVector(dir, t);
    wind(out.x, out.y, out.z, time, blown);
    const d = field(out.x - blown.x, out.y - blown.y, out.z - blown.z, fat);
    if (d < margin) return t;
    t += Math.max(d * 0.9, 0.004);
    if (t > 40) break;
  }
  return null;
}

// The same distance in the tracer, blown by the breeze, with the film's slow wobble laid over it.
export function fieldNode(at: any, fat: any, wobble: any, time: any) {
  const p = at.sub(windNode(at, time)) as any;
  const zz = p.z.div(FLAT) as any;
  let d: any = float(1e9);
  for (const s of segs) {
    const a = vec2(s.ax, s.ay) as any;
    const ba = vec2(s.dx, s.dy) as any;
    const pa = p.xy.sub(a) as any;
    const t = clamp(dot(pa, ba).div(s.len2), 0, 1) as any;
    const q = pa.sub(ba.mul(t)) as any;
    const e = length(vec3(q, zz)).mul(FLAT).sub(float(R).mul(fat.add(1)).mul(t.mul(float(1).sub(t)).mul(0.32).add(1))) as any;
    const h = max(float(SMOOTH).sub(abs(d.sub(e))), float(0)).div(SMOOTH) as any;
    d = min(d, e).sub(h.mul(h).mul(SMOOTH * 0.25));
  }
  return d.add(wave(p, time).mul(wobble).mul(0.018));
}

const wave = (p: any, time: any) =>
  sin(p.x.mul(3.1).add(time.mul(2.3)))
    .mul(sin(p.y.mul(2.6).sub(time.mul(1.7))))
    .add(sin(p.x.mul(-1.7).add(p.y.mul(4.3)).add(time.mul(3.1))).mul(0.5)) as any;

// The distance baked once into a block of samples over the box, for the tracer's march: one look-up a step instead of
// every stroke. The exact field is still used for each hit's normal.
export function bakeField(nx: number, ny: number, nz: number) {
  const data = new Uint16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) / nx) * 2 * BOUNDS.x - BOUNDS.x;
        const y = ((j + 0.5) / ny) * 2 * BOUNDS.y - BOUNDS.y;
        const z = ((k + 0.5) / nz) * 2 * BOUNDS.z - BOUNDS.z;
        data[i + nx * (j + ny * k)] = THREE.DataUtils.toHalfFloat(field(x, y, z));
      }
  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

// The baked distance in the tracer, blown, plumped and wobbled as the exact one is.
export function bakedNode(baked: THREE.Data3DTexture, at: any, fat: any, wobble: any, time: any, gust?: any) {
  const p = at.sub(windNode(at, time, gust)) as any;
  const d = texture3D(baked, p.div(vec3(BOUNDS)).mul(0.5).add(0.5), float(0)).r as any;
  return d.sub(fat.mul(R * 1.06)).add(wave(p, time).mul(wobble).mul(0.018));
}

// The baked distance with no breeze or wobble: cheap, and never more than `slack` from the full one, since the breeze
// shifts the point by at most WIND and the wobble moves the surface by at most 1.5 x 0.018 per unit of wobble. Far from
// the film the tracer steps by this less the slack, and works the full distance only close in.
const WIND = Math.hypot(0.084, 0.022, 0.02);
export const slack = (wobble: any, gust: any) => gust.mul(WIND).add(wobble.mul(0.027)) as any;
export function bakedBare(baked: THREE.Data3DTexture, p: any, fat: any) {
  return (texture3D(baked, p.div(vec3(BOUNDS)).mul(0.5).add(0.5), float(0)).r as any).sub(fat.mul(R * 1.06)) as any;
}
