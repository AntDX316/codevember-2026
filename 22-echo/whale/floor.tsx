"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { Fn, attribute, cameraPosition, exp, length, max, mix, normalize, positionWorld, varying, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { echo, lines, revealAt, waterColour } from "./pulses";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The floor of the deep: a plain of long sediment dunes that slopes away ahead, a reef wall rising on the right, low
// rocky outcrops, and past them the edge of a drop into the abyss. Worked out here once, so the scene can find where a
// tap lands on it and where the echoes come back from.

const noise = new ImprovedNoise();
const fbm = (x: number, z: number, octaves: number) => {
  let sum = 0;
  let amp = 1;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise.noise(x * f, z * f, 1.7 + i * 3.1) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Where the reef wall runs: x along it as it goes back.
const wallX = (z: number) => 58 + z * 0.12 + Math.sin(z * 0.035) * 5;
// Where the floor drops away into the abyss, ahead.
const edgeZ = (x: number) => -128 + Math.sin(x * 0.021 + 1) * 18 + Math.sin(x * 0.07) * 4;

export function floorHeight(x: number, z: number) {
  // A plain sloping gently down and away.
  let h = -24 + z * 0.045 + fbm(x * 0.008, z * 0.008, 3) * 6;
  // Long dunes in the sediment, bending with the slow current.
  const along = x * 0.82 + z * 0.57 + fbm(x * 0.01, z * 0.01, 2) * 14;
  h += Math.sin(along * 0.62) * 0.45 * (0.6 + 0.4 * noise.noise(x * 0.02, 0.5, z * 0.02));
  // Rock outcrops: ridged noise, kept to patches.
  const ridge = 1 - Math.abs(fbm(x * 0.025, z * 0.025, 4));
  const patch = smooth(0.05, 0.4, noise.noise(x * 0.012, 7.3, z * 0.012));
  h += ridge * ridge * ridge * 5.5 * patch;
  // The reef wall: a steep face toward the plain, broken into buttresses, and a rough top falling away behind.
  const w = wallX(z) + fbm(x * 0.03, z * 0.03, 3) * 7 + fbm(x * 0.09, z * 0.09, 2) * 2.5;
  const face = smooth(w - 6, w + 4, x);
  const crest = 1 - Math.abs(fbm(x * 0.05 + 9, z * 0.05, 4));
  const wall = face * (15 + crest * 7 + fbm(x * 0.12, z * 0.12, 2) * 2) * (1 - smooth(w + 30, w + 60, x) * 0.5);
  h += wall;
  // The drop into the abyss, far ahead.
  const e = edgeZ(x) + fbm(x * 0.05, 3, 3) * 6;
  h -= smooth(e, e - 40, z) * 70;
  return h;
}

export function floorNormal(x: number, z: number, out: THREE.Vector3) {
  const e = 0.35;
  const dx = floorHeight(x + e, z) - floorHeight(x - e, z);
  const dz = floorHeight(x, z + e) - floorHeight(x, z - e);
  return out.set(-dx, 2 * e, -dz).normalize();
}

// The floor's extent: wide enough that its edge is lost in the dark from anywhere the camera can go.
const CENTRE = new THREE.Vector2(0, -90);
const SIZE = 460;

function buildFloor(cells: number) {
  const n = cells + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const normal = new THREE.Vector3();
  // Finer toward the camera's corner of the floor: spacing grows with distance from the near middle.
  const spread = (t: number) => Math.sign(t) * Math.pow(Math.abs(t), 1.35);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = CENTRE.x + spread(i / cells * 2 - 1) * SIZE * 0.5;
      // Rows from the near edge (behind the camera) to the far one, closer together near the camera.
      const v = j / cells;
      const z = 40 - Math.pow(v, 1.3) * SIZE;
      const k = (j * n + i) * 3;
      positions[k] = x;
      positions[k + 1] = floorHeight(x, z);
      positions[k + 2] = z;
      floorNormal(x, z, normal);
      normals.set([normal.x, normal.y, normal.z], k);
    }
  // Rows run toward -z as j grows, columns toward +x as i grows: (i, j), (i + 1, j), (i, j + 1) winds anticlockwise
  // seen from above, so the faces look up.
  const index: number[] = [];
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

// Lit only by the calls: in the dark it is all but invisible, the faintest trace of the light from above on its upper
// faces. As a front passes it draws itself in contour lines and the rings of the front, which linger and fade.
export function floorMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  const N = varying(attribute("normal", "vec3")) as any;
  material.colorNode = Fn(() => {
    const P = positionWorld as any;
    const toEye = cameraPosition.sub(P) as any;
    const dist = length(toEye) as any;
    const n = normalize(N) as any;
    const contour = lines(P.y, 1.25, 1.2) as any;
    const fine = lines(P.y, 0.25, 0.8).mul(0.25) as any;
    const pattern = (d: any) => max(contour, lines(d, 3.2, 1).mul(0.55)).add(fine);
    const glow = revealAt(P, pattern, 0.22, 1.6) as any;
    // The faint light from far above on the faces turned to it, and nothing below.
    const above = max(n.y, 0).mul(exp(P.y.div(60))).mul(0.006) as any;
    const keep = exp(dist.div(-55)) as any;
    const water = waterColour(toEye.negate().div(dist)) as any;
    const rgb = mix(water, echo.water.mul(above.mul(40)), keep).add(glow.mul(exp(dist.div(-210)))) as any;
    return vec4(rgb, 1);
  })() as any;
  return material;
}

export function Floor({ cells }: { cells: number }) {
  const { mesh, geometry, material } = useMemo(() => {
    const geometry = buildFloor(cells);
    const material = floorMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "floor";
    return { mesh, geometry, material };
  }, [cells]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}
