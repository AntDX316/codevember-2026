"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { cameraFar, cameraNear, exp, float, instanceIndex, mix, perspectiveDepthToViewZ, positionGeometry, positionView, screenUV, smoothstep, step, uv, varying, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import type { Field } from "./field";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Every grain in one draw: a small quad square to the view, placed and coloured by the compute pass. A sharp grain is a
// soft round point; one out of focus a flat disc with a soft edge. Added over the frame in the overlay pass, so the bloom
// takes the compressed shells, and hidden wherever the core stands in front of it.
export function Dust({ field }: { field: Field }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const { pos, shade, u } = field;
    const centre = pos.element(instanceIndex).xyz as any;
    const radius = shade.element(instanceIndex).w as any;
    material.positionNode = centre.add(u.camRight.mul(positionGeometry.x.mul(radius.mul(2)))).add(u.camUp.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    const colour = varying(shade.element(instanceIndex).xyz) as any;
    const soft = varying(pos.element(instanceIndex).w) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const grain = exp(r.mul(r).mul(-4.5)) as any;
    const disc = float(1).sub(smoothstep(0.72, 1, r)).mul(0.62) as any;
    material.colorNode = vec4(colour.mul(mix(grain, disc, soft)), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = field.count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh, colour, grain, disc, soft };
  }, [field]);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const { material, colour, grain, disc, soft } = parts;
        const scene = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        material.colorNode = vec4(colour.mul(mix(grain, disc, soft)).mul(step(scene, positionView.z)), 1) as any;
        material.needsUpdate = true;
      }),
    [parts]
  );

  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
