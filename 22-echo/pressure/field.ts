import * as THREE from "three/webgpu";
import { abs, clamp, If, cos, dot, float, Fn, instancedArray, instanceIndex, length, max, min, mix, normalize, sin, smoothstep, uniform, vec3, vec4 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";
import { CORE, type Shape } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A ball of fine dust round the hidden core, every grain on the GPU. A sound wave is a travelling push: each grain is moved
// along the wave by the signal that reaches it at its true travel time, and let go again once it has passed, so the dust
// itself bunches into bright shells of compression and thins into dark ones of rarefaction. Where a wave meets the core it
// is thrown back, and the echo spreads out from the core's own surface, its shells carrying the core's shape.

// How fast sound travels in the dust, in world units a second. At a pitch of F beats a second, one band of compression
// leaves every SPEED / F.
export const SPEED = 0.95;
// Up to this many sounds at once, each with its echo.
export const SLOTS = 10;
// How far the nebula reaches.
const BALL = 2.05;
// Roughly how far the core reaches, for its shadow.
const CORE_HALF = CORE * 0.9;

export const COUNTS: Record<QualityTier, number> = { high: 440000, medium: 270000, low: 110000 };

// Grains thick round the core and thinning to the edge, gathered into soft clouds and lanes by a few crossing waves, so
// the ball has structure rather than a flat fog. A few drift far out, past the lens, as bokeh.
function scatter(count: number, random: () => number) {
  const home = new Float32Array(count * 4);
  const far = Math.floor(count * 0.012);
  let made = 0;
  while (made < count - far) {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const z = random() * 2 - 1;
    const l = Math.hypot(x, y, z);
    if (l > 1 || l < 1e-3) continue;
    const r = Math.pow(random(), 0.6) * BALL;
    const px = (x / l) * r;
    const py = (y / l) * r * 0.92;
    const pz = (z / l) * r;
    const lanes =
      Math.sin(px * 2.3 + 1.3) * Math.sin(py * 2.9 + 0.4) * Math.sin(pz * 2.1 + 2) +
      0.55 * Math.sin(px * 5.1 - pz * 4.3 + py * 1.7 + 1) * Math.sin(py * 4.7 + pz * 2.2) +
      0.25 * Math.sin(px * 11.3 + py * 9.1) * Math.sin(pz * 10.7 - px * 3.3);
    const edge = Math.exp(-Math.pow(Math.max(0, r - 1.1) / 0.62, 2));
    const keep = edge * (0.1 + 0.9 * Math.min(1, Math.max(0, 0.5 + lanes * 0.9)));
    if (random() > keep) continue;
    home.set([px, py, pz, random()], made++ * 4);
  }
  for (; made < count; made++) {
    const a = random() * Math.PI * 2;
    const z = random() * 2 - 1;
    const ring = Math.sqrt(1 - z * z);
    const r = 2.4 + random() * 4.6;
    home.set([Math.cos(a) * ring * r, z * r * 0.6, Math.sin(a) * ring * r, random()], made * 4);
  }
  return home;
}

export type Field = ReturnType<typeof createField>;

export function createField(shape: Shape, tier: QualityTier) {
  const count = COUNTS[tier];
  // Fewer grains each glow brighter, so the ball reads the same at every tier.
  const gain = Math.pow(COUNTS.high / count, 0.75);
  const homes = instancedArray(scatter(count, lehmer(22091)), "vec4") as any;
  const pos = instancedArray(count, "vec4") as any;
  const shade = instancedArray(count, "vec4") as any;

  const u = {
    now: uniform(0),
    spin: uniform(0),
    eye: uniform(new THREE.Vector3(0, 0, 6)),
    pixel: uniform(0.0005),
    focus: uniform(6),
    dust: uniform(new THREE.Color("#ffe2c4")),
    hot: uniform(new THREE.Color("#fff6ea")),
    echo: uniform(new THREE.Color("#6fb6ff")),
    // Each sound: where it starts and when (xyz, w), and its strength, how long it sounds, how far it travels before it
    // meets the core and its pitch (x, y, z, w; strength 0 for an empty slot).
    at: Array.from({ length: SLOTS }, () => uniform(new THREE.Vector4(0, 0, 0, -100))),
    info: Array.from({ length: SLOTS }, () => uniform(new THREE.Vector4(0, 0.3, 1, 3))),
    camRight: uniform(new THREE.Vector3(1, 0, 0)),
    camUp: uniform(new THREE.Vector3(0, 1, 0))
  };

  const coreRadius = shape.radiusNode;
  const TAU = Math.PI * 2;
  // A sound's signal, a time after it reaches a point: a few cycles of a sine, eased in and out.
  const envelope = (t: any, lasts: any) => smoothstep(0, 0.07, t).mul(float(1).sub(smoothstep(lasts, lasts.add(0.1), t))) as any;

  const update = Fn(() => {
    const i = instanceIndex;
    const h = homes.element(i) as any;
    const seed = h.w as any;
    // The whole ball turns very slowly, and every grain wanders its own small loop.
    const c = cos(u.spin) as any;
    const s = sin(u.spin) as any;
    const turned = vec3(h.x.mul(c).add(h.z.mul(s)), h.y, h.z.mul(c).sub(h.x.mul(s))) as any;
    const q = turned.mul(1.6).add(seed.mul(17)) as any;
    const w = u.now.mul(0.16) as any;
    const wander = vec3(
      sin(q.y.add(w.mul(1.1)).add(seed.mul(6.3))).add(sin(q.z.mul(2.3).sub(w.mul(1.7))).mul(0.5)),
      sin(q.z.add(w.mul(0.9)).add(seed.mul(3.1))).add(sin(q.x.mul(2.1).add(w.mul(1.3))).mul(0.5)),
      sin(q.x.sub(w).add(seed.mul(4.7))).add(sin(q.y.mul(1.9).sub(w.mul(1.5))).mul(0.5))
    ) as any;
    const rest = turned.add(wander.mul(0.045)).toVar() as any;
    const out = length(rest).max(1e-4).toVar() as any;
    const dir = rest.div(out).toVar() as any;
    const surface = coreRadius(dir).toVar() as any;
    // How far out from the core this grain sits, measured so that the echo's shells keep the core's shape as they spread.
    const fromCore = out.sub(surface).div(surface.div(CORE).mul(0.8).add(0.2)).max(0).toVar() as any;

    const push = vec3(0).toVar() as any;
    const squeeze = float(0).toVar() as any;
    const echoed = float(0).toVar() as any;
    for (let k = 0; k < SLOTS; k++) {
      const at = u.at[k] as any;
      const info = u.info[k] as any;
      const strength = info.x as any;
      const lasts = info.y as any;
      const reach = info.z as any;
      // Only sounds still out in the dust are worked out; every grain takes the same branch.
      If(strength.greaterThan(0).and(u.now.sub(at.w).lessThan(lasts.add(7))), () => {
        const rel = rest.sub(at.xyz) as any;
        const d = length(rel).max(1e-4) as any;
        const t = u.now.sub(at.w).sub(d.div(SPEED)) as any;
        // Behind the core lies its shadow: what passes close by its middle on the way is mostly stopped.
        const along = clamp(dot(at.xyz.negate(), rel).div(d.mul(d)), 0, 1) as any;
        const miss = length(at.xyz.add(rel.mul(along))) as any;
        const shadow = smoothstep(CORE_HALF, CORE_HALF * 2.6, miss).mul(0.8).add(0.2) as any;
        const fade = strength.div(d.mul(0.5).add(1)).mul(shadow) as any;
        const phase = t.mul(info.w).mul(TAU) as any;
        const env = envelope(t, lasts) as any;
        push.addAssign(rel.div(d).mul(sin(phase).mul(env).mul(fade).mul(0.09)));
        squeeze.addAssign(cos(phase).mul(env).mul(fade));
        // The echo leaves the core when the sound first reaches it, strongest back toward where it came from.
        const te = u.now.sub(at.w).sub(reach.add(fromCore).div(SPEED)) as any;
        const back = smoothstep(-0.6, 0.9, dot(dir, normalize(at.xyz))).mul(0.75).add(0.25) as any;
        const efade = strength.mul(1.25).div(reach.mul(0.5).add(1)).div(fromCore.mul(0.55).add(1)).mul(back) as any;
        const ephase = te.mul(info.w).mul(TAU) as any;
        const eenv = envelope(te, lasts) as any;
        push.addAssign(dir.mul(sin(ephase).mul(eenv).mul(efade).mul(0.09)));
        echoed.addAssign(cos(ephase).mul(eenv).mul(efade));
      });
    }

    const p = rest.add(push) as any;
    // Grains right against the core fade, so it stays a shadow among them rather than a lit shell.
    const clear = smoothstep(0.0, 0.08, out.sub(surface)) as any;

    const toEye = u.eye.sub(p) as any;
    const away = length(toEye) as any;
    const glint = seed.mul(13.7).fract() as any;
    const big = seed.mul(7.31).fract() as any;
    const near = smoothstep(0.6, 3, away).mul(0.8).add(0.2) as any;
    // Light falls on the ball from the upper left; the far side sinks into shadow.
    const key = smoothstep(-0.75, 0.85, dot(dir, vec3(-0.62, 0.55, 0.42).normalize())).mul(0.75).add(0.4) as any;
    // Compression is bright and a touch whiter, rarefaction dark; the echo's compression glows cool.
    const pressed = max(squeeze, 0) as any;
    const ringing = max(echoed, 0) as any;
    const thinned = max(squeeze.negate(), 0).add(max(echoed.negate(), 0).mul(0.8)) as any;
    const lit = float(1).add(pressed.pow(1.5).mul(9)).div(thinned.mul(3).add(1)) as any;
    const warm = mix(u.dust, u.hot, min(pressed, 1)) as any;
    const colour = warm
      .mul(lit)
      .add(u.echo.mul(ringing.pow(1.5).mul(11)))
      .mul(glint.mul(1.3).add(0.35))
      .mul(0.07 * gain)
      .mul(clear)
      .mul(near)
      .mul(key) as any;

    // Its size on screen: a fine grain, never under about half a pixel (dimmer instead), and spread into a soft disc the
    // further it is from the focus, as a lens does, never wider than about two degrees.
    const grain = float(0.0042).mul(big.pow(8).mul(2.6).add(0.55)).mul(min(pressed.add(ringing), 1.5).mul(0.35).add(1)) as any;
    const px = u.pixel.mul(away) as any;
    const sharp = max(grain, px.mul(0.55)) as any;
    const dim = grain.div(sharp).pow(2) as any;
    const blur = min(abs(away.sub(u.focus)).div(away).mul(0.016), away.mul(0.022)) as any;
    const radius = sharp.add(blur) as any;
    const spread = max(sharp.div(radius).pow(2), float(0.02)) as any;
    const soft = smoothstep(0.4, 2.5, blur.div(px)) as any;

    pos.element(i).assign(vec4(p, soft));
    shade.element(i).assign(vec4(colour.mul(dim).mul(spread), radius));
  })().compute(count);

  return { count, pos, shade, u, update };
}
