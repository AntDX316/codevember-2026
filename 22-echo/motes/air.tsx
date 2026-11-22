"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cross,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light in the air, as in Erosion: a warm key high on the left pouring in as a few parallel shafts, as if through gaps
// high in an unseen wall, each soft at its edges and breathing a little. Everything that floats is lit by the same
// function, so flecks glint only where they cross a shaft and fall away to near nothing in the dark between. Nothing
// solid stands in the way here, so every shaft runs on through the cloud.
export const KEY = new THREE.Vector3(-4.3, 3.6, 1.5);
export const AXIS = KEY.clone().negate().normalize();
const SIDE = new THREE.Vector3().crossVectors(AXIS, new THREE.Vector3(0, 1, 0)).normalize();
const LIFT = new THREE.Vector3().crossVectors(SIDE, AXIS).normalize();
const BEAMS = [
  { across: 0.15, up: 0.1, width: 0.42, strength: 1, phase: 0 },
  { across: -1.05, up: 0.55, width: 0.22, strength: 0.75, phase: 1.7 },
  { across: 0.95, up: 0.75, width: 0.17, strength: 0.6, phase: 3.1 },
  { across: 1.8, up: -0.3, width: 0.26, strength: 0.5, phase: 4.6 },
  { across: -2.0, up: -0.6, width: 0.3, strength: 0.45, phase: 2.4 }
].map((beam) => ({ ...beam, from: KEY.clone().addScaledVector(SIDE, beam.across).addScaledVector(LIFT, beam.up) }));

const beamFrom = (k: number) => vec3(BEAMS[k].from.x, BEAMS[k].from.y, BEAMS[k].from.z) as any;
const axisNode = () => vec3(AXIS.x, AXIS.y, AXIS.z) as any;
const breathe = (k: number) => sin(time.mul(0.23).add(BEAMS[k].phase)).mul(0.18).add(0.82) as any;

// How strongly one shaft lights a point: by its distance from the shaft's line, and how far down the shaft it lies.
function shaftAt(k: number, p: any) {
  const from = beamFrom(k);
  const axis = axisNode();
  const s = dot(p.sub(from), axis) as any;
  // Its edge wavers a little along its length and in time, so no edge runs ruler-straight.
  const waver = sin(s.mul(1.1).add(time.mul(0.09)).add(BEAMS[k].phase)).mul(0.07) as any;
  const off = length(p.sub(from.add(axis.mul(s))))
    .add(waver)
    .max(0) as any;
  const width = s.mul(0.035).add(BEAMS[k].width) as any;
  // A soft core inside a much wider halo: feathered, with nowhere a line could be drawn.
  const across = off.div(width) as any;
  return exp(across.mul(across).negate().mul(1.9))
    .mul(0.78)
    .add(exp(across.mul(across).negate().mul(0.5)).mul(0.22))
    .mul(smoothstep(0.6, 2.6, s))
    .mul(exp(s.mul(-0.07)))
    .mul(BEAMS[k].strength)
    .mul(breathe(k)) as any;
}

// How lit a point in the air is, by every shaft together.
export function airLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < BEAMS.length; k++) sum = sum.add(shaftAt(k, p));
  return sum;
}

// The air's slow stirring: eddies that turn things over as they pass.
export function eddy(p: any, t: any, amount = 0.11) {
  const swirl = vec3(
    sin(
      p.y
        .mul(1.7)
        .add(t.mul(0.13))
        .add(sin(p.z.mul(1.1).sub(t.mul(0.07))))
    ),
    sin(
      p.z
        .mul(1.3)
        .add(t.mul(0.11))
        .add(sin(p.x.mul(0.9).add(t.mul(0.05))))
    ).mul(0.6),
    sin(
      p.x
        .mul(1.5)
        .sub(t.mul(0.12))
        .add(sin(p.y.mul(1.2).add(t.mul(0.06))))
    )
  ).mul(amount) as any;
  return p.add(swirl) as any;
}

// The shafts seen in the air, and what floats round the cloud: fine specks, larger motes, and big, soft, even discs of
// bokeh drifting past the lens.
export function Air({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4411);
    const seeds = new Float32Array(dust * 4);
    for (let i = 0; i < dust; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const dustMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, dustMaterial, dust);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < dust; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    const sphere = new THREE.SphereGeometry(40, 32, 16);
    const beamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(sphere, beamMaterial);
    beam.frustumCulled = false;
    beam.layers.set(OVERLAY_LAYER);
    return { quad, dustMaterial, specks, sphere, beamMaterial, beam };
  }, [dust]);
  useDispose(parts.quad, parts.dustMaterial, parts.sphere, parts.beamMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;

        // The shafts: for each pixel and each shaft, the closest the eye's line comes to the shaft's line, lit by that
        // shaft there. A slow noise stirs them, as dust does.
        {
          const d = normalize(positionWorld.sub(cameraPosition)) as any;
          const axis = axisNode();
          const b = dot(d, axis) as any;
          const den = max(float(1).sub(b.mul(b)), float(1e-4)) as any;
          const stop = sceneZ.div(normalize(positionView).z) as any;
          let glow: any = float(0);
          for (let k = 0; k < BEAMS.length; k++) {
            const w0 = cameraPosition.sub(beamFrom(k)) as any;
            const tRay = b.mul(dot(axis, w0)).sub(dot(d, w0)).div(den) as any;
            const p = cameraPosition.add(d.mul(tRay.clamp(0, stop))) as any;
            glow = glow.add(shaftAt(k, p));
          }
          const middle = cameraPosition.add(d.mul(stop.min(6).mul(0.6))) as any;
          const stir = mx_noise_float(middle.mul(0.9).add(vec3(time.mul(0.04), time.mul(-0.025), 0)))
            .mul(0.35)
            .add(0.85) as any;
          // Seen along its length a shaft is brightest; keep it soft so its sides never band.
          const along = float(1).sub(smoothstep(0.75, 0.98, abs(b))) as any;
          parts.beamMaterial.colorNode = vec4(color("#ffdcb4").mul(glow.mul(along).mul(stir).mul(0.12)), 1) as any;
          parts.beamMaterial.needsUpdate = true;
        }

        // Floaters. Three kinds by seed: about two thirds fine specks in a box round the cloud; a fifth larger motes in
        // the same box; and the rest in a small box that travels with the eye, so soft bokeh always drifts past the lens.
        {
          const s = attribute("aSeed", "vec4") as any;
          const t = time as any;
          const size = vec3(9, 6, 9) as any;
          const drift = vec3(t.mul(-0.006), t.mul(0.008), t.mul(0.003)).mul(s.w.add(0.5)) as any;
          const lens = step(s.w, 0.18) as any;
          const mote = step(0.18, s.w).mul(step(s.w, 0.36)) as any;
          const roomPlace = eddy(
            fract(s.xyz.add(drift.div(size)))
              .sub(0.5)
              .mul(size),
            t.add(s.y.mul(40))
          ) as any;
          const nearPlace = cameraPosition.add(
            fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4)))
              .sub(0.5)
              .mul(2.4)
          ) as any;
          const centre = mix(roomPlace, nearPlace, lens) as any;
          const toEye = normalize(cameraPosition.sub(centre)) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
          const up = cross(toEye, right) as any;
          const away = cameraPosition.sub(centre).length() as any;
          const grain = mix(float(1), s.x.mul(2.2).add(1.6), mote) as any;
          const sharp = max(float(0.0016), away.mul(0.0007)).mul(grain).mul(s.y.mul(0.8).add(0.6)) as any;
          // Out of focus a speck spreads into a disc, never wider than about two degrees.
          const blur = min(away.sub(focusDistance).abs().div(away).mul(0.05), away.mul(0.034)) as any;
          const radius = sharp.add(blur) as any;
          const spread = sharp.div(radius).pow(2).max(0.035) as any;
          const soft = smoothstep(0.004, 0.03, blur) as any;
          parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
            .mul(0.3)
            .add(0.7) as any;
          const r = uv().sub(0.5).length() as any;
          const point = float(1).sub(smoothstep(0.08, 0.5, r)) as any;
          // An even disc with only a soft edge: a rim would turn bokeh into soap bubbles.
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const light = airLight(centre) as any;
          const lit = mix(light.mul(light).mul(9).add(light.mul(0.6)).add(0.012), light.mul(1.4).add(mix(float(0.04), float(0.3), s.z.mul(s.z))), lens) as any;
          parts.dustMaterial.colorNode = vec4(color("#ffe6cc").mul(lit.mul(twinkle).mul(dot2).mul(shown)), 1) as any;
          parts.dustMaterial.needsUpdate = true;
        }
      }),
    [parts]
  );

  return (
    <>
      <primitive object={parts.beam} />
      <primitive object={parts.specks} />
    </>
  );
}

// The void it floats in: near black, warming to a soft glow behind it on the key's side, darker below.
export function Backdrop() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionWorld) as any;
    const glowDir = normalize(vec3(-0.25, 0.2, -1)) as any;
    const halo = pow(max(dot(d, glowDir), float(0)), float(2.2)) as any;
    const below = smoothstep(0.1, -0.7, d.y) as any;
    const toKey = smoothstep(0.55, -0.6, d.x)
      .mul(smoothstep(-0.6, 0.5, d.y))
      .mul(0.7)
      .add(0.3) as any;
    const base = mix(color("#080707"), color("#1d1915"), halo.mul(toKey)) as any;
    m.colorNode = mix(base, color("#040404"), below.mul(0.8)).mul(mix(float(0.55), float(1), toKey)) as any;
    return { material: m, geometry: new THREE.SphereGeometry(45, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}
