"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  instancedArray,
  vec4,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  If,
  Fn,
  fract,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  time,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { BEYOND, type Desert, hash, homeNode, PALM_KINDS, palmShape, PATCH, sandBetween, WIND } from "./desert";
import { eye, inView, useListed, useView, world } from "./render";
// Past this far from the eye, in metres, a palm is drawn coarse.
const NEAR = 2.4;

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Light on a leaf, stem or trunk, worked out for each pixel: the sun on the face toward the eye, as much of it as gets
// there; the sun through a thin leaf from behind, coming out yellower and glowing most when the eye looks toward the
// sun through it; the sky, less of it down among the others; the warm light off the ground; and a waxy sheen.
function litPlant(albedo: any, normal: any, lit: any, ao: any, thin: any, sheen: any, at: any = positionWorld): any {
  const eye = normalize(cameraPosition.sub(at)) as any;
  // A leaf's tip may have no face to it; it faces up rather than nowhere.
  const n0 = normalize(normal.add(vec3(0, 1e-5, 0))) as any;
  const n = dot(n0, eye).lessThan(0).select(n0.negate(), n0) as any;
  const toSun = world.toSun as any;
  const sun = world.sun.mul(world.power).mul(lit) as any;
  const face = max(dot(n, toSun), float(0)) as any;
  const behind = max(dot(n.negate(), toSun), float(0))
    .mul(0.5)
    .add(pow(max(dot(eye.negate(), toSun), float(0)), float(5)).mul(0.9))
    .mul(thin) as any;
  const sky = mix(world.horizon, world.zenith, n.y.mul(0.5).add(0.5)).mul(0.5).mul(ao) as any;
  const ground = (world.sand as any).mul(world.sun).mul(world.power).mul(0.07).mul(float(1).sub(n.y).mul(0.5)).mul(ao) as any;
  const half = normalize(toSun.add(eye)) as any;
  const shine = pow(max(dot(n, half), float(0)), float(48))
    .mul(sheen)
    .mul(face.greaterThan(0).select(float(1), float(0))) as any;
  const glow = albedo.mul(vec3(0.9, 1.15, 0.45)) as any;
  return albedo
    .mul(
      sun
        .mul(face)
        .mul(mix(float(0.55), float(1), ao))
        .add(sky)
        .add(ground)
    )
    .add(glow.mul(sun).mul(behind))
    .add(sun.mul(shine));
}

// One of four values by a kind given as a node.
const byKind4 = (kind: any, values: number[]): any => values.slice(1).reduce((v: any, value, n) => kind.greaterThan(n + 0.5).select(float(value), v), float(values[0]));

// Grass where the ground has grown green, in clumps of blades, each clump of one kind: fine short turf, broad arching
// leaves, tufts of fountain grass sending up feathery heads, reeds in and round the water with plumes of their own,
// fine silvery feather grass, stiff blue-grey spiky tufts, dark sedge, and wild oats nodding with seed; the odd flower in
// the turf once the oasis is old. Each blade curves out from its clump as it rises, sways in gusts
// that sweep across the field, and is lit for every pixel, rounded across, the sun shining through it from behind.
const BLADES = 10;
// For each kind (turf, broad, fountain, reed, feather, spiky, sedge, oats): how tall, shortest to tallest, in metres; how wide at the foot; how far
// it arches out, least to most, as a share of its height; how wide its clump is; and how much it gives to the wind.
const GRASS = {
  short: [0.018, 0.035, 0.03, 0.08, 0.04, 0.02, 0.03, 0.04],
  tall: [0.045, 0.08, 0.06, 0.17, 0.09, 0.04, 0.07, 0.085],
  wide: [0.0022, 0.0055, 0.004, 0.0035, 0.0012, 0.0016, 0.005, 0.0025],
  archLow: [0.15, 0.45, 0.4, 0.05, 0.6, 0.02, 0.3, 0.2],
  archHigh: [0.55, 1.0, 0.9, 0.3, 1.3, 0.15, 0.7, 0.55],
  clump: [0.02, 0.022, 0.018, 0.03, 0.016, 0.012, 0.022, 0.02],
  flex: [1, 0.8, 0.9, 0.45, 1.4, 0.25, 0.7, 0.9],
  // How often a blade is a flowering stem instead of a leaf.
  stems: [0, 0, 0.18, 0.15, 0.12, 0, 0, 0.4]
};
// Each kind's own colour against the grass: broad a little bluer, feather grass silvery, spiky tufts blue-grey, sedge
// dark, wild oats golden.
const TINT = [
  [1, 1, 1],
  [0.92, 1, 1.05],
  [1, 1, 1],
  [1, 1, 1],
  [1.18, 1.12, 0.9],
  [0.78, 0.95, 1.12],
  [0.74, 0.88, 0.72],
  [1.22, 1.06, 0.68]
];
export function Grass({ desert, count }: { desert: Desert; count: number }) {
  const geometry = useMemo(() => {
    // A blade a unit high, from -1 to 1 across, its width set in the shader.
    const rows = 7;
    const position: number[] = [];
    const index: number[] = [];
    for (let k = 0; k < rows; k++) position.push(-1, k / rows, 0, 1, k / rows, 0);
    position.push(0, 1, 0);
    for (let k = 0; k < rows - 1; k++) index.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    index.push((rows - 1) * 2, (rows - 1) * 2 + 1, rows * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setIndex(index);
    return g;
  }, []);
  // Each blade worked out once a frame, rather than at every point along it: where its foot is and how tall it stands;
  // its kind and whether it flowers, how far it arches, the sun on it, and how moist its ground is.
  useView();
  const listing = useListed(count, 39);
  // Both in one buffer, two to a blade, since a compute pass may bind only eight.
  const { blades, pass } = useMemo(() => {
    const blades = instancedArray(count * 2, "vec4");
    // One thread to a clump: what the clump shares is worked out once, and a clump with no chance of coming up yet is
    // passed over, as the bare desert is at first.
    const pass = Fn(() => {
      const clump = float(instanceIndex) as any;
      // About one clump in eight grows at the foot of a palm instead, round its trunk: low grass and dry brush that come
      // up as the palm does.
      const atPalm = hash(clump.add(9.9)).lessThan(0.12) as any;
      const palm = desert.palms.element(int(hash(clump.add(7.7)).mul(desert.palmSites))) as any;
      const around = hash(clump.add(8.8)).mul(Math.PI * 2) as any;
      const foot = palm.xy.add(vec2(around.cos(), around.sin()).mul(hash(clump.add(6.6)).mul(0.24).add(0.05))) as any;
      const scattered = vec2(hash(clump.mul(0.37)), hash(clump.mul(0.71).add(2)))
        .sub(0.5)
        .mul(PATCH + BEYOND * 2) as any;
      const centre = atPalm.select(foot, scattered) as any;
      const underPalm = atPalm.select(smoothstep(0.25, 0.6, palm.z), float(0)) as any;
      const least = hash(clump.add(5.1)).mul(0.5) as any;
      // About one clump in nine never comes up, to keep the green from crowding; the rest wait for green near enough to
      // their own threshold, with room for the green a few centimetres off, where their blades stand.
      const waiting = hash(clump.add(12.3))
        .greaterThanEqual(0.89)
        .or(underPalm.lessThanEqual(0).and(desert.greenNear(centre).add(0.15).lessThan(least))) as any;
      If(waiting.not(), () => {
        const onPatch = desert.onPatch(centre) as any;
        const k0 = desert.columnOf(centre) as any;
        const depth = onPatch.select(desert.cells.element(k0).y, float(0)) as any;
        // Brush at a palm's foot is drier, browning at its tips.
        const moist = onPatch.select(desert.life.element(k0).x, desert.greenNear(centre)).mul(atPalm.select(float(0.45), float(1))) as any;
        // Its kind: reeds where the clump stands in water or the wettest ground, else turf, broad or fountain grass.
        const pick = hash(clump.add(3.3)) as any;
        const reed = depth.greaterThan(0.0006).or(moist.greaterThan(0.93).and(pick.lessThan(0.45))) as any;
        const mixOf = [
          [0.3, 0],
          [0.45, 1],
          [0.58, 2],
          [0.7, 4],
          [0.82, 5],
          [0.92, 6]
        ].reduceRight((k: any, [below, value]) => pick.lessThan(below).select(float(value), k), float(7)) as any;
        const kind = atPalm.select(pick.lessThan(0.4).select(float(0), pick.lessThan(0.7).select(float(1), float(5))), reed.select(float(3), mixOf)) as any;
        const spread = byKind4(kind, GRASS.clump) as any;
        Loop(BLADES, ({ i }: any) => {
          const id = int(instanceIndex).mul(BLADES).add(i) as any;
          const seed = float(id) as any;
          // Out from the clump's middle, the way it arches.
          const angle = hash(seed.add(12.7)).mul(Math.PI * 2) as any;
          const out = vec2(angle.cos(), angle.sin()) as any;
          const p = centre.add(out.mul(spread).mul(pow(hash(seed.add(11.3)), float(0.6)))) as any;
          const threshold = least.add(hash(seed.add(5.1)).mul(0.1)) as any;
          const shown = max(smoothstep(threshold, threshold.add(0.2), desert.greenNear(p)), underPalm) as any;
          If(shown.greaterThan(0), () => {
            const k = desert.columnOf(p) as any;
            const inside = desert.onPatch(p) as any;
            // A flowering stem: fountain grass and reeds send some up, taller and thin with a head; the turf has the odd flower.
            const flowerPick = hash(seed.add(9.1)) as any;
            const stem = flowerPick.lessThan(byKind4(kind, GRASS.stems)).and(world.oasis.greaterThan(0.25)) as any;
            const flower = kind.lessThan(0.5).and(flowerPick.lessThan(world.oasis.mul(0.08))) as any;
            const tall = mix(byKind4(kind, GRASS.short), byKind4(kind, GRASS.tall), pow(hash(seed.add(1.3)), float(1.3)))
              .mul(mix(float(0.75), float(1.5), world.oasis))
              .mul(stem.select(float(1.7), float(1)))
              .mul(shown) as any;
            // Reeds reach up through the water; deeper water drowns any grass.
            const water = inside.select(desert.cells.element(k).y, float(0)) as any;
            const height = tall.add(water.mul(1.2)).mul(float(1).sub(smoothstep(0.015, 0.03, water))) as any;
            const arch = mix(byKind4(kind, GRASS.archLow), byKind4(kind, GRASS.archHigh), hash(seed.add(6.2))).mul(stem.select(float(0.25), float(1))) as any;
            const base = inside.select(sandBetween(desert, p).x, homeNode(p)) as any;
            const lit = inside.select(desert.light.element(k).x, desert.palmShade(p)) as any;
            blades.element(id.mul(2)).assign(vec4(p, base, height));
            blades.element(id.mul(2).add(1)).assign(vec4(kind.add(stem.select(float(8), float(0))).add(flower.select(float(16), float(0))), arch, lit, moist));
            listing.keep(id, height.greaterThan(0.0005).and(inView(vec3(p.x, base.add(height.mul(0.5)), p.y), height.add(0.03))));
          });
        });
      });
    })().compute(count / BLADES);
    return { blades, pass };
  }, [desert, count, listing]);
  useFrame(({ gl }) => (gl as unknown as THREE.WebGPURenderer).compute(listing.listed ? [listing.reset, pass] : pass));
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    // The blade's own point, as built: across it (-1 to 1) and up it (0 to 1).
    const blade = attribute("position", "vec3") as any;
    const id = listing.which();
    const seed = float(id) as any;
    const at = blades.element(id.mul(2)) as any;
    const own = blades.element(id.mul(2).add(1)) as any;
    const p = at.xy as any;
    const height = at.w as any;
    const code = own.x as any;
    const flower = code.greaterThan(15.5) as any;
    const stem = code.mod(16).greaterThan(7.5) as any;
    const kind = code.mod(8) as any;
    const arch = own.y as any;
    const moist = own.w as any;
    const angle = hash(seed.add(12.7)).mul(Math.PI * 2) as any;
    const out = vec2(angle.cos(), angle.sin()) as any;
    const y = blade.y as any;
    // How wide the blade is up its length: a leaf narrowing to its tip; a stem, thin, swelling into its head.
    const headFrom = flower.select(float(0.86), float(0.68)) as any;
    const head = smoothstep(headFrom, headFrom.add(0.02), y).mul(pow(max(sin(y.sub(headFrom).div(float(1).sub(headFrom)).clamp(0, 1).mul(Math.PI)), float(0)), float(0.6))) as any;
    const leaf = byKind4(kind, GRASS.wide)
      .mul(pow(float(1).sub(y), float(0.6)))
      .mul(smoothstep(0, 0.15, y).mul(0.25).add(0.75))
      .mul(hash(seed.add(7.7)).mul(0.6).add(0.7)) as any;
    const headWide = flower.select(float(0.005), kind.equal(3).select(float(0.006), kind.equal(7).select(float(0.0035), float(0.0045)))) as any;
    const width = stem.or(flower).select(max(head.mul(headWide), float(0.0011).mul(float(1).sub(y))), leaf) as any;
    // Gusts sweeping across the field, and each blade's own flutter.
    const front = dot(p, vec2(...WIND))
      .mul(2.3)
      .sub(time.mul(1.6))
      .add(sin(p.x.mul(1.3).sub(p.y.mul(0.9)).add(time.mul(0.3))).mul(1.5)) as any;
    const gust = pow(sin(front).mul(0.5).add(0.5), float(2)) as any;
    const push = gust
      .mul(0.7)
      .add(sin(time.mul(5).add(seed.mul(6))).mul(0.06))
      .add(0.1)
      .mul(byKind4(kind, GRASS.flex))
      .mul(0.6) as any;
    const wind = vec2(...WIND) as any;
    const bend = out.mul(arch).add(wind.mul(push)) as any;
    const twist = hash(seed.add(8.3)).sub(0.5).mul(1.2) as any;
    const side = vec2(out.y.negate(), out.x) as any;
    const across = vec3(side.x.mul(twist.cos()).sub(out.x.mul(twist.sin())), 0, side.y.mul(twist.cos()).sub(out.y.mul(twist.sin()))) as any;
    const base = at.z as any;
    const spine = vec3(
      p.x.add(bend.x.mul(y.mul(y)).mul(height)),
      base.add(y.mul(height).mul(float(1).sub(length(bend).mul(0.35).mul(y)))).sub(0.001),
      p.y.add(bend.y.mul(y.mul(y)).mul(height))
    ) as any;
    // Never thinner than about a pixel, so a far meadow reads as a meadow rather than flickering.
    const distance = length(spine.sub(cameraPosition)) as any;
    const seen = max(
      width,
      distance
        .mul(world.pixel)
        .mul(0.6)
        .mul(width.greaterThan(0).select(float(1), float(0)))
    ) as any;
    m.positionNode = spine.add(across.mul(blade.x).mul(seen)) as any;
    const along = vec3(bend.x.mul(y.mul(2)).mul(height), height.mul(float(1).sub(length(bend).mul(0.7).mul(y))), bend.y.mul(y.mul(2)).mul(height)) as any;
    const lit = own.z as any;
    // Its colour: green deepening to its root and paling to its tip, lush where the ground is wettest and drying to straw
    // in patches where it is not; some broad leaves and reeds browned at their tips; the heads straw, plum or flower.
    const albedo = (() => {
      const straw = mix(vec3(0.62, 0.55, 0.36), world.sand, 0.2) as any;
      const lush = mix(world.grass, world.grassTip, pow(y, float(1.2))) as any;
      const patches = sin(p.x.mul(2.1).add(1.3))
        .mul(sin(p.y.mul(1.7).sub(0.4)))
        .mul(0.5)
        .add(0.5)
        .add(sin(p.x.mul(5.3).sub(p.y.mul(4.1))).mul(0.15)) as any;
      const dryness = smoothstep(0.25, 0.85, patches)
        .mul(float(1).sub(moist.mul(0.7)))
        .mul(kind.equal(3).select(float(0.3), float(1))) as any;
      const leafy = mix(lush, mix(world.grassTip, straw, 0.6), dryness.mul(float(0.55).sub(world.oasis.mul(0.3)))) as any;
      const browned = kind
        .greaterThan(0.5)
        .and(hash(seed.add(4.9)).lessThan(0.35))
        .select(smoothstep(0.78, 0.98, y), float(0)) as any;
      const tinted = mix(leafy, straw.mul(0.8), browned)
        .mul(hash(seed.add(4.4)).mul(0.36).add(0.82))
        .mul(TINT.slice(1).reduce((v: any, t, n) => kind.greaterThan(n + 0.5).select(vec3(t[0], t[1], t[2]), v), vec3(1))) as any;
      const plume = kind.equal(3).select(mix(world.trunk, vec3(0.42, 0.36, 0.3), 0.5), kind.equal(7).select(vec3(0.78, 0.66, 0.4), mix(vec3(0.7, 0.64, 0.55), world.flower, 0.08))) as any;
      // A reed's stem is green to its plume; fountain grass dries to straw under its head.
      const holder = kind.equal(3).select(mix(world.grass, world.grassTip, 0.55), straw) as any;
      return flower.select(y.greaterThan(headFrom).select(world.flower, tinted), stem.select(y.greaterThan(headFrom).select(plume, holder), tinted));
    })();
    // Lit at its points, which run down its edges: rounded across it, the sun through it, shaded down at its root.
    const normal = normalize(normalize(cross(across, along).add(vec3(0, 1e-6, 0))).add(across.mul(blade.x).mul(0.45))) as any;
    const ao = mix(float(0.3), float(1), smoothstep(0, 0.75, y)) as any;
    const thin = stem.or(flower).select(float(0.5), float(1)) as any;
    const shade = varying(litPlant(albedo, normal, lit, ao, thin, float(0.18), m.positionNode)) as any;
    // Down to the pixel: its veins running along it, and its edges a touch darker.
    const across01 = varying(blade.x) as any;
    m.colorNode = shade.mul(cos(across01.mul(9)).mul(0.05).add(0.95)).mul(float(1).sub(pow(abs(across01), float(4)).mul(0.15))) as any;
    return m;
  }, [blades, listing]);
  const mesh = useMemo(() => {
    if (listing.listed) geometry.setIndirect(listing.args);
    const object = new THREE.Mesh(geometry, material);
    object.count = count;
    object.frustumCulled = false;
    return object;
  }, [geometry, material, count, listing]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// Palms, built once for each kind a unit of their size: a trunk, a crown of fronds, and what hangs under it.
// Each vertex carries what it is (0 trunk, 1 leaflet, 2 midrib or leaf stalk, 3 dead leaf, 4 fruit, 5 fan blade), how
// far along that part, which frond or, round the trunk, how far round, and how far out along a leaflet or ray; and
// the half-width of the leaf there and its side, to keep thin leaves from thinning below a pixel far off.
type Built = {
  position: number[];
  part: number[];
  across: number[];
  index: number[];
};
const V = THREE.Vector3;
const UP = new V(0, 1, 0);
// Building the coarse version, for palms far off: fewer, broader leaflets and rays, fewer rings, no stubs.
let COARSE = false;

// A strip of leaf along a line of points, each with its half-width as a vector, and what to carry for each point.
function ribbon(b: Built, centres: THREE.Vector3[], halves: THREE.Vector3[], parts: number[][]) {
  const first = b.position.length / 3;
  centres.forEach((c, k) => {
    for (const side of [-1, 1]) {
      const h = halves[k];
      b.position.push(c.x + h.x * side, c.y + h.y * side, c.z + h.z * side);
      b.across.push(h.x, h.y, h.z, side);
      b.part.push(...parts[k]);
    }
  });
  for (let k = 0; k < centres.length - 1; k++) {
    const a = first + k * 2;
    b.index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

// A trunk up from the foot to the crown: rings of this radius at a height up it (0 to 1).
// It narrows into the crown and closes over in a low dome a little above it, hidden among the frond bases.
function trunk(b: Built, radius: (t: number) => number) {
  const RINGS = COARSE ? 10 : 28;
  const CAP = 4;
  const SIDES = COARSE ? 7 : 12;
  const first = b.position.length / 3;
  for (let r = 0; r <= RINGS + CAP; r++)
    for (let a = 0; a <= SIDES; a++) {
      const over = Math.max(0, r - RINGS) / CAP;
      const t = r <= RINGS ? r / RINGS : 1 + 0.025 * Math.sin((over * Math.PI) / 2);
      const narrow = r <= RINGS ? 1 - 0.3 * Math.pow(Math.max(0, (t - 0.9) / 0.1), 2) : 0.7 * Math.cos((over * Math.PI) / 2);
      const angle = (a / SIDES) * Math.PI * 2;
      const rr = radius(Math.min(t, 1)) * narrow;
      b.position.push(Math.cos(angle) * rr, t, Math.sin(angle) * rr);
      b.across.push(0, 0, 0, 0);
      b.part.push(0, Math.min(t, 1), a / SIDES, 0);
    }
  for (let r = 0; r < RINGS + CAP; r++)
    for (let a = 0; a < SIDES; a++) {
      const k = first + r * (SIDES + 1) + a;
      b.index.push(k, k + SIDES + 1, k + 1, k + 1, k + SIDES + 1, k + SIDES + 2);
    }
}

// A feather-leaved frond: a midrib arching out and over, and leaflets along both its sides, longest in its middle,
// raised in a V (up) or hanging (down), each drooping at its tip.
type Pinnate = {
  angle: number;
  reach: number;
  rise: number;
  droop: number;
  leaflets: number;
  length: number;
  width: number;
  up: number;
  curl: number;
  frond: number;
  what: number;
};
function pinnate(b: Built, o: Pinnate) {
  const S = COARSE ? 6 : 16;
  const along = (t: number) => {
    const local = new V(t * o.reach, (o.rise * t - o.droop * t * t) * o.reach, 0);
    return local.applyAxisAngle(UP, o.angle);
  };
  const tangent = (t: number) =>
    along(Math.min(1, t + 0.01))
      .sub(along(Math.max(0, t - 0.01)))
      .normalize();
  const spine: THREE.Vector3[] = [];
  const halves: THREE.Vector3[] = [];
  const parts: number[][] = [];
  for (let s = 0; s <= S; s++) {
    const t = s / S;
    spine.push(along(t));
    halves.push(
      new V()
        .crossVectors(tangent(t), UP)
        .normalize()
        .multiplyScalar(0.011 * (1 - 0.8 * t))
    );
    parts.push([o.what === 3 ? 3 : 2, t, o.frond, 0]);
  }
  ribbon(b, spine, halves, parts);
  const START = 0.14;
  // A fixed little random number for a leaflet, so every palm of a kind is built alike and the shader varies them.
  const rand = (n: number) => {
    const x = Math.sin(n * 127.1 + o.frond * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const leaflets = COARSE ? Math.ceil(o.leaflets * 0.4) : o.leaflets;
  for (let l = 0; l < leaflets; l++)
    for (const side of [-1, 1]) {
      const id = l * 2 + (side > 0 ? 1 : 0);
      // Now and then a leaflet torn away, or broken short.
      if (rand(id) < 0.05) continue;
      const torn = rand(id + 0.5) < 0.08 ? 0.45 + rand(id + 0.7) * 0.3 : 1;
      const jitter = Math.sin(l * 12.9 + side * 3.1 + o.frond * 7.7) * 0.4;
      const t = START + ((1 - START) * (l + 0.5 + jitter * 0.5)) / leaflets;
      const P = along(t);
      const T = tangent(t);
      const H = new V().crossVectors(T, UP).normalize().multiplyScalar(side);
      const size = o.length * Math.pow(Math.sin(Math.PI * (0.12 + 0.82 * ((t - START) / (1 - START)))), 0.7) * (1 + jitter * 0.15) * torn;
      // Leaflets stand in more than one plane up the rib, as on a real frond, each a little off its neighbours.
      const rank = ((l % 3) - 1) * 0.32 + (rand(id + 0.2) - 0.5) * 0.3;
      const swing = 0.5 + (rand(id + 0.3) - 0.5) * 0.35;
      const dir = H.clone()
        .multiplyScalar(Math.cos(swing))
        .addScaledVector(T, Math.sin(swing))
        .addScaledVector(UP, o.up + rank)
        .normalize();
      const twist = (rand(id + 0.4) - 0.5) * 1.4;
      const centres: THREE.Vector3[] = [];
      const hs: THREE.Vector3[] = [];
      const ps: number[][] = [];
      const SEG = COARSE ? 2 : 5;
      for (let k = 0; k <= SEG; k++) {
        const u = k / SEG;
        centres.push(
          P.clone()
            .addScaledVector(dir, size * u)
            .addScaledVector(UP, -o.curl * (0.8 + rand(id + 0.6) * 0.5) * size * u * u)
        );
        // Narrow and lance-shaped: widest a little out from the rib, drawn out to a fine point, turning as it goes.
        const width = o.width * (COARSE ? 1.6 : 0.8) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + u * 1.25)), 0.6) * Math.pow(1 - u * 0.85, 0.7);
        hs.push(
          T.clone()
            .applyAxisAngle(dir, twist * u)
            .multiplyScalar(k === SEG ? o.width * 0.06 : width)
        );
        ps.push([o.what === 3 ? 3 : 1, t, o.frond, u]);
      }
      ribbon(b, centres, hs, ps);
    }
}

// A round leaf on a stalk: the stalk arching out and up, and the blade at its end, a fan of pleated rays, split near
// their tips, which hang.
type Fan = {
  angle: number;
  reach: number;
  rise: number;
  droop: number;
  span: number;
  rays: number;
  radius: number;
  frond: number;
  what: number;
  face: number;
  // Where its stalk springs from, if not the crown's middle (a clump's other stems), and how narrow its segments are.
  base?: THREE.Vector3;
  split?: number;
};
function fan(b: Built, o: Fan) {
  const S = COARSE ? 4 : 8;
  const along = (t: number) => new V(t * o.reach, (o.rise * t - o.droop * t * t) * o.reach, 0).applyAxisAngle(UP, o.angle).add(o.base ?? new V());
  const spine: THREE.Vector3[] = [];
  const halves: THREE.Vector3[] = [];
  const parts: number[][] = [];
  const outward = new V(1, 0, 0).applyAxisAngle(UP, o.angle);
  const sideways = new V().crossVectors(UP, outward).normalize();
  for (let s = 0; s <= S; s++) {
    spine.push(along(s / S));
    halves.push(sideways.clone().multiplyScalar(0.005 * (1 - 0.5 * (s / S))));
    parts.push([o.what === 3 ? 3 : 2, s / S, o.frond, 0]);
  }
  ribbon(b, spine, halves, parts);
  const C = along(1);
  const reachOut = outward.clone().multiplyScalar(Math.cos(o.face)).addScaledVector(UP, Math.sin(o.face)).normalize();
  const normal = new V().crossVectors(sideways, reachOut).normalize();
  const rays = COARSE ? Math.ceil(o.rays * 0.5) : o.rays;
  for (let r = 0; r < rays; r++) {
    const phi = (r / (rays - 1) - 0.5) * o.span;
    const ray = reachOut.clone().multiplyScalar(Math.cos(phi)).addScaledVector(sideways, Math.sin(phi));
    const across = new V().crossVectors(normal, ray).normalize();
    const pleat = r % 2 ? 1 : -1;
    const centres: THREE.Vector3[] = [];
    const hs: THREE.Vector3[] = [];
    const ps: number[][] = [];
    const length = o.radius * (0.85 + 0.15 * Math.cos(phi * 1.3));
    const SEG = COARSE ? 2 : 4;
    for (let k = 0; k <= SEG; k++) {
      const u = k / SEG;
      centres.push(
        C.clone()
          .addScaledVector(ray, length * u)
          .addScaledVector(normal, pleat * 0.006 * Math.sin(Math.PI * Math.min(1, u * 1.4)))
          .addScaledVector(UP, -0.35 * length * Math.pow(u, 3))
      );
      const wedge = (o.span / rays) * length * u * 0.55 * (u > 0.7 ? 0.55 : 1) * (o.split ?? 1);
      hs.push(across.clone().multiplyScalar(k === SEG ? wedge * 0.2 : wedge));
      ps.push([o.what, u, o.frond, r / (rays - 1)]);
    }
    ribbon(b, centres, hs, ps);
  }
}

// Fruit: a bunch of little balls, as small rounded solids, all marked as fruit.
function bunch(b: Built, at: THREE.Vector3, count: number, radius: number, spread: THREE.Vector3, seed: number) {
  const ball = new THREE.IcosahedronGeometry(radius, count > 8 ? 0 : 1);
  const p = ball.attributes.position as THREE.BufferAttribute;
  let s = seed;
  const random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  for (let n = 0; n < count; n++) {
    const centre = at.clone().add(new V((random() - 0.5) * spread.x, -random() * spread.y, (random() - 0.5) * spread.z));
    const first = b.position.length / 3;
    for (let k = 0; k < p.count; k++) {
      b.position.push(centre.x + p.getX(k), centre.y + p.getY(k), centre.z + p.getZ(k));
      b.across.push(0, 0, 0, 0);
      b.part.push(4, n / count, 0, 0);
    }
    const index = ball.index ? Array.from(ball.index.array) : Array.from({ length: p.count }, (_, k) => k);
    for (const k of index) b.index.push(first + k);
  }
  ball.dispose();
}

function finish(b: Built) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.position, 3));
  g.setAttribute("part", new THREE.Float32BufferAttribute(b.part, 4));
  g.setAttribute("across", new THREE.Float32BufferAttribute(b.across, 4));
  g.setIndex(b.index);
  g.computeVertexNormals();
  return g;
}
const empty = (): Built => ({ position: [], part: [], across: [], index: [] });

// A date palm: a thick trunk scaled with old leaf bases, a dense crown of stiff blue-green fronds, the youngest
// standing up and the oldest bowed, a few dead ones hanging brown, and bunches of dates under the crown.
// The cut bases of old fronds left on a trunk, the boots: stiff stubs angling up and out in a spiral, thicker up near the
// crown.
function boots(b: Built, radius: (t: number) => number, from: number, rows: number) {
  if (COARSE) return;
  for (let k = 0; k < rows; k++) {
    const t = from + (1 - from) * (k / rows) * 0.97;
    const angle = k * 2.399;
    const out = new V(Math.cos(angle), 0, Math.sin(angle));
    const r = radius(t);
    const reach = r * (0.9 + 0.5 * ((k * 0.618) % 1));
    const side = new V(-out.z, 0, out.x).multiplyScalar(r * 0.5);
    const centres = [new V().addScaledVector(out, r * 0.7), new V().addScaledVector(out, r + reach * 0.6), new V().addScaledVector(out, r + reach)];
    // The stub's tip sits a little higher up the trunk than its base.
    const parts = [0, 0.5, 1].map((u) => [0, Math.min(1, t + u * 0.035), angle / (Math.PI * 2), 0]);
    ribbon(b, centres, [side, side.clone().multiplyScalar(0.8), side.clone().multiplyScalar(0.25)], parts);
  }
}

function datePalm() {
  const b = empty();
  boots(b, (t) => 0.05 * (1 - 0.12 * t), 0.25, 70);
  trunk(b, (t) => 0.05 * (1 + 0.5 * Math.pow(1 - t, 8)) * (1 - 0.12 * t) * (1 + 0.18 * Math.pow(t, 6)));
  const tiers = [
    { count: 6, rise: 1.3, droop: 0.5, reach: 0.34, tilt: 0.3 },
    { count: 10, rise: 0.6, droop: 0.75, reach: 0.5, tilt: 0 },
    { count: 9, rise: 0.15, droop: 1.0, reach: 0.48, tilt: 0.6 }
  ];
  let frond = 0;
  for (const tier of tiers)
    for (let f = 0; f < tier.count; f++, frond++)
      pinnate(b, {
        angle: (f / tier.count) * Math.PI * 2 + tier.tilt + Math.sin(frond * 7.3) * 0.2,
        reach: tier.reach * (1 + Math.sin(frond * 3.1) * 0.08),
        rise: tier.rise,
        droop: tier.droop + Math.sin(frond * 5.7) * 0.1,
        leaflets: 36,
        length: 0.15,
        width: 0.011,
        up: 0.55,
        curl: 0.2,
        frond,
        what: 1
      });
  for (let f = 0; f < 6; f++)
    pinnate(b, {
      angle: (f / 6) * Math.PI * 2 + 0.4,
      reach: 0.32,
      rise: -1.6,
      droop: 0.2,
      leaflets: 18,
      length: 0.08,
      width: 0.009,
      up: -0.6,
      curl: 0.3,
      frond: frond++,
      what: 3
    });
  for (let k = 0; k < 4; k++) {
    const angle = (k / 4) * Math.PI * 2 + 0.7;
    bunch(b, new V(Math.cos(angle) * 0.06, -0.04, Math.sin(angle) * 0.06), 16, 0.012, new V(0.04, 0.08, 0.04), 11 + k * 31);
  }
  return finish(b);
}

// A slender palm: a thin grey trunk, ringed, curving up from a flared foot, long fronds arching over and drooping, their
// leaflets hanging, and a few green nuts at the crown.
function slenderPalm() {
  const b = empty();
  trunk(b, (t) => 0.03 * (1 + 0.8 * Math.pow(1 - t, 10)) * (1 - 0.3 * t) * (1 + 0.25 * Math.pow(t, 10)));
  let frond = 0;
  for (let f = 0; f < 13; f++, frond++)
    pinnate(b, {
      angle: (f / 13) * Math.PI * 2 + Math.sin(f * 7.3) * 0.25,
      reach: 0.62 * (1 + Math.sin(f * 3.1) * 0.08),
      rise: 0.6,
      droop: 1.25 + Math.sin(f * 5.7) * 0.15,
      leaflets: 42,
      length: 0.17,
      width: 0.012,
      up: -0.45,
      curl: 0.6,
      frond,
      what: 1
    });
  for (let f = 0; f < 3; f++, frond++)
    pinnate(b, {
      angle: (f / 3) * Math.PI * 2 + 0.5,
      reach: 0.4,
      rise: 1.4,
      droop: 0.4,
      leaflets: 30,
      length: 0.1,
      width: 0.01,
      up: 0.1,
      curl: 0.2,
      frond,
      what: 1
    });
  bunch(b, new V(0.02, -0.02, 0.01), 6, 0.026, new V(0.08, 0.04, 0.08), 77);
  return finish(b);
}

// A fan palm: a straight grey trunk, closely ringed, crowned with round pleated leaves on long stalks, over a skirt of
// dead leaves hanging down it.
function fanPalm() {
  const b = empty();
  trunk(b, (t) => 0.038 * (1 + 0.35 * Math.pow(1 - t, 8)) * (1 - 0.15 * t));
  let frond = 0;
  for (let f = 0; f < 16; f++, frond++) {
    const young = f >= 12;
    fan(b, {
      angle: (f / 12) * Math.PI * 2 + Math.sin(f * 7.3) * 0.2,
      reach: young ? 0.12 : 0.2,
      rise: young ? 2.2 : 1.0,
      droop: young ? 0.5 : 0.7 + Math.sin(f * 5.7) * 0.1,
      span: 3.6,
      rays: 26,
      radius: young ? 0.12 : 0.16,
      frond,
      what: 5,
      face: young ? 1.1 : 0.55
    });
  }
  for (let f = 0; f < 14; f++)
    fan(b, {
      angle: (f / 14) * Math.PI * 2,
      reach: 0.05,
      rise: -0.2,
      droop: 1.4,
      span: 1.6,
      rays: 14,
      radius: 0.13,
      frond: frond++,
      what: 3,
      face: -1.35
    });
  return finish(b);
}

// A coconut palm: a slim, ringed grey-brown trunk swelling at its foot and curving up, long fronds arching right over
// with their leaflets hanging, and a cluster of big green coconuts under the crown.
function coconutPalm() {
  const b = empty();
  trunk(b, (t) => 0.026 * (1 + 1.1 * Math.pow(1 - t, 12)) * (1 - 0.25 * t));
  let frond = 0;
  for (let f = 0; f < 15; f++, frond++)
    pinnate(b, {
      angle: (f / 15) * Math.PI * 2 + Math.sin(f * 7.3) * 0.3,
      reach: 0.72 * (1 + Math.sin(f * 3.1) * 0.1),
      rise: 0.55 + Math.sin(f * 2.3) * 0.2,
      droop: 1.45 + Math.sin(f * 5.7) * 0.2,
      leaflets: 46,
      length: 0.2,
      width: 0.011,
      up: -0.75,
      curl: 0.75,
      frond,
      what: 1
    });
  for (let f = 0; f < 3; f++, frond++)
    pinnate(b, {
      angle: (f / 3) * Math.PI * 2 + 0.9,
      reach: 0.42,
      rise: 1.6,
      droop: 0.5,
      leaflets: 32,
      length: 0.11,
      width: 0.01,
      up: 0.05,
      curl: 0.25,
      frond,
      what: 1
    });
  bunch(b, new V(0.015, -0.03, -0.01), 9, 0.034, new V(0.1, 0.05, 0.1), 41);
  return finish(b);
}

// A palm bush: no trunk to speak of, a fountain of fronds springing up from the sand and arching out every way, young
// ones standing straight up in its middle.
function bushPalm() {
  const b = empty();
  trunk(b, (t) => 0.035 * (1 - 0.3 * t));
  let frond = 0;
  const tiers = [
    { count: 8, rise: 0.9, droop: 1.0, reach: 0.55, up: 0.15 },
    { count: 7, rise: 1.6, droop: 0.9, reach: 0.5, up: 0.3 },
    { count: 5, rise: 2.6, droop: 0.7, reach: 0.38, up: 0.45 }
  ];
  for (const tier of tiers)
    for (let f = 0; f < tier.count; f++, frond++)
      pinnate(b, {
        angle: (f / tier.count) * Math.PI * 2 + frond * 0.7 + Math.sin(frond * 7.3) * 0.25,
        reach: tier.reach * (1 + Math.sin(frond * 3.1) * 0.12),
        rise: tier.rise + Math.sin(frond * 4.3) * 0.2,
        droop: tier.droop + Math.sin(frond * 5.7) * 0.15,
        leaflets: 30,
        length: 0.14,
        width: 0.011,
        up: tier.up,
        curl: 0.3,
        frond,
        what: 1
      });
  return finish(b);
}

// A sago palm: a short, stout trunk shaggy with old leaf bases, crowned with a dense rosette of stiff, glossy, dark
// fronds, finely and evenly cut, arching out and over in every direction.
function sagoPalm() {
  const b = empty();
  trunk(b, (t) => 0.07 * (1 + 0.15 * Math.pow(1 - t, 4)) * (1 - 0.1 * t));
  let frond = 0;
  const tiers = [
    { count: 13, rise: 0.55, droop: 1.15, reach: 0.5, up: 0.05 },
    { count: 11, rise: 1.1, droop: 1.0, reach: 0.46, up: 0.15 },
    { count: 7, rise: 1.9, droop: 0.8, reach: 0.36, up: 0.3 }
  ];
  for (const tier of tiers)
    for (let f = 0; f < tier.count; f++, frond++)
      pinnate(b, {
        angle: (f / tier.count) * Math.PI * 2 + frond * 0.37 + Math.sin(frond * 7.3) * 0.15,
        reach: tier.reach * (1 + Math.sin(frond * 3.1) * 0.08),
        rise: tier.rise,
        droop: tier.droop + Math.sin(frond * 5.7) * 0.1,
        leaflets: 52,
        length: 0.085,
        width: 0.0065,
        up: tier.up,
        curl: 0.08,
        frond,
        what: 1
      });
  return finish(b);
}

// A fan palm bush: a clump of short stems, each sending up stiff fans on long thin stalks, the fans cut deep into
// narrow, pointed segments, so the whole bush is a spiky green mound.
function fanBush() {
  const b = empty();
  trunk(b, (t) => 0.03 * (1 - 0.3 * t));
  let frond = 0;
  const stems = [new V(0, 0, 0), new V(0.07, -0.02, 0.04), new V(-0.06, -0.03, 0.05), new V(0.02, -0.03, -0.08)];
  stems.forEach((base, k) => {
    for (let f = 0; f < 8; f++, frond++) {
      const out = f / 8 + k * 0.13;
      fan(b, {
        angle: out * Math.PI * 2 + Math.sin(frond * 7.3) * 0.3,
        reach: 0.16 + 0.08 * Math.abs(Math.sin(frond * 2.7)),
        rise: 1.6 + Math.sin(frond * 4.1) * 0.7,
        droop: 0.5 + Math.abs(Math.sin(frond * 5.3)) * 0.4,
        span: 2.4,
        rays: 22,
        radius: 0.13 + 0.03 * Math.sin(frond * 1.9),
        frond,
        what: 5,
        face: 0.7 + Math.sin(frond * 3.7) * 0.35,
        base,
        split: 0.45
      });
    }
  });
  return finish(b);
}

const BUILD = [datePalm, slenderPalm, fanPalm, coconutPalm, bushPalm, sagoPalm, fanBush];
// One kind of palm, built in full or coarse for far off.
function buildPalm(kind: number, coarse: boolean) {
  COARSE = coarse;
  try {
    return BUILD[kind]();
  } finally {
    COARSE = false;
  }
}

// Palms of one kind, at its run of the places palms can stand, grown as far as each has: a tuft of fronds first, then a
// trunk lifting them, leaning its own way, swaying in the wind, its fronds and their leaflets fluttering.
function PalmsOfKind({ desert, kind, coarse }: { desert: Desert; kind: number; coarse: boolean }) {
  const geometry = useMemo(() => buildPalm(kind, coarse), [kind, coarse]);
  const { from, to } = PALM_KINDS[kind];
  useView();
  const listing = useListed(to - from, geometry.index!.count);
  const pass = useMemo(
    () =>
      Fn(() => {
        const s = desert.palms.element(int(instanceIndex).add(from)) as any;
        // Near palms in full, far ones coarse.
        const far = length(vec2(s.x, s.y).sub(eye.xz)).greaterThan(NEAR) as any;
        listing.keep(
          instanceIndex,
          s.z
            .greaterThan(0.01)
            .and(inView(vec3(s.x, 0.3, s.y), float(1.1)))
            .and(coarse ? far : far.not())
        );
      })().compute(to - from),
    [desert, from, to, listing, coarse]
  );
  useFrame(({ gl }) => {
    if (listing.listed) (gl as unknown as THREE.WebGPURenderer).compute([listing.reset, pass]);
  });
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      fog: false
    });
    const part = attribute("part", "vec4") as any;
    const across = attribute("across", "vec4") as any;
    const site = listing.which().add(from) as any;
    const s = desert.palms.element(site) as any;
    const base = desert.onPatch(s.xy).select(sandBetween(desert, s.xy).x, homeNode(s.xy)) as any;
    const extra = max(desert.roots.element(site).sub(base), float(0)) as any;
    const { growth, seed, crown, turn, spine, thick, unfurl, woody } = palmShape(s, kind, extra);
    const what = part.x as any;
    const along = part.y as any;
    const turnY = (v: any) => vec3(v.x.mul(turn.cos()).sub(v.z.mul(turn.sin())), v.y, v.x.mul(turn.sin()).add(v.z.mul(turn.cos()))) as any;
    const local = positionLocal as any;
    // No two trunks alike: swellings and pinches up them, knots here and there, a little out of round.
    // Read round the trunk by direction rather than by its 0-to-1 angle, so the seam where they meet stays closed.
    const round = vec2(part.z.mul(Math.PI * 2).cos(), part.z.mul(Math.PI * 2).sin()) as any;
    const bump = sin(along.mul(23).add(seed.mul(7)).add(round.x.mul(2)))
      .mul(sin(along.mul(9).add(round.y.mul(3)).add(seed)))
      .mul(0.06)
      .add(smoothstep(0.85, 1, sin(along.mul(31).add(seed.mul(5))).mul(sin(round.x.mul(3).add(round.y).add(seed)))).mul(0.16)) as any;
    const trunkAt = spine(along).add(
      turnY(vec3(local.x, 0, local.z))
        .mul(thick)
        .mul(bump.add(1))
    ) as any;
    // Fronds bob along their length, each its own way, and their leaflets flutter faster.
    const bob = sin(time.mul(3.3).add(along.mul(4)).add(part.z.mul(1.7)).add(seed))
      .mul(0.025)
      .mul(along) as any;
    const flutter = sin(time.mul(11).add(part.z.mul(3)).add(along.mul(25)))
      .mul(0.008)
      .mul(part.w)
      .mul(what.equal(1).select(float(1), float(0))) as any;
    // Fruit only on a palm long grown in an old oasis.
    const fruiting = growth
      .greaterThan(0.92)
      .and(world.oasis.greaterThan(0.3))
      .and(hash(seed.add(8)).lessThan(0.75)) as any;
    // Dead fronds hang only under an old crown.
    const kept = what
      .equal(4)
      .and(fruiting.not())
      .select(float(0), what.equal(3).select(smoothstep(0.85, 1, growth), float(1))) as any;
    // Each frond comes out folded up into the spear and opens in its own time, the young ones last.
    const open = smoothstep(0, 1, unfurl.mul(1.5).sub(hash(seed.add(part.z.mul(0.37))).mul(0.5))) as any;
    const folded = vec3(local.x.mul(0.1), local.y.mul(0.3).add(length(local).mul(0.95)), local.z.mul(0.1)) as any;
    const crownAt = spine(float(1)).add(
      turnY(mix(folded, local, open).add(vec3(0, bob.add(flutter).mul(open), 0)))
        .mul(crown)
        .mul(kept)
    ) as any;
    const at = what.lessThan(0.5).select(trunkAt, crownAt) as any;
    const placed = vec3(s.x, base.sub(0.004), s.y).add(at) as any;
    // A leaf never thinner than about a pixel.
    const half = length(across.xyz).mul(crown) as any;
    const wanted = length(placed.sub(cameraPosition)).mul(world.pixel).mul(0.55) as any;
    const widen = turnY(normalize(across.xyz.add(vec3(1e-6))))
      .mul(across.w)
      .mul(max(wanted.sub(half), float(0)))
      .mul(half.greaterThan(0).select(float(1), float(0))) as any;
    m.positionNode = growth.greaterThan(0.01).select(placed.add(widen), vec3(0, -50, 0)) as any;
    const normal = varying(turnY(attribute("normal", "vec3"))) as any;
    // The sun at its foot, for the trunk low down; the crown stands above the dunes' shadows.
    const foot = varying(desert.onPatch(s.xy).select(desert.light.element(desert.columnOf(s.xy)).x, desert.palmShade(s.xy))) as any;
    const fold = varying(turnY(normalize(across.xyz.add(vec3(1e-6))))) as any;
    const own = varying(vec3(hash(seed.add(6.6)), hash(seed.add(2.2)), hash(seed.add(part.z.mul(0.37))))) as any;
    // Per frond, two numbers for its tone; per leaflet, one for its own shade.
    const hashed = varying(vec3(hash(seed.add(part.z.mul(1.31)).add(0.4)), hash(part.z.mul(2.71).add(seed.mul(0.3))), hash(part.y.mul(97.1).add(part.z.mul(13.7)).add(seed)))) as any;
    // How far up the trunk it has turned from green shoot to brown wood: from the foot upward as it grows.
    const wood = varying(smoothstep(0, 0.15, woody.mul(1.15).sub(along))) as any;
    m.colorNode = Fn(() => {
      const w = part.x as any;
      const t = part.y as any;
      const u = part.w as any;
      const n = normalize(normal).toVar();
      // The trunk's bark: date palms scaled with the diamond stubs of old leaves; the others ringed, closely on a fan palm.
      const round = part.z as any;
      // Worked out only for the trunk's own pixels: a branch, so the many leaf pixels never pay for the bark's noise.
      const bark = vec3(0).toVar();
      const tilt = float(0).toVar();
      If(w.lessThan(0.5), () => {
        const rough = mx_noise_float(vec3(round.mul(12), t.mul(60), 3)) as any;
        const scales = vec2(round.mul(13).add(t.mul(64).floor().mul(0.5)), t.mul(64).add(rough.mul(0.15))) as any;
        const cell = fract(scales).sub(0.5).abs() as any;
        const diamond = cell.x.add(cell.y).add(rough.mul(0.08)) as any;
        const ringCount = kind === 2 ? 110 : kind === 3 ? 45 : 70;
        const ring = fract(t.mul(ringCount).add(mx_noise_float(vec3(round.mul(6), t.mul(20), 5)).mul(0.35))) as any;
        const fibre = mx_noise_float(vec3(round.mul(40), t.mul(300), 1))
          .mul(0.5)
          .add(0.5) as any;
        bark.assign(
          kind === 0 || kind === 5
            ? (world.trunk as any)
                .mul(kind === 5 ? 0.7 : 1)
                .mul(smoothstep(0.6, 0.38, diamond).mul(0.6).add(0.35))
                .mul(fibre.mul(0.4).add(0.8))
                .mul(mix(vec3(1), vec3(1.15, 1.05, 0.9), smoothstep(0.3, 0, diamond)))
            : (mix(world.trunk, vec3(0.62, 0.6, 0.56), kind === 1 || kind === 3 ? 0.5 : 0.35) as any).mul(smoothstep(0, 0.1, ring).mul(0.16).add(0.84)).mul(fibre.mul(0.3).add(0.85))
        );
        // Each scale of a date palm's trunk faces a little up at its top, each ring of the others' a little out.
        tilt.assign(
          kind === 0 || kind === 5
            ? fract(scales.y)
                .sub(0.5)
                .mul(kind === 5 ? 2 : 1.2)
            : ring.sub(0.5).mul(0.25)
        );
      });
      // A leaflet is folded along its middle, its two halves facing a little apart.
      const side = across.w as any;
      n.assign(w.lessThan(0.5).select(normalize(n.add(vec3(0, tilt, 0))), w.equal(1).select(normalize(n.add(fold.mul(side).mul(0.5))), n)));
      const grey = vec3(dot(world.frond as any, vec3(0.3, 0.59, 0.11))) as any;
      // No two fronds quite alike: some yellower, some bluer or darker; each leaflet a shade of its own; sago palms a deep
      // glossy green, the fan bushes a fresh pale one.
      const kindColour = mix(world.frond as any, mix(grey, vec3(0.42, 0.52, 0.5).mul(grey.x.mul(2)), kind === 0 ? 0.6 : 0.2), kind === 0 ? 0.35 : 0.2).mul(
        kind === 5 ? vec3(0.62, 0.78, 0.62) : kind === 6 ? vec3(1.05, 1.12, 0.92) : vec3(1)
      ) as any;
      const frondTone = mix(vec3(1.12, 1.08, 0.72), vec3(0.82, 0.94, 1.02), hashed.x).mul(hashed.y.mul(0.3).add(0.85)) as any;
      // Some palms are darker and olive, none quite lime.
      const palmTone = mix(float(0.58), float(1.02), own.y) as any;
      const olive = mix(kindColour, vec3(0.16, 0.27, 0.1).mul(kindColour.length().mul(1.6)), 0.3) as any;
      const frondColour = olive
        .mul(mix(vec3(1), frondTone, 0.8))
        .mul(hashed.z.mul(0.16).add(0.92))
        .mul(palmTone) as any;
      const ageing = smoothstep(16, 26, part.z).mul(kind === 0 ? 0.25 : 0) as any;
      const brown = mix(world.trunk, world.sand, 0.4) as any;
      const leaflet = mix(mix(frondColour, mix(world.grassTip, world.frond, 0.5), ageing), brown, smoothstep(0.82, 1, u).mul(own.z.mul(0.3).add(0.1)))
        .mul(mix(float(0.7), float(1.1), t))
        .mul(own.z.mul(0.25).add(0.88))
        .mul(mix(float(1.18), float(1), smoothstep(0, 0.3, abs(side)))) as any;
      const midrib = mix(frondColour, world.grassTip, 0.45).mul(0.9) as any;
      const dead = mix(world.trunk, vec3(0.3, 0.27, 0.23), 0.45).mul(own.z.mul(0.3).add(0.75)) as any;
      const fruit = kind === 0 ? vec3(0.72, 0.3, 0.07) : kind === 3 ? vec3(0.4, 0.45, 0.13) : vec3(0.35, 0.42, 0.12);
      const blade = mix(frondColour, world.grassTip, 0.25)
        .mul(fract(u.mul(25)).sub(0.5).abs().mul(0.3).add(0.85))
        .mul(mix(float(0.75), float(1.1), t)) as any;
      const albedo = w
        .lessThan(0.5)
        .select(
          mix(mix(world.frond as any, world.grassTip as any, 0.35).mul(1.1), bark.mul(own.x.mul(0.25).add(0.85)), wood),
          w.lessThan(1.5).select(leaflet, w.lessThan(2.5).select(midrib, w.lessThan(3.5).select(dead, w.lessThan(4.5).select(fruit, blade))))
        ) as any;
      // Shade down in the crown, and on the trunk just under it; the sun at its foot low down the trunk.
      const ao = w
        .lessThan(0.5)
        .select(
          float(1).sub(smoothstep(0.8, 1, t).mul(kind === 1 ? 0.3 : 0.55)),
          w.equal(3).select(float(0.55), w.equal(4).select(float(0.6), mix(float(0.45), float(1), smoothstep(0, 0.7, t))))
        ) as any;
      const lit = w.lessThan(0.5).select(mix(foot, float(1), smoothstep(0.1, 0.6, t)), float(1)) as any;
      const thin = w
        .equal(1)
        .or(w.equal(5))
        .select(float(1), w.equal(3).select(float(0.5), w.equal(2).select(float(0.25), float(0)))) as any;
      const sheen = w.lessThan(0.5).select(float(0.03), w.equal(4).select(float(0.5), w.equal(3).select(float(0.05), float(0.3)))) as any;
      return litPlant(albedo, n, lit, ao, thin, sheen);
    })() as any;
    return m;
  }, [desert, kind, from, listing]);
  const mesh = useMemo(() => {
    if (listing.listed) geometry.setIndirect(listing.args);
    const object = new THREE.Mesh(geometry, material);
    object.count = to - from;
    object.frustumCulled = false;
    return object;
  }, [geometry, material, from, to, listing]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

export function Palms({ desert }: { desert: Desert }) {
  return (
    <>
      {PALM_KINDS.map((_, kind) => (
        <PalmsOfKind key={kind} desert={desert} kind={kind} coarse={false} />
      ))}
      {PALM_KINDS.map((_, kind) => (
        <PalmsOfKind key={"far" + kind} desert={desert} kind={kind} coarse />
      ))}
    </>
  );
}
