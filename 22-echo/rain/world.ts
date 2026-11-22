import * as THREE from "three/webgpu";
import { mulberry32 } from "../../shared/engine/random";

// The little walled garden behind a house at night, seen from under the back porch: a flagstone path to a gate in a
// brick wall, a raised bed of shrubs, a bench, a table and chairs, pots by the step, a tree, a fence of boards, and the
// roofs of the next street beyond. Built here from boxes, turned profiles and lumpy blobs, merged into one mesh. Every
// vertex carries where it sits on its face, so the shader can find the edges, and what it is made of.

// What a surface is made of, for the texture a passing echo reveals on it.
export const KIND = { stone: 0, leaf: 1, ground: 2, brick: 3, wood: 4, far: 5, glass: 6 } as const;

// Where the rain falls: the garden inside its walls, short of the porch roof.
export const RAIN = { x0: -6.15, x1: 5.55, z0: -9.0, z1: 3.15 };
// The lip of the porch roof: its gutter drips here.
export const GUTTER = { y: 2.32, z: 3.12 };

// The heightmap, for where rain lands and where a press meets the garden.
export const MAP = { x0: -7.5, z0: -10.5, step: 0.05, nx: 300, nz: 370 };

// A face's own coordinates in metres: (u, v) across it and its size (U, V). A face with no edge along one way gets a size
// far bigger than it is, with the point in the middle of it.
const NONE = 1000;

class Builder {
  position: number[] = [];
  normal: number[] = [];
  face: number[] = [];
  kind: number[] = [];
  index: number[] = [];
  // Up-facing triangles of each piece, for the heightmaps: the top of everything, and the top of what a press can land on.
  tops: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; overhang: boolean }[] = [];
  // Triangles whose winding disagreed with their normals, and normals pointing into their own piece: both should be none.
  flipped = 0;
  inward = 0;
  // Points on the lumpy masses where leaves grow: position and outward normal.
  leaves: number[] = [];
  leafDensity = 300;
  random = mulberry32(22_08);

  vertex(p: THREE.Vector3, n: THREE.Vector3, f: [number, number, number, number], kind: number) {
    this.position.push(p.x, p.y, p.z);
    this.normal.push(n.x, n.y, n.z);
    this.face.push(...f);
    this.kind.push(kind);
    return this.position.length / 3 - 1;
  }

  // A triangle, wound so that it faces the way its normals do.
  triangle(a: number, b: number, c: number, overhang: boolean) {
    const p = (i: number) => new THREE.Vector3(this.position[i * 3], this.position[i * 3 + 1], this.position[i * 3 + 2]);
    const pa = p(a);
    const pb = p(b);
    const pc = p(c);
    const geometric = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
    const n = new THREE.Vector3(this.normal[a * 3] + this.normal[b * 3] + this.normal[c * 3], this.normal[a * 3 + 1] + this.normal[b * 3 + 1] + this.normal[c * 3 + 1], this.normal[a * 3 + 2] + this.normal[b * 3 + 2] + this.normal[c * 3 + 2]);
    if (geometric.dot(n) < 0) {
      this.flipped++;
      this.index.push(a, c, b);
    } else this.index.push(a, b, c);
    if (geometric.lengthSq() > 1e-14 && Math.abs(geometric.y) / geometric.length() > 0.05 && n.y > 0) this.tops.push({ a: pa, b: pb, c: pc, overhang });
  }

  // Counts a normal that points into the piece it belongs to, measured from the piece's middle (boxes and lumps; a turned
  // shape is checked by its profile instead, as it may be hollow).
  check(p: THREE.Vector3, n: THREE.Vector3, centre: THREE.Vector3) {
    if (n.dot(new THREE.Vector3().subVectors(p, centre)) < -1e-6) this.inward++;
  }

  // A box, sized and placed, turned about y and tipped a little about x and z.
  box(centre: [number, number, number], size: [number, number, number], kind: number, options: { turn?: number; tipX?: number; tipZ?: number; overhang?: boolean } = {}) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...centre), new THREE.Quaternion().setFromEuler(new THREE.Euler(options.tipX ?? 0, options.turn ?? 0, options.tipZ ?? 0, "YXZ")), new THREE.Vector3(1, 1, 1));
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const half = [size[0] / 2, size[1] / 2, size[2] / 2];
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    const axisSize = (v: THREE.Vector3) => Math.abs(v.x) * size[0] + Math.abs(v.y) * size[1] + Math.abs(v.z) * size[2];
    // Each face: its normal, and two axes across it with a × b = n.
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [X, Y, Z],
      [X.clone().negate(), Z, Y],
      [Y, Z, X],
      [Y.clone().negate(), X, Z],
      [Z, X, Y],
      [Z.clone().negate(), Y, X]
    ];
    const c = new THREE.Vector3(...centre);
    for (const [n, a, b] of faces) {
      const na = axisSize(a);
      const nb = axisSize(b);
      const out = n.clone().applyMatrix3(nm).normalize();
      const ids: number[] = [];
      for (const [sa, sb] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1]
      ]) {
        const local = new THREE.Vector3()
          .addScaledVector(n, Math.abs(n.x) * half[0] + Math.abs(n.y) * half[1] + Math.abs(n.z) * half[2])
          .addScaledVector(a, (sa * na) / 2)
          .addScaledVector(b, (sb * nb) / 2);
        const p = local.applyMatrix4(m);
        this.check(p, out, c);
        ids.push(this.vertex(p, out, [((sa + 1) / 2) * na, ((sb + 1) / 2) * nb, na, nb], kind));
      }
      this.triangle(ids[0], ids[1], ids[2], !!options.overhang);
      this.triangle(ids[0], ids[2], ids[3], !!options.overhang);
    }
  }

  // A shape turned about an axis from a profile of (radius, height) points, starting and ending on the axis or not.
  // Corners split the profile into runs: each run's two ends are edges, its smooth middle is not.
  lathe(profile: { r: number; y: number; corner?: boolean }[], at: THREE.Vector3, kind: number, options: { segments?: number; axis?: THREE.Vector3; overhang?: boolean } = {}) {
    const segments = options.segments ?? 40;
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), (options.axis ?? new THREE.Vector3(0, 1, 0)).clone().normalize());
    // Split into runs at the corners.
    const runs: { r: number; y: number }[][] = [];
    let run: { r: number; y: number }[] = [profile[0]];
    for (let i = 1; i < profile.length; i++) {
      run.push(profile[i]);
      if (profile[i].corner && i < profile.length - 1) {
        runs.push(run);
        run = [profile[i]];
      }
    }
    runs.push(run);
    // The profile's normals, (dy, -dr) along it, face out of the solid when it runs anticlockwise in the (r, y) plane,
    // closed along the axis: out along the bottom, up the side, in across the top. Its signed area says which way it runs.
    let area = 0;
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      const q = profile[(i + 1) % profile.length];
      area += p.r * q.y - q.r * p.y;
    }
    if (area <= 0) this.inward++;
    for (const points of runs) {
      // Distance along the run, and the normal at each point from its neighbours.
      const along = [0];
      for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i].r - points[i - 1].r, points[i].y - points[i - 1].y));
      const total = along[along.length - 1];
      const fromAxis = points[0].r < 1e-6 ? NONE : 0;
      const toAxis = points[points.length - 1].r < 1e-6 ? NONE : 0;
      const rows: number[][] = [];
      for (let i = 0; i < points.length; i++) {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        const dr = next.r - prev.r;
        const dy = next.y - prev.y;
        const len = Math.hypot(dr, dy) || 1;
        const row: number[] = [];
        for (let s = 0; s <= segments; s++) {
          const angle = (s / segments) * Math.PI * 2;
          const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
          const p = radial
            .clone()
            .multiplyScalar(points[i].r)
            .add(new THREE.Vector3(0, points[i].y, 0))
            .applyQuaternion(turn)
            .add(at);
          const n = radial
            .clone()
            .multiplyScalar(dy / len)
            .add(new THREE.Vector3(0, -dr / len, 0))
            .applyQuaternion(turn)
            .normalize();
          row.push(this.vertex(p, n, [NONE / 2, along[i] + fromAxis, NONE, total + fromAxis + toAxis], kind));
        }
        rows.push(row);
      }
      for (let i = 0; i < points.length - 1; i++) {
        for (let s = 0; s < segments; s++) {
          const a = rows[i][s];
          const b = rows[i][s + 1];
          const c = rows[i + 1][s + 1];
          const d = rows[i + 1][s];
          // A ring that has shrunk to the axis has no area on that side.
          // Wound so that they face out: the angle runs from x toward z, clockwise seen from above.
          if (points[i].r > 1e-6) this.triangle(a, c, b, !!options.overhang);
          if (points[i + 1].r > 1e-6) this.triangle(a, d, c, !!options.overhang);
        }
      }
    }
  }

  // A round bar from one point to another, tapering, with flat ends.
  bar(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, kind: number, segments = 16, overhang = false) {
    const axis = new THREE.Vector3().subVectors(to, from);
    const length = axis.length();
    this.lathe(
      [
        { r: 0, y: 0 },
        { r: r0, y: 0, corner: true },
        { r: r1, y: length, corner: true },
        { r: 0, y: length }
      ],
      from,
      kind,
      { segments, axis, overhang }
    );
  }

  // A lumpy rounded mass (a shrub, a crown of leaves), its normals worked out from the moved surface.
  blob(centre: THREE.Vector3, radius: [number, number, number], seed: number, detail: number, kind: number, overhang = false) {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    ico.deleteAttribute("normal");
    ico.deleteAttribute("uv");
    const merged = mergeByPosition(ico);
    const pos = merged.getAttribute("position") as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).normalize();
      // Big lobes, then clumps of leaves, then a little crinkle.
      const lump = 1 + 0.22 * fbm(p.x * 1.3 + seed, p.y * 1.3, p.z * 1.3, 2) + 0.09 * fbm(p.x * 4 + seed * 2, p.y * 4, p.z * 4, 2) + 0.025 * noise3(p.x * 13 + seed, p.y * 13, p.z * 13);
      // Flatter underneath, as a shrub sits.
      const under = p.y < 0 ? 1 + p.y * 0.25 : 1;
      pos.setXYZ(i, centre.x + p.x * radius[0] * lump, centre.y + p.y * radius[1] * lump * under, centre.z + p.z * radius[2] * lump);
    }
    merged.computeVertexNormals();
    const nor = merged.getAttribute("normal") as THREE.BufferAttribute;
    const index = merged.getIndex()!;
    const base: number[] = [];
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nor, i);
      this.check(p, n, centre);
      base.push(this.vertex(p, n, [NONE / 2, NONE / 2, NONE, NONE], kind));
    }
    for (let i = 0; i < index.count; i += 3) this.triangle(base[index.getX(i)], base[index.getX(i + 1)], base[index.getX(i + 2)], overhang);
    // Leaves over it, by area: each triangle gets its share, the remainder by chance.
    const a = new THREE.Vector3();
    const bb = new THREE.Vector3();
    const c = new THREE.Vector3();
    const na = new THREE.Vector3();
    const nb = new THREE.Vector3();
    const nc = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
      const [ia, ib, ic] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      a.fromBufferAttribute(pos, ia);
      bb.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      const area = new THREE.Vector3().subVectors(bb, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
      let count = area * this.leafDensity;
      while (count > 0) {
        if (count < 1 && this.random() > count) break;
        count -= 1;
        let u = this.random();
        let v = this.random();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        na.fromBufferAttribute(nor, ia);
        nb.fromBufferAttribute(nor, ib);
        nc.fromBufferAttribute(nor, ic);
        const n = na.multiplyScalar(1 - u - v).addScaledVector(nb, u).addScaledVector(nc, v).normalize();
        const p = a.clone().multiplyScalar(1 - u - v).addScaledVector(bb, u).addScaledVector(c, v);
        // Some a little proud of the mass, some sunk into it.
        p.addScaledVector(n, (this.random() - 0.35) * 0.06);
        this.leaves.push(p.x, p.y, p.z, n.x, n.y, n.z);
      }
    }
    ico.dispose();
    merged.dispose();
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute("face", new THREE.Float32BufferAttribute(this.face, 4));
    g.setAttribute("kind", new THREE.Float32BufferAttribute(this.kind, 1));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    return g;
  }
}

// An icosphere's vertices welded where they meet, so its normals come out smooth.
function mergeByPosition(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const points: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = points.length / 3;
      map.set(key, k);
      points.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    index.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  out.setIndex(index);
  return out;
}

// Value noise, smooth, from -1 to 1.
function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x: number, y: number, z: number, octaves: number) {
  let sum = 0;
  let amp = 1;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f, y * f, z * f);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}

export type Garden = {
  geometry: THREE.BufferGeometry;
  // The top of everything, rain's view, and the top of what a press lands on (no roof, no crowns of leaves).
  top: Float32Array;
  ground: Float32Array;
  // Where the leaves grow: position and outward normal, six numbers a leaf.
  leaves: Float32Array;
  flipped: number;
  inward: number;
  triangles: number;
};

export function buildGarden(quality: "low" | "medium" | "high"): Garden {
  const b = new Builder();
  const random = mulberry32(22_07);
  const r = (lo: number, hi: number) => lo + random() * (hi - lo);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Icosphere subdivisions for the lumpy masses: each face of twenty split into fine² triangles.
  const fine = quality === "low" ? 10 : quality === "medium" ? 14 : 18;
  b.leafDensity = quality === "low" ? 220 : quality === "medium" ? 400 : 600;

  // The ground, out to the roofs beyond.
  b.box([0, -0.25, -11], [40, 0.5, 39], KIND.ground);

  // The porch: boards, a step down, posts and the roof with its gutter.
  for (let z = 3.42; z < 8; z += 0.145) b.box([0, 0.16 + r(-0.004, 0.004), z + 0.0675], [6.4, 0.05, 0.135], KIND.wood);
  b.box([0, 0.065, 3.48], [6.6, 0.13, 0.12], KIND.wood);
  b.box([0, 0.045, 3.2], [2.2, 0.09, 0.42], KIND.stone);
  for (const x of [-3.05, 3.05]) b.box([x, 1.24, 3.48], [0.13, 2.3, 0.13], KIND.wood);
  b.box([0, 2.46, 5.7], [7.2, 0.14, 4.6], KIND.wood, { overhang: true });
  b.box([0, 2.36, 3.44], [7.2, 0.1, 0.1], KIND.wood, { overhang: true });
  b.lathe(
    [
      { r: 0, y: 0 },
      { r: 0.075, y: 0, corner: true },
      { r: 0.075, y: 7.3, corner: true },
      { r: 0, y: 7.3 }
    ],
    V(-3.65, GUTTER.y, GUTTER.z),
    KIND.stone,
    { axis: V(1, 0, 0), segments: 20, overhang: true }
  );

  // The flagstone path, two slabs across in uneven lengths, each a little tipped and sunk.
  for (let z = 2.95; z > -8.9; ) {
    const len = r(0.42, 0.7);
    const split = r(-0.25, 0.25);
    const pieces: [number, number][] = [
      [-0.78, split - 0.012],
      [split + 0.012, 0.78]
    ];
    if (random() < 0.3) pieces.splice(0, 2, [-0.78, 0.78]);
    for (const [x0, x1] of pieces) b.box([(x0 + x1) / 2 + r(-0.02, 0.02), 0.012 + r(-0.01, 0.006), z - len / 2], [x1 - x0 - r(0, 0.03), 0.06, len - 0.028], KIND.stone, { turn: r(-0.025, 0.025), tipX: r(-0.012, 0.012), tipZ: r(-0.012, 0.012) });
    z -= len;
  }

  // The house wall on the left, with a window and a downpipe into a water butt.
  b.box([-6.7, 2.8, -1], [1, 5.6, 18], KIND.brick);
  b.box([-6.15, 1.0, -0.8], [0.14, 0.07, 1.55], KIND.stone);
  for (const z of [-1.5, -0.1]) b.box([-6.17, 1.75, z], [0.08, 1.45, 0.09], KIND.wood);
  b.box([-6.17, 2.5, -0.8], [0.08, 0.09, 1.49], KIND.wood);
  b.box([-6.17, 1.75, -0.8], [0.06, 0.05, 1.32], KIND.wood);
  b.box([-6.2, 1.75, -0.8], [0.02, 1.38, 1.32], KIND.glass);
  b.bar(V(-6.08, 0.98, 1.9), V(-6.08, 5.6, 1.9), 0.045, 0.045, KIND.stone, 14);
  b.lathe(
    [
      { r: 0, y: 0 },
      { r: 0.3, y: 0, corner: true },
      { r: 0.35, y: 0.45 },
      { r: 0.32, y: 0.9, corner: true },
      { r: 0.28, y: 0.9, corner: true },
      { r: 0.28, y: 0.82, corner: true },
      { r: 0, y: 0.82 }
    ],
    V(-5.75, 0, 1.9),
    KIND.wood,
    { segments: 48 }
  );

  // The raised bed on the left: sleepers round a box of soil, shrubs growing out of it.
  const bed = { x0: -5.9, x1: -2.4, z0: -6.2, z1: -1.6 };
  b.box([(bed.x0 + bed.x1) / 2, 0.21, bed.z1 - 0.08], [bed.x1 - bed.x0, 0.42, 0.16], KIND.wood);
  b.box([(bed.x0 + bed.x1) / 2, 0.21, bed.z0 + 0.08], [bed.x1 - bed.x0, 0.42, 0.16], KIND.wood);
  b.box([bed.x1 - 0.08, 0.21, (bed.z0 + bed.z1) / 2], [0.16, 0.42, bed.z1 - bed.z0 - 0.32], KIND.wood);
  b.box([(bed.x0 + bed.x1) / 2 - 0.08, 0.17, (bed.z0 + bed.z1) / 2], [bed.x1 - bed.x0 - 0.16, 0.34, bed.z1 - bed.z0 - 0.32], KIND.ground);
  for (const [x, z, s, h] of [
    [-3.2, -2.4, 0.55, 0.5],
    [-4.4, -2.7, 0.7, 0.7],
    [-3.5, -4.0, 0.75, 0.8],
    [-5.0, -4.7, 0.85, 1.0],
    [-3.6, -5.5, 0.6, 0.6]
  ])
    b.blob(V(x, 0.34 + h * 0.75, z), [s, h, s * r(0.85, 1.1)], r(0, 50), fine, KIND.leaf);

  // A bench beside the path, facing across it.
  {
    const x = -1.75;
    const z = 0.6;
    for (const dz of [-0.66, 0.66]) {
      b.box([x, 0.21, z + dz], [0.42, 0.42, 0.06], KIND.wood);
      b.box([x - 0.2, 0.48, z + dz], [0.06, 0.6, 0.06], KIND.wood, { tipZ: 0.18 });
    }
    for (let i = 0; i < 4; i++) b.box([x + 0.15 - i * 0.105, 0.44 + r(-0.003, 0.003), z], [0.09, 0.035, 1.5], KIND.wood);
    for (let i = 0; i < 3; i++) b.box([x - 0.26 - i * 0.022, 0.6 + i * 0.11, z], [0.03, 0.08, 1.5], KIND.wood, { tipZ: 0.18 });
  }

  // A round table and two chairs on the right.
  {
    const t = V(2.5, 0, -0.6);
    b.lathe(
      [
        { r: 0, y: 0 },
        { r: 0.26, y: 0, corner: true },
        { r: 0.26, y: 0.03, corner: true },
        { r: 0.045, y: 0.06, corner: true },
        { r: 0.04, y: 0.68, corner: true },
        { r: 0.48, y: 0.69, corner: true },
        { r: 0.48, y: 0.73, corner: true },
        { r: 0, y: 0.73 }
      ],
      t,
      KIND.stone,
      { segments: 56 }
    );
    for (const [dx, dz, turn] of [
      [0.75, 0.25, -1.9],
      [-0.4, -0.7, 0.6]
    ]) {
      const c = V(t.x + dx, 0, t.z + dz);
      const fwd = V(Math.sin(turn), 0, Math.cos(turn));
      const side = V(fwd.z, 0, -fwd.x);
      for (const [f, s] of [
        [0.2, 0.2],
        [0.2, -0.2],
        [-0.2, 0.2],
        [-0.2, -0.2]
      ]) {
        const p = c.clone().addScaledVector(fwd, f).addScaledVector(side, s);
        b.box([p.x, 0.22, p.z], [0.04, 0.44, 0.04], KIND.wood, { turn });
      }
      b.box([c.x, 0.46, c.z], [0.46, 0.04, 0.46], KIND.wood, { turn });
      const back = c.clone().addScaledVector(fwd, -0.21);
      for (const s of [-0.2, 0.2]) {
        const p = back.clone().addScaledVector(side, s);
        b.box([p.x, 0.7, p.z], [0.04, 0.5, 0.04], KIND.wood, { turn, tipX: -0.1 });
      }
      for (const y of [0.72, 0.86]) {
        const p = back.clone().addScaledVector(fwd, -(y - 0.46) * 0.1);
        b.box([p.x, y, p.z], [0.44, 0.07, 0.025], KIND.wood, { turn, tipX: -0.1 });
      }
    }
  }

  // Pots by the step, each with a shrub in it.
  for (const [x, z, s] of [
    [-1.45, 2.55, 1],
    [-1.05, 2.95, 0.7],
    [1.4, 2.7, 0.85]
  ]) {
    b.lathe(
      [
        { r: 0, y: 0.002 },
        { r: 0.16 * s, y: 0.002, corner: true },
        { r: 0.2 * s, y: 0.18 * s },
        { r: 0.24 * s, y: 0.36 * s, corner: true },
        { r: 0.27 * s, y: 0.38 * s, corner: true },
        { r: 0.27 * s, y: 0.46 * s, corner: true },
        { r: 0.22 * s, y: 0.46 * s, corner: true },
        { r: 0.22 * s, y: 0.42 * s, corner: true },
        { r: 0, y: 0.42 * s }
      ],
      V(x, 0, z),
      KIND.stone,
      { segments: 48 }
    );
    b.blob(V(x, 0.46 * s + 0.2 * s, z), [0.3 * s, 0.32 * s, 0.3 * s], r(0, 50), fine, KIND.leaf);
  }

  // A tree at the back right: a trunk forking into limbs, under a crown of leafy masses.
  {
    const base = V(3.7, 0, -5.6);
    const fork = V(3.6, 1.7, -5.55);
    b.bar(base.clone().add(V(0, -0.05, 0)), fork, 0.17, 0.13, KIND.wood, 20);
    b.lathe(
      [
        { r: 0, y: -0.02 },
        { r: 0.3, y: -0.02, corner: true },
        { r: 0.17, y: 0.25 },
        { r: 0.16, y: 0.4, corner: true },
        { r: 0, y: 0.4 }
      ],
      base,
      KIND.wood,
      { segments: 20 }
    );
    const limbs: [THREE.Vector3, number][] = [
      [V(2.7, 3.2, -5.2), 0.08],
      [V(4.5, 3.4, -5.0), 0.08],
      [V(3.8, 3.7, -6.5), 0.07],
      [V(3.2, 3.0, -6.4), 0.06]
    ];
    for (const [to, w] of limbs) b.bar(fork, to, 0.11, w, KIND.wood, 16, true);
    for (const [x, y, z, s] of [
      [2.6, 3.6, -5.2, 1.1],
      [4.5, 3.8, -5.1, 1.15],
      [3.8, 4.2, -6.4, 1.2],
      [3.2, 3.4, -6.5, 0.95],
      [3.6, 4.5, -5.6, 0.9]
    ])
      b.blob(V(x, y, z), [s, s * 0.75, s], r(0, 50), fine + 4, KIND.leaf, true);
  }

  // The fence on the right: boards with thin gaps, on two rails and posts.
  for (let z = 3.1; z > -9.0; z -= 0.15) b.box([5.65, 0.92 + r(-0.012, 0.012), z - 0.07], [0.022, 1.84 + r(-0.03, 0.03), 0.132], KIND.wood, { turn: r(-0.01, 0.01) });
  for (const y of [0.35, 1.55]) b.box([5.69, y, -2.95], [0.05, 0.1, 12.1], KIND.wood);
  for (let z = 3.0; z > -9.1; z -= 2.4) b.box([5.73, 0.95, z], [0.09, 1.9, 0.09], KIND.wood);

  // The garden wall at the back: brick, coped with stone, and a gate of boards between two piers.
  b.box([-3.35, 1.1, -9.2], [6.3, 2.2, 0.32], KIND.brick);
  b.box([3.25, 1.1, -9.2], [4.9, 2.2, 0.32], KIND.brick);
  for (let x = -6.4; x < 5.7; x += 0.44) {
    if (x > -0.95 && x < 0.75) continue;
    b.box([x + 0.21, 2.24, -9.2], [0.42, 0.08, 0.4], KIND.stone, { turn: r(-0.01, 0.01) });
  }
  for (const x of [-0.82, 0.82]) {
    b.box([x, 1.25, -9.2], [0.36, 2.5, 0.38], KIND.brick);
    b.box([x, 2.54, -9.2], [0.44, 0.08, 0.46], KIND.stone);
  }
  for (let x = -0.6; x < 0.6; x += 0.12) b.box([x + 0.055, 0.95, -9.18], [0.105, 1.7, 0.03], KIND.wood);
  for (const y of [0.4, 1.5]) b.box([0, y, -9.15], [1.24, 0.1, 0.03], KIND.wood);
  b.box([0, 0.95, -9.15], [0.08, 1.2, 0.03], KIND.wood, { tipX: 0, tipZ: 0.82 });

  // The roofs of the next street, far off: walls, pitched with slabs, and chimneys.
  for (let x = -22; x < 22; ) {
    const w = r(4, 7);
    const h = r(5, 8.5);
    const z = r(-19, -15);
    const d = r(6, 9);
    b.box([x + w / 2, h / 2, z - d / 2], [w - 0.3, h, d], KIND.far);
    // A pitched roof: two slabs leaning together.
    const pitch = r(0.55, 0.75);
    const run = d / 2 / Math.cos(pitch);
    for (const s of [-1, 1]) b.box([x + w / 2, h + Math.sin(pitch) * run * 0.5, z - d / 2 + s * d * 0.25], [w - 0.2, 0.12, run], KIND.far, { tipX: s * pitch });
    if (random() < 0.7) b.box([x + w * r(0.2, 0.8), h + r(1.6, 2.4), z - d / 2 + r(-1, 1)], [0.6, r(1.4, 2.2), 0.5], KIND.far);
    // Windows on the side facing the garden: frames and sills standing a little proud of the wall.
    const across = Math.max(1, Math.floor((w - 1) / 1.6));
    for (let row = 0; row < Math.floor(h / 2.8); row++) {
      for (let col = 0; col < across; col++) {
        if (random() < 0.2) continue;
        const wx = x + 0.15 + ((col + 0.5) * (w - 0.3)) / across;
        const wy = 1.4 + row * 2.8;
        b.box([wx, wy, z + 0.03], [0.85, 1.25, 0.06], KIND.far);
        b.box([wx, wy - 0.68, z + 0.07], [1.0, 0.08, 0.14], KIND.far);
      }
    }
    x += w + r(0.2, 2.5);
  }

  // The heightmaps, rasterised from every face that looks up.
  const top = new Float32Array(MAP.nx * MAP.nz).fill(-1);
  const ground = new Float32Array(MAP.nx * MAP.nz).fill(-1);
  for (const { a, b: bb, c, overhang } of b.tops) {
    const minX = Math.max(0, Math.floor((Math.min(a.x, bb.x, c.x) - MAP.x0) / MAP.step));
    const maxX = Math.min(MAP.nx - 1, Math.ceil((Math.max(a.x, bb.x, c.x) - MAP.x0) / MAP.step));
    const minZ = Math.max(0, Math.floor((Math.min(a.z, bb.z, c.z) - MAP.z0) / MAP.step));
    const maxZ = Math.min(MAP.nz - 1, Math.ceil((Math.max(a.z, bb.z, c.z) - MAP.z0) / MAP.step));
    const det = (bb.z - c.z) * (a.x - c.x) + (c.x - bb.x) * (a.z - c.z);
    if (Math.abs(det) < 1e-12) continue;
    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const px = MAP.x0 + (ix + 0.5) * MAP.step;
        const pz = MAP.z0 + (iz + 0.5) * MAP.step;
        const l1 = ((bb.z - c.z) * (px - c.x) + (c.x - bb.x) * (pz - c.z)) / det;
        const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
        const y = l1 * a.y + l2 * bb.y + l3 * c.y;
        const k = iz * MAP.nx + ix;
        if (y > top[k]) top[k] = y;
        if (!overhang && y > ground[k]) ground[k] = y;
      }
    }
  }

  const geometry = b.geometry();
  return { geometry, top, ground, leaves: new Float32Array(b.leaves), flipped: b.flipped, inward: b.inward, triangles: b.index.length / 3 };
}

// The height of a map at a point, or -1 off it.
export function heightAt(map: Float32Array, x: number, z: number) {
  const ix = Math.floor((x - MAP.x0) / MAP.step);
  const iz = Math.floor((z - MAP.z0) / MAP.step);
  if (ix < 0 || iz < 0 || ix >= MAP.nx || iz >= MAP.nz) return -1;
  return map[iz * MAP.nx + ix];
}
