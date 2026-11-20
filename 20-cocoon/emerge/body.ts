import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  mod,
  modelWorldMatrix,
  modelViewMatrix,
  normalize,
  normalView,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { sky } from "../../14-tension/backdrop";
import { live } from "./live";
import { skyAt } from "./sky";
import { look, pixelAt, relief } from "./look";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The butterfly's body, in body space: +y toward the head, +z the back, +x its right; in forewing lengths, scaled to
// the species by its group. A head with great faceted eyes and furred palps, a thorax deep in fine hair, an abdomen
// of overlapping rings that is swollen with fluid when it first comes out and bends against the wingbeat in flight.

export const JOINT = -0.1; // where abdomen meets thorax
export const ABDOMEN = 0.4;
const HEAD_Y = 0.166;
const HEAD_R = 0.046;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// Radius along the body, by height, and how far the back and the belly stand from the axis there.
function profile(y: number) {
  const head = Math.abs(y - HEAD_Y) < HEAD_R ? Math.sqrt(HEAD_R * HEAD_R - (y - HEAD_Y) ** 2) : 0;
  const t = (y - 0.012) / 0.12;
  const thorax = Math.abs(t) < 1 ? 0.066 * Math.sqrt(1 - Math.pow(Math.abs(t), 2.5)) : 0;
  const neck = y > 0.1 && y < 0.14 ? 0.03 : 0;
  let abdomen = 0;
  const a = (JOINT + 0.03 - y) / (ABDOMEN + 0.03);
  if (a > 0 && a < 1) {
    abdomen = 0.049 * (0.6 + 0.4 * smooth(a / 0.24)) * (1 - 0.62 * Math.pow(smooth((a - 0.24) / 0.76), 1.15)) * Math.sqrt(Math.min(1, (1 - a) / 0.05));
    // Rings: each plate widens to its hind edge, where it laps over the next.
    const seg = a * 8.4;
    if (a > 0.06) abdomen *= 0.985 + 0.045 * Math.pow(seg - Math.floor(seg), 0.7);
  }
  const r = Math.max(head, thorax, neck, abdomen);
  const onThorax = thorax >= r - 1e-6;
  const onHead = head >= r - 1e-6 && !onThorax;
  return { r, up: onThorax ? 1.12 : onHead ? 1.02 : 1.04, down: onThorax ? 0.94 : onHead ? 1 : 0.98, wide: onThorax || onHead ? 1 : 0.93 };
}

// A point of the skin: by height and by angle round the body from the back.
function skin(y: number, phi: number, out: THREE.Vector3) {
  const p = profile(y);
  const c = Math.cos(phi);
  return out.set(Math.sin(phi) * p.r * p.wide, y, c * p.r * (c > 0 ? p.up : p.down) + (y > 0.12 ? 0.004 : 0));
}

// The skin's radius at a height, for whoever needs the body's bulk on the CPU.
export const bodyRadius = (y: number) => profile(y).r * 1.12;

const abOf = (y: number) => (y < JOINT ? Math.min(1, (JOINT - y) / ABDOMEN) : 0);

export function bodyGeometry() {
  const rows = 230;
  const sides = 48;
  const top = HEAD_Y + HEAD_R;
  const bottom = JOINT - ABDOMEN;
  const pos: number[] = [];
  const ab: number[] = [];
  const index: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i <= rows; i++) {
    const y = top + (bottom - top) * (i / rows);
    for (let j = 0; j <= sides; j++) {
      skin(y, (j / sides) * Math.PI * 2, v);
      pos.push(v.x, v.y, v.z);
      ab.push(abOf(y));
    }
  }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      // (Counter-clockwise seen from outside: the skin faces out.)
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("aAb", new THREE.Float32BufferAttribute(ab, 1));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // The seam down the back: the same normal on both of its sides.
  const n = geometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = 0; i <= rows; i++) {
    const a = i * (sides + 1);
    const b = a + sides;
    v.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z);
    n.setXYZ(b, v.x, v.y, v.z);
  }
  return geometry;
}

// The species' build, then the abdomen: swollen, then emptying into the wings; bent at the waist, more toward the tip.
function place(p: any, a: any) {
  const swell = live.swell as any;
  const stout = vec3(p.x.mul(look.girth), p.y, p.z.mul(look.girth)) as any;
  const local = stout.sub(vec3(0, JOINT, 0)) as any;
  const under = step(0.0001, a) as any;
  const fat = float(1).add(swell.mul(0.6).mul(sin(a.mul(Math.PI)).pow(0.6))) as any;
  const long = mix(float(1), look.long.mul(float(1).add(swell.mul(0.18))), under) as any;
  const q = vec3(local.x.mul(fat), local.y.mul(long), local.z.mul(fat)) as any;
  const angle = live.tuck.mul(a) as any;
  const c = cos(angle) as any;
  const s = sin(angle) as any;
  // About x: the tip swings toward the belly (-z) for positive tuck, toward the back for negative.
  return vec3(q.x, q.y.mul(c).sub(q.z.mul(s)), q.y.mul(s).add(q.z.mul(c))).add(vec3(0, JOINT, 0));
}

const hash2 = (a: any, b: any) => fract(sin(a.mul(127.1).add(b.mul(311.7))).mul(43758.5453)) as any;

// Pale markings, by where on the body (rest position): the monarch's white dots on a black head and thorax and along
// the sides of the abdomen; the paper kite's white streaks down the thorax and its pale belly.
export const marking = Fn(([p]: [any]) => {
  const phi = atan(p.x, p.z) as any;
  const side = abs(phi) as any;
  const y = p.y as any;
  const onHead = smoothstep(0.122, 0.13, y) as any;
  const onThorax = smoothstep(JOINT - 0.005, JOINT + 0.01, y).mul(onHead.oneMinus()) as any;
  const onAbdomen = smoothstep(JOINT + 0.005, JOINT - 0.01, y) as any;
  // Dots on a staggered grid, some missing, each a little off its place.
  const gy = y.div(0.031) as any;
  const row = floor(gy) as any;
  const gp = phi.div(0.5).add(mod(row, 2).mul(0.5)) as any;
  const col = floor(gp) as any;
  const h = hash2(row, col) as any;
  const h2 = hash2(col.add(7.3), row.add(1.7)) as any;
  const off = vec2(fract(gy).sub(0.5).add(h.sub(0.5).mul(0.3)).mul(0.031), fract(gp).sub(0.5).add(h2.sub(0.5).mul(0.3)).mul(0.5 * 0.055)) as any;
  // (On the head they are small: a few paired dots, not patches.) Small and uneven, as a monarch's are: each its own
  // size, its rim wavering, and a few drawn out into short streaks along the body.
  const big = mix(float(0.0045), float(0.0078), h2).mul(look.spot).mul(onHead.mul(0.45).oneMinus()) as any;
  const around = atan(off.y, off.x) as any;
  const waver = sin(around.mul(3).add(h.mul(17))).mul(0.16).add(sin(around.mul(5).add(h2.mul(23))).mul(0.09)).add(1) as any;
  const drawn = vec2(off.x.mul(mix(float(1), float(0.55), step(0.78, h2))), off.y) as any;
  // (Soft-rimmed: the white scales thin out at the edge into the dark ones.)
  const dots = smoothstep(big.mul(waver), big.mul(waver).mul(0.55), length(drawn)).mul(step(0.22, h)) as any;
  const small = smoothstep(float(0.006), float(0.003), length(off)).mul(step(0.3, h)) as any;
  // Where the dots are allowed: all over the head, the sides and underside of the thorax and its collar, a row along
  // each side of the abdomen.
  const thoraxSides = smoothstep(0.22, 0.4, side).add(smoothstep(0.085, 0.1, y)).min(1) as any;
  const abdomenSides = smoothstep(1.35, 1.6, side).mul(smoothstep(2.7, 2.4, side)) as any;
  const dotted = dots.mul(onHead.add(onThorax.mul(thoraxSides)).min(1)).add(small.mul(onAbdomen).mul(abdomenSides)) as any;
  // Streaks: four broken lines down the back of the thorax, and the belly pale along the abdomen.
  const line = smoothstep(0.13, 0.05, abs(side.sub(0.38))).add(smoothstep(0.13, 0.05, abs(side.sub(0.95)))).add(smoothstep(0.14, 0.06, abs(side.sub(1.7)))) as any;
  const broken = smoothstep(-0.2, 0.3, sin(y.mul(95).add(side.mul(3)))) as any;
  const streaks = line.mul(broken).mul(onThorax) as any;
  const belly = smoothstep(1.55, 1.95, side).mul(onAbdomen).mul(0.85) as any;
  const two = max(max(streaks, dotted), belly) as any;
  // A Morpho: pale stripes along the sides of the thorax and across the face, a pale line down each flank.
  const stripe = smoothstep(0.12, 0.05, abs(side.sub(1.25))).add(smoothstep(0.1, 0.04, abs(side.sub(2.1)))).mul(onThorax.add(onHead.mul(0.8))).mul(0.8) as any;
  return select(look.marks.lessThan(0.5), float(0), select(look.marks.lessThan(1.5), dotted, select(look.marks.lessThan(2.5), two, stripe)));
}) as any;

// Fill light for things the sun is behind: sky from above, garden from below.
// (The garden itself, blurred, in the direction the surface faces: what really falls on it from that side.)
const ambient = (n: any) => mix(sky.horizon, sky.zenith, n.y.mul(0.5).add(0.5)).mul(0.3).add(skyAt(n, 1).mul(0.45)) as any;

export function bodyMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.82, specularIntensity: 0.3 });
  const a = attribute("aAb", "float") as any;
  m.positionNode = place(positionLocal, a) as any;
  const p = positionGeometry as any;
  const phi = atan(p.x, p.z) as any;
  // Scales: tiny overlapping plates in rows round the body, each its own shade.
  const sv = p.y.mul(520) as any;
  const su = phi.mul(46).add(mod(floor(sv), 2).mul(0.5)) as any;
  const shade = hash2(floor(su), floor(sv)) as any;
  const lap = fract(sv) as any;
  // (Faded out well before the rows come near a pixel apart: closer than that they beat into broad rings.)
  const fine = clamp(float(1).sub(fwidth(sv).mul(3.5)), 0, 1) as any;
  // Each ring of the abdomen pales toward its hind edge.
  const seg = fract(a.mul(8.4)) as any;
  const edge = smoothstep(0.72, 0.98, seg).mul(step(0.06, a)) as any;
  const belly = smoothstep(1.7, 2.6, abs(phi)) as any;
  const mark = marking(p) as any;
  // (The skin under the coat is near the coat's own colour, so that between the hairs it reads as more coat.)
  const ground = mix(live.body, live.fur, belly.mul(0.5).add(edge.mul(0.35)).mul(0.4).add(0.6)).mul(look.ink).mul(0.8) as any;
  const grain = mix(float(1), shade.mul(0.5).add(0.72).mul(lap.mul(0.3).add(0.82)), fine) as any;
  // Swollen with fluid, the abdomen's plates are pulled apart and the pale membrane between them shows as bands.
  const gap = smoothstep(0.3, 0.02, seg).mul(step(0.06, a)).mul(live.swell) as any;
  const tone = mix(mix(ground, vec3(0.42, 0.36, 0.24), gap.mul(0.75)), look.mark, mark) as any;
  // (Wet from the chrysalis: darker, and smooth enough to shine.)
  m.colorNode = tone.mul(grain).mul(mix(float(1), float(0.6), live.wet.mul(mark.oneMinus()))) as any;
  // (Matt under its coat: a smooth skin catches the sun as one hard sheet down the back of the thorax.)
  m.roughnessNode = mix(float(0.9).sub(edge.mul(0.1)), float(0.74), live.wet) as any;
  // (Damp, not lacquered: under a wet coat a hard highlight would show every hair as a dark speck on a white streak.)
  m.specularIntensityNode = mix(float(0.12), float(0.05), live.wet) as any;
  m.normalNode = relief(lap.mul(lap).mul(0.0009).mul(fine).mul(look.scale), normalView) as any;
  // Velvet: the scales' edges catch the light at grazing angles; the sky fills the shaded side.
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const N = normalize(normalWorld) as any;
    const rim = pow(float(1).sub(dot(N, V).abs()), 3) as any;
    const back = pow(max(dot(V, sky.toLight.negate()), 0), 1.5) as any;
    return tone
      .mul(ambient(N))
      .mul(0.55)
      .add(tone.add(0.03).mul(sky.light).mul(sky.power).mul(rim).mul(back.mul(0.9).add(0.06)).mul(mark.mul(0.85).oneMinus()));
  })() as any;
  return m;
}

// The tegulae, the small plates over the forewing hinges: scaled like the body, plain.
export function plateMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.85, specularIntensity: 0.15 });
  // (The body's own colour, a little toward its fur's, mottled like its scales.)
  const tone = mix(live.body, live.fur, 0.3).mul(hash2(floor(positionGeometry.y.mul(14)), floor(atan(positionGeometry.x, positionGeometry.z).mul(5))).mul(0.4).add(0.8)) as any;
  m.colorNode = tone;
  m.positionNode = positionLocal.mul(live.hidden.oneMinus()) as any;
  m.emissiveNode = Fn(() => {
    const N = normalize(normalWorld) as any;
    return tone.mul(ambient(N)).mul(0.55);
  })() as any;
  return m;
}

// The compound eyes: thousands of facets under a glossy dome, with the dark false pupil that follows the camera. The
// geometry is a unit sphere whose +x is the side of the head the eye looks out from.
export function eyeMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3, specularIntensity: 0.6 });
  const n = normalize(positionGeometry) as any;
  // Stereographic, so the hexagons keep their shape all the way round to where the head hides them.
  const uv = vec2(n.y, n.z).div(n.x.add(1.12)).mul(44) as any;
  const r = vec2(1, 1.7320508) as any;
  const h = r.mul(0.5) as any;
  const ga = mod(uv, r).sub(h) as any;
  const gb = mod(uv.sub(h), r).sub(h) as any;
  const g = select(dot(ga, ga).lessThan(dot(gb, gb)), ga, gb) as any;
  const toEdge = float(0.5).sub(max(abs(g.x), abs(g.x).mul(0.5).add(abs(g.y).mul(0.8660254)))) as any;
  const seen = clamp(float(1).sub(fwidth(uv.x).add(fwidth(uv.y)).mul(0.9)), 0, 1) as any;
  // Each facet a little lens: domed, with a groove between.
  const dome = smoothstep(0, 0.16, toEdge).mul(float(1).sub(dot(g, g).mul(1.2))) as any;
  m.normalNode = relief(dome.mul(0.0011).mul(seen).mul(look.scale), normalView) as any;
  m.colorNode = Fn(() => {
    const facing = normalView.z.max(0) as any;
    // The false pupil: the facets looking straight down the lens show the dark inside; six fainter ones ring it.
    const pupil = smoothstep(0.9, 0.985, facing) as any;
    const round = atan(normalView.y, normalView.x) as any;
    const ring = smoothstep(0.07, 0.02, abs(length(normalView.xy).sub(0.5))).mul(smoothstep(0.55, 0.95, cos(round.mul(6)))) as any;
    const groove = mix(float(1), smoothstep(0, 0.1, toEdge).mul(0.35).add(0.65), seen) as any;
    // (Near black, as in life: the species' own eye colour only as a faint cast.)
    const tone = mix(look.eye.mul(0.5).add(vec3(0.006, 0.005, 0.004)), look.eye.mul(0.22), smoothstep(0.2, 0.9, facing)) as any;
    // A Morpho's eye is banded: dark and tawny stripes across it.
    const striped = smoothstep(-0.35, 0.35, sin(n.y.mul(15).add(n.z.mul(2)))).mul(step(2.5, look.marks)) as any;
    return mix(tone, vec3(0.3, 0.19, 0.08), striped.mul(0.5)).mul(groove).mul(float(1).sub(pupil.mul(0.92)).sub(ring.mul(0.6)));
  })() as any;
  // The garden and the sky in the dome.
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const N = normalize(normalWorld) as any;
    const R = N.mul(dot(V, N).mul(2)).sub(V) as any;
    const fres = pow(float(1).sub(dot(N, V).max(0)), 4).mul(0.22).add(0.035) as any;
    // (And the soft band of sheen a faceted dome carries whatever the distance: light glancing off thousands of lenses.)
    const H = normalize(V.add(normalize(vec3(0.23, 0.31, 0.92)))) as any;
    const band = pow(max(dot(N, H), 0), 6).mul(0.16).add(pow(max(dot(N, normalize(V.add(sky.toLight))), 0), 3).mul(0.1)) as any;
    return skyAt(R)
      .min(vec3(3, 3, 3))
      .mul(fres)
      .mul(mix(float(1), dome.mul(0.6).add(0.55), seen))
      .add(look.eye.mul(ambient(N)).mul(0.16))
      .add(look.eye.add(0.08).mul(sky.horizon).mul(band));
  })() as any;
  return m;
}

// Hair: fine ribbons turned to the eye. Deep and swept back on the thorax, short on the head and the palps, lying flat
// along the abdomen. Sorted so that any first part of them is an even thinning of the whole, for distance.
export function furGeometry(count: number) {
  const geometry = new THREE.InstancedBufferGeometry();
  const segs = 3;
  const pos: number[] = [];
  const index: number[] = [];
  for (let s = 0; s <= segs; s++) pos.push(-1, s / segs, 0, 1, s / segs, 0);
  for (let s = 0; s < segs; s++) {
    const a = s * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const root = new Float32Array(count * 4);
  const dir = new Float32Array(count * 4);
  const nrm = new Float32Array(count * 4);
  const p = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const n = new THREE.Vector3();
  const d = new THREE.Vector3();
  const palp = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // The order is the thinning: instance i has rank i / count.
    const rank = i / count;
    const k = random();
    let len: number;
    let lift: number;
    if (k < 0.1) {
      // The palps: a short dense brush round each.
      const side = random() < 0.5 ? 1 : -1;
      const t = random();
      palpPoint(side, t, palp);
      const a = random() * Math.PI * 2;
      const r = palpRadius(t) * 0.9;
      n.set(Math.cos(a), 0.25, Math.sin(a) - 0.2).normalize();
      p.copy(palp).addScaledVector(n, r);
      d.set(n.x * 0.5, 0.75, n.z * 0.5 - 0.15).normalize();
      len = 0.005 + random() * 0.006;
      root.set([p.x, p.y, p.z, len], i * 4);
      dir.set([d.x, d.y, d.z, 0], i * 4);
      nrm.set([n.x, n.y, n.z, rank], i * 4);
      continue;
    }
    let y: number;
    if (k < 0.62) {
      y = -0.1 + random() * 0.215;
      len = 0.03 + random() * 0.03;
      lift = 0.55;
    } else if (k < 0.76) {
      y = 0.125 + random() * 0.082;
      len = 0.012 + random() * 0.014;
      lift = 0.8;
    } else if (k < 0.88) {
      y = JOINT - random() * 0.1;
      len = 0.014 + random() * 0.012;
      lift = 0.14;
    } else {
      y = JOINT - 0.1 - random() * (ABDOMEN - 0.11);
      len = 0.008 + random() * 0.008;
      lift = 0.12;
    }
    let phi = random() * Math.PI * 2;
    // Not on the eyes: the crown and the face instead.
    if (y > 0.125 && Math.abs(Math.sin(phi)) > 0.72 && Math.abs(y - 0.172) < 0.04) phi = (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 1.2;
    skin(y, phi, p);
    skin(y + 0.002, phi, pa);
    skin(y, phi + 0.02, pb);
    n.crossVectors(pb.sub(p), pa.sub(p)).normalize();
    if (n.x * p.x + n.z * p.z < 0) n.negate();
    // Swept back along the body, never standing out in a ruff where the thorax rounds off.
    n.y *= 0.2;
    n.normalize();
    if (y > 0.08 && y < 0.125) {
      len *= 0.55;
      lift = 0.18;
    }
    // Longer on the back of the thorax, shorter beneath.
    if (y > -0.1 && y < 0.115) len *= 0.75 + 0.45 * Math.max(0, Math.cos(phi));
    // Round the wing hinges and down the flank the wings sweep through, the coat is short and lies flat: a wing never
    // has hair to pass through.
    const fromBack = Math.acos(Math.max(-1, Math.min(1, Math.cos(phi))));
    if (y > -0.11 && y < 0.09 && fromBack > 0.45 && fromBack < 2.0) {
      const near = 1 - Math.min(1, Math.abs(fromBack - 0.95) / 1.05);
      len *= 1 - 0.72 * near;
      lift *= 1 - 0.85 * near;
    }
    d.set(n.x * lift + (random() - 0.5) * 0.35, -1 + lift * 0.4 + (random() - 0.5) * 0.3, n.z * lift + (random() - 0.5) * 0.35).normalize();
    // On the head it stands forward and up instead.
    if (y > 0.125) d.set(n.x * 0.8 + (random() - 0.5) * 0.4, 0.35 + random() * 0.3, n.z * 0.8 + (random() - 0.5) * 0.4).normalize();
    root.set([p.x - n.x * 0.002, p.y, p.z - n.z * 0.002, len], i * 4);
    dir.set([d.x, d.y, d.z, abOf(y)], i * 4);
    nrm.set([n.x, n.y, n.z, rank], i * 4);
  }
  geometry.setAttribute("aRoot", new THREE.InstancedBufferAttribute(root, 4));
  geometry.setAttribute("aDir", new THREE.InstancedBufferAttribute(dir, 4));
  geometry.setAttribute("aNrm", new THREE.InstancedBufferAttribute(nrm, 4));
  geometry.instanceCount = count;
  return geometry;
}

export function furMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const root = attribute("aRoot", "vec4") as any;
  const d = attribute("aDir", "vec4") as any;
  const nr = attribute("aNrm", "vec4") as any;
  const s = positionGeometry.y as any;
  const rank = nr.w as any;
  const lenK = mix(float(1), look.shag, step(d.w, 0.0001)) as any;
  // Each hair droops a little toward the tail and curls its own way.
  const curl = vec3(sin(rank.mul(913)), -0.5, cos(rank.mul(571))).mul(0.3) as any;
  const along = d.xyz.add(curl.mul(s.mul(s))) as any;
  // (Over a pale spot the coat is shorter and closer, so the spot keeps its shape, though some hair still lies across
  // its edge.)
  const reach = along.mul(root.w).mul(lenK).mul(look.sleek.mul(0.78).oneMinus()).mul(marking(root.xyz).mul(0.45).oneMinus()).mul(s) as any;
  const free = root.xyz.add(reach) as any;
  // The hair on the back stays between the wing hinges at every wing angle: none leans out over a wing, open or shut.
  const hinge = max(abs(root.x), float(0.05)) as any;
  const held = clamp(free.x, hinge.negate(), hinge) as any;
  const between = smoothstep(0.015, 0.035, root.z).mul(step(d.w, 0.0001)).mul(smoothstep(0.125, 0.11, root.y)) as any;
  const centre = vec3(mix(free.x, held, between), free.y, free.z) as any;
  const placed = place(centre, d.w) as any;
  // No thinner than a pixel: farther off, fewer and broader hairs stand for the many.
  const viewZ = modelViewMatrix.mul(vec4(placed, 1)).z as any;
  const pixel = pixelAt(viewZ).div(look.scale) as any;
  const fine = float(0.00042) as any;
  const half = max(fine, pixel.mul(0.55)) as any;
  const keep = clamp(fine.div(half).mul(1.7), 0.12, 1) as any;
  const shown = step(rank, keep).mul(live.hidden.oneMinus()) as any;
  const sideways = normalize(cross(along, look.view).add(vec3(0.0001, 0, 0))) as any;
  const width = half.mul(float(1).sub(pow(s, 1.6).mul(0.85))) as any;
  m.positionNode = placed.add(sideways.mul(positionGeometry.x).mul(width)).mul(shown) as any;
  const tangent = varying(normalize(modelWorldMatrix.mul(vec4(along, 0)).xyz)) as any;
  const skinNormal = varying(normalize(modelWorldMatrix.mul(vec4(nr.xyz, 0)).xyz)) as any;
  const markAt = varying(marking(root.xyz)) as any;
  const tint = varying(fract(rank.mul(77.7)).mul(0.5).add(0.75)) as any;
  const along01 = varying(s) as any;
  m.colorNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const T = normalize(tangent) as any;
    const N = normalize(skinNormal) as any;
    const L = sky.toLight as any;
    // Hair lit as hair (Kajiya and Kay): bright where it lies across the light, a soft streak of sheen along it.
    const tl = dot(T, L) as any;
    const across = sqrt(max(float(1).sub(tl.mul(tl)), 0)) as any;
    const H = normalize(L.add(V)) as any;
    const th = dot(T, H) as any;
    const sheen = pow(sqrt(max(float(1).sub(th.mul(th)), 0)), 48) as any;
    // The coat shades itself: the side of the body away from the light is dark, and roots darker than tips.
    const facing = smoothstep(-0.35, 0.6, dot(N, L)) as any;
    // (The hair over a pale spot is pale from root to tip, and not shaded down at its root: so a spot is a spot.)
    const depth = mix(along01.mul(0.75).add(0.25), float(1), markAt.mul(0.8)) as any;
    // (A pale mark is in the scales and the roots of the hair over it: the tips are the coat's own colour, so a dot
    // stays a dot. Wet from the chrysalis the coat is darker.)
    const base = mix(mix(live.body, live.fur, along01.mul(0.7).add(0.3)).mul(look.ink).mul(mix(float(1), float(0.55), look.sleek)), look.mark, markAt).mul(mix(tint, float(1), markAt)) as any;
    const sun = sky.light.mul(sky.power) as any;
    const lit = base.mul(sun).mul(mix(across.mul(facing).mul(0.34), facing.mul(0.3), markAt)) as any;
    const gloss = sun.mul(sheen).mul(facing).mul(0.05).mul(base.add(0.25)) as any;
    // From behind, light comes through the tips and they glow.
    const back = pow(max(dot(V, L.negate()), 0), 3) as any;
    const halo = base.add(0.015).mul(sun).mul(back).mul(pow(along01, 1.5)).mul(0.55) as any;
    const fill = base.mul(ambient(N).add(sky.horizon.mul(0.12))).mul(0.85) as any;
    // Damp, it lies in a sheet and shines as one.
    const damp = sun.mul(pow(max(dot(N, H), 0), 22)).mul(facing).mul(look.sleek).mul(0.1).add(sky.horizon.mul(pow(float(1).sub(max(dot(N, V), 0)), 3)).mul(look.sleek).mul(0.07)).mul(base.add(0.12)).mul(3) as any;
    return lit.add(gloss).add(fill).mul(depth).add(halo.mul(look.sleek.mul(0.7).oneMinus())).add(damp);
  })() as any;
  return m;
}

// The palps: scaly, upturned either side of the face, sheathing the coiled tongue.
const PALP = [
  [0, 0, 0],
  [0, 0.01, -0.018],
  [0.002, 0.03, -0.028],
  [0.003, 0.05, -0.03],
  [0.003, 0.068, -0.026],
  [0.002, 0.082, -0.018],
  [0.001, 0.09, -0.01],
  [0, 0.094, -0.004]
];
// (Slim, curved, held close to the face: not a muff.)
const PALP_R = [0.0048, 0.0063, 0.0069, 0.0069, 0.0063, 0.0054, 0.0036, 0.0015];
export function palpPoint(side: number, t: number, out: THREE.Vector3) {
  const x = Math.min(0.9999, Math.max(0, t)) * 7;
  const i = Math.floor(x);
  const f = x - i;
  const a = PALP[i];
  const b = PALP[i + 1];
  return out.set(side * (0.013 + a[0] + (b[0] - a[0]) * f), 0.152 + a[1] + (b[1] - a[1]) * f, -0.04 + a[2] + (b[2] - a[2]) * f);
}
export function palpRadius(t: number) {
  const x = Math.min(0.9999, Math.max(0, t)) * 7;
  const i = Math.floor(x);
  return PALP_R[i] + (PALP_R[i + 1] - PALP_R[i]) * (x - i);
}

// Tubes whose middles are moved by the CPU each frame: legs with their claws, antennae, the two halves of the
// proboscis, the palps. One mesh, rewritten in place.
export class Tubes {
  geometry = new THREE.BufferGeometry();
  private position: Float32Array;
  private normal: Float32Array;
  private colour: Float32Array;
  private starts: number[] = [];
  private rings: number[] = [];
  private sides: number;
  private frame = { t: new THREE.Vector3(), n: new THREE.Vector3(), b: new THREE.Vector3(), q: new THREE.Vector3(), a: new THREE.Vector3(), c: new THREE.Vector3() };
  constructor(spec: number[], sides = 8) {
    this.sides = sides;
    let total = 0;
    for (const r of spec) {
      this.starts.push(total);
      this.rings.push(r);
      total += r * (sides + 1);
    }
    this.position = new Float32Array(total * 3);
    this.normal = new Float32Array(total * 3);
    this.colour = new Float32Array(total * 3).fill(0.1);
    // Where each vertex is on its tube (along, around) and which tube: the surface detail holds to the limb.
    const at = new Float32Array(total * 3);
    const index: number[] = [];
    spec.forEach((r, k) => {
      const base = this.starts[k];
      for (let i = 0; i < r; i++) for (let j = 0; j <= sides; j++) at.set([i / (r - 1), j / sides, k], (base + i * (sides + 1) + j) * 3);
      for (let i = 0; i < r - 1; i++)
        for (let j = 0; j < sides; j++) {
          const a = base + i * (sides + 1) + j;
          const b = a + sides + 1;
          // (Counter-clockwise seen from outside, as the normals written below face.)
          index.push(a, a + 1, b, a + 1, b + 1, b);
        }
    });
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(this.normal, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colour, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aAt", new THREE.BufferAttribute(at, 3));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  }
  // A tube along the first `count` points with radii and colours, parallel-transported so it never twists; thickened
  // through a bend so a joint keeps its girth.
  write(k: number, points: THREE.Vector3[], radii: number[], colours: THREE.Color[], count = this.rings[k]) {
    const { t, n, b, q, a, c } = this.frame;
    const rings = this.rings[k];
    const sides = this.sides;
    let v = this.starts[k];
    const last = Math.min(count, rings) - 1;
    n.set(0, 0, 0);
    for (let i = 0; i < rings; i++) {
      const at = Math.min(i, last);
      const p = points[at];
      const prev = points[Math.max(0, at - 1)];
      const next = points[Math.min(last, at + 1)];
      t.subVectors(next, prev);
      if (t.lengthSq() < 1e-14) t.set(0, 1, 0);
      t.normalize();
      let r = radii[at];
      if (at > 0 && at < last) {
        a.subVectors(p, prev);
        c.subVectors(next, p);
        const la = a.length();
        const lc = c.length();
        if (la > 1e-7 && lc > 1e-7) r /= Math.max(0.62, Math.sqrt(Math.max(0, 0.5 + (0.5 * a.dot(c)) / (la * lc))));
      }
      if (i === 0 || n.lengthSq() < 0.5) {
        n.set(0, 0, 1);
        if (Math.abs(t.z) > 0.9) n.set(1, 0, 0);
      }
      n.addScaledVector(t, -n.dot(t)).normalize();
      b.crossVectors(t, n);
      const col = colours[at];
      for (let j = 0; j <= sides; j++) {
        const ang = (j / sides) * Math.PI * 2;
        q.copy(n).multiplyScalar(Math.cos(ang)).addScaledVector(b, Math.sin(ang));
        this.position[v * 3] = p.x + q.x * r;
        this.position[v * 3 + 1] = p.y + q.y * r;
        this.position[v * 3 + 2] = p.z + q.z * r;
        this.normal[v * 3] = q.x;
        this.normal[v * 3 + 1] = q.y;
        this.normal[v * 3 + 2] = q.z;
        this.colour[v * 3] = col.r;
        this.colour[v * 3 + 1] = col.g;
        this.colour[v * 3 + 2] = col.b;
        v++;
      }
    }
  }
  // (Colours only change with the species: they are sent again only when asked.)
  commit(colours = true) {
    for (const name of colours ? ["position", "normal", "color"] : ["position", "normal"]) (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }
}

export function tubeMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.9, specularIntensity: 0 });
  // (No specular at all when dry: with the sun behind it turns dark legs to pale straw.)
  m.specularIntensityNode = (live.wet as any).mul(0.3);
  // (Chitin with scales on it: dull when dry, glossy while still damp from the chrysalis.)
  m.roughnessNode = mix(float(0.92), float(0.35), live.wet) as any;
  const at = attribute("aAt", "vec3") as any;
  // Scaled like the body: fine rings of scales along each limb, each its own shade.
  const rows = floor(at.x.mul(90)) as any;
  const shade = hash2(rows.add(at.z.mul(13)), floor(at.y.mul(8).add(mod(rows, 2).mul(0.5)))) as any;
  const fine = clamp(float(1).sub(fwidth(at.x.mul(90)).mul(1.5)), 0, 1) as any;
  const tone = (attribute("color", "vec3") as any).mul(look.ink) as any;
  // On the dotted species the legs are flecked white too.
  const fx = at.x.mul(95) as any;
  const fy = at.y.mul(5) as any;
  const fleck = smoothstep(0.42, 0.2, length(vec2(fract(fx).sub(0.5), fract(fy).sub(0.5))))
    .mul(step(0.93, hash2(floor(fx).add(at.z.mul(7.3)), floor(fy))))
    .mul(step(at.z, 5.5))
    .mul(step(0.5, look.marks))
    .mul(smoothstep(0.1, 0.16, at.x))
    .mul(smoothstep(0.58, 0.5, at.x)) as any;
  m.colorNode = mix(tone, look.mark, fleck.mul(0.7)).mul(mix(float(1), shade.mul(0.55).add(0.7), fine)) as any;
  m.positionNode = positionLocal.mul(live.hidden.oneMinus()) as any;
  // Overlapping scales in rings down each limb, and the fine pile on them: relief up close, a soft bloom at the rim.
  const lap = fract(at.x.mul(90)) as any;
  m.normalNode = relief(lap.mul(lap).mul(0.0007).mul(fine).mul(look.scale), normalView) as any;
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const N = normalize(normalWorld) as any;
    const rim = pow(float(1).sub(dot(N, V).abs()), 3) as any;
    const back = pow(max(dot(V, sky.toLight.negate()), 0), 1.5) as any;
    const pile = pow(float(1).sub(dot(N, V).abs()), 1.5).mul(shade.mul(0.6).add(0.5)).mul(0.25) as any;
    const round = pow(max(dot(N, V), 0), 3).mul(0.5).add(0.35) as any;
    return tone.mul(ambient(N)).mul(pile.add(0.6)).mul(round.mul(1.6)).add(sky.horizon.mul(pow(max(dot(N, normalize(V.add(normalize(vec3(0.23, 0.31, 0.92))))), 0), 12)).mul(live.wet.mul(0.12).add(0.03))).add(tone.add(0.02).mul(sky.light).mul(sky.power).mul(rim).mul(back.mul(0.35).add(0.03)));
  })() as any;
  return m;
}
