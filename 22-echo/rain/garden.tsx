"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, exp, float, length, max, min, mix, mx_noise_float, normalWorld, positionWorld, sin, smoothstep, vec2, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { CLAP, DRIZZLE, clapAt, drizzleAt, echo, fieldAt } from "./echo";
import { KIND, type Garden } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const hash = (v: any) => sin(v.dot(vec2(127.1, 311.7))).mul(43758.5453).fract() as any;
const is = (kind: any, k: number) => kind.sub(k).abs().lessThan(0.5).select(1, 0) as any;

// The garden's one material. It has no light of its own: a surface shows only where an echo is passing, as thin rings
// where the drops' shells cross it, its edges and joints lit round where each drop fell, and, behind a clap's front, its
// whole face for a moment before it falls dark again.
function makeMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const p = positionWorld as any;
    const n = normalWorld as any;
    const dist = length(cameraPosition.sub(p)) as any;
    const px = dist.mul(echo.pixel) as any;
    const face = attribute("face", "vec4") as any;
    const kind = attribute("kind", "float") as any;

    // How near the face's edge: one at the edge, falling to nothing over a few millimetres (never under a pixel or so).
    const toEdge = min(min(face.x, face.z.sub(face.x)), min(face.y, face.w.sub(face.y))) as any;
    const edge = float(1).sub(smoothstep(0, max(px.mul(1.4), 0.006), toEdge)) as any;

    // Joints between bricks: courses 75 mm high, every other one set over by half a brick.
    const course = face.y.div(0.075) as any;
    const across = face.x.add(course.floor().mod(2).mul(0.115)).div(0.23) as any;
    const toJoint = min(float(0.5).sub(course.fract().sub(0.5).abs()).mul(0.075), float(0.5).sub(across.fract().sub(0.5).abs()).mul(0.23)) as any;
    const joint = float(1).sub(smoothstep(0.004, max(px.mul(1.2), 0.004).add(0.004), toJoint)).mul(is(kind, KIND.brick)) as any;

    // Points, as a scanner leaves them: a jittered grid 25 mm apart on whichever plane the face lies nearest, blending to
    // an even tone once they are too small to tell apart.
    const an = n.abs() as any;
    const flat = an.y.greaterThan(an.x.max(an.z)).select(p.xz, an.x.greaterThan(an.z).select(p.zy, p.xy)) as any;
    const grid = flat.div(0.025) as any;
    const id = grid.floor() as any;
    const jitter = vec2(hash(id), hash(id.add(17.3))).sub(0.5).mul(0.5) as any;
    const dotSize = max(px.mul(0.9), 0.0035) as any;
    const dot = float(1).sub(smoothstep(dotSize.mul(0.4), dotSize, length(grid.fract().sub(0.5).sub(jitter)).mul(0.025))) as any;
    const dots = mix(float(0.55), dot.mul(2.2), smoothstep(2.5, 6, float(0.025).div(px))) as any;

    // The grain of each material, as a passing echo shows it: leaves only as their scattered points, the rest as gravel,
    // stone and wood under a soft mottle.
    const leaf = is(kind, KIND.leaf);
    const grit = mx_noise_float(p.mul(7)).mul(0.5).add(0.5) as any;
    const leafy = dots.mul(grit.mul(0.8).add(0.4)).mul(leaf) as any;
    const tex = grit.mul(0.6).add(0.4).mul(float(1).sub(leaf)).add(leafy.mul(0.8)) as any;

    const drizzle = drizzleAt(p, px);
    const field = fieldAt(p);
    const clap = clapAt(p, n, px);

    // The far roofs barely catch the drizzle; the masses under the leaves only faintly, behind their own leaves.
    const dim = is(kind, KIND.far).mul(0.6).oneMinus().mul(leaf.mul(-0.7).add(1)) as any;
    const outline = edge.mul(1.6).add(joint.mul(0.7)).add(leafy.mul(0.35)) as any;
    const sketch = drizzle.rings
      .mul(mix(float(1), dots, 0.8))
      .mul(tex.mul(0.5).add(0.5))
      .mul(0.3)
      .add(drizzle.glow.mul(outline.add(0.02)))
      .add(field.mul(outline.mul(0.8).add(dots.mul(0.025)))) as any;
    // The front itself, white; the wake behind it, cooler, mostly points and edges.
    const front = clap.front.mul(edge.mul(3).add(tex.mul(1.4))).add(clap.charge.mul(edge.mul(0.5).add(0.6))) as any;
    // The far roofs show more by their edges than their faces.
    const wake = clap.facing
      .mul(tex)
      .mul(dots.mul(0.9).add(0.06))
      .mul(is(kind, KIND.far).mul(-0.65).add(1).mul(1.3))
      .add(clap.wake.mul(edge.mul(2.4).add(joint.mul(1.0)).add(leafy.mul(0.5))))
      .add(clap.ripples.mul(0.6)) as any;
    // A little air between the eye and anything far, so depth reads; the roofs beyond keep more of the clap.
    const air = exp(dist.mul(-0.045)).max(is(kind, KIND.far).mul(0.35)) as any;
    return DRIZZLE.mul(sketch.mul(dim).mul(1.9))
      .add(CLAP.mul(front))
      .add(mix(DRIZZLE, CLAP, 0.45).mul(wake).mul(leaf.mul(-0.6).add(1)))
      .mul(air)
      .add(vec3(0.0016, 0.002, 0.0028).mul(n.y.max(0)))
      .mul(echo.normals.oneMinus())
      .add(n.mul(0.5).add(0.5).mul(echo.normals));
  })();
  return material;
}

export function GardenMesh({ garden }: { garden: Garden }) {
  const material = useMemo(makeMaterial, []);
  useDispose(material);
  return <mesh geometry={garden.geometry} material={material} frustumCulled={false} />;
}
