"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cos, exp, float, fract, max, min, mix, pow, sin, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { APEX, FAR, fanFrameNode, HALF, NEAR, type Atlas } from "./scan";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What every drawn slice reads: the live pose, where the pulse has got to, and the look the settings choose.
export const view = {
  tilt: uniform(0),
  yaw: uniform(0),
  // How far down the fan the current pulse has travelled, and the length of one pulse's trip.
  front: uniform(0),
  trip: uniform(FAR + 0.7),
  now: uniform(0),
  gain: uniform(1),
  // Seconds for a left slice to fade to a third.
  trail: uniform(40),
  // The tint as a curve per channel: brightness raised to these powers, then scaled, so the darks are coloured and
  // the brightest echoes run to white.
  power: uniform(new THREE.Vector3(0.95, 1.3, 2.1)),
  scale: uniform(new THREE.Vector3(1.05, 0.62, 0.34))
};

export const TINTS = {
  amber: { power: [0.95, 1.3, 2.1], scale: [1.05, 0.62, 0.34] },
  cyan: { power: [2.1, 1.15, 0.92], scale: [0.36, 0.82, 1.05] }
} as const;

// A bell, exp(-x²), written with a product: pow() of a negative number is undefined in WGSL and gave NaN, which the
// bloom then smeared over the whole frame.
export const bell = (x: any) => exp(x.mul(x).negate()) as any;

export const tint = (i: any) => pow(vec3(i, i, i).max(1e-6), view.power).mul(view.scale) as any;

// A fan as a strip of thin wedges, its corners carrying where they lie in the fan (across, down) as uv.
function fanGeometry(segments: number, rings: number) {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      positions.push(0, 0, 0);
      uvs.push(s / segments, r / rings);
    }
  }
  const index: number[] = [];
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s;
      index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

// Where a corner of the fan lies, for a pose.
function fanPosition(tilt: any, yaw: any, at: any) {
  const frame = fanFrameNode(tilt, yaw);
  const angle = at.x.mul(2).sub(1).mul(HALF) as any;
  const range = at.y.mul(FAR - NEAR).add(NEAR) as any;
  return vec3(APEX.x, APEX.y, APEX.z).add(frame.down.mul(cos(angle)).add(frame.across.mul(sin(angle))).mul(range)) as any;
}

// Where in the atlas a point of a slot's tile is, kept half a texel in from the tile's edge.
function atlasUv(atlas: Atlas, slot: any, at: any) {
  const column = slot.mod(atlas.columns) as any;
  const row = slot.div(atlas.columns).floor() as any;
  const inTile = vec2(at.x.mul(atlas.lines - 1).add(0.5), at.y.mul(atlas.depth - 1).add(0.5)) as any;
  return vec2(column.mul(atlas.lines).add(inTile.x).div(atlas.lines * atlas.columns), row.mul(atlas.depth).add(inTile.y).div(atlas.depth * atlas.rows)) as any;
}

// Soft edges, so a slice has no hard outline: in from the sides, the far end, and the probe.
const edgeFade = (at: any) =>
  smoothstep(0, 0.06, at.x)
    .mul(smoothstep(0, 0.06, float(1).sub(at.x)))
    .mul(smoothstep(0, 0.1, float(1).sub(at.y))) as any;

// The live fan: the image redrawn by each pulse as it passes, the pulse itself as a bright arc travelling down, and
// the fan's outline and depth marks, faint, as a scanner draws them.
export function LiveFan({ atlas }: { atlas: Atlas }) {
  const parts = useMemo(() => {
    const geometry = fanGeometry(96, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // An unlit sheet of light seen from both faces: it has no normals to get wrong.
    const at = uv() as any;
    material.positionNode = fanPosition(view.tilt, view.yaw, attribute("uv", "vec2"));
    const sample = texture(atlas.texture, atlasUv(atlas, float(0), at)) as any;
    const range = at.y.mul(FAR - NEAR).add(NEAR) as any;
    // How long ago, in distance, the pulse passed this depth: the image is brightest just behind it.
    const since = fract(view.front.sub(range).div(view.trip)).mul(view.trip) as any;
    const refresh = exp(since.mul(-1.1)).mul(0.6).add(0.4) as any;
    const image = sample.r.add(sample.g).mul(2.4).sub(0.03).max(0).add(sample.b.mul(0.55)).mul(refresh).mul(view.gain) as any;
    const front = range.sub(view.front) as any;
    const arc = bell(front.div(0.016))
      .mul(0.5)
      .add(bell(front.div(0.14)).mul(0.08)) as any;
    // The outline: the two side lines and the far arc, and depth marks every quarter unit down the left side.
    const sideLine = bell(min(at.x, float(1).sub(at.x)).mul(HALF * 2).mul(range).div(0.009)).mul(0.08) as any;
    const tick = step(fract(range.div(0.25)), 0.03).mul(step(at.x, 0.022)).mul(0.5) as any;
    const near = exp(range.sub(NEAR).mul(-28)).mul(0.25) as any;
    const fade = edgeFade(at) as any;
    const glow = image
      .add(arc.mul(0.55))
      .mul(fade)
      .add(sideLine.add(tick).mul(smoothstep(0, 0.05, float(1).sub(at.y))))
      .add(near.mul(fade)) as any;
    material.colorNode = vec4(tint(glow.mul(0.9)).add(vec3(1, 1, 1).mul(arc.mul(0.06).mul(fade))), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [atlas]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The slices left behind, one instance per slot of the ring: each at the pose it was taken at, flaring as it is
// written and then fading over the trail. A spent slot folds to a point and draws nothing.
export function Trail({ atlas, poses }: { atlas: Atlas; poses: THREE.InstancedBufferAttribute }) {
  const parts = useMemo(() => {
    const count = atlas.slots - 1;
    const geometry = fanGeometry(64, 1);
    geometry.setAttribute("aPose", poses);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const pose = attribute("aPose", "vec4") as any;
    const age = view.now.sub(pose.z) as any;
    const live = step(0, pose.z) as any;
    const weightOf = (a: any) => exp(a.div(view.trail).negate()).mul(float(1).add(exp(a.mul(-5)).mul(1.6))).mul(live) as any;
    const vertexWeight = weightOf(view.now.sub(attribute("aPose", "vec4").z)) as any;
    const corner = fanPosition(pose.x, pose.y, attribute("uv", "vec2")) as any;
    material.positionNode = mix(vec3(APEX.x, APEX.y, APEX.z), corner, step(0.004, vertexWeight)) as any;
    const at = uv() as any;
    const sample = texture(atlas.texture, atlasUv(atlas, pose.w, at)) as any;
    const weight = weightOf(age) as any;
    const glow = sample.r.add(sample.g.mul(0.3)).mul(2.6).sub(0.07).max(0).mul(view.gain).mul(weight).mul(0.6).mul(edgeFade(at)) as any;
    material.colorNode = vec4(tint(max(glow, float(0))), 1) as any;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [atlas, poses]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
