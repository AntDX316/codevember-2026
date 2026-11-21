import * as THREE from "three/webgpu";

// The ladder's shape, in metres. Two copper rods rise from brass posts on porcelain insulators, close in to a few
// millimetres at the throat, where the arc strikes, then open out in a V to their tips.
export const ROD_RADIUS = 0.0045;
export const POST_X = 0.082;
export const BOX_TOP = 0.15;
export const POST_TOP = 0.292;
export const THROAT_Y = 0.385;
// Half the distance between the rods' centre lines at the throat: a gap of about 7 mm between their surfaces.
export const THROAT_HALF = 0.0078;
export const TIP_Y = 1.13;
// How far each tip stands out from the throat, from the Spread setting (0 to 1).
export const spreadOf = (setting: number) => 0.045 + setting * 0.25;
export const settingOf = (spread: number) => THREE.MathUtils.clamp((spread - 0.045) / 0.25, 0, 1);

const RISE = TIP_Y - THROAT_Y;

// The throat and tip of one rod (side -1 left, +1 right), and the unit direction up its straight run.
export function rodLine(side: number, spread: number, throat: THREE.Vector3, tip: THREE.Vector3, dir: THREE.Vector3) {
  throat.set(side * THROAT_HALF, THROAT_Y, 0);
  tip.set(side * (THROAT_HALF + spread), TIP_Y, 0);
  dir.subVectors(tip, throat);
  const length = dir.length();
  dir.divideScalar(length);
  return length;
}

// A point up the straight run, u from 0 (throat) to 1 (tip), on the rod's inner face where the arc's foot sits.
const t0 = new THREE.Vector3();
const t1 = new THREE.Vector3();
const d0 = new THREE.Vector3();
export function rootAt(side: number, spread: number, u: number, out: THREE.Vector3) {
  rodLine(side, spread, t0, t1, d0);
  out.lerpVectors(t0, t1, u);
  // Inward, square to the rod in the ladder's plane.
  out.x -= side * ROD_RADIUS * 0.85 * (RISE / Math.hypot(RISE, spread));
  return out;
}

// How far up its run (0 to 1) the point of the rod nearest p lies, unclamped.
export function alongRod(side: number, spread: number, p: THREE.Vector3) {
  const length = rodLine(side, spread, t0, t1, d0);
  return (d0.x * (p.x - t0.x) + d0.y * (p.y - t0.y) + d0.z * (p.z - t0.z)) / length;
}

// The centre line of one whole rod, as `count` points evenly spaced along it: up out of the post, curving in to the
// throat, then straight up and out to the tip.
const curvePoints = Array.from({ length: 7 }, () => new THREE.Vector3());
const curve = new THREE.CatmullRomCurve3(curvePoints, false, "centripetal");
export function rodCentre(side: number, spread: number, count: number, out: THREE.Vector3[]) {
  rodLine(side, spread, t0, t1, d0);
  const [a, b, c, d, e, f, g] = curvePoints;
  a.set(side * POST_X, POST_TOP - 0.02, 0);
  b.set(side * POST_X, POST_TOP + 0.012, 0);
  c.set(side * (POST_X * 0.52), POST_TOP + 0.048, 0);
  // Into the throat from below along a line that runs on into the V, so the bend is one smooth knee.
  d.copy(t0).addScaledVector(d0, -0.03).setX(side * (THROAT_HALF + 0.0045));
  e.copy(t0);
  f.copy(t0).addScaledVector(d0, 0.12);
  g.copy(t1);
  curve.updateArcLengths();
  for (let i = 0; i < count; i++) curve.getPointAt(i / (count - 1), out[i]);
  return out;
}

// The rod as a tube that can be bent in place: the same buffers rewritten whenever the spread changes, never rebuilt.
// `aRod` carries, per vertex, the height above the throat and which side it is on, for the heat tint.
export const ROD_RINGS = 140;
export const ROD_SIDES = 16;
const CAP = 5;

export function createRodGeometry() {
  const rings = ROD_RINGS + CAP;
  const count = rings * (ROD_SIDES + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aRod", new THREE.BufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const index: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < ROD_SIDES; s++) {
      const a = r * (ROD_SIDES + 1) + s;
      const b = a + ROD_SIDES + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 1.2);
  return geometry;
}

const centres = Array.from({ length: ROD_RINGS }, () => new THREE.Vector3());
const tangent = new THREE.Vector3();
const normal = new THREE.Vector3();
const binormal = new THREE.Vector3();
const radial = new THREE.Vector3();
const scratch = new THREE.Vector3();
const capCentre = new THREE.Vector3();

export function writeRod(geometry: THREE.BufferGeometry, side: number, spread: number) {
  rodCentre(side, spread, ROD_RINGS, centres);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const rod = geometry.getAttribute("aRod") as THREE.BufferAttribute;
  // Frames carried along the curve so the tube never twists: the rod lies in the ladder's plane, so z is a steady binormal.
  binormal.set(0, 0, 1);
  let v = 0;
  const ring = (centre: THREE.Vector3, radius: number, bulge: number, height: number) => {
    for (let s = 0; s <= ROD_SIDES; s++) {
      const angle = (s / ROD_SIDES) * Math.PI * 2;
      radial
        .copy(normal)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(binormal, Math.sin(angle));
      position.setXYZ(v, centre.x + radial.x * radius, centre.y + radial.y * radius, centre.z + radial.z * radius);
      scratch.copy(radial).multiplyScalar(1 - bulge).addScaledVector(tangent, bulge).normalize();
      normals.setXYZ(v, scratch.x, scratch.y, scratch.z);
      rod.setXY(v, height, side);
      v++;
    }
  };
  for (let i = 0; i < ROD_RINGS; i++) {
    const a = centres[Math.max(0, i - 1)];
    const b = centres[Math.min(ROD_RINGS - 1, i + 1)];
    tangent.subVectors(b, a).normalize();
    normal.crossVectors(binormal, tangent).normalize();
    ring(centres[i], ROD_RADIUS, 0, centres[i].y - THROAT_Y);
  }
  // A rounded end at the tip.
  const end = centres[ROD_RINGS - 1];
  for (let k = 1; k <= CAP; k++) {
    const a = (k / CAP) * (Math.PI / 2);
    capCentre.copy(end).addScaledVector(tangent, Math.sin(a) * ROD_RADIUS);
    ring(capCentre, Math.max(1e-5, Math.cos(a) * ROD_RADIUS), Math.sin(a), capCentre.y - THROAT_Y);
  }
  position.needsUpdate = true;
  normals.needsUpdate = true;
  rod.needsUpdate = true;
}
