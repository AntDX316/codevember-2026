"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, cameraPosition, cos, cross, dot, float, length, max, normalize, positionLocal, positionWorld, pow, smoothstep, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { type Field, SPEED } from "./field";
import type { Shape } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The core itself: matte black, all but invisible against the dark, a hole in the dust. Only a faint rim gives it away, and
// a thin line of light that sweeps over its face, on the side the sound comes from, as each wave passes it.
export function Core({ shape, field }: { shape: Shape; field: Field }) {
  const parts = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(1, 56);
    const material = new THREE.MeshBasicNodeMaterial();
    const radius = shape.radiusNode;
    const on = (dir: any) => normalize(dir).mul(radius(normalize(dir))) as any;
    const dir = normalize(positionLocal) as any;
    const here = on(dir) as any;
    // The surface's normal from two nearby points across it. The tangents and the direction make a right-handed frame,
    // so the cross product of the two steps points outward.
    const helper = abs(dir.y).greaterThan(0.9).select(vec3(1, 0, 0), vec3(0, 1, 0)) as any;
    const t1 = normalize(cross(helper, dir)) as any;
    const t2 = cross(dir, t1) as any;
    const step = 0.01;
    const a = on(dir.add(t1.mul(step))).sub(here) as any;
    const b = on(dir.add(t2.mul(step))).sub(here) as any;
    const normal = varying(normalize(cross(a, b))) as any;
    material.positionNode = here;

    const { u } = field;
    const n = normalize(normal) as any;
    const view = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(float(1).sub(max(dot(n, view), 0)), float(3)) as any;
    let sweep = float(0) as any;
    for (let k = 0; k < u.at.length; k++) {
      const at = u.at[k] as any;
      const info = u.info[k] as any;
      const rel = positionWorld.sub(at.xyz) as any;
      const d = length(rel) as any;
      const t = u.now.sub(at.w).sub(d.div(SPEED)) as any;
      const env = smoothstep(0, 0.07, t).mul(float(1).sub(smoothstep(info.y, info.y.add(0.1), t))) as any;
      const facing = max(dot(n, rel.div(d).negate()), 0) as any;
      sweep = sweep.add(max(cos(t.mul(info.w).mul(Math.PI * 2)), 0).mul(env).mul(info.x).mul(facing).div(d.mul(0.85).add(1)));
    }
    material.colorNode = vec4(u.dust.mul(rim.mul(0.015)).add(u.hot.mul(sweep.mul(rim.mul(0.5).add(0.04)))), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    return { geometry, material, mesh };
  }, [shape, field]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
