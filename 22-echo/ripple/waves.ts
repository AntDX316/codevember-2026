import { clamp, cos, cross, dot, exp, float, floor, Fn, If, instancedArray, instanceIndex, int, length, Loop, max, min, mix, sin, sqrt, atan, uniform, vec2, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The drop rings as a real liquid drop does. Its surface is a sum of spherical harmonics, each zonal about the point that
// was struck: degree l rings at Rayleigh's capillary frequency ω² ∝ l(l−1)(l+2) and dies as viscosity takes it, faster
// for the short waves. So a tap's short ripples run out ahead of its long swell, the rings wrap the drop, pile up at the
// far side and come back. Degree 0 (its volume) and 1 (sliding sideways) never move.
//
// Every frame a compute pass sums the series for each ping over its distance from the point struck, into a table of
// height and slope by angle. The drop and the dust then read each ping's row at their own angle from it.

export const TAPS = 16;
// The held tone's row comes after the taps'.
export const DRIVE = TAPS;
export const ROWS = TAPS + 1;
// Samples across the angle from the point struck, 0 to π.
export const SAMPLES = 1024;
export const DEGREES = 150;
// How fast it rings: a stiffness that carries every wave at much the same speed, about 1.3 radians a second, and
// surface tension, which makes the short ones faster still.
const STIFF = 1.3;
const TENSION = 0.08;
// Viscous damping: a floor for the long waves, and a part growing with the square of the degree.
const DAMP = 0.12;
const DAMP_SQ = 0.00004;
// How wide a tap is, in radians, and how wide the held tone's press.
export const DENT = 0.068;
export const PRESS = 0.075;

export const omega = (l: number) => Math.sqrt((l - 1) * (l + 2) * (STIFF * STIFF + TENSION * TENSION * l));
export const damping = (l: number) => DAMP + DAMP_SQ * l * l;
const weight = (l: number, width: number) => ((2 * l + 1) / (4 * Math.PI)) * Math.exp(-0.5 * (l * width) * (l * width));

// The depth a unit of amplitude gives straight under the press, so a tap's dent and a tone's swell come out the size asked.
export const peak = (width: number) => {
  let sum = 0;
  for (let l = 2; l <= DEGREES; l++) sum += weight(l, width);
  return sum;
};

// How fast a tap's rings run: the group speed of the degree carrying most of its energy, in radians a second.
export const ringSpeed = (() => {
  let best = 2;
  for (let l = 2; l <= DEGREES; l++) if (weight(l, DENT) * l > weight(best, DENT) * best) best = l;
  return omega(best + 0.5) - omega(best - 0.5);
})();

// Per row, set each frame: where it was struck (xyz, unit) and how strong it is now (w, 0 when free); and its age, its
// amplitude, the tone's phase and the tone's angular frequency.
// Storage rather than uniform arrays, since the compute pass and the draws must both see each frame's values.
export const rowAt = instancedArray(new Float32Array(ROWS * 4), "vec4") as any;
export const rowTime = instancedArray(new Float32Array(ROWS * 4), "vec4") as any;
export const rows = { at: rowAt.value.array as Float32Array, time: rowTime.value.array as Float32Array };
// Called once the frame's values are in.
export function sendRows() {
  rowAt.value.needsUpdate = true;
  rowTime.value.needsUpdate = true;
}
export const clock = uniform(0) as any;
// A breath through the drop's lowest shapes, so it is never quite still.
export const breath = uniform(1) as any;

export const table = instancedArray(ROWS * SAMPLES, "vec2") as any;

// One thread per row and angle: the sum over degree, by the three-term recurrence for Legendre polynomials.
export const buildTable = Fn(() => {
  const row = instanceIndex.div(SAMPLES).toVar() as any;
  const j = instanceIndex.mod(SAMPLES).toVar() as any;
  const at = rowAt.element(row) as any;
  const time = rowTime.element(row) as any;
  const theta = float(j).add(0.5).mul(Math.PI / SAMPLES).toVar() as any;
  const c = cos(theta).toVar() as any;
  const s = sin(theta).toVar() as any;
  const height = float(0).toVar() as any;
  const slope = float(0).toVar() as any;
  If(at.w.greaterThan(0), () => {
    const before = float(1).toVar() as any;
    const now = c.toVar() as any;
    const driven = row.equal(int(DRIVE)) as any;
    const width = driven.select(float(PRESS), float(DENT)) as any;
    const age = time.x as any;
    const phase = time.z as any;
    const tone = time.w as any;
    Loop({ start: int(2), end: int(DEGREES + 1), type: "int", condition: "<" }, ({ i }: any) => {
      const l = float(i).toVar() as any;
      const next = l.mul(2).sub(1).mul(c).mul(now).sub(l.sub(1).mul(before)).div(l).toVar() as any;
      before.assign(now);
      now.assign(next);
      const w = l.mul(2).add(1).mul(1 / (4 * Math.PI)).mul(exp(l.mul(width).pow2().mul(-0.5))).toVar() as any;
      const om = sqrt(l.sub(1).mul(l.add(2)).mul(l.mul(TENSION * TENSION).add(STIFF * STIFF))).toVar() as any;
      const g = l.mul(l).mul(DAMP_SQ).add(DAMP).toVar() as any;
      const amount = float(0).toVar() as any;
      If(driven, () => {
        // Held: the steady answer to a tone, strongest at a degree whose own note it is, and lagging it there by a quarter.
        const off = om.mul(om).sub(tone.mul(tone)) as any;
        const loss = g.mul(2).mul(tone).toVar() as any;
        const gain = loss.div(sqrt(off.mul(off).add(loss.mul(loss)))) as any;
        amount.assign(w.mul(gain).mul(cos(phase.sub(atan(loss, off)))));
      }).Else(() => {
        // Struck: a kick to the surface's speed, so each degree swings as sin(ωt)/ω and dies away.
        amount.assign(w.mul(sin(om.mul(age))).div(om).mul(exp(g.mul(age).negate())));
      });
      height.addAssign(amount.mul(now));
      slope.addAssign(amount.mul(l).mul(before.sub(c.mul(now))));
    });
    const scale = at.w.mul(time.y) as any;
    height.mulAssign(scale);
    slope.assign(slope.mul(scale).negate().div(max(s, 1e-4)));
  });
  table.element(instanceIndex).assign(vec2(height, slope));
})().compute(ROWS * SAMPLES);

// The drop's height at direction n (unit), as a fraction of its radius; with `slope`, also its gradient over the sphere.
export function surface(n: any, withSlope: boolean) {
  const both = Fn(() => {
  const height = float(0).toVar() as any;
  const grad = vec3(0).toVar() as any;
  Loop({ start: int(0), end: int(ROWS), type: "int", condition: "<" }, ({ i }: any) => {
    const at = rowAt.element(i) as any;
    If(at.w.greaterThan(0), () => {
      const c = dot(n, at.xyz).toVar() as any;
      const side = length(cross(n, at.xyz)).toVar() as any;
      // The angle by atan2 rather than acos: the GPU's fast acos is rough enough to ripple the slopes read back.
      const u = clamp(atan(side, c).mul(SAMPLES / Math.PI).sub(0.5), 0, SAMPLES - 1.001).toVar() as any;
      const k = int(floor(u)).toVar() as any;
      const f = u.sub(floor(u)) as any;
      const base = i.mul(SAMPLES).add(k) as any;
      const a = table.element(base) as any;
      const b = table.element(min(base.add(1), i.mul(SAMPLES).add(SAMPLES - 1))) as any;
      const v = mix(a, b, f) as any;
      height.addAssign(v.x);
      if (withSlope) {
        // Down the angle away from the point struck, along the surface.
        const away = n.mul(c).sub(at.xyz).div(max(side, 1e-4)) as any;
        grad.addAssign(away.mul(v.y));
      }
    });
  });
  // The breath: three slow quadrupoles about fixed axes, each with its gradient (n·e)² → 2(n·e)(e − (n·e)n).
  const axes: [number, number, number, number, number][] = [
    [0.8, 0.5, 0.33, 0.41, 0],
    [-0.3, 0.9, 0.3, 0.29, 2.1],
    [0.2, -0.3, 0.93, 0.36, 4.2]
  ];
  for (const [x, y, z, rate, phase] of axes) {
    const e = vec3(x, y, z).normalize() as any;
    const ne = dot(n, e).toVar() as any;
    const amp = sin(clock.mul(rate).add(phase)).mul(breath).mul(0.011) as any;
    height.addAssign(amp.mul(ne.mul(ne).sub(1 / 3)));
    if (withSlope) grad.addAssign(e.sub(n.mul(ne)).mul(ne.mul(2)).mul(amp));
  }
  return vec4(grad, height);
  })() as any;
  return { height: both.w as any, grad: both.xyz as any };
}
