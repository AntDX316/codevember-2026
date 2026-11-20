import { atan, clamp, cos, dot, float, floor, Fn, fract, log, max, min, pow, round, sin, sqrt, vec2, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const PHI = (1 + Math.sqrt(5)) / 2;

// Spike `i` of `n` on a spherical Fibonacci lattice, with its pole on +z. Its cells are near-hexagons, which is the pattern
// a real ferrofluid settles into, and the lattice spirals out from the pole like a sunflower, which is where the field is.
function latticePoint(i: any, n: any) {
  const m = float(1).sub(float(1).div(n));
  const around = fract(i.mul(PHI)).mul(Math.PI * 2) as any;
  const height = clamp(m.sub(i.mul(2).div(n)), -1, 1) as any;
  const ring = sqrt(max(float(1).sub(height.mul(height)), float(0))) as any;
  return vec3(cos(around).mul(ring) as any, sin(around).mul(ring) as any, height);
}

// The nearest lattice point to a direction, without searching all of them: the inverse mapping of Keinert et al.,
// "Spherical Fibonacci Mapping" (2015), as written by Inigo Quilez. It works for any n, whole or not, so the spikes
// can drift smoothly from sparse to dense. Returns the point and its index. Checked against a brute-force search.
export const nearestSpike = Fn(([p, n]: any[]) => {
  const m = float(1).sub(float(1).div(n));
  const around = min(atan(p.y, p.x), float(Math.PI)) as any;
  const height = p.z as any;
  const k = max(float(2), floor(log(n.mul(Math.PI * Math.sqrt(5)).mul(max(float(1).sub(height.mul(height)), float(1e-6)))).div(Math.log(PHI * PHI)))) as any;
  const fk = pow(float(PHI), k).div(Math.sqrt(5)) as any;
  const F = vec2(round(fk), round(fk.mul(PHI))).toVar() as any;
  const ka = F.mul(2).div(n).toVar() as any;
  const kb = fract(F.add(1).mul(PHI)).sub(PHI - 1).mul(Math.PI * 2).toVar() as any;
  const det = ka.y.mul(kb.x).sub(ka.x.mul(kb.y)) as any;
  const vy = height.sub(m) as any;
  const cell = floor(vec2(ka.y.mul(around).add(kb.y.mul(vy)), ka.x.mul(around).add(kb.x.mul(vy)).negate()).div(det)).toVar() as any;
  const best = float(9).toVar() as any;
  const index = float(0).toVar() as any;
  const point = vec3(0, 0, 1).toVar() as any;
  // Four corners of the lattice cell; one of them is the nearest.
  for (const [a, b] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ]) {
    const i = dot(F, cell.add(vec2(a, b))).toVar() as any;
    const q = latticePoint(i, n).toVar() as any;
    const gap = q.sub(p) as any;
    // Corners past either end of the spiral are not spikes.
    const d = dot(gap, gap).add(i.lessThan(0).or(i.greaterThan(n.sub(1))).select(float(100), float(0))).toVar() as any;
    const nearer = d.lessThan(best) as any;
    index.assign(nearer.select(i, index));
    point.assign(nearer.select(q, point));
    best.assign(min(best, d));
  }
  return vec4(point, index);
}).setLayout({ name: "ferroNearestSpike", type: "vec4", inputs: [{ name: "p", type: "vec3" }, { name: "n", type: "float" }] }) as any;

// Half the gap between neighbouring spikes, as a chord on the unit sphere, for n spikes packed as hexagons.
export const SPACING = 1.905;
