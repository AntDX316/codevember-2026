"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, cross, dot, exp, float, fract, length, max, min, mix, normalize, positionGeometry, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import { KEY_FROM } from "./strings";

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

// Dust in the dark round the loom: fine specks drifting up through the air, and a few big soft discs, specks so near the
// lens or so far behind that they have gone out of focus. They are only seen where light finds them: on the key light's
// side, brighter still looking toward it, and close to the strings in the strings' own colour while they ring. Away from
// both they fall into the dark, so the room reads by contrast rather than by fog.
export function Atmosphere({ tier, tint, energy }: { tier: QualityTier; tint: THREE.Color; energy: { value: number } }) {
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const specks = tier === "low" ? 110 : tier === "medium" ? 190 : 280;
  const discs = tier === "low" ? 8 : tier === "medium" ? 12 : 18;

  const { geometry, material, pixel, glowTint, ringing } = useMemo(() => {
    const random = rng(20);
    const count = specks + discs;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // Where each starts (xyz) and its own random number (w); whether it is a disc, and how big.
    const seed = new Float32Array(count * 4);
    const kind = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const disc = i >= specks;
      // Specks fill a column round the loom; discs keep further out, where the eye passes them as it circles.
      const r = disc ? 1.9 + random() * 1.8 : 0.25 + Math.sqrt(random()) * 2.6;
      const a = random() * Math.PI * 2;
      seed.set([r * Math.cos(a), random() * 3.4 - 1.6, r * Math.sin(a), random()], i * 4);
      kind.set([disc ? 1 : 0, disc ? 0.035 + random() * 0.045 : 0.0035 + random() * 0.0055], i * 2);
    }
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
    geometry.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 2));
    geometry.instanceCount = count;

    const pixel = uniform(0.001);
    const glowTint = uniform(new THREE.Color());
    const ringing = uniform(0);
    const key = vec3(KEY_FROM.clone().normalize());

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: true, fog: false });
    // Depth only where a speck is solid enough, so the lens blur knows how far each one is and softens the near ones more.
    material.alphaTest = 0.3;
    const place = () => {
      const s = attribute("aSeed", "vec4") as any;
      const k = attribute("aKind", "vec2") as any;
      const t = time as any;
      // A slow rise, wrapping round, and a lazy sway each its own way; the discs drift slower, as far things seem to.
      const pace = mix(float(1), float(0.45), k.x) as any;
      const sway = vec3(sin(t.mul(0.13).add(s.w.mul(31))).mul(0.18), 0, sin(t.mul(0.1).add(s.w.mul(17))).mul(0.18)).mul(pace) as any;
      const rise = fract(s.y.add(1.6).div(3.4).add(t.mul(0.006).mul(s.w.add(0.4)).mul(pace))).mul(3.4).sub(1.6) as any;
      const centre = vec3(s.x, rise, s.z).add(sway) as any;
      const distance = length(cameraPosition.sub(centre)) as any;
      // Never under about a pixel, so far specks do not flicker away; and a disc never wider than about two degrees.
      const wanted = min(k.y, distance.mul(0.035)) as any;
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
    // Light from one side: the key lights what is on its side of the loom, and glows in what is between the eye and it.
    const side = smoothstep(-0.35, 0.85, dot(normalize(vec3(q.centre.x, 0, q.centre.z).add(vec3(1e-4, 0, 0))), normalize(vec3(key.x, 0, key.z)))) as any;
    const toward = max(dot(V.negate(), key), 0) as any;
    const lit = side.mul(0.55).add(toward.mul(toward).mul(toward).mul(1.4)).add(0.04) as any;
    // Near the strings, their own light while they ring.
    const off = length(vec3(q.centre.x, 0, q.centre.z)).sub(0.6) as any;
    const near = exp(off.mul(off).mul(-5)).mul(float(1).sub(smoothstep(1.1, 1.7, q.centre.y.abs()))) as any;
    const twinkle = sin(time.mul(q.s.w.mul(1.7).add(0.5)).add(q.s.w.mul(60))).mul(0.35).add(0.65) as any;
    const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
    // A speck is a soft point; a disc is flat with a faintly brighter rim, as a lens draws one.
    const speck = exp(r2.mul(-3.2)) as any;
    const disc = float(1).sub(smoothstep(0.82, 1, r2)).mul(smoothstep(0.55, 0.98, r2).mul(0.5).add(0.5)) as any;
    const shape = mix(speck, disc, q.k.x) as any;
    // A speck widened to a pixel is dimmed by as much; a disc spreads its little light thin.
    const cover = q.wanted.div(q.drawn) as any;
    const strength = mix(cover.mul(cover).mul(0.6).mul(twinkle), float(0.075), q.k.x) as any;
    const light = color("#ffeedd").mul(lit).add(glowTint.mul(near.mul(ringing).mul(2.2))) as any;
    material.colorNode = light.mul(shape).mul(strength) as any;
    material.opacityNode = mix(float(1).sub(smoothstep(0.5, 1, r2)), float(1).sub(smoothstep(0.7, 0.9, r2)), q.k.x) as any;
    return { geometry, material, pixel, glowTint, ringing };
  }, [specks, discs]);
  useDispose(geometry, material);

  useFrame(() => {
    pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, size.height);
    glowTint.value.copy(tint);
    // A breath of string light at rest, more as they ring.
    ringing.value = 0.08 + Math.min(1, energy.value * 0.012);
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={3} raycast={() => null} />;
}
