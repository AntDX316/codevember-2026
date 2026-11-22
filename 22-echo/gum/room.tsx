"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { atan, cameraPosition, cameraViewMatrix, color, cos, dot, float, floor, fract, fwidth, max, min, mix, normalize, positionWorld, pow, reflector, sin, smoothstep, step, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { ROOM, wave } from "./echo";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The hall: a round room lined with small white glazed tiles and light grey grout, a band of pink tiles round the wall
// at shoulder height and a ring of them round the floor's edge, a plain white ceiling with a round skylight in it. The
// floor is a mirror of the room, softened and broken by each tile's slight tilt. When the gum snaps, the sound's front
// runs over the tiles: each tile flashes as it passes and the grout lines burn bright pink in a thin ring.

const TILE = 0.15;
const GROUT = 0.0048;
// The course of pink tiles round the wall, counted up from the floor.
const BAND = 21;
// Tiles round the wall: a whole number, so the courses close.
const AROUND = Math.round((Math.PI * 2 * ROOM.radius) / TILE);
const GLOW = new THREE.Color("#ff3d8f");
const WHITE = new THREE.Color("#f2f0eb");
const PINK = new THREE.Color("#f3a3bf");
const GROUT_COLOUR = new THREE.Color("#d0cac2");

const hash = (c: any) => fract(sin(dot(c, vec2(127.1, 311.7))).mul(43758.5453)) as any;

// One tile face: given a point in the tiling (in tile units), how far it is from the grout in metres, which tile it is
// in, and how its pillowed face tilts there.
function tiling(g: any) {
  const cell = floor(g) as any;
  const f = fract(g) as any;
  const edge = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y))).mul(TILE) as any;
  const aa = max(fwidth(edge), float(0.0004)) as any;
  const grout = float(1).sub(smoothstep(float(GROUT).sub(aa), aa.add(GROUT), edge)) as any;
  // The glaze rolls over at each edge; and no tile is set quite flat.
  const roll = float(1).sub(smoothstep(GROUT, GROUT + 0.018, edge)) as any;
  const tilt = f
    .sub(0.5)
    .mul(roll.mul(1.4))
    .add(vec2(hash(cell).sub(0.5), hash(cell.add(17.3)).sub(0.5)).mul(0.045)) as any;
  return { cell, grout, tilt, id: hash(cell.add(3.7)) };
}

// The room's light as the glaze mirrors it: the white walls, darker below, and the skylight overhead.
export function hall(r: any) {
  const base = mix(vec3(0.42, 0.41, 0.4), vec3(0.95, 0.94, 0.92), smoothstep(-0.35, 0.55, r.y)) as any;
  const sky = smoothstep(0.9, 0.96, r.y).mul(5) as any;
  return base.add(vec3(1, 0.99, 0.97).mul(sky));
}

// Everything about a point of the tiles, built afresh for each of the material's outputs.
function surface(kind: "wall" | "floor") {
  const p = positionWorld as any;
  // The tiling's coordinates, the face's own normal and its two directions along the surface, and the centre of the
  // tile a point is in (for the flash, which lights a whole tile at once).
  let t: ReturnType<typeof tiling>;
  let n: any, along: any, up: any, centre: any, pink: any;
  if (kind === "wall") {
    const angle = atan(p.x, p.z.negate()) as any;
    t = tiling(vec2(angle.div(Math.PI * 2).mul(AROUND), p.y.sub(ROOM.floor).div(TILE)));
    n = normalize(vec3(p.x.negate(), 0, p.z.negate()));
    along = vec3(n.z.negate(), 0, n.x);
    up = vec3(0, 1, 0);
    const centreAngle = t.cell.x.add(0.5).div(AROUND).mul(Math.PI * 2) as any;
    centre = vec3(sin(centreAngle).mul(ROOM.radius), t.cell.y.add(0.5).mul(TILE).add(ROOM.floor), cos(centreAngle).mul(-ROOM.radius));
    const row = t.cell.y as any;
    pink = max(step(row.sub(BAND).abs(), float(0.5)), step(row.sub(2).abs(), float(0.5)));
  } else {
    t = tiling(p.xz.div(TILE));
    n = vec3(0, 1, 0);
    along = vec3(1, 0, 0);
    up = vec3(0, 0, 1);
    centre = vec3(t.cell.x.add(0.5).mul(TILE), ROOM.floor, t.cell.y.add(0.5).mul(TILE));
    const fromAxis = centre.xz.length() as any;
    pink = step(ROOM.radius - 0.72, fromAxis).mul(step(fromAxis, ROOM.radius - 0.52));
  }
  const N = normalize(n.add(along.mul(t.tilt.x)).add(up.mul(t.tilt.y))) as any;
  return { p, t, N, centre, pink };
}

function shaded(kind: "wall" | "floor", mirror: any) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.16, metalness: 0 });
  {
    const { t, pink } = surface(kind);
    const face = mix(color(WHITE), color(PINK), pink).mul(t.id.mul(0.05).add(0.97)) as any;
    material.colorNode = mix(face, color(GROUT_COLOUR), t.grout) as any;
  }
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(surface(kind).N, 0)).xyz) as any;
  material.roughnessNode = mix(float(kind === "floor" ? 0.1 : 0.14), float(0.85), surface(kind).t.grout) as any;

  const { p, t, N, centre, pink } = surface(kind);
  // A white room lights itself: light off every wall falls on every other, filling the shade.
  const bounce = mix(mix(color(WHITE), color(PINK), pink), color(GROUT_COLOUR), t.grout).mul(kind === "floor" ? 0.22 : 0.42) as any;
  const glaze = float(1).sub(t.grout) as any;
  const V = normalize(cameraPosition.sub(p)) as any;
  const facing = max(dot(N, V), 0) as any;
  const fresnel = pow(float(1).sub(facing), 5).mul(0.9).add(0.05) as any;
  // The room in the glaze; on the floor the real mirror image, broken by each tile's tilt.
  let seen: any = hall(N.mul(facing.mul(2)).sub(V));
  if (mirror) {
    mirror.uvNode = (mirror.uvNode as any).add(t.tilt.mul(0.012));
    seen = mix(seen.mul(0.5), mirror.level(0.6).rgb, 0.8);
  }
  const shine = seen.mul(fresnel).mul(glaze).mul(kind === "floor" ? 0.75 : 0.45) as any;
  // The sound passing: whole tiles flash, the grout burns in a sharper ring.
  const inward = float(kind === "floor" ? 1 : 0.35);
  const flash = wave(centre, inward) as any;
  const line = wave(p, inward, 2.2) as any;
  const glow = color(GLOW)
    .mul(flash.mul(glaze).mul(2.6).add(line.mul(t.grout).mul(14)))
    .add(vec3(1, 0.9, 0.95).mul(flash.mul(glaze).mul(0.45))) as any;
  material.emissiveNode = shine.add(glow).add(bounce) as any;
  return material;
}

export function Room({ mirrorScale }: { mirrorScale: number }) {
  const parts = useMemo(() => {
    const H = ROOM.ceiling - ROOM.floor;
    // The wall, turned to face in: its triangles' order reversed and its normals flipped.
    const wallGeometry = new THREE.CylinderGeometry(ROOM.radius, ROOM.radius, H, 256, 1, true).translate(0, ROOM.floor + H / 2, 0);
    inward(wallGeometry);
    const floorGeometry = new THREE.CircleGeometry(ROOM.radius + 0.02, 160).rotateX(-Math.PI / 2).translate(0, ROOM.floor, 0);
    const ceilingGeometry = new THREE.RingGeometry(ROOM.oculus, ROOM.radius + 0.02, 160, 2).rotateX(Math.PI / 2).translate(0, ROOM.ceiling, 0);
    const shaftGeometry = new THREE.CylinderGeometry(ROOM.oculus, ROOM.oculus, 1.4, 96, 1, true).translate(0, ROOM.ceiling + 0.7, 0);
    inward(shaftGeometry);
    const skyGeometry = new THREE.CircleGeometry(ROOM.oculus + 0.02, 96).rotateX(Math.PI / 2).translate(0, ROOM.ceiling + 1.4, 0);

    const mirror = mirrorScale > 0 ? (reflector({ resolutionScale: mirrorScale, generateMipmaps: true, bounces: false }) as any) : null;
    if (mirror) {
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = ROOM.floor;
    }
    const wallMaterial = shaded("wall", null);
    const floorMaterial = shaded("floor", mirror);
    // Plaster overhead, lit mostly by the room below it; brighter toward the skylight's edge.
    const ceilingMaterial = new THREE.MeshStandardNodeMaterial({ color: "#f2efea", roughness: 0.95 });
    ceilingMaterial.emissiveNode = vec3(0.5, 0.49, 0.48).mul(float(0.35).add(float(1).sub(smoothstep(ROOM.oculus, ROOM.oculus + 3, (positionWorld as any).xz.length())).mul(0.5))) as any;
    const shaftMaterial = new THREE.MeshStandardNodeMaterial({ color: "#f4f2ee", roughness: 0.9 });
    shaftMaterial.emissiveNode = vec3(1, 0.99, 0.97).mul(smoothstep(ROOM.ceiling, ROOM.ceiling + 1.4, (positionWorld as any).y).mul(1.6).add(0.35)) as any;
    const skyMaterial = new THREE.MeshBasicNodeMaterial({ color: "#ffffff" });
    skyMaterial.colorNode = vec3(1, 0.995, 0.98).mul(3.2) as any;

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, receive = true) => {
      const o = new THREE.Mesh(g, m);
      o.receiveShadow = receive;
      o.raycast = () => null;
      return o;
    };
    return {
      meshes: [mesh(wallGeometry, wallMaterial), mesh(floorGeometry, floorMaterial), mesh(ceilingGeometry, ceilingMaterial), mesh(shaftGeometry, shaftMaterial, false), mesh(skyGeometry, skyMaterial, false)],
      mirror,
      disposables: [wallGeometry, floorGeometry, ceilingGeometry, shaftGeometry, skyGeometry, wallMaterial, floorMaterial, ceilingMaterial, shaftMaterial, skyMaterial]
    };
  }, [mirrorScale]);
  useDispose(...parts.disposables, parts.mirror);

  return (
    <>
      {parts.meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      {parts.mirror ? <primitive object={parts.mirror.target} /> : null}
    </>
  );
}

// Turns a surface inside out properly: each triangle's corners in the other order, and every normal reversed.
export function inward(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
  const n = geometry.getAttribute("normal");
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return geometry;
}
