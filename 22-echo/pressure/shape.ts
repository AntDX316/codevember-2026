import * as THREE from "three/webgpu";
import { dot, exp, float, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The hidden core: a sphere swollen by a few soft lobes that wander over it, so it reads as a cluster of metaballs slowly
// melting into one another. Its surface is a radius for every direction, which the dust, the echoes and the mesh all share.

export const CORE = 0.3;
export const LOBES = 6;
// How tight each lobe is: higher is a narrower, rounder bump.
const TIGHT = 3.4;

// Each lobe's direction and how far it swells, as uniforms the frame updates.
export function createShape() {
  const lobes = Array.from({ length: LOBES }, () => ({ dir: uniform(new THREE.Vector3(0, 1, 0)), size: uniform(0) }));
  // Each lobe turns about its own axis at its own pace, and breathes.
  const paths = Array.from({ length: LOBES }, (_, i) => {
    const axis = new THREE.Vector3(Math.sin(i * 2.4), Math.cos(i * 1.7), Math.sin(i * 3.1 + 1)).normalize();
    const start = new THREE.Vector3(Math.cos(i * 2.1), Math.sin(i * 1.3 + 0.5), Math.cos(i * 0.9 + 2)).normalize();
    return { axis, start, pace: 0.07 + ((i * 0.37) % 1) * 0.09, size: 0.3 + ((i * 0.61) % 1) * 0.35, breath: 0.2 + i * 0.07 };
  });
  const turned = new THREE.Vector3();
  const update = (clock: number) => {
    paths.forEach((p, i) => {
      turned.copy(p.start).applyAxisAngle(p.axis, clock * p.pace + i);
      lobes[i].dir.value.copy(turned);
      lobes[i].size.value = p.size * (0.8 + 0.2 * Math.sin(clock * p.breath + i * 1.9));
    });
  };
  update(0);

  // The same surface on the processor, for where a ping meets the core.
  const radius = (dir: THREE.Vector3) => {
    let r = 1;
    for (const lobe of lobes) {
      r += lobe.size.value * Math.exp((dir.dot(lobe.dir.value) - 1) * TIGHT);
    }
    return r * CORE;
  };

  // The radius of the surface along a unit direction, written out in place: as a shader function, a vertex stage lost
  // track of the uniforms it reads.
  const radiusNode = (dir: any) => {
    let r = float(1) as any;
    for (const lobe of lobes) r = r.add((lobe.size as any).mul(exp(dot(dir, lobe.dir as any).sub(1).mul(TIGHT))));
    return r.mul(CORE) as any;
  };

  return { lobes, update, radius, radiusNode };
}

export type Shape = ReturnType<typeof createShape>;
