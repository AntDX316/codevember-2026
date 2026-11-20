"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, cross, dot, exp, float, fract, min, mix, normalize, positionGeometry, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useQuality } from "../../shared/engine/quality";

// The key light, for lighting the dust that drifts through its beam.
export const KEY = { position: new THREE.Vector3(-5.2, 3.4, 2.4), target: new THREE.Vector3(0, -0.1, 0) };

// A seeded random, so the dust is the same every visit.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quad(count: number, seeds: Float32Array) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  return geometry;
}

// How much of the key light's beam a point stands in: bright in its core, nothing outside it.
function beam(centre: any) {
  const axis = normalize(vec3(KEY.target.x - KEY.position.x, KEY.target.y - KEY.position.y, KEY.target.z - KEY.position.z));
  const along = dot(normalize(centre.sub(vec3(KEY.position.x, KEY.position.y, KEY.position.z))), axis);
  return smoothstep(Math.cos(0.44), Math.cos(0.18), along) as any;
}

// Dust in the light: fine motes drifting slowly through the room, catching the key where they cross its beam, and a few
// soft out-of-focus discs close to the lens, which follow the eye round so there are always some in frame.
export function Motes() {
  const { tier } = useQuality();
  const counts = tier === "low" ? [160, 10] : tier === "medium" ? [260, 14] : [380, 18];
  const eye = useMemo(() => ({ right: uniform(new THREE.Vector3(1, 0, 0)) as any, up: uniform(new THREE.Vector3(0, 1, 0)) as any, ahead: uniform(new THREE.Vector3(0, 0, -1)) as any }), []);

  const fine = useMemo(() => {
    const random = rng(11);
    const n = counts[0];
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) seeds.set([random() * 7 - 3.5, random() * 4 - 1.5, random() * 6 - 3.5, random()], i * 4);
    const geometry = quad(n, seeds);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const s = attribute("aSeed", "vec4") as any;
    const t = time as any;
    // Slow drift on air currents, rising and sinking, wrapped round in a box about the cocoon.
    const drift = vec3(sin(t.mul(0.07).add(s.w.mul(31))).mul(0.35), sin(t.mul(0.05).add(s.w.mul(13))).mul(0.25).add(t.mul(0.02)), sin(t.mul(0.06).add(s.w.mul(19))).mul(0.35)) as any;
    const raw = s.xyz.add(drift) as any;
    const centre = vec3(raw.x, fract(raw.y.add(1.5).div(4)).mul(4).sub(1.5), raw.z) as any;
    // Mixed sizes, most specks, a few larger flecks.
    const size = mix(float(0.0035), float(0.011), s.w.mul(s.w).mul(s.w)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    m.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))) as any;
    const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
    const twinkle = sin(t.mul(s.w.mul(1.5).add(0.4)).add(s.w.mul(40))).mul(0.3).add(0.7) as any;
    const lit = beam(centre).mul(0.92).add(0.08) as any;
    m.colorNode = color("#ffe3c2").mul(exp(r2.mul(-3))).mul(twinkle).mul(lit).mul(1.6) as any;
    m.opacityNode = float(1).sub(smoothstep(0.5, 1, r2)) as any;
    return { geometry, material: m };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts[0]]);

  const bokeh = useMemo(() => {
    const random = rng(29);
    const n = counts[1];
    const seeds = new Float32Array(n * 4);
    // Placed in the eye's own frame: across and up the view, and 0.7 to 2.4 units in front of the lens.
    for (let i = 0; i < n; i++) seeds.set([random() * 2 - 1, random() * 2 - 1, 0.7 + random() * 1.7, random()], i * 4);
    const geometry = quad(n, seeds);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
    const s = attribute("aSeed", "vec4") as any;
    const t = time as any;
    const depth = s.z as any;
    // Spread to about the view's width at that depth (fov ~34 degrees: half height 0.31 of the depth, wider across).
    const sway = vec3(sin(t.mul(0.05).add(s.w.mul(23))).mul(0.06), sin(t.mul(0.04).add(s.w.mul(9))).mul(0.05), 0) as any;
    const x = s.x.mul(depth).mul(0.5).add(sway.x) as any;
    const y = s.y.mul(depth).mul(0.3).add(sway.y) as any;
    const centre = cameraPosition.add(eye.right.mul(x)).add(eye.up.mul(y)).add(eye.ahead.mul(depth)) as any;
    // No disc wider than about two degrees across, however close it drifts.
    const size = min(mix(float(0.02), float(0.05), s.w), depth.mul(0.017)) as any;
    m.positionNode = centre.add(eye.right.mul(positionGeometry.x.mul(size))).add(eye.up.mul(positionGeometry.y.mul(size))) as any;
    const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
    // A lens disc: nearly flat, a touch brighter at the rim, soft at its very edge.
    const disc = float(1).sub(smoothstep(0.82, 1, r2)).mul(r2.mul(0.35).add(0.65)) as any;
    const lit = beam(centre).mul(0.8).add(0.2) as any;
    const pulse = sin(t.mul(0.3).add(s.w.mul(20))).mul(0.25).add(0.75) as any;
    m.colorNode = color("#ffd8ad").mul(disc).mul(lit).mul(pulse).mul(0.09) as any;
    m.opacityNode = disc;
    return { geometry, material: m };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts[1], eye]);

  useDispose(fine.geometry, fine.material, bokeh.geometry, bokeh.material);

  useFrame(({ camera }) => {
    const e = camera.matrixWorld.elements;
    eye.right.value.set(e[0], e[1], e[2]);
    eye.up.value.set(e[4], e[5], e[6]);
    eye.ahead.value.set(-e[8], -e[9], -e[10]);
  });

  return (
    <>
      <mesh geometry={fine.geometry} material={fine.material} frustumCulled={false} renderOrder={5} raycast={() => null} />
      <mesh geometry={bokeh.geometry} material={bokeh.material} frustumCulled={false} renderOrder={6} raycast={() => null} />
    </>
  );
}
