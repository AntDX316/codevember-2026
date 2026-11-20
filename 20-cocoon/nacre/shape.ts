import * as THREE from "three/webgpu";

// The cocoon is seven nested shells of nacre around a pearl. Each shell is a surface of revolution, an egg drawn a little
// to a point at either end, and is cut into bricks the way nacre itself is laid: rows running round it, each row's
// joints offset from the last, and the seams between rows gently wavy. Everything here is mirrored in the shader
// (material.ts), which lays every brick exactly on its own patch of the shell so neighbours meet edge to edge.

export const LAYERS = 7;
// Outermost and innermost shell: half-width, half-height, and how pointed the ends are.
export const A0 = 0.7;
export const A1 = 0.29;
export const C0 = 1.05;
export const C1 = 0.355;
export const K0 = 0.16;
export const K1 = 0.02;
export const PEARL = 0.2;
// How thick each skin is.
export const DEPTH = 0.012;
// How far a row's seam wanders up and down, in radians at the widest.
export const WAVE = 0.085;

export type Dims = { a: number; c: number; k: number };

export function dims(layer: number, out: Dims = { a: 0, c: 0, k: 0 }) {
  const t = layer / (LAYERS - 1);
  out.a = A0 + (A1 - A0) * t;
  out.c = C0 + (C1 - C0) * t;
  out.k = K0 + (K1 - K0) * t;
  return out;
}

// Where a row's seam lies at a given angle round: its own height, waved by two harmonics that close up all the way round.
// The poles (sin 0) never wave.
export function seam(base: number, layer: number, phi: number) {
  const p = base * 13.7 + layer * 3.1;
  return base + Math.sin(base) * WAVE * (0.6 * Math.sin(3 * phi + p) + 0.4 * Math.sin(7 * phi + 2.1 * p));
}

// A point on the shell, and its outward normal, at polar angle theta and angle round phi.
export function surface(d: Dims, theta: number, phi: number, point: THREE.Vector3, normal?: THREE.Vector3) {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const r = d.a * st * (1 - d.k * ct * ct);
  point.set(r * Math.cos(phi), d.c * ct, r * Math.sin(phi));
  if (normal) {
    const dr = d.a * ct * (1 - d.k * ct * ct + 2 * d.k * st * st);
    const nr = d.c * st;
    const l = Math.hypot(nr, dr) || 1;
    normal.set((nr / l) * Math.cos(phi), dr / l, (nr / l) * Math.sin(phi));
  }
  return point;
}

// One brick: where it sits in the picture of its shell (its middle angle round, half its width in angle, and the two
// seams it lies between), its middle and frame at rest, and how far it reaches across and up from that middle.
export type Brick = {
  layer: number;
  phi: number;
  half: number;
  top: number;
  bottom: number;
  centre: THREE.Vector3;
  e: THREE.Vector3;
  u: THREE.Vector3;
  n: THREE.Vector3;
  reachAcross: number;
  reachUp: number;
  seed: number;
};

const random = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
};

// Every brick of every shell, outermost shell first so the ones drawn can be cut off at the end of the list.
export function layout() {
  const bricks: Brick[] = [];
  const starts: number[] = [];
  const rand = random(20261120);
  const d = dims(0);
  for (let layer = 0; layer < LAYERS; layer++) {
    starts.push(bricks.length);
    dims(layer, d);
    const size = d.a / A0;
    // Fewer, so for their size much the same, bricks on the smaller shells.
    const rows = Math.max(5, Math.round(9 * size));
    const round = Math.max(7, Math.round(16 * size));
    for (let row = 0; row < rows; row++) {
      const top = (row / rows) * Math.PI;
      const bottom = ((row + 1) / rows) * Math.PI;
      const count = Math.max(3, Math.round(round * Math.sin((top + bottom) / 2)));
      const offset = rand() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const phi = offset + ((i + 0.5) / count) * Math.PI * 2;
        const half = Math.PI / count;
        const mid = (seam(top, layer, phi) + seam(bottom, layer, phi)) / 2;
        const centre = new THREE.Vector3();
        const n = new THREE.Vector3();
        surface(d, mid, phi, centre, n);
        const e = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
        const u = new THREE.Vector3().crossVectors(n, e);
        // Arc length up the shell per radian here.
        const st = Math.sin(mid);
        const ct = Math.cos(mid);
        const dr = d.a * ct * (1 - d.k * ct * ct + 2 * d.k * st * st);
        const speed = Math.hypot(dr, d.c * st);
        const radius = d.a * st * (1 - d.k * ct * ct);
        bricks.push({
          layer,
          phi,
          half,
          top,
          bottom,
          centre,
          e,
          u,
          n,
          reachAcross: Math.max(0.03, radius * half),
          reachUp: ((bottom - top) / 2) * speed,
          seed: rand()
        });
      }
    }
  }
  starts.push(bricks.length);
  return { bricks, starts };
}

// Where a ray meets a shell from outside, as a distance along it, using the plain ellipsoid the shell is very nearly.
export function hitShell(ray: THREE.Ray, d: Dims, inflate = 0) {
  const a = d.a + inflate;
  const c = d.c + inflate;
  const ox = ray.origin.x / a;
  const oy = ray.origin.y / c;
  const oz = ray.origin.z / a;
  const dx = ray.direction.x / a;
  const dy = ray.direction.y / c;
  const dz = ray.direction.z / a;
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (ox * dx + oy * dy + oz * dz);
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t > 0 ? t : null;
}

// How far a point is outside a shell, roughly, writing the way out into `out`.
export function outside(p: THREE.Vector3, d: Dims, out: THREE.Vector3) {
  const qx = p.x / d.a;
  const qy = p.y / d.c;
  const qz = p.z / d.a;
  const q = Math.hypot(qx, qy, qz) || 1e-4;
  out.set(p.x / (d.a * d.a), p.y / (d.c * d.c), p.z / (d.a * d.a));
  const g = out.length() || 1e-4;
  out.divideScalar(g);
  return ((q - 1) * q) / g;
}
