import * as THREE from "three/webgpu";
import { abs, clamp, cross, dot, exp, float, Fn, hash, instancedArray, instanceIndex, length, max, min, mix, select, sin, uniform, vec3, vec4 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A murmuration as a field rather than as neighbours: the flock's shape is a few capsules melted together, drifting and
// stretching on slow loops, and every bird steers to hold its own depth under that skin while it streams along it, carried
// round by a slowly turning wind. Birds that sit near each other feel the same field and fly as one, so the cloud wheels,
// folds and thins like a real one with no bird ever looking at another. A chirp's wavefront startles the birds it passes:
// they swerve away and come back, a ripple of density running through the cloud, and catch the light as they turn.

// Capsules the shape is melted from, and wavefronts at once: chirps and their echoes off the dense parts.
export const CAPSULES = 4;
export const FRONTS = 12;
// How fast a chirp's front travels, in world units a second, and how far it reaches before it is spent.
export const SPEED = 3.2;
export const REACH = 16;

export const COUNTS: Record<QualityTier, number> = { high: 170000, medium: 110000, low: 50000 };

export type Flock = ReturnType<typeof createFlock>;

// The shape's capsules at a time: each its two ends and radius, on loops of their own.
const LOOPS = Array.from({ length: CAPSULES }, (_, k) => {
  const r = lehmer(911 + k * 37);
  return Array.from({ length: 12 }, () => r());
});
export function capsuleAt(k: number, t: number, a: THREE.Vector3, b: THREE.Vector3) {
  const q = LOOPS[k];
  const w = 0.11 + q[0] * 0.08;
  const cx = Math.sin(t * w + q[1] * 6.28) * 1.5;
  const cy = Math.sin(t * w * 0.73 + q[2] * 6.28) * 0.8;
  const cz = Math.sin(t * w * 0.61 + q[3] * 6.28) * 1.2;
  // Each turns end over end slowly and breathes longer and shorter, so the cloud stretches into arms and pulls back.
  const yaw = t * (0.07 + q[4] * 0.06) + q[5] * 6.28;
  const pitch = Math.sin(t * (0.09 + q[6] * 0.05) + q[7] * 6.28) * 0.9;
  const half = 1 + 1 * (0.5 + 0.5 * Math.sin(t * (0.13 + q[8] * 0.08) + q[9] * 6.28));
  const dx = Math.cos(yaw) * Math.cos(pitch) * half;
  const dy = Math.sin(pitch) * half;
  const dz = Math.sin(yaw) * Math.cos(pitch) * half;
  a.set(cx - dx, cy - dy, cz - dz);
  b.set(cx + dx, cy + dy, cz + dz);
  return 0.95 + 0.5 * (0.5 + 0.5 * Math.sin(t * (0.1 + q[10] * 0.07) + q[11] * 6.28));
}

// The whole shape at a time, kept centred on the origin so the flock wheels in place in front of the eye.
export function shapeAt(t: number, ends: THREE.Vector3[], radii: number[]) {
  const mid = new THREE.Vector3();
  for (let k = 0; k < CAPSULES; k++) {
    radii[k] = capsuleAt(k, t, ends[k * 2], ends[k * 2 + 1]);
    mid.add(ends[k * 2]).add(ends[k * 2 + 1]);
  }
  mid.multiplyScalar(1 / (CAPSULES * 2));
  for (const e of ends) e.sub(mid);
}

export function createFlock(tier: QualityTier) {
  const random = lehmer(22113);
  const count = COUNTS[tier];
  const start = new Float32Array(count * 4);
  const speed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    const r = 2.6 * Math.cbrt(random());
    start.set([Math.cos(a) * ring * r * 1.4, z * r * 0.7, Math.sin(a) * ring * r, 0], i * 4);
    speed.set([-Math.sin(a) * 2, 0, Math.cos(a) * 2, 0], i * 4);
  }
  // Per bird: where it is and how lit it is (w); its velocity, and in w how hard it has been startled lately.
  const pos = instancedArray(start, "vec4") as any;
  const vel = instancedArray(speed, "vec4") as any;

  const u = {
    now: uniform(0),
    dt: uniform(0),
    caps: Array.from({ length: CAPSULES }, () => ({ a: uniform(new THREE.Vector4()), b: uniform(new THREE.Vector3()) })),
    // The wind the flock wheels round, turning slowly.
    wind: uniform(new THREE.Vector3(0, 1, 0)),
    fronts: Array.from({ length: FRONTS }, () => uniform(new THREE.Vector4(0, 0, 0, -100))),
    power: Array.from({ length: FRONTS }, () => uniform(0)),
    // The view, for drawing: the eye, the camera's forward and right, and a pixel's width at a distance of one.
    eye: uniform(new THREE.Vector3(0, 0, 12)),
    forward: uniform(new THREE.Vector3(0, 0, -1)),
    pixel: uniform(0.001),
    ink: uniform(new THREE.Color("#04050a")),
    glint: uniform(new THREE.Color("#9fefff"))
  };

  // The skin's signed distance: the capsules melted together with a smooth minimum, the space first stirred a little so
  // the skin rolls in soft folds rather than staying a sum of sausages.
  const skin = (p: any) => {
    const t = u.now as any;
    const q = p.add(vec3(sin(p.y.mul(1.3).add(t.mul(0.31))), sin(p.z.mul(1.1).sub(t.mul(0.27)).add(1.7)), sin(p.x.mul(1.2).add(t.mul(0.23)).add(3.1))).mul(0.32)) as any;
    let d: any = null;
    for (const cap of u.caps) {
      const a = cap.a.xyz as any;
      const ba = cap.b.sub(a) as any;
      const pa = q.sub(a) as any;
      const h = clamp(dot(pa, ba).div(dot(ba, ba).add(1e-4)), 0, 1) as any;
      const one = length(pa.sub(ba.mul(h))).sub(cap.a.w) as any;
      if (!d) d = one;
      else {
        const k = 1.1;
        const blend = max(float(k).sub(abs(d.sub(one))), 0).div(k) as any;
        d = min(d, one).sub(blend.mul(blend).mul(k * 0.25));
      }
    }
    return d;
  };

  const update = Fn(() => {
    const i = instanceIndex;
    const p = pos.element(i) as any;
    const v = vel.element(i) as any;
    const at = p.xyz as any;
    const t = u.now as any;
    const dt = u.dt as any;
    const seed = hash(i) as any;
    const seed2 = hash(i.add(7919)) as any;

    // The skin's distance and direction out of it, from four samples on a tetrahedron.
    const e = 0.05;
    const k1 = vec3(1, -1, -1);
    const k2 = vec3(-1, -1, 1);
    const k3 = vec3(-1, 1, -1);
    const k4 = vec3(1, 1, 1);
    const f1 = skin(at.add(k1.mul(e))) as any;
    const f2 = skin(at.add(k2.mul(e))) as any;
    const f3 = skin(at.add(k3.mul(e))) as any;
    const f4 = skin(at.add(k4.mul(e))) as any;
    const f = f1.add(f2).add(f3).add(f4).mul(0.25) as any;
    const g = k1.mul(f1).add(k2.mul(f2)).add(k3.mul(f3)).add(k4.mul(f4)) as any;
    const n = g.div(length(g).add(1e-5)) as any;

    // Each bird keeps its own depth under the skin, most of them close to it, so the cloud has a crisp edge and a dense rim
    // where it folds edge-on to the eye.
    const depth = seed.pow(1.6).mul(1.3) as any;
    const err = f.add(depth) as any;
    const settle = n.mul(clamp(err.mul(-2.6), -3, 3)) as any;

    // Streaming along the skin, round a wind that wanders from place to place; a finer stir rolls the sheets over.
    const s = at.mul(0.8) as any;
    const wander = vec3(sin(s.y.add(t.mul(0.21))), sin(s.z.sub(t.mul(0.17)).add(1.3)), sin(s.x.add(t.mul(0.19)).add(2.6))) as any;
    const axis = u.wind.add(wander.mul(0.4)) as any;
    const along = cross(n, axis) as any;
    const s2 = at.mul(2.1).add(seed2.mul(0.6)) as any;
    const stir = vec3(sin(s2.z.add(t.mul(0.5))), sin(s2.x.sub(t.mul(0.43))), sin(s2.y.add(t.mul(0.47)))) as any;
    const fine = cross(n, stir).mul(0.25) as any;
    const flow = along.add(fine) as any;
    const pace = seed2.mul(0.35).add(0.85).mul(1.9) as any;
    const desired = flow.div(length(flow).add(0.2)).mul(pace).add(settle) as any;

    // Every wavefront: a thin shell. Where it passes, a bird is startled away from the chirp and banks to one side, then
    // steers back to the flock; it catches the light as it turns.
    const push = vec3(0).toVar() as any;
    const lit = float(0).toVar() as any;
    for (let k = 0; k < FRONTS; k++) {
      const src = u.fronts[k] as any;
      const rel = at.sub(src.xyz) as any;
      const d = length(rel).add(1e-3) as any;
      const age = t.sub(src.w) as any;
      const off = d.sub(age.mul(SPEED)) as any;
      const band = exp(off.div(select(off.lessThan(0), float(0.3), float(0.12))).pow(2).negate()) as any;
      const strength = u.power[k].mul(band).div(d.mul(0.12).add(1)).mul(max(float(1).sub(age.mul(SPEED / REACH)), 0)) as any;
      const away = rel.div(d) as any;
      push.addAssign(away.add(cross(away, n).mul(0.7)).mul(strength));
      lit.addAssign(strength);
    }

    // A bird still shaken from the last chirp flinches less at the next, so a buzz ruffles the flock without blowing it apart.
    const turn = min(dt.mul(2.2), 1) as any;
    const flinch = float(1).sub(v.w.mul(0.75)) as any;
    let nv = v.xyz.add(desired.sub(v.xyz).mul(turn)).add(push.mul(dt).mul(flinch).mul(22)) as any;
    const sp = length(nv) as any;
    nv = nv.mul(min(float(1), float(6).div(sp.add(1e-4)))) as any;
    const np = at.add(nv.mul(dt)) as any;
    // The light a startled bird catches fades over a moment.
    const glow = max(p.w.mul(exp(dt.mul(-3.2))), min(lit, 1)) as any;
    // How startled it has been, smoothed, so the streak stays long through the swerve.
    const fright = max(v.w.mul(exp(dt.mul(-1.6))), min(lit, 1)) as any;
    p.assign(vec4(np, glow));
    v.assign(vec4(nv, fright));
  })().compute(count);

  return { count, pos, vel, u, update };
}
