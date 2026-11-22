import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The form: a handful of balls drifting on slow, unrelated orbits, melted into one mass with a soft minimum, and a gentle
// swell through the whole of it. The same field is worked out here for the pointer and in the shader for the picture, from
// the same numbers, so a press lands exactly where the eye sees the surface.

export const BALLS = 7;
export const MELT = 0.42;
export const SWELL = 0.035;
// Nothing of the form reaches past this from the middle; the shader only marches inside it.
export const BOUND = 2;

// Sound in this world: how fast a front travels, how far behind it each echo follows, and how many there are.
export const SPEED = 1.7;
export const ECHO_DELAY = 0.42;
export const ECHOES = 3;
export const ECHO_FALL = 0.48;
// Slot 0 is the form's own faint breath; the rest are the visitor's pings, the oldest given up first.
export const SLOTS = 12;
export const NEVER = -1000;

const ORBITS = [
  // radius, and per axis: reach, rate, phase
  [0.72, 0.42, 0.13, 0.0, 0.3, 0.11, 1.7, 0.36, 0.09, 4.1],
  [0.58, 0.62, 0.09, 2.1, 0.5, 0.14, 0.4, 0.44, 0.12, 1.3],
  [0.52, 0.55, 0.16, 4.0, 0.62, 0.1, 2.9, 0.5, 0.15, 0.2],
  [0.46, 0.7, 0.12, 1.2, 0.4, 0.17, 5.1, 0.62, 0.1, 3.3],
  [0.42, 0.66, 0.15, 5.3, 0.66, 0.12, 0.9, 0.4, 0.18, 2.4],
  [0.38, 0.8, 0.11, 3.4, 0.55, 0.19, 3.8, 0.7, 0.13, 5.7],
  [0.34, 0.78, 0.18, 0.6, 0.72, 0.09, 2.2, 0.66, 0.16, 1.0]
];

export const clock = uniform(0) as any;
export const balls = uniformArray(
  ORBITS.map(() => new THREE.Vector4()),
  "vec4"
) as any;
// Each ping: where it left (xyz) and how loud (w); and when it left.
export const pings = uniformArray(
  Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)),
  "vec4"
) as any;
// How quickly each ping's contour lines fade behind its front, per unit of distance: a tap leaves a long trail, a stream short ones.
export const tails = uniformArray(
  Array.from({ length: SLOTS }, () => 2),
  "float"
) as any;
export const births = uniformArray(
  Array.from({ length: SLOTS }, () => NEVER),
  "float"
) as any;

const ballValues = balls.array as THREE.Vector4[];

export function moveBalls(time: number) {
  for (let i = 0; i < BALLS; i++) {
    const [r, ax, fx, px, ay, fy, py, az, fz, pz] = ORBITS[i];
    // The biggest stays near the middle so the mass never comes apart.
    const pull = i === 0 ? 0.35 : 1;
    ballValues[i].set(Math.sin(time * fx + px) * ax * pull, Math.sin(time * fy + py) * ay * pull, Math.cos(time * fz + pz) * az * pull, r * (1 + 0.08 * Math.sin(time * 0.31 + i * 1.9)));
  }
  // Carried back so the mass, weighed by volume, stays in the middle of the view however it reshapes.
  let x = 0, y = 0, z = 0, w = 0;
  for (const b of ballValues) {
    const v = b.w ** 3;
    x += b.x * v;
    y += b.y * v;
    z += b.z * v;
    w += v;
  }
  for (const b of ballValues) b.set(b.x - x / w, b.y - y / w, b.z - z / w, b.w);
}

export const swellAt = (x: number, y: number, z: number, t: number) => Math.sin(x * 3.1 + t * 0.5) * Math.sin(y * 2.7 - t * 0.4) * Math.sin(z * 2.9 + t * 0.33) * SWELL;

export function fieldAt(p: THREE.Vector3, time: number) {
  let d = 1000;
  for (let i = 0; i < BALLS; i++) {
    const b = ballValues[i];
    const e = Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) - b.w;
    const h = Math.min(Math.max(0.5 + (0.5 * (d - e)) / MELT, 0), 1);
    d = d + (e - d) * h - MELT * h * (1 - h);
  }
  return (d + swellAt(p.x, p.y, p.z, time)) * 0.86;
}

const along = new THREE.Vector3();
// Where a ray first meets the form, or null.
export function hitForm(ray: THREE.Ray, time: number, out: THREE.Vector3) {
  const sphere = new THREE.Sphere(new THREE.Vector3(), BOUND);
  if (!ray.intersectSphere(sphere, along)) return null;
  let t = Math.max(0, ray.origin.distanceTo(along) - 0.01);
  for (let k = 0; k < 160; k++) {
    ray.at(t, along);
    const d = fieldAt(along, time);
    if (d < 0.001) return out.copy(along);
    t += d;
    if (t > ray.origin.length() + BOUND) return null;
  }
  return null;
}

// The point of the form nearest a ray that misses it: from the ray's closest pass by the middle, straight in.
export function nearestToRay(ray: THREE.Ray, time: number, out: THREE.Vector3) {
  ray.closestPointToPoint(new THREE.Vector3(), out);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  out.setLength(BOUND + 0.2);
  const inward = out.clone().normalize().negate();
  for (let k = 0; k < 120; k++) {
    const d = fieldAt(out, time);
    if (d < 0.001) return out;
    out.addScaledVector(inward, d);
  }
  return out;
}
