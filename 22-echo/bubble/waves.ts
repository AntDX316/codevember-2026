import * as THREE from "three/webgpu";
import { abs, atan, cos, cross, dot, exp, float, Fn, If, instancedArray, int, length, Loop, max, sin, uniform, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The membrane rings. A tap sends a ring of ripples out from the point struck; on a sphere it wraps round, closes up on
// the far side, passes through itself and comes back, so the wave is a packet travelling over the angle from the tap,
// mirrored at both poles of that axis. Its height grows where the ring is short (near the tap and the far side) and
// thins out round the middle, as the ring's energy spreads along it. The whole bubble also wobbles in its lowest shape.

export const TAPS = 10;
// Radians a second round the bubble: the ring meets on the far side after π / SPEED.
export const SPEED = 0.9;
const WAVENUMBER = 17;
const WIDTH = 0.2;
export const RIPPLE = 0.02;
const FADE = 0.26;
// How long a tap lives: out, back, and out to the far side again.
export const LIFE = (3 * Math.PI) / SPEED;

// Per tap: where it was struck (xyz) and its strength (w, 0 when free); its age.
export const rowAt = instancedArray(new Float32Array(TAPS * 4), "vec4") as any;
export const rowAge = instancedArray(new Float32Array(TAPS), "float") as any;
export const rows = { at: rowAt.value.array as Float32Array, age: rowAge.value.array as Float32Array };
export function sendRows() {
  rowAt.value.needsUpdate = true;
  rowAge.value.needsUpdate = true;
}
export const clock = uniform(0) as any;

// The held tone: a standing pattern of six crossing waves, one of them centred where the press is.
const AXES = 6;
export const hold = {
  level: uniform(0) as any,
  swing: uniform(0) as any,
  order: uniform(9) as any,
  axes: Array.from({ length: AXES }, () => uniform(new THREE.Vector3(0, 1, 0)) as any),
  // The pattern (x) and its gradient over the sphere (yzw).
  pattern(n: any) {
    let value: any = float(0);
    let grad: any = vec3(0);
    // The wave about the press is strongest, so the pattern reads as rings round the finger crossed by a lattice.
    this.axes.forEach((e, i) => {
      const ne = dot(n, e) as any;
      const k = this.order as any;
      const w = i === 0 ? 3 : 1;
      value = value.add(cos(ne.mul(k)).mul(w));
      grad = grad.add(e.sub(n.mul(ne)).mul(sin(ne.mul(k)).mul(k).mul(-w)));
    });
    return { value: value.div(AXES + 2) as any, grad: grad.div(AXES + 2) as any };
  },
  // The film's drift under the tone: up the slope of the pattern's square, so it piles into bands.
  flow(n: any) {
    const p = this.pattern(n);
    return p.grad.mul(p.value.mul(2)).mul(this.level.mul(0.3));
  }
};
// Fixed directions of the pattern's other waves, turned with the press.
export const HOLD_AXES = [
  [0, 1, 0],
  [0.894, 0.447, 0],
  [0.276, 0.447, 0.851],
  [-0.724, 0.447, 0.526],
  [-0.724, 0.447, -0.526],
  [0.276, 0.447, -0.851]
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

const packet = (x: any) => exp(x.mul(x).mul(-1 / (WIDTH * WIDTH))).mul(cos(x.mul(WAVENUMBER)));
const packetSlope = (x: any) => {
  const g = exp(x.mul(x).mul(-1 / (WIDTH * WIDTH))) as any;
  return g.mul(x.mul(-2 / (WIDTH * WIDTH)).mul(cos(x.mul(WAVENUMBER))).sub(sin(x.mul(WAVENUMBER)).mul(WAVENUMBER)));
};

// Per tap: the angle from it, and the packet's images over the angle (outward and on its way back).
const each = (n: any, i: any, body: (o: { at: any; c: any; side: any; away: any; theta: any; reach: any; age: any; spread: any }) => void) => {
  const at = rowAt.element(i) as any;
  If(at.w.greaterThan(0), () => {
    const c = dot(n, at.xyz).toVar() as any;
    const side = length(cross(n, at.xyz)).toVar() as any;
    const theta = atan(side, c).toVar() as any;
    const age = rowAge.element(i).toVar() as any;
    const reach = age.mul(SPEED).toVar() as any;
    // The ring is long round the middle, so lower there.
    const spread = float(0.5).div(side.add(0.5)).sqrt().mul(at.w).mul(exp(age.mul(-FADE))).toVar() as any;
    const away = n.mul(c).sub(at.xyz).div(max(side, 1e-4)).toVar() as any;
    body({ at, c, side, away, theta, reach, age, spread });
  });
};

// The membrane's height at direction n, as a fraction of the radius (w), with its gradient over the sphere (xyz). The
// gradient lies across the sphere, so the part of xyz along n is free: it carries the ring alone, about ±1 under a fresh
// one, for the film's colour to follow. Read the parts with `unpack`.
const membraneFn = Fn(([n]: any) => {
  const height = float(0).toVar() as any;
  const grad = vec3(0).toVar() as any;
  const ring = float(0).toVar() as any;
  Loop({ start: int(0), end: int(TAPS), type: "int", condition: "<" }, ({ i }: any) => {
    each(n, i, ({ at, c, away, theta, reach, age, spread }) => {
      const a = theta.sub(reach) as any;
      const b = theta.negate().sub(reach) as any;
      const sum = packet(a).add(packet(b)).add(packet(a.add(2 * Math.PI))).add(packet(b.add(2 * Math.PI))) as any;
      const slope = packetSlope(a).sub(packetSlope(b)).add(packetSlope(a.add(2 * Math.PI))).sub(packetSlope(b.add(2 * Math.PI))) as any;
      ring.addAssign(sum.mul(spread));
      height.addAssign(sum.mul(spread).mul(RIPPLE));
      grad.addAssign(away.mul(slope.mul(spread).mul(RIPPLE)));
      // The whole bubble squashes and stretches about the axis of the blow, and settles.
      const wobble = sin(age.mul(5.2)).mul(exp(age.mul(-0.9))).mul(at.w).mul(0.03) as any;
      height.addAssign(wobble.mul(c.mul(c).mul(1.5).sub(0.5)));
      grad.addAssign(at.xyz.sub(n.mul(c)).mul(c.mul(3)).mul(wobble));
    });
  });
  // A breath through the lowest shapes, so it is never quite still.
  const axes: [number, number, number, number, number][] = [
    [0.8, 0.5, 0.33, 0.37, 0],
    [-0.3, 0.9, 0.3, 0.26, 2.1],
    [0.2, -0.3, 0.93, 0.31, 4.2]
  ];
  for (const [x, y, z, rate, phase] of axes) {
    const e = vec3(x, y, z).normalize() as any;
    const ne = dot(n, e).toVar() as any;
    const amp = sin(clock.mul(rate).add(phase)).mul(0.009) as any;
    height.addAssign(amp.mul(ne.mul(ne).sub(1 / 3)));
    grad.addAssign(e.sub(n.mul(ne)).mul(ne.mul(2)).mul(amp));
  }
  // The held tone's standing pattern, rocking up and down.
  const p = hold.pattern(n);
  const tone = hold.level.mul(sin(hold.swing)).mul(0.011) as any;
  height.addAssign(p.value.mul(tone));
  grad.addAssign(p.grad.mul(tone));
  return vec4(grad.add(n.mul(ring)), height);
});

export function unpack(n: any, packed: any) {
  const ring = dot(packed.xyz, n).toVar() as any;
  return { height: packed.w as any, grad: packed.xyz.sub(n.mul(ring)) as any, ring };
}

// How the rings move the film at n: their drag along the way they travel (xyz) and how hard they stir it (w).
const stirFn = Fn(([n]: any) => {
  const push = vec3(0).toVar() as any;
  const stir = float(0).toVar() as any;
  Loop({ start: int(0), end: int(TAPS), type: "int", condition: "<" }, ({ i }: any) => {
    each(n, i, ({ away, theta, reach, spread }) => {
      const a = theta.sub(reach) as any;
      const b = theta.negate().sub(reach) as any;
      const env = (x: any) => exp(x.mul(x).mul(-1 / (WIDTH * WIDTH * 1.6)));
      const out = env(a).add(env(a.add(2 * Math.PI))) as any;
      const back = env(b).add(env(b.add(2 * Math.PI))) as any;
      push.addAssign(away.mul(out.sub(back).mul(spread).mul(0.55)));
      stir.addAssign(out.add(back).mul(abs(spread)));
    });
  });
  return vec4(push, stir);
});

export const membrane = (n: any) => (membraneFn as any)(n);
export const stirAt = (n: any) => (stirFn as any)(n);
