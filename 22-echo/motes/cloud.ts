import * as THREE from "three/webgpu";
import { abs, cos, If, dot, exp, float, fract, Fn, instancedArray, instanceIndex, length, max, min, mix, normalize, pow, sin, smoothstep, sqrt, uniform, vec2, vec3, vec4 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";
import { AXIS, airLight, eddy } from "./air";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Sounding the dust: a cloud of Erosion's tumbling flecks hangs in the shafts, and in the middle of it is a smooth form
// that is never drawn. A tap sends a pressure wave out from where it lands; each fleck it passes is kicked along it,
// spins up and flashes. Where the front meets the form it is reflected: an echo leaves every point of the surface the
// front touches, so the echo front is the form's own shape, growing outward, and the flecks it passes flash cool. Flecks
// right at the surface are briefly drawn onto it, so for a moment the hidden form stands in glinting dust.
//
// Each fleck works out its echo from the nearest point of the surface: the echo reaches it after the time the front took
// to reach that point plus the time back out, and only from a point that faces the tap.

// How fast a front travels, in world units a second.
export const SPEED = 2.2;
// Fronts at once, one a tap.
export const FRONTS = 16;
// How long a front and its echo take to leave the cloud, in seconds.
export const LIFE = 6.5;
// The cloud's reach, across and up.
export const REACH = 2.7;
const SQUASH = 0.78;

export const COUNTS: Record<QualityTier, number> = { high: 320000, medium: 200000, low: 90000 };

// The hidden form: a torus, leaning and turning slowly, melted together with three drifting balls. The same distance
// function runs here for the processor (aiming, timing the sound) and in the compute pass.
const TORUS = { major: 0.78, minor: 0.24 };
const BALLS = [
  { at: [0.05, 0.05, 0.0], r: 0.5, w: [0.11, 0.17, 0.13], amp: 0.12, ph: 0 },
  { at: [0.72, 0.32, 0.15], r: 0.36, w: [0.19, 0.13, 0.16], amp: 0.28, ph: 1.9 },
  { at: [-0.62, -0.4, -0.12], r: 0.4, w: [0.14, 0.21, 0.12], amp: 0.26, ph: 4.1 }
];
const BLEND = 0.36;

export type Form = { frame: THREE.Matrix3; balls: THREE.Vector4[] };

export function formAt(t: number, out: Form) {
  const m = new THREE.Matrix4().makeRotationY(t * 0.09).multiply(new THREE.Matrix4().makeRotationX(0.95 + Math.sin(t * 0.07) * 0.35)).multiply(new THREE.Matrix4().makeRotationZ(Math.sin(t * 0.05) * 0.4));
  // The frame takes world points into the torus's own space.
  out.frame.setFromMatrix4(m).transpose();
  BALLS.forEach((b, k) => {
    out.balls[k].set(
      b.at[0] + Math.sin(t * b.w[0] + b.ph) * b.amp,
      b.at[1] + Math.sin(t * b.w[1] + b.ph * 1.3) * b.amp,
      b.at[2] + Math.sin(t * b.w[2] + b.ph * 0.7) * b.amp,
      b.r * (1 + Math.sin(t * 0.23 + b.ph) * 0.12)
    );
  });
  return out;
}
export const newForm = (): Form => ({ frame: new THREE.Matrix3(), balls: BALLS.map(() => new THREE.Vector4()) });

const sminJS = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const scratch = new THREE.Vector3();
export function formDistance(p: THREE.Vector3, form: Form) {
  const q = scratch.copy(p).applyMatrix3(form.frame);
  let d = Math.hypot(Math.hypot(q.x, q.z) - TORUS.major, q.y) - TORUS.minor;
  for (const b of form.balls) d = sminJS(d, Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) - b.w, BLEND);
  return d;
}

export type Cloud = ReturnType<typeof createCloud>;

export function createCloud(tier: QualityTier) {
  const random = lehmer(22122);
  const count = COUNTS[tier];
  // Fewer flecks each catch a little more light, so a lower tier keeps most of the shimmer.
  const lift = Math.sqrt(COUNTS.high / count);
  // Each fleck's resting place, denser toward the middle with a soft edge, and a seed.
  const home = new Float32Array(count * 4);
  const start = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    const r = REACH * Math.pow(random(), 0.42) * (0.82 + 0.18 * random());
    const x = Math.cos(a) * ring * r;
    const y = z * r * SQUASH;
    const zz = Math.sin(a) * ring * r;
    home.set([x, y, zz, 0], i * 4);
    start.set([x, y, zz, random()], i * 4);
  }
  const homes = instancedArray(home, "vec4") as any;
  // Where it is and its seed; how it moves and how fast it spins; its glints (warm from the tap's front, cool from the
  // echo) and its two tumble angles; and how it is drawn (colour and size, then angle, narrowing and shape).
  const pos = instancedArray(start, "vec4") as any;
  const vel = instancedArray(count, "vec4") as any;
  const glow = instancedArray(count, "vec4") as any;
  const shade = instancedArray(count, "vec4") as any;
  const turn = instancedArray(count, "vec4") as any;

  const u = {
    now: uniform(0),
    // 1 while any front is still out.
    active: uniform(0),
    dt: uniform(1 / 60),
    eye: uniform(new THREE.Vector3(0, 0, 8)),
    pixel: uniform(0.0007),
    focus: uniform(7),
    frontAt: Array.from({ length: FRONTS }, () => uniform(new THREE.Vector4(0, 0, 0, -100))),
    frontPower: Array.from({ length: FRONTS }, () => uniform(0)),
    frame: uniform(new THREE.Matrix3()),
    balls: BALLS.map(() => uniform(new THREE.Vector4())),
    warm: uniform(new THREE.Color("#fff1d6")),
    cool: uniform(new THREE.Color("#8fd0ff")),
    dust: uniform(new THREE.Color("#ddd0bd"))
  };

  const smin = (a: any, b: any) => {
    const h = max(float(BLEND).sub(abs(a.sub(b))), 0).div(BLEND) as any;
    return min(a, b).sub(h.mul(h).mul(BLEND * 0.25)) as any;
  };
  const sdf = Fn(([p]: any[]) => {
    const q = u.frame.mul(p) as any;
    let d: any = length(vec2(length(q.xz).sub(TORUS.major), q.y)).sub(TORUS.minor);
    for (const b of u.balls as any[]) d = smin(d, length(p.sub(b.xyz)).sub(b.w));
    return d;
  }).setLayout({ name: "echoForm", type: "float", inputs: [{ name: "p", type: "vec3" }] }) as any;

  const update = Fn(() => {
    const i = instanceIndex;
    const P = pos.element(i) as any;
    const V = vel.element(i) as any;
    const S = glow.element(i) as any;
    const H = homes.element(i) as any;
    const x = P.xyz.toVar() as any;
    const seed = P.w as any;
    const other = fract(seed.mul(91.7).add(0.37)) as any;
    const v = V.xyz.toVar() as any;
    const dt = u.dt as any;
    const t = u.now as any;

    // Glints die away within a second; spin and cling a little slower.
    const warm = S.x.mul(exp(dt.div(-0.15))).toVar() as any;
    const cool = S.y.mul(exp(dt.div(-0.3))).toVar() as any;
    const spin = V.w.mul(exp(dt.div(-1.3))).toVar() as any;
    const cling = H.w.mul(exp(dt.div(-1.8))).toVar() as any;

    // Only while a front is out: the form here (its distance, its outward direction by tetrahedral differences, and the
    // nearest point on it), and every front and its echo.
    const kick = vec3(0).toVar() as any;
    const n = vec3(0, 1, 0).toVar() as any;
    const surf = x.toVar() as any;
    If(u.active.greaterThan(0.5), () => {
      const e = 0.012;
      const k1 = vec3(1, -1, -1);
      const k2 = vec3(-1, -1, 1);
      const k3 = vec3(-1, 1, -1);
      const k4 = vec3(1, 1, 1);
      const d1 = sdf(x.add(k1.mul(e))) as any;
      const d2 = sdf(x.add(k2.mul(e))) as any;
      const d3 = sdf(x.add(k3.mul(e))) as any;
      const d4 = sdf(x.add(k4.mul(e))) as any;
      const f = d1.add(d2).add(d3).add(d4).mul(0.25).toVar() as any;
      const grad = k1.mul(d1).add(k2.mul(d2)).add(k3.mul(d3)).add(k4.mul(d4)) as any;
      n.assign(grad.div(max(length(grad), float(1e-5))));
      surf.assign(x.sub(n.mul(f)));
      const outside = max(f, float(0)) as any;
      const near = float(1).sub(smoothstep(0.12, 0.5, abs(f))) as any;
      const shell = outside.mul(2.5).add(1) as any;
      const reflects = smoothstep(-0.5, -0.25, f) as any;

      for (let k = 0; k < FRONTS; k++) {
        const src = u.frontAt[k] as any;
        const power = u.frontPower[k] as any;
        const age = t.sub(src.w) as any;
        If(age.lessThan(LIFE).and(power.greaterThan(0)), () => {
          // The tap's front: a thin shell.
          const rel = x.sub(src.xyz) as any;
          const d = length(rel).add(1e-3) as any;
          const ph = age.sub(d.div(SPEED)) as any;
          const band = exp(ph.div(0.075).pow(2).negate()) as any;
          const reach = power.div(d.mul(0.7).add(1)) as any;
          kick.addAssign(rel.div(d).mul(band.mul(reach)));
          warm.assign(max(warm, band.mul(reach)));
          // Its echo, from the nearest point of the form, if that point faces the tap.
          const back = src.xyz.sub(surf) as any;
          const ds = length(back).add(1e-3) as any;
          const facing = max(dot(back.div(ds), n), float(0)) as any;
          const phE = age.sub(ds.add(outside).div(SPEED)) as any;
          const bandE = exp(phE.div(0.07).pow(2).negate()) as any;
          const strE = power.mul(sqrt(facing)).div(ds.mul(0.4).add(1)).mul(reflects) as any;
          cool.assign(max(cool, bandE.mul(strE).mul(1.6).div(shell.mul(shell))));
          cling.assign(max(cling, bandE.mul(strE).mul(near).mul(2)));
        });
      }
    });
    spin.assign(max(spin, warm.mul(7).add(cool.mul(5))));

    // Kicked along the front, then the air takes it back: each fleck follows its own resting place, which the eddies
    // carry round in slow loops, lazily, so a kick is settled over a few seconds.
    v.addAssign(kick.mul(dt).mul(4.2));
    const rest = eddy(H.xyz, t.add(seed.mul(40)), 0.16) as any;
    const toward = rest.sub(x).mul(0.32) as any;
    v.addAssign(toward.sub(v).mul(float(1).sub(exp(dt.mul(-1.1)))));
    // Caught by the echo, a fleck near the surface is drawn onto it for a moment.
    const onto = surf.add(n.mul(other.sub(0.5).mul(0.03))).sub(x).mul(6) as any;
    v.assign(mix(v, onto, min(cling, float(1)).mul(float(1).sub(exp(dt.mul(-9))))));
    const nx = x.add(v.mul(dt)) as any;

    // It tumbles about two axes, each its own way, faster while the wave has it spinning.
    const rate = other.mul(0.9).add(0.25) as any;
    const ta = S.z.add(dt.mul(rate.add(spin))).mod(6.283185 * 64) as any;
    const tb = S.w.add(dt.mul(rate.mul(0.73).add(spin.mul(0.85)))).mod(6.283185 * 64) as any;

    // How it is seen. Dust shows by the light it catches: each of the block's three pairs of faces flashes as it turns
    // to mirror a shaft's light toward the eye, and its faces glow softly as they turn to the light. A glint lights it
    // whatever the shafts do: warm white from the tap's front, cool from the echo.
    const toEye = normalize(u.eye.sub(nx)) as any;
    const toLight = vec3(-AXIS.x, -AXIS.y, -AXIS.z) as any;
    const halfway = normalize(toLight.add(toEye)) as any;
    const ca = cos(ta) as any;
    const sa = sin(ta) as any;
    const cb = cos(tb) as any;
    const sb = sin(tb) as any;
    const faces = [vec3(ca.mul(cb), sa.mul(cb), sb), vec3(sa.negate(), ca, 0), vec3(ca.mul(sb).negate(), sa.mul(sb).negate(), cb)] as any[];
    let flash: any = float(0);
    let face: any = float(0);
    let facingEye: any = float(0);
    for (const fc of faces) {
      flash = max(flash, pow(abs(dot(fc, halfway)), float(48)));
      face = max(face, abs(dot(fc, toLight)));
      facingEye = max(facingEye, pow(abs(dot(fc, toEye)), float(16)));
    }
    const lit = airLight(nx) as any;
    const crumb = (u.dust as any).mul(vec3(1, 0.88, 0.72)).mul(lit.mul(face.mul(0.9).add(0.15).add(flash.mul(3))).mul(1.15).add(0.007)) as any;
    const sparkle = flash.mul(9).add(facingEye.mul(3.5)).add(face.mul(0.5)).add(0.3) as any;
    // Flecks the echo has drawn onto the form glow with it while they cling, so its surface reads as one.
    const held = min(cling, float(1)) as any;
    const glints = (u.warm as any)
      .mul(min(warm, float(1.5)))
      .add((u.cool as any).mul(min(cool, float(1.5)).mul(1.6)))
      .mul(sparkle)
      .add((u.cool as any).mul(held.mul(facingEye.mul(6).add(flash.mul(8)).add(1.2)))) as any;
    const colour = crumb.add(glints).mul(lift) as any;

    // Size: mostly very fine grains, a rare larger chip, never under about half a pixel (dimmer instead), blurred into a
    // soft disc away from the focus as a lens does, never wider than about two degrees.
    const away = length(u.eye.sub(nx)) as any;
    const grain = pow(other, float(7)).mul(0.0055).add(0.0011) as any;
    const px = u.pixel.mul(away) as any;
    const sharp = max(grain, px.mul(0.55)) as any;
    const dim = grain.div(sharp).pow(2) as any;
    const blur = min(abs(away.sub(u.focus)).div(away).mul(0.018), away.mul(0.02)) as any;
    const radius = sharp.add(blur) as any;
    const spread = max(sharp.div(radius).pow(2), float(0.05)) as any;
    const block = float(1).sub(smoothstep(0.3, 2.5, blur.div(px))) as any;
    const narrow = abs(cos(tb)).mul(0.65).add(0.35) as any;

    P.assign(vec4(nx, seed));
    V.assign(vec4(v, spin));
    S.assign(vec4(warm, cool, ta, tb));
    H.assign(vec4(H.xyz, cling));
    shade.element(i).assign(vec4(colour.mul(dim).mul(spread), radius));
    turn.element(i).assign(vec4(ta, narrow, block, 0));
  })().compute(count);

  return { count, pos, shade, turn, u, update };
}

// The colours each palette gives the dust, the tap's glint and the echo's.
export const PALETTES = {
  moon: { label: "Moon", dust: "#ddd0bd", warm: "#fff1d6", cool: "#8fd0ff" },
  ember: { label: "Ember", dust: "#e2c7a8", warm: "#ffc27a", cool: "#5ff0d8" },
  rose: { label: "Rose", dust: "#e0cbc6", warm: "#ffd9c4", cool: "#b48cff" }
} as const;
export type Palette = keyof typeof PALETTES;
