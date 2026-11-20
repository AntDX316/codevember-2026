import * as THREE from "three/webgpu";
import { ConvexHull, type Face } from "three/addons/math/ConvexHull.js";
import { lehmer } from "../../shared/engine/random";

// The lantern's shape and its cells, all worked out on the CPU once per cell count: a Voronoi pattern on a sphere,
// pressed into an egg, then built into paper panels, a frame of veins, light shafts and a map of which way out of the
// lantern passes through which cell.

// The egg: a unit sphere stretched to 2.1 tall and narrowed toward the top.
export const WIDTH = 0.78;
export const HALF_HEIGHT = 1.05;
const TAPER = 0.13;
// The ember hangs a little below the middle, where a candle would sit, so the lower cells burn brightest.
export const EMBER = new THREE.Vector3(0, -0.22, 0);

export function toEgg(s: THREE.Vector3, out = new THREE.Vector3()) {
  const g = WIDTH * (1 - TAPER * s.y);
  return out.set(s.x * g, s.y * HALF_HEIGHT, s.z * g);
}

// Back from the egg to the sphere; its length is 1 exactly on the surface, less inside.
export function fromEgg(p: THREE.Vector3, out = new THREE.Vector3()) {
  const y = p.y / HALF_HEIGHT;
  const g = WIDTH * (1 - TAPER * y);
  return out.set(p.x / g, y, p.z / g);
}

const scratch = new THREE.Vector3();
const inside = (p: THREE.Vector3) => fromEgg(p, scratch).lengthSq() - 1;

// The outward normal at a point on the egg, by the slope of the inside test.
export function eggNormal(p: THREE.Vector3, out = new THREE.Vector3()) {
  const e = 1e-3;
  const q = new THREE.Vector3();
  const dx = inside(q.set(p.x + e, p.y, p.z)) - inside(q.set(p.x - e, p.y, p.z));
  const dy = inside(q.set(p.x, p.y + e, p.z)) - inside(q.set(p.x, p.y - e, p.z));
  const dz = inside(q.set(p.x, p.y, p.z + e)) - inside(q.set(p.x, p.y, p.z - e));
  return out.set(dx, dy, dz).normalize();
}

// Where a ray first meets the egg's skin, or -1. Marched, then halved down to the crossing.
export function hitEgg(origin: THREE.Vector3, dir: THREE.Vector3, near = 0, far = 30) {
  const p = new THREE.Vector3();
  // Only the stretch of the ray inside a sphere round the whole egg is worth marching.
  const b = origin.dot(dir);
  const c = origin.lengthSq() - 1.3 * 1.3;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t0 = Math.max(near, -b - Math.sqrt(disc));
  const t1 = Math.min(far, -b + Math.sqrt(disc));
  if (t1 <= t0) return -1;
  const steps = 48;
  let prev = t0;
  let prevF = inside(p.copy(dir).multiplyScalar(t0).add(origin));
  for (let i = 1; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const f = inside(p.copy(dir).multiplyScalar(t).add(origin));
    if (Math.sign(f) !== Math.sign(prevF)) {
      let a = prev;
      let z = t;
      for (let k = 0; k < 14; k++) {
        const m = (a + z) / 2;
        const fm = inside(p.copy(dir).multiplyScalar(m).add(origin));
        if (Math.sign(fm) === Math.sign(prevF)) a = m;
        else z = m;
      }
      return (a + z) / 2;
    }
    prev = t;
    prevF = f;
  }
  return -1;
}

export type Cell = {
  seed: THREE.Vector3; // on the unit sphere
  centre: THREE.Vector3; // on the egg
  // The hinge: a point on it and its direction, turned so that a positive angle swings the panel outward.
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  // How far this one swings open, in radians.
  reach: number;
  // Its run of vertices in the paper geometry.
  start: number;
  count: number;
  height: number; // seed.y, for cascades
};

export type Layout = {
  cells: Cell[];
  paper: THREE.BufferGeometry;
  // The paper's resting positions and normals, which the hinges turn each frame.
  restPositions: Float32Array;
  restNormals: Float32Array;
  veins: THREE.BufferGeometry;
  knots: THREE.Vector3[];
  knotRadius: number;
  shafts: THREE.BufferGeometry;
  // Which cell each direction out from the ember leaves through (red) and how clear of the veins it is (green).
  map: { data: Uint8Array; width: number; height: number };
  pick: (ray: THREE.Ray) => { cell: number; distance: number; point: THREE.Vector3 } | null;
};

// Seeds spread evenly but not regularly: a jittered golden spiral, relaxed a few times toward the middles of their cells.
function makeSeeds(count: number, random: () => number) {
  const seeds: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    seeds.push(
      new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
        .add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(1.6 / Math.sqrt(count)))
        .normalize()
    );
  }
  for (let pass = 0; pass < 4; pass++) {
    const { rings, corners } = voronoi(seeds);
    rings.forEach((ring, i) => {
      const mid = new THREE.Vector3();
      for (const f of ring) mid.add(corners[f]);
      seeds[i].lerp(mid.normalize(), 0.7).normalize();
    });
  }
  return seeds;
}

// The spherical Voronoi diagram, from the convex hull of the seeds: each hull face is a corner where three cells meet,
// and each seed's ring of faces, in turn round it, is its cell's outline.
function voronoi(seeds: THREE.Vector3[]) {
  const index = new Map<THREE.Vector3, number>();
  seeds.forEach((s, i) => index.set(s, i));
  const hull = new ConvexHull().setFromPoints(seeds);
  const corners: THREE.Vector3[] = [];
  const around: number[][] = seeds.map(() => []);
  hull.faces.forEach((face: Face, f: number) => {
    corners.push(face.normal.clone().normalize());
    let edge = face.edge;
    do {
      const i = index.get(edge.head().point);
      if (i !== undefined) around[i].push(f);
      edge = edge.next;
    } while (edge !== face.edge);
  });
  const rings = around.map((faces, i) => {
    const n = seeds[i];
    const t1 = new THREE.Vector3().crossVectors(Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), n).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1);
    // Counterclockwise seen from outside.
    return faces
      .map((f) => ({ f, a: Math.atan2(corners[f].dot(t2), corners[f].dot(t1)) }))
      .sort((p, q) => p.a - q.a)
      .map((x) => x.f);
  });
  return { rings, corners };
}

const slerpish = (a: THREE.Vector3, b: THREE.Vector3, t: number, out = new THREE.Vector3()) => out.copy(a).lerp(b, t).normalize();

export function buildLayout(count: number, mapWidth: number, radial: number): Layout {
  const random = lehmer(2011 + count);
  const seeds = makeSeeds(count, random);
  const { rings, corners } = voronoi(seeds);

  // ---- Paper: each cell its own panel, a fan of rings from its middle out to its outline.
  const SPLIT = 3;
  const RINGS = 4;
  const positions: number[] = [];
  const uvs: number[] = [];
  const cellIds: number[] = [];
  const ringIds: number[] = [];
  const indices: number[] = [];
  const cells: Cell[] = [];
  const cellSize = Math.sqrt((4 * Math.PI) / count) * 0.9;
  const tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  rings.forEach((ring, i) => {
    const outline: THREE.Vector3[] = [];
    ring.forEach((f, k) => {
      const a = corners[f];
      const b = corners[ring[(k + 1) % ring.length]];
      for (let j = 0; j < SPLIT; j++) outline.push(slerpish(a, b, j / SPLIT));
    });
    const mid = new THREE.Vector3();
    ring.forEach((f) => mid.add(corners[f]));
    mid.normalize();
    const centre = toEgg(mid);
    const normal = eggNormal(centre);
    const t1 = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < 0.95 ? up : new THREE.Vector3(1, 0, 0)).normalize();
    const t2 = new THREE.Vector3().crossVectors(normal, t1);
    const turn = random() * Math.PI * 2;
    const offset = [random() * 10, random() * 10];
    const start = positions.length / 3;

    const push = (s: THREE.Vector3, ring01: number) => {
      const p = toEgg(s);
      // Paper drawn slightly in between its ribs, as stretched paper settles.
      p.addScaledVector(eggNormal(p, tmp), -0.05 * cellSize * (1 - ring01 * ring01));
      positions.push(p.x, p.y, p.z);
      const dx = p.clone().sub(centre);
      const u = dx.dot(t1);
      const v = dx.dot(t2);
      uvs.push((Math.cos(turn) * u - Math.sin(turn) * v) * 1.3 + offset[0], (Math.sin(turn) * u + Math.cos(turn) * v) * 1.3 + offset[1]);
      cellIds.push(i);
      ringIds.push(ring01);
    };
    push(mid, 0);
    for (let r = 1; r <= RINGS; r++) for (const o of outline) push(slerpish(mid, o, r / RINGS), r / RINGS);
    const M = outline.length;
    for (let m = 0; m < M; m++) indices.push(start, start + 1 + m, start + 1 + ((m + 1) % M));
    for (let r = 1; r < RINGS; r++) {
      const a = start + 1 + (r - 1) * M;
      const b = start + 1 + r * M;
      for (let m = 0; m < M; m++) {
        const n = (m + 1) % M;
        indices.push(a + m, b + m, b + n, a + m, b + n, a + n);
      }
    }

    // The hinge is the lowest edge, so a panel falls open outward like a petal.
    let low = 0;
    let lowest = Infinity;
    ring.forEach((f, k) => {
      const y = corners[f].y + corners[ring[(k + 1) % ring.length]].y;
      if (y < lowest) {
        lowest = y;
        low = k;
      }
    });
    const h0 = toEgg(corners[ring[low]]);
    const h1 = toEgg(corners[ring[(low + 1) % ring.length]]);
    const axis = h1.clone().sub(h0).normalize();
    // Make a positive turn carry the middle outward.
    const moved = centre.clone().sub(h0).applyAxisAngle(axis, 0.1).add(h0);
    if (moved.sub(centre).dot(normal) < 0) axis.negate();

    cells.push({ seed: seeds[i], centre, pivot: h0, axis, reach: 1.85 + random() * 0.45, start, count: 1 + M * RINGS, height: seeds[i].y });
  });

  const paper = new THREE.BufferGeometry();
  paper.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  paper.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  paper.setAttribute("aCell", new THREE.Float32BufferAttribute(cellIds, 1));
  paper.setAttribute("aRing", new THREE.Float32BufferAttribute(ringIds, 1));
  paper.setIndex(indices);
  paper.computeVertexNormals();
  // The outlines wind counterclockwise from outside, so the normals should point out; make sure.
  const n0 = new THREE.Vector3().fromBufferAttribute(paper.getAttribute("normal") as THREE.BufferAttribute, 0);
  const p0 = new THREE.Vector3().fromBufferAttribute(paper.getAttribute("position") as THREE.BufferAttribute, 0);
  if (n0.dot(p0) < 0) {
    for (let k = 0; k < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
    paper.setIndex(indices);
    paper.computeVertexNormals();
  }
  (paper.getAttribute("position") as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (paper.getAttribute("normal") as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  const restPositions = new Float32Array(paper.getAttribute("position").array as Float32Array);
  const restNormals = new Float32Array(paper.getAttribute("normal").array as Float32Array);

  // ---- Veins: a tube along every edge, bowed a little and swelling into the joints, sitting proud of the paper.
  const veinRadius = 0.012 * Math.sqrt(90 / count) + 0.004;
  const edges = new Set<string>();
  const vPos: number[] = [];
  const vNorm: number[] = [];
  const vIdx: number[] = [];
  const SEG = 8;
  const RAD = radial;
  rings.forEach((ring) =>
    ring.forEach((f, k) => {
      const g = ring[(k + 1) % ring.length];
      const key = f < g ? `${f}-${g}` : `${g}-${f}`;
      if (edges.has(key)) return;
      edges.add(key);
      const a = corners[f];
      const b = corners[g];
      const bow = new THREE.Vector3().crossVectors(a, b).normalize();
      const bend = (random() - 0.5) * 0.18 * a.distanceTo(b);
      const wobble = (random() - 0.5) * 0.06 * a.distanceTo(b);
      const centres: THREE.Vector3[] = [];
      const normals: THREE.Vector3[] = [];
      const radii: number[] = [];
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const q = slerpish(a, b, t).addScaledVector(bow, Math.sin(Math.PI * t) * bend + Math.sin(Math.PI * 2 * t) * wobble).normalize();
        const p = toEgg(q);
        const n = eggNormal(p);
        const r = veinRadius * (1 + 0.7 * Math.pow(1 - Math.sin(Math.PI * t), 2)) * (0.85 + 0.3 * random());
        p.addScaledVector(n, r * 0.35);
        centres.push(p);
        normals.push(n);
        radii.push(r);
      }
      const base = vPos.length / 3;
      for (let s = 0; s <= SEG; s++) {
        const p = centres[s];
        const along = centres[Math.min(SEG, s + 1)].clone().sub(centres[Math.max(0, s - 1)]).normalize();
        const n = normals[s].clone().addScaledVector(along, -normals[s].dot(along)).normalize();
        const side = new THREE.Vector3().crossVectors(along, n);
        for (let k = 0; k < RAD; k++) {
          const ang = (k / RAD) * Math.PI * 2;
          // Flattened against the paper, as a glued rib is.
          const dir = n.clone().multiplyScalar(Math.cos(ang) * 0.75).addScaledVector(side, Math.sin(ang));
          vPos.push(p.x + dir.x * radii[s], p.y + dir.y * radii[s], p.z + dir.z * radii[s]);
          dir.normalize();
          vNorm.push(dir.x, dir.y, dir.z);
        }
      }
      for (let s = 0; s < SEG; s++)
        for (let k = 0; k < RAD; k++) {
          const a0 = base + s * RAD + k;
          const a1 = base + s * RAD + ((k + 1) % RAD);
          const b0 = a0 + RAD;
          const b1 = a1 + RAD;
          vIdx.push(a0, a1, b1, a0, b1, b0);
        }
    })
  );
  const veins = new THREE.BufferGeometry();
  veins.setAttribute("position", new THREE.Float32BufferAttribute(vPos, 3));
  veins.setAttribute("normal", new THREE.Float32BufferAttribute(vNorm, 3));
  veins.setIndex(vIdx);
  // The winding of the tube walls is not checked, so the material draws both sides.

  const knots = corners.map((c) => {
    const p = toEgg(c);
    return p.addScaledVector(eggNormal(p), veinRadius * 0.4);
  });

  // ---- Shafts: each cell's outline carried straight out from the ember, the light that leaves through it once open.
  const sPos: number[] = [];
  const sCell: number[] = [];
  const sIdx: number[] = [];
  rings.forEach((ring, i) => {
    const outline: THREE.Vector3[] = [];
    ring.forEach((f, k) => {
      const a = corners[f];
      const b = corners[ring[(k + 1) % ring.length]];
      for (let j = 0; j < 2; j++) outline.push(toEgg(slerpish(a, b, j / 2)));
    });
    const base = sPos.length / 3;
    const M = outline.length;
    for (const p of outline) {
      const far = p.clone().sub(EMBER).multiplyScalar(4.2).add(EMBER);
      sPos.push(p.x, p.y, p.z, far.x, far.y, far.z);
      sCell.push(i, i);
    }
    for (let m = 0; m < M; m++) {
      const n = (m + 1) % M;
      sIdx.push(base + m * 2, base + m * 2 + 1, base + n * 2 + 1, base + m * 2, base + n * 2 + 1, base + n * 2);
    }
  });
  const shafts = new THREE.BufferGeometry();
  shafts.setAttribute("position", new THREE.Float32BufferAttribute(sPos, 3));
  shafts.setAttribute("aCell", new THREE.Float32BufferAttribute(sCell, 1));
  shafts.setIndex(sIdx);
  shafts.computeVertexNormals();

  // ---- The light map: every direction out of the ember, which cell it leaves by, and whether a vein is in the way.
  const width = mapWidth;
  const height = mapWidth / 2;
  const exits = exitDirections(width, height);
  const data = new Uint8Array(width * height * 4);
  const veinHalf = (veinRadius * 1.25) / 0.9;
  for (let t = 0; t < width * height; t++) {
    const x = exits[t * 3];
    const y = exits[t * 3 + 1];
    const z = exits[t * 3 + 2];
    let best = -2;
    let second = -2;
    let bi = 0;
    let si = 0;
    for (let i = 0; i < count; i++) {
      const s = seeds[i];
      const d = s.x * x + s.y * y + s.z * z;
      if (d > best) {
        second = best;
        si = bi;
        best = d;
        bi = i;
      } else if (d > second) {
        second = d;
        si = i;
      }
    }
    const gap = (best - second) / seeds[bi].distanceTo(seeds[si]);
    const clear = THREE.MathUtils.smoothstep(gap, veinHalf * 0.45, veinHalf * 1.15);
    data[t * 4] = bi;
    data[t * 4 + 1] = Math.round(clear * 255);
    data[t * 4 + 2] = 0;
    data[t * 4 + 3] = 255;
  }

  // ---- Picking: where a ray meets the skin, the cell is whichever seed lies nearest.
  const pick = (ray: THREE.Ray) => {
    const t = hitEgg(ray.origin, ray.direction);
    if (t < 0) return null;
    const point = ray.at(t, new THREE.Vector3());
    const s = fromEgg(point).normalize();
    let best = -2;
    let cell = 0;
    for (let i = 0; i < count; i++) {
      const d = seeds[i].dot(s);
      if (d > best) {
        best = d;
        cell = i;
      }
    }
    return { cell, distance: t, point };
  };

  return { cells, paper, restPositions, restNormals, veins, knots, knotRadius: veinRadius * 1.6, shafts, map: { data, width, height }, pick };
}

// For each texel of a map laid out by longitude and latitude round the ember, the point on the unit sphere where that
// direction leaves the egg. The same for every cell count, so kept.
const exitCache = new Map<number, Float32Array>();
function exitDirections(width: number, height: number) {
  const cached = exitCache.get(width);
  if (cached) return cached;
  const out = new Float32Array(width * height * 3);
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height) * Math.PI;
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width) * Math.PI * 2 - Math.PI;
      dir.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      // From inside, the skin is the first point where the inside test turns positive.
      let a = 0;
      let b = 2.5;
      for (let k = 0; k < 22; k++) {
        const m = (a + b) / 2;
        if (inside(p.copy(dir).multiplyScalar(m).add(EMBER)) < 0) a = m;
        else b = m;
      }
      fromEgg(p.copy(dir).multiplyScalar((a + b) / 2).add(EMBER), s).normalize();
      out.set([s.x, s.y, s.z], (j * width + i) * 3);
    }
  }
  exitCache.set(width, out);
  return out;
}
