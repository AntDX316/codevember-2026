"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraPosition, clamp, cos, cross, dot, exp, float, fract, length, max, mix, normalize, sin, smoothstep, varying, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { mulberry32 } from "../../shared/engine/random";
import { BASE, storm } from "./state";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Light reaching a point from every flash and the channel: the same falloffs the cloud uses, cheaper.
const flashAt = (p: any) => {
  let sum: any = storm.flash.mul(0.04);
  for (const ic of storm.ic) sum = sum.add(ic.w.mul(exp(length(p.sub(ic.xyz)).mul(-0.32)).mul(0.5)));
  const ab = storm.tip.xyz.sub(storm.top.xyz) as any;
  const h = clamp(dot(p.sub(storm.top.xyz), ab).div(dot(ab, ab).max(1e-4)), 0, 1);
  const ds = length(p.sub(storm.top.xyz).sub(ab.mul(h))) as any;
  return sum.add(storm.top.w.add(storm.tip.w).mul(float(2.2).div(ds.mul(ds).mul(0.9).add(1))));
};

// Rain under the cloud: thin streaks falling through the curtain, nearly invisible in the dark and caught bright by
// each flash. One quad a streak; where each falls is worked out from its seed and the clock, so nothing moves on the
// processor.
function makeRain(count: number) {
  const random = mulberry32(21_11);
  const seeds = new Float32Array(count * 4 * 4);
  const corners = new Float32Array(count * 4 * 2);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const seed = [random(), random(), random(), random()];
    for (let k = 0; k < 4; k++) {
      seeds.set(seed, (i * 4 + k) * 4);
      corners.set([k % 2 === 0 ? -1 : 1, k < 2 ? 0 : 1], (i * 4 + k) * 2);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("rainSeed", new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute("rainCorner", new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const drop = () => {
    const seed = attribute("rainSeed", "vec4") as any;
    const corner = attribute("rainCorner", "vec2") as any;
    const angle = seed.x.mul(Math.PI * 2);
    const radius = seed.y.mul(storm.rain.z).mul(1.1);
    const fall = fract(seed.z.add(storm.time.mul(seed.w.mul(0.35).add(1.6))));
    const y = float(BASE + 0.3).sub(fall.mul(BASE + 0.3)) as any;
    const spread = float(BASE).sub(y).mul(0.09).add(1) as any;
    const x = storm.rain.x.add(cos(angle).mul(radius).mul(spread)).add(float(BASE).sub(y).mul(0.12)) as any;
    const z = storm.rain.y.add(sin(angle).mul(radius).mul(spread)) as any;
    const head = vec3(x, y, z) as any;
    const eye = length(head.sub(cameraPosition)) as any;
    const width = max(float(0.006), eye.mul(storm.pixel).mul(0.6)) as any;
    return { seed, corner, head, y, width };
  };
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const fallDir = vec3(0.12, -1, 0).normalize();
  material.positionNode = Fn(() => {
    const { corner, head, width, seed } = drop();
    const side = normalize(cross(fallDir, storm.forward)) as any;
    return head.add(fallDir.mul(corner.y.mul(seed.w.mul(0.3).add(0.22)))).add(side.mul(corner.x).mul(width));
  })();
  const look = varying(
    Fn(() => {
      const { corner, head, y, width, seed } = drop();
      const fade = smoothstep(0.0, 0.4, y).mul(float(1).sub(smoothstep(BASE - 1.2, BASE + 0.2, y)));
      // Fewer toward the curtain's edge, and some much fainter than others.
      const edge = float(1).sub(smoothstep(0.5, 1.0, seed.y));
      const lit = flashAt(head).add(0.015).mul(fade).mul(edge).mul(seed.x.mul(0.7).add(0.3)).mul(float(0.006).div(width)).mul(storm.rain.w.min(1.4)).mul(0.5);
      return vec4(corner.x, corner.y, lit, 0);
    })(),
    "vRain"
  );
  material.colorNode = Fn(() => {
    const across = exp(look.x.mul(look.x).mul(-3));
    const along = sin(look.y.mul(Math.PI));
    return vec4(vec3(0.72, 0.76, 0.95).mul(across.mul(along).mul(look.z).mul(1.1)), 1);
  })();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return mesh;
}

// Motes: specks of spray and drizzle drifting in the air before the lens, soft and out of focus, unseen until the
// cloud flashes. They live in a box that travels with the eye and wraps, so they are always about.
function makeMotes(count: number) {
  const random = mulberry32(21_12);
  const seeds = new Float32Array(count * 4 * 4);
  const corners = new Float32Array(count * 4 * 2);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const seed = [random(), random(), random(), random()];
    for (let k = 0; k < 4; k++) {
      seeds.set(seed, (i * 4 + k) * 4);
      corners.set([k % 2 === 0 ? -1 : 1, k < 2 ? -1 : 1], (i * 4 + k) * 2);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("moteSeed", new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute("moteCorner", new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const mote = () => {
    const seed = attribute("moteSeed", "vec4") as any;
    const corner = attribute("moteCorner", "vec2") as any;
    // Across, up and ahead in the eye's frame, wrapped in a box 2.4 across, 1.6 high, from 0.7 to 4.5 ahead.
    const drift = storm.time.mul(seed.w.mul(0.05).add(0.02));
    const across = fract(seed.x.add(drift.mul(0.4)).add(sin(storm.time.mul(0.3).add(seed.y.mul(20))).mul(0.01)))
      .sub(0.5)
      .mul(2.4);
    const up = fract(seed.y.sub(drift)).sub(0.5).mul(1.6);
    const ahead = seed.z.mul(seed.z).mul(3.8).add(0.7);
    const centre = cameraPosition
      .add(storm.forward.mul(ahead))
      .add(storm.right.mul(across.mul(ahead.mul(0.6))))
      .add(storm.up.mul(up.mul(ahead.mul(0.6)))) as any;
    // Out of focus: nearer is bigger and fainter.
    const size = mix(float(0.006), float(0.026), seed.w.mul(seed.w)).mul(float(1).add(float(1).div(ahead).mul(0.5)));
    return { seed, corner, centre, ahead, size };
  };
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  material.positionNode = Fn(() => {
    const { corner, centre, size } = mote();
    return centre.add(storm.right.mul(corner.x.mul(size))).add(storm.up.mul(corner.y.mul(size)));
  })();
  const look = varying(
    Fn(() => {
      const { corner, seed, ahead } = mote();
      const bright = storm.flash.mul(0.012).add(0.0002).mul(seed.x.mul(0.8).add(0.4)).div(ahead.mul(0.5).add(0.6)) as any;
      return vec4(corner.x, corner.y, bright, 0);
    })(),
    "vMote"
  );
  material.colorNode = Fn(() => {
    const r = length(vec2(look.x, look.y));
    const disc = float(1)
      .sub(smoothstep(0.55, 1.0, r))
      .mul(abs(r).mul(0.25).add(0.75));
    return vec4(vec3(0.75, 0.8, 1.0).mul(disc.mul(look.z)), 1);
  })();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return mesh;
}

export function Rain({ drops, motes }: { drops: number; motes: number }) {
  const rain = useMemo(() => makeRain(drops), [drops]);
  const specks = useMemo(() => makeMotes(motes), [motes]);
  useDispose(rain.geometry, rain.material as THREE.Material, specks.geometry, specks.material as THREE.Material);
  return (
    <>
      <primitive object={rain} />
      <primitive object={specks} />
    </>
  );
}
