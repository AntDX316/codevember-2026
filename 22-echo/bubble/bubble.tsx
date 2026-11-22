"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, dot, float, max, mix, normalize, pow, positionWorld, reflect, smoothstep, texture, uniform, varying, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { filmTable, SCALE, type Field } from "./film";
import { hold, membrane, unpack } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export const RADIUS = 1;

// 1 draws the normals as colour, 2 the film's thickness, for checking them.
export const debug = uniform(0) as any;

// A cube with every face cut into a grid and pushed out onto the sphere by equal angles, so the cells are close to even.
// The faces' edges repeat their points, which land in exactly the same place since the shape is a function of direction.
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

// The studio the bubble mirrors, all maths: near black, a big warm softbox up to the left, a tall cool strip to the right,
// a dim wide card behind the eye that fills the bubble's face with faint colour, and a warm rim light behind.
const KEY = [-0.5, 0.72, 0.48] as const;
export function studio(r: any, scale = 1) {
  const panel = (centre: readonly [number, number, number], upHint: [number, number, number], halfW: number, halfH: number, soft: number) => {
    const c = vec3(...centre).normalize() as any;
    const across = normalize(vec3(...upHint).cross(c)) as any;
    const upward = c.cross(across) as any;
    const along = max(dot(r, c), float(0.001)) as any;
    const x = abs(dot(r, across).div(along)) as any;
    const y = abs(dot(r, upward).div(along)) as any;
    const inside = float(1).sub(smoothstep(halfW - soft, halfW + soft, x)).mul(float(1).sub(smoothstep(halfH - soft, halfH + soft, y))) as any;
    return inside.mul(smoothstep(0, 0.2, dot(r, c)));
  };
  const key = panel(KEY, [0, 0, -1], 0.52, 0.36, 0.12) as any;
  const keyCore = panel(KEY, [0, 0, -1], 0.4, 0.26, 0.06) as any;
  const strip = panel([1, 0.08, -0.15], [0, 1, 0], 0.07, 1.2, 0.05) as any;
  const rim = panel([-0.45, 0.25, -0.86], [0, 1, 0], 0.09, 0.9, 0.06) as any;
  const card = panel([0.12, 0.05, 1], [0, 1, 0], 0.9, 0.7, 0.5) as any;
  const glow = pow(max(dot(r, vec3(...KEY).normalize()), float(0)), float(3)) as any;
  const dome = mix(vec3(0.004, 0.0045, 0.006), vec3(0.03, 0.032, 0.04), smoothstep(-0.7, 0.9, r.y)) as any;
  return dome
    .add(vec3(1, 0.93, 0.85).mul(key.mul(1.6).add(keyCore.mul(2.2)).add(glow.mul(0.12))))
    .add(vec3(0.72, 0.84, 1).mul(strip.mul(2.2)))
    .add(vec3(1, 0.8, 0.62).mul(rim.mul(1.7)))
    .add(vec3(0.6, 0.64, 0.72).mul(card.mul(0.045)))
    .mul(scale);
}

// The bubble: its far wall from inside, then its near wall, both added over the void as a film reflects and lets the
// rest through. Shape and normals from the membrane, colour from the film's thickness under it.
export function Bubble({ cells, field }: { cells: number; field: Field }) {
  const geometry = useMemo(() => sphereGrid(cells), [cells]);
  const table = useMemo(() => filmTable(), []);
  const materials = useMemo(() => {
    const make = (inside: boolean) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: inside ? THREE.BackSide : THREE.FrontSide });
      const built = attribute("position", "vec3") as any;
      m.positionNode = built.mul(unpack(built, membrane(built)).height.add(1).mul(RADIUS)) as any;

      const n = normalize(varying(attribute("position", "vec3"))).toVar() as any;
      const wave = unpack(n, membrane(n));
      // r = R(1 + h(n)) n has its normal along (1 + h) n − ∇h; seen from inside, the other way.
      const outward = normalize(n.mul(wave.height.add(1)).sub(wave.grad)).toVar() as any;
      const normal = inside ? outward.negate() : outward;
      const view = normalize(cameraPosition.sub(positionWorld)).toVar() as any;
      const facing = clamp(dot(normal, view), 0, 1).toVar() as any;
      const bounce = reflect(view.negate(), normal) as any;

      // The film: the drained, swirled field, squeezed and stretched by the passing ring, gathered by a held tone.
      const pattern = hold.pattern(n).value.mul(hold.level).toVar() as any;
      const tone = pattern.mul(0.3) as any;
      const thick = max(field.sample(n).mul(wave.ring.mul(0.75).add(1)).add(wave.ring.mul(0.1)).add(tone), float(0)).toVar() as any;
      const colour = texture(table.texture, vec2(thick.mul(SCALE / table.most), facing)).rgb as any;
      const light = studio(bounce) as any;
      // A little more than physics gives, so the colours read against the dark, and a faint sheen of them everywhere.
      // The passing ring catches the light a little, so it reads as a band of colour racing round.
      const glint = abs(wave.ring).mul(inside ? 3 : 5.5).add(abs(pattern).mul(inside ? 1 : 1.8)).add(inside ? 0.03 : 0.04) as any;
      const gain = mix(float(inside ? 2 : 3.4), float(1.3), pow(float(1).sub(facing), float(4))) as any;
      const lit = light.mul(colour).mul(gain).add(colour.mul(glint)) as any;
      const probe = debug.greaterThan(2.5).select(vec3(wave.ring.max(0), wave.height.abs().mul(30), wave.ring.negate().max(0)), debug.greaterThan(1.5).select(vec3(thick), normal.mul(0.5).add(0.5))) as any;
      m.colorNode = vec4((mix as any)(lit, inside ? vec3(0) : probe, debug.min(1)), 1) as any;
      return m;
    };
    return { back: make(true), front: make(false) };
  }, [field, table]);
  useDispose(geometry, materials.back, materials.front, table.texture);
  return (
    <>
      <mesh geometry={geometry} material={materials.back} renderOrder={1} frustumCulled={false} />
      <mesh geometry={geometry} material={materials.front} renderOrder={2} frustumCulled={false} />
    </>
  );
}

// The dark studio itself, barely there, so the bubble hangs in a void with only the faintest sense of the room.
export function Backdrop() {
  const parts = useMemo(() => {
    const sphere = new THREE.SphereGeometry(40, 48, 24);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const dir = normalize(positionWorld.sub(cameraPosition)) as any;
    material.colorNode = vec4(studio(dir, 0.02), 1) as any;
    return { sphere, material };
  }, []);
  useDispose(parts.sphere, parts.material);
  return <mesh geometry={parts.sphere} material={parts.material} renderOrder={-1} frustumCulled={false} />;
}
