"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cross,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  int,
  length,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { airLight } from "./air";
import { glowColour, type Sand } from "./sand";
import type { Segment } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The stepped leader feels its way down for this long before the return stroke; the glass starts growing then.
export const LEAD = 0.13;

export const strike = {
  // When the bolt began, in the scene's seconds; and where it struck, in the specimen's frame.
  at: uniform(-100),
  root: uniform(new THREE.Vector3(0, 0.66, 0))
};

// How bright the channel is, by seconds since the strike: dim while the leader steps down, a blinding return stroke,
// then two fainter restrikes down the same channel as it dies. The flash on the room follows the same curve.
const bump = (t: number, at: number, width: number) => Math.exp(-(((t - at) / width) ** 2));
export function flashAt(t: number) {
  if (t < 0 || t > 1.2) return 0;
  if (t < LEAD) return 0.12 * (t / LEAD);
  const s = t - LEAD;
  return Math.exp(-s / 0.06) + 0.75 * bump(s, 0.17, 0.025) + 0.45 * bump(s, 0.36, 0.03);
}

// Over the scene, hidden by it where it is in front: each overlay mesh compares its own depth to the frame's.
const listenDepth = (build: (sceneZ: any) => void) =>
  overlayLink.listen((depth) => {
    build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
  });

// The bolt: each segment of the channel a strip turned to the eye, a white core in a violet-blue glow. Every shape is
// built at load; a strike shows one.
export function boltGeometry(segments: Segment[]) {
  const n = segments.length;
  const a = new Float32Array(n * 4 * 3);
  const b = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const meta = new Float32Array(n * 4 * 4);
  const index: number[] = [];
  segments.forEach((s, i) => {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      a.set([s.a.x, s.a.y, s.a.z], v * 3);
      b.set([s.b.x, s.b.y, s.b.z], v * 3);
      corner.set([k >> 1, k & 1 ? 1 : -1], v * 2);
      meta.set([s.order, s.level, s.width, (i * 0.618) % 1], v * 4);
    }
    const o = i * 4;
    index.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(a, 3));
  geometry.setAttribute("aB", new THREE.BufferAttribute(b, 3));
  geometry.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  geometry.setAttribute("aMeta", new THREE.BufferAttribute(meta, 4));
  geometry.setIndex(index);
  return geometry;
}

export function boltMaterial(seconds: any) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const A = attribute("position", "vec3") as any;
  const B = attribute("aB", "vec3") as any;
  const corner = attribute("aCorner", "vec2") as any;
  const meta = attribute("aMeta", "vec4") as any;
  const P = mix(A, B, corner.x) as any;
  const dir = normalize(B.sub(A)) as any;
  const eye = (modelWorldMatrixInverse as any).mul(vec4(cameraPosition, 1)).xyz as any;
  const side = normalize((cross as any)(dir, normalize(eye.sub(P)))) as any;
  const width = meta.z.mul(0.09) as any;
  m.positionNode = P.add(side.mul(corner.y.mul(width))).add(dir.mul(corner.x.mul(2).sub(1).mul(width.mul(0.35)))) as any;

  const t = seconds.sub(strike.at) as any;
  const order = meta.x as any;
  const level = meta.y as any;
  // The leader steps down in jumps; a part shows once the leader has passed it.
  const reach = select(t.lessThan(LEAD), floor14(t.div(LEAD)), float(1.2)) as any;
  const shown = step(order, reach) as any;
  const s = t.sub(LEAD) as any;
  const bumpN = (at: number, w: number) => exp(s.sub(at).div(w).pow(2).negate()) as any;
  const stroke = exp(s.max(0).mul(-1 / 0.06))
    .add(bumpN(0.17, 0.025).mul(0.75))
    .add(bumpN(0.36, 0.03).mul(0.45)) as any;
  const leader = float(0.35).add(sin(t.mul(190).add(meta.w.mul(30))).mul(0.15)) as any;
  const main = select(t.lessThan(LEAD), leader, stroke) as any;
  const life = select(level.greaterThan(0.5), select(t.lessThan(LEAD), leader, stroke.mul(0.45).mul(exp(s.max(0).mul(-6)))), main) as any;
  const alive = step(0, t).mul(step(t, 1.4)) as any;
  const x = varying(corner.y, "vBoltSide") as any;
  const core = exp(x.mul(x).mul(-55)) as any;
  const halo = exp(x.mul(x).mul(-4.5)).mul(0.22) as any;
  const tint = mix(color("#7f8cff"), color("#ffffff"), core) as any;
  m.colorNode = vec4(tint.mul(core.mul(9).add(halo.mul(2))).mul(varying(life.mul(shown).mul(alive), "vBoltLife")), 1) as any;
  return m;
}
// Fourteen steps for the leader's jumps.
const floor14 = (v: any) => v.mul(14).floor().div(14) as any;

// Sparks and spatter thrown up where the bolt hits, white-hot streaks that arc and fall and cool as they go; and a
// flare at the mouth while the sand there is molten.
export function Sparks({ count, seconds }: { count: number; seconds: any }) {
  const parts = useMemo(() => {
    const random = lehmer(9001);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    const flareGeometry = new THREE.PlaneGeometry(1, 1);
    const flareMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const flare = new THREE.Mesh(flareGeometry, flareMaterial);
    flare.frustumCulled = false;
    flare.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh, flareGeometry, flareMaterial, flare };
  }, [count]);
  useDispose(parts.quad, parts.material, parts.flareGeometry, parts.flareMaterial);

  useEffect(
    () =>
      listenDepth((sceneZ) => {
        const s = attribute("aSeed", "vec4") as any;
        const t = seconds.sub(strike.at).sub(LEAD) as any;
        const life = s.w.mul(1.3).add(0.35) as any;
        const age = t.sub(s.x.mul(0.25).mul(s.x)) as any;
        const alive = step(0, age).mul(step(age, life)) as any;
        // Up and out in a wide cone, a few low and fast.
        const a = s.y.mul(6.2832) as any;
        const up = s.z.mul(0.75).add(0.25) as any;
        const out = float(1).sub(up.mul(up)).sqrt() as any;
        const speed = pow(s.x, float(0.5)).mul(3.2).add(0.8) as any;
        const v0 = vec3(out.mul(sin(a)), up, out.mul(sin(a.add(1.5708)))).mul(speed) as any;
        const g = vec3(0, -4.2, 0) as any;
        const local = strike.root.add(v0.mul(age)).add(g.mul(age.mul(age).mul(0.5))) as any;
        const vel = v0.add(g.mul(age)) as any;
        const centre = modelWorldMatrix.mul(vec4(local, 1)).xyz as any;
        const vWorld = modelWorldMatrix.mul(vec4(vel, 0)).xyz as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const along = normalize(vWorld.sub(toEye.mul(vWorld.dot(toEye))).add(vec3(0, 1e-4, 0))) as any;
        const across = normalize(cross(along, toEye)) as any;
        const cool = age.div(life).clamp(0, 1) as any;
        const length2 = length(vWorld).mul(0.022).add(0.006) as any;
        const thick = float(0.0035).mul(float(1).sub(cool.mul(0.6))) as any;
        parts.material.positionNode = centre
          .add(along.mul(positionGeometry.y.mul(length2).mul(alive)))
          .add(across.mul(positionGeometry.x.mul(thick).mul(alive))) as any;
        const q = uv().sub(0.5).mul(2) as any;
        const shape = float(1).sub(smoothstep(0.2, 1, q.x.abs())).mul(float(1).sub(smoothstep(0.5, 1, q.y.abs()))) as any;
        const heat = float(1.6).mul(exp(cool.mul(-2.6))) as any;
        const shown = step(sceneZ, positionView.z) as any;
        parts.material.colorNode = vec4(glowColour(heat).mul(5).mul(shape).mul(alive).mul(shown), 1) as any;
        parts.material.needsUpdate = true;

        // The flare: a soft disc of white-orange light at the mouth, bright in the stroke, then glowing on as melt.
        const root = modelWorldMatrix.mul(vec4(strike.root, 1)).xyz as any;
        const e = normalize(cameraPosition.sub(root)) as any;
        const right = normalize(cross(vec3(0, 1, 0), e)) as any;
        const upv = cross(e, right) as any;
        const stroke = exp(t.max(0).mul(-1 / 0.08)).mul(step(0, t)) as any;
        const melt = exp(t.max(0).mul(-1 / 1.6)).mul(0.5).add(exp(t.max(0).mul(-1 / 9)).mul(0.1)).mul(step(0, t)) as any;
        const size = stroke.mul(1.1).add(0.22) as any;
        parts.flareMaterial.positionNode = root.add(e.mul(0.08)).add(right.mul(positionGeometry.x.mul(size))).add(upv.mul(positionGeometry.y.mul(size))) as any;
        const r = uv().sub(0.5).length().mul(2) as any;
        const disc = exp(r.mul(r).mul(-9)).add(exp(r.mul(-7)).mul(0.25)).mul(float(1).sub(smoothstep(0.85, 1, r))) as any;
        const tint = mix(color("#ff7a26"), color("#fff2de"), stroke.add(melt.mul(0.4)).clamp(0, 1)) as any;
        parts.flareMaterial.colorNode = vec4(tint.mul(disc).mul(stroke.mul(6).add(melt.mul(1.4))), 1) as any;
        parts.flareMaterial.needsUpdate = true;
      }),
    [parts, seconds]
  );
  return (
    <>
      <primitive object={parts.mesh} />
      <primitive object={parts.flare} />
    </>
  );
}

// Grains the wind has taken: fine sand that streams off downwind, catching the key where it crosses a shaft, a few
// larger soft puffs of dust among them, and grains from round the glass still glowing as they fly.
export function Grains({ sand }: { sand: Sand }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = sand.pool;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [sand]);
  useDispose(parts.geometry, parts.material);

  useEffect(
    () =>
      listenDepth((sceneZ) => {
        const m = parts.material;
        const a = sand.grains.element(int(instanceIndex).mul(2)) as any;
        const b = sand.grains.element(int(instanceIndex).mul(2).add(1)) as any;
        const seed = hash(instanceIndex.add(17)) as any;
        const other = fract(seed.mul(91.7).add(0.37)) as any;
        const puff = step(seed, 0.07) as any;
        const age = sand.u.seconds.sub(a.w) as any;
        const life = mix(other.mul(2.2).add(2.2), other.mul(1.5).add(1.6), puff) as any;
        const alive = step(0, age).mul(step(age, life)) as any;
        const t = age.div(life).clamp(0, 1) as any;
        const centre = modelWorldMatrix.mul(vec4(a.xyz, 1)).xyz as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const away = length(cameraPosition.sub(centre)) as any;
        const grain = pow(other, float(4)).mul(0.004).add(0.0016) as any;
        const dust = other.mul(0.05).add(0.025).mul(t.mul(1.6).add(0.4)) as any;
        const sharp = mix(grain, dust, puff) as any;
        const blur = min(away.sub(focusDistance).abs().div(away).mul(0.035), away.mul(0.03)) as any;
        const radius = sharp.add(blur.mul(float(1).sub(puff))).mul(alive) as any;
        const spread = sharp.div(sharp.add(blur.mul(float(1).sub(puff)))).pow(2).max(0.05) as any;
        m.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        const r = uv().sub(0.5).length() as any;
        const disc = mix(float(1).sub(smoothstep(0.25, 0.5, r)), exp(r.mul(r).mul(-14)).mul(float(1).sub(smoothstep(0.42, 0.5, r))), puff) as any;
        const lit = airLight(centre) as any;
        const sandTint = color("#e9d2ae") as any;
        const glint = pow(sin(age.mul(other.mul(14).add(6)).add(seed.mul(40))).mul(0.5).add(0.5), float(8)) as any;
        const shade = sandTint.mul(lit.mul(float(1.1).add(glint.mul(2.5))).add(0.07)) as any;
        const dustShade = sandTint.mul(lit.mul(0.45).add(0.03)).mul(0.22) as any;
        const hot = glowColour(b.w).mul(5) as any;
        const colour = mix(shade, dustShade, puff).add(hot.mul(float(1).sub(puff))) as any;
        const fade = smoothstep(0, 0.04, t).mul(float(1).sub(smoothstep(0.55, 1, t))) as any;
        const shown = step(sceneZ, positionView.z) as any;
        m.colorNode = vec4(colour.mul(disc).mul(spread).mul(fade).mul(shown).mul(alive), 1) as any;
        m.needsUpdate = true;
      }),
    [parts, sand]
  );
  return <primitive object={parts.mesh} />;
}

// One shape of bolt, shown only for the strike that uses it.
export function Bolt({ geometry, material }: { geometry: THREE.BufferGeometry; material: THREE.Material }) {
  const mesh = useMemo(() => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return mesh;
  }, [geometry, material]);
  useDispose(geometry);
  return <primitive object={mesh} />;
}

