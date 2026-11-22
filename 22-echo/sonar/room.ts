import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";

// The echo chamber: a seven-sided concrete hall whose walls fold in a zigzag and lean in a little, so no two faces are
// parallel. Skyline diffusers (blocks of random depth) and deep vertical ribs on the walls, square columns, beams across
// the ceiling and tilted reflector panels hung on cables. All one merged mesh, built once at load; the shell's faces turn
// into the room, every block's out of itself.

export const FLOOR = -3.4;
export const CEILING = 6.2;
// How much the walls close in from floor to ceiling.
const LEAN = 0.9;
// The plan's corners, by angle (degrees, 0 toward the start view) and distance from the middle.
const PLAN: [number, number][] = [
  [8, 10.6],
  [58, 9.4],
  [108, 11.2],
  [160, 10.1],
  [205, 11.6],
  [258, 9.8],
  [308, 11]
];

type Wall = { a: THREE.Vector3; b: THREE.Vector3; along: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3; width: number; height: number };

const corner = (deg: number, r: number) => new THREE.Vector3(Math.sin((deg * Math.PI) / 180) * r, FLOOR, Math.cos((deg * Math.PI) / 180) * r);
const lift = (p: THREE.Vector3) => new THREE.Vector3(p.x * LEAN, CEILING, p.z * LEAN);

function shell(walls: Wall[]) {
  const pos: number[] = [];
  const nor: number[] = [];
  // A triangle turned to face the point given, inside the room.
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, toward: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.dot(new THREE.Vector3().subVectors(toward, a)) < 0) {
      n.negate();
      [b, c] = [c, b];
    }
    for (const p of [a, b, c]) {
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
    }
  };
  // The plan's outline, zigzagged: each side split in three with its inner points pushed in and out.
  const random = lehmer(97);
  const outline: THREE.Vector3[] = [];
  PLAN.forEach(([deg, r], i) => {
    const [deg2, r2] = PLAN[(i + 1) % PLAN.length];
    const a = corner(deg, r);
    const b = corner(deg2 + (i === PLAN.length - 1 ? 360 : 0), r2);
    const inward = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
    if (inward.dot(a) > 0) inward.negate();
    outline.push(a);
    for (let k = 1; k < 3; k++) outline.push(a.clone().lerp(b, k / 3).addScaledVector(inward, (k === 1 ? 0.55 : -0.25) + (random() - 0.5) * 0.4));
  });
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const a2 = lift(a);
    const b2 = lift(b);
    const inside = new THREE.Vector3(0, (FLOOR + CEILING) / 2, 0);
    tri(a, a2, b, inside);
    tri(b, a2, b2, inside);
    const along = new THREE.Vector3().subVectors(b, a);
    const width = along.length();
    along.normalize();
    const up = new THREE.Vector3().subVectors(a2, a).normalize();
    const normal = new THREE.Vector3().crossVectors(up, along).normalize();
    if (normal.dot(a) > 0) normal.negate();
    walls.push({ a, b, along, up, normal, width, height: a2.distanceTo(a) });
  }
  const mid = new THREE.Vector3(0, FLOOR, 0);
  const top = new THREE.Vector3(0, CEILING, 0);
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    tri(mid, b, a, top);
    tri(top, lift(a), lift(b), mid);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// A box in a frame of its own: centre, two axes, three sizes. The third axis is always x × y, so the frame is never a
// mirror, which would turn the faces inside out.
function box(centre: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, sx: number, sy: number, sz: number) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.deleteAttribute("uv");
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y).normalize()).setPosition(centre));
  return g;
}

export function buildRoom() {
  const walls: Wall[] = [];
  const parts: THREE.BufferGeometry[] = [shell(walls)];
  const random = lehmer(4242);
  const Y = new THREE.Vector3(0, 1, 0);

  walls.forEach((w, i) => {
    // Diffusers, ribs or bare concrete, wall by wall.
    const kind = i % 3;
    const at = (u: number, v: number, out: number) => w.a.clone().addScaledVector(w.along, u).addScaledVector(w.up, v).addScaledVector(w.normal, out);
    if (kind === 0 && w.width > 2.2) {
      // A skyline diffuser: a field of square blocks, each its own depth.
      const cell = 0.36;
      const cols = Math.floor((w.width - 0.6) / cell);
      const rows = 13;
      const u0 = (w.width - cols * cell) / 2;
      const v0 = 1.1 + random() * 1.2;
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++) {
          const depth = 0.06 + Math.pow(random(), 1.6) * 0.5;
          parts.push(box(at(u0 + (c + 0.5) * cell, v0 + (r + 0.5) * cell, depth / 2), w.along, w.up, cell * 0.94, cell * 0.94, depth));
        }
    } else if (kind === 1) {
      // Deep vertical ribs, floor to ceiling, of uneven depth.
      const count = Math.max(2, Math.floor(w.width / 0.55));
      for (let c = 0; c < count; c++) {
        const depth = 0.25 + random() * 0.65;
        parts.push(box(at(((c + 0.5) / count) * w.width, w.height / 2, depth / 2), w.along, w.up, 0.1, w.height, depth));
      }
    }
    // A plinth along every wall's foot.
    parts.push(box(at(w.width / 2, 0.2, 0.12), w.along, w.up, w.width, 0.4, 0.24));
  });

  // Square columns, turned every which way, toward the back and sides.
  for (const [deg, r, turn] of [
    [118, 7.6, 0.3],
    [162, 7.2, 0.8],
    [205, 7.9, 0.1],
    [250, 7.4, 0.55],
    [70, 7.3, 1.1]
  ]) {
    const c = corner(deg, r);
    const x = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn));
    parts.push(box(new THREE.Vector3(c.x, (FLOOR + CEILING) / 2, c.z), x, Y, 0.8, CEILING - FLOOR, 0.8));
    parts.push(box(new THREE.Vector3(c.x, CEILING - 0.3, c.z), x, Y, 1.15, 0.6, 1.15));
    parts.push(box(new THREE.Vector3(c.x, FLOOR + 0.25, c.z), x, Y, 1.1, 0.5, 1.1));
  }

  // Beams across the ceiling.
  for (const [deg, off] of [
    [20, -4.5],
    [20, 0],
    [20, 4.5],
    [110, -2.5],
    [110, 2.5]
  ]) {
    const a = (deg * Math.PI) / 180;
    const x = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const z = new THREE.Vector3().crossVectors(x, Y);
    parts.push(box(z.clone().multiplyScalar(off).setY(CEILING - 0.45), x, Y, 22, 0.9, 0.45));
  }

  // Reflector panels hung on cables, tilted to throw the sound about.
  for (const [deg, r, h, tilt, spin, w, d] of [
    [150, 4.2, 3.4, 0.5, 0.2, 2.6, 1.5],
    [215, 5.6, 4.1, -0.4, 0.9, 2.2, 1.3],
    [95, 5.2, 3.8, 0.6, -0.5, 2.4, 1.4],
    [270, 4.8, 3.2, -0.55, 0.3, 2, 1.6],
    [30, 5.8, 4.3, 0.35, 1.4, 2.3, 1.2],
    [330, 5.3, 3.7, -0.3, -0.9, 2.1, 1.4],
    [180, 7.4, 2.4, 0.7, 0.1, 1.8, 2.4]
  ]) {
    const c = corner(deg, r).setY(h);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, spin, tilt * 0.4));
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    parts.push(box(c, x, y, w, 0.07, d));
    for (const [sx, sz] of [
      [-0.42, -0.38],
      [0.42, 0.38]
    ]) {
      const foot = c.clone().addScaledVector(x, sx * w).addScaledVector(z, sz * d);
      const len = CEILING - 0.9 - foot.y;
      parts.push(box(foot.clone().setY(foot.y + len / 2), new THREE.Vector3(1, 0, 0), Y, 0.018, len, 0.018));
    }
  }

  const geometry = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 16);
  return geometry;
}

// How many of the shell's triangles face the middle and how many of the blocks' face out of their own centre: a check,
// run once in development.
export function checkRoom(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute("position");
  const n = geometry.getAttribute("normal");
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const m = new THREE.Vector3();
  let agree = 0;
  const tris = p.count / 3;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(p, t * 3);
    b.fromBufferAttribute(p, t * 3 + 1).sub(a);
    c.fromBufferAttribute(p, t * 3 + 2).sub(a);
    b.cross(c);
    m.fromBufferAttribute(n, t * 3);
    if (b.dot(m) > 0) agree++;
  }
  return { agree, tris };
}
