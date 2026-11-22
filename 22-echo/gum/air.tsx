"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, color, cameraFar, cameraNear, cameraPosition, cross, exp, float, Fn, fract, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, positionWorld, screenUV, sin, smoothstep, sqrt, step, time, uv, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { ROOM } from "./echo";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The daylight from the skylight, seen in the air: a soft column straight down to the floor, brightest seen across its
// full depth and fading as it falls; and dust drifting through the hall, glinting where it crosses the column. Both in
// the overlay pass, added over the finished frame and cut off by the scene's depth. (After Pendulum's window light.)

const SUN = new THREE.Color("#fff4e4");
const SHAFT = ROOM.oculus * 0.95;

export function Air({ count }: { count: number }) {
  const parts = useMemo(() => {
    const H = ROOM.ceiling - ROOM.floor;
    const shaftGeometry = new THREE.CylinderGeometry(SHAFT, SHAFT, H, 64, 1, true).translate(0, ROOM.floor + H / 2, 0);
    const shaftMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending });
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
    shaft.layers.set(OVERLAY_LAYER);
    shaft.frustumCulled = false;

    const random = lehmer(5521);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const dustMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, dustMaterial, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    return { shaft, shaftGeometry, shaftMaterial, quad, dustMaterial, specks };
  }, [count]);
  useDispose(parts.shaftGeometry, parts.shaftMaterial, parts.quad, parts.dustMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = time as any;

        // How far the eye's line runs inside the column, stopped by whatever stands in the way.
        parts.shaftMaterial.colorNode = Fn(() => {
          const dir = normalize(positionWorld.sub(cameraPosition)) as any;
          const o = cameraPosition as any;
          const a = dir.x.mul(dir.x).add(dir.z.mul(dir.z)).max(1e-5) as any;
          const b = o.x.mul(dir.x).add(o.z.mul(dir.z)) as any;
          const c = o.x.mul(o.x).add(o.z.mul(o.z)).sub(SHAFT * SHAFT) as any;
          const disc = max(b.mul(b).sub(a.mul(c)), 0) as any;
          const root = sqrt(disc) as any;
          const into = max(b.negate().sub(root).div(a), 0) as any;
          const stop = sceneZ.div(normalize(positionView).z) as any;
          const out = min(b.negate().add(root).div(a), stop) as any;
          const length = max(out.sub(into), 0) as any;
          const mid = o.add(dir.mul(into.add(out).mul(0.5))) as any;
          // Brightest near the skylight, soft at the column's edge (where the line through it is short anyway).
          const fall = smoothstep(ROOM.floor - 0.5, ROOM.ceiling, mid.y).mul(0.7).add(0.3) as any;
          const edge = float(1).sub(smoothstep(SHAFT * 0.55, SHAFT, mid.xz.length())) as any;
          const glow = length.mul(fall).mul(edge.mul(0.7).add(0.3)).mul(0.028) as any;
          return vec4(color(SUN).mul(glow), 1);
        })() as any;
        parts.shaftMaterial.needsUpdate = true;

        // Dust: each speck on its own slow path round the hall, a soft dot facing the eye, blurred by its distance from
        // the focus as a lens would; faint in the room, glinting in the column.
        const s = attribute("aSeed", "vec4") as any;
        const lo = vec3(-6, ROOM.floor + 0.2, -6) as any;
        const size = vec3(12, ROOM.ceiling - ROOM.floor - 0.4, 12) as any;
        const drift = vec3(sin(t.mul(0.06).add(s.w.mul(40))).mul(0.25), t.mul(0.012).mul(s.w.add(0.3)), sin(t.mul(0.05).add(s.x.mul(31))).mul(0.25)) as any;
        const close = step(s.w, 0.05) as any;
        const roomPlace = lo.add(fract(s.xyz.add(drift.div(size))).mul(size)) as any;
        const nearPlace = cameraPosition.add(fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4))).sub(0.5).mul(2.4)) as any;
        const centre = mix(roomPlace, nearPlace, close) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const away = cameraPosition.sub(centre).length() as any;
        const fleck = step(s.w, 0.3).mul(1.4).add(1) as any;
        const sharp = max(float(0.0024), away.mul(0.0011)).mul(fleck) as any;
        const blur = away.sub(focusDistance).abs().div(away).mul(0.045) as any;
        const radius = min(sharp.add(blur), away.mul(0.018)) as any;
        const spread = sharp.div(radius).pow(2).max(0.05) as any;
        const soft = smoothstep(0.004, 0.03, blur) as any;
        parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        const inShaft = float(1).sub(smoothstep(SHAFT * 0.7, SHAFT * 1.1, centre.xz.length())) as any;
        const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50))).mul(0.3).add(0.7) as any;
        const r = uv().sub(0.5).length() as any;
        const point = float(1).sub(smoothstep(0.15, 0.5, r)) as any;
        const disc = float(1).sub(smoothstep(0.4, 0.5, r)).mul(0.8) as any;
        const dot = mix(point, disc, soft).mul(spread) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const brightness = mix(float(0.07), float(1.6), inShaft).mul(twinkle).mul(dot).mul(shown).mul(exp(away.mul(-0.04))) as any;
        parts.dustMaterial.colorNode = vec4(color(SUN).mul(brightness), 1) as any;
        parts.dustMaterial.needsUpdate = true;
      }),
    [parts]
  );

  return (
    <>
      <primitive object={parts.shaft} />
      <primitive object={parts.specks} />
    </>
  );
}
