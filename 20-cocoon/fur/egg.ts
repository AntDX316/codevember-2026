import * as THREE from "three/webgpu";
import { mulberry32 } from "../../shared/engine/random";

// The cocoon under the fur: an egg, broader below than above, with ends a little blunter than an ellipse, leaning a
// touch off upright. Everything is described by (u, v): u goes once round the waist, v from the top (0) to the bottom
// (1). The fur's brushing is kept in a picture over the same (u, v), so the two always agree.

const RADIUS = 0.6;
const HALF_HEIGHT = 0.86;
const TAPER = 0.13;
const TILT = 0.2;
const COS_TILT = Math.cos(TILT);
const SIN_TILT = Math.sin(TILT);

export function eggPoint(u: number, v: number, out: THREE.Vector3) {
  const t = Math.min(Math.max(v, 0), 1) * Math.PI;
  const p = u * Math.PI * 2;
  const s = Math.sin(t);
  const c = Math.cos(t);
  // A little blunter than an ellipse at the ends, as a cocoon is.
  const r = RADIUS * Math.pow(Math.max(s, 0), 0.82) * (1 - TAPER * c);
  const x = r * Math.cos(p);
  const z = r * Math.sin(p);
  const y = HALF_HEIGHT * c;
  return out.set(x * COS_TILT - y * SIN_TILT, x * SIN_TILT + y * COS_TILT, z);
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const across = new THREE.Vector3();
const down = new THREE.Vector3();

// The surface's outward normal, the way along the waist and the way down toward the bottom, at (u, v). Near the
// poles the waist has no length, so the normal there is simply away from the middle.
export function eggFrame(u: number, v: number, normal: THREE.Vector3, along?: THREE.Vector3, downward?: THREE.Vector3) {
  const e = 0.0015;
  const vv = Math.min(Math.max(v, e * 2), 1 - e * 2);
  eggPoint(u + e, vv, a);
  eggPoint(u - e, vv, b);
  across.subVectors(a, b);
  eggPoint(u, vv + e, a);
  eggPoint(u, vv - e, b);
  down.subVectors(a, b);
  normal.crossVectors(down, across);
  eggPoint(u, v, a);
  if (normal.lengthSq() < 1e-14) normal.copy(a);
  if (normal.dot(a) < 0) normal.negate();
  normal.normalize();
  if (along) along.copy(across).normalize();
  if (downward) downward.copy(down).normalize();
  return normal;
}

// How much surface a small step in u and v covers, for spreading strands evenly.
function areaAt(u: number, v: number) {
  const e = 0.001;
  eggPoint(u + e, v, a);
  eggPoint(u - e, v, b);
  across.subVectors(a, b);
  eggPoint(u, Math.min(1, v + e), a);
  eggPoint(u, Math.max(0, v - e), b);
  down.subVectors(a, b);
  return across.cross(down).length();
}

// Strand roots spread over the egg by area: candidates walk the R2 sequence, which never bunches, and are kept in
// proportion to the surface they stand for. Each strand carries its root, its normal, where it is in (u, v) and four
// numbers of its own.
export function sowStrands(count: number) {
  let most = 0;
  for (let j = 0; j <= 64; j++) for (let i = 0; i < 16; i++) most = Math.max(most, areaAt(i / 16, j / 64));
  const rand = mulberry32(2026);
  const root = new Float32Array(count * 4);
  const facing = new Float32Array(count * 4);
  const place = new Float32Array(count * 4);
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let made = 0;
  for (let n = 1; made < count && n < count * 20; n++) {
    const u = (0.5 + n * 0.7548776662) % 1;
    const v = (0.5 + n * 0.569840291) % 1;
    if (rand() * most > areaAt(u, v)) continue;
    eggPoint(u, v, point);
    eggFrame(u, v, normal);
    // Rooted a hair's breadth inside the skin, so no strand floats off it.
    root.set([point.x - normal.x * 0.003, point.y - normal.y * 0.003, point.z - normal.z * 0.003, rand()], made * 4);
    facing.set([normal.x, normal.y, normal.z, rand()], made * 4);
    place.set([u, v, rand(), rand()], made * 4);
    made++;
  }
  return { root, facing, place, made };
}

// The skin itself, which shows between the strands as the dense undercoat. It carries (u, v) for the brushing.
export function eggGeometry(around: number, rows: number, lift = 0) {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const point = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= around; i++) {
      const u = i / around;
      const v = j / rows;
      eggPoint(u, v, point);
      eggFrame(u, v, n);
      point.addScaledVector(n, lift);
      position.push(point.x, point.y, point.z);
      normal.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < around; i++) {
      const p = j * (around + 1) + i;
      const q = p + around + 1;
      index.push(p, p + 1, q, p + 1, q + 1, q);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

// Moves the touch shell, the invisible egg the pointer is tested against, out to where the fur's tips now reach.
export function liftShell(geometry: THREE.BufferGeometry, around: number, rows: number, lift: number) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const point = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= around; i++) {
      eggPoint(i / around, j / rows, point);
      eggFrame(i / around, j / rows, n);
      point.addScaledVector(n, lift);
      position.setXYZ(j * (around + 1) + i, point.x, point.y, point.z);
    }
  }
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}
