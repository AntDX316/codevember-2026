import * as THREE from "three/webgpu";
import { cos, dot, exp, float, normalize, sin, uniform, uniformArray, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The blob is a sphere pushed out along each direction by a handful of soft lobes that wander over it, so it churns
// like a lava lamp. Its shape is a pure function of time: an echo shell is the same sphere drawn with the time it was
// spoken, so it carries the shape the blob had then, however far the blob has moved on.

export const BASE = 0.8;
// Each lobe: how fast its direction wanders on three axes and from where, how big and how pointed it is, and how its
// size breathes.
const LOBES = [
  { f: [0.21, 0.17, 0.23], p: [0.3, 1.7, 0.2], w: 0.42, k: 4.0, g: 0.31, q: 0.0 },
  { f: [0.16, 0.25, 0.19], p: [2.4, 0.6, 2.9], w: 0.4, k: 5.0, g: 0.27, q: 1.9 },
  { f: [0.27, 0.13, 0.18], p: [4.1, 3.3, 1.1], w: 0.36, k: 6.0, g: 0.36, q: 3.4 },
  { f: [0.14, 0.22, 0.26], p: [5.6, 2.2, 4.4], w: 0.33, k: 7.0, g: 0.23, q: 4.8 },
  { f: [0.24, 0.19, 0.15], p: [1.2, 5.1, 3.7], w: 0.3, k: 8.0, g: 0.41, q: 2.6 },
  { f: [0.18, 0.28, 0.21], p: [3.5, 4.4, 5.6], w: 0.26, k: 9.0, g: 0.33, q: 5.5 },
  // Two soft dents, so it pinches as well as bulges.
  { f: [0.29, 0.15, 0.24], p: [0.9, 2.8, 4.9], w: -0.16, k: 5.0, g: 0.38, q: 0.7 },
  { f: [0.13, 0.26, 0.2], p: [4.7, 0.4, 2.3], w: -0.14, k: 6.0, g: 0.29, q: 3.9 }
];

// Echo slots. Each: (time its shape was taken, time it was born, loudness, seed). A slot whose birth is long past is free.
export const SLOTS = 32;
// A shell's life, and how much longer its dust lingers after it.
export const LIFE = 3.6;
export const DUST_LIFE = 1.9;
export const NEVER = -1000;
// One past the highest slot still showing anything, so the draws skip the idle ones at the end.
export const active = { top: 0 };

export const clock = uniform(0);
export const slots = uniformArray(
  Array.from({ length: SLOTS }, () => new THREE.Vector4(0, NEVER, 0, 0)),
  "vec4"
) as any;
// How loudly the blob is speaking just now, which lights it from inside; and a brief swell as each call leaves it.
export const voice = uniform(0);
export const swell = uniform(0);

// The radius along unit direction n at time t, and the surface normal there: for p = r(n) n the normal is r n less the
// gradient of r across the sphere, which always points outward while r stays positive.
export function shapeAt(n: any, t: any) {
  let r = float(BASE) as any;
  let grad = vec3(0, 0, 0) as any;
  for (const l of LOBES) {
    const d = normalize(vec3(sin(t.mul(l.f[0]).add(l.p[0])), sin(t.mul(l.f[1]).add(l.p[1])).mul(0.8), cos(t.mul(l.f[2]).add(l.p[2])))) as any;
    const w = sin(t.mul(l.g).add(l.q)).mul(0.28).add(0.72).mul(l.w) as any;
    const e = exp(dot(n, d).sub(1).mul(l.k)).mul(w) as any;
    r = r.add(e);
    grad = grad.add(d.mul(e.mul(l.k)));
  }
  const across = grad.sub(n.mul(dot(grad, n))) as any;
  return { r, normal: normalize(n.mul(r).sub(across)) as any };
}

// The same shape on the processor, for picking and for checking the normals.
export function radiusAt(n: THREE.Vector3, t: number) {
  let r = BASE;
  const d = new THREE.Vector3();
  for (const l of LOBES) {
    d.set(Math.sin(t * l.f[0] + l.p[0]), Math.sin(t * l.f[1] + l.p[1]) * 0.8, Math.cos(t * l.f[2] + l.p[2])).normalize();
    const w = (Math.sin(t * l.g + l.q) * 0.28 + 0.72) * l.w;
    r += Math.exp((n.dot(d) - 1) * l.k) * w;
  }
  return r;
}

export function normalAt(n: THREE.Vector3, t: number, out: THREE.Vector3) {
  let r = BASE;
  const d = new THREE.Vector3();
  const grad = new THREE.Vector3();
  for (const l of LOBES) {
    d.set(Math.sin(t * l.f[0] + l.p[0]), Math.sin(t * l.f[1] + l.p[1]) * 0.8, Math.cos(t * l.f[2] + l.p[2])).normalize();
    const w = (Math.sin(t * l.g + l.q) * 0.28 + 0.72) * l.w;
    const e = Math.exp((n.dot(d) - 1) * l.k) * w;
    r += e;
    grad.addScaledVector(d, e * l.k);
  }
  grad.addScaledVector(n, -grad.dot(n));
  return out.copy(n).multiplyScalar(r).sub(grad).normalize();
}

// How far a shell has spread by a given age: quickly at first, then slowly, as a sound thins out.
export function spread(age: any) {
  return float(1).add(float(1).sub(exp(age.mul(-1.05))).mul(0.82)).add(age.mul(0.045)) as any;
}
