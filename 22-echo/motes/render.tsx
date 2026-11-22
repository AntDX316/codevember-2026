"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { cos, float, instanceIndex, max, mix, positionGeometry, sin, smoothstep, uniform, uv, varying, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import type { Cloud } from "./cloud";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The view's right and up, set each frame, so every fleck's quad lies square to it.
export const view = { right: uniform(new THREE.Vector3(1, 0, 0)), up: uniform(new THREE.Vector3(0, 1, 0)) };

// Every fleck in one draw, placed and coloured by the compute pass: a little block turning in the view, its quad
// narrowing as a face turns edge-on, a square while sharp and a soft round disc out of focus. Added over the frame in the
// overlay pass, so the bloom takes the glints.
export function Flecks({ cloud }: { cloud: Cloud }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    {
      const centre = cloud.pos.element(instanceIndex).xyz as any;
      const radius = cloud.shade.element(instanceIndex).w as any;
      const turn = cloud.turn.element(instanceIndex) as any;
      const ta = turn.x as any;
      const qx = positionGeometry.x
        .mul(turn.y)
        .mul(cos(ta))
        .sub(positionGeometry.y.mul(sin(ta))) as any;
      const qy = positionGeometry.x
        .mul(turn.y)
        .mul(sin(ta))
        .add(positionGeometry.y.mul(cos(ta))) as any;
      material.positionNode = centre.add(view.right.mul(qx.mul(radius.mul(2)))).add(view.up.mul(qy.mul(radius.mul(2)))) as any;
    }
    const colour = varying(cloud.shade.element(instanceIndex).xyz) as any;
    const block = varying(cloud.turn.element(instanceIndex).z) as any;
    const q = uv().sub(0.5).abs() as any;
    const r = uv().sub(0.5).length() as any;
    const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
    const square = float(1).sub(smoothstep(0.3, 0.46, max(q.x, q.y))) as any;
    material.colorNode = vec4(colour.mul(mix(disc, square, block)), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = cloud.count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [cloud]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
