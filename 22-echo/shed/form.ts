import * as THREE from "three/webgpu";
import { acos, clamp, cos, dot, exp, float, floor, Fn, length, Loop, max, mix, normalize, sin, smoothstep, step, uniform, uniformArray, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The form: a sphere pushed out along each direction by a few broad, slow lobes, so it reads as a pebble of dark stone
// that very slowly changes its mind. Its shape is a pure function of direction and time, worked out the same way on the
// graphics card (to draw it and to let dust go from it) and on the processor (to find where a tap lands).

export const BASE = 0.72;
const LOBES = [
  { f: [0.05, 0.041, 0.057], p: [0.3, 1.7, 0.2], w: 0.5, k: 2.8, g: 0.07, q: 0.0 },
  { f: [0.043, 0.061, 0.047], p: [2.4, 0.6, 2.9], w: 0.42, k: 3.4, g: 0.06, q: 1.9 },
  { f: [0.066, 0.034, 0.045], p: [4.1, 3.3, 1.1], w: 0.36, k: 4.2, g: 0.08, q: 3.4 },
  { f: [0.036, 0.055, 0.063], p: [5.6, 2.2, 4.4], w: 0.28, k: 5, g: 0.05, q: 4.8 },
  { f: [0.058, 0.047, 0.038], p: [1.2, 5.1, 3.7], w: 0.24, k: 6, g: 0.09, q: 2.6 },
  // Two soft dents, so it pinches as well as swells.
  { f: [0.071, 0.039, 0.052], p: [0.9, 2.8, 4.9], w: -0.2, k: 3.8, g: 0.07, q: 0.7 },
  { f: [0.032, 0.064, 0.05], p: [4.7, 0.4, 2.3], w: -0.17, k: 4.6, g: 0.06, q: 3.9 }
];

// Rings. Each is a voice striking the form at a point: a front that runs out across the surface (as an angle from the
// struck point), closes on itself at the far side, and runs back, a pass at a time, each pass weaker.
export const RINGS = 24;
// A pass takes this long, pole to pole; there are this many; each this much of the last.
export const PASS = 1.5;
export const PASSES = 4;
export const FALL = 0.58;
const OMEGA = Math.PI / PASS;
export const NEVER = -1000;
// Each ring: (struck direction, when) and (strength, 0, 0, 0).
export const ringAt = uniformArray(
  Array.from({ length: RINGS }, () => new THREE.Vector4(0, 1, 0, NEVER)),
  "vec4"
) as any;
export const ringPower = uniformArray(
  Array.from({ length: RINGS }, () => new THREE.Vector4(0, 0, 0, 0)),
  "vec4"
) as any;
// The rings live in the first ringCount slots (kept packed by the scene), so idle slots cost nothing.
export const ringCount = uniform(0, "int");
export const clock = uniform(0);

// The shudder the front carries: a short packet of ripples, as a function of the signed angle ahead of the front.
const PACKET = 0.11;
const RIPPLE = 30;
const LIFT = 0.032;
// The band within which the front sheds.
export const BAND = 0.05;

// The radius along unit direction n at time t, and its gradient across the sphere.
export function shapeAt(n: any, t: any) {
  let r = float(BASE) as any;
  let grad = vec3(0, 0, 0) as any;
  for (const l of LOBES) {
    const d = normalize(vec3(sin(t.mul(l.f[0]).add(l.p[0])), sin(t.mul(l.f[1]).add(l.p[1])).mul(0.8), cos(t.mul(l.f[2]).add(l.p[2])))) as any;
    const w = sin(t.mul(l.g).add(l.q)).mul(0.25).add(0.75).mul(l.w) as any;
    const e = exp(dot(n, d).sub(1).mul(l.k)).mul(w) as any;
    r = r.add(e);
    grad = grad.add(d.mul(e.mul(l.k)));
  }
  return { r, grad: grad.sub(n.mul(dot(grad, n))) as any };
}

// One ring as seen from direction n at time t: its strength now, the angle from the struck point, where its front is,
// the signed angle ahead of the front, which way it runs, and the pass it is on.
export function ring(i: any, n: any, t: any) {
  const at = ringAt.element(i) as any;
  const age = t.sub(at.w) as any;
  const s = max(age, float(0)).mul(OMEGA) as any;
  const k = floor(s.div(Math.PI)) as any;
  const within = s.sub(k.mul(Math.PI)) as any;
  const out = float(1).sub(k.mod(2)) as any;
  const front = mix(float(Math.PI).sub(within), within, out) as any;
  const dir = out.mul(2).sub(1) as any;
  const alpha = acos(clamp(dot(n, at.xyz), -1, 1)) as any;
  const passes = s.div(Math.PI) as any;
  const strength = (ringPower.element(i) as any).x
    .mul(exp(k.mul(Math.log(FALL))))
    .mul(step(0, age))
    .mul(smoothstep(0, 0.03, passes))
    .mul(float(1).sub(smoothstep(PASSES - 0.35, PASSES, passes))) as any;
  return { at, age, strength, alpha, front, ahead: alpha.sub(front).mul(dir), dir, k };
}

// The shudder of every ring at n: how far it lifts the surface, and its gradient across the sphere.
// Wrapped in its own function, so its loop has somewhere to live inside a material's shader.
export function shudderAt(n: any, t: any) {
  const both = Fn(() => {
    const lift = float(0).toVar() as any;
    const grad = vec3(0, 0, 0).toVar() as any;
    Loop(ringCount, ({ i }: any) => {
      const r = ring(i, n, t);
      const x = r.ahead as any;
      const env = exp(x.mul(x).div(-PACKET * PACKET)) as any;
      const f = env.mul(cos(x.mul(RIPPLE))) as any;
      const df = env.mul(
        x
          .mul(-2 / (PACKET * PACKET))
          .mul(cos(x.mul(RIPPLE)))
          .sub(sin(x.mul(RIPPLE)).mul(RIPPLE))
      ) as any;
      lift.addAssign(f.mul(r.strength).mul(LIFT));
      // Away from the struck point across the sphere: the way the angle grows.
      const away = n.mul(dot(n, r.at.xyz)).sub(r.at.xyz) as any;
      const awayN = away.div(max(length(away), float(1e-4))) as any;
      grad.addAssign(awayN.mul(df.mul(r.dir).mul(r.strength).mul(LIFT)));
    });
    return vec4(grad, lift);
  })() as any;
  return { lift: both.w, grad: both.xyz };
}

// The same shape on the processor, for picking.
const d = new THREE.Vector3();
export function radiusAt(n: THREE.Vector3, t: number) {
  let r = BASE;
  for (const l of LOBES) {
    d.set(Math.sin(t * l.f[0] + l.p[0]), Math.sin(t * l.f[1] + l.p[1]) * 0.8, Math.cos(t * l.f[2] + l.p[2])).normalize();
    const w = (Math.sin(t * l.g + l.q) * 0.25 + 0.75) * l.w;
    r += Math.exp((n.dot(d) - 1) * l.k) * w;
  }
  return r;
}

// Where a ray first meets the form, or null: march in until inside, then halve back to the surface.
const p = new THREE.Vector3();
const dir = new THREE.Vector3();
export function hitForm(ray: THREE.Ray, t: number) {
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1.9);
  const enter = ray.intersectSphere(sphere, new THREE.Vector3());
  if (!enter) return null;
  let a = ray.origin.distanceTo(enter);
  const inside = (s: number) => {
    ray.at(s, p);
    return p.length() < radiusAt(dir.copy(p).normalize(), t);
  };
  for (let k = 0; k < 160; k++) {
    const b = a + 0.025;
    if (inside(b)) {
      let lo = a;
      let hi = b;
      for (let j = 0; j < 14; j++) {
        const m = (lo + hi) / 2;
        if (inside(m)) hi = m;
        else lo = m;
      }
      return { distance: hi, point: ray.at(hi, new THREE.Vector3()) };
    }
    a = b;
  }
  return null;
}
