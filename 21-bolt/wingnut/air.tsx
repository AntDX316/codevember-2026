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
import { HOVER } from "./rig";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sun, through a porthole high behind on the left: the key light, the beam in the air and the glow in the void all
// come from here.
export const SUN = new THREE.Vector3(-4.6, 3.3, -2.6);

// The beams: one broad round shaft from the porthole across the middle, where the nut hovers, and fainter, narrower
// ones either side, as if through the gaps of a second window. Each is soft, breathing a little.
const AXIS = SUN.clone().negate().normalize();
const SIDE = new THREE.Vector3().crossVectors(AXIS, new THREE.Vector3(0, 1, 0)).normalize();
const LIFT = new THREE.Vector3().crossVectors(SIDE, AXIS).normalize();
// The main beam's line passes through where the nut hovers: its offset from the sun's line through the origin.
const THROUGH = { across: HOVER.dot(SIDE), up: HOVER.dot(LIFT) };
const BEAMS = [
  { across: THROUGH.across, up: THROUGH.up, width: 0.62, strength: 1, phase: 0 },
  { across: -1.25, up: 0.6, width: 0.24, strength: 0.55, phase: 1.7 },
  { across: 2.3, up: -0.2, width: 0.3, strength: 0.4, phase: 3.1 },
  { across: -2.6, up: -0.7, width: 0.36, strength: 0.32, phase: 4.6 }
].map((beam) => ({ ...beam, from: SUN.clone().addScaledVector(SIDE, beam.across).addScaledVector(LIFT, beam.up) }));

const beamFrom = (k: number) => vec3(BEAMS[k].from.x, BEAMS[k].from.y, BEAMS[k].from.z) as any;
const axisNode = () => vec3(AXIS.x, AXIS.y, AXIS.z) as any;
const breathe = (k: number) => sin(time.mul(0.21).add(BEAMS[k].phase)).mul(0.16).add(0.84) as any;

// How strongly one shaft lights a point: by its distance from the shaft's line, feathered (a core inside a wider
// halo), wavering a little along its length, and fading in from the porthole and out with distance.
function shaftAt(k: number, p: any) {
  const from = beamFrom(k);
  const axis = axisNode();
  const s = dot(p.sub(from), axis) as any;
  const waver = sin(s.mul(1.3).add(time.mul(0.08)).add(BEAMS[k].phase)).mul(0.05) as any;
  const off = length(p.sub(from.add(axis.mul(s))))
    .add(waver)
    .max(0) as any;
  const width = s.mul(0.03).add(BEAMS[k].width) as any;
  const across = off.div(width) as any;
  return exp(across.mul(across).negate().mul(1.9))
    .mul(0.8)
    .add(exp(across.mul(across).negate().mul(0.6)).mul(0.2))
    .mul(smoothstep(0.8, 2.8, s))
    .mul(exp(s.mul(-0.06)))
    .mul(BEAMS[k].strength)
    .mul(breathe(k)) as any;
}

// How lit a point in the air is, by every shaft together.
function airLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < BEAMS.length; k++) sum = sum.add(shaftAt(k, p));
  return sum;
}

// The air's slow stirring, so nothing floats in a straight line.
function eddy(p: any, t: any) {
  const swirl = vec3(sin(p.y.mul(1.6).add(t.mul(0.12)).add(sin(p.z.mul(1.1).sub(t.mul(0.07))))), sin(p.z.mul(1.3).add(t.mul(0.1)).add(sin(p.x.mul(0.9).add(t.mul(0.05))))).mul(0.6), sin(p.x.mul(1.4).sub(t.mul(0.11)).add(sin(p.y.mul(1.2).add(t.mul(0.06)))))).mul(0.12) as any;
  return p.add(swirl) as any;
}

// The light in the air and what floats in it, drawn over the finished frame in the overlay pass and hidden by the
// scene's depth: the shafts, and dust in three kinds (fine specks round the bolt, larger motes, and soft bokeh that
// travels with the eye so there is always something drifting past the lens). Specks glint only where they cross a beam.
export function Air({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const random = lehmer(2121);
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

        // The shafts: for each pixel and shaft, the point where the eye's line passes closest to the shaft's line (short
        // of whatever stands in the way), lit by that shaft there.
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
          const middle = cameraPosition.add(d.mul(stop.min(7).mul(0.6))) as any;
          const stir = mx_noise_float(middle.mul(0.8).add(vec3(time.mul(0.035), time.mul(-0.02), 0)))
            .mul(0.3)
            .add(0.85) as any;
          const along = float(1).sub(smoothstep(0.75, 0.98, abs(b))) as any;
          // In front of the metal the air is only a little deep: keep the beam from washing it out.
          const onSubject = float(1).sub(smoothstep(12, 20, stop)) as any;
          parts.beamMaterial.colorNode = vec4(
            color("#ffd9ae").mul(
              glow
                .mul(along)
                .mul(stir)
                .mul(mix(float(1), float(0.3), onSubject))
                .mul(0.15)
            ),
            1
          ) as any;
          parts.beamMaterial.needsUpdate = true;
        }

        {
          const s = attribute("aSeed", "vec4") as any;
          const t = time as any;
          const size = vec3(8, 5.5, 6) as any;
          const centreOf = vec3(0.3, 0.2, -0.4) as any;
          const drift = vec3(t.mul(0.004), t.mul(0.006), t.mul(-0.003)).mul(s.w.add(0.5)) as any;
          const lens = step(s.w, 0.16) as any;
          const mote = step(0.16, s.w).mul(step(s.w, 0.34)) as any;
          const roomPlace = eddy(
            fract(s.xyz.add(drift.div(size)))
              .sub(0.5)
              .mul(size)
              .add(centreOf),
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
          // Out of focus a speck spreads into a soft disc, never wider than about two degrees.
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
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const light = airLight(centre) as any;
          const lit = mix(light.mul(light).mul(9).add(light.mul(0.6)).add(0.012), light.mul(1.4).add(mix(float(0.04), float(0.3), s.z.mul(s.z))), lens) as any;
          parts.dustMaterial.colorNode = vec4(color("#ffe4c4").mul(lit.mul(twinkle).mul(dot2).mul(shown)), 1) as any;
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

// The void: near black, warming toward the porthole, with the porthole itself far off as a soft out-of-focus disc of
// light, and a faint cool bounce from below and the right, as off a cabin's pale walls.
export function Backdrop() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionWorld) as any;
    const sun = vec3(SUN.x, SUN.y, SUN.z).normalize() as any;
    const toSun = max(dot(d, sun), float(0)) as any;
    const glow = pow(toSun, float(3)).mul(0.5).add(pow(toSun, float(14)).mul(0.6)) as any;
    // The porthole: a round window just off the sun's line, its rim soft as if far out of focus.
    const port = normalize(vec3(-0.62, 0.42, -0.66)) as any;
    const angle = float(1).sub(dot(d, port)) as any;
    const disc = float(1).sub(smoothstep(0.004, 0.0075, angle)) as any;
    const cool = smoothstep(0.2, 0.9, d.x.mul(0.6).sub(d.y.mul(0.5))).mul(0.018) as any;
    const base = vec3(0.006, 0.0055, 0.006) as any;
    m.colorNode = base
      .add(color("#8a5a32").mul(glow.mul(0.12)))
      .add(color("#ffe6c8").mul(disc.mul(1.1)))
      .add(color("#6d7a90").mul(cool)) as any;
    return { material: m, geometry: new THREE.SphereGeometry(45, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}
