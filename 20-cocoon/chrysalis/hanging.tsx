"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, color, cross, dot, exp, float, fract, mix, mx_noise_float, normalize, positionGeometry, positionLocal, sin, smoothstep, uv, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import type { Live } from "./live";
import { rng } from "./shape";

// What it hangs from: a dark twig across the top of the frame with a side shoot and a leaf, and under it the pad of
// silk the thread is spun from.
export function Twig() {
  const parts = useMemo(() => {
    const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    const grain = mx_noise_float(positionLocal.mul(vec3(2.5, 40, 40))).mul(0.5).add(0.5) as any;
    const blotch = mx_noise_float(positionLocal.mul(3)).mul(0.5).add(0.5) as any;
    bark.colorNode = mix(mix(color("#1c1611"), color("#3b2e22"), grain), color("#2b3022"), blotch.mul(0.4)) as any;
    const main = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-2.6, 1.6, -0.5),
      new THREE.Vector3(-1.2, 1.44, -0.12),
      new THREE.Vector3(0, 1.385, 0),
      new THREE.Vector3(0.95, 1.42, 0.04),
      new THREE.Vector3(2.4, 1.62, -0.35)
    ]);
    const shoot = new THREE.CatmullRomCurve3([new THREE.Vector3(0.9, 1.42, 0.04), new THREE.Vector3(1.15, 1.6, 0.18), new THREE.Vector3(1.32, 1.86, 0.32)]);
    const mainGeometry = new THREE.TubeGeometry(main, 160, 0.045, 14, false);
    const shootGeometry = new THREE.TubeGeometry(shoot, 40, 0.022, 10, false);

    // A long milkweed leaf off the shoot, curved along its length and folded a little at its midrib.
    const leafGeometry = new THREE.PlaneGeometry(0.22, 0.8, 8, 32);
    const lp = leafGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i);
      const y = lp.getY(i) + 0.4;
      const t = y / 0.8;
      const half = 0.11 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.98 + 0.02)), 0.8);
      const nx = (x / 0.11) * half;
      lp.setXYZ(i, nx, y, -0.18 * t * t + Math.abs(nx) * 0.35);
    }
    leafGeometry.computeVertexNormals();
    const leafMaterial = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.6 });
    const across = uv().x.sub(0.5).abs() as any;
    const rib = smoothstep(0.03, 0.0, across) as any;
    const veins = smoothstep(0.06, 0.0, abs(fract(uv().y.mul(14).sub(across.mul(5))).sub(0.5))).mul(0.35) as any;
    leafMaterial.colorNode = mix(mix(color("#12261a"), color("#2a4a2a"), mx_noise_float(positionLocal.mul(9)).mul(0.5).add(0.5)), color("#5a6a3c"), rib.add(veins).min(1)) as any;
    leafMaterial.sheenColor = new THREE.Color("#9fb89a");

    const silk = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, sheen: 1, sheenRoughness: 0.35 });
    silk.colorNode = mix(color("#b5ada0"), color("#e8e2d6"), mx_noise_float(positionLocal.mul(120)).mul(0.5).add(0.5)) as any;
    silk.sheenColor = new THREE.Color("#ffffff");
    const padGeometry = new THREE.SphereGeometry(1, 24, 12).scale(0.085, 0.022, 0.07);
    return { bark, mainGeometry, shootGeometry, leafGeometry, leafMaterial, silk, padGeometry };
  }, []);
  useDispose(parts.bark, parts.mainGeometry, parts.shootGeometry, parts.leafGeometry, parts.leafMaterial, parts.silk, parts.padGeometry);
  return (
    <group>
      <mesh geometry={parts.mainGeometry} material={parts.bark} castShadow receiveShadow />
      <mesh geometry={parts.shootGeometry} material={parts.bark} castShadow receiveShadow />
      <mesh geometry={parts.leafGeometry} material={parts.leafMaterial} position={[1.3, 1.86, 0.32]} rotation={[0.35, 0.6, -2.7]} castShadow receiveShadow />
      <mesh geometry={parts.padGeometry} material={parts.silk} position={[0, 1.352, 0]} castShadow />
    </group>
  );
}

// The thread from the pad and the dark stalk the pod is hung by, both swinging with it. Built hanging from the pivot.
export function Thread() {
  const parts = useMemo(() => {
    const silk = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.4, sheen: 1, sheenRoughness: 0.3 });
    silk.colorNode = color("#e8e2d6") as any;
    silk.sheenColor = new THREE.Color("#ffffff");
    const strand = new THREE.CylinderGeometry(0.0022, 0.0022, 0.19, 6, 1).translate(0, -0.095, 0);
    const stalk = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 });
    stalk.colorNode = color("#050403") as any;
    const stem = new THREE.CylinderGeometry(0.008, 0.024, 0.075, 14, 1).translate(0, -0.2, 0);
    const knob = new THREE.SphereGeometry(0.012, 14, 8).translate(0, -0.163, 0);
    return { silk, strand, stalk, stem, knob };
  }, []);
  useDispose(parts.silk, parts.strand, parts.stalk, parts.stem, parts.knob);
  return (
    <group>
      <mesh geometry={parts.strand} material={parts.silk} position={[0.004, 0, 0]} rotation={[0, 0, 0.02]} castShadow />
      <mesh geometry={parts.strand} material={parts.silk} position={[-0.004, 0, 0.003]} rotation={[0.02, 0, -0.015]} castShadow />
      <mesh geometry={parts.strand} material={parts.silk} position={[0, 0, -0.004]} rotation={[-0.018, 0, 0]} castShadow />
      <mesh geometry={parts.stem} material={parts.stalk} castShadow />
      <mesh geometry={parts.knob} material={parts.stalk} castShadow />
    </group>
  );
}

// Specks of dust in the dark, drifting slowly through the light; the lens turns the near and far ones to soft discs.
const BOKEH = 14;

export function Motes({ live, tier }: { live: Live; tier: QualityTier }) {
  const count = tier === "low" ? 80 : tier === "medium" ? 120 : 170;
  const parts = useMemo(() => {
    const random = rng(3);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seed.set([random() * 7 - 3.5, random() * 4.5 - 1.8, random() * 7 - 3.5, random()], i * 4);
    // The last few hang close to the eye's side of the pod, bigger, for the lens to turn into soft discs; marked by a
    // fourth number over 1.
    for (let i = count - BOKEH; i < count; i++) seed.set([random() * 4 - 2, random() * 3 - 1, 1.9 + random() * 1.8, 1.2 + random() * 0.8], i * 4);
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: true, fog: false });
    material.alphaTest = 0.3;
    const s = attribute("aSeed", "vec4") as any;
    const t = live.now as any;
    const wander = vec3(sin(t.mul(0.11).add(s.w.mul(30))).mul(0.25), fract(t.mul(0.012).mul(s.w.add(0.5)).add(s.w)).mul(4.5), sin(t.mul(0.09).add(s.w.mul(17))).mul(0.25)) as any;
    const raw = s.xyz.add(wander) as any;
    const centre = vec3(raw.x, raw.y.add(1.8).mod(4.5).sub(1.8), raw.z) as any;
    const big = s.w.greaterThan(1) as any;
    const radius = big.select(float(0.012).add(s.w.sub(1.2).mul(0.02)), float(0.004).add(s.w.mul(0.006))) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-5, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius))).add(up.mul(positionGeometry.y.mul(radius))) as any;
    const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
    const twinkle = sin(t.mul(s.w.mul(2).add(0.6)).add(s.w.mul(50))).mul(0.4).add(0.6) as any;
    material.colorNode = color("#ffe6c4").mul(exp(r2.mul(-2)).mul(big.select(float(0.12), float(0.22))) as any).mul(twinkle) as any;
    material.opacityNode = float(1).sub(smoothstep(0.6, 1, r2)) as any;
    return { geometry, material };
  }, [count, live]);
  useDispose(parts.geometry, parts.material);
  return <mesh geometry={parts.geometry} material={parts.material} frustumCulled={false} raycast={() => null} />;
}
