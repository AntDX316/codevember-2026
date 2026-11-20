"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, cross, float, length, max, mix, normalize, positionGeometry, sin, smoothstep, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { mulberry32 } from "../../shared/engine/random";
import { shockAt, type Nebula } from "./gas";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sky round the cloud: a field of stars from a few units out to well past where the camera can go, and a handful of
// young ones buried in the gas itself. Each is a small quad turned to the eye, drawn before the gas, so the gas dims
// whatever lies behind it, and lit up as a heartbeat's front passes.
export function Stars({ nebula, count, embedded }: { nebula: Nebula; count: number; embedded: number }) {
  const { geometry, material } = useMemo(() => {
    const random = mulberry32(2011);
    const total = count + embedded;
    const seeds = new Float32Array(total * 4);
    const looks = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      const inside = i >= count;
      // An even spread of directions; far ones more common, as the shell of sky grows with distance.
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const across = Math.sqrt(1 - z * z);
      const r = inside ? 0.45 + random() * 0.55 : 3.2 + Math.pow(random(), 0.6) * 20;
      const squash = inside ? 1.25 : 1;
      seeds.set([Math.cos(a) * across * r, z * r * squash, Math.sin(a) * across * r, random()], i * 4);
      // Brightness (mostly faint, a few bright), warmth from blue-white to peach, a twinkle rate, and a flag for the buried.
      const bright = inside ? 1.2 + random() * 1.6 : 0.12 + Math.pow(random(), 7) * 3.2;
      looks.set([bright, random(), 0.4 + random() * 2.2, inside ? 1 : 0], i * 4);
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geometry.setAttribute("aLook", new THREE.InstancedBufferAttribute(looks, 4));
    geometry.instanceCount = total;

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const n = nebula as any;
    const s = attribute("aSeed", "vec4") as any;
    const l = attribute("aLook", "vec4") as any;
    const centre = s.xyz as any;
    const away = length(centre.sub(cameraPosition)) as any;
    // Held to about a pixel and a half across wherever they are, so far stars do not shimmer and near ones are not discs.
    const size = away.mul(0.0032).mul(l.x.mul(0.25).add(0.75)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(0.0001, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))) as any;

    const warmth = l.y as any;
    const tint = mix(mix(vec3(0.62, 0.74, 1), vec3(1, 0.97, 0.92), smoothstep(0, 0.5, warmth)), vec3(1, 0.78, 0.6), smoothstep(0.6, 1, warmth)) as any;
    const twinkle = sin(n.time.mul(l.z).add(s.w.mul(60))).mul(0.22).add(0.78) as any;
    // The buried ones take the cloud's inner colour and flash as a shock front passes them.
    const buried = l.w as any;
    const flash = shockAt(nebula, length(centre)).mul(6).mul(buried) as any;
    const colour = mix(tint, mix(n.inner, vec3(1), 0.4), buried).mul(l.x).mul(twinkle).mul(flash.add(1)) as any;
    const glow = varying(colour) as any;
    material.colorNode = (() => {
      const r = length(positionGeometry.xy) as any;
      // A bright point with a little soft glow round it.
      const dot = max(float(1).sub(r), float(0)) as any;
      return vec4(glow.mul(dot.mul(dot).mul(dot)), 1);
    })() as any;
    return { geometry, material };
  }, [nebula, count, embedded]);
  useDispose(geometry, material);

  return <mesh geometry={geometry} material={material} renderOrder={0} frustumCulled={false} raycast={() => null} />;
}
