"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  color,
  dot,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalLocal,
  normalMap,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../../shared/engine/dispose";
import { environment, sky } from "../../14-tension/backdrop";
import { KINDS, LOOKS, type Look, type Version } from "../../14-tension/versions";
import { mulberry32 } from "../../14-tension/web";
import { ON, dewShake, dropSize, makeDrops, type Drop } from "./drops";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The branch the chrysalis hangs from: one limb out of the tree on the left, across the upper part of the view and on
// out to the right, in Tension's scanned bark (CC0, Poly Haven bark_brown_02). Its shape is a function, so that anything
// may ask where its surface is: the chrysalis hangs from its underside, and the butterfly lands and walks on its top.
// Along it, s is the distance in scene units from the point above the chrysalis (negative toward the trunk); round it,
// phi is the angle from the top (positive toward the eye).

const PATH = [
  [-5.2, -0.35, -3.6],
  [-4.0, 0.42, -2.5],
  [-2.9, 0.82, -1.45],
  [-1.8, 0.93, -0.62],
  [-0.85, 0.9, -0.16],
  [0, 0.853, 0],
  [0.9, 0.845, 0.1],
  [1.85, 0.9, 0.08],
  [2.8, 1.04, -0.14],
  [3.7, 1.3, -0.6],
  [4.5, 1.68, -1.25]
].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const CURVE = new THREE.CatmullRomCurve3(PATH, false, "centripetal");
CURVE.arcLengthDivisions = 600;
const LENGTH = CURVE.getLength();
// Where it passes over the chrysalis (x = 0).
const U0 = (() => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (CURVE.getPointAt(m).x < 0) a = m;
    else b = m;
  }
  return (a + b) / 2;
})();
const S_MIN = -U0 * LENGTH;
const S_MAX = (1 - U0) * LENGTH;
// How much bark one copy of the scan covers, and how far its heights push the surface, as a fraction of the radius.
const TILE = 0.55;
const RELIEF = 0.42;
const MID = 0.7;
const OFFSET = 3.37;

function makeNoise(seed: number) {
  const random = mulberry32(seed);
  const table = new Float32Array(512).map(() => random() * 2 - 1);
  const hash = (x: number, y: number, z: number) => table[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) & 511];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const w = fade(y - yi);
    const t = fade(z - zi);
    const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), w), lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), w), t);
  };
}
const noise = makeNoise(404);

// Thickness along it: heavy at the trunk, a finger's width over the chrysalis, thinning past the fork to its tip.
const TAPER: [number, number][] = [
  [S_MIN, 0.27],
  [-4.2, 0.19],
  [-2.2, 0.142],
  [0, 0.115],
  [2.0, 0.092],
  [2.75, 0.084],
  [3.05, 0.058],
  [S_MAX, 0.02]
];
// Knots: healed scars where twigs once grew, each a raised collar round a dimple; and the swellings twigs fork from.
// [s, phi, width, height, dimple]
const KNOTS: [number, number, number, number, number][] = [
  [-3.3, 1.2, 0.16, 0.5, 0.5],
  [-1.72, -1.9, 0.11, 0.55, 0],
  [-1.2, 2.1, 0.085, 0.42, 0.75],
  [-0.42, -2.5, 0.06, 0.3, 0.6],
  [0.68, 2.6, 0.07, 0.36, 0.7],
  [1.34, -1.75, 0.09, 0.5, 0],
  [1.95, 1.5, 0.06, 0.3, 0.7],
  [2.82, -0.5, 0.12, 0.5, 0],
  [-2.78, 1.9, 0.12, 0.45, 0]
];
const wrap = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function taper(s: number) {
  for (let i = 1; i < TAPER.length; i++)
    if (s <= TAPER[i][0]) {
      const [s0, r0] = TAPER[i - 1];
      const [s1, r1] = TAPER[i];
      return r0 + (r1 - r0) * Math.min(1, Math.max(0, (s - s0) / (s1 - s0)));
    }
  return TAPER[TAPER.length - 1][1];
}

// Moss: soft cushions on the upper side in patches, thickest in the lee of knots and toward the trunk.
function mossAt(s: number, phi: number) {
  const up = Math.cos(phi);
  const n = noise(s * 1.7 + 11, Math.sin(phi) * 1.6, 3.3) * 0.6 + noise(s * 4.3, Math.sin(phi) * 4 + 2, 9.1) * 0.4;
  const more = 0.12 * smooth(-1.5, -3.5, s) + 0.06 * smooth(1.6, 2.8, s);
  return smooth(0.16, 0.42, n + more + (up - 0.75) * 0.5) * smooth(0.05, 0.55, up);
}

// The radius before the bark's own relief: taper, lumps, a little out of round, knots, moss.
function radiusAt(s: number, phi: number) {
  let r = taper(s);
  r *= 1 + 0.06 * noise(s * 1.3, 0.5, 7) + 0.03 * noise(s * 4.1, 2.5, 1);
  r *= 1 + 0.07 * noise(s * 0.9, Math.cos(phi) * 1.1 + 5, Math.sin(phi) * 1.1);
  let bump = 0;
  for (const [ks, kp, w, h, dimple] of KNOTS) {
    const ds = (s - ks) / w;
    if (Math.abs(ds) > 3) continue;
    const da = (wrap(phi - kp) * r) / w;
    const d2 = ds * ds * 0.6 + da * da;
    bump += h * (Math.exp(-d2) - dimple * 0.8 * Math.exp(-d2 / 0.09));
  }
  r *= 1 + bump;
  r += 0.016 * mossAt(s, phi);
  if (s > S_MAX - 0.04) r *= Math.sqrt(Math.max(0, (S_MAX - s) / 0.04));
  return r;
}
// How many copies of the scan go round: whole numbers, changing only where a knot or the fork hides the step.
const aroundAt = (s: number) => (s < -3.3 ? 2 : 1);

// The scan's heights, read on the CPU once the image is in, so that a foot can be set on the bark as it is drawn.
const relief = { data: null as Uint8ClampedArray | null, size: 0 };
if (typeof window !== "undefined") {
  const image = new Image();
  image.onload = () => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, size, size);
    const rgba = context.getImageData(0, 0, size, size).data;
    const data = new Uint8ClampedArray(size * size);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
    relief.data = data;
    relief.size = size;
  };
  image.src = "/codevember/tension/bark_brown_02_disp_1k.jpg";
}
function heightAt(u: number, v: number) {
  const { data, size } = relief;
  if (!data) return 0.5;
  const x = (u - Math.floor(u)) * size - 0.5;
  const y = (1 - (v - Math.floor(v))) * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) => data[(((j % size) + size) % size) * size + (((i % size) + size) % size)] / 255;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

const UP = new THREE.Vector3(0, 1, 0);
const frame = { centre: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3() };
// The middle of the branch at s, the way it runs, its top and its side toward the eye.
function frameAt(s: number, out = frame) {
  const u = Math.min(1, Math.max(0, U0 + s / LENGTH));
  CURVE.getPointAt(u, out.centre);
  CURVE.getTangentAt(u, out.tangent);
  out.up.copy(UP).addScaledVector(out.tangent, -out.tangent.y).normalize();
  out.side.crossVectors(out.tangent, out.up);
  return out;
}

export type Hold = { point: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3; radius: number };
export const makeHold = (): Hold => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(), tangent: new THREE.Vector3(), radius: 0 });

// How far along the top the butterfly may walk either side of the chrysalis: clear of knots, twigs and moss.
export const BRANCH_WALK = 2.2;

// A point of the bark as it is drawn: s along, phi round from the top (positive toward the eye).
export function branchSurface(s: number, phi: number, out: Hold = makeHold()) {
  const f = frameAt(s);
  const r0 = radiusAt(s, phi);
  const moss = mossAt(s, phi);
  const h = heightAt((phi / (Math.PI * 2)) * aroundAt(s), s / TILE + OFFSET);
  const r = r0 + (h - MID) * taper(s) * RELIEF * (1 - moss);
  out.normal.copy(f.up).multiplyScalar(Math.cos(phi)).addScaledVector(f.side, Math.sin(phi));
  out.point.copy(f.centre).addScaledVector(out.normal, r);
  out.tangent.copy(f.tangent);
  out.radius = r;
  return out;
}

// The path along its top: where a butterfly's body is carried, which way is up and which way is along (toward +x).
// The point lies on the smooth top (bark relief averaged out), so a body carried along it does not judder.
export function branchPath(s: number, out: Hold = makeHold()) {
  const f = frameAt(s);
  const r = radiusAt(s, 0) + (0.5 - MID) * taper(s) * RELIEF * (1 - mossAt(s, 0));
  out.normal.copy(f.up);
  out.point.copy(f.centre).addScaledVector(f.up, r);
  out.tangent.copy(f.tangent);
  out.radius = r;
  return out;
}

// Where the cremaster hangs from: the underside over the middle.
export const HANG = (() => {
  const f = frameAt(0);
  const r = radiusAt(0, Math.PI) + (0.45 - MID) * taper(0) * RELIEF;
  return f.centre.clone().addScaledVector(f.up, -r);
})();

// The branch itself: rings closer together where the eye is close.
function branchGeometry(fine: number) {
  const rings: number[] = [];
  for (let s = S_MIN; s < S_MAX; ) {
    rings.push(s);
    const near = Math.abs(s) < 2.6 ? 0.0065 : Math.abs(s) < 3.4 ? 0.012 : 0.03;
    s += near / fine;
  }
  rings.push(S_MAX);
  const sides = Math.round(112 * fine);
  const steps = rings.length - 1;
  const row = sides + 1;
  const position = new Float32Array((steps + 1) * row * 3);
  const normal = new Float32Array((steps + 1) * row * 3);
  const radius = new Float32Array((steps + 1) * row);
  const moss = new Float32Array((steps + 1) * row);
  const uvs = new Float32Array((steps + 1) * row * 2);
  const f = { centre: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3() };
  const n = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const s = rings[i];
    frameAt(s, f);
    const around = aroundAt(s);
    const thick = taper(s);
    for (let j = 0; j <= sides; j++) {
      const phi = (j / sides) * Math.PI * 2;
      const r = radiusAt(s, phi);
      n.copy(f.up).multiplyScalar(Math.cos(phi)).addScaledVector(f.side, Math.sin(phi));
      const k = i * row + j;
      position[k * 3] = f.centre.x + n.x * r;
      position[k * 3 + 1] = f.centre.y + n.y * r;
      position[k * 3 + 2] = f.centre.z + n.z * r;
      const m = mossAt(s, phi);
      // The scan's relief, in scene units, less under moss.
      radius[k] = thick * RELIEF * (1 - m);
      moss[k] = m;
      uvs[k * 2] = (j / sides) * around;
      uvs[k * 2 + 1] = s / TILE + OFFSET;
    }
  }
  // Normals from the shape itself, by its neighbours, joined across the seam.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const at = (i: number, j: number, out: THREE.Vector3) => {
    const k = (Math.min(steps, Math.max(0, i)) * row + ((j + sides) % sides)) * 3;
    return out.set(position[k], position[k + 1], position[k + 2]);
  };
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= sides; j++) {
      at(i + 1, j, a).sub(at(i - 1, j, b));
      at(i, j + 1, c).sub(at(i, j - 1, d));
      n.crossVectors(c, a).normalize();
      if (!Number.isFinite(n.x) || n.lengthSq() < 0.5) n.set(0, 1, 0);
      const k = (i * row + j) * 3;
      normal[k] = n.x;
      normal[k + 1] = n.y;
      normal[k + 2] = n.z;
    }
  const index = new Uint32Array(steps * sides * 6);
  let w = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const p = i * row + j;
      const q = p + row;
      // Wound so that the outside is the front (Tension's limbs are wound the other way, and show their far wall).
      index[w++] = p;
      index[w++] = p + 1;
      index[w++] = q;
      index[w++] = q;
      index[w++] = p + 1;
      index[w++] = q + 1;
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("aRadius", new THREE.BufferAttribute(radius, 1));
  geometry.setAttribute("aMoss", new THREE.BufferAttribute(moss, 1));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

// A side twig along a curve, thinning to its tip (as Tension's limbs are made).
function twigTube(curve: THREE.Curve<THREE.Vector3>, from: number, to: number, seed: number, fine: number, blunt = false) {
  const length = curve.getLength();
  const steps = Math.min(260, Math.max(16, Math.round((length / 0.012) * fine)));
  const sides = Math.max(12, Math.round(28 * fine));
  const frames = curve.computeFrenetFrames(steps, false);
  const position: number[] = [];
  const normal: number[] = [];
  const radius: number[] = [];
  const moss: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const n = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = curve.getPointAt(t);
    const s = t * length;
    let r = from + (to - from) * t ** 0.75;
    r *= 1 + 0.3 * Math.exp(-((s / (from * 3)) ** 2)) + 0.08 * noise(s * 6, 1, seed);
    // A broken end is ragged and a little flared; a growing one rounds off.
    if (blunt && t > 0.9) r *= 1 + 0.25 * noise(s * 40, 3, seed) - (t > 0.985 ? 0.75 * ((t - 0.985) / 0.015) : 0);
    else if (!blunt && t > 0.985) r *= Math.sqrt(Math.max(0, (1 - t) / 0.015));
    const around = Math.max(1, Math.round((2 * Math.PI * r) / TILE));
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      position.push(at.x + n.x * r, at.y + n.y * r, at.z + n.z * r);
      normal.push(n.x, n.y, n.z);
      radius.push(r * RELIEF);
      moss.push(0);
      uvs.push((j / sides) * around, s / TILE + seed * 0.37);
    }
  }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("aRadius", new THREE.Float32BufferAttribute(radius, 1));
  geometry.setAttribute("aMoss", new THREE.Float32BufferAttribute(moss, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

// A leaf on its stalk: folded along the midrib, drooping and curled at the tip; outline, veins and bites in the shader.
function leafGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1, 28, 12);
  const p = geometry.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 0.5;
    const y = p.getY(i) * 0.9;
    p.setXYZ(i, x, y, Math.abs(y) * 0.3 - x * x * 0.2 + Math.sin(x * 9 + y * 3) * 0.01 + Math.sin(y * 14) * 0.006 * x);
  }
  geometry.computeVertexNormals();
  return geometry;
}

type Scans = { colour: THREE.Texture; normal: THREE.Texture; height: THREE.Texture; rough: THREE.Texture };
function loadScans(fine: number): Scans {
  const size = fine < 0.75 ? "1k" : "2k";
  const load = (name: string, colour: boolean) => {
    const t = new THREE.TextureLoader().load(`/codevember/tension/bark_brown_02_${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { colour: load(`diff_${size}`, true), normal: load(`nor_gl_${size}`, false), height: load("disp_1k", false), rough: load("rough_1k", false) };
}

function dress(look: Look, scans: Scans) {
  const wet = look.air === "rain";
  // Bark: the scan pushed out by its own heights, darker down in its cracks; grey-green lichen and pale crust on the
  // upper side; cushions of moss; damp and dark underneath, wet all over in the storm.
  // Its mirror-like shine is turned well down when dry: lit from behind, every ridge of the scan otherwise catches the
  // sun at a grazing angle and draws itself as a thin white line, worst on the knots.
  const bark = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.9, specularIntensity: wet ? 0.8 : 0.2 });
  const scan = uv() as any;
  const height = texture(scans.height, scan).r as any;
  const moss = attribute("aMoss", "float") as any;
  bark.positionNode = positionLocal.add(normalLocal.mul(height.sub(MID).mul(attribute("aRadius", "float")))) as any;
  const fuzz = mx_noise_float(positionLocal.mul(260)) as any;
  bark.normalNode = normalMap(texture(scans.normal, scan), vec2(2.4, 2.4).mul(moss.oneMinus().mul(0.85).add(0.15))) as any;
  const deep = smoothstep(0.6, 0.2, height) as any;
  const N = normalWorld as any;
  const facingUp = smoothstep(-0.3, 0.7, N.y.add(N.z.mul(0.3))) as any;
  // (A little lifted: the side toward the eye is in shadow, lit only by the fill.)
  let wood: any = texture(scans.colour, scan).rgb.mul(1.45);
  wood = wood.mul(deep.mul(-0.5).add(1));
  const patch = smoothstep(0.2, 0.36, mx_fractal_noise_float(positionLocal.mul(11), 3, 2, 0.55).add(facingUp.mul(0.25)).sub(0.17)) as any;
  const lobes = smoothstep(0.0, 0.25, mx_noise_float(positionLocal.mul(80))) as any;
  wood = mix(wood, mix(color("#74826a"), color("#a7b295"), lobes).mul(height.mul(0.5).add(0.6)), patch.mul(deep.oneMinus()).mul(0.7));
  // Crust lichen: small pale and ochre discs.
  const cells = mx_noise_float(positionLocal.mul(34).add(vec3(3, 9, 1))) as any;
  const crust = smoothstep(0.52, 0.6, cells).mul(facingUp).mul(deep.oneMinus()) as any;
  wood = mix(wood, mix(color("#c9c7a4"), color("#b98a2e"), smoothstep(0.1, 0.5, mx_noise_float(positionLocal.mul(7)))), crust.mul(0.65));
  // Underneath it stays damp.
  wood = wood.mul(smoothstep(-0.9, 0.1, N.y).mul(0.35).add(0.65));
  // Moss: deep green in its hollows, yellow-green on its tips, finely tufted.
  const tuft = fuzz.mul(0.5).add(0.5) as any;
  const green = mix(color("#27360f"), color("#73902a"), tuft.mul(moss.mul(0.6).add(0.4))) as any;
  const mossy = smoothstep(0.25, 0.6, moss.add(fuzz.mul(0.12))) as any;
  wood = mix(wood, green, mossy);
  if (wet) wood = wood.mul(0.55);
  bark.colorNode = wood;
  const rough = texture(scans.rough, scan).r as any;
  // (Dry bark is kept matt: against the light its ridges otherwise glint in thin white lines, worst on the knots.)
  bark.roughnessNode = mix(wet ? rough.mul(0.45) : rough.mul(0.3).add(0.7), float(0.95), mossy) as any;
  // Backlit, the edge glows with the fuzz on it, the moss more than the bark.
  bark.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(dot(normalize(normalWorld), V).abs().oneMinus(), 4) as any;
    const back = pow(max(dot(V.negate(), sky.toLight), 0), 2) as any;
    // (Not down in the cracks: they are the darkest part of bark.)
    const glow = sky.light.mul(rim.mul(back).mul(sky.power).mul(0.06)).mul(deep.oneMinus()) as any;
    return glow.add(green.mul(sky.light).mul(sky.power).mul(mossy).mul(rim.mul(0.5).add(pow(rim, 0.4).mul(back).mul(0.22))));
  })() as any;

  const leafMaterial = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.5 });
  leafMaterial.alphaTest = 0.5;
  const lx = uv().x as any;
  const ly = uv().y.sub(0.5).mul(2) as any;
  // The blade begins a little way out: before it, only the stalk.
  const bx = lx.sub(0.14).div(0.86) as any;
  const teeth = fract(bx.mul(22)).sub(0.5).abs().mul(0.05) as any;
  const half = pow(bx.mul(Math.PI).sin().max(0), 0.7)
    .mul(float(1).sub(bx.mul(0.3)))
    .mul(0.82)
    .sub(teeth) as any;
  const blade = smoothstep(0.02, -0.02, ly.abs().sub(half)).mul(smoothstep(0, 0.01, bx)) as any;
  const stalk = smoothstep(0.03, 0.02, ly.abs()).mul(smoothstep(0.16, 0.14, lx)) as any;
  const bites = smoothstep(0.66, 0.64, mx_noise_float(vec3(lx.mul(7), ly.mul(4), positionWorld.x.mul(3).add(positionWorld.y.mul(5))))) as any;
  leafMaterial.opacityNode = max(blade.mul(bites), stalk) as any;
  const midrib = smoothstep(0.03, 0.0, ly.abs()) as any;
  const veins = smoothstep(0.05, 0.0, fract(bx.mul(9).sub(ly.abs().mul(2.4))).sub(0.5).abs()).mul(smoothstep(0.04, 0.2, ly.abs())) as any;
  const fineVeins = mx_noise_float(vec3(lx.mul(70), ly.mul(70), 2)).mul(0.5).add(0.5) as any;
  const edgeBrown = smoothstep(0.78, 1, ly.abs().div(half.max(0.01))).mul(mx_noise_float(vec3(lx.mul(5), ly.mul(5), 3)).mul(0.5).add(0.5)) as any;
  let leaf: any = mix(color(look.leaf) as any, (color(look.leaf) as any).mul(vec3(1.25, 1.2, 0.8)), lx);
  leaf = leaf.mul(mx_fractal_noise_float(vec3(lx.mul(12), ly.mul(12), 1), 3, 2, 0.5).mul(0.18).add(1)).mul(fineVeins.mul(0.16).add(0.92));
  leaf = mix(leaf, leaf.mul(1.45).add(0.04), midrib.max(veins.mul(0.6)));
  leaf = mix(leaf, color("#8a6a30"), edgeBrown.mul(0.6));
  leafMaterial.colorNode = leaf;
  leafMaterial.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const through = pow(max(dot(V, sky.toLight.negate()), 0), 3) as any;
    return leaf
      .mul(sky.light)
      .mul(sky.power)
      .mul(through.mul(0.45).add(0.035))
      .mul(float(1).sub(midrib.max(veins).mul(0.55)));
  })() as any;
  return { bark, leafMaterial };
}

// The silk pad: a tuft of fine white threads matted against the underside of the branch.
function padGeometry() {
  const random = mulberry32(9);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 90; i++) {
    const a = random() * Math.PI * 2;
    const r = 0.004 + random() * 0.04;
    const start = new THREE.Vector3(Math.cos(a) * r * 0.4, 0, Math.sin(a) * r * 0.4);
    const end = new THREE.Vector3(Math.cos(a) * r * 1.4, 0.012 + random() * 0.014, Math.sin(a) * r * 1.4);
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, -0.008 + random() * 0.004, 0));
    parts.push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(start, mid, end), 6, 0.0006 + random() * 0.0008, 4, false));
  }
  const g = mergeGeometries(parts.map((p) => p.deleteAttribute("uv") && p));
  parts.forEach((p) => p.dispose());
  return g;
}

export function Twig({ version, fine }: { version: Version; fine: number }) {
  const shapes = useMemo(() => {
    const main = branchGeometry(fine);
    const random = mulberry32(12);
    const twigs: THREE.BufferGeometry[] = [];
    const leafAt: THREE.Matrix4[] = [];
    const hold = makeHold();
    // A twig out of the branch at a knot, wandering as it grows.
    const sprout = (s: number, phi: number, heading: THREE.Vector3, r: number, length: number, seed: number, blunt = false) => {
      const f = frameAt(s);
      const start = f.centre.clone();
      const out = f.up.clone().multiplyScalar(Math.cos(phi)).addScaledVector(f.side, Math.sin(phi));
      const dir = out.clone().multiplyScalar(0.8).add(heading.clone().normalize().multiplyScalar(0.6)).normalize();
      const points = [start, start.clone().addScaledVector(out, taper(s) * 0.9)];
      const n = blunt ? 2 : 5;
      for (let p = 1; p <= n; p++) {
        dir.lerp(heading, 0.25).add(new THREE.Vector3(random() - 0.5, random() - 0.4, random() - 0.5).multiplyScalar(blunt ? 0.1 : 0.28)).normalize();
        points.push(points[points.length - 1].clone().addScaledVector(dir, length / n));
      }
      const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
      twigs.push(twigTube(curve, r, blunt ? r * 0.8 : Math.max(0.006, r * 0.25), seed, fine, blunt));
      return curve;
    };
    const leaf = (at: THREE.Vector3, dir: THREE.Vector3, size: number, roll: number) => {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll));
      leafAt.push(new THREE.Matrix4().compose(at, q, new THREE.Vector3(size, size, size)));
    };
    // Leaves alternate along a twig, each on its stalk, turned to the light with its own tilt.
    const leaves = (curve: THREE.Curve<THREE.Vector3>, count: number, size: number, from = 0.35) => {
      for (let i = 0; i < count; i++) {
        const t = from + ((1 - from) * (i + 0.6)) / count;
        const along = curve.getTangentAt(Math.min(1, t));
        const across = new THREE.Vector3().crossVectors(along, UP).normalize().multiplyScalar(i % 2 ? 1 : -1);
        const dir = across.multiplyScalar(0.8).addScaledVector(along, 0.55).add(new THREE.Vector3(0, 0.1 - random() * 0.5, 0));
        leaf(curve.getPointAt(Math.min(1, t)), dir, size * (0.7 + random() * 0.5) * (1 - 0.25 * t), (random() - 0.5) * 1.3);
      }
      leaf(curve.getPointAt(1), curve.getTangentAt(1).add(new THREE.Vector3(0, -0.25, 0.1)), size * 0.8, (random() - 0.5) * 0.8);
    };
    // Past the walk on the right: the fork, up and back toward the light with the most leaves; a second smaller sprig.
    leaves(sprout(2.82, -0.5, new THREE.Vector3(0.35, 0.8, -0.45), 0.05, 1.5, 21), 5, 0.62);
    leaves(sprout(1.34, -1.75, new THREE.Vector3(0.5, 0.25, -0.85), 0.03, 0.8, 22), 2, 0.4, 0.55);
    // On the left: one hanging forward and down, in front of the eye and out of focus; one behind.
    leaves(sprout(-2.78, 1.9, new THREE.Vector3(-0.2, -0.75, 0.6), 0.045, 1.2, 23), 4, 0.6);
    leaves(sprout(-1.72, -1.9, new THREE.Vector3(-0.5, 0.35, -0.8), 0.034, 0.9, 24), 3, 0.42, 0.5);
    // The tip of the branch itself.
    const tip = frameAt(S_MAX - 0.02);
    leaf(tip.centre.clone(), tip.tangent.clone().add(new THREE.Vector3(0, -0.2, 0.2)), 0.6, 0.3);
    leaf(frameAt(S_MAX - 0.5).centre.clone(), new THREE.Vector3(0.2, 0.6, -0.7), 0.5, -0.5);
    // A broken stub.
    sprout(-3.3, 1.2, new THREE.Vector3(-0.3, 0.2, 0.9), 0.05, 0.16, 25, true);
    const bark = mergeGeometries([main, ...twigs]);
    main.dispose();
    twigs.forEach((g) => g.dispose());

    // Dew, all over: fine beads misted over the bark and thick in the moss, drops strung along the underside where
    // water runs to and hangs, a few fat ones there that swell and fall, beads along the leaves' midribs and a drop at
    // every tip, and a few caught in the silk. Gathered in patches, never evenly.
    const drops: Drop[] = [];
    const f = { centre: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3() };
    const up = new THREE.Vector3(0, 1, 0);
    const onBranch = (s: number, phi: number, r: number, period = 0, rng = random) => {
      frameAt(s, f);
      const moss = mossAt(s, phi);
      const normal = f.up.clone().multiplyScalar(Math.cos(phi)).addScaledVector(f.side, Math.sin(phi));
      const at = f.centre.clone().addScaledVector(normal, radiusAt(s, phi));
      const under = normal.y < -0.45;
      drops.push({
        at,
        up: under ? up : normal,
        r,
        flat: under ? 1.12 + rng() * 0.25 : 0.6 + rng() * 0.2,
        on: moss > 0.35 ? ON.moss : ON.bark,
        period,
        bark: [(phi / (Math.PI * 2)) * aroundAt(s), s / TILE + OFFSET, taper(s) * RELIEF * (1 - moss)]
      });
    };
    const want = Math.round(520 * fine);
    for (let i = 0, tries = 0; i < want && tries < want * 12; tries++) {
      const s = S_MIN + 0.5 + random() * (S_MAX - S_MIN - 0.7);
      const phi = random() * Math.PI * 2;
      const upward = Math.cos(phi);
      // Thick underneath and in the moss, in patches elsewhere.
      const patch = noise(s * 2.6 + 5, Math.sin(phi) * 2.2, Math.cos(phi) * 2.2 + 7);
      const chance = 0.1 + 0.55 * smooth(0.45, 0.7, patch) + 0.32 * smooth(-0.5, -0.95, upward) + 0.45 * mossAt(s, phi);
      if (random() > chance) continue;
      // Clear of the cremaster and its pad.
      if (Math.abs(s) < 0.1 && upward < -0.7) continue;
      let r = dropSize(random);
      // Only the finest where the butterfly walks.
      if (upward > 0.75 && Math.abs(s) < BRANCH_WALK + 0.2) r = Math.min(r, 0.0045);
      // Fat ones only underneath, where they can hang.
      if (upward > -0.6) r = Math.min(r, 0.013);
      onBranch(s, phi, r);
      i++;
    }
    // The few that drip: each swells over half a minute or so, lets go and falls; a few where the eye first looks.
    for (let i = 0; i < 6; i++) {
      const s = -2.9 + random() * 5.6;
      if (Math.abs(s) < 0.3) continue;
      onBranch(s, Math.PI + (random() - 0.5) * 0.3, 0.017 + random() * 0.009, 18 + random() * 20);
    }
    const dripping = mulberry32(77);
    for (const s of [-1.24, 0.47, 1.38]) onBranch(s + (dripping() - 0.5) * 0.1, Math.PI + (dripping() - 0.5) * 0.3, 0.017 + dripping() * 0.008, 20 + dripping() * 16, dripping);
    // On the leaves.
    const leafTip = new THREE.Vector3();
    const turned = new THREE.Quaternion();
    const size = new THREE.Vector3();
    const at = new THREE.Vector3();
    for (const m of leafAt) {
      m.decompose(at, turned, size);
      const local = (x: number, y: number) => new THREE.Vector3(x, y * 0.9, Math.abs(y * 0.9) * 0.3 - x * x * 0.2).multiplyScalar(size.x).applyQuaternion(turned).add(at);
      const face = new THREE.Vector3(0, 0, 1).applyQuaternion(turned);
      const top = face.y < 0 ? -1 : 1;
      // A drop hanging from the tip.
      leafTip.copy(local(0.985, 0));
      drops.push({ at: leafTip.clone(), up, r: (0.011 + random() * 0.012) * Math.min(1.2, size.x * 1.6), flat: 1.25, on: ON.leaf, period: random() < 0.25 ? 18 + random() * 30 : 0 });
      // Beads along the midrib and out along the veins.
      const beads = Math.round((4 + random() * 5) * fine);
      for (let k = 0; k < beads; k++) {
        const x = 0.18 + random() * 0.74;
        const y = (random() - 0.5) * 0.5 * Math.sin(Math.PI * x) * (random() < 0.5 ? 0.25 : 1);
        const normal = new THREE.Vector3(0.4 * x, -Math.sign(y) * 0.27, 1).normalize().applyQuaternion(turned).multiplyScalar(top);
        drops.push({ at: local(x, y), up: normal.y < -0.5 ? up : normal, r: dropSize(random, 0.85), flat: normal.y < -0.5 ? 1.15 : 0.62 + random() * 0.15, on: ON.leaf });
      }
    }
    // Caught in the silk.
    for (let i = 0; i < 7; i++) {
      const a = random() * Math.PI * 2;
      const d = 0.012 + random() * 0.035;
      drops.push({ at: new THREE.Vector3(HANG.x + Math.cos(a) * d, HANG.y - 0.006 - random() * 0.012, HANG.z + Math.sin(a) * d), up, r: 0.0028 + random() * 0.004, flat: 1.05, on: ON.silk });
    }
    return { bark, leafGeo: leafGeometry(), leafAt, pad: padGeometry(), drops };
  }, [fine]);
  const scans = useMemo(() => loadScans(fine), [fine]);
  const dressed = useMemo(() => KINDS.map((v) => dress(LOOKS[v], scans)), [scans]);
  const silk = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 });
    m.colorNode = color("#f2efe6") as any;
    m.emissiveNode = sky.light.mul(sky.power).mul(0.08) as any;
    return m;
  }, []);
  const dew = useMemo(() => makeDrops(shapes.drops, { detail: fine < 0.75 ? 1 : 2, height: scans.height, mid: MID }), [shapes, scans, fine]);
  // A knock to the branch dies away.
  useFrame((_, delta) => {
    dewShake.value *= Math.exp(-Math.min(delta, 0.1) * 2.5);
    // (In development, `window.__scene = { dew: false }` hides the drops, for measuring.)
    dew.mesh.visible = (globalThis as { __scene?: { dew?: boolean } }).__scene?.dew !== false;
  });
  const groups = useMemo(
    () =>
      dressed.map((d) => {
        const group = new THREE.Group();
        group.add(new THREE.Mesh(shapes.bark, d.bark));
        const leaves = new THREE.InstancedMesh(shapes.leafGeo, d.leafMaterial, shapes.leafAt.length);
        shapes.leafAt.forEach((m, i) => leaves.setMatrixAt(i, m));
        leaves.computeBoundingSphere();
        group.add(leaves);
        return group;
      }),
    [dressed, shapes]
  );
  useDispose(scans.colour, scans.normal, scans.height, scans.rough, shapes.bark, shapes.leafGeo, shapes.pad, silk, dew.material, dew.geometry, dew.geometry2);
  useDispose(...dressed.flatMap((d) => [d.bark, d.leafMaterial]));
  return (
    <>
      {groups.map((group, i) => (
        <primitive key={KINDS[i]} object={group} visible={KINDS[i] === version} />
      ))}
      <primitive object={dew.mesh} />
      <mesh geometry={shapes.pad} material={silk} position={[HANG.x, HANG.y + 0.004, HANG.z]} rotation={[Math.PI, 0, 0]} />
    </>
  );
}

// The cremaster: a short dark stalk ending in the hooks set in the pad.
export function cremasterGeometry(length: number) {
  const points = [new THREE.Vector2(0.0, 0), new THREE.Vector2(0.012, 0.001), new THREE.Vector2(0.01, -length * 0.3), new THREE.Vector2(0.007, -length * 0.7), new THREE.Vector2(0.012, -length), new THREE.Vector2(0.0, -length * 1.05)];
  return new THREE.LatheGeometry(points, 16);
}

export const cremasterMaterial = () => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 });
  m.colorNode = mix(color("#1d140c"), color("#4a3a22"), smoothstep(-0.05, 0, positionGeometry.y)) as any;
  return m;
};
