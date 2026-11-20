"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { atan, attribute, cameraPosition, cos, cross, dot, exp, float, fract, length, max, min, mix, normalize, positionGeometry, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import { KEY, type Studio } from "./studio";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The same scatter every visit.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dust in the studio air: fine specks drifting round the fluid, and soft discs further out, which the eye passes close
// to as it circles, so they blur into lens bokeh. They show only where the key light finds them, on its side and
// brightest looking toward it, catching a little of the strip lights; everywhere else they fall into the dark.
export function Atmosphere({ studio, tier }: { studio: Studio; tier: QualityTier }) {
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const specks = tier === "low" ? 120 : tier === "medium" ? 200 : 300;
  const discs = tier === "low" ? 10 : tier === "medium" ? 16 : 24;

  const { geometry, material, pixel } = useMemo(() => {
    const random = rng(2020);
    const count = specks + discs;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // Where each starts (xyz) and its own random number (w); whether it is a disc, and how big.
    const seed = new Float32Array(count * 4);
    const kind = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const disc = i >= specks;
      const r = disc ? 2.6 + random() * 3 : 1.05 + Math.sqrt(random()) * 2.6;
      const a = random() * Math.PI * 2;
      seed.set([r * Math.cos(a), random() * 4 - 1.9, r * Math.sin(a), random()], i * 4);
      kind.set([disc ? 1 : 0, disc ? 0.03 + random() * 0.05 : 0.003 + random() * 0.005], i * 2);
    }
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
    geometry.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 2));
    geometry.instanceCount = count;

    const pixel = uniform(0.001);
    const key = vec3(KEY.x, KEY.y, KEY.z);

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: true, fog: false });
    // Depth only where a speck is solid enough, so the lens blur knows how far each one is.
    material.alphaTest = 0.3;
    const place = () => {
      const s = attribute("aSeed", "vec4") as any;
      const k = attribute("aKind", "vec2") as any;
      const t = time as any;
      // A slow rise, wrapping round, and a lazy sway each its own way; the discs drift slower.
      const pace = mix(float(1), float(0.45), k.x) as any;
      const sway = vec3(sin(t.mul(0.13).add(s.w.mul(31))).mul(0.2), 0, sin(t.mul(0.1).add(s.w.mul(17))).mul(0.2)).mul(pace) as any;
      const rise = fract(s.y.add(1.9).div(4).add(t.mul(0.007).mul(s.w.add(0.4)).mul(pace))).mul(4).sub(1.9) as any;
      const centre = vec3(s.x, rise, s.z).add(sway) as any;
      const distance = length(cameraPosition.sub(centre)) as any;
      // Never under about a pixel, so far specks do not flicker away; and a disc never wider than about two degrees.
      const wanted = min(k.y, distance.mul(0.017)) as any;
      const drawn = max(wanted, distance.mul(pixel).mul(0.9)) as any;
      return { s, k, centre, wanted, drawn };
    };
    const p = place();
    const toEye = normalize(cameraPosition.sub(p.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-5, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    material.positionNode = p.centre.add(right.mul(positionGeometry.x.mul(p.drawn))).add(up.mul(positionGeometry.y.mul(p.drawn))) as any;

    const q = place();
    const V = normalize(cameraPosition.sub(q.centre)) as any;
    // Light from one side: the key lights what is on its side of the fluid, and glows in what lies between the eye and it.
    const flat = normalize(vec3(q.centre.x, 0, q.centre.z).add(vec3(1e-4, 0, 0))) as any;
    const side = smoothstep(-0.3, 0.9, dot(flat, normalize(vec3(KEY.x, 0, KEY.z)))) as any;
    const toward = max(dot(V.negate(), key), 0) as any;
    // A little more where a strip light stands behind it.
    const strip = smoothstep(0.55, 1, cos(atan(q.centre.z, q.centre.x).mul(8).add(0.3))).mul(0.35).add(0.65) as any;
    const lit = side.mul(side).mul(0.5).add(toward.mul(toward).mul(toward).mul(1.3)).mul(strip).add(0.015) as any;
    const twinkle = sin(time.mul(q.s.w.mul(1.7).add(0.5)).add(q.s.w.mul(60))).mul(0.35).add(0.65) as any;
    const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
    // A speck is a soft point; a disc is flat with a faintly brighter rim, as a lens draws one.
    const speck = exp(r2.mul(-3.2)) as any;
    const disc = float(1).sub(smoothstep(0.82, 1, r2)).mul(smoothstep(0.55, 0.98, r2).mul(0.5).add(0.5)) as any;
    const shape = mix(speck, disc, q.k.x) as any;
    // A speck widened to a pixel is dimmed by as much; a disc spreads its little light thin.
    const cover = q.wanted.div(q.drawn) as any;
    const strength = mix(cover.mul(cover).mul(1.5).mul(twinkle), float(0.1), q.k.x) as any;
    const light = mix(studio.key, studio.left, 0.35) as any;
    material.colorNode = light.mul(lit).mul(shape).mul(strength) as any;
    material.opacityNode = mix(float(1).sub(smoothstep(0.5, 1, r2)), float(1).sub(smoothstep(0.7, 0.9, r2)), q.k.x) as any;
    return { geometry, material, pixel };
  }, [specks, discs, studio]);
  useDispose(geometry, material);

  useFrame(() => {
    pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, size.height);
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={3} raycast={() => null} />;
}
