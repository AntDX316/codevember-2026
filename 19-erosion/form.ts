import { abs, atan, floor, clamp, cos, cross, dot, float, fract, If, length, Loop, max, min, mix, mx_noise_float, normalize, pow, sin, smoothstep, vec2, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sculptures, each a solid-or-not test for any point, worked out once per cell for every form while the page loads.
// p is in the sculpture's own units, its middle at the origin; every form fits within REACH of it. Each is built so its
// parts run from thin to thick, so erosion takes them in an order you can see: the finest first, the heaviest last.

// How far any form reaches from its middle, so the grid can be sized round them all.
export const REACH = 1.26;

// The nearest point of a closed curve (period 2π) to p, coarse to fine: the nearest of 24 segments first, then 18 finer
// ones over that segment and its neighbours. About a third of the work of 128 even segments, as exact where it matters.
function nearestOn(curve: (t: any) => any, p: any) {
  const best = float(9).toVar() as any;
  const at = float(0).toVar() as any;
  const near = vec3(0).toVar() as any;
  const along = vec3(1, 0, 0).toVar() as any;
  const coarse = (Math.PI * 2) / 24;
  const roughBest = float(9).toVar() as any;
  const roughAt = float(0).toVar() as any;
  Loop(24, ({ i }: any) => {
    const t = float(i).mul(coarse) as any;
    const a = curve(t) as any;
    const ab = curve(t.add(coarse)).sub(a) as any;
    const h = clamp(dot(p.sub(a), ab).div(dot(ab, ab)), 0, 1) as any;
    const d = length(p.sub(a.add(ab.mul(h)))) as any;
    If(d.lessThan(roughBest), () => {
      roughBest.assign(d);
      roughAt.assign(t);
    });
  });
  const fine = (coarse * 3) / 18;
  Loop(18, ({ i }: any) => {
    const t = roughAt.sub(coarse).add(float(i).mul(fine)) as any;
    const a = curve(t) as any;
    const ab = curve(t.add(fine)).sub(a) as any;
    const h = clamp(dot(p.sub(a), ab).div(dot(ab, ab)), 0, 1) as any;
    const c = a.add(ab.mul(h)) as any;
    const d = length(p.sub(c)) as any;
    If(d.lessThan(best), () => {
      best.assign(d);
      at.assign(t.add(h.mul(fine)));
      near.assign(c);
      along.assign(ab);
    });
  });
  // Back into one turn, 0 to 2π.
  at.assign(at.sub(floor(at.div(Math.PI * 2)).mul(Math.PI * 2)));
  return { best, at, near, along };
}

// Loop: after the driftwood carving, a ring a little out of plane whose softened-ellipse section turns half a turn on
// the way round and swells low on the left. Its slim side goes first.
const LOOP = { R: 0.84, A: 0.3, B: 0.14, segments: 128 };
function loopCentre(u: any) {
  const r = float(LOOP.R).mul(
    float(1)
      .add(cos(u.mul(2).add(0.6)).mul(0.06))
      .add(sin(u.mul(3).add(0.4)).mul(0.025))
  ) as any;
  return vec3(
    r.mul(cos(u)),
    r.mul(sin(u)).mul(1.04),
    sin(u.mul(2).add(1.1))
      .mul(0.095)
      .add(sin(u.mul(3)).mul(0.036))
  ) as any;
}
function loop(p: any) {
  const solid = float(0).toVar() as any;
  If(abs(length(p.xy).sub(LOOP.R)).lessThan(0.5).and(abs(p.z).lessThan(0.48)), () => {
    const { at, near, along } = nearestOn(loopCentre, p);
    const tangent = normalize(along) as any;
    const side = normalize(cross(tangent, vec3(0, 0, 1))) as any;
    const binormal = cross(side, tangent) as any;
    const r = p.sub(near) as any;
    const X = dot(r, side) as any;
    const Y = dot(r, binormal) as any;
    // Undo the section's half turn, then test against the softened ellipse there.
    const twist = at.mul(0.5).add(0.35) as any;
    const x = X.mul(cos(twist)).add(Y.mul(sin(twist))) as any;
    const y = Y.mul(cos(twist)).sub(X.mul(sin(twist))) as any;
    const swell = float(1)
      .add(cos(at.sub(3.6)).mul(0.2))
      .add(cos(at.mul(3).add(1)).mul(0.04)) as any;
    const a = swell.mul(LOOP.A) as any;
    const b = float(1)
      .add(cos(at.sub(3.6)).mul(0.16))
      .mul(LOOP.B) as any;
    const e = 2 / 0.86;
    If(
      pow(abs(x).div(a), float(e))
        .add(pow(abs(y).div(b), float(e)))
        .lessThan(1),
      () => solid.assign(1)
    );
  });
  return solid;
}

// Ribbon: after the weathering-steel monument, one plate joined to itself after three half turns (so, like a Möbius
// band, it has one face and one edge), standing tall. It is
// thick along its spine and thins toward its one edge, and unevenly, so erosion eats it into lace from the edge in.
const RIBBON = { RX: 0.74, RY: 0.84, W: 0.36, segments: 140 };
function ribbonCentre(t: any) {
  return vec3(sin(t).mul(RIBBON.RX), cos(t).mul(RIBBON.RY), 0) as any;
}
function ribbon(p: any) {
  const solid = float(0).toVar() as any;
  const q = p.sub(vec3(0, -0.04, 0)) as any;
  If(length(q.xy).lessThan(1.25), () => {
    const { at, near } = nearestOn(ribbonCentre, q);
    const t = at as any;
    // Outward in the loop's plane, and the band's width turned about the loop by half the angle.
    const out = normalize(vec3(sin(t).mul(RIBBON.RY), cos(t).mul(RIBBON.RX), 0)) as any;
    const across = out.mul(cos(t.mul(1.5))).add(vec3(0, 0, 1).mul(sin(t.mul(1.5)))) as any;
    const tangent = normalize(vec3(cos(t).mul(RIBBON.RX), sin(t).mul(-RIBBON.RY), 0)) as any;
    const face = cross(tangent, across) as any;
    const r = q.sub(near) as any;
    const half = float(RIBBON.W).sub(cos(t).mul(0.045)) as any;
    const s = dot(r, across).div(half) as any;
    // Thick at the spine and heavier toward the foot of the loop, thin at the edge, and patchy, so it holes through.
    const foot = smoothstep(0.3, -0.9, near.y).mul(0.025) as any;
    const patch = mx_noise_float(p.mul(4.2).add(7.3)).mul(0.5).add(0.5) as any;
    const thick = mix(float(0.15), float(0.032), s.mul(s))
      .add(foot)
      .mul(mix(float(0.5), float(1.2), patch)) as any;
    If(
      abs(s)
        .lessThan(1)
        .and(abs(dot(r, face)).lessThan(thick.mul(0.5))),
      () => solid.assign(1)
    );
  });
  return solid;
}

// Link: two rings through each other, as in a chain, each through the other's middle. One is heavy and swells and
// thins as it goes round; the other is slender and pinched, so it wears through long before its partner.
const LINK = [
  { centre: [-0.37, 0.04, 0], R: 0.7, plane: "xy", tube: 0.165, swell: 0.065, phase: 0.6, flat: 0.78 },
  { centre: [0.37, -0.04, 0], R: 0.7, plane: "xz", tube: 0.08, swell: 0.04, phase: 2.4, flat: 0.85 }
] as const;
function link(p: any) {
  const solid = float(0).toVar() as any;
  for (const ring of LINK) {
    const q = p.sub(vec3(...ring.centre)) as any;
    // Into the ring's own frame: it lies in the first two axes, the third across it.
    const a = ring.plane === "xy" ? q.xy : q.xz;
    const across = ring.plane === "xy" ? q.z : q.y;
    const round = length(a) as any;
    const angle = atan(a.y, a.x) as any;
    const tube = float(ring.tube)
      .add(sin(angle.add(ring.phase)).mul(ring.swell))
      .add(sin(angle.mul(3).add(ring.phase * 2)).mul(0.012)) as any;
    // A section a little flattened across the ring, as a cast link is.
    const r = length(vec2(round.sub(ring.R), across.div(ring.flat))) as any;
    If(r.lessThan(tube), () => solid.assign(1));
  }
  return solid;
}

// Lattice: a ball of rods on a cubic grid, hair-fine at the surface and thickening toward a solid heart, so erosion
// strips it from the outside in, as frost thaws.
function lattice(p: any) {
  const solid = float(0).toVar() as any;
  const r = length(p) as any;
  If(r.lessThan(1.18), () => {
    const L = 0.2;
    const q = fract(p.div(L).add(0.5)).sub(0.5).mul(L) as any;
    const rod = min(min(length(q.yz), length(q.xz)), length(q.xy)) as any;
    const radius = mix(float(0.062), float(0.016), smoothstep(0.3, 1.15, r)) as any;
    If(rod.lessThan(radius).or(r.lessThan(0.3)), () => solid.assign(1));
  });
  return solid;
}

// turn: how far each is turned about the vertical to face the eye at its best.
export const FORMS: { value: string; label: string; turn: number; solid: (p: any) => any }[] = [
  { value: "loop", label: "Loop", turn: -0.3, solid: loop },
  { value: "ribbon", label: "Ribbon", turn: 0.55, solid: ribbon },
  { value: "link", label: "Link", turn: -0.5, solid: link },
  { value: "lattice", label: "Lattice", turn: 0.35, solid: lattice }
];
