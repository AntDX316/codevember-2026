"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { abs, attribute, clamp, color, float, length, mix, mx_noise_float, normalMap, normalWorld, positionWorld, pow, smoothstep, texture, uniform, vec2, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { BOX_TOP, POST_TOP, POST_X } from "./rods";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const ROOT = "/codevember/pendulum";
const BOX = { width: 0.38, height: BOX_TOP, depth: 0.2 };
// Where the back wall stands.
export const WALL_Z = -1.55;

// How hot the copper has been worked, shown as temper colours along the rods' inner faces where the arc runs.
export const copperLook = { heat: uniform(1) };

// Copper rods, darkened with soot at the throat where every arc strikes, and tempered in bands of straw, bronze, violet and
// blue up their inner faces where the arc's feet have run, fading toward the tips.
function copperMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ metalness: 1, roughness: 0.3 });
  const rod = attribute("aRod", "vec2") as any;
  const height = rod.x as any;
  const side = rod.y as any;
  const inner = clamp(normalWorld.x.mul(side.negate()), 0, 1) as any;
  const grain = mx_noise_float(positionWorld.mul(vec3(90, 14, 90))) as any;
  const blotch = mx_noise_float(positionWorld.mul(vec3(30, 6, 30)).add(vec3(side.mul(3), 0, 0))) as any;
  const run = smoothstep(-0.01, 0.04, height).mul(float(1).sub(smoothstep(0.35, 0.72, height))) as any;
  const tint = pow(inner, float(0.8)).mul(run).mul(blotch.mul(0.35).add(0.75)).mul(copperLook.heat).clamp(0, 1) as any;
  // Temper colours run through as the metal got hotter: straw, bronze, violet, blue.
  const phase = height.mul(9).add(blotch.mul(0.8)).add(inner.mul(0.6)) as any;
  const band = phase.sub(phase.floor()) as any;
  const straw = color("#d9a456");
  const bronze = color("#a2552c");
  const violet = color("#6b3b78");
  const blue = color("#3a5b9a");
  const temper = mix(mix(straw, bronze, smoothstep(0, 0.33, band)), mix(violet, blue, smoothstep(0.55, 0.95, band)), smoothstep(0.3, 0.6, band)) as any;
  const copper = mix(color("#c8754a"), color("#e09a6c"), grain.mul(0.5).add(0.5)) as any;
  const soot = smoothstep(0.07, 0.0, abs(height.sub(0.01)))
    .mul(inner.mul(0.6).add(0.4))
    .mul(blotch.mul(0.3).add(0.7)) as any;
  m.colorNode = mix(mix(copper, temper, tint.mul(0.75)), color("#1a1210"), soot.mul(0.85)) as any;
  m.roughnessNode = float(0.22)
    .add(grain.mul(0.05))
    .add(tint.mul(0.12))
    .add(soot.mul(0.45)) as any;
  return m;
}

// The ribbed porcelain insulator, as a turned profile: a foot, three sheds, a neck.
function insulatorGeometry() {
  const pts: THREE.Vector2[] = [];
  const h = POST_TOP - 0.022 - BOX_TOP;
  const push = (r: number, y: number) => pts.push(new THREE.Vector2(r, y));
  push(0.0001, 0);
  push(0.029, 0);
  push(0.03, 0.004);
  push(0.027, 0.012);
  const sheds = 3;
  for (let i = 0; i < sheds; i++) {
    const y0 = 0.016 + (i * (h - 0.035)) / sheds;
    const span = (h - 0.035) / sheds;
    const outer = 0.034 - i * 0.003;
    // Each shed: a sloping top out to a rounded lip, a short drip edge, and a hollow underneath back to the core.
    push(0.017, y0);
    push(0.019, y0 + span * 0.12);
    push(outer - 0.002, y0 + span * 0.3);
    push(outer, y0 + span * 0.36);
    push(outer - 0.001, y0 + span * 0.46);
    push(0.019, y0 + span * 0.9);
  }
  push(0.016, h - 0.016);
  push(0.015, h - 0.006);
  push(0.012, h);
  push(0.0001, h);
  const geometry = new THREE.LatheGeometry(pts, 64);
  geometry.computeVertexNormals();
  return geometry;
}

// Brass: a terminal post with a hex nut, and the box's nameplate.
function postGeometry() {
  const post = new THREE.CylinderGeometry(0.0085, 0.0095, 0.03, 24).translate(0, POST_TOP - 0.007, 0);
  const nut = new THREE.CylinderGeometry(0.0135, 0.0135, 0.008, 6).translate(0, POST_TOP - 0.015, 0);
  const cap = new THREE.SphereGeometry(0.0085, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, POST_TOP + 0.008, 0);
  const strip = (g: THREE.BufferGeometry) => {
    g.deleteAttribute("uv");
    return g.toNonIndexed();
  };
  return mergeGeometries([strip(post), strip(nut), strip(cap)]);
}

export function Ladder({ rods }: { rods: [THREE.BufferGeometry, THREE.BufferGeometry] }) {
  const parts = useMemo(() => {
    const copper = copperMaterial();
    const porcelain = new THREE.MeshPhysicalNodeMaterial({ color: "#ece5d8", roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.06 });
    // A faint craze and a warmer tint low down, where it has sat in the dust.
    porcelain.colorNode = mix(color("#e9e2d4"), color("#cfc2ad"), smoothstep(BOX_TOP + 0.03, BOX_TOP, positionWorld.y).mul(0.6)) as any;
    const brass = new THREE.MeshPhysicalNodeMaterial({ color: "#c79a4a", metalness: 1, roughness: 0.32 });
    brass.roughnessNode = float(0.3).add(mx_noise_float(positionWorld.mul(120)).mul(0.08)) as any;
    // Painted steel, a little worn at the edges.
    const steel = new THREE.MeshPhysicalNodeMaterial({ color: "#1b1d1c", metalness: 0.4, roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    const wear = mx_noise_float(positionWorld.mul(vec3(40, 40, 40))) as any;
    steel.colorNode = mix(color("#1d201f"), color("#262a28"), wear.mul(0.5).add(0.5)) as any;
    steel.roughnessNode = float(0.46).add(wear.mul(0.1)) as any;
    const box = new RoundedBoxGeometry(BOX.width, BOX.height, BOX.depth, 4, 0.012).translate(0, BOX.height / 2, 0);
    const plate = new RoundedBoxGeometry(0.13, 0.045, 0.003, 2, 0.001).translate(0, BOX.height * 0.5, BOX.depth / 2 + 0.0012);
    const insulator = insulatorGeometry().translate(0, BOX_TOP, 0);
    const post = postGeometry();
    return { copper, porcelain, brass, steel, box, plate, insulator, post };
  }, []);
  useDispose(parts.copper, parts.porcelain, parts.brass, parts.steel, parts.box, parts.plate, parts.insulator, parts.post);
  return (
    <group>
      <mesh geometry={parts.box} material={parts.steel} castShadow receiveShadow />
      <mesh geometry={parts.plate} material={parts.brass} castShadow />
      {[-1, 1].map((side) => (
        <group key={side} position={[side * POST_X, 0, 0]}>
          <mesh geometry={parts.insulator} material={parts.porcelain} castShadow receiveShadow />
          <mesh geometry={parts.post} material={parts.brass} castShadow />
        </group>
      ))}
      <mesh geometry={rods[0]} material={parts.copper} castShadow receiveShadow frustumCulled={false} />
      <mesh geometry={rods[1]} material={parts.copper} castShadow receiveShadow frustumCulled={false} />
      <Cables />
    </group>
  );
}

// Two heavy rubber leads out of the back of the box, across the floor and away into the dark.
function Cables() {
  const { geometry, material } = useMemo(() => {
    const leads = [-1, 1].map((side) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.06, 0.05, -BOX.depth / 2 + 0.01),
        new THREE.Vector3(side * 0.07, 0.045, -BOX.depth / 2 - 0.05),
        new THREE.Vector3(side * 0.09, 0.012, -BOX.depth / 2 - 0.14),
        new THREE.Vector3(side * 0.05 + 0.1, 0.008, -0.45),
        new THREE.Vector3(side * 0.04 + 0.35, 0.008, -0.8),
        new THREE.Vector3(side * 0.05 + 0.5, 0.008, -1.4)
      ]);
      const g = new THREE.TubeGeometry(curve, 120, 0.0075, 12, false);
      g.deleteAttribute("uv");
      return g;
    });
    const geometry = mergeGeometries(leads);
    const material = new THREE.MeshPhysicalNodeMaterial({ color: "#0c0c0c", roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.5 });
    return { geometry, material };
  }, []);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} castShadow receiveShadow />;
}

// A concrete floor and a back wall, the floor's own scan, both falling away to black past the arc's reach.
export function Room() {
  const [diff, nor, rough] = suspendRetried(
    () => Promise.all(["diff", "nor_gl", "rough"].map((map) => loadRetried(new THREE.TextureLoader(), `${ROOT}/concrete_floor_worn_001_${map}_2k.jpg`))),
    ["bolt-ladder-concrete"]
  );
  const parts = useMemo(() => {
    for (const t of [diff, nor, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
    }
    diff.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.8 });
    const fuv = positionWorld.xz.div(1.6) as any;
    const away = length(positionWorld.xz) as any;
    const fade = float(1).sub(smoothstep(1.6, 4.2, away)) as any;
    floor.colorNode = texture(diff, fuv).rgb.mul(0.42).mul(fade.mul(0.85).add(0.15)) as any;
    floor.roughnessNode = texture(rough, fuv).g.mul(0.5).add(0.45) as any;
    floor.normalNode = normalMap(texture(nor, fuv), vec2(0.8)) as any;
    const wall = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92 });
    const wuv = vec2(positionWorld.x.div(2.2).add(0.37), positionWorld.y.div(2.2)) as any;
    const wallFade = float(1).sub(smoothstep(1.5, 4, abs(positionWorld.x))) as any;
    wall.colorNode = texture(diff, wuv).rgb.mul(0.5).mul(wallFade) as any;
    wall.normalNode = normalMap(texture(nor, wuv), vec2(0.6)) as any;
    const floorGeometry = new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2);
    const wallGeometry = new THREE.PlaneGeometry(10, 5).translate(0, 2.5, WALL_Z);
    return { floor, wall, floorGeometry, wallGeometry };
  }, [diff, nor, rough]);
  useDispose(parts.floor, parts.wall, parts.floorGeometry, parts.wallGeometry);
  return (
    <>
      <mesh geometry={parts.floorGeometry} material={parts.floor} receiveShadow renderOrder={1} />
      <mesh geometry={parts.wallGeometry} material={parts.wall} receiveShadow renderOrder={1} />
    </>
  );
}

