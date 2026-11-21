import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";

// The specimen: a core of fine sand, a cylinder half a metre across and 1.3 m tall, with a wedge a quarter of the way
// round cut out toward the viewer, as a museum cuts a core sample to show what is inside.
export const RADIUS = 0.5;
export const HALF = 0.65;
// The grid's box, a little larger than the core all round.
export const BOX_MIN = new THREE.Vector3(-0.53, -0.68, -0.53);
export const BOX_SIZE = new THREE.Vector3(1.06, 1.36, 1.06);
// The cut faces the viewer, a little to the right of straight on.
export const WEDGE_AT = THREE.MathUtils.degToRad(40);
const dirAt = (a: number) => [Math.sin(a), Math.cos(a)] as const;
// The two cut faces' normals, pointing into the empty wedge.
export const CUT_A = dirAt(WEDGE_AT - Math.PI / 4);
export const CUT_B = dirAt(WEDGE_AT + Math.PI / 4);
export const FACING = dirAt(WEDGE_AT);

// Signed distance to the sand as cut, negative inside.
export function sandDistance(x: number, y: number, z: number) {
  const cylinder = Math.max(Math.hypot(x, z) - RADIUS, Math.abs(y) - HALF);
  const a = x * CUT_A[0] + z * CUT_A[1];
  const b = x * CUT_B[0] + z * CUT_B[1];
  return Math.max(cylinder, Math.min(a, b));
}

export type Grid = { x: number; y: number; z: number; count: number };
export const gridFor = (low: boolean): Grid => {
  const [x, y, z] = low ? [48, 62, 48] : [80, 104, 80];
  return { x, y, z, count: x * y * z };
};

// A small smooth value noise, for lumps along the glass.
function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), sx), lerp(c(0, 1, 0), c(1, 1, 0), sx), sy), lerp(lerp(c(0, 0, 1), c(1, 0, 1), sx), lerp(c(0, 1, 1), c(1, 1, 1), sx), sy), sz);
}

// One point along a branch of glass: where, how thick, when the melt front reaches it (in seconds of the glass's own
// clock), and how deep in the branching it lies (0 the trunk).
type Knot = { p: THREE.Vector3; r: number; t: number; level: number };
type Branch = Knot[];

// A fulgurite: the lightning's current spreads down and out through the sand from where it struck, fusing a branching
// root of glass. A trunk wanders down, forking now and then; the forks and side roots taper and wander more; and short
// bristly spurs stick out all along, as on a real one dug from a dune.
export function growGlass(seed: number) {
  const random = lehmer(seed * 7919 + 13);
  const r = () => random();
  const branches: Branch[] = [];
  // On the broad cut face, a hand's width out from the corner.
  const along = dirAt(WEDGE_AT + Math.PI / 4);
  const root = new THREE.Vector3(along[0] * 0.15 - CUT_A[0] * 0.012, HALF + 0.012, along[1] * 0.15 - CUT_A[1] * 0.012);
  const down = new THREE.Vector3(0, -1, 0);
  const jitter = new THREE.Vector3();
  const steer = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  // The sand's outward direction at a point.
  const outward = (p: THREE.Vector3, out: THREE.Vector3) => {
    const e = 0.003;
    const d = sandDistance(p.x, p.y, p.z);
    out.set(sandDistance(p.x + e, p.y, p.z) - d, sandDistance(p.x, p.y + e, p.z) - d, sandDistance(p.x, p.y, p.z + e) - d).normalize();
    return d;
  };

  // The trunk and some forks run along a cut face, half sunk in it, so the growth shows in section; the rest wander off
  // into the sand, where only their glow shows through until the wind uncovers them.
  const grow = (start: THREE.Vector3, heading: THREE.Vector3, radius: number, length: number, level: number, t0: number, speed: number, hug: number) => {
    const branch: Branch = [{ p: start.clone(), r: radius, t: t0, level }];
    const dir = heading.clone().normalize();
    const step = level === 0 ? 0.007 : 0.006;
    const wander = [0.12, 0.24, 0.36, 0.5][Math.min(level, 3)];
    const fall = [0.2, 0.12, 0.05, 0.02][Math.min(level, 3)];
    const p = start.clone();
    let arc = 0;
    let rr = radius;
    const tipAt = length;
    while (arc < tipAt) {
      jitter.set(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(wander * 2);
      dir.add(jitter).addScaledVector(down, fall).normalize();
      p.addScaledVector(dir, step);
      arc += step;
      // Thins along its length, faster toward the tip.
      const left = Math.max(0, 1 - arc / tipAt);
      rr = radius * (0.3 + 0.7 * Math.pow(left, 0.7)) * Math.exp(-arc * (level === 0 ? 0.45 : 1.2));
      if (p.y < -HALF + 0.05 || rr < 0.0018) break;
      // Drawn toward the nearer cut face, to lie a quarter of its width proud of it.
      if (hug > 0) {
        const n = hug === 1 ? CUT_A : CUT_B;
        const cut = p.x * n[0] + p.z * n[1];
        const pull = (-rr * 0.3 - cut) * 0.35;
        p.x += n[0] * pull;
        p.z += n[1] * pull;
      }
      // Never out of the sand by more than a little.
      const d = outward(p, steer);
      const limit = -rr * 0.3;
      if (d > limit) {
        p.addScaledVector(steer, limit - d);
        dir.addScaledVector(steer, -0.5 * Math.max(0, dir.dot(steer))).normalize();
      }
      const t = t0 + arc / speed;
      branch.push({ p: p.clone(), r: rr, t, level });

      // Forks and side roots, and spurs.
      const fork = level === 0 ? 2.8 : level === 1 ? 2.6 : 0;
      const side = level === 0 ? 13 : level === 1 ? 9 : level === 2 ? 4 : 0;
      const spur = level < 3 ? 40 : 0;
      if (r() < fork * step && rr > 0.008) {
        const turn = scratch.copy(dir).add(jitter.set(r() - 0.5, (r() - 0.5) * 0.4, r() - 0.5).normalize().multiplyScalar(0.9)).normalize();
        const pick = r();
        grow(p, turn, rr * (0.7 + r() * 0.2), (tipAt - arc) * (0.6 + r() * 0.5), level + 1, t, speed * 0.9, pick < 0.5 ? 1 : pick < 0.7 ? 2 : 0);
        rr *= 0.88;
      } else if (r() < side * step && rr > 0.004) {
        const out = jitter.set(r() - 0.5, -0.15 - r() * 0.3, r() - 0.5).normalize();
        grow(p, scratch.copy(dir).multiplyScalar(0.4).add(out).normalize(), rr * (0.35 + r() * 0.25), 0.06 + r() * 0.3 * (level === 0 ? 1 : 0.6), level + 1, t, speed * 0.75, r() < 0.3 ? hug : 0);
      } else if (r() < spur * step && rr > 0.003) {
        const out = jitter.set(r() - 0.5, (r() - 0.6) * 0.6, r() - 0.5).normalize();
        grow(p, out, Math.max(0.0028, rr * (0.22 + r() * 0.18)), 0.012 + r() * 0.045, 3, t, speed * 0.6, 0);
      }
    }
    if (branch.length > 2) branches.push(branch);
  };

  grow(root, new THREE.Vector3(0.05, -1, 0.02), 0.04, 1.2, 0, 0, 0.62, 1);
  return { branches, root };
}

export type Glass = ReturnType<typeof growGlass>;

// The glass as one mesh: a lumpy tube round each branch, open at the mouth where the bolt struck, closed in a point at
// each tip. Each vertex carries the middle of its ring (so the shader can grow the tube from nothing) and when the melt
// reached it.
export function glassGeometry(glass: Glass, sides: number) {
  const positions: number[] = [];
  const centres: number[] = [];
  const infos: number[] = [];
  const indices: number[] = [];
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const q = new THREE.Vector3();
  const helper = new THREE.Vector3();

  for (const branch of glass.branches) {
    const base = positions.length / 3;
    const n = branch.length;
    const seed = (Math.abs(branch[0].p.x * 7919 + branch[0].p.z * 104729) % 100) + branch.length;
    // A frame carried along the branch without twisting.
    tangent.subVectors(branch[1].p, branch[0].p).normalize();
    helper.set(0, 0, 1);
    if (Math.abs(tangent.dot(helper)) > 0.9) helper.set(1, 0, 0);
    normal.crossVectors(tangent, helper).normalize();
    for (let i = 0; i < n; i++) {
      const k = branch[i];
      const next = branch[Math.min(i + 1, n - 1)].p;
      const prev = branch[Math.max(i - 1, 0)].p;
      const t2 = helper.subVectors(next, prev);
      if (t2.lengthSq() < 1e-12) t2.copy(tangent);
      t2.normalize();
      // Parallel transport: turn the normal by the change in tangent.
      normal.addScaledVector(t2, -normal.dot(t2));
      if (normal.lengthSq() < 1e-8) normal.set(t2.y, -t2.x, 0).addScaledVector(t2, 0);
      if (normal.lengthSq() < 1e-8) normal.set(0, t2.z, -t2.y);
      normal.normalize();
      tangent.copy(t2);
      binormal.crossVectors(tangent, normal);
      // The mouth flares a little; the tip pinches to a point.
      const flare = k.level === 0 && i < 3 ? 1.25 - i * 0.08 : 1;
      const tip = i === n - 1 ? 0.15 : i === n - 2 ? 0.6 : 1;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        q.copy(k.p)
          .addScaledVector(normal, ca * k.r)
          .addScaledVector(binormal, sa * k.r);
        // Lumps and ridges: fused sand bulges unevenly, in long ridges along the tube.
        const lump = 1 + 0.42 * (noise3(q.x * 70 + seed, q.y * 70, q.z * 70) - 0.5) + 0.3 * (noise3(q.x * 22, q.y * 22 + seed, q.z * 22) - 0.5) + 0.12 * Math.sin(a * 5 + noise3(k.p.x * 9, k.p.y * 9, seed) * 6);
        const radius = k.r * lump * flare * tip;
        positions.push(k.p.x + (normal.x * ca + binormal.x * sa) * radius, k.p.y + (normal.y * ca + binormal.y * sa) * radius, k.p.z + (normal.z * ca + binormal.z * sa) * radius);
        centres.push(k.p.x, k.p.y, k.p.z);
        infos.push(k.t, k.r, k.level, (s / sides + i * 0.37) % 1);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = base + i * sides + s;
        const b = base + i * sides + ((s + 1) % sides);
        const c = a + sides;
        const d = b + sides;
        indices.push(a, c, b, b, c, d);
      }
    }
    // The tip's point.
    const last = branch[n - 1];
    const dir = helper.subVectors(last.p, branch[n - 2].p);
    if (dir.lengthSq() < 1e-12) dir.copy(tangent);
    dir.normalize();
    const tipIndex = positions.length / 3;
    positions.push(last.p.x + dir.x * last.r * 1.2, last.p.y + dir.y * last.r * 1.2, last.p.z + dir.z * last.r * 1.2);
    centres.push(last.p.x, last.p.y, last.p.z);
    infos.push(last.t + 0.01, last.r, last.level, 0.5);
    for (let s = 0; s < sides; s++) indices.push(base + (n - 1) * sides + s, tipIndex, base + (n - 1) * sides + ((s + 1) % sides));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aCentre", new THREE.Float32BufferAttribute(centres, 3));
  geometry.setAttribute("aInfo", new THREE.Float32BufferAttribute(infos, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// How far each cell of the grid lies from the glass's surface, and when the melt front reached the nearest part of it:
// the sand glows and scorches by it, and melts away where the glass now is. Found by stamping a small ball of cells
// round every knot of every branch.
export function bakeField(glass: Glass, grid: Grid, out: Float32Array, offset: number) {
  const cell = BOX_SIZE.x / grid.x;
  const reach = 0.05;
  for (let i = 0; i < grid.count; i++) {
    out[(offset + i) * 2] = 99;
    out[(offset + i) * 2 + 1] = 9;
  }
  for (const branch of glass.branches) {
    for (const k of branch) {
      const span = Math.ceil((reach + k.r) / cell);
      const cx = Math.floor(((k.p.x - BOX_MIN.x) / BOX_SIZE.x) * grid.x);
      const cy = Math.floor(((k.p.y - BOX_MIN.y) / BOX_SIZE.y) * grid.y);
      const cz = Math.floor(((k.p.z - BOX_MIN.z) / BOX_SIZE.z) * grid.z);
      for (let z = Math.max(0, cz - span); z <= Math.min(grid.z - 1, cz + span); z++) {
        const pz = BOX_MIN.z + ((z + 0.5) / grid.z) * BOX_SIZE.z;
        for (let y = Math.max(0, cy - span); y <= Math.min(grid.y - 1, cy + span); y++) {
          const py = BOX_MIN.y + ((y + 0.5) / grid.y) * BOX_SIZE.y;
          for (let x = Math.max(0, cx - span); x <= Math.min(grid.x - 1, cx + span); x++) {
            const px = BOX_MIN.x + ((x + 0.5) / grid.x) * BOX_SIZE.x;
            const d = Math.hypot(px - k.p.x, py - k.p.y, pz - k.p.z) - k.r;
            const j = (offset + x + y * grid.x + z * grid.x * grid.y) * 2;
            if (d < out[j + 1]) {
              out[j + 1] = d;
              // Sand a little way off is reached a moment after the glass beside it.
              out[j] = k.t + Math.max(d, 0) * 3;
            }
          }
        }
      }
    }
  }
}

// A bolt: the main channel jagged by midpoint displacement from high above down to the strike, with forks that die out
// in the air. Each piece is a segment from a to b, with how far down the channel it lies (0 at the cloud, 1 at the sand),
// its depth in the branching and how wide it is.
export type Segment = { a: THREE.Vector3; b: THREE.Vector3; order: number; level: number; width: number };
export function boltSegments(seed: number, to: THREE.Vector3) {
  const random = lehmer(seed * 104729 + 7);
  const r = () => random();
  const segments: Segment[] = [];
  const jag = (a: THREE.Vector3, b: THREE.Vector3, depth: number, spread: number, out: THREE.Vector3[]) => {
    if (depth === 0) {
      out.push(b.clone());
      return;
    }
    const length = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.4 + r() * 0.2);
    mid.x += (r() - 0.5) * length * spread;
    mid.z += (r() - 0.5) * length * spread;
    mid.y += (r() - 0.5) * length * spread * 0.4;
    jag(a, mid, depth - 1, spread, out);
    jag(mid, b, depth - 1, spread, out);
  };
  const from = new THREE.Vector3(to.x + (r() - 0.5) * 3.2, to.y + 8, to.z - 1 - r() * 1.5);
  const main: THREE.Vector3[] = [from.clone()];
  jag(from, to, 8, 0.42, main);
  for (let i = 0; i < main.length - 1; i++) segments.push({ a: main[i], b: main[i + 1], order: i / (main.length - 1), level: 0, width: 1 });
  // Forks from the upper parts of the channel, down and outward.
  const forks = 9;
  for (let f = 0; f < forks; f++) {
    const at = Math.floor(Math.pow(r(), 1.3) * (main.length - 12));
    const start = main[at];
    const heading = new THREE.Vector3().subVectors(main[Math.min(at + 4, main.length - 1)], start).normalize();
    heading.x += (r() - 0.5) * 1.6;
    heading.z += (r() - 0.5) * 1.2;
    heading.normalize();
    const length = 0.8 + r() * 2.4;
    const end = start.clone().addScaledVector(heading, length);
    const pts: THREE.Vector3[] = [start.clone()];
    jag(start, end, 6, 0.5, pts);
    const order0 = at / (main.length - 1);
    for (let i = 0; i < pts.length - 1; i++) segments.push({ a: pts[i], b: pts[i + 1], order: order0 + (i / pts.length) * 0.25, level: 1, width: 0.55 * (1 - (i / pts.length) * 0.7) });
  }
  return segments;
}
