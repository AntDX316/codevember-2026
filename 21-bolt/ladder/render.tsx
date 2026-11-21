"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cos,
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
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uniformArray,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { POINTS, type Arc } from "./arc";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light in the room besides the arc: a cold window high on the left, its shaft faint in the haze.
export const KEY = new THREE.Vector3(-2.3, 2.7, 0.7);
const KEY_TARGET = new THREE.Vector3(0.1, 0.45, -0.1);

// The arc as a handful of glowing points, for everything lit by it through the air: the haze, the smoke, the dust.
export const GLOW = 8;
export const glowPoints = uniformArray(
  Array.from({ length: GLOW }, () => new THREE.Vector4()),
  "vec4"
);
// The arc's colour of light, which shifts from white-hot toward violet as it stretches thin.
export const arcTint = uniform(new THREE.Color("#c9bcff"));
// How thick the workshop air is.
export const haziness = uniform(1);

// The arc's light at a point in the air: each glowing point by the inverse square of its distance, softened at the core.
export function arcLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < GLOW; k++) {
    const c = glowPoints.element(k) as any;
    const d = p.sub(c.xyz) as any;
    sum = sum.add(c.w.div(dot(d, d).add(0.0012)));
  }
  return sum;
}

// The window's shaft: by how far a point lies from its line, soft-edged and widening as it comes in.
const AXIS = KEY_TARGET.clone().sub(KEY).normalize();
function shaft(p: any) {
  const from = vec3(KEY.x, KEY.y, KEY.z) as any;
  const axis = vec3(AXIS.x, AXIS.y, AXIS.z) as any;
  const s = dot(p.sub(from), axis) as any;
  const off = length(p.sub(from.add(axis.mul(s)))) as any;
  const across = off.div(s.mul(0.09).add(0.22)) as any;
  return exp(across.mul(across).negate().mul(1.6))
    .mul(smoothstep(0.8, 2.2, s))
    .mul(exp(s.mul(-0.12))) as any;
}

// Everything the overlay pass draws needs the scene's depth, to hide behind what is solid.
const sceneDepthZ = (depth: any) => perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;

// ---------------------------------------------------------------------------------------------------------------------
// The arc itself: camera-facing ribbons along the live arc, along the ghost of the last one rising as hot air, and along
// the spark that jumps to a hand held near it. Each is a thin white-hot core inside a broad violet glow.

const SAMPLES = 160;
const ZAP = 30;
const STRIPS = [SAMPLES, SAMPLES, ZAP];

export const ribbon = {
  eye: uniform(new THREE.Vector3()),
  // The size of a pixel one metre from the eye.
  pixel: uniform(0.001),
  core: uniform(0.0016),
  glow: uniform(0.02),
  live: uniform(0),
  ghost: uniform(0),
  zap: uniform(0)
};

export function createRibbon() {
  const verts = STRIPS.reduce((sum, n) => sum + n * 4, 0);
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const tangent = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const info = new Float32Array(verts * 4);
  const index: number[] = [];
  // Where each strip's samples start, in vertices; each sample has four: core left, core right, glow left, glow right.
  const starts: number[] = [];
  let v = 0;
  STRIPS.forEach((n, strip) => {
    starts.push(v);
    for (let i = 0; i < n; i++) {
      const along = i / (n - 1);
      for (let band = 0; band < 2; band++)
        for (const side of [-1, 1]) {
          info.set([side, band, strip, along], (v + i * 4 + band * 2 + (side > 0 ? 1 : 0)) * 4);
        }
      if (i < n - 1) {
        for (let band = 0; band < 2; band++) {
          const a = v + i * 4 + band * 2;
          const b = a + 4;
          index.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    v += n * 4;
  });
  geometry.setAttribute("position", position);
  geometry.setAttribute("aTangent", tangent);
  geometry.setAttribute("aInfo", new THREE.BufferAttribute(info, 4));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 3);
  return { geometry, position, tangent, starts };
}

const curve = new THREE.CatmullRomCurve3(
  Array.from({ length: POINTS }, () => new THREE.Vector3()),
  false,
  "centripetal"
);
const sample = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
const zapPoints = Array.from({ length: ZAP }, () => new THREE.Vector3());
const tmp = new THREE.Vector3();
const perpA = new THREE.Vector3();
const perpB = new THREE.Vector3();

// Write one strip's points and tangents into the ribbon.
function writeStrip(r: ReturnType<typeof createRibbon>, strip: number, points: THREE.Vector3[], n: number) {
  const base = r.starts[strip];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    tmp.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]);
    if (tmp.lengthSq() < 1e-12) tmp.set(1, 0, 0);
    tmp.normalize();
    for (let k = 0; k < 4; k++) {
      r.position.setXYZ(base + i * 4 + k, p.x, p.y, p.z);
      r.tangent.setXYZ(base + i * 4 + k, tmp.x, tmp.y, tmp.z);
    }
  }
}

// Sample a string of points smoothly, with a fine electric jitter laid over it that changes every frame.
function smoothArc(points: THREE.Vector3[], jitter: number, seed: number) {
  for (let i = 0; i < POINTS; i++) curve.points[i].copy(points[i]);
  curve.updateArcLengths();
  const pa = seed * 6.28;
  const pb = seed * 17.1;
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1);
    curve.getPointAt(t, sample[i]);
  }
  if (jitter <= 0) return sample;
  for (let i = 1; i < SAMPLES - 1; i++) {
    const t = i / (SAMPLES - 1);
    tmp.subVectors(sample[i + 1], sample[i - 1]).normalize();
    perpA.set(-tmp.y, tmp.x, 0).normalize();
    perpB.crossVectors(tmp, perpA);
    const envelope = Math.sin(t * Math.PI);
    const ja = (Math.sin(t * 23 + pa) * 0.6 + Math.sin(t * 47 + pb) * 0.4) * jitter * envelope;
    const jb = (Math.sin(t * 29 + pb) * 0.6 + Math.sin(t * 41 + pa) * 0.4) * jitter * envelope;
    sample[i].addScaledVector(perpA, ja).addScaledVector(perpB, jb);
  }
  return sample;
}

// A jagged spark from a to b, made fresh whenever asked.
function jagged(a: THREE.Vector3, b: THREE.Vector3) {
  const d = a.distanceTo(b);
  for (let i = 0; i < ZAP; i++) {
    const t = i / (ZAP - 1);
    zapPoints[i].lerpVectors(a, b, t);
  }
  // Midpoint displacement, by hand: a few levels of random kinks, smaller each time.
  let span = ZAP - 1;
  let amount = d * 0.22;
  while (span > 1) {
    for (let i = span; i < ZAP - 1; i += span) {
      const k = Math.min(ZAP - 2, Math.max(1, Math.round(i - span / 2)));
      zapPoints[k].x += (Math.random() - 0.5) * amount;
      zapPoints[k].y += (Math.random() - 0.5) * amount;
      zapPoints[k].z += (Math.random() - 0.5) * amount;
    }
    span = Math.floor(span / 2);
    amount *= 0.55;
  }
  return zapPoints;
}

export function updateRibbon(r: ReturnType<typeof createRibbon>, arc: Arc, jitter: number, zapFresh: boolean, zapFrom: THREE.Vector3, zapTo: THREE.Vector3) {
  if (arc.on) writeStrip(r, 0, smoothArc(arc.p, jitter, Math.random()), SAMPLES);
  if (arc.ghostAge < 1) writeStrip(r, 1, smoothArc(arc.ghost, 0, 0), SAMPLES);
  if (zapFresh) writeStrip(r, 2, jagged(zapFrom, zapTo), ZAP);
  r.position.needsUpdate = true;
  r.tangent.needsUpdate = true;
}

const HOT = new THREE.Color("#fffaff");
const LILAC = new THREE.Color("#c8b6ff");
const VIOLET = new THREE.Color("#6f58ff");
const EMBER = new THREE.Color("#ff8a5c");

// The ribbon's half width at a vertex: wanted, and as drawn (never under about a pixel, dimmed instead).
function widths() {
  const info = attribute("aInfo", "vec4") as any;
  const dist = length(ribbon.eye.sub(positionGeometry)) as any;
  const isCore = float(1).sub(info.y) as any;
  const zapThin = select(info.z.greaterThan(1.5), float(0.55), float(1)) as any;
  const want = mix(ribbon.glow, ribbon.core, isCore).mul(zapThin) as any;
  return { info, want, drawn: max(want, dist.mul(ribbon.pixel).mul(1.15)) as any };
}

export function ArcRibbon({ r }: { r: ReturnType<typeof createRibbon> }) {
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    {
      const { info, drawn } = widths();
      const tan = attribute("aTangent", "vec3") as any;
      const toEye = normalize(ribbon.eye.sub(positionGeometry)) as any;
      const across = cross(tan, toEye) as any;
      const side = across.div(max(length(across), float(1e-4))) as any;
      material.positionNode = positionGeometry.add(side.mul(drawn.mul(info.x))) as any;
    }
    const mesh = new THREE.Mesh(r.geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    mesh.renderOrder = 5;
    return { mesh, material };
  }, [r]);
  useDispose(r.geometry, material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = sceneDepthZ(depth);
        const info = attribute("aInfo", "vec4") as any;
        const v = info.x as any;
        const isCore = float(1).sub(info.y) as any;
        const strip = info.z as any;
        const along = info.w as any;
        const thin = (() => {
          const { want, drawn } = widths();
          return varying(want.div(drawn), "vThin") as any;
        })();
        // Across a core: a white-hot middle in a lilac skin. Across a glow: a soft violet falloff.
        const prof = exp(v.mul(v).mul(-4.5)) as any;
        const coreCol = mix(color(LILAC), color(HOT), pow(prof, float(2.5)))
          .mul(prof)
          .mul(thin.mul(0.85).add(0.15)) as any;
        const g = float(1).sub(v.mul(v)).max(0) as any;
        const glowCol = mix(color(VIOLET), arcTint, 0.35).mul(g.mul(g).mul(g)).mul(0.5) as any;
        // Brighter at the feet, where the arc burns into the copper.
        const feet = exp(along.mul(-36))
          .add(exp(float(1).sub(along).mul(-36)))
          .mul(0.9)
          .add(1) as any;
        const bright = select(strip.lessThan(0.5), ribbon.live, select(strip.lessThan(1.5), ribbon.ghost, ribbon.zap)) as any;
        const ghostWarm = select(strip.greaterThan(0.5).and(strip.lessThan(1.5)), float(1), float(0)) as any;
        const base = mix(coreCol.mul(5.5), glowCol, float(1).sub(isCore)) as any;
        const tinted = mix(base, mix(color(EMBER), color(VIOLET), 0.45).mul(mix(prof.mul(0.25), g.mul(g).mul(0.1), float(1).sub(isCore))), ghostWarm) as any;
        const shown = step(sceneZ, positionView.z) as any;
        material.colorNode = vec4(tinted.mul(bright).mul(select(strip.lessThan(0.5), feet, float(1))).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material]
  );
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hot spots: where the arc's feet burn into the rods, the tip of the spark at the hand, and the strike's flash.

export const SPOTS = 4;
export function createSpots() {
  const data = new Float32Array(SPOTS * 4);
  const attributeData = new THREE.InstancedBufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
  return { data, attribute: attributeData };
}

export function Spots({ spots }: { spots: ReturnType<typeof createSpots> }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute("aSpot", spots.attribute);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(geometry, material, SPOTS);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < SPOTS; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry };
  }, [spots]);
  useDispose(geometry, material);
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = sceneDepthZ(depth);
        const s = attribute("aSpot", "vec4") as any;
        const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const radius = s.w.sqrt().mul(0.03).add(0.004) as any;
        // Drawn a touch toward the eye, so the rod it sits on does not hide it.
        const centre = s.xyz.add(toEye.mul(0.006)) as any;
        material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        const r = uv().sub(0.5).length().mul(2) as any;
        const core = exp(r.mul(r).mul(-60)) as any;
        const halo = exp(r.mul(r).mul(-7)).mul(0.18) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const fade = float(1).sub(smoothstep(0.7, 1, r)) as any;
        material.colorNode = vec4(mix(color(LILAC), color(HOT), core).mul(core.mul(3).add(halo)).mul(s.w.min(3)).mul(fade).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material]
  );
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// The air: the arc's glow lighting the haze, the window's faint shaft, and the dust drifting through both.

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
    const sphere = new THREE.SphereGeometry(30, 32, 16);
    const hazeMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending });
    const haze = new THREE.Mesh(sphere, hazeMaterial);
    haze.frustumCulled = false;
    haze.layers.set(OVERLAY_LAYER);
    return { quad, dustMaterial, specks, sphere, hazeMaterial, haze };
  }, [dust]);
  useDispose(parts.quad, parts.dustMaterial, parts.sphere, parts.hazeMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = sceneDepthZ(depth);

        // The haze: along each pixel's line of sight, up to whatever solid thing it meets, the light scattered from every
        // glowing point of the arc, in closed form (the integral of an inverse square along a line is an arctangent).
        {
          const d = normalize(positionWorld.sub(cameraPosition)) as any;
          const stop = sceneZ.div(normalize(positionView).z).min(12) as any;
          let glow: any = float(0);
          for (let k = 0; k < GLOW; k++) {
            const c = glowPoints.element(k) as any;
            const w = c.xyz.sub(cameraPosition) as any;
            const tc = dot(w, d) as any;
            const h = sqrt(dot(w, w).sub(tc.mul(tc)).max(0).add(0.0009)) as any;
            // Light thins out with distance from the arc as the haze swallows it, so the glow stays a halo, not a wash.
            glow = glow.add(c.w.mul(atan(stop.sub(tc).div(h)).sub(atan(tc.negate().div(h)))).div(h).mul(exp(h.mul(-3.2))));
          }
          // The window's shaft, by the closest the line of sight comes to its axis.
          const from = vec3(KEY.x, KEY.y, KEY.z) as any;
          const axis = vec3(AXIS.x, AXIS.y, AXIS.z) as any;
          const b = dot(d, axis) as any;
          const w0 = cameraPosition.sub(from) as any;
          const tRay = b
            .mul(dot(axis, w0))
            .sub(dot(d, w0))
            .div(max(float(1).sub(b.mul(b)), float(1e-4))) as any;
          const nearest = cameraPosition.add(d.mul(tRay.clamp(0, stop))) as any;
          const along = float(1).sub(smoothstep(0.8, 0.98, abs(b))) as any;
          // The air is never even: a slow stirring makes it thicker in some places than others.
          const middle = cameraPosition.add(d.mul(stop.min(4).mul(0.5))) as any;
          const stirred = mx_noise_float(middle.mul(2.2).add(vec3(0, time.mul(-0.12), time.mul(0.03))))
            .mul(0.4)
            .add(0.8) as any;
          const arcHaze = arcTint.mul(glow.mul(1.1)) as any;
          const window = color("#9fb2d6").mul(shaft(nearest).mul(along).mul(0.012)) as any;
          parts.hazeMaterial.colorNode = vec4(arcHaze.add(window).mul(stirred).mul(haziness), 1) as any;
          parts.hazeMaterial.needsUpdate = true;
        }

        // Dust. About two thirds fine specks in the air round the ladder, a fifth larger motes, and the rest soft discs
        // drifting past the lens. They wander on slow paths, lit by the arc and, faintly, by the window.
        {
          const s = attribute("aSeed", "vec4") as any;
          const t = time as any;
          const size = vec3(1.8, 1.5, 1.6) as any;
          const centreBox = vec3(0, 0.75, 0.1) as any;
          const drift = vec3(t.mul(-0.004), t.mul(0.012), t.mul(0.003)).mul(s.w.add(0.5)) as any;
          const lens = step(s.w, 0.16) as any;
          const mote = step(0.16, s.w).mul(step(s.w, 0.34)) as any;
          const wander = vec3(sin(t.mul(0.21).add(s.x.mul(40))), sin(t.mul(0.17).add(s.y.mul(40))), sin(t.mul(0.19).add(s.z.mul(40)))).mul(0.02) as any;
          const roomPlace = fract(s.xyz.add(drift.div(size)))
            .sub(0.5)
            .mul(size)
            .add(centreBox)
            .add(wander) as any;
          const nearPlace = cameraPosition.add(
            fract(s.xyz.add(drift.div(1.2)).sub(cameraPosition.div(1.2)))
              .sub(0.5)
              .mul(1.2)
          ) as any;
          const centre = mix(roomPlace, nearPlace, lens) as any;
          const toEye = normalize(cameraPosition.sub(centre)) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
          const up = cross(toEye, right) as any;
          const away = cameraPosition.sub(centre).length() as any;
          const grain = mix(float(1), s.x.mul(2.0).add(1.4), mote) as any;
          const sharp = max(float(0.0007), away.mul(0.00045)).mul(grain).mul(s.y.mul(0.8).add(0.6)) as any;
          const blur = min(away.sub(focusDistance).abs().div(away).mul(0.03), away.mul(0.03)) as any;
          const radius = sharp.add(blur) as any;
          const spread = sharp.div(radius).pow(2).max(0.03) as any;
          const soft = smoothstep(0.003, 0.02, blur) as any;
          parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
            .mul(0.3)
            .add(0.7) as any;
          const r = uv().sub(0.5).length() as any;
          const point = float(1).sub(smoothstep(0.08, 0.5, r)) as any;
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const byArc = arcLight(centre).min(40) as any;
          const byWindow = shaft(centre) as any;
          const lit = arcTint
            .mul(byArc.mul(0.55))
            .add(color("#a8bbe0").mul(byWindow.mul(0.7)))
            .add(vec3(0.006)) as any;
          parts.dustMaterial.colorNode = vec4(lit.mul(twinkle).mul(dot2).mul(shown).mul(mix(float(1), float(0.6), lens)), 1) as any;
          parts.dustMaterial.needsUpdate = true;
        }
      }),
    [parts]
  );

  return (
    <>
      <primitive object={parts.haze} />
      <primitive object={parts.specks} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Smoke the arc drives up off itself, and sparks of copper it spits at a strike or a snap. Both stepped on the processor
// (a few hundred at most) and written into instanced buffers each frame.

export type Smoke = {
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  age: Float32Array;
  seed: Float32Array;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  next: number;
};

export function createSmoke(count: number): Smoke {
  const age = new Float32Array(count).fill(99);
  return {
    count,
    pos: new Float32Array(count * 3),
    vel: new Float32Array(count * 3),
    life: new Float32Array(count).fill(1),
    age,
    seed: Float32Array.from({ length: count }, () => Math.random()),
    a: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage),
    b: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage),
    next: 0
  };
}

export function emitSmoke(s: Smoke, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number) {
  const i = s.next;
  s.next = (s.next + 1) % s.count;
  s.pos.set([x, y, z], i * 3);
  s.vel.set([vx, vy, vz], i * 3);
  s.age[i] = 0;
  s.life[i] = life;
  s.seed[i] = Math.random();
}

export function stepSmoke(s: Smoke, dt: number, t: number) {
  const a = s.a.array as Float32Array;
  const b = s.b.array as Float32Array;
  const drag = Math.exp(-dt * 1.1);
  for (let i = 0; i < s.count; i++) {
    s.age[i] += dt;
    const k = s.age[i] / s.life[i];
    if (k >= 1) {
      a[i * 4 + 3] = 0;
      b[i * 4 + 3] = 0;
      continue;
    }
    const j = i * 3;
    const seed = s.seed[i];
    const px = s.pos[j];
    const py = s.pos[j + 1];
    const pz = s.pos[j + 2];
    // Rising and slowing, curling in the air's eddies.
    s.vel[j] = s.vel[j] * drag + Math.sin(py * 7 + t * 0.7 + seed * 30) * 0.05 * dt;
    s.vel[j + 1] = s.vel[j + 1] * drag + 0.12 * dt;
    s.vel[j + 2] = s.vel[j + 2] * drag + Math.sin(px * 6 - t * 0.6 + seed * 20) * 0.04 * dt;
    s.pos[j] = px + s.vel[j] * dt;
    s.pos[j + 1] = py + s.vel[j + 1] * dt;
    s.pos[j + 2] = pz + s.vel[j + 2] * dt;
    const size = 0.012 + Math.pow(k, 0.6) * (0.09 + seed * 0.06);
    a[i * 4] = s.pos[j];
    a[i * 4 + 1] = s.pos[j + 1];
    a[i * 4 + 2] = s.pos[j + 2];
    a[i * 4 + 3] = size;
    const fade = Math.min(1, k * 8) * Math.pow(1 - k, 1.6);
    b[i * 4] = k;
    b[i * 4 + 1] = seed;
    b[i * 4 + 2] = Math.exp(-s.age[i] * 9);
    b[i * 4 + 3] = fade;
  }
  s.a.needsUpdate = true;
  s.b.needsUpdate = true;
}

// A soft, ragged puff, drawn once at load.
function puffTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const image = context.createImageData(size, size);
  const random = lehmer(77);
  const grid = 16;
  const lattice = Array.from({ length: grid * grid }, () => random());
  const value = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const at = (i: number, j: number) => lattice[(((j % grid) + grid) % grid) * grid + (((i % grid) + grid) % grid)];
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx) * (1 - sy) + (at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = Math.hypot(u, v) * 2;
      let n = 0;
      let amp = 0.55;
      let f = 3;
      for (let o = 0; o < 4; o++) {
        n += value(x / (size / f), y / (size / f)) * amp;
        amp *= 0.5;
        f *= 2;
      }
      const falloff = Math.max(0, 1 - r);
      const alpha = Math.max(0, falloff * falloff * (n * 1.6 - 0.25));
      const k = (y * size + x) * 4;
      image.data[k] = image.data[k + 1] = image.data[k + 2] = 255;
      image.data[k + 3] = Math.min(255, alpha * 255);
    }
  context.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export function SmokeCloud({ smoke }: { smoke: Smoke }) {
  const { mesh, material, geometry, puff } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute("aSmokeA", smoke.a);
    geometry.setAttribute("aSmokeB", smoke.b);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(geometry, material, smoke.count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < smoke.count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry, puff: puffTexture() };
  }, [smoke]);
  useDispose(geometry, material, puff);
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = sceneDepthZ(depth);
        const A = attribute("aSmokeA", "vec4") as any;
        const B = attribute("aSmokeB", "vec4") as any;
        const toEye = normalize(cameraPosition.sub(A.xyz)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const turn = B.y.mul(6.28).add(B.x.mul(B.y.sub(0.5).mul(3))) as any;
        const qx = positionGeometry.x.mul(cos(turn)).sub(positionGeometry.y.mul(sin(turn))) as any;
        const qy = positionGeometry.x.mul(sin(turn)).add(positionGeometry.y.mul(cos(turn))) as any;
        material.positionNode = A.xyz.add(right.mul(qx.mul(A.w.mul(2)))).add(up.mul(qy.mul(A.w.mul(2)))) as any;
        const lit = varying(
          (() => {
            const p = attribute("aSmokeA", "vec4").xyz as any;
            return arcLight(p).min(60).mul(0.3).add(shaft(p).mul(0.5)).add(0.01);
          })(),
          "vSmokeLit"
        ) as any;
        const puffA = texture(puff, uv()).a as any;
        const shown = step(sceneZ, positionView.z) as any;
        // Fresh off the arc it glows a little of itself, hot air and copper vapour, then is only lit.
        const hot = color("#ff9a6a").mul(B.z.mul(1.6)) as any;
        const col = arcTint.mul(lit).add(hot) as any;
        material.colorNode = vec4(col.mul(puffA).mul(B.w).mul(0.16).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material, puff]
  );
  return <primitive object={mesh} />;
}

export type Sparks = {
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  life: Float32Array;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  next: number;
};

export function createSparks(count: number): Sparks {
  return {
    count,
    pos: new Float32Array(count * 3),
    vel: new Float32Array(count * 3),
    age: new Float32Array(count).fill(99),
    life: new Float32Array(count).fill(1),
    a: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage),
    b: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage),
    next: 0
  };
}

export function emitSpark(s: Sparks, p: THREE.Vector3, speed: number) {
  const i = s.next;
  s.next = (s.next + 1) % s.count;
  const theta = Math.random() * Math.PI * 2;
  const up = Math.random() * 0.9 - 0.1;
  const flat = Math.sqrt(1 - up * up);
  const v = speed * (0.4 + Math.random() * 0.8);
  s.pos.set([p.x, p.y, p.z], i * 3);
  s.vel.set([Math.cos(theta) * flat * v, up * v, Math.sin(theta) * flat * v * 0.6], i * 3);
  s.age[i] = 0;
  s.life[i] = 0.25 + Math.random() * 0.5;
}

export function stepSparks(s: Sparks, dt: number, floor: number) {
  const a = s.a.array as Float32Array;
  const b = s.b.array as Float32Array;
  for (let i = 0; i < s.count; i++) {
    s.age[i] += dt;
    const k = s.age[i] / s.life[i];
    if (k >= 1) {
      b[i * 4 + 3] = 0;
      continue;
    }
    const j = i * 3;
    s.vel[j + 1] -= 9.8 * dt;
    const drag = Math.exp(-dt * 1.5);
    s.vel[j] *= drag;
    s.vel[j + 1] *= drag;
    s.vel[j + 2] *= drag;
    s.pos[j] += s.vel[j] * dt;
    s.pos[j + 1] += s.vel[j + 1] * dt;
    s.pos[j + 2] += s.vel[j + 2] * dt;
    if (s.pos[j + 1] < floor) {
      s.pos[j + 1] = floor;
      s.vel[j + 1] *= -0.3;
      s.vel[j] *= 0.5;
      s.vel[j + 2] *= 0.5;
    }
    a.set([s.pos[j], s.pos[j + 1], s.pos[j + 2], k], i * 4);
    b.set([s.vel[j], s.vel[j + 1], s.vel[j + 2], 1], i * 4);
  }
  s.a.needsUpdate = true;
  s.b.needsUpdate = true;
}

export function SparkTrails({ sparks }: { sparks: Sparks }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute("aSparkA", sparks.a);
    geometry.setAttribute("aSparkB", sparks.b);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(geometry, material, sparks.count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < sparks.count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry };
  }, [sparks]);
  useDispose(geometry, material);
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = sceneDepthZ(depth);
        const A = attribute("aSparkA", "vec4") as any;
        const B = attribute("aSparkB", "vec4") as any;
        const speed = length(B.xyz) as any;
        const dir = B.xyz.div(max(speed, float(1e-4))) as any;
        const toEye = normalize(cameraPosition.sub(A.xyz)) as any;
        const side = normalize(cross(dir, toEye).add(vec3(1e-5, 0, 0))) as any;
        const dist = length(cameraPosition.sub(A.xyz)) as any;
        const long = speed.mul(0.014).add(0.002) as any;
        const wide = max(float(0.0006), dist.mul(0.0009)) as any;
        // The streak trails behind the spark, a camera's exposure of its flight.
        material.positionNode = A.xyz
          .add(dir.mul(positionGeometry.y.sub(0.5).mul(long)))
          .add(side.mul(positionGeometry.x.mul(wide.mul(2))))
          .mul(B.w)
          .add(vec3(0, -50, 0).mul(float(1).sub(B.w))) as any;
        const k = A.w as any;
        const across = uv().x.sub(0.5).mul(2) as any;
        const head = uv().y as any;
        const shape = exp(across.mul(across).mul(-3)).mul(head.mul(0.8).add(0.2)) as any;
        const heat = float(1).sub(k) as any;
        const col = mix(color("#ff3a10"), mix(color("#ffb050"), color("#fff4d8"), smoothstep(0.6, 1, heat)), smoothstep(0.1, 0.6, heat)) as any;
        const shown = step(sceneZ, positionView.z) as any;
        material.colorNode = vec4(col.mul(heat.mul(heat).mul(5)).mul(shape).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material]
  );
  return <primitive object={mesh} />;
}
