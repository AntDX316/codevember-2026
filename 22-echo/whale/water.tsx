"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraFar, cameraNear, cameraPosition, cross, exp, float, floor, fract, instanceIndex, max, min, mix, mod, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, positionWorld, pow, screenUV, sin, smoothstep, step, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { PULSES, SPEED, SUN, echo, revealAt, waterColour } from "./pulses";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The open water round everything: black below, the faintest blue-green far overhead.
export function Backdrop() {
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    material.colorNode = waterColour(normalize(positionWorld.sub(cameraPosition))) as any;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    return { mesh, material };
  }, []);
  useDispose(mesh.geometry, material);
  useFrame(({ camera }) => mesh.position.copy(camera.position));
  return <primitive object={mesh} />;
}

const sceneDepthZ = (depth: any) => perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;

// Marine snow: flecks of drifting detritus through a box round the eye that wraps, sinking slowly. In the dark they are
// barely there, a few catching the light from above; as a front passes through them they flash and glow a moment, so
// the call is seen moving through the open water itself. `near` is a smaller, sparser box of bigger flecks right at the
// lens, blurred into soft discs.
export function Snow({ count, near = false }: { count: number; near?: boolean }) {
  const BOX = near ? 7 : 34;
  const parts = useMemo(() => {
    const random = lehmer(near ? 9137 : 2251);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    return { quad, material, specks };
  }, [count, near]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const t = echo.time as any;
        const s = attribute("aSeed", "vec4") as any;
        const drift = vec3(sin(t.mul(0.07).add(s.w.mul(40))).mul(0.4).add(t.mul(0.12)), t.mul(-0.05).mul(s.w.add(0.4)), sin(t.mul(0.05).add(s.x.mul(31))).mul(0.4)) as any;
        const centre = cameraPosition.add(fract(s.xyz.add(drift.sub(cameraPosition).div(BOX))).sub(0.5).mul(BOX)) as any;
        const away = cameraPosition.sub(centre).length() as any;
        const toEye = cameraPosition.sub(centre).div(away) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        // A speck of a few millimetres, grown by its distance from the focus at about 30 m, no more than about two
        // degrees across.
        const sharp = max(float(0.0012), away.mul(0.0011)).mul(s.w.mul(1.4).add(0.6)) as any;
        const blur = min(away.sub(30).abs().div(away).mul(near ? 0.03 : 0.006), away.mul(near ? 0.018 : 0.004)) as any;
        const radius = sharp.add(blur) as any;
        const spread = sharp.div(radius).pow(1.3).max(near ? 0.06 : 0.15) as any;
        parts.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        // Lit as the fronts pass, worked out once at each corner.
        const lit = varying(revealAt(centre, () => float(1), 1, 2).mul(spread)) as any;
        const base = varying(spread.mul(s.z.mul(s.z).mul(0.035).add(0.004)).mul(smoothstep(-40, 10, centre.y))) as any;
        const r = uv().sub(0.5).length() as any;
        const soft = smoothstep(0.0015, 0.01, blur) as any;
        const point = float(1).sub(smoothstep(0.05, 0.5, r)) as any;
        const disc = float(1).sub(smoothstep(0.34, 0.5, r)).mul(0.85).add(smoothstep(0.28, 0.44, r).mul(float(1).sub(smoothstep(0.44, 0.5, r))).mul(0.08)) as any;
        const dot = mix(point, disc, soft) as any;
        const fade = smoothstep(0.3, 0.8, away).mul(float(1).sub(smoothstep(BOX * 0.36, BOX * 0.5, away))) as any;
        const shown = step(sceneDepthZ(depth), positionView.z) as any;
        const colour = vec3(0.45, 0.75, 0.85).mul(base).add(lit.mul(near ? 0.6 : 1.4)) as any;
        parts.material.colorNode = vec4(colour.mul(dot).mul(fade).mul(shown), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts, BOX, near]
  );

  return <primitive object={parts.specks} />;
}

// Shafts of the last daylight, reaching down from far above and dying out long before the floor. Each a strip turned
// about its own line to face the eye, soft across, fading in at the top and out with depth, and fading too where the
// eye looks along it.
export function Shafts({ count }: { count: number }) {
  const { mesh, material } = useMemo(() => {
    const random = lehmer(4409);
    const foot: number[] = [];
    const along: number[] = [];
    const index: number[] = [];
    const LONG = 120;
    for (let i = 0; i < count; i++) {
      const x = (random() - 0.5) * 150;
      const z = -20 - random() * 110;
      const wide = 2.5 + random() * random() * 9;
      const seed = random() * 100;
      const strength = 0.4 + random() * 0.6;
      const steps = 8;
      const base = foot.length / 4;
      for (let k = 0; k <= steps; k++)
        for (const across of [-1, 1]) {
          foot.push(x, z, wide, strength);
          along.push(across, (k / steps) * LONG, seed, 0);
        }
      for (let k = 0; k < steps; k++) {
        const q = base + k * 2;
        index.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array((foot.length / 4) * 3), 3));
    geometry.setAttribute("aFoot", new THREE.Float32BufferAttribute(foot, 4));
    geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 4));
    geometry.setIndex(index);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material };
  }, [count]);
  useDispose(mesh.geometry, material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const f = attribute("aFoot", "vec4") as any;
        const a = attribute("aAlong", "vec4") as any;
        const axis = vec3(-SUN.x, -SUN.y, -SUN.z) as any;
        // The top, high above, from which the shaft runs down along the light.
        const top = vec3(f.x, 40, f.y).sub(axis.mul(30)) as any;
        const centre = top.add(axis.mul(a.y)) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const side = normalize(cross(axis, toEye)) as any;
        const widen = a.y.div(120).mul(0.8).add(0.6) as any;
        material.positionNode = centre.add(side.mul(a.x.mul(f.z).mul(widen))) as any;
        const across = varying(a.x) as any;
        const down = varying(a.y.div(120)) as any;
        const facing = varying(float(1).sub(pow(abs(toEye.dot(axis)), 6))) as any;
        const t = echo.time as any;
        const flicker = sin(t.mul(0.21).add(a.z)).mul(0.25).add(sin(t.mul(0.13).add(a.z.mul(1.7))).mul(0.15)).add(0.75) as any;
        const bell = pow(float(1).sub(across.mul(across)).max(0), 2.2) as any;
        const fade = smoothstep(0, 0.12, down).mul(exp(down.mul(-3.2))) as any;
        const shown = step(sceneDepthZ(depth), positionView.z) as any;
        material.colorNode = vec4(vec3(0.05, 0.12, 0.13).mul(bell).mul(fade).mul(facing).mul(flicker).mul(f.w).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material]
  );

  return <primitive object={mesh} />;
}

// The fronts themselves, seen in the open water: each call is drawn as a few nested shells (the leading front and two
// ripples behind it), faint face-on and brighter where the eye looks along their curve, with fine rings of latitude
// about the point they spread from, so the wave reads as a sweeping scan.
export const SHELLS = 3;
export function Fronts() {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(1, 12);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, material, PULSES * SHELLS);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < PULSES * SHELLS; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry };
  }, []);
  useDispose(geometry, material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const which = floor(float(instanceIndex).div(SHELLS)).toInt() as any;
        const lag = mod(float(instanceIndex), SHELLS) as any;
        const p = echo.pulse.element(which) as any;
        const c = echo.tone.element(which) as any;
        const age = (echo.time as any).sub(p.w) as any;
        const radius = age.mul(SPEED).sub(lag.mul(5.5)).max(0.01) as any;
        material.positionNode = p.xyz.add(positionGeometry.mul(radius)) as any;
        const n = varying(positionGeometry) as any;
        const P = positionWorld as any;
        const toEye = normalize(cameraPosition.sub(P)) as any;
        const rim = float(1).sub(abs(normalize(n).dot(toEye))) as any;
        // Rings of latitude about the vertical through the source, thin, and gone toward the poles.
        const lat = n.y.mul(18) as any;
        const ring = float(1).sub(smoothstep(0.0, 0.09, abs(fract(lat).sub(0.5)).sub(0.41).max(0))) as any;
        const born = smoothstep(0.5, 3, radius) as any;
        const dying = exp(radius.div(-75)) as any;
        const tint = varying(c.xyz.mul(c.w).mul(float(1).sub(lag.mul(0.3))).mul(born).mul(dying)) as any;
        const light = pow(rim, 6).mul(0.09).add(pow(rim, 1.5).mul(ring).mul(0.012)).add(0.0015) as any;
        const shown = step(sceneDepthZ(depth), positionView.z) as any;
        material.colorNode = vec4(tint.mul(light).mul(shown), 1) as any;
        material.needsUpdate = true;
      }),
    [material]
  );

  return <primitive object={mesh} />;
}
