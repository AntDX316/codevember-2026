"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { cos, exp, float, instanceIndex, mix, positionGeometry, sin, smoothstep, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import type { Field } from "./field";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Every point, ball and far motes, in one draw: a small quad square to the view, placed and coloured entirely by the compute
// pass, so each corner only reads two values. A sharp point is a soft round grain; one out of focus a flat disc with a
// soft edge. Added over the frame in the overlay pass, so the bloom takes the hot fronts.
export function Points({ cloud }: { cloud: Field }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const { pos, vel, shade, u } = cloud;
    // Turned with the ball about the upright.
    const local = pos.element(instanceIndex).xyz as any;
    const c = cos(u.spin) as any;
    const sn = sin(u.spin) as any;
    const centre = vec3(local.x.mul(c).add(local.z.mul(sn)), local.y, local.z.mul(c).sub(local.x.mul(sn))) as any;
    const radius = shade.element(instanceIndex).w as any;
    material.positionNode = centre.add(u.camRight.mul(positionGeometry.x.mul(radius.mul(2)))).add(u.camUp.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    const colour = varying(shade.element(instanceIndex).xyz) as any;
    const soft = varying(vel.element(instanceIndex).w) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const grain = exp(r.mul(r).mul(-4.5)) as any;
    const disc = float(1).sub(smoothstep(0.72, 1, r)).mul(0.62) as any;
    material.colorNode = vec4(colour.mul(mix(grain, disc, soft)), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = cloud.count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [cloud]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
