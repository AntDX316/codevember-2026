"use client";

import { useEffect, useMemo } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import {
  Fn,
  cameraPosition,
  hash,
  instanceIndex,
  dot,
  float,
  max,
  mix,
  mx_noise_float,
  normalMap,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3
} from "three/tsl";
import type { QualityTier } from "../shared/engine/types";
import { mulberry32 } from "../shared/engine/random";
import { loadRetried, suspendRetried } from "../shared/engine/retry";
import { cull, fernMesh } from "./litter";
import { clock, FALLEN, giantLight, glowAt, light, LOG, logZ, phoneLike, surfaceAt } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Scanned plants and stones (CC0, Poly Haven; see public/assets/16-spore/CREDITS.txt), pulled out of their glTF as
// plain geometry standing on y = 0, centred, to be instanced.
const ROOT = "/assets/16-spore";
type Scan = { geometry: THREE.BufferGeometry; size: THREE.Vector3 };
type Plant = { diffuse: THREE.Texture; normal: THREE.Texture; scans: Scan[] };

async function loadTexture(url: string, colour: boolean) {
  const t = await loadRetried(new THREE.TextureLoader(), url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.flipY = false;
  return t;
}
async function loadPlant(name: string, resolution: string): Promise<Plant> {
  const [gltf, diffuse, normal] = await Promise.all([
    loadRetried(new GLTFLoader(), `${ROOT}/${name}/${name}.gltf`),
    loadTexture(`${ROOT}/${name}/textures/${name}_diff_${resolution}.jpg`, true),
    loadTexture(`${ROOT}/${name}/textures/${name}_nor_gl_${resolution}.jpg`, false)
  ]);
  const scans: Scan[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    const mesh = child as unknown as { isMesh?: boolean; geometry: { getAttribute(n: string): { array: ArrayLike<number> }; index: { array: ArrayLike<number> } } };
    if (!mesh.isMesh) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("position").array), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("normal").array), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("uv").array), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.geometry.index.array), 1));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    scans.push({ geometry, size: box.getSize(new THREE.Vector3()) });
  });
  return { diffuse, normal, scans };
}
const loadAll = async (sharp: boolean) => {
  const size = sharp ? "2k" : "1k";
  const [sorrel, rocks, trunk, stumped, branches] = await Promise.all([
    loadPlant("shrub_sorrel_01", size),
    loadPlant("rock_moss_set_01", "2k"),
    loadPlant("dead_tree_trunk", size),
    loadPlant("dead_tree_trunk_02", size),
    loadPlant("dry_branches_medium_01", size)
  ]);
  const [mossColour, mossHeight] = await Promise.all([loadTexture(`${ROOT}/moss_diff_1k.jpg`, true), loadTexture(`${ROOT}/moss_disp_1k.jpg`, false)]);
  return { sorrel, rocks, trunk, stumped, branches, moss: { colour: mossColour, height: mossHeight } };
};
type Moss = { colour: THREE.Texture; height: THREE.Texture };

// Moss over whatever faces up, in patches with soft, ragged edges: the scan seen from above, deeper green in the
// hollows of its pile, and how much of it there is (0 to 1).
function mossOver(moss: Moss, amount: number) {
  const top = positionWorld.xz.mul(5) as any;
  const pile = texture(moss.height, top).r as any;
  const patches = mx_noise_float(positionWorld.mul(7))
    .mul(0.45)
    .add(mx_noise_float(positionWorld.mul(23)).mul(0.15)) as any;
  const cover = smoothstep(
    0.45,
    0.72,
    normalWorld.y
      .add(patches)
      .add(pile.mul(0.2))
      .add(amount - 0.5)
  ).mul(Math.min(1, amount * 2)) as any;
  const colour = texture(moss.colour, top)
    .rgb.mul(pile.mul(0.35).add(0.3))
    .mul(mix(vec3(0.8, 0.9, 0.65), vec3(1.05, 1.05, 0.75), mx_noise_float(positionWorld.mul(4)).mul(0.5).add(0.5))) as any;
  return { cover, colour, pile };
}
// Fine fuzz on moss catching the moon at its edges.
const mossRim = (cover: any) => {
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  return (light.moon as any).mul(
    pow(dot(normalize(normalWorld), V).abs().oneMinus(), 3)
      .mul(cover)
      .mul(light.moonPower)
      .mul(0.06)
  );
};

// Scanned deadwood: weathered, split bark, the grain showing where it has gone, damp and dark where it lies in the
// litter; lit like everything else by the moon and the blooms near it.
function woodMaterial(plant: Plant, moss: Moss, mossy: number) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  const damp = smoothstep(0, 0.07, positionLocal.y).mul(0.55).add(0.45) as any;
  const green = mossOver(moss, mossy);
  const bark = mix(texture(plant.diffuse, uv()).rgb.mul(1.1), green.colour, green.cover).mul(damp) as any;
  material.colorNode = bark;
  material.roughnessNode = mix(float(0.88), float(1), green.cover) as any;
  material.normalNode = normalMap(texture(plant.normal, uv()), vec2(1.4, 1.4).mul(float(1).sub(green.cover.mul(0.7)))) as any;
  // As on the big log: the night sky's faint light, so the bark reads in the dark.
  material.emissiveNode = Fn(() => {
    const facing = normalWorld.y.mul(0.4).add(0.6) as any;
    const sky = light.moon.mul(light.moonPower).mul(0.9) as any;
    return bark
      .mul(glowAt(positionWorld).add(giantLight().mul(0.25)).mul(0.65).add(sky))
      .mul(facing)
      .add(mossRim(green.cover));
  })() as any;
  return material;
}
// Stones grown over with moss on their tops, lit as the wood is.
function stoneMaterial(plant: Plant, moss: Moss) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  const green = mossOver(moss, 0.35);
  const stone = mix(texture(plant.diffuse, uv()).rgb.mul(0.9), green.colour, green.cover) as any;
  material.colorNode = stone;
  material.roughnessNode = mix(float(0.75), float(1), green.cover) as any;
  material.normalNode = normalMap(texture(plant.normal, uv()), vec2(1.2, 1.2)) as any;
  material.emissiveNode = Fn(() => {
    const facing = normalWorld.y.mul(0.4).add(0.6) as any;
    const sky = light.moon.mul(light.moonPower).mul(0.7) as any;
    return stone
      .mul(glowAt(positionWorld).add(giantLight().mul(0.2)).mul(0.65).add(sky))
      .mul(facing)
      .add(mossRim(green.cover));
  })() as any;
  return material;
}

// Pebbles: lumpy, flattened low-poly stones, grey-brown and mottled, moss on their tops, one instanced draw.
function pebbles(spots: Spot[], moss: Moss, rand: () => number) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
    const lump = 1 + 0.18 * Math.sin(x * 5 + z * 3) * Math.sin(y * 4 - z * 2);
    p.setXYZ(i, x * lump, y * 0.6 * lump, z * lump);
  }
  g.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const green = mossOver(moss, 0.35);
  const mottle = mx_noise_float(positionWorld.mul(90)).mul(0.5).add(0.5) as any;
  const rock = mix(vec3(0.09, 0.085, 0.075), vec3(0.24, 0.22, 0.19), mottle) as any;
  const colour = mix(rock, green.colour, green.cover) as any;
  material.colorNode = colour;
  material.emissiveNode = Fn(() => {
    const facing = normalWorld.y.mul(0.4).add(0.6) as any;
    return colour.mul(glowAt(positionWorld).add(giantLight().mul(0.2)).mul(0.65).add(light.moon.mul(light.moonPower).mul(0.7))).mul(facing);
  })() as any;
  const mesh = new THREE.InstancedMesh(g, material, Math.max(1, spots.length));
  const m = new THREE.Matrix4();
  spots.forEach((s, i) => {
    const size = 0.008 + rand() * rand() * 0.025;
    m.compose(
      new THREE.Vector3(s.x, surfaceAt(s.x, s.z).y + size * 0.15, s.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.4, rand() * 6.28, (rand() - 0.5) * 0.4)),
      new THREE.Vector3(size * (0.8 + rand() * 0.6), size, size * (0.8 + rand() * 0.6))
    );
    mesh.setMatrixAt(i, m);
  });
  mesh.count = spots.length;
  mesh.frustumCulled = false;
  return cull(mesh);
}

// A cushion of moss: a low, lumpy dome, the pile of the scan pushing its surface out.
function cushionGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
    const lump = 1 + 0.12 * Math.sin(x * 7 + z * 3) * Math.sin(z * 6 - y * 4) + 0.06 * Math.sin(x * 17 - z * 13);
    p.setXYZ(i, x * lump, Math.max(y, -0.1) * 0.42 * lump, z * lump);
  }
  g.computeVertexNormals();
  return g;
}
function cushionMaterial(moss: Moss) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const top = positionWorld.xz.mul(6) as any;
  const pile = texture(moss.height, top).r as any;
  const colour = texture(moss.colour, top)
    .rgb.mul(pile.mul(0.4).add(0.25))
    .mul(mix(vec3(0.7, 0.85, 0.55), vec3(1.1, 1.05, 0.7), mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5)))
    .mul(smoothstep(-0.05, 0.25, positionLocal.y).mul(0.6).add(0.4)) as any;
  material.colorNode = colour;
  material.positionNode = positionLocal.add(normalWorld.mul(pile.sub(0.5).mul(0.08))) as any;
  material.emissiveNode = Fn(() => {
    const facing = normalWorld.y.mul(0.4).add(0.6) as any;
    const sky = light.moon.mul(light.moonPower).mul(0.6) as any;
    return colour
      .mul(glowAt(positionWorld).add(giantLight().mul(0.2)).mul(0.7).add(sky))
      .mul(facing)
      .add(mossRim(float(1)));
  })() as any;
  return material;
}
// One of each scan for every place it lies, each placed by its own matrix.
function lay(scan: Scan, material: THREE.Material, matrices: THREE.Matrix4[]) {
  const mesh = new THREE.InstancedMesh(scan.geometry, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.frustumCulled = false;
  return mesh;
}

// Lit as everything on the floor is: by the moon, and by whatever blooms near, in its colours.
function plantMaterial(plant: Plant, cutout: boolean, sway: number) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: cutout ? THREE.DoubleSide : THREE.FrontSide, alphaTest: cutout ? 0.5 : 0 });
  const leaf = texture(plant.diffuse, uv()) as any;
  material.colorNode = leaf.rgb.mul(0.8) as any;
  // These scans hold their leaf shapes against black, in place of an alpha channel.
  if (cutout) material.opacityNode = smoothstep(0.015, 0.05, max(leaf.r, max(leaf.g, leaf.b))) as any;
  material.normalNode = normalMap(texture(plant.normal, uv()), vec2(1, 1)) as any;
  material.emissiveNode = Fn(() => leaf.rgb.mul(glowAt(positionWorld).add(giantLight().mul(0.2))).mul(0.7))() as any;
  if (sway) {
    const h = positionLocal.y as any;
    const s = sin(clock.mul(1.2).add(positionWorld.x.mul(9)).add(positionWorld.z.mul(7)))
      .mul(h)
      .mul(sway) as any;
    material.positionNode = positionLocal.add(vec3(s, 0, s.mul(0.6))) as any;
  }
  return material;
}

type Spot = { x: number; z: number };
function scatter(plant: Plant, material: THREE.Material, spots: Spot[], seed: number, size: [number, number], sink: number) {
  const rand = mulberry32(seed);
  return plant.scans.map((scan, k) => {
    const mine = spots.filter((_, i) => i % plant.scans.length === k);
    const mesh = new THREE.InstancedMesh(scan.geometry, material, Math.max(1, mine.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    mine.forEach((s, i) => {
      const wanted = size[0] + rand() * rand() * (size[1] - size[0]);
      const scale = wanted / Math.max(0.001, scan.size.y);
      const y = surfaceAt(s.x, s.z).y - wanted * sink;
      q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25));
      m.compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(scale, scale, scale));
      mesh.setMatrixAt(i, m);
    });
    mesh.count = mine.length;
    mesh.frustumCulled = false;
    return mesh;
  });
}

// Grass: a tuft of a few thin blades, arching out, drawn by the hundred.
function tuftGeometry() {
  const blades: THREE.BufferGeometry[] = [];
  const rand = mulberry32(5);
  for (let b = 0; b < 7; b++) {
    const g = new THREE.PlaneGeometry(1, 1, 1, 5);
    g.translate(0, 0.5, 0);
    const p = g.getAttribute("position");
    const turn = rand() * Math.PI * 2;
    const arch = 0.15 + rand() * 0.35;
    const tall = 0.6 + rand() * 0.4;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const w = 0.035 * (1 - y * 0.92) * p.getX(i);
      const out = arch * y * y;
      p.setXYZ(i, Math.cos(turn) * out - Math.sin(turn) * w, y * tall, Math.sin(turn) * out + Math.cos(turn) * w);
    }
    g.computeVertexNormals();
    blades.push(g);
  }
  return mergeGeometries(blades);
}

// Fallen twigs lying in the litter.
function twigGeometry() {
  const g = new THREE.CylinderGeometry(0.6, 1, 1, 6, 1, true);
  g.rotateZ(Math.PI / 2);
  return g;
}

export function Plants({ tier }: { tier: QualityTier }) {
  const sharp = tier !== "low" || !phoneLike();
  const assets = suspendRetried(() => loadAll(sharp), ["codevember-spore-plants", sharp]);
  const meshes = useMemo(() => {
    const rand = mulberry32(17);
    const scale = tier === "low" ? 0.5 : tier === "medium" ? 0.75 : 1;
    const inDisc = (r0: number, r1: number) => {
      const a = rand() * Math.PI * 2;
      const r = r0 + Math.sqrt(rand()) * (r1 - r0);
      return { x: Math.cos(a) * r, z: Math.sin(a) * r * 0.9 };
    };
    const offLog = (s: Spot) => !surfaceAt(s.x, s.z).onLog;
    const clumps = (n: number, each: number, r0: number, r1: number, spread: number) => {
      const spots: Spot[] = [];
      for (let c = 0; c < n; c++) {
        const centre = inDisc(r0, r1);
        for (let k = 0; k < each; k++) {
          const s = { x: centre.x + (rand() - 0.5) * spread, z: centre.z + (rand() - 0.5) * spread };
          if (offLog(s)) spots.push(s);
        }
      }
      return spots;
    };
    const out: THREE.Object3D[] = [];
    // Sorrel in little drifts, ferns along the log and round the edges, mossy stones here and there.
    // Sorrel in proper patches, thick in the middle and thinning out at the edges.
    out.push(...scatter(assets.sorrel, plantMaterial(assets.sorrel, true, 0.02), clumps(Math.round(22 * scale) + 3, 14, 0.15, 2.3, 0.24), 3307, [0.025, 0.07], 0.05));
    const ferns: Spot[] = [];
    for (let i = 0; i < 26 * scale; i++) {
      const x = LOG.from + 0.4 + rand() * (LOG.to - LOG.from - 0.8);
      const s = rand() < 0.4 ? { x, z: logZ(x) + (rand() < 0.5 ? 1 : -1) * (0.2 + rand() * 0.15) } : inDisc(1.3, 2.4);
      if (offLog(s)) ferns.push(s);
    }
    // More ferns further out all round, and big ones in stands further still: dark shapes against the giants' glow.
    for (let i = 0; i < 40 * scale; i++) ferns.push(inDisc(2.4, 9));
    out.push(fernMesh(ferns, [0.12, 0.4], 1711));
    const bushes: Spot[] = [];
    for (let c = 0; c < 26 * scale; c++) {
      const centre = inDisc(2.6, 11);
      if (centre.z > 0.8 && Math.abs(centre.x) < 1.6) continue;
      for (let k = 0; k < 3; k++) bushes.push({ x: centre.x + (rand() - 0.5) * 0.7, z: centre.z + (rand() - 0.5) * 0.7 });
    }
    out.push(fernMesh(bushes, [0.4, 1.0], 4243));
    const stones: Spot[] = [];
    for (let i = 0; i < 60 * scale; i++) {
      const s = inDisc(0.25, 2.4);
      if (offLog(s)) stones.push(s);
    }
    const stone = stoneMaterial(assets.rocks, assets.moss);
    // Small stones are low-poly pebbles: the scans are thousands of points each, wasted at a few centimetres.
    out.push(pebbles(stones, assets.moss, mulberry32(919)));
    // Bigger rocks, half sunk and thick with moss, alone or in twos and threes.
    const boulders: Spot[] = [];
    for (let c = 0; c < 16 * scale + 3; c++) {
      const centre = inDisc(0.7, 2.4);
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const s = { x: centre.x + (rand() - 0.5) * 0.25, z: centre.z + (rand() - 0.5) * 0.25 };
        if (offLog(s)) boulders.push(s);
      }
    }
    out.push(...scatter(assets.rocks, stone, boulders, 2027, [0.06, 0.17], 0.4));
    // The smaller fallen logs, and dead branches lying about.
    {
      const placed = (log: (typeof FALLEN)[number]) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(log.x, log.y, log.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, log.yaw, log.pitch, "YZX")),
          new THREE.Vector3(log.scale, log.scale, log.scale)
        );
      const trunk = woodMaterial(assets.trunk, assets.moss, 0.55);
      out.push(lay(assets.trunk.scans[0], trunk, FALLEN.filter((l) => l.scan === "dead_tree_trunk").map(placed)));
      out.push(lay(assets.stumped.scans[0], woodMaterial(assets.stumped, assets.moss, 0.45), FALLEN.filter((l) => l.scan === "dead_tree_trunk_02").map(placed)));
      const wood = woodMaterial(assets.branches, assets.moss, 0.15);
      const lying: [number, number, number, number][][] = [
        [
          [0.85, -0.42, 0.4, 0.42],
          [-1.1, 0.95, 1.2, 0.5]
        ],
        [
          [-0.95, 0.62, 2.1, 0.4],
          [2.05, 0.95, -0.3, 0.45]
        ],
        [
          [2.0, -0.6, -0.7, 0.42],
          [-2.0, -0.85, 0.9, 0.5]
        ]
      ];
      assets.branches.scans.forEach((scan, k) => {
        const matrices = lying[k % lying.length].map(([x, z, yaw, scale]) =>
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, surfaceAt(x, z).y - scan.size.y * scale * 0.18, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
            new THREE.Vector3(scale, scale, scale)
          )
        );
        out.push(lay(scan, wood, matrices));
      });
    }
    // Twigs: the same scanned branches, small, sprinkled through the litter.
    {
      const wood = woodMaterial(assets.branches, assets.moss, 0);
      assets.branches.scans.forEach((scan) => {
        const matrices: THREE.Matrix4[] = [];
        for (let i = 0; i < 14 * scale; i++) {
          const s = inDisc(0.1, 2.4);
          if (!offLog(s)) continue;
          const size = 0.1 + rand() * rand() * 0.16;
          matrices.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(s.x, surfaceAt(s.x, s.z).y - scan.size.y * size * 0.25, s.z),
              new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.2, rand() * 6.28, (rand() - 0.5) * 0.2)),
              new THREE.Vector3(size, size, size)
            )
          );
        }
        out.push(lay(scan, wood, matrices));
      });
    }
    // Moss: cushions in little colonies on the floor, along the foot of the log, and on top of the logs.
    {
      const spots: { x: number; z: number; size: number }[] = [];
      for (let c = 0; c < 22 * scale + 4; c++) {
        const centre =
          rand() < 0.35
            ? (() => {
                const x = LOG.from + 0.3 + rand() * (LOG.to - LOG.from - 0.6);
                return { x, z: logZ(x) + (rand() < 0.5 ? 1 : -1) * (0.13 + rand() * 0.06) };
              })()
            : inDisc(0.3, 2.4);
        const n = 3 + Math.floor(rand() * 6);
        for (let k = 0; k < n; k++) spots.push({ x: centre.x + (rand() - 0.5) * 0.14, z: centre.z + (rand() - 0.5) * 0.14, size: 0.012 + rand() * rand() * 0.045 });
      }
      for (let i = 0; i < 14 * scale; i++) {
        const x = LOG.from + 0.2 + rand() * (LOG.to - LOG.from - 0.4);
        spots.push({ x, z: logZ(x) + (rand() - 0.5) * 0.08, size: 0.015 + rand() * 0.03 });
      }
      for (const log of FALLEN)
        for (let k = 0; k < 4; k++) {
          const along = (rand() - 0.5) * log.profile.length * log.scale * 0.8;
          spots.push({ x: log.x + Math.cos(log.yaw) * along, z: log.z - Math.sin(log.yaw) * along, size: 0.012 + rand() * 0.025 });
        }
      const mesh = new THREE.InstancedMesh(cushionGeometry(), cushionMaterial(assets.moss), spots.length);
      const m = new THREE.Matrix4();
      spots.forEach((p, i) => {
        const w = p.size * (0.8 + rand() * 0.5);
        m.compose(
          new THREE.Vector3(p.x, surfaceAt(p.x, p.z).y - p.size * 0.12, p.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)),
          new THREE.Vector3(w, p.size, p.size * (0.8 + rand() * 0.5))
        );
        mesh.setMatrixAt(i, m);
      });
      mesh.frustumCulled = false;
      out.push(cull(mesh));
    }
    // Grass tufts.
    {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
      const tip = positionLocal.y as any;
      // Each tuft its own green, from near black-green and deep blue-green to olive and a few gone straw-dry, darker at
      // the root, paler at the tips.
      const pick = hash(instanceIndex.toFloat().mul(3.17)) as any;
      const root = mix(mix(vec3(0.03, 0.05, 0.02), vec3(0.04, 0.08, 0.06), smoothstep(0.2, 0.5, pick)), vec3(0.12, 0.1, 0.04), smoothstep(0.85, 0.95, pick)) as any;
      const blade = mix(mix(vec3(0.16, 0.22, 0.07), vec3(0.1, 0.2, 0.14), smoothstep(0.2, 0.5, pick)), vec3(0.38, 0.32, 0.14), smoothstep(0.85, 0.95, pick)).mul(
        hash(instanceIndex.toFloat().mul(9.1)).mul(0.5).add(0.7)
      ) as any;
      const tint = mix(root, blade, tip.mul(14).clamp(0, 1)) as any;
      material.colorNode = tint;
      material.emissiveNode = Fn(() => tint.mul(glowAt(positionWorld).add(giantLight().mul(0.07))).mul(0.8))() as any;
      const s = sin(clock.mul(1.4).add(positionWorld.x.mul(11)).add(positionWorld.z.mul(5)))
        .mul(tip.mul(tip))
        .mul(0.25) as any;
      material.positionNode = positionLocal.add(vec3(s, 0, s.mul(0.5))) as any;
      // Always in groups: several tufts together, never one alone; among the mushrooms too.
      const spots = clumps(Math.round(170 * scale), 4 + Math.floor(rand() * 4), 0.04, 2.4, 0.09);
      // And a few thick patches of it.
      spots.push(...clumps(Math.round(22 * scale) + 3, 34, 0.3, 2.4, 0.24));
      const mesh = new THREE.InstancedMesh(tuftGeometry(), material, spots.length);
      const m = new THREE.Matrix4();
      spots.forEach((p, i) => {
        const h = 0.025 + rand() * rand() * 0.07;
        m.compose(new THREE.Vector3(p.x, surfaceAt(p.x, p.z).y - 0.004, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)), new THREE.Vector3(h, h, h));
        mesh.setMatrixAt(i, m);
      });
      mesh.frustumCulled = false;
      out.push(cull(mesh));
    }
    // Twigs.
    {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, color: "#3a2a1e" });
      material.emissiveNode = Fn(() => vec3(0.23, 0.16, 0.11).mul(glowAt(positionWorld)).mul(0.6))() as any;
      const n = Math.round(40 * scale);
      const mesh = new THREE.InstancedMesh(twigGeometry(), material, n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        let s = inDisc(0.1, 2.3);
        for (let t = 0; t < 5 && !offLog(s); t++) s = inDisc(0.1, 2.3);
        const length = 0.04 + rand() * 0.16;
        const r = 0.0018 + rand() * 0.0025;
        m.compose(
          new THREE.Vector3(s.x, surfaceAt(s.x, s.z).y + r * 0.4, s.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, (rand() - 0.5) * 0.15)),
          new THREE.Vector3(length, r, r)
        );
        mesh.setMatrixAt(i, m);
      }
      mesh.frustumCulled = false;
      out.push(cull(mesh));
    }
    return out;
  }, [assets, tier]);
  useEffect(
    () => () => {
      for (const root of meshes)
        root.traverse((object) => {
          const mesh = object as THREE.InstancedMesh;
          if (!mesh.isInstancedMesh) return;
          (mesh.material as THREE.Material).dispose();
          mesh.dispose();
        });
    },
    [meshes]
  );
  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}
