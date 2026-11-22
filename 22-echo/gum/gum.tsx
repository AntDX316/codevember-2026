"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, cameraViewMatrix, color, dot, exp, float, mix, mx_noise_float, normalize, normalGeometry, normalWorld, positionGeometry, positionWorld, pow, sin, smoothstep, uniform, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { hall } from "./room";
import { buildShape } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The gum: the letters blown as one bubble of pink bubblegum. Glossy, a little see-through: where the film faces you it
// is thin and pale and the light shows through it, toward the edges it is deeper pink; streaked faintly along its
// stretch. Blowing it bigger thins it, so it pales. It breaks from where it was tapped: a ragged hole that races across
// the letters, its rim thick and dark where the gum snaps back, the inside of the film showing through the hole.

export const DEEP = new THREE.Color("#ff5c9c");
export const PALE = new THREE.Color("#ffd3e3");
const INSIDE = new THREE.Color("#e5498a");
const RIM = new THREE.Color("#e2367a");

export const gum = {
  clock: uniform(0),
  // How far the film has been blown out along its normals, and how much it wobbles.
  puff: uniform(0),
  wobble: uniform(0.012),
  // Thinness, 0 (as chewed) to 1 (about to go): paler and more see-through.
  thin: uniform(0.2),
  // The break: where, in the gum's own space, and how far it has torn. Below zero, whole.
  tearAt: uniform(new THREE.Vector3()),
  tear: uniform(-1)
};

// The surface moved: blown out, wobbling, and lifted into a thick rim just beyond the tear.
function moved() {
  const p = positionGeometry as any;
  const t = gum.clock as any;
  const wob = sin(dot(p, vec3(1.7, 2.3, 0.6)).mul(2.4).add(t.mul(2.1)))
    .add(sin(p.x.mul(3.1).sub(t.mul(2.9)).add(p.y.mul(1.3))).mul(0.6))
    .mul(gum.wobble) as any;
  const d = p.sub(gum.tearAt).length().sub(gum.tear) as any;
  const rim = exp(d.mul(d).mul(-180)).mul(0.035).mul(smoothstep(-0.5, 0, gum.tear)) as any;
  return p.add(normalGeometry.mul(gum.puff.add(wob).add(rim)));
}

// How far past the tear's ragged edge a point is: below zero, torn away.
function pastTear(built: any) {
  const ragged = mx_noise_float(built.mul(5.5)).mul(0.16).add(mx_noise_float(built.mul(17)).mul(0.05)) as any;
  return built.sub(gum.tearAt).length().sub(gum.tear.add(ragged.mul(smoothstep(0, 0.25, gum.tear).add(0.3))));
}

function material(side: "outside" | "inside") {
  const m = new THREE.MeshPhysicalNodeMaterial({
    side: side === "outside" ? THREE.FrontSide : THREE.BackSide,
    roughness: side === "outside" ? 0.34 : 0.55,
    metalness: 0,
    clearcoat: side === "outside" ? 0.75 : 0,
    clearcoatRoughness: 0.1,
    alphaTest: typeof window !== "undefined" && window.location.search.includes("noalpha") ? 0 : 0.5
  });
  m.positionNode = moved() as any;
  const built = varying(attribute("position", "vec3")) as any;
  const past = pastTear(built) as any;
  const rim = float(1).sub(smoothstep(0, 0.07, past)).mul(smoothstep(-0.5, 0, gum.tear)) as any;
  if (!(typeof window !== "undefined" && window.location.search.includes("noalpha"))) m.opacityNode = smoothstep(-0.001, 0.001, past) as any;

  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  // Chewed, not moulded: the surface a little lumpy.
  const lumps = vec3(mx_noise_float(built.mul(5)), mx_noise_float(built.mul(5).add(11.3)), mx_noise_float(built.mul(5).add(23.1))).mul(side === "outside" ? 0.045 : 0.1) as any;
  const N = normalize(normalize(normalWorld).add(lumps)) as any;
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(N, 0)).xyz) as any;
  const facing = abs(dot(N, V)) as any;
  // Streaks drawn out along the stretch, and a few soft blotches where the gum is thicker.
  const streak = mx_noise_float(built.mul(vec3(2.2, 11, 2.2))).mul(0.5).add(mx_noise_float(built.mul(1.3)).mul(0.6)) as any;
  const thin = gum.thin.add(streak.mul(0.12)).clamp(0, 1) as any;
  if (side === "outside") {
    const body = mix(color(DEEP), color(PALE), facing.pow(2).mul(thin.mul(0.6).add(0.08))) as any;
    m.colorNode = mix(body, color(RIM), rim.mul(0.8)).mul(0.92) as any;
    m.roughnessNode = float(0.34).sub(streak.mul(0.06)).add(rim.mul(0.3)) as any;
    // Light through the film: thin parts glow pale, the rest a deep pink.
    const through = mix(color(DEEP).mul(0.07), color(PALE).mul(0.2), facing.pow(2).mul(thin)) as any;
    // The room in its gloss.
    const fresnel = pow(float(1).sub(facing), 4).mul(0.85).add(0.04) as any;
    const sheen = hall(N.mul(dot(N, V).mul(2)).sub(V)).mul(fresnel.mul(0.55).add(0.05)) as any;
    m.emissiveNode = through.mul(float(1).sub(rim.mul(0.7))).add(sheen.mul(float(1).sub(rim))) as any;
  } else {
    m.colorNode = mix(color(INSIDE), color(RIM), rim).mul(0.75) as any;
    m.emissiveNode = color(DEEP).mul(0.12) as any;
  }
  if (typeof window !== "undefined" && window.location.search.includes("flat")) {
    m.colorNode = vec3(0.6, 0.02, 0.1) as any;
    m.emissiveNode = vec3(0) as any;
  }
  if (typeof window !== "undefined" && window.location.search.includes("emit")) {
    m.colorNode = vec3(0) as any;
  }
  return m;
}

export function useGumMaterials() {
  const parts = useMemo(() => {
    if (typeof window !== "undefined" && window.location.search.includes("basic")) {
      const b = new THREE.MeshBasicNodeMaterial({ color: "#a00020" }) as any;
      return { outside: b, inside: b };
    }
    return { outside: material("outside"), inside: material("inside") };
  }, []);
  useDispose(parts.outside, parts.inside);
  return parts;
}

export function useGumGeometry(step: number) {
  const geometry = useMemo(() => buildShape(step), [step]);
  useDispose(geometry);
  return geometry;
}

export function Gum({ geometry, group }: { geometry: THREE.BufferGeometry; group: React.RefObject<THREE.Group | null> }) {
  const { outside, inside } = useGumMaterials();
  return (
    <group ref={group}>
      <mesh geometry={geometry} material={outside} castShadow raycast={() => null} />
      <mesh geometry={geometry} material={inside} raycast={() => null} />
    </group>
  );
}
