"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  cross,
  dot,
  float,
  floor,
  fract,
  hash,
  int,
  length,
  max,
  min,
  mix,
  mod,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  sin,
  smoothstep,
  sqrt,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
  vertexIndex
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { airLight, airTone, haloTone, KEY } from "./air";
import { CORE, LENGTH, THICK, WIDTH, type Cloth } from "./cloth";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// An index held within [0, top]; TSL's types do not allow min and max on integers.
const clampInt = (k: any, top: number) => (max as any)((min as any)(k, int(top)), int(0));

// Shot silk: warp threads of one colour woven with weft of another, so the cloth turns from one to the other as it
// tilts to the eye. Each choice is only uniforms, so changing it compiles nothing.
export type Silk = { label: string; warp: string; weft: string; selvedge: string; light: string; halo: string };
export const SILKS: Record<string, Silk> = {
  ember: { label: "Ember", warp: "#5e0716", weft: "#d8862a", selvedge: "#e8c27a", light: "#ffe6cc", halo: "#170e0b" },
  peacock: { label: "Peacock", warp: "#0b7a84", weft: "#6a2aa6", selvedge: "#d6c08a", light: "#e4ecff", halo: "#141a24" },
  rose: { label: "Rose gold", warp: "#9a2f58", weft: "#cf9a5a", selvedge: "#f2dcae", light: "#ffe8d8", halo: "#171012" },
  pearl: { label: "Pearl", warp: "#8f99a8", weft: "#c9b48c", selvedge: "#a8b4c4", light: "#f4f0ea", halo: "#121212" }
};

export const look = {
  warp: uniform(new THREE.Color(SILKS.ember.warp)),
  weft: uniform(new THREE.Color(SILKS.ember.weft)),
  selvedge: uniform(new THREE.Color(SILKS.ember.selvedge)),
  // The bolt's state, for the caps: unrolled length and where the cloth leaves it.
  s: uniform(0.4),
  lift: uniform(0)
};

export function setSilk(key: string) {
  const silk = SILKS[key] ?? SILKS.ember;
  look.warp.value.set(silk.warp);
  look.weft.value.set(silk.weft);
  look.selvedge.value.set(silk.selvedge);
  airTone.value.set(silk.light);
  haloTone.value.set(silk.halo);
}

const KEY_NODE = () => vec3(KEY.x, KEY.y, KEY.z) as any;

// The colour of the silk at a point, seen from the eye: warp face on, weft at a slant, slubs across it as dupioni has,
// and a woven selvedge at either edge. `facing` is |n·v|, `slant` how far the eye looks along the warp.
function silkColour(facing: any, slant: any, glint: any, across: any, along: any) {
  const shot = smoothstep(0.05, 0.85, float(1).sub(facing)).mul(0.6).add(slant.mul(0.25)).add(glint.mul(0.45)) as any;
  const base = mix(look.warp, look.weft, shot.clamp(0, 1)) as any;
  // Slubs: thicker weft threads here and there, lines across the cloth that catch a little more light.
  const slubNoise = mx_noise_float(vec3(along.mul(46), across.mul(2.2), 0.5)) as any;
  const slub = smoothstep(0.45, 0.8, slubNoise).mul(0.07) as any;
  const streak = mx_noise_float(vec3(across.mul(90), along.mul(0.6), 3.1)).mul(0.04) as any;
  const cloth = base.mul(float(1).add(slub).add(streak)) as any;
  // The selvedge: a firmer band in its own thread, with a fine line woven in.
  const edge = min(across, float(WIDTH).sub(across)) as any;
  const band = float(1).sub(smoothstep(0.012, 0.016, edge)) as any;
  const line = float(1).sub(smoothstep(0.0015, 0.0025, abs(edge.sub(0.007)))) as any;
  return mix(cloth, mix(base.mul(0.8), look.selvedge, line.mul(0.85)), band).mul(0.72) as any;
}

// The cloth: one grid of vertices, each read from the simulation by its index, with normals and the warp's direction
// from its neighbours.
export function Sheet({ cloth }: { cloth: Cloth }) {
  const { mesh, geometry, material } = useMemo(() => {
    const { COLS, ROWS, A, du, dv } = cloth;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(COLS * ROWS * 3);
    const uvs = new Float32Array(COLS * ROWS * 2);
    for (let j = 0; j < ROWS; j++)
      for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i;
        positions.set([i * du - WIDTH / 2, -j * dv, 0], k * 3);
        uvs.set([i * du, j * dv], k * 2);
      }
    const index: number[] = [];
    for (let j = 0; j < ROWS - 1; j++)
      for (let i = 0; i < COLS - 1; i++) {
        const a = j * COLS + i;
        index.push(a, a + COLS, a + 1, a + 1, a + COLS, a + COLS + 1);
      }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);

    const id = int(vertexIndex);
    const i = id.mod(COLS);
    const j = id.div(COLS);
    const at = (a: any, b: any) =>
      A.element(
        clampInt(b, ROWS - 1)
          .mul(COLS)
          .add(clampInt(a, COLS - 1))
      ).xyz as any;
    const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.4, metalness: 0 });
    material.positionNode = at(i, j);
    const sideways = at(i.add(1), j).sub(at(i.sub(1), j)) as any;
    const lengthways = at(i, j.add(1)).sub(at(i, j.sub(1))) as any;
    const normal = varying(normalize(cross(lengthways, sideways).add(vec3(0, 1e-7, 0)))) as any;
    const warp = varying(normalize(lengthways.add(vec3(1e-7, 0, 0)))) as any;
    const coords = attribute("uv", "vec2") as any;

    const eye = normalize(cameraPosition.sub(positionWorld)) as any;
    // Turned to the eye on whichever side it sees.
    const n = normal.mul(select(dot(normal, eye).greaterThanEqual(0), float(1), float(-1))) as any;
    const facing = abs(dot(normal, eye)) as any;
    const slant = abs(dot(warp, eye)) as any;
    const toKey = normalize(KEY_NODE().sub(positionWorld)) as any;
    // Where the cloth turns its face between the light and the eye, the weft shows.
    const half = normalize(toKey.add(eye)) as any;
    const glint = (max(dot(n, half), float(0)) as any).pow(3) as any;
    const albedo = silkColour(facing, slant, glint, coords.x, coords.y);
    material.colorNode = albedo;
    material.normalNode = transformNormalToView(n) as any;
    material.roughnessNode = float(0.42) as any;
    // A long highlight drawn along the threads, and the soft sheen of a woven surface at grazing angles.
    material.anisotropyNode = vec2(0, 0.85) as any;
    material.sheenNode = look.weft.mul(0.9) as any;
    material.sheenRoughnessNode = float(0.32) as any;
    material.specularIntensityNode = float(0.8) as any;
    // Thin silk glows where the beam comes through it from behind.
    const through = max(dot(n, toKey).negate(), float(0)) as any;
    material.emissiveNode = albedo.mul(airLight(positionWorld).mul(through).mul(0.3)) as any;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return { mesh, geometry, material };
  }, [cloth]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The bolt: the ends of the wound cloth, a spiral of layers cut off at where the cloth leaves; and the cardboard core
// they are wound on, which turns with the roll.
export function Bolt({ centre, core }: { centre: THREE.Vector3; core: React.RefObject<THREE.Group | null> }) {
  const parts = useMemo(() => {
    const TAU = Math.PI * 2;
    const disc = new THREE.CircleGeometry(1, 160);
    disc.rotateY(Math.PI / 2);
    const capMaterial = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, side: THREE.DoubleSide });
    const Rs = sqrt(float(CORE * CORE).add(max(float(LENGTH).sub(look.s), 0).mul(THICK / Math.PI))) as any;
    const g = positionGeometry as any;
    capMaterial.positionNode = vec3(g.x, g.y.mul(Rs.add(0.0015)), g.z.mul(Rs.add(0.0015))) as any;
    const rel = positionWorld.sub(vec3(centre.x, centre.y, centre.z)) as any;
    const r = length(rel.yz) as any;
    const a = atan(rel.y, rel.z) as any;
    // Round the spiral from where the cloth leaves, the way it was wound.
    const turn = mod(a.sub(look.lift), TAU).div(TAU) as any;
    const outer = Rs.sub(turn.mul(THICK)) as any;
    const layer = Rs.sub(r).div(THICK).sub(turn) as any;
    const f = fract(layer) as any;
    // Each wrap a slightly different face of the shot colour, a dark seam between wraps and fine lines within.
    const wrapHash = hash(floor(layer).add(17)) as any;
    const tone = mix(look.warp, look.weft, wrapHash.mul(0.35).add(0.25)) as any;
    const seam = smoothstep(0.0, 0.1, f).mul(float(1).sub(smoothstep(0.9, 1.0, f))) as any;
    const fine = (sin(f.mul(Math.PI * 8)).abs() as any).pow(0.3).mul(0.22).add(0.78) as any;
    capMaterial.colorNode = tone.mul(seam.mul(0.75).add(0.25)).mul(fine) as any;
    capMaterial.sheenNode = look.weft.mul(0.3) as any;
    capMaterial.opacityNode = float(1)
      .sub(smoothstep(outer.sub(0.0008), outer, r))
      .mul(smoothstep(CORE - 0.0005, CORE + 0.0005, r)) as any;
    capMaterial.alphaTest = 0.5;
    const capL = new THREE.Mesh(disc, capMaterial);
    const capR = new THREE.Mesh(disc, capMaterial);
    capL.position.set(centre.x - WIDTH / 2 - 0.0015, centre.y, centre.z);
    capR.position.set(centre.x + WIDTH / 2 + 0.0015, centre.y, centre.z);
    for (const c of [capL, capR]) {
      c.castShadow = true;
      c.receiveShadow = true;
      c.frustumCulled = false;
    }

    // The core: a spiral-wound cardboard tube a little longer than the cloth, with its seam showing it turn.
    const tubeLength = WIDTH + 0.08;
    const tube = new THREE.CylinderGeometry(CORE, CORE, tubeLength, 64, 1, true);
    tube.rotateZ(Math.PI / 2);
    const inside = new THREE.CylinderGeometry(CORE - 0.004, CORE - 0.004, tubeLength, 48, 1, true);
    inside.rotateZ(Math.PI / 2);
    const rim = new THREE.RingGeometry(CORE - 0.004, CORE, 64);
    rim.rotateY(Math.PI / 2);
    const card = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
    const p = positionGeometry as any;
    const around = atan(p.y, p.z).div(TAU) as any;
    const helix = fract(around.add(p.x.div(0.11))) as any;
    const seamLine = smoothstep(0.0, 0.012, helix).mul(float(1).sub(smoothstep(0.988, 1.0, helix))) as any;
    const fibre = mx_noise_float(vec3(p.x.mul(60), around.mul(40), 0)).mul(0.05) as any;
    // A printed mill's stripe along the tube, so its turning shows.
    const stripe = smoothstep(0.02, 0.0, abs(fract(around.add(0.5)).sub(0.5)).sub(0.03)) as any;
    card.colorNode = mix(vec3(0.42, 0.3, 0.19), vec3(0.62, 0.12, 0.1), stripe.mul(0.8))
      .mul(seamLine.mul(0.25).add(0.75))
      .add(fibre) as any;
    const dark = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.BackSide });
    dark.colorNode = vec3(0.07, 0.05, 0.035) as any;
    const rimMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    rimMaterial.colorNode = vec3(0.48, 0.36, 0.24) as any;
    const tubeMesh = new THREE.Mesh(tube, card);
    const insideMesh = new THREE.Mesh(inside, dark);
    const rimL = new THREE.Mesh(rim, rimMaterial);
    const rimR = new THREE.Mesh(rim, rimMaterial);
    rimL.position.x = -tubeLength / 2;
    rimR.position.x = tubeLength / 2;
    tubeMesh.castShadow = true;
    tubeMesh.receiveShadow = true;
    return { disc, capMaterial, capL, capR, tube, inside, rim, card, dark, rimMaterial, tubeMesh, insideMesh, rimL, rimR };
  }, [centre]);
  useDispose(parts.disc, parts.capMaterial, parts.tube, parts.inside, parts.rim, parts.card, parts.dark, parts.rimMaterial);
  return (
    <>
      <primitive object={parts.capL} />
      <primitive object={parts.capR} />
      <group ref={core} position={[centre.x, centre.y, centre.z]}>
        <primitive object={parts.tubeMesh} />
        <primitive object={parts.insideMesh} />
        <primitive object={parts.rimL} />
        <primitive object={parts.rimR} />
      </group>
    </>
  );
}
