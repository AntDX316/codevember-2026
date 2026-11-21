"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, clamp, color, dot, exp, float, floor, fract, frontFacing, max, mix, mx_noise_float, normalize, normalView, select, sin, smoothstep, sqrt, transformNormalToView, uniform, varying, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { glowColour, heatAfter, type Sand } from "./sand";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// 0 while the glass stands; rising to 1 it shrinks away as the sand pours back.
export const glassLook = { dissolve: uniform(0) };

// The fulgurite. Outside, a rough crust of half-fused sand, lumpy, with patches where the glass broke through dark and
// glossy; inside the open mouth, smooth dark glass. While the melt front runs it grows from nothing behind it, white hot
// at the front and cooling through orange to a dull red ember; a gust over still-warm glass brightens it, as breath does
// an ember. Every shape uses this one material, so none compiles on its first strike.
export function glassMaterial(sand: Sand) {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  const centre = attribute("aCentre", "vec3") as any;
  const info = attribute("aInfo", "vec4") as any;
  const grown = smoothstep(info.x, info.x.add(0.06), sand.u.glass) as any;
  const keep = float(1).sub(smoothstep(0, 1, glassLook.dissolve)) as any;
  m.positionNode = centre.add(attribute("position", "vec3").sub(centre).mul(grown.mul(keep))) as any;

  // Thin spurs cool far faster than the trunk.
  const heat = varying(
    (() => {
      const age = sand.u.glass.sub(info.x) as any;
      const quick = sqrt(clamp(float(0.022).div(max(info.y, 0.002)), 1, 6)) as any;
      const hot = heatAfter(age.mul(quick)) as any;
      const breath = sand.u.gust.mul(0.6).mul(exp(age.mul(-1 / 25))).mul(select(age.greaterThan(0), float(1), float(0))) as any;
      return hot.add(breath);
    })(),
    "vGlassHeat"
  ) as any;
  const front = varying(exp(sand.u.glass.sub(info.x).abs().mul(-1 / 0.03)).mul(grown), "vGlassFront") as any;

  const p = attribute("position", "vec3") as any;
  // Crust: fused sand in clumps over the tube, the glass showing through in dark glossy blisters.
  const n1 = mx_noise_float(p.mul(38)).mul(0.5).add(0.5) as any;
  const n2 = mx_noise_float(p.mul(14).add(7.1)).mul(0.5).add(0.5) as any;
  const g = 0.0028;
  const id = floor(p.div(g)) as any;
  const h = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  const blister = smoothstep(0.6, 0.72, n2.add(n1.mul(0.25)).sub(0.12)) as any;
  const crust = mix(mix(color("#8c7658"), color("#c4aa82"), n1), color("#dcc6a0"), select(h.greaterThan(0.8), float(0.5), float(0))) as any;
  const glassy = mix(color("#14160f"), color("#2b2f22"), n1) as any;
  const outside = mix(crust, glassy, blister) as any;
  const inside = color("#1d211a") as any;
  // Grains stuck on the crust catch the light as tiny facets.
  const tilt = vec3(h.sub(0.5), fract(h.mul(31.7)).sub(0.5), fract(h.mul(71.3)).sub(0.5)).mul(float(1).sub(blister).mul(0.8)) as any;
  const bump = vec3(mx_noise_float(p.mul(90)), mx_noise_float(p.mul(90).add(3.3)), mx_noise_float(p.mul(90).add(6.7))).mul(0.25) as any;
  m.normalNode = select(frontFacing, normalize(normalView.add(transformNormalToView(tilt.add(bump)).mul(0.9))), normalView) as any;
  const molten = smoothstep(0.25, 0.9, heat) as any;
  m.colorNode = mix(select(frontFacing, outside, inside), color("#2a1a10"), molten.mul(0.6)) as any;
  m.roughnessNode = mix(select(frontFacing, mix(float(0.9), float(0.12), blister), float(0.06)), float(0.18), molten) as any;
  m.clearcoatNode = select(frontFacing, blister, float(1)) as any;
  m.clearcoatRoughnessNode = float(0.08) as any;
  m.emissiveNode = glowColour(heat).mul(3.2).add(color("#fff6e6").mul(front.mul(9))) as any;
  return m;
}

export function Glass({ geometry, material }: { geometry: THREE.BufferGeometry; material: THREE.Material }) {
  const mesh = useMemo(() => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }, [geometry, material]);
  useDispose(geometry);
  return <primitive object={mesh} />;
}
