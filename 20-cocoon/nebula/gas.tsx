"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  Break,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  If,
  interleavedGradientNoise,
  length,
  Loop,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  texture3D,
  uniform,
  uniformArray,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import { nebulaNoise } from "./noise";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The box the gas lives in: an ellipsoid round the origin, a little taller than wide, that holds the egg and its wisps.
export const BOUNDS = new THREE.Vector3(1.32, 1.8, 1.32);
// How many hand pushes the gas remembers at once, each a dent with a swirl round it that heals over a few seconds.
export const MAX_PUSHES = 8;
// How fast a heartbeat's shock front runs out through the gas, in units a second.
export const SHOCK_SPEED = 1.5;

// Everything the shader reads, eased or written from the scene each frame.
export function makeNebula() {
  return {
    time: uniform(0),
    frame: uniform(0),
    // The gas turning slowly round its axis, as cosine and sine, and the drift that carries the warp through the noise.
    spin: uniform(new THREE.Vector2(1, 0)),
    drift: uniform(new THREE.Vector3()),
    density: uniform(1),
    // The star's steady power with its breath, and how much brighter a heartbeat has made it for now.
    star: uniform(9),
    flare: uniform(1),
    // Seconds since the two beats of the last heartbeat (lub, dub) and how strong each was.
    beat: uniform(new THREE.Vector4(99, 99, 0, 0)),
    inner: uniform(new THREE.Color()),
    outer: uniform(new THREE.Color()),
    scatter: uniform(new THREE.Color()),
    starColour: uniform(new THREE.Color()),
    ring: uniform(new THREE.Color()),
    // Each push: where (xyz) and how strong now (w); and which way the gas was carried (xyz) and how wide (w).
    pushes: uniformArray(
      Array.from({ length: MAX_PUSHES }, () => new THREE.Vector4(0, 0, 0, 0)),
      "vec4"
    ),
    flows: uniformArray(
      Array.from({ length: MAX_PUSHES }, () => new THREE.Vector4(0, 0, 0, 0.3)),
      "vec4"
    )
  };
}
export type Nebula = ReturnType<typeof makeNebula>;

// A shock front: a thin bright shell at the distance the beat has run, fading as it goes.
export const shockAt = (n: Nebula, radius: any) => {
  const b = n.beat as any;
  const one = (age: any, strength: any) => {
    const off = radius.sub(age.mul(SHOCK_SPEED)).div(0.1) as any;
    return exp(off.mul(off).negate()).mul(exp(age.mul(-1.3))).mul(strength).mul(age.greaterThan(0).select(float(1), float(0)));
  };
  return one(b.x, b.z).add(one(b.y, b.w));
};

const STEPS: Record<QualityTier, number> = { low: 22, medium: 32, high: 44 };

// The cloud, drawn by marching each pixel's ray through the ellipsoid: glowing gas and dark dust that block and give off
// light, and the star's own light scattered toward the eye by whatever it reaches through the gas between.
//
// Drawn over what is behind it as a premultiplied colour with its own cover, so stars show through the thin parts. It
// writes a depth where it is dense enough to read as a thing, the middle of the cloud along the ray, so the lens blur
// keeps it sharp and leaves the empty sky to go soft as before.
export function Gas({ nebula, tier }: { nebula: Nebula; tier: QualityTier }) {
  const material = useMemo(() => {
    const n = nebula as any;
    const noise = nebulaNoise();
    const steps = STEPS[tier];
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: true, fog: false });
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    const turn = (p: any) => vec3(p.x.mul(n.spin.x).sub(p.z.mul(n.spin.y)), p.y, p.x.mul(n.spin.y).add(p.z.mul(n.spin.x)));
    // How far out through the egg a point lies: 1 at its skin. Squashed in height and narrowed toward the top, so it is
    // broad below and rounds to a blunt point above.
    const eggOf = (p: any) => length(vec3(p.x, p.y.mul(0.8), p.z).mul(p.y.mul(0.06).add(1))).div(0.95);

    // Both functions below are inlined rather than given a layout: three reuses a layout function's code from a shader's
    // first build, with its uniforms named in that build's order, and the push arrays read only in here went missing.
    // The gas at a point: x the glowing gas, y the dust, z how far out (with its ragged edge), w how much is filament.
    const field = Fn(([p]: any[]) => {
      // The hand's pushes: each carries the gas along the way it moved and twists it round that way, and thins it.
      const at = p.toVar() as any;
      const dent = float(1).toVar() as any;
      Loop(MAX_PUSHES, ({ i }: any) => {
        const push = n.pushes.element(i) as any;
        const flow = n.flows.element(i) as any;
        const d = p.sub(push.xyz).toVar() as any;
        const f = push.w.mul(exp(dot(d, d).div(flow.w.mul(flow.w)).negate())).toVar() as any;
        at.subAssign(flow.xyz.mul(f));
        at.addAssign(cross(flow.xyz, d).mul(f).mul(2.4));
        dent.mulAssign(float(1).sub(f.mul(0.7)));
      });
      // A heartbeat's front shoves the gas outward as it passes.
      const r = length(p) as any;
      at.subAssign(p.div(r.add(0.001)).mul(shockAt(nebula, r)).mul(0.09));

      const q0 = turn(at).toVar() as any;
      // Domain warp: the noise read through a slowly drifting field of offsets, so the shapes churn and fold over time.
      const warp = (texture3D(noise, q0.mul(0.21).add(n.drift)) as any).rba.sub(0.5) as any;
      const q = q0.add(warp.mul(0.9)).toVar() as any;
      const big = texture3D(noise, q.mul(0.43)) as any;
      const fine = texture3D(noise, q.mul(1.25).sub(n.drift.mul(2))) as any;
      const s = eggOf(at).add(big.r.sub(0.5).mul(0.42)).add(fine.g.sub(0.5).mul(0.16)).toVar() as any;
      // A shell: thin at its ragged outer edge, and hollowed out round the star, whose wind has blown a cavity.
      const shell = smoothstep(1.0, 0.7, s).mul(smoothstep(0.16, 0.55, s)) as any;
      // Filaments where the large noise crosses its middle: folded into sharp ridges.
      const ridge = float(1).sub(abs(big.r.mul(2).sub(1))) as any;
      const filament = pow(ridge, float(5)) as any;
      const gas = shell.mul(fine.g.mul(0.5).add(filament.mul(1.5)).add(0.1)).mul(dent) as any;
      // Dark lanes of dust, through the outer shell only.
      const dust = smoothstep(0.5, 0.74, big.a).mul(smoothstep(0.2, 0.6, fine.b)).mul(smoothstep(1.0, 0.75, s)).mul(smoothstep(0.4, 0.72, s)).mul(dent) as any;
      return vec4(gas, dust, s, filament);
    }) as any;

    // A coarse take on the same, for the light's way in from the star: no warp, no fine detail, as dimming only.
    const thin = Fn(([p]: any[]) => {
      const big = texture3D(noise, turn(p).mul(0.43)) as any;
      const s = eggOf(p).add(big.r.sub(0.5).mul(0.42)) as any;
      const shell = smoothstep(1.0, 0.7, s).mul(smoothstep(0.16, 0.55, s)) as any;
      const ridge = float(1).sub(abs(big.r.mul(2).sub(1))) as any;
      const gas = shell.mul(ridge.mul(ridge).mul(0.7).add(0.3)) as any;
      const dust = smoothstep(0.5, 0.74, big.a).mul(smoothstep(0.4, 0.72, s)).mul(smoothstep(1.0, 0.75, s)).mul(0.5) as any;
      return gas.mul(2).add(dust.mul(10)).mul(n.density);
    }) as any;

    const run = Fn(() => {
      const ro = cameraPosition as any;
      const rd = normalize(positionWorld.sub(cameraPosition)).toVar() as any;
      // Where the ray enters and leaves the ellipsoid.
      const o = ro.div(BOUNDS) as any;
      const d = rd.div(BOUNDS) as any;
      const a = dot(d, d) as any;
      const b = dot(o, d) as any;
      const root = sqrt(max(b.mul(b).sub(a.mul(dot(o, o).sub(1))), float(0))) as any;
      const enter = max(b.negate().sub(root).div(a), float(0)).toVar() as any;
      const leave = b.negate().add(root).div(a).toVar() as any;
      const step = max(leave.sub(enter), float(0)).div(steps).toVar() as any;
      // Each pixel starts its steps somewhere of its own, moved on every frame, so the banding becomes fine noise that
      // the temporal pass averages away.
      const jitter = fract(interleavedGradientNoise(screenCoordinate.xy).add(n.frame.mul(0.618034))) as any;
      // How near the ray passes the star, for its core.
      const closest = dot(ro, rd).negate().toVar() as any;
      const impact = max(dot(ro, ro).sub(closest.mul(closest)), float(0)).toVar() as any;

      const light = vec3(0).toVar() as any;
      const through = float(1).toVar() as any;
      const before = float(1).toVar() as any;
      const shadowTaps = tier === "low" ? 1 : 2;

      Loop(steps, ({ i }: any) => {
        If(through.lessThan(0.015), () => {
          Break();
        });
        const t = enter.add(step.mul(float(i).add(jitter))).toVar() as any;
        const p = ro.add(rd.mul(t)).toVar() as any;
        If(t.lessThan(closest), () => {
          before.assign(through);
        });
        const here = field(p).toVar() as any;
        const gas = here.x.mul(n.density).toVar() as any;
        const dust = here.y.mul(n.density).toVar() as any;
        If(gas.add(dust).greaterThan(0.002), () => {
          const r = length(p).toVar() as any;
          const out = p.div(r.add(0.0001)) as any;
          // The light's way in from the star: a tap or two of the coarse gas between, as optical depth.
          const depthIn = (shadowTaps === 1 ? thin(p.mul(0.5)).mul(r) : thin(p.mul(0.62)).add(thin(p.mul(0.28))).mul(r).mul(0.5)) as any;
          // Henyey–Greenstein, leaning forward: the gas is brightest seen against the star.
          const cosine = dot(out, rd) as any;
          const phase = float(1 - 0.35 * 0.35).div(pow(float(1 + 0.35 * 0.35).sub(cosine.mul(0.7)), float(1.5))) as any;
          const starlit = n.starColour.mul(n.star).mul(n.flare.sub(1).mul(0.3).add(1)).mul(exp(depthIn.negate())).mul(phase).div(r.mul(r).mul(4).add(0.15)) as any;
          const hue = mix(n.inner, n.outer, smoothstep(0.35, 0.85, here.z)) as any;
          const emission = hue.mul(gas).mul(here.w.mul(2.4).add(0.3)).mul(1.1) as any;
          const scattered = starlit.mul(mix(vec3(1), hue, 0.75).mul(gas.mul(0.45)).add(n.scatter.mul(dust.mul(0.9)))) as any;
          const shock = n.ring.mul(shockAt(nebula, r)).mul(gas.mul(9).add(dust.mul(2)).add(0.02)) as any;
          const sigma = gas.mul(2).add(dust.mul(10)) as any;
          const fade = exp(sigma.mul(step).negate()).toVar() as any;
          // Exact for light given off evenly through the step, so it does not depend on how many steps there are.
          light.addAssign(emission.add(scattered).add(shock).mul(through).mul(float(1).sub(fade).div(max(sigma, float(0.0001)))));
          through.mulAssign(fade);
        });
      });

      // The star itself, seen through whatever gas lies in front of it: a tiny hot core and a soft halo.
      // The halo is gone well inside the ellipsoid, so its edge never shows. Seen through the gas, but never quite lost.
      const halo = float(0.012).div(impact.add(0.012)).mul(0.05).mul(smoothstep(0.5, 0.05, impact)) as any;
      const core = float(0.00025).div(impact.add(0.00025)).mul(0.35).add(halo) as any;
      const white = mix(n.starColour, vec3(1), 0.55) as any;
      light.addAssign(white.mul(core).mul(n.star).mul(n.flare).mul(sqrt(before)).mul(closest.greaterThan(0).select(float(1), float(0))));
      return vec4(light, float(1).sub(through));
    });

    const result = run().toVar("nebulaTrace") as any;
    // The middle of the cloud along the ray, as a depth, where there is enough gas to be seen.
    const rd = normalize(positionWorld.sub(cameraPosition)) as any;
    const middle = cameraPosition.add(rd.mul(max(dot(cameraPosition, rd).negate(), float(0.05)))) as any;
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(middle, 1)) as any;
    m.depthNode = select(result.w.greaterThan(0.05), clamp(clip.z.div(clip.w), 0, 0.9999), float(1)) as any;
    m.colorNode = result.xyz as any;
    m.opacityNode = result.w as any;
    return m;
  }, [nebula, tier]);
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 48, 32), []);
  useDispose(material, geometry);

  return <mesh geometry={geometry} material={material} scale={BOUNDS} renderOrder={1} frustumCulled={false} raycast={() => null} />;
}
