"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraFar, cameraNear, cameraPosition, cross, dot, float, fract, length, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, pow, screenUV, sin, smoothstep, step, uniform, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { clock, surface } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where the lens is focused, set each frame: the drop's middle.
export const focus = uniform(4.4) as any;

// Fine dust hanging round the drop, and a few big soft discs drifting past the lens. Near the drop each speck is pushed
// by the surface under it and shivers as a wave passes, catching the light as it goes.
export function Dust({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(9127);
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
        // Each speck's place: a slow orbit in a shell round the drop, or, for one in eight, drifting about near the lens.
        const place = () => {
          const s = attribute("aSeed", "vec4") as any;
          const t = clock as any;
          const lensNear = step(s.w, 0.1) as any;
          const turn = t.mul(s.y.mul(0.02).add(0.01)).add(s.x.mul(6.283)) as any;
          const rise = s.z.mul(2).sub(1).add(sin(t.mul(0.05).add(s.w.mul(9))).mul(0.06)) as any;
          const across = max(float(1).sub(rise.mul(rise)), float(0)).sqrt() as any;
          const dir = vec3(across.mul(sin(turn)), rise, across.mul(sin(turn.add(1.5708)))).toVar() as any;
          const reach = s.w.mul(s.w).mul(2.2).add(1.12) as any;
          const { height } = surface(dir, false);
          // Pushed by the surface beneath, and shaking with it, both fading over a few tenths of the radius.
          const near = float(1).sub(smoothstep(1.05, 1.9, reach)) as any;
          const shake = sin(t.mul(53).add(s.x.mul(91))).mul(abs(height)).mul(2.2) as any;
          const shell = dir.mul(reach.add(height.mul(1.6).add(shake).mul(near))) as any;
          const box = 3.2;
          const drift = vec3(t.mul(0.011), t.mul(0.007), t.mul(-0.005)) as any;
          const lens = cameraPosition.add(
            fract(s.xyz.add(drift.div(box)).sub(cameraPosition.div(box)))
              .sub(0.5)
              .mul(box)
          ) as any;
          return { s, centre: mix(shell, lens, lensNear) as any, lensNear, wave: abs(height).mul(near), dir };
        };
        const size = (centre: any, s: any) => {
          const away = length(cameraPosition.sub(centre)) as any;
          const sharp = max(float(0.0016), away.mul(0.0012)).mul(s.y.mul(1.4).add(0.45)) as any;
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
        // Lit from the big softbox above and in front, a little from the strip on the right, and flaring in a passing wave.
        const lit = max(dot(b.dir, vec3(-0.35, 0.85, 0.45).normalize()), float(0)).mul(0.8).add(max(b.dir.x, float(0)).mul(0.3)).add(0.12) as any;
        const flare = smoothstep(0.002, 0.02, b.wave).mul(1.6) as any;
        const twinkle = sin(clock.mul(b.s.y.mul(1.3).add(0.3)).add(b.s.z.mul(40)))
          .mul(0.25)
          .add(0.75) as any;
        const amount = mix(float(1), float(0.16), b.lensNear) as any;
        const tint = mix(vec3(0.85, 0.9, 1), vec3(1, 0.9, 0.78), b.s.x) as any;
        const light = tint.mul(lit.add(flare).mul(0.42)).mul(twinkle).mul(amount).mul(spread) as any;
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
