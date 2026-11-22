"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  Break,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  Discard,
  dot,
  exp,
  float,
  Fn,
  fract,
  fwidth,
  If,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { BALLS, balls, births, tails, BOUND, clock, ECHO_DELAY, ECHO_FALL, ECHOES, MELT, pings, SLOTS, SPEED, SWELL } from "./blob";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The palette, changed through uniforms: the bone of the contour lines and the one colour of the front.
export const palette = { bone: uniform(new THREE.Color("#efe6d6")), accent: uniform(new THREE.Color("#5ee0ff")) };
// A pixel's size at a distance of one, set each frame by the scene.
export const lens = { pixel: uniform(0.001) };
// 1 shows the surface's normals as colour, for checking they face out.
export const normalView = uniform(0);

// Contour lines every this far from where a ping left, every fifth a little heavier, as on a survey map.
const SPACING = 0.05;
const LINE = 0.0007;
const FRONT = 0.0035;

// Inlined rather than laid out as functions: a laid-out function lost its binding to the ball uniforms.
function makeField() {
const field = Fn(([p]: any[]) => {
  const d = float(1000).toVar() as any;
  Loop(BALLS, ({ i }: any) => {
    const b = balls.element(i) as any;
    const e = length(p.sub(b.xyz)).sub(b.w) as any;
    const h = clamp(float(0.5).add(d.sub(e).mul(0.5 / MELT)), 0, 1).toVar() as any;
    d.assign(mix(d, e, h).sub(h.mul(float(1).sub(h)).mul(MELT)));
  });
  const t = clock as any;
  const swell = sin(p.x.mul(3.1).add(t.mul(0.5))).mul(sin(p.y.mul(2.7).sub(t.mul(0.4)))).mul(sin(p.z.mul(2.9).add(t.mul(0.33)))).mul(SWELL) as any;
  return d.add(swell).mul(0.86);
}) as any;

const normalAt = Fn(([p]: any[]) => {
  const e = 0.0016;
  const a = vec3(e, -e, -e) as any;
  const b = vec3(-e, -e, e) as any;
  const c = vec3(-e, e, -e) as any;
  const d = vec3(e, e, e) as any;
  return normalize(a.mul(field(p.add(a))).add(b.mul(field(p.add(b)))).add(c.mul(field(p.add(c)))).add(d.mul(field(p.add(d)))));
}) as any;
return { field, normalAt };
}

// A line `width` either side of zero, smoothed over the pixel's footprint so it never stairsteps or shimmers.
const thin = (offset: any, width: any, fw: any) => float(1).sub(smoothstep(width, width.add(fw), abs(offset))).mul(width.div(width.add(fw.mul(0.5))));

// The form. Ink black and matte, nearly invisible: a ray is marched to it inside a sphere that bounds it. Each ping lights
// thin contour lines of distance from where it left, fixed in space so they slide over the morphing skin, bright at the
// front, which is a razor line of the accent with a soft halo, and fading slowly behind it. Two echoes follow each.
// The quality tier only changes how many steps a ray may take, through a uniform, so changing it never rebuilds the shader.
const MAX_STEPS = 110;
const stepLimit = uniform(MAX_STEPS);

export function Form({ steps }: { steps: number }) {
  stepLimit.value = steps;
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial();
    const { field, normalAt } = makeField();
    const depthOut = float(1).toVar("isolineDepth") as any;
    const shade = Fn(() => {
      const ro = cameraPosition as any;
      const toward = positionWorld.sub(cameraPosition) as any;
      const rd = normalize(toward).toVar() as any;
      const start = length(toward).sub(0.02).toVar() as any;
      const end = start.add(BOUND * 2 + 0.1) as any;
      const t = start.toVar() as any;
      const hit = float(0).toVar() as any;
      const last = float(1).toVar() as any;
      Loop(MAX_STEPS, ({ i }: any) => {
        If(float(i).greaterThanEqual(stepLimit), () => {
          Break();
        });
        last.assign(field(ro.add(rd.mul(t))));
        If(last.lessThan(t.mul(0.00025).add(0.0006)), () => {
          hit.assign(1);
          Break();
        });
        t.addAssign(last);
        If(t.greaterThan(end), () => {
          Break();
        });
      });
      // Out of steps while grazing the skin is a hit, or the silhouette frays.
      If(hit.lessThan(0.5).and(last.lessThan(0.006)).and(t.lessThan(end)), () => {
        hit.assign(1);
      });
      Discard(hit.lessThan(0.5));

      const p = ro.add(rd.mul(t)).toVar() as any;
      const n = normalAt(p).toVar() as any;
      const v = rd.negate() as any;
      const facing = max(dot(n, v), 0) as any;
      const fw = clamp(length(fwidth(p)), 0.0002, 0.08).toVar() as any;
      // Lines too close together for the pixels fade rather than shimmer.
      const legible = smoothstep(SPACING * 0.5, SPACING * 0.14, fw) as any;

      const fronts = float(0).toVar() as any;
      const halo = float(0).toVar() as any;
      const lines = float(0).toVar() as any;
      const wash = float(0).toVar() as any;
      Loop(SLOTS, ({ i }: any) => {
        const ping = pings.element(i) as any;
        const born = births.element(i) as any;
        const tail = tails.element(i) as any;
        // A slot long quiet costs nothing.
        If(clock.sub(born).lessThan(14), () => {
        const away = p.sub(ping.xyz) as any;
        const d = length(away).toVar() as any;
        const lit = max(dot(n, away.div(d.add(0.0001)).negate()), 0).mul(0.6).add(0.4) as any;
        const trail = float(0).toVar() as any;
        for (let k = 0; k < ECHOES; k++) {
          const age = clock.sub(born).sub(k * ECHO_DELAY) as any;
          const behind = age.mul(SPEED).sub(d) as any;
          const loud = ping.w
            .mul(ECHO_FALL ** k)
            .mul(step(0, age))
            .mul(exp(age.mul(-0.42)))
            .div(age.mul(SPEED * 0.22).add(1)) as any;
          fronts.addAssign(thin(behind, float(FRONT * (1 - k * 0.25)), fw).mul(loud));
          halo.addAssign(exp(abs(behind).mul(-18)).mul(loud).mul(lit));
          wash.addAssign(exp(abs(behind).mul(-5)).mul(loud).mul(lit));
          trail.addAssign(step(0, behind).mul(exp(behind.mul(tail).negate())).mul(loud));
        }
        // Distance from the ping in lines; every fifth is a major.
        const ring = d.div(SPACING) as any;
        const offset = fract(ring.add(0.5)).sub(0.5).mul(SPACING) as any;
        const major = step(fract(ring.add(0.5).div(5)), 0.2) as any;
        const width = float(LINE).mul(major.mul(0.7).add(1)) as any;
        lines.addAssign(thin(offset, width, fw).mul(major.mul(0.8).add(1)).mul(trail));
        });
      });

      const key = normalize(vec3(-0.5, 0.75, 0.45)) as any;
      const ink = vec3(0.012, 0.013, 0.017).mul(max(dot(n, key), 0).mul(0.8).add(0.25)) as any;
      const rim = pow(float(1).sub(facing), 4).mul(0.05) as any;
      const bone = vec3(palette.bone as any) as any;
      const accent = vec3(palette.accent as any) as any;
      const colour = ink
        .add(bone.mul(rim))
        .add(accent.mul(wash.mul(0.05)))
        .add(accent.mul(halo.mul(0.7)))
        .add(bone.mul(lines.mul(legible).mul(1.5)))
        .add(mix(accent, vec3(1), 0.4).mul(fronts.mul(min(legible.add(0.4), 1)).mul(9))) as any;

      const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1)) as any;
      depthOut.assign(min(clip.z.div(clip.w), float(0.99999)));
      return mix(min(colour, vec3(24)), n.mul(0.5).add(0.5), normalView);
    });
    m.colorNode = shade() as any;
    m.depthNode = depthOut;
    return m;
  }, []);
  useDispose(material);
  return (
    <mesh material={material} raycast={() => null} frustumCulled={false}>
      <sphereGeometry args={[BOUND + 0.03, 48, 32]} />
    </mesh>
  );
}

// Called with the scene's depth once the overlay pass exists, so what is drawn there hides behind the form.
function useOverlay(build: (sceneZ: any) => void) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built once; the builder closes over memoised objects.
    []
  );
}

// Fine dust hanging in the dark round the form, barely there until a front passes through it and it sparkles.
export function Dust({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(2207);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // In a shell round the form, thicker near it.
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = 1.35 + Math.pow(random(), 1.6) * 4.2;
      const s = Math.sqrt(1 - u * u);
      seeds.set([Math.cos(a) * s * r, u * r * 0.8, Math.sin(a) * s * r], i * 4);
      seeds[i * 4 + 3] = random();
    }
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

  useOverlay((sceneZ) => {
    const s = attribute("aSeed", "vec4") as any;
    const t = clock as any;
    const drift = vec3(sin(t.mul(0.05).add(s.w.mul(40))), sin(t.mul(0.037).add(s.w.mul(17))), sin(t.mul(0.043).add(s.w.mul(29)))).mul(0.12) as any;
    const centre = s.xyz.add(drift) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(centre)) as any;

    const spark = float(0).toVar() as any;
    const glow = float(0).toVar() as any;
    Loop(SLOTS, ({ i }: any) => {
      const ping = pings.element(i) as any;
      const born = births.element(i) as any;
      const d = length(centre.sub(ping.xyz)) as any;
      for (let k = 0; k < ECHOES; k++) {
        const age = clock.sub(born).sub(k * ECHO_DELAY) as any;
        const behind = age.mul(SPEED).sub(d) as any;
        const loud = ping.w
          .mul(ECHO_FALL ** k)
          .mul(step(0, age))
          .mul(exp(age.mul(-0.42))) as any;
        spark.addAssign(exp(behind.mul(behind).mul(-160)).mul(loud));
        glow.addAssign(step(0, behind).mul(exp(behind.mul(-2.2))).mul(loud));
      }
    });
    const twinkle = sin(t.mul(s.w.mul(2.1).add(0.6)).add(s.w.mul(90)))
      .mul(0.35)
      .add(0.65) as any;
    const heard = min(spark.mul(5).add(glow.mul(0.3)), 7) as any;
    const radius = lens.pixel.mul(away).mul(s.w.mul(1.1).add(0.9)).mul(heard.mul(0.35).add(1)) as any;
    parts.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    const bone = vec3(palette.bone as any) as any;
    const accent = vec3(palette.accent as any) as any;
    const light = bone.mul(0.09).mul(twinkle).add(mix(bone, accent, 0.6).mul(heard.mul(1.3))) as any;
    const colour = varying(light) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = float(1).sub(smoothstep(0.12, 0.5, r)) as any;
    parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}
