"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraFar, cameraNear, cameraPosition, cross, exp, float, fract, length, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, pow, screenUV, sin, smoothstep, step, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { CENTRE_Y, room } from "./room";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Dust drifting slowly through the room, lit where it crosses the softbox's column, and a few big soft discs passing
// the lens. Each speck is hidden behind whatever the tracer drew nearer.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4421);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const place = () => {
          const s = attribute("aSeed", "vec4") as any;
          const t = room.now as any;
          const lensNear = step(s.w, 0.1) as any;
          // Most specks in a wide column round the light, slowly turning and sinking; the rest anywhere near the lens.
          const box = vec3(6.4, 4.6, 6.4);
          // Each speck wanders, sinks, and is carried slowly along by the same breeze that ripples the bubble.
          const drift = vec3(sin(t.mul(0.05).add(s.x.mul(20))).mul(0.15).add(t.mul(0.035)), t.mul(-0.012), sin(t.mul(0.04).add(s.z.mul(17))).mul(0.15).add(t.mul(0.012))) as any;
          const inRoom = fract(s.xyz.add(drift.div(box))).sub(0.5).mul(box).add(vec3(0, CENTRE_Y + 0.3, 0)) as any;
          const pulled = vec3(inRoom.x.mul(s.y.mul(0.6).add(0.35)), inRoom.y, inRoom.z.mul(s.y.mul(0.6).add(0.35))) as any;
          const lensBox = 2.6;
          const lens = cameraPosition.add(fract(s.xyz.add(drift.div(lensBox)).sub(cameraPosition.div(lensBox))).sub(0.5).mul(lensBox)) as any;
          return { s, centre: mix(pulled, lens, lensNear) as any, lensNear };
        };
        const size = (centre: any, s: any) => {
          const away = length(cameraPosition.sub(centre)) as any;
          const sharp = max(float(0.0018), away.mul(0.0012)).mul(s.y.mul(1.4).add(0.45)) as any;
          const blur = min(abs(away.sub(3.4)).div(away).mul(0.035), away.mul(0.03)) as any;
          return { sharp, radius: sharp.add(blur), blur };
        };
        const a = place();
        const sa = size(a.centre, a.s);
        const toEye = normalize(cameraPosition.sub(a.centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const upward = cross(toEye, right) as any;
        parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(sa.radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(sa.radius.mul(2)))) as any;

        const b = place();
        const sb = size(b.centre, b.s);
        const spread = pow(sb.sharp.div(sb.radius), 2).max(0.04) as any;
        const column = exp(b.centre.xz.dot(b.centre.xz).div(-1.1)) as any;
        const twinkle = sin(room.now.mul(b.s.y.mul(1.3).add(0.3)).add(b.s.z.mul(40))).mul(0.3).add(0.7) as any;
        const amount = mix(float(1), float(0.18), b.lensNear) as any;
        const light = vec3(1, 0.93, 0.84).mul(column.mul(0.9).add(0.06)).mul(twinkle).mul(amount).mul(spread).mul(0.5) as any;
        const colour = varying(light) as any;
        const r = uv().sub(0.5).length() as any;
        const soft = varying(smoothstep(0.004, 0.03, sb.blur)) as any;
        const shape = mix(float(1).sub(smoothstep(0.06, 0.5, r)), float(1).sub(smoothstep(0.36, 0.5, r)), soft) as any;
        parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts]
  );
  return <primitive object={parts.mesh} />;
}
