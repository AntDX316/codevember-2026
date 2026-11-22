"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, cos, dot, exp, float, max, mix, normalize, pow, positionWorld, reflect, sin, smoothstep, sqrt, uniform, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { clock, surface } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export const RADIUS = 1;

// The finishes: how much each colour reflects head on, and how much of the oil film shows.
export const FINISHES: Record<string, { label: string; swatch: string[]; f0: [number, number, number]; film: number; body: number }> = {
  mercury: { label: "Mercury", swatch: ["#f2f4f7", "#a9afba", "#4b5059"], f0: [0.78, 0.79, 0.81], film: 0, body: 0 },
  oil: { label: "Oil", swatch: ["#e2b04f", "#c23d8e", "#2f6fd6"], f0: [0.62, 0.62, 0.65], film: 1, body: 0 },
  obsidian: { label: "Obsidian", swatch: ["#2a2d36", "#0b0c10", "#000000"], f0: [0.05, 0.05, 0.055], film: 0.18, body: 1 }
};

export const look = {
  f0: uniform(new THREE.Vector3(...FINISHES.mercury.f0)) as any,
  film: uniform(FINISHES.mercury.film) as any,
  body: uniform(FINISHES.mercury.body) as any,
  // 1 draws the normals as colour, for checking them.
  debug: uniform(0) as any
};

// A cube with every face cut into a grid and pushed out onto the sphere by equal angles, so the cells are close to even.
// Indexed: one vertex per point, shared by its six triangles. The faces' edges repeat their points, which land in exactly
// the same place since the height is a function of direction alone.
function sphereGrid(cells: number) {
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)],
    [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)]
  ];
  const side = cells + 1;
  const positions = new Float32Array(6 * side * side * 3);
  const index = new Uint32Array(6 * cells * cells * 6);
  const p = new THREE.Vector3();
  let v = 0;
  let t = 0;
  faces.forEach(([out, right, up], f) => {
    for (let y = 0; y <= cells; y++) {
      for (let x = 0; x <= cells; x++) {
        const a = Math.tan(((x / cells) * 2 - 1) * (Math.PI / 4));
        const b = Math.tan(((y / cells) * 2 - 1) * (Math.PI / 4));
        p.copy(out).addScaledVector(right, a).addScaledVector(up, b).normalize();
        positions.set([p.x, p.y, p.z], v * 3);
        v++;
      }
    }
    const first = f * side * side;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const k = first + y * side + x;
        // right × up = out on every face, so this winding faces outward.
        index.set([k, k + 1, k + side + 1, k, k + side + 1, k + side], t);
        t += 6;
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS * 1.3);
  return geometry;
}

// The room the drop reflects, all maths: near black, a big warm softbox above and in front, a tall cool strip to the
// right and a thin warm one behind to the left, so the rim always catches. Soft-edged, as soft light is.
export function room(r: any, seen = false) {
  const panel = (centre: [number, number, number], upHint: [number, number, number], halfW: number, halfH: number, soft: number) => {
    const c = vec3(...centre).normalize() as any;
    const across = normalize(vec3(...upHint).cross(c)) as any;
    const upward = c.cross(across) as any;
    const along = max(dot(r, c), float(0.001)) as any;
    const x = abs(dot(r, across).div(along)) as any;
    const y = abs(dot(r, upward).div(along)) as any;
    const inside = float(1).sub(smoothstep(halfW - soft, halfW + soft, x)).mul(float(1).sub(smoothstep(halfH - soft, halfH + soft, y))) as any;
    return inside.mul(smoothstep(0, 0.15, dot(r, c)));
  };
  const key = panel([-0.35, 0.85, 0.45], [0, 0, -1], 0.5, 0.34, 0.05) as any;
  const strip = panel([1, 0.1, 0.1], [0, 1, 0], 0.06, 1.1, 0.025) as any;
  const left = panel([-1, 0.05, 0.35], [0, 1, 0], 0.035, 0.9, 0.02) as any;
  const rim = panel([-0.55, 0.2, -0.85], [0, 1, 0], 0.05, 1, 0.03) as any;
  // A row of small panels behind the eye, which the face of the drop turned to it mirrors.
  const row = panel([0.08, 0.1, 1], [0, 1, 0], 0.11, 0.075, 0.015).add(panel([-0.24, 0.1, 1], [0, 1, 0], 0.11, 0.075, 0.015)).add(panel([0.4, 0.1, 1], [0, 1, 0], 0.11, 0.075, 0.015)) as any;
  const horizon = float(1).sub(smoothstep(0, 0.22, abs(r.y.add(0.04)))) as any;
  // The cyclorama's edge: a thin bright line all round, which the waves wobble wherever they pass.
  const edge = float(1).sub(smoothstep(0.004, 0.03, abs(r.y.add(0.04)))) as any;
  // Long lights across the ceiling, so every part of the upper half has lines in it for the waves to bend.
  const up = max(r.y, float(0.02)) as any;
  const across = r.z.div(up) as any;
  const along = r.x.div(up) as any;
  const lines = pow(cos(across.mul(4.2)).mul(0.5).add(0.5), float(10)) as any;
  const ceiling = lines.mul(smoothstep(0.08, 0.35, r.y)).mul(float(1).div(along.mul(along).mul(0.08).add(1))) as any;
  const floor = mix(vec3(0.012, 0.011, 0.01), vec3(0.02, 0.022, 0.028), smoothstep(-0.6, 0.9, r.y)) as any;
  // A soft pool of light on the floor far below.
  const pool = smoothstep(-0.55, -0.95, r.y) as any;
  const glow = pow(max(dot(r, vec3(-0.35, 0.85, 0.45).normalize()), float(0)), float(4)).mul(0.12) as any;
  return floor
    .add(vec3(0.09, 0.085, 0.08).mul(horizon))
    .add(vec3(0.16, 0.15, 0.14).mul(pool))
    .add(vec3(0.75, 0.72, 0.68).mul(edge).mul(seen ? 0 : 1))
    .add(vec3(0.85, 0.88, 0.95).mul(ceiling.mul(0.75)))
    .add(vec3(1, 0.88, 0.76).mul(key.mul(3.4).add(glow)))
    .add(vec3(0.74, 0.85, 1).mul(strip.mul(2.8)))
    .add(vec3(1, 0.9, 0.8).mul(left.mul(1.6)))
    .add(vec3(1, 0.78, 0.6).mul(rim.mul(2.4)))
    .add(vec3(0.8, 0.85, 0.95).mul(row.mul(0.9)));
}

// The drop. Its shape is moved on the GPU from the wave table each frame; every pixel works out its own normal from the
// table's slopes, so ripples finer than the mesh still bend the reflections.
export function Blob({ cells }: { cells: number }) {
  const geometry = useMemo(() => sphereGrid(cells), [cells]);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial();
    const built = attribute("position", "vec3") as any;
    m.positionNode = built.mul(surface(built, false).height.add(1).mul(RADIUS)) as any;

    const n = normalize(varying(attribute("position", "vec3"))) as any;
    const { height, grad } = surface(n, true);
    // r = R(1 + h(n)) n has its normal along (1 + h) n − ∇h.
    const normal = normalize(n.mul(height.add(1)).sub(grad)).toVar() as any;
    const view = normalize(cameraPosition.sub(positionWorld)).toVar() as any;
    const facing = clamp(dot(normal, view), 0, 1).toVar() as any;
    const bounce = reflect(view.negate(), normal) as any;
    const fresnel = look.f0.add(vec3(1).sub(look.f0).mul(pow(float(1).sub(facing), float(5)))) as any;

    // An oil film whose thickness swirls slowly over the drop and swells on the flanks of each wave.
    const swirl = sin(n.x.mul(2.3).add(clock.mul(0.05))).mul(sin(n.y.mul(1.9).sub(n.z.mul(1.4)).add(clock.mul(0.04)))) as any;
    // The film follows the slope of the waves rather than their height, so the slow wobble of the whole drop leaves its
    // colours be and only the rings carry bands.
    const thickness = float(0.42).add(swirl.mul(0.2)).add(grad.length().mul(0.5)) as any;
    const inside = sqrt(float(1).sub(float(1).sub(facing.mul(facing)).div(1.96))) as any;
    const path = thickness.mul(inside).mul(2.8 * Math.PI * 2) as any;
    const film = vec3(cos(path.div(0.65)), cos(path.div(0.53)), cos(path.div(0.45))).mul(-0.5).add(0.5) as any;
    const tint = mix(vec3(1), film.mul(1.45).add(0.12), look.film.mul(0.82)) as any;

    const mirror = room(bounce).mul(fresnel).mul(tint) as any;
    // Obsidian's body: a faint smoky depth under the glass.
    const depth = vec3(0.012, 0.013, 0.02).mul(exp(facing.mul(-2))).mul(look.body) as any;
    const colour = mirror.add(depth) as any;
    // Debug 1: normals as colour; 2: height (red up, blue down) and slope (green).
    const probe = look.debug.greaterThan(1.5).select(vec3(height.mul(25).max(0), grad.length().mul(3), height.mul(-25).max(0)), normal.mul(0.5).add(0.5)) as any;
    m.colorNode = vec4((mix as any)(colour, probe, look.debug.min(1)), 1) as any;
    return m;
  }, []);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// The dark room itself, very dim, so the drop hangs in space but its lights are faintly there. Without the cyclorama's
// edge, which would read as a horizon line across the void.
export function Backdrop() {
  const parts = useMemo(() => {
    const sphere = new THREE.SphereGeometry(40, 48, 24);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const dir = normalize(positionWorld.sub(cameraPosition)) as any;
    material.colorNode = vec4(room(dir, true).mul(0.035), 1) as any;
    return { sphere, material };
  }, []);
  useDispose(parts.sphere, parts.material);
  return <mesh geometry={parts.sphere} material={parts.material} renderOrder={-1} frustumCulled={false} />;
}
