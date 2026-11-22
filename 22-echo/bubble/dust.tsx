"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraFar, cameraNear, cameraPosition, cross, dot, float, fract, length, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, pow, screenUV, sin, smoothstep, step, uniform, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { clock, membrane, unpack } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where the lens is focused, set each frame: the bubble's middle.
export const focus = uniform(4.6) as any;

// Fine dust drifting slowly round the bubble, and a few big soft discs passing the lens. Specks near the film are
// breathed out and back as a ring passes under them, and catch the light as they go.
export function Dust({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(5381);
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
          const t = clock as any;
          const lensNear = step(s.w, 0.12) as any;
          const turn = t.mul(s.y.mul(0.016).add(0.006)).add(s.x.mul(6.283)) as any;
          const rise = s.z.mul(2).sub(1).add(sin(t.mul(0.04).add(s.w.mul(9))).mul(0.08)) as any;
          const across = max(float(1).sub(rise.mul(rise)), float(0)).sqrt() as any;
          const dir = vec3(across.mul(sin(turn)), rise, across.mul(sin(turn.add(1.5708)))).toVar() as any;
          const reach = s.w.mul(s.w).mul(2.6).add(1.08) as any;
          const wave = unpack(dir, membrane(dir));
          // Breathed out by the ring beneath, fading over a few tenths of the radius.
          const near = float(1).sub(smoothstep(1.05, 1.8, reach)) as any;
          const shell = dir.mul(reach.add(wave.height.mul(3).mul(near))) as any;
          const box = 3.4;
          const drift = vec3(t.mul(0.009), t.mul(0.006), t.mul(-0.004)) as any;
          const lens = cameraPosition.add(
            fract(s.xyz.add(drift.div(box)).sub(cameraPosition.div(box)))
              .sub(0.5)
              .mul(box)
          ) as any;
          return { s, centre: mix(shell, lens, lensNear) as any, lensNear, ring: abs(wave.ring).mul(near), dir };
        };
        const size = (centre: any, s: any) => {
          const away = length(cameraPosition.sub(centre)) as any;
          const sharp = max(float(0.0016), away.mul(0.0011)).mul(s.y.mul(1.4).add(0.45)) as any;
          const blur = min(abs(away.sub(focus)).div(away).mul(0.04), away.mul(0.03)) as any;
          return { sharp, radius: sharp.add(blur), blur };
        };
        const a = place();
        const sa = size(a.centre, a.s);
        const toEye = normalize(cameraPosition.sub(a.centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const upward = cross(toEye, right) as any;
        parts.material.positionNode = a.centre
          .add(right.mul(positionGeometry.x.mul(sa.radius.mul(2))))
          .add(upward.mul(positionGeometry.y.mul(sa.radius.mul(2)))) as any;

        const b = place();
        const sb = size(b.centre, b.s);
        const spread = pow(sb.sharp.div(sb.radius), 2).max(0.05) as any;
        // Lit from the softbox up to the left, a little from the strip on the right, and flaring as a ring passes.
        const lit = max(dot(b.dir, vec3(-0.5, 0.72, 0.48).normalize()), float(0)).mul(0.7).add(max(b.dir.x, float(0)).mul(0.25)).add(0.12) as any;
        const flare = smoothstep(0.15, 0.8, b.ring).mul(1.2) as any;
        const twinkle = sin(clock.mul(b.s.y.mul(1.3).add(0.3)).add(b.s.z.mul(40)))
          .mul(0.25)
          .add(0.75) as any;
        const amount = mix(float(1), float(0.14), b.lensNear) as any;
        const tint = mix(vec3(0.86, 0.9, 1), vec3(1, 0.9, 0.8), b.s.x) as any;
        const light = tint.mul(lit.add(flare).mul(0.4)).mul(twinkle).mul(amount).mul(spread) as any;
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
