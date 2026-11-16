"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  cameraPosition,
  clamp,
  dot,
  float,
  Fn,
  hash,
  instanceIndex,
  max,
  mix,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { mulberry32 } from "../shared/engine/random";
import type { QualityTier } from "../shared/engine/types";
import { clock, environment, giantLight, glowAt, light, surfaceAt } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The litter itself, in three dimensions over the scanned floor: fallen leaves, curled and folded, lying every which way;
// beads of dew from the rain; and twigs, bent and forked. Each kind one instanced draw.

// Splits an instanced set into wedges round the middle of the floor and rings out from it, each its own draw with its
// own bounds, so whatever lies behind the eye or off to the side is skipped whole. Nothing about how each looks changes.
const RINGS = [0.6, 1.5, 4];
export function cull(mesh: THREE.InstancedMesh, wedges = 10) {
  const group = new THREE.Group();
  const buckets = new Map<number, number[]>();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    const r = Math.hypot(p.x, p.z);
    const ring = RINGS.findIndex((edge) => r < edge);
    const wedge = Math.floor(((Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2)) * wedges) % wedges;
    const key = ring === 0 ? -1 : (ring < 0 ? RINGS.length : ring) * wedges + wedge;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }
  for (const list of buckets.values()) {
    const part = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
    list.forEach((i, k) => {
      mesh.getMatrixAt(i, m);
      part.setMatrixAt(k, m);
    });
    part.layers.mask = mesh.layers.mask;
    part.renderOrder = mesh.renderOrder;
    part.computeBoundingSphere();
    part.frustumCulled = true;
    group.add(part);
  }
  return group;
}

const REACH = 2.5;
function inDisc(rand: () => number, r0: number, r1: number) {
  const a = rand() * Math.PI * 2;
  const r = r0 + Math.sqrt(rand()) * (r1 - r0);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r * 0.9 };
}

// A leaf: a strip along its length, curled lengthways and folded at its midrib, a little lifted at the tip.
function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 6, 4);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const fold = Math.abs(y) * 0.12;
    const curl = x * x * 0.22;
    p.setXYZ(i, x, y, fold + curl);
  }
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

// `scan`: the ground's photograph, a patch of which each leaf wears, so its surface is a real leaf's.
export function Leaves({ tier, scan }: { tier: QualityTier; scan: string }) {
  const { mesh, material, geometry } = useMemo(() => {
    const count = tier === "high" ? 4000 : tier === "medium" ? 2800 : 1500;
    const rand = mulberry32(2207);
    const geometry = leafGeometry();
    // Lambert: thousands of leaves, lit cheaply.
    const material = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    const leafUv = uv() as any;
    // Its outline: widest a little before the middle, coming to a point at the tip, a short stalk at the base.
    const along = leafUv.x as any;
    const across = abs(leafUv.y.sub(0.5)).mul(2) as any;
    const width = pow(smoothstep(0, 0.35, along), float(0.7))
      .mul(pow(float(1).sub(along), float(0.6)))
      .mul(1.25) as any;
    const blade = smoothstep(width, width.sub(0.06), across) as any;
    const stalk = smoothstep(0.08, 0.0, along).mul(smoothstep(0.08, 0.02, across)) as any;
    material.opacityNode = max(blade, stalk) as any;
    // Every leaf its own colour, from dark and rotting through tan and rust to one still a little green; veins a shade
    // paler, the edges darker where they are drying.
    const pick = hash(instanceIndex.toFloat().mul(1.37)) as any;
    const base = mix(
      mix(vec3(0.09, 0.055, 0.03), vec3(0.26, 0.15, 0.07), smoothstep(0.0, 0.45, pick)),
      mix(vec3(0.34, 0.14, 0.05), vec3(0.2, 0.22, 0.08), smoothstep(0.75, 0.95, pick)),
      smoothstep(0.4, 0.8, pick)
    ) as any;
    const midrib = smoothstep(0.035, 0.0, across) as any;
    const laterals = smoothstep(0.88, 1, abs(along.mul(18).sub(across.mul(9)).fract().sub(0.5).mul(2)).oneMinus()).mul(smoothstep(0.85, 0.2, across)) as any;
    const edge = smoothstep(0.6, 1, across.div(max(width, 0.01))) as any;
    const tint = hash(instanceIndex.toFloat().mul(5.11)).mul(0.5).add(0.75) as any;
    const photo = new THREE.TextureLoader().load(`/assets/16-spore/${scan}_diff_2k.jpg`);
    photo.colorSpace = THREE.SRGBColorSpace;
    photo.wrapS = photo.wrapT = THREE.RepeatWrapping;
    photo.anisotropy = 8;
    const patch = leafUv.mul(0.09).add(vec2(hash(instanceIndex.toFloat().mul(7.7)), hash(instanceIndex.toFloat().mul(3.1)))) as any;
    const albedo = texture(photo, patch)
      .rgb.mul(tint.mul(0.6).add(0.55))
      .mul(float(1).add(midrib.mul(0.35)).add(laterals.mul(0.12)))
      .mul(float(1).sub(edge.mul(0.3)))
      .mul(mix(float(1), base.mul(3), 0.25)) as any;
    material.colorNode = albedo;
    material.emissiveNode = Fn(() => {
      const facing = normalize(normalWorld).y.abs().mul(0.5).add(0.5) as any;
      return albedo
        .mul(glowAt(positionWorld).add(giantLight().mul(0.3)))
        .mul(facing)
        .mul(0.6);
    })() as any;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      // Thickest where it is looked at closely.
      const s = inDisc(rand, 0, rand() < 0.7 ? 1.6 : REACH);
      const size = 0.014 + rand() * rand() * 0.035;
      const ground = surfaceAt(s.x, s.z);
      q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
      m.compose(new THREE.Vector3(s.x, ground.y + size * 0.05, s.z), q, new THREE.Vector3(size * (1.4 + rand() * 0.6), size * (0.7 + rand() * 0.8), size));
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    return { mesh: cull(mesh), material, geometry };
  }, [tier, scan]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// Dew: beads of water from the rain on the litter and the logs, each a tiny ball lens as in Tension: through it the
// night behind shows bent over and upside down, with the blooms' glow gathered in it; its rim mirrors the sky and goes
// dark where the light inside is turned back, which is what makes a drop read as a drop; and where it lines up with the
// moon it gathers the light into a burning point.
export function Dew({ tier }: { tier: QualityTier }) {
  const { mesh, material, geometry } = useMemo(() => {
    const count = tier === "high" ? 1800 : tier === "medium" ? 1100 : 550;
    const rand = mulberry32(911);
    const geometry = new THREE.IcosahedronGeometry(1, tier === "high" ? 2 : 1);
    const material = new THREE.MeshBasicNodeMaterial({ fog: false });
    material.colorNode = Fn(() => {
      const N = normalize(normalWorld) as any;
      const I = normalize(positionWorld.sub(cameraPosition)) as any;
      const bent = normalize(I.sub(N.mul(1.2))) as any;
      const facing = max(dot(I.negate(), N), 0) as any;
      const fresnel = pow(float(1).sub(facing), float(4)) as any;
      // What shows through: the sky bent over, and the light of the blooms round about, brightest held in its lower half.
      const glow = glowAt(positionWorld).mul(0.7).add(giantLight().mul(0.25)) as any;
      const seen = environment(bent)
        .mul(1.2)
        .add(glow.mul(smoothstep(0.3, -0.6, N.y).mul(0.8).add(0.3))) as any;
      const mirrored = environment(reflect(I, N)) as any;
      const rim = smoothstep(0.08, 0.5, facing).mul(0.85).add(0.15) as any;
      const focus = pow(max(dot(bent, light.toMoon), 0), float(160)).mul(9) as any;
      const glance = pow(max(dot(reflect(I, N), light.toMoon), 0), float(500)).mul(14) as any;
      const rgb = mix(seen, mirrored, fresnel.mul(0.7).add(0.04))
        .mul(rim)
        .add(light.moon.mul(light.moonPower).mul(focus.add(glance))) as any;
      return vec4(rgb, 1);
    })() as any;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      // Thickest close in, where they are seen.
      const s = inDisc(rand, 0, rand() < 0.7 ? 1.4 : REACH * 0.85);
      // Many small and a few big, as dew gathers.
      const r = 0.0012 + rand() ** 3 * 0.0038;
      const ground = surfaceAt(s.x, s.z);
      m.compose(new THREE.Vector3(s.x, ground.y + r * 0.7 + 0.002, s.z), new THREE.Quaternion(), new THREE.Vector3(r, r * 0.85, r));
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    return { mesh: cull(mesh), material, geometry };
  }, [tier]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// A twig: a bent stick of a few joints, tapering, with a short side shoot snapped off.
function twigGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const bend = (points: THREE.Vector3[], r0: number, r1: number) => {
    const curve = new THREE.CatmullRomCurve3(points);
    const g = new THREE.TubeGeometry(curve, 8, 1, 5, false);
    const p = g.getAttribute("position");
    const ring = 6;
    for (let i = 0; i < p.count; i++) {
      const t = Math.floor(i / ring) / 8;
      const centre = curve.getPointAt(Math.min(1, t));
      const r = r0 + (r1 - r0) * t;
      p.setXYZ(i, centre.x + (p.getX(i) - centre.x) * r, centre.y + (p.getY(i) - centre.y) * r, centre.z + (p.getZ(i) - centre.z) * r);
    }
    g.computeVertexNormals();
    return g;
  };
  parts.push(bend([new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(-0.15, 0.02, 0.03), new THREE.Vector3(0.2, 0.01, -0.02), new THREE.Vector3(0.5, 0.03, 0.02)], 0.022, 0.012));
  parts.push(bend([new THREE.Vector3(0.05, 0.015, 0), new THREE.Vector3(0.15, 0.03, 0.09), new THREE.Vector3(0.22, 0.03, 0.17)], 0.012, 0.007));
  const g = new THREE.BufferGeometry();
  const merged = parts.map((p) => p.toNonIndexed());
  const count = merged.reduce((sum, p) => sum + p.getAttribute("position").count, 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let at = 0;
  for (const p of merged) {
    position.set(p.getAttribute("position").array as Float32Array, at * 3);
    normal.set(p.getAttribute("normal").array as Float32Array, at * 3);
    at += p.getAttribute("position").count;
  }
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return g;
}

export function Twigs({ tier }: { tier: QualityTier }) {
  const { mesh, material, geometry } = useMemo(() => {
    const count = tier === "high" ? 800 : tier === "medium" ? 520 : 260;
    const rand = mulberry32(4401);
    const geometry = twigGeometry();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    const tint = hash(instanceIndex.toFloat().mul(3.3)) as any;
    const bark = mix(vec3(0.07, 0.05, 0.035), vec3(0.22, 0.17, 0.12), tint) as any;
    material.colorNode = bark;
    material.emissiveNode = Fn(() => bark.mul(glowAt(positionWorld).add(giantLight().mul(0.3)).mul(0.7).add(light.moon.mul(light.moonPower).mul(0.4))))() as any;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      let s = inDisc(rand, 0.05, REACH);
      for (let k = 0; k < 4 && surfaceAt(s.x, s.z).onLog; k++) s = inDisc(rand, 0.05, REACH);
      const length = 0.04 + rand() * rand() * 0.22;
      m.compose(
        new THREE.Vector3(s.x, surfaceAt(s.x, s.z).y + length * 0.004, s.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.15, rand() * Math.PI * 2, (rand() - 0.5) * 0.15)),
        new THREE.Vector3(length, length * (0.6 + rand() * 0.6), length)
      );
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    return { mesh: cull(mesh), material, geometry };
  }, [tier]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// A fern: a clump of fronds arching up and out from one crown, each a stalk with leaflets down both sides, longest in the
// middle of the frond, drooping a little; the leaflets' toothed outline is cut in the shader.
function fernGeometry() {
  const position: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const rand = mulberry32(77);
  const FRONDS = 12;
  const PAIRS = 16;
  const up = new THREE.Vector3(0, 1, 0);
  for (let f = 0; f < FRONDS; f++) {
    const turn = (f / FRONDS) * Math.PI * 2 + rand() * 0.5;
    const out = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn));
    const reach = 0.75 + rand() * 0.35;
    const lift = 0.5 + rand() * 0.25;
    const at = (s: number) =>
      out
        .clone()
        .multiplyScalar(s * reach)
        .add(new THREE.Vector3(0, Math.sin(s * Math.PI * 0.75) * lift - s * s * 0.25, 0));
    for (let k = 0; k < PAIRS; k++) {
      const s = 0.14 + (k / (PAIRS - 1)) * 0.84;
      const p = at(s);
      const tangent = at(Math.min(1, s + 0.01))
        .sub(at(Math.max(0, s - 0.01)))
        .normalize();
      const sideways = new THREE.Vector3().crossVectors(tangent, up).normalize();
      const length = 0.2 * Math.pow(Math.sin((Math.PI * (s - 0.08)) / 0.94), 0.8) * reach;
      const width = length * 0.3;
      for (const side of [-1, 1]) {
        const dir = sideways.clone().multiplyScalar(side).addScaledVector(tangent, 0.4).addScaledVector(up, -0.12).normalize();
        const across = new THREE.Vector3()
          .crossVectors(dir, up)
          .normalize()
          .multiplyScalar(width * 0.5);
        const tip = p.clone().addScaledVector(dir, length);
        const v = position.length / 3;
        for (const [q, u, w] of [
          [p.clone().sub(across), 0, 0],
          [p.clone().add(across), 0, 1],
          [
            tip
              .clone()
              .add(across)
              .addScaledVector(up, -length * 0.08),
            1,
            1
          ],
          [
            tip
              .clone()
              .sub(across)
              .addScaledVector(up, -length * 0.08),
            1,
            0
          ]
        ] as [THREE.Vector3, number, number][]) {
          position.push(q.x, q.y, q.z);
          uvs.push(u, w);
        }
        index.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// Ferns wherever they are asked for, each spot its own size and turn.
export function fernMesh(spots: { x: number; z: number }[], size: [number, number], seed: number) {
  const rand = mulberry32(seed);
  const geometry = fernGeometry();
  const material = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  const leaf = uv() as any;
  const toothed = float(0.82).add(abs(leaf.x.mul(26).fract().sub(0.5)).mul(0.36)) as any;
  const half = pow(float(1).sub(leaf.x), float(0.55))
    .mul(smoothstep(0, 0.12, leaf.x))
    .mul(toothed) as any;
  material.opacityNode = smoothstep(half, half.sub(0.08), abs(leaf.y.sub(0.5)).mul(2)) as any;
  const pick = hash(instanceIndex.toFloat().mul(2.71)) as any;
  const green = mix(vec3(0.03, 0.07, 0.025), vec3(0.09, 0.15, 0.05), pick).mul(smoothstep(0.0, 0.3, leaf.x).mul(0.4).add(0.8)) as any;
  material.colorNode = green;
  // Light through the leaflets from the blooms and the giants behind, as through any thin leaf.
  material.emissiveNode = Fn(() => green.mul(glowAt(positionWorld).mul(1.2).add(giantLight().mul(0.55)).add(light.moon.mul(light.moonPower).mul(0.3))))() as any;
  const sway = sin(clock.mul(1.1).add(positionWorld.x.mul(3)).add(positionWorld.z.mul(2))).mul(positionLocal.y.mul(0.04)) as any;
  material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6))) as any;
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, spots.length));
  const m = new THREE.Matrix4();
  spots.forEach((s, i) => {
    const h = size[0] + rand() * rand() * (size[1] - size[0]);
    m.compose(
      new THREE.Vector3(s.x, surfaceAt(s.x, s.z).y - h * 0.03, s.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.15, rand() * Math.PI * 2, (rand() - 0.5) * 0.15)),
      new THREE.Vector3(h, h * (0.8 + rand() * 0.4), h)
    );
    mesh.setMatrixAt(i, m);
  });
  mesh.count = spots.length;
  mesh.frustumCulled = false;
  return cull(mesh);
}
