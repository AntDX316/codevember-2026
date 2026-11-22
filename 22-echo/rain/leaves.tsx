"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, float, length, max, mix, normalWorld, smoothstep, varying } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { mulberry32 } from "../../shared/engine/random";
import { CLAP, DRIZZLE, clapAt, drizzleAt, echo, fieldAt } from "./echo";
import type { Garden } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The leaves of the shrubs and the tree: small diamond cards over each lumpy mass, each facing out from it with a little
// tilt of its own. A leaf is lit as one point, the way a scanner returns it: the echoes are read once at its middle,
// so the foliage flickers as a cloud of separate specks.
function makeLeaves(garden: Garden) {
  const count = garden.leaves.length / 6;
  const random = mulberry32(22_41);
  const position = new Float32Array(count * 4 * 3);
  const normal = new Float32Array(count * 4 * 3);
  const centre = new Float32Array(count * 4 * 4);
  const index = new Uint32Array(count * 6);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const b = new THREE.Vector3();
  const corner = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.fromArray(garden.leaves, i * 6);
    n.fromArray(garden.leaves, i * 6 + 3);
    // Tilted off the mass's normal, so the cards do not all lie flat to it, but never so far that one faces in.
    n.x += (random() - 0.5) * 0.6;
    n.y += (random() - 0.5) * 0.6;
    n.z += (random() - 0.5) * 0.6;
    n.normalize();
    // A frame across the card with t × b = n, turned at random about n.
    t.set(n.z, 0, -n.x);
    if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
    t.normalize().applyAxisAngle(n, random() * Math.PI * 2);
    b.crossVectors(n, t);
    const long = 0.017 + random() * 0.02;
    const wide = long * (0.45 + random() * 0.2);
    const shade = 0.25 + random() * random() * 0.9;
    // Round the diamond in increasing angle about n, so it winds to face along n.
    const corners: [number, number][] = [
      [-long, 0],
      [0, -wide],
      [long, 0],
      [0, wide]
    ];
    for (let k = 0; k < 4; k++) {
      corner.copy(p).addScaledVector(t, corners[k][0]).addScaledVector(b, corners[k][1]);
      corner.toArray(position, (i * 4 + k) * 3);
      n.toArray(normal, (i * 4 + k) * 3);
      centre.set([p.x, p.y, p.z, shade], (i * 4 + k) * 4);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("leafCentre", new THREE.BufferAttribute(centre, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();

  const material = new THREE.MeshBasicNodeMaterial();
  const light = varying(
    Fn(() => {
      const c = attribute("leafCentre", "vec4") as any;
      const n = attribute("normal", "vec3") as any;
      const px = length(cameraPosition.sub(c.xyz)).mul(echo.pixel) as any;
      const drizzle = drizzleAt(c.xyz, max(px, 0.01));
      const clap = clapAt(c.xyz, n, max(px, 0.01));
      const field = fieldAt(c.xyz);
      const shade = c.w as any;
      const cool = drizzle.glow.mul(0.8).add(drizzle.rings.mul(0.5)).add(field.mul(0.22)).mul(shade) as any;
      const white = clap.front.mul(1.6).add(clap.charge.mul(0.6)).mul(shade.add(0.3)) as any;
      const wake = clap.facing.mul(1.2).add(clap.wake.mul(0.35)).mul(shade) as any;
      const air = float(1).sub(smoothstep(4, 26, length(cameraPosition.sub(c.xyz)))).mul(0.8).add(0.2) as any;
      return DRIZZLE.mul(cool).add(CLAP.mul(white)).add(mix(DRIZZLE, CLAP, 0.45).mul(wake)).mul(air);
    })(),
    "vLeafLight"
  );
  material.colorNode = mix(light as any, normalWorld.mul(0.5).add(0.5), echo.normals) as any;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

export function Leaves({ garden }: { garden: Garden }) {
  const mesh = useMemo(() => makeLeaves(garden), [garden]);
  useDispose(mesh.geometry, mesh.material as THREE.Material);
  return <primitive object={mesh} />;
}
