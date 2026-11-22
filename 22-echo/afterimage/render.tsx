"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  instancedArray,
  instanceIndex,
  length,
  Loop,
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
  reflect,
  screenUV,
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
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { active, clock, DUST_LIFE, LIFE, shapeAt, SLOTS, slots, spread, swell, voice } from "./blob";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The palette: ink for the blob, pearl for its echoes, and one warm amber where they come apart into dust.
const INK = vec3(0.009, 0.009, 0.013);
const PEARL = vec3(0.86, 0.9, 1);
const AMBER = vec3(1, 0.62, 0.3);
const KEY = vec3(-0.62, 0.58, 0.52).normalize();

// The lens: a pixel's size at a distance of one, and where it is focused, set each frame by the scene.
export const lens = { pixel: uniform(0.001), focus: uniform(7) };
const meshes: Record<string, THREE.Mesh> = {};
if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __afterimageMeshes: meshes });
// ?debug=normals draws the blob's normals as colour, to check they face outward.
const SHOW_NORMALS = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "normals";

// Called with the scene's depth once the overlay pass exists, so what is drawn there hides behind the blob.
function useOverlay(build: (sceneZ: any) => void) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built once; the builder closes over memoised objects.
    []
  );
}

// Pearl sheen: a soft drift between rose, cream and ice by how steeply it is seen, never a full rainbow.
function film(x: any) {
  const w = cos(x.mul(6.283)).mul(0.5).add(0.5) as any;
  const v = cos(x.mul(6.283).add(2.1)).mul(0.5).add(0.5) as any;
  return mix(mix(vec3(1, 0.84, 0.86), vec3(1, 0.93, 0.8), v), vec3(0.8, 0.88, 1), w) as any;
}

// A soft-edged rectangular light in direction `dir`, `w` by `h` across (as tangents), seen along reflected ray r.
function softbox(r: any, dir: THREE.Vector3, w: number, h: number, soft: number) {
  const across = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(across, dir);
  const facing = dot(r, vec3(dir.x, dir.y, dir.z)) as any;
  const a = abs(dot(r, vec3(across.x, across.y, across.z)).div(facing.max(0.05))) as any;
  const b = abs(dot(r, vec3(up.x, up.y, up.z)).div(facing.max(0.05))) as any;
  // Brightest in the middle, as a diffused softbox is.
  const middle = float(1).sub(a.div(w).pow2().add(b.div(h).pow2()).mul(0.3)) as any;
  return float(1).sub(smoothstep(w - soft, w + soft, a)).mul(float(1).sub(smoothstep(h - soft, h + soft, b))).mul(smoothstep(0.05, 0.25, facing)).mul(middle) as any;
}

const KEY_DIR = new THREE.Vector3(-0.62, 0.58, 0.52).normalize();
const BACK_DIR = new THREE.Vector3(0.78, 0.18, -0.6).normalize();
const TOP_DIR = new THREE.Vector3(0.1, 1, 0.15).normalize();

// What the glossy blob reflects: a warm softbox up to one side, a cool strip light behind the other, a dim panel
// overhead, and the dark.
function room(r: any) {
  const box = softbox(r, KEY_DIR, 0.3, 0.46, 0.05).mul(2.4) as any;
  const strip = softbox(r, BACK_DIR, 0.07, 0.9, 0.04).mul(1.7) as any;
  const top = softbox(r, TOP_DIR, 0.8, 0.8, 0.3).mul(0.12) as any;
  const floor = smoothstep(-0.2, 0.6, r.y).mul(0.02).add(0.004) as any;
  return vec3(1, 0.88, 0.74).mul(box).add(vec3(0.6, 0.72, 1).mul(strip)).add(vec3(0.8, 0.85, 1).mul(top)).add(vec3(floor)) as any;
}

// A unit sphere with each vertex shared by its triangles, so the shape is worked out once per point, not six times.
function sphere(detail: number) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute("normal");
  raw.deleteAttribute("uv");
  const shared = mergeVertices(raw, 1e-5);
  raw.dispose();
  return shared;
}

// The blob itself: dark glossy ink with a pearl sheen at its edge, lit from inside while it speaks.
export function Blob({ detail }: { detail: number }) {
  const parts = useMemo(() => {
    const geometry = sphere(detail);
    const material = new THREE.MeshBasicNodeMaterial();
    const n = normalize(positionGeometry) as any;
    const shape = shapeAt(n, clock);
    material.positionNode = n.mul(shape.r.mul(swell.add(1))) as any;
    const bent = varying(shapeAt(normalize(attribute("position", "vec3")), clock).normal) as any;
    const N = normalize(bent) as any;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const ndv = clamp(dot(N, V), 0, 1) as any;
    const fres = pow(float(1).sub(ndv), 4) as any;
    const R = reflect(V.negate(), N) as any;
    const sheen = film(ndv.mul(0.8).add(N.y.mul(0.2))) as any;
    const reflected = room(R).mul(fres.mul(0.9).add(0.07)).mul(sheen) as any;
    // A little warm key light across the ink, wrapped softly round; a pearl haze at the very edge, as on a glazed
    // surface; and a glow from deep inside while the blob speaks.
    const wrap = clamp(dot(N, KEY).add(0.35).div(1.35), 0, 1) as any;
    const diffuse = INK.mul(wrap.mul(2.4).add(0.3)) as any;
    const edgeHaze = sheen.mul(pow(float(1).sub(ndv), 2.2).mul(0.05)) as any;
    const inner = AMBER.mul(pow(ndv, 4).mul(voice).mul(0.1)).add(PEARL.mul(fres.mul(voice).mul(0.35))) as any;
    const lit = diffuse.add(reflected).add(edgeHaze).add(inner) as any;
    material.colorNode = vec4(SHOW_NORMALS ? N.mul(0.5).add(0.5) : lit, 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, [detail]);
  useDispose(parts.geometry, parts.material);
  meshes.blob = parts.mesh;
  return <primitive object={parts.mesh} />;
}

// Where a shell stands for its age: how far it has spread, drifting up a touch, how strong it still is, and where the
// dissolve front has reached (0 whole, 1 gone).
function shellState(slot: any) {
  const age = clock.sub(slot.y) as any;
  const life = age.div(LIFE) as any;
  const fade = smoothstep(0, 0.07, age).mul(pow(float(1).sub(clamp(life, 0, 1)), 1.4)).mul(slot.z) as any;
  const front = mix(float(0.12), float(0.9), clamp(life.sub(0.3).div(0.62), 0, 1)) as any;
  return { age, life, fade, front, scale: spread(age), lift: vec3(0, age.mul(0.05), 0) as any };
}

// Where a direction falls on a shell's dissolve: a soft noise over the sphere, its own for each shell.
function grain(n: any, seed: any) {
  return clamp(mx_noise_float(n.mul(2.1).add(vec3(seed.mul(7.1), seed.mul(3.3), seed.mul(5.7)))).mul(0.62).add(0.5), 0, 1) as any;
}

// The echoes: every slot a ghost of the blob as it was when that call was spoken, spreading, fading, softening at the
// rim and coming apart into dust from the inside of its noise outward.
export function Shells({ detail }: { detail: number }) {
  const parts = useMemo(() => {
    const geometry = sphere(detail);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = SLOTS;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [detail]);
  useDispose(parts.geometry, parts.material);
  meshes.shells = parts.mesh;
  useFrame(() => {
    parts.mesh.count = Math.max(1, active.top);
  });

  useOverlay((sceneZ) => {
    const { material } = parts;
    const place = () => {
      const slot = slots.element(instanceIndex) as any;
      const s = shellState(slot);
      const n = normalize(positionGeometry) as any;
      const alive = step(0.0005, s.fade) as any;
      return n.mul(shapeAt(n, slot.x).r.mul(s.scale).mul(alive)).add(s.lift);
    };
    material.positionNode = place();
    const slot = slots.element(instanceIndex) as any;
    const n = normalize(attribute("position", "vec3")) as any;
    const N = normalize(varying(shapeAt(n, slot.x).normal)) as any;
    const d = varying(grain(n, slot.w)) as any;
    const s = shellState(slot);
    const fade = varying(s.fade) as any;
    const front = varying(s.front) as any;
    const life = varying(s.life) as any;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const ndv = abs(dot(N, V)) as any;
    // Older shells are softer: the rim widens and dims, as an echo blurs.
    const rim = pow(float(1).sub(ndv), mix(float(4.5), float(1.8), life)) as any;
    const whole = smoothstep(front, front.add(0.06), d) as any;
    const edge = float(1).sub(smoothstep(0, 0.05, d.sub(front))).mul(whole).mul(step(0.13, front)) as any;
    const tint = mix(PEARL, film(ndv.mul(0.7).add(life.mul(0.4))), 0.45) as any;
    const light = tint.mul(rim.mul(0.7).add(0.002)).mul(whole).add(AMBER.mul(edge).mul(rim.mul(1.6).add(0.3))) as any;
    material.colorNode = vec4(light.mul(fade).mul(step(sceneZ, positionView.z)), 1) as any;
    material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// The dust each shell sheds as it comes apart: every grain sits on the shell where it is, waits for the dissolve front
// to reach it, then flares and drifts off outward, twinkling as it dims.
export function Dust({ each }: { each: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4127);
    const seeds = new Float32Array(each * 4);
    const v = new THREE.Vector3();
    for (let k = 0; k < each; k++) {
      v.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      while (v.lengthSq() > 1 || v.lengthSq() < 0.01) v.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      v.normalize();
      seeds.set([v.x, v.y, v.z, random()], k * 4);
    }
    const seed = instancedArray(seeds, "vec4") as any;
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(quad, material);
    mesh.count = SLOTS * each;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { seed, quad, material, mesh };
  }, [each]);
  useDispose(parts.quad, parts.material);
  meshes.dust = parts.mesh;
  useFrame(() => {
    parts.mesh.count = Math.max(1, active.top) * each;
  });

  useOverlay((sceneZ) => {
    const grainOf = () => {
      const slot = slots.element(instanceIndex.div(each)) as any;
      const sd = parts.seed.element(instanceIndex.mod(each)) as any;
      const n = sd.xyz as any;
      const s = shellState(slot);
      const d = grain(n, slot.w) as any;
      // When the front passes this grain, and how long since.
      const frontAt = clamp(d.sub(0.12).div(0.78), 0, 1).mul(0.62).add(0.3).mul(LIFE) as any;
      const since = s.age.sub(frontAt) as any;
      const alive = step(0, since).mul(step(since, DUST_LIFE)).mul(step(0.12, d)).mul(slot.z) as any;
      const swirl = vec3(sin(sd.w.mul(41).add(since.mul(1.3))), cos(sd.w.mul(23).add(since.mul(1.1))), sin(sd.w.mul(17).sub(since))).mul(since.mul(0.07)) as any;
      const born = n.mul(shapeAt(n, slot.x).r.mul(spread(frontAt))) as any;
      const centre = born
        .mul(since.mul(0.05).add(1))
        .add(n.mul(since.mul(sd.w.mul(0.22).add(0.08))))
        .add(swirl)
        .add(vec3(0, s.age.mul(0.05).add(since.mul(since).mul(0.025)), 0)) as any;
      return { sd, since, alive, centre };
    };
    const a = grainOf();
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(a.centre)) as any;
    const radius = lens.pixel.mul(away).mul(a.sd.w.mul(2.4).add(1.3)).mul(a.alive) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = grainOf();
    const life = clamp(b.since.div(DUST_LIFE), 0, 1) as any;
    const twinkle = sin(clock.mul(b.sd.w.mul(9).add(5)).add(b.sd.w.mul(60))).mul(0.45).add(0.6) as any;
    const flare = exp(b.since.mul(-4)).mul(3.5).add(0.7) as any;
    const tint = mix(AMBER, PEARL, smoothstep(0, 0.5, life)) as any;
    const light = varying(tint.mul(flare).mul(twinkle).mul(pow(float(1).sub(life), 1.6)).mul(b.alive).mul(1.4)) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const shape = exp(r.mul(r).mul(-5)).sub(exp(float(-5))).max(0) as any;
    parts.material.colorNode = vec4(light.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// The air: fine specks and a few big soft bokeh discs drifting round the blob, dim until a shell passes through them,
// when they catch its light, so each echo shows the dust it travels through.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(5113);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const seed = instancedArray(seeds, "vec4") as any;
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(quad, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { seed, quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useOverlay((sceneZ) => {
    const place = () => {
      const s = parts.seed.element(instanceIndex) as any;
      const t = clock as any;
      const lensNear = step(s.w, 0.1) as any;
      const drift = vec3(t.mul(0.006), t.mul(0.005), t.mul(-0.003)).mul(s.w.add(0.5)) as any;
      const box = 8 as number;
      const far = s.xyz.add(drift.div(box)).fract().sub(0.5).mul(box) as any;
      const near = cameraPosition.add(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4)).fract().sub(0.5).mul(2.4)) as any;
      return { s, centre: mix(far, near, lensNear) as any, lensNear };
    };
    const a = place();
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(a.centre)) as any;
    const sharp = max(float(0.0016), away.mul(0.001)).mul(a.s.y.mul(1.3).add(0.5)) as any;
    const blur = min(abs(away.sub(lens.focus)).div(away).mul(0.04), away.mul(0.03)) as any;
    const radius = sharp.add(blur) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = place();
    const awayB = length(cameraPosition.sub(b.centre)) as any;
    const sharpB = max(float(0.0016), awayB.mul(0.001)).mul(b.s.y.mul(1.3).add(0.5)) as any;
    const blurB = min(abs(awayB.sub(lens.focus)).div(awayB).mul(0.04), awayB.mul(0.03)) as any;
    const spreadOut = pow(sharpB.div(sharpB.add(blurB)), 2).max(0.035) as any;
    // Lit as each shell's front sweeps past: its mean radius, near enough, since the dust is out beyond the lobes.
    const caught = float(0).toVar() as any;
    const dist = length(b.centre) as any;
    Loop(SLOTS, ({ i }: any) => {
      const slot = slots.element(i) as any;
      const st = shellState(slot);
      const front = dist.sub(st.scale.mul(1.18)) as any;
      caught.addAssign(exp(front.mul(front).mul(-22)).mul(st.fade));
    });
    // Brighter on the side the key light comes from, so the air has a direction.
    const side = smoothstep(-0.6, 0.9, dot(normalize(b.centre), KEY)).mul(0.8).add(0.2) as any;
    const twinkle = sin(clock.mul(b.s.y.mul(1.7).add(0.4)).add(b.s.z.mul(40))).mul(0.3).add(0.7) as any;
    const amount = mix(float(1), float(0.14), b.lensNear) as any;
    const tint = mix(vec3(0.7, 0.78, 0.95), vec3(1, 0.84, 0.66), b.s.x) as any;
    const light = tint.mul(caught.mul(1.5).add(side.mul(0.07))).mul(twinkle).mul(amount).mul(spreadOut) as any;
    const colour = varying(light) as any;
    const r = uv().sub(0.5).length() as any;
    const soft = smoothstep(0.004, 0.03, blurB) as any;
    const shape = mix(float(1).sub(smoothstep(0.08, 0.5, r)), float(1).sub(smoothstep(0.38, 0.5, r)), varying(soft)) as any;
    parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// A faint warm glow far behind the blob, off toward the key side, so it floats in air rather than in nothing.
export function Glow() {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(quad, material);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, []);
  useDispose(parts.quad, parts.material);
  useOverlay((sceneZ) => {
    const toEye = normalize(cameraPosition) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const centre = toEye.mul(-7) as any;
    parts.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(34))).add(upward.mul(positionGeometry.y.mul(34))) as any;
    const p = uv().sub(0.5).mul(2) as any;
    const off = p.sub(vec3(-0.2, 0.16, 0).xy) as any;
    const warm = exp(dot(off, off).mul(-9)).mul(0.03) as any;
    const wide = exp(dot(p, p).mul(-3)).mul(0.01) as any;
    const pulse = voice.mul(0.04).add(1) as any;
    const light = vec3(1, 0.78, 0.58).mul(warm).add(vec3(0.45, 0.55, 0.8).mul(wide)).mul(pulse) as any;
    parts.material.colorNode = vec4(light.mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}
