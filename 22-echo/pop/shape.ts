import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";

// The bubble's shape: the letters A and I drawn as strokes, each stroke a fat round rod a little plumper in its middle,
// squashed slightly front to back, all melted together with a smooth minimum so the joins swell like a balloon's. The
// distance to it is meshed once at load by surface nets, every vertex then slid onto the true surface and given the
// field's gradient as its normal.

// Stroke ends in the letters' plane, and the rod's radius.
const R = 0.205;
const FLAT = 0.82;
const SEGMENTS: [number, number, number, number][] = [
  // A: two legs to a rounded apex, and the bar.
  [-1.45, -0.9, -0.65, 0.9],
  [0.15, -0.9, -0.65, 0.9],
  [-1.08, -0.36, -0.22, -0.36],
  // I: the stem, and a serif top and bottom so it never reads as an l.
  [0.82, -0.9, 0.82, 0.9],
  [0.5, 0.9, 1.14, 0.9],
  [0.5, -0.9, 1.14, -0.9]
];
// The letters' middle, so the shape sits on the origin.
const SHIFT = -(-1.45 - R + 1.14 + R) / 2;
const SMOOTH = 0.085;

export const BOUNDS = { x: 1.6 + R + 0.1, y: 0.9 + R + 0.12, z: R * FLAT * 1.25 + 0.08 };

const segs = SEGMENTS.map(([ax, ay, bx, by]) => ({ ax: ax + SHIFT, ay, bx: bx + SHIFT, by, dx: bx - ax, dy: by - ay, len2: (bx - ax) ** 2 + (by - ay) ** 2 }));

export function field(x: number, y: number, z: number) {
  const zz = z / FLAT;
  let d = 1e9;
  for (const s of segs) {
    const t = Math.min(1, Math.max(0, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.len2));
    const px = x - s.ax - s.dx * t;
    const py = y - s.ay - s.dy * t;
    const e = Math.sqrt(px * px + py * py + zz * zz) * FLAT - R * (1 + 0.32 * t * (1 - t));
    // Polynomial smooth minimum.
    const h = Math.max(SMOOTH - Math.abs(d - e), 0) / SMOOTH;
    d = Math.min(d, e) - h * h * SMOOTH * 0.25;
  }
  return d;
}

const gradient = (x: number, y: number, z: number, out: THREE.Vector3) => {
  const e = 0.0015;
  return out.set(field(x + e, y, z) - field(x - e, y, z), field(x, y + e, z) - field(x, y - e, z), field(x, y, z + e) - field(x, y, z - e)).divideScalar(2 * e);
};

// Where a ray in the shape's own space first meets it, or null.
export function march(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3) {
  let t = 0;
  for (let i = 0; i < 120; i++) {
    out.copy(origin).addScaledVector(dir, t);
    const d = field(out.x, out.y, out.z);
    if (d < 0.002) return t;
    t += Math.max(d * 0.9, 0.004);
    if (t > 60) break;
  }
  return null;
}

export function buildShape(step: number) {
  const nx = Math.ceil((BOUNDS.x * 2) / step) + 1;
  const ny = Math.ceil((BOUNDS.y * 2) / step) + 1;
  const nz = Math.ceil((BOUNDS.z * 2) / step) + 1;
  const ox = -BOUNDS.x;
  const oy = -BOUNDS.y;
  const oz = -BOUNDS.z;
  const values = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[at(i, j, k)] = field(ox + i * step, oy + j * step, oz + k * step);

  // One vertex per cell the surface passes through, at the mean of where it crosses the cell's edges.
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const points: number[] = [];
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1]
  ];
  const edges: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (Math.abs(corner[a][0] - corner[b][0]) + Math.abs(corner[a][1] - corner[b][1]) + Math.abs(corner[a][2] - corner[b][2]) === 1) edges.push([a, b]);
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = values[at(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          n++;
        }
        cellVertex[at(i, j, k)] = points.length / 3;
        points.push(ox + (i + sx / n) * step, oy + (j + sy / n) * step, oz + (k + sz / n) * step);
      }

  // A quad round every grid edge the surface crosses, joining the four cells that share it, turned to face outward
  // (from the inside end of the edge to the outside end).
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const here = values[at(i, j, k)] < 0;
        if (here !== values[at(i + 1, j, k)] < 0) quad(cellVertex[at(i, j - 1, k - 1)], cellVertex[at(i, j, k - 1)], cellVertex[at(i, j, k)], cellVertex[at(i, j - 1, k)], !here);
        if (here !== values[at(i, j + 1, k)] < 0) quad(cellVertex[at(i - 1, j, k - 1)], cellVertex[at(i - 1, j, k)], cellVertex[at(i, j, k)], cellVertex[at(i, j, k - 1)], !here);
        if (here !== values[at(i, j, k + 1)] < 0) quad(cellVertex[at(i - 1, j - 1, k)], cellVertex[at(i, j - 1, k)], cellVertex[at(i, j, k)], cellVertex[at(i - 1, j, k)], !here);
      }

  // Onto the surface, and the field's gradient as the normal.
  const count = points.length / 3;
  const position = new Float32Array(points);
  const normal = new Float32Array(count * 3);
  const g = new THREE.Vector3();
  for (let p = 0; p < count; p++) {
    let x = position[p * 3];
    let y = position[p * 3 + 1];
    let z = position[p * 3 + 2];
    for (let it = 0; it < 3; it++) {
      const d = field(x, y, z);
      gradient(x, y, z, g);
      const l2 = Math.max(g.lengthSq(), 1e-6);
      x -= (d * g.x) / l2;
      y -= (d * g.y) / l2;
      z -= (d * g.z) / l2;
    }
    gradient(x, y, z, g).normalize();
    position.set([x, y, z], p * 3);
    normal.set([g.x, g.y, g.z], p * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.6);
  return geometry;
}

// How many triangles face the way their vertices' normals say: should be all of them.
export function checkOutward(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute("position");
  const n = geometry.getAttribute("normal");
  const idx = geometry.getIndex()!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const m = new THREE.Vector3();
  let good = 0;
  const tris = idx.count / 3;
  for (let t = 0; t < tris; t++) {
    const i0 = idx.getX(t * 3);
    const i1 = idx.getX(t * 3 + 1);
    const i2 = idx.getX(t * 3 + 2);
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1).sub(a);
    c.fromBufferAttribute(p, i2).sub(a);
    b.cross(c);
    m.fromBufferAttribute(n, i0).add(c.fromBufferAttribute(n, i1)).add(c.fromBufferAttribute(n, i2));
    if (b.dot(m) > 0) good++;
  }
  return { good, tris };
}

// Points spread evenly over the surface by area, with their normals and four random numbers each.
export function scatter(geometry: THREE.BufferGeometry, count: number, seed: number) {
  const p = geometry.getAttribute("position");
  const n = geometry.getAttribute("normal");
  const idx = geometry.getIndex()!;
  const tris = idx.count / 3;
  const area = new Float32Array(tris);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(p, idx.getX(t * 3));
    b.fromBufferAttribute(p, idx.getX(t * 3 + 1)).sub(a);
    c.fromBufferAttribute(p, idx.getX(t * 3 + 2)).sub(a);
    total += b.cross(c).length() * 0.5;
    area[t] = total;
  }
  const random = lehmer(seed);
  const at = new Float32Array(count * 3);
  const dir = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const q = new THREE.Vector3();
  for (let s = 0; s < count; s++) {
    const pick = random() * total;
    let lo = 0;
    let hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (area[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    let u = random();
    let w = random();
    if (u + w > 1) {
      u = 1 - u;
      w = 1 - w;
    }
    const i0 = idx.getX(lo * 3);
    const i1 = idx.getX(lo * 3 + 1);
    const i2 = idx.getX(lo * 3 + 2);
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1);
    c.fromBufferAttribute(p, i2);
    q.copy(a).multiplyScalar(1 - u - w).addScaledVector(b, u).addScaledVector(c, w);
    at.set([q.x, q.y, q.z], s * 3);
    a.fromBufferAttribute(n, i0);
    b.fromBufferAttribute(n, i1);
    c.fromBufferAttribute(n, i2);
    q.copy(a).multiplyScalar(1 - u - w).addScaledVector(b, u).addScaledVector(c, w).normalize();
    dir.set([q.x, q.y, q.z], s * 3);
    seeds.set([random(), random(), random(), random()], s * 4);
  }
  return { at, dir, seeds };
}
