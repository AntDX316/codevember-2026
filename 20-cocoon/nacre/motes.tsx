"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, dot, float, length, max, min, mod, normalize, positionGeometry, pow, sin, smoothstep, time, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance } from "../../shared/engine/Post";

// Where the dust drifts: a wide box round the cocoon, deep enough that some of it passes close to the lens.
const MIN = [-6, -3, -6] as const;
const SIZE = [12, 6.5, 12] as const;

// Dust in the key light, in mixed sizes: specks in focus near the cocoon, and soft discs, as a lens draws them, the
// further they are from the plane of focus. Each disc is capped at about two degrees across, and fainter the larger it
// grows, as the same light spread wider.
export function Motes({ count, light }: { count: number; light: [number, number, number] }) {
  const { mesh, geometry, material } = useMemo(() => {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const start: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < count; i++) {
      start.push(MIN[0] + random() * SIZE[0], MIN[1] + random() * SIZE[1], MIN[2] + random() * SIZE[2], random() * 100);
      // Mostly fine specks, a few larger flakes.
      drift.push((random() - 0.5) * 0.04, (random() - 0.6) * 0.03, (random() - 0.5) * 0.04, 0.4 + Math.pow(random(), 3) * 1.6);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(new Float32Array(drift), 4));
    geometry.instanceCount = count;

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aDrift", "vec4") as any;
    const wander = vec3(sin(time.mul(0.21).add(s.w)).mul(0.18), sin(time.mul(0.16).add(s.w.mul(1.3))).mul(0.12), sin(time.mul(0.13).add(s.w.mul(2.1))).mul(0.16)) as any;
    const lo = vec3(...MIN) as any;
    const span = vec3(...SIZE) as any;
    const centre = mod(s.xyz.add(v.xyz.mul(time)).add(wander).sub(lo), span).add(lo) as any;
    const offset = cameraPosition.sub(centre) as any;
    const distance = max(length(offset), 0.05) as any;
    const toEye = offset.div(distance) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate()).add(vec3(1e-4, 0, 0))) as any;
    const up = vec3(right.y.mul(toEye.z).sub(right.z.mul(toEye.y)), right.z.mul(toEye.x).sub(right.x.mul(toEye.z)), right.x.mul(toEye.y).sub(right.y.mul(toEye.x))) as any;
    const sharp = v.w.mul(0.0045) as any;
    // How far out of focus: the blur circle grows with distance from the focal plane, relative to the distance itself.
    const blur = abs(distance.sub(focusDistance)).div(distance) as any;
    const radius = min(sharp.add(blur.mul(0.05)), distance.mul(0.0175)) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius))).add(up.mul(positionGeometry.y.mul(radius))) as any;

    const r = length(positionGeometry.xy) as any;
    const defocus = smoothstep(0.01, 0.04, radius.sub(sharp)) as any;
    // A sharp speck is a soft dot; a defocused one a flat disc with a faintly brighter rim.
    const dotShape = pow(float(1).sub(smoothstep(0, 1, r)), 2) as any;
    const disc = float(1).sub(smoothstep(0.86, 1, r)).mul(smoothstep(0.6, 0.97, r).mul(0.35).add(0.65)) as any;
    const shape = dotShape.mul(float(1).sub(defocus)).add(disc.mul(defocus)) as any;
    const key = normalize(vec3(...light)) as any;
    // Brightest looking towards the light, as dust is.
    const along = max(dot(toEye.negate(), key), 0) as any;
    const lit = pow(along, 4).mul(1.2).add(0.18) as any;
    const spread = pow(sharp.div(radius), 1.1).max(0.08) as any;
    const twinkle = sin(time.mul(0.6).add(s.w.mul(5))).mul(0.25).add(0.75) as any;
    const fadeNear = smoothstep(0.25, 0.8, distance) as any;
    material.colorNode = vec4(vec3(1.0, 0.93, 0.84).mul(lit).mul(shape).mul(spread).mul(twinkle).mul(fadeNear).mul(1.6), 1) as any;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.raycast = () => null;
    return { mesh, geometry, material };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}
