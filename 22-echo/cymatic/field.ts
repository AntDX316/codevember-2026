import * as THREE from "three/webgpu";
import { abs, acos, atan, clamp, cos, exp, float, Fn, instancedArray, instanceIndex, length, max, min, mix, select, sin, smoothstep, transpose, uniform, vec3, vec4 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Cymatics in 3D: a ball of dust in a standing wave. The wave is a field over space, and its nodal surfaces (where it is
// still) are where the dust gathers, as sand does on a Chladni plate: each point is shaken in proportion to how hard the
// field moves where it sits, and drawn down the field's slope toward the nearest place it is still. Every mode is one
// formula with different numbers, so a new tone only changes uniforms.

// The ball's radius, and how fast a struck tone's wavefront crosses it, in world units a second.
export const BALL = 2;
export const SPEED = 3.2;
// Wavefronts at once: strikes and their echoes off the ball's far wall.
export const FRONTS = 8;

export const COUNTS: Record<QualityTier, { dust: number; air: number }> = {
  high: { dust: 320000, air: 8000 },
  medium: { dust: 200000, air: 6000 },
  low: { dust: 90000, air: 3000 }
};

// A mode: radial waves k, azimuthal symmetry m, polar waves n, angular amount a; gyroid and Schwarz lattice amounts at
// frequency q; and a twist that winds the petals into a spiral with depth. Pitch is in semitones above the root.
export type Mode = { name: string; k: number; m: number; n: number; a: number; gyroid: number; schwarz: number; q: number; twist: number; pitch: number };

export const MODES: Mode[] = [
  { name: "spiral", k: 2.6, m: 6, n: 2, a: 1.2, gyroid: 0, schwarz: 0, q: 0, twist: 1.4, pitch: 0 },
  { name: "lattice", k: 2.2, m: 0, n: 0, a: 0, gyroid: 1.3, schwarz: 0, q: 2.6, twist: 0, pitch: 7 },
  { name: "star", k: 2.2, m: 4, n: 3, a: 1.8, gyroid: 0, schwarz: 0, q: 0, twist: 0, pitch: 3 },
  { name: "rings", k: 3.2, m: 0, n: 4, a: 0.9, gyroid: 0, schwarz: 0, q: 0, twist: 0, pitch: 5 },
  { name: "crystal", k: 2.2, m: 0, n: 0, a: 0, gyroid: 0, schwarz: 1.1, q: 3, twist: 0, pitch: 12 },
  { name: "lotus", k: 2.4, m: 5, n: 2, a: 1.3, gyroid: 0, schwarz: 0, q: 0, twist: 0, pitch: 10 }
];

export const modeVectors = (mode: Mode) => [new THREE.Vector4(mode.k, mode.m, mode.n, mode.a), new THREE.Vector4(mode.gyroid, mode.schwarz, mode.q, mode.twist)];

export type Field = ReturnType<typeof createField>;

export function createField(tier: QualityTier) {
  const random = lehmer(22071);
  const { dust, air } = COUNTS[tier];
  const count = dust + air;
  // Fewer points each burn a little brighter, so a lower tier keeps most of the glow.
  const lift = Math.sqrt(COUNTS.high.dust / dust);
  // Per point: where it starts, and (seed, kind): kind 0 is the ball's dust, 1 the far motes drifting round it.
  const start = new Float32Array(count * 4);
  const info = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    const outer = i >= dust;
    const r = outer ? 2.8 + 7 * Math.pow(random(), 1.3) : BALL * Math.cbrt(random());
    start.set([Math.cos(a) * ring * r, z * r * (outer ? 0.7 : 1), Math.sin(a) * ring * r, 0], i * 4);
    info.set([random(), outer ? 1 : 0, random(), random()], i * 4);
  }

  const infos = instancedArray(info, "vec4") as any;
  const pos = instancedArray(start, "vec4") as any;
  const vel = instancedArray(count, "vec4") as any;
  const shade = instancedArray(count, "vec4") as any;

  const [a0, b0] = modeVectors(MODES[0]);
  const u = {
    now: uniform(0),
    dt: uniform(0),
    // How loud the tone is (0 to 1), and how far a held tone has sharpened the pattern (0 to 1).
    drive: uniform(0.25),
    sharp: uniform(0),
    // The mode the dust is leaving and the one it is going to; points take the new one once the strike's front passes.
    fromA: uniform(a0.clone()),
    fromB: uniform(b0.clone()),
    toA: uniform(a0.clone()),
    toB: uniform(b0.clone()),
    strike: uniform(new THREE.Vector4(0, 0, 0, -100)),
    // The field's frame, leaning toward the eye; and how far the whole ball has turned, for drawing. The dust lives in the
    // ball's own space, so a turn never drags it behind its pattern.
    frame: uniform(new THREE.Matrix3()),
    spin: uniform(0),
    // The eye, in the ball's space.
    eye: uniform(new THREE.Vector3(0, 0, 8)),
    pixel: uniform(0.0005),
    focus: uniform(8),
    hot: uniform(new THREE.Color("#fff3e0")),
    mid: uniform(new THREE.Color("#ffb45c")),
    deep: uniform(new THREE.Color("#c2366b")),
    frontAt: Array.from({ length: FRONTS }, () => uniform(new THREE.Vector4(0, 0, 0, -100))),
    frontStrength: Array.from({ length: FRONTS }, () => uniform(0)),
    camRight: uniform(new THREE.Vector3(1, 0, 0)),
    camUp: uniform(new THREE.Vector3(0, 1, 0))
  };

  // The standing wave's amplitude at a point in the field's frame: concentric shells, rippled by an angular harmonic into
  // petals, plus a triply periodic lattice for the crystal modes, all faded toward the centre where angles mean nothing.
  const wave = Fn(([p, A, B]: any[]) => {
    const r = length(p).add(1e-4) as any;
    const theta = acos(clamp(p.y.div(r), -1, 1)) as any;
    const phi = atan(p.z, p.x).add(r.mul(B.w)) as any;
    const sectoral = min(A.y, 1) as any;
    const angular = mix(cos(theta.mul(A.z)), cos(phi.mul(A.y)).mul(sin(theta.mul(A.z))), sectoral) as any;
    const q = p.mul(B.z) as any;
    const gyroid = sin(q.x).mul(cos(q.y)).add(sin(q.y).mul(cos(q.z))).add(sin(q.z).mul(cos(q.x))) as any;
    const schwarz = cos(q.x).add(cos(q.y)).add(cos(q.z)) as any;
    return cos(r.mul(A.x))
      .add(angular.mul(A.w).mul(smoothstep(0.05, 0.6, r)))
      .add(gyroid.mul(B.x))
      .add(schwarz.mul(B.y));
  }).setLayout({
    name: "cymaticWave",
    type: "float",
    inputs: [
      { name: "p", type: "vec3" },
      { name: "A", type: "vec4" },
      { name: "B", type: "vec4" }
    ]
  }) as any;

  const update = Fn(() => {
    const i = instanceIndex;
    const info = infos.element(i) as any;
    const seed = info.x as any;
    const outer = info.y as any;
    const inner = float(1).sub(outer) as any;
    const p = pos.element(i) as any;
    const v = vel.element(i) as any;
    const at = p.xyz as any;

    // Which mode this point feels: the new one once the strike's front has passed it.
    const sinceStrike = u.now.sub(u.strike.w).sub(length(at.sub(u.strike.xyz)).div(SPEED)) as any;
    const taken = smoothstep(0, 0.35, sinceStrike) as any;
    const A = mix(u.fromA, u.toA, taken) as any;
    const B = mix(u.fromB, u.toB, taken) as any;

    // The field and its slope, in the turning frame; the slope brought back to the world.
    const fp = u.frame.mul(at) as any;
    const h = 0.012;
    const f0 = wave(fp, A, B) as any;
    const gx = wave(fp.add(vec3(h, 0, 0)), A, B).sub(f0) as any;
    const gy = wave(fp.add(vec3(0, h, 0)), A, B).sub(f0) as any;
    const gz = wave(fp.add(vec3(0, 0, h)), A, B).sub(f0) as any;
    const gradLocal = vec3(gx, gy, gz).div(h) as any;
    const grad = transpose(u.frame).mul(gradLocal) as any;
    const slope = length(grad).add(0.08) as any;
    // How far the point is from the nearest still surface, signed, to first order.
    const off = f0.div(slope) as any;

    // Drawn down the slope to the still surface; shaken where the field moves (the antinodes), as sand on a plate is.
    const drive = u.drive as any;
    const strength = drive.mul(mix(float(4.5), float(9), u.sharp)) as any;
    const pull = grad.div(slope).mul(clamp(off, -0.3, 0.3).negate()).mul(strength) as any;
    const t = u.now as any;
    const n1 = seed.mul(91.7).add(t.mul(37.1)) as any;
    const shake = vec3(sin(n1.mul(1.13)), sin(n1.mul(1.71).add(2.1)), sin(n1.mul(1.37).add(4.2))) as any;
    // Only a sounding tone shakes: once it has rung out the dust lies where it was left, drifting.
    const jitter = shake.mul(min(abs(f0), 1.2)).mul(max(drive.sub(0.35), 0).mul(1.55)).mul(mix(float(1.1), float(0.5), u.sharp)) as any;

    // Without a tone the dust drifts on slow loops of its own.
    const w = t.mul(0.16) as any;
    const s = at.mul(0.9).add(seed.mul(13)) as any;
    const wander = vec3(
      sin(s.y.add(w.mul(1.1))).add(sin(s.z.mul(2.1).sub(w.mul(1.6))).mul(0.5)),
      sin(s.z.add(w.mul(0.9)).add(1.7)).add(sin(s.x.mul(1.9).add(w.mul(1.3))).mul(0.5)),
      sin(s.x.sub(w).add(3.1)).add(sin(s.y.mul(2.3).sub(w.mul(1.4))).mul(0.5))
    ) as any;
    const calm = float(1).sub(drive).mul(0.05).add(0.012).mul(float(1).sub(u.sharp.mul(0.6))) as any;
    // Kept inside the ball, gently.
    const r = length(at) as any;
    const keep = at.div(r.add(1e-4)).mul(max(r.sub(BALL), 0).mul(-3)) as any;

    // Every wavefront: a bright shell crossing the dust and a push outward from its source as it passes.
    const flash = float(0).toVar() as any;
    const push = vec3(0).toVar() as any;
    for (let k = 0; k < FRONTS; k++) {
      const src = u.frontAt[k] as any;
      const power = u.frontStrength[k] as any;
      const rel = at.sub(src.xyz) as any;
      const d = length(rel).add(1e-3) as any;
      const age = u.now.sub(src.w).sub(d.div(SPEED)) as any;
      const band = exp(age.div(select(age.lessThan(0), float(0.05), float(0.12))).pow(2).negate()) as any;
      const reach = power.div(d.mul(0.35).add(1)) as any;
      flash.addAssign(band.mul(reach));
      push.addAssign(rel.div(d).mul(band.mul(reach)));
    }

    const desired = pull.add(wander.mul(calm)).mul(inner).add(wander.mul(0.05).mul(outer)) as any;
    const nv = v.xyz
      .add(desired.sub(v.xyz).mul(min(u.dt.mul(5), 1)))
      .add(jitter.add(keep).add(push.mul(5)).mul(u.dt).mul(inner)) as any;
    const np = at.add(nv.mul(u.dt)) as any;

    // How it is seen: points on a still surface glow, the more so the louder and sharper the tone; the front burns white.
    const on = exp(off.div(mix(float(0.06), float(0.03), u.sharp)).pow(2).negate()).mul(inner) as any;
    const settle = on.mul(drive.mul(0.6).add(0.4)).mul(smoothstep(0.25, 0.75, r).mul(0.6).add(0.4)) as any;
    const glint = seed.mul(13.7).fract() as any;
    const depth = smoothstep(0.2, BALL, r) as any;
    const tone = mix(u.mid, u.deep, depth) as any;
    const fire = min(flash, 1.5) as any;
    const away = length(u.eye.sub(np)) as any;
    const near = smoothstep(0.8, 3.5, away).mul(0.8).add(0.2) as any;
    const colour = (u.deep as any)
      .mul(mix(float(0.007), float(0.05), outer).mul(glint.mul(1.3).add(0.3)))
      .add(tone.mul(settle.mul(0.15)))
      .add(mix(u.mid, u.hot, settle.mul(drive).mul(u.sharp.mul(0.5).add(0.3))).mul(settle.mul(glint.pow(3)).mul(0.12)))
      .add(mix(u.mid, u.hot, min(fire, 1)).mul(fire.mul(0.12)).mul(inner))
      .mul(near)
      .mul(mix(float(lift), float(1), outer)) as any;

    // Size on screen: a fine grain, never under about half a pixel (dimmer instead), blurred into a soft disc away from the
    // focus as a lens does, never wider than about two degrees.
    const grain = mix(float(0.0055).mul(glint.mul(0.8).add(0.6)), float(0.012).mul(info.z.pow(5).mul(2.5).add(0.6)), outer) as any;
    const px = u.pixel.mul(away) as any;
    const sharpSize = max(grain, px.mul(0.55)) as any;
    const dim = grain.div(sharpSize).pow(2) as any;
    const blur = min(abs(away.sub(u.focus)).div(away).mul(mix(float(0.012), float(0.03), outer)), away.mul(0.022)) as any;
    const radius = sharpSize.add(blur) as any;
    const spread = max(sharpSize.div(radius).pow(2), float(0.02)) as any;
    const soft = smoothstep(0.4, 2.5, blur.div(px)) as any;

    p.assign(vec4(np, 0));
    v.assign(vec4(nv, soft));
    shade.element(i).assign(vec4(colour.mul(dim).mul(spread), radius));
  })().compute(count);

  return { count, dust, pos, vel, shade, u, update };
}
