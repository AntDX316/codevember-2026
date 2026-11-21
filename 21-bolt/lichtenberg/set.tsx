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
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { CENTRE, FLOOR_ALBEDO, floorLight, HALF, hotGlow, KEY_AT, KEY_DIR, room, u } from "./block";
import { SHADOW_SPAN } from "./figure";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The room: a great sphere, near black, with a faint cool sweep behind the block.
export function Backdrop() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    m.colorNode = vec4(room(normalize(positionWorld.sub(vec3(0, 1, 0)))), 1) as any;
    return { material: m, geometry: new THREE.SphereGeometry(40, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}

// The floor under the block: a dark matte studio floor in a pool of the key's light. The block's own light falls on
// it: clear through the top and bottom faces, bent away (and gathered into a bright line) at its sides, with the
// figures' fine shadows inside, and the blue of a figure still hot.
// `glossy`: a dark polished floor that lets through a little of the block's reflection drawn under it.
export function Floor({ shadow, glossy }: { shadow: THREE.RenderTarget; glossy: boolean }) {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial(glossy ? { transparent: true, depthWrite: true } : {});
    const F = positionWorld as any;
    const H = vec3(HALF.x, HALF.y, HALF.z) as any;
    const o = u.toLocal.mul(vec4(F, 1)).xyz as any;
    const up = u.toLocal.mul(vec4(-KEY_DIR.x, -KEY_DIR.y, -KEY_DIR.z, 0)).xyz as any;
    const safe = vec3(select(abs(up.x).lessThan(1e-4), float(1e-4), up.x), up.y, select(abs(up.z).lessThan(1e-4), float(1e-4), up.z)) as any;
    const t1 = H.negate().sub(o).div(safe) as any;
    const t2 = H.sub(o).div(safe) as any;
    const tmin = min(t1, t2) as any;
    const tmax = max(t1, t2) as any;
    const near = max(tmin.x, max(tmin.y, tmin.z)) as any;
    const far = min(tmax.x, min(tmax.y, tmax.z)) as any;
    const hit = smoothstep(0, 0.004, far.sub(near.max(0))) as any;
    // Through the bottom and out of the top: how far inside the side faces the light ran.
    const bottomFirst = tmin.y.greaterThanEqual(max(tmin.x, tmin.z));
    const topLast = tmax.y.lessThanEqual(min(tmax.x, tmax.z));
    const margin = min(min(tmax.x, tmax.z).sub(tmax.y), tmin.y.sub(max(tmin.x, tmin.z))) as any;
    const straight = select(bottomFirst.and(topLast), float(1), float(0)) as any;
    const line = exp(margin.abs().div(-0.012))
      .mul(0.8)
      .add(exp(margin.abs().div(-0.05)).mul(0.25)) as any;
    const throughBlock = mix(float(0.72).add(exp(far.sub(near).div(-0.03)).mul(0.3)), float(0.94).add(line), straight) as any;
    const light = floorLight(F).mul(mix(float(1), throughBlock, hit)) as any;

    // The figures' shadows, softened a little, from the map drawn each frame from above.
    const uvAt = vec2(F.x.sub(CENTRE.x).div(SHADOW_SPAN).add(0.5), F.z.sub(CENTRE.z).negate().div(SHADOW_SPAN).add(0.5)) as any;
    const map = texture(shadow.texture) as any;
    const step2 = 1.4 / 1024;
    const occ = map
      .sample(uvAt)
      .r.mul(0.4)
      .add(map.sample(uvAt.add(vec2(step2, step2))).r.mul(0.15))
      .add(map.sample(uvAt.add(vec2(-step2, step2))).r.mul(0.15))
      .add(map.sample(uvAt.add(vec2(step2, -step2))).r.mul(0.15))
      .add(map.sample(uvAt.add(vec2(-step2, -step2))).r.mul(0.15)) as any;
    const shaded = light.mul(float(1).sub(occ.min(1).mul(0.75))) as any;
    const lit = color(FLOOR_ALBEDO).mul(shaded.add(0.02)).add(hotGlow(F).mul(0.3)) as any;
    // Far off, the floor sinks into the room behind it as the eye sees it there, so no horizon shows.
    const fade = smoothstep(2.5, 8, length(F.xz)) as any;
    // How much of the reflection under it shows: more at a glance, none far off, where the floor sinks into the room.
    const view = normalize(cameraPosition.sub(F)) as any;
    const sheen = float(1).sub(view.y).pow(3).mul(0.5).add(0.24).mul(float(1).sub(fade)) as any;
    const surface = (mix as any)(
      lit,
      room(normalize(F.sub(cameraPosition))).mul(
        smoothstep(-0.2, 0.05, normalize(F.sub(cameraPosition)).y)
          .mul(0.6)
          .add(0.4)
      ),
      fade
    ) as any;
    m.colorNode = glossy ? (vec4(surface.div(float(1).sub(sheen).max(0.05)), float(1).sub(sheen)) as any) : (vec4(surface, 1) as any);
    return { material: m, geometry: new THREE.CircleGeometry(14, 96) };
  }, [shadow, glossy]);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} />;
}

// The key's light in the air: one broad soft shaft from the soft box overhead, down across the block, with a fainter
// one either side.
const AXIS = KEY_DIR.clone();
const SIDE = new THREE.Vector3().crossVectors(AXIS, new THREE.Vector3(0, 1, 0)).normalize();
const LIFT = new THREE.Vector3().crossVectors(SIDE, AXIS).normalize();
const BEAMS = [
  { across: 0, up: 0, width: 0.55, strength: 1, phase: 0 },
  { across: -1.0, up: 0.35, width: 0.24, strength: 0.45, phase: 1.7 },
  { across: 1.1, up: -0.2, width: 0.3, strength: 0.4, phase: 3.1 }
].map((beam) => ({ ...beam, from: KEY_AT.clone().addScaledVector(SIDE, beam.across).addScaledVector(LIFT, beam.up) }));
const beamFrom = (k: number) => vec3(BEAMS[k].from.x, BEAMS[k].from.y, BEAMS[k].from.z) as any;
const axisNode = () => vec3(AXIS.x, AXIS.y, AXIS.z) as any;

function shaftAt(k: number, p: any) {
  const from = beamFrom(k);
  const axis = axisNode();
  const s = dot(p.sub(from), axis) as any;
  const waver = sin(s.mul(1.3).add(time.mul(0.08)).add(BEAMS[k].phase)).mul(0.05) as any;
  const off = length(p.sub(from.add(axis.mul(s))))
    .add(waver)
    .max(0) as any;
  const width = s.mul(0.06).add(BEAMS[k].width) as any;
  const across = off.div(width) as any;
  const breathe = sin(time.mul(0.21).add(BEAMS[k].phase)).mul(0.15).add(0.85) as any;
  return exp(across.mul(across).negate().mul(1.8))
    .mul(0.8)
    .add(exp(across.mul(across).negate().mul(0.55)).mul(0.2))
    .mul(smoothstep(0.4, 2.0, s))
    .mul(BEAMS[k].strength)
    .mul(breathe) as any;
}

export function airLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < BEAMS.length; k++) sum = sum.add(shaftAt(k, p));
  return sum;
}

// The shafts seen in the air and what floats in them: fine specks round the block that glint only in the light, a few
// larger motes, and big soft bokeh drifting past the lens. Drawn over the finished frame, hidden by the scene's depth.
export function Air({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const random = lehmer(2117);
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
    const sphere = new THREE.SphereGeometry(30, 32, 16);
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
          const along = float(1).sub(smoothstep(0.75, 0.98, abs(b))) as any;
          parts.beamMaterial.colorNode = vec4(color("#e6ecff").mul(glow.mul(along).mul(stir).mul(0.085)), 1) as any;
          parts.beamMaterial.needsUpdate = true;
        }
        {
          const s = attribute("aSeed", "vec4") as any;
          const t = time as any;
          const size = vec3(6, 4, 6) as any;
          const drift = vec3(t.mul(-0.006), t.mul(0.007), t.mul(0.003)).mul(s.w.add(0.5)) as any;
          const lens = step(s.w, 0.16) as any;
          const mote = step(0.16, s.w).mul(step(s.w, 0.34)) as any;
          const swirl = vec3(sin(s.y.mul(40).add(t.mul(0.13))), sin(s.z.mul(31).add(t.mul(0.11))).mul(0.6), sin(s.x.mul(23).sub(t.mul(0.12)))).mul(0.1) as any;
          const roomPlace = fract(s.xyz.add(drift.div(size)))
            .sub(0.5)
            .mul(size)
            .add(vec3(CENTRE.x, CENTRE.y + 0.6, CENTRE.z))
            .add(swirl) as any;
          const nearPlace = cameraPosition.add(
            fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4)))
              .sub(0.5)
              .mul(2.4)
          ) as any;
          const centre = mix(roomPlace, nearPlace, lens) as any;
          const toEye = normalize(cameraPosition.sub(centre)) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
          const upward = cross(toEye, right) as any;
          const away = cameraPosition.sub(centre).length() as any;
          const grain = mix(float(1), s.x.mul(2.2).add(1.6), mote) as any;
          const sharp = max(float(0.0014), away.mul(0.0006)).mul(grain).mul(s.y.mul(0.8).add(0.6)) as any;
          const blur = min(away.sub(focusDistance).abs().div(away).mul(0.05), away.mul(0.034)) as any;
          const radius = sharp.add(blur) as any;
          const spread = sharp.div(radius).pow(2).max(0.035) as any;
          const soft = smoothstep(0.004, 0.03, blur) as any;
          parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
            .mul(0.3)
            .add(0.7) as any;
          const r = uv().sub(0.5).length() as any;
          const point = float(1).sub(smoothstep(0.08, 0.5, r)) as any;
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const light = airLight(centre) as any;
          // A spark of a hot figure lights the motes near it too.
          const hot = hotGlow(centre) as any;
          const lit = mix(light.mul(light).mul(7).add(light.mul(0.5)).add(0.01), light.mul(1.1).add(mix(float(0.03), float(0.22), s.z.mul(s.z))), lens) as any;
          parts.dustMaterial.colorNode = vec4(color("#eef2ff").mul(lit).add(hot.mul(0.6)).mul(twinkle).mul(dot2).mul(shown), 1) as any;
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

// The point of contact: a hot star where a charge builds under a held press and flashes as it strikes.
export function Spark() {
  const { mesh, material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const at = u.spark.xyz as any;
    const strength = u.spark.w as any;
    const toEye = normalize(cameraPosition.sub(at)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const size = strength.sqrt().mul(0.22).add(0.02) as any;
    m.positionNode = at
      .add(toEye.mul(0.02))
      .add(right.mul(positionGeometry.x.mul(size)))
      .add(upward.mul(positionGeometry.y.mul(size))) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const core = exp(r.mul(r).mul(-60)) as any;
    const halo = exp(r.mul(-5)).mul(float(1).sub(smoothstep(0.7, 1, r))) as any;
    const rays = abs(sin(time.mul(23).add(uv().x.mul(9))))
      .mul(0.3)
      .add(0.7) as any;
    m.colorNode = vec4(
      u.hotColour
        .mul(halo.mul(0.9).mul(rays))
        .add(color("#ffffff").mul(core.mul(3)))
        .mul(strength),
      1
    ) as any;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, m);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material: m, geometry };
  }, []);
  useDispose(material, geometry);
  return <primitive object={mesh} />;
}
