"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, cross, dot, float, length, max, min, mix, mod, normalize, positionGeometry, pow, sin, smoothstep, time, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance } from "../../shared/engine/Post";
import { mulberry32 } from "../../shared/engine/random";

// Fluff and dust drifting in the still air about the cocoon, bright only where they cross the key light. Those far from
// where the lens is focused swell into soft discs, as out-of-focus specks do, but never past about two degrees across,
// and they dim as they grow so a near one is a glow rather than a blot.
const BOX = { min: [-3, -2.2, -3], size: [6, 4.4, 6] };

export function Motes({ count, keyLight }: { count: number; keyLight: any }) {
  const { mesh, material } = useMemo(() => {
    const random = mulberry32(41);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const start = new Float32Array(count * 4);
    const drift = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;
      let z = 0;
      // Not inside the cocoon itself.
      do {
        x = BOX.min[0] + random() * BOX.size[0];
        y = BOX.min[1] + random() * BOX.size[1];
        z = BOX.min[2] + random() * BOX.size[2];
      } while (x * x + y * y + z * z < 1.4);
      start.set([x, y, z, random() * 100], i * 4);
      // Mostly fine dust, some larger tufts of shed fibre.
      const size = random() < 0.85 ? 0.0025 + random() * 0.004 : 0.007 + random() * 0.006;
      drift.set([(random() - 0.5) * 0.04, (random() - 0.6) * 0.025, (random() - 0.5) * 0.04, size], i * 4);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(start, 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(drift, 4));
    geometry.instanceCount = count;

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aDrift", "vec4") as any;
    const wander = vec3(sin(time.mul(0.21).add(s.w)).mul(0.12), sin(time.mul(0.16).add(s.w.mul(1.3))).mul(0.1), sin(time.mul(0.13).add(s.w.mul(2.1))).mul(0.12)) as any;
    const low = vec3(BOX.min[0], BOX.min[1], BOX.min[2]) as any;
    const span = vec3(BOX.size[0], BOX.size[1], BOX.size[2]) as any;
    const centre = mod(s.xyz.add(v.xyz.mul(time)).add(wander).sub(low), span).add(low) as any;
    const offset = cameraPosition.sub(centre) as any;
    const away = max(length(offset), 0.05) as any;
    const toEye = offset.div(away) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(0.00001, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    // The blur circle grows with distance from the focus, capped at about two degrees seen from the lens.
    const blur = min(max(v.w, away.sub(focusDistance).abs().mul(0.012)), away.mul(0.017)) as any;
    const spread = blur.div(v.w) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(blur))).add(up.mul(positionGeometry.y.mul(blur))) as any;

    const r = length(positionGeometry.xy) as any;
    // A sharp speck is a soft dot; a blurred one a flat disc with a faintly brighter rim.
    const defocus = smoothstep(1.5, 4, spread) as any;
    const dot2 = float(1).sub(smoothstep(0.0, 1.0, r)) as any;
    const disc = float(1).sub(smoothstep(0.82, 1.0, r)).mul(smoothstep(0.5, 0.95, r).mul(0.35).add(0.65)) as any;
    const shape = mix(dot2.mul(dot2), disc, defocus) as any;
    // Lit by the key from the side it comes from, shadowed by the cocoon behind it, and glinting toward the lens.
    const lit = smoothstep(-0.2, 0.6, dot(normalize(centre.add(vec3(0.0001, 0, 0))), keyLight)) as any;
    const glint = pow(max(dot(toEye.negate(), keyLight.negate()), 0), 2).mul(0.6).add(0.4) as any;
    const twinkle = sin(time.mul(0.6).add(s.w.mul(5))).mul(0.25).add(0.75) as any;
    const energy = float(1).div(spread.mul(spread).mul(0.35).add(0.65)) as any;
    const warm = vec3(1.0, 0.82, 0.6) as any;
    const strength = lit.mul(0.92).add(0.08).mul(glint).mul(twinkle).mul(energy).mul(1.6) as any;
    material.colorNode = vec4(warm.mul(strength).mul(shape), 1) as any;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.raycast = () => {};
    return { mesh, material };
  }, [count, keyLight]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}
