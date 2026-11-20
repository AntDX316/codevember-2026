/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { clamp, float, max, mix, pow, sin, smoothstep } from "three/tsl";

// The chrysalis in its own space: 1.75 tall, centred on the origin, hanging along y with its stalk at the top. The
// front, where the gold crown is fullest, faces +z.
export const HALF = 0.875;
export const WIDE = 0.47;
// Where it hangs: the silk pad under the twig, and how far below that the pod's middle sits.
export const PIVOT = new THREE.Vector3(0, 1.32, 0);
export const DROP = 1.095;
// The shoulder, where the ring of gold sits, as a height in pod space.
export const SHOULDER = -HALF + 0.72 * 2 * HALF;
// How many pieces the shell breaks into.
export const SEEDS = 46;

// The outline, as radius against height from the bottom (0) to the top (1): blunt below, widest a little below the
// middle, stepping in at the shoulder and closing to a narrow crown. The same curve is written twice, once for the CPU
// (geometry, picking) and once for the shaders (the glow inside).
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function radiusAt(t: number) {
  if (t <= 0 || t >= 1) return 0;
  const body = Math.pow(Math.max(Math.sin(Math.PI * Math.pow(t, 0.85)), 0), 0.5);
  const shoulder = 1 - 0.14 * smooth(0.66, 0.78, t);
  const ring = 0.012 * Math.exp(-Math.pow((t - 0.72) / 0.012, 2));
  return WIDE * body * shoulder + ring;
}
export const radiusOf = (y: number) => radiusAt((y + HALF) / (2 * HALF));

export function radiusNode(y: any) {
  const t = clamp(y.add(HALF).div(2 * HALF), 0, 1) as any;
  const body = pow(max(sin(t.pow(0.85).mul(Math.PI)), float(0)), float(0.5)) as any;
  const shoulder = mix(float(1), float(0.86), smoothstep(0.66, 0.78, t)) as any;
  return body.mul(shoulder).mul(WIDE) as any;
}

// A small seeded random, so every visit breaks the same jewel the same way.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ridges = (phi: number, t: number) => 1 + 0.011 * Math.cos(phi * 8) * Math.sin(Math.PI * t);

// The shell: a lathe with faint ridges down it, split into pieces round scattered seeds. Every triangle keeps its own
// corners, so each piece can be carried off whole: aShard holds its piece's middle and number, aHinge the point on
// its top edge it folds back about and what it does when the shell opens (0 stays, 1 peels back, 2 falls).
export function buildShell(rows: number, around: number) {
  const random = rng(20);
  const positions: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const y = -HALF + t * 2 * HALF;
    for (let i = 0; i <= around; i++) {
      const phi = (i / around) * Math.PI * 2;
      const r = radiusAt(t) * ridges(phi, t);
      positions.push(Math.sin(phi) * r, y, Math.cos(phi) * r);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i;
      const b = a + around + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const smoothGeometry = new THREE.BufferGeometry();
  smoothGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  smoothGeometry.setIndex(index);
  smoothGeometry.computeVertexNormals();
  // The seam down the back gets two sets of normals; average them so it does not show.
  const n = smoothGeometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let j = 0; j <= rows; j++) {
    const a = j * (around + 1);
    const b = a + around;
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  // The poles have no area to average over: point them straight along the axis.
  for (let i = 0; i <= around; i++) {
    n.setXYZ(i, 0, -1, 0);
    n.setXYZ(rows * (around + 1) + i, 0, 1, 0);
  }
  const geometry = smoothGeometry.toNonIndexed();
  smoothGeometry.dispose();

  // Seeds spread evenly over the surface by best candidate: of a handful of random points on it, the one furthest from
  // every seed so far. Points are drawn by area, so the narrow crown does not crowd with pieces.
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const triangles = pos.count / 3;
  const areas = new Float32Array(triangles);
  let total = 0;
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let f = 0; f < triangles; f++) {
    va.fromBufferAttribute(pos, f * 3);
    vb.fromBufferAttribute(pos, f * 3 + 1);
    vc.fromBufferAttribute(pos, f * 3 + 2);
    total += vb.sub(va).cross(vc.sub(va)).length() / 2;
    areas[f] = total;
  }
  const surfacePoint = () => {
    const pick = random() * total;
    let lo = 0;
    let hi = triangles - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (areas[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    va.fromBufferAttribute(pos, lo * 3);
    vb.fromBufferAttribute(pos, lo * 3 + 1).sub(va);
    vc.fromBufferAttribute(pos, lo * 3 + 2).sub(va);
    return va.clone().addScaledVector(vb, u).addScaledVector(vc, v);
  };
  const seeds: THREE.Vector3[] = [];
  for (let s = 0; s < SEEDS; s++) {
    let best = surfacePoint();
    let bestGap = -1;
    for (let k = 0; k < (s === 0 ? 1 : 24); k++) {
      const candidate = surfacePoint();
      const gap = Math.min(...seeds.map((seed) => seed.distanceToSquared(candidate)), Infinity);
      if (gap > bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    seeds.push(best);
  }

  // Each triangle goes to the seed nearest its middle.
  const owner = new Int32Array(triangles);
  const sums = seeds.map(() => ({ c: new THREE.Vector3(), n: 0, top: -Infinity }));
  const mid = new THREE.Vector3();
  for (let f = 0; f < triangles; f++) {
    mid.set(0, 0, 0);
    let top = -Infinity;
    for (let k = 0; k < 3; k++) {
      va.fromBufferAttribute(pos, f * 3 + k);
      mid.add(va);
      top = Math.max(top, va.y);
    }
    mid.divideScalar(3);
    let nearest = 0;
    let d = Infinity;
    seeds.forEach((seed, s) => {
      const e = seed.distanceToSquared(mid);
      if (e < d) {
        d = e;
        nearest = s;
      }
    });
    owner[f] = nearest;
    sums[nearest].c.add(mid);
    sums[nearest].n++;
    sums[nearest].top = Math.max(sums[nearest].top, top);
  }
  const pieces = sums.map((s, i) => {
    const centre = s.n ? s.c.divideScalar(s.n) : seeds[i].clone();
    // The crown stays on its stalk; the upper pieces fold back like petals; the rest drop away.
    const kind = centre.y > 0.62 ? 0 : centre.y > 0.08 ? 1 : 2;
    const top = Number.isFinite(s.top) ? Math.min(s.top, 0.84) : centre.y;
    const flat = Math.hypot(centre.x, centre.z) || 1;
    const r = radiusOf(top);
    const hinge = new THREE.Vector3((centre.x / flat) * r, top, (centre.z / flat) * r);
    return { centre, kind, hinge };
  });
  const shard = new Float32Array(pos.count * 4);
  const hinge = new Float32Array(pos.count * 4);
  for (let f = 0; f < triangles; f++) {
    const p = pieces[owner[f]];
    for (let k = 0; k < 3; k++) {
      const o = (f * 3 + k) * 4;
      shard.set([p.centre.x, p.centre.y, p.centre.z, owner[f]], o);
      hinge.set([p.hinge.x, p.hinge.y, p.hinge.z, p.kind], o);
    }
  }
  geometry.setAttribute("aShard", new THREE.BufferAttribute(shard, 4));
  geometry.setAttribute("aHinge", new THREE.BufferAttribute(hinge, 4));
  geometry.computeBoundingSphere();
  return { geometry, seeds };
}

// Where a ray in pod space first meets the skin, or null: stepped through the pod's bounding ball, then narrowed.
const probe = new THREE.Vector3();
export function hitPod(ray: THREE.Ray, out: THREE.Vector3) {
  const o = ray.origin;
  const d = ray.direction;
  const b = o.dot(d);
  const c = o.lengthSq() - 0.95 * 0.95;
  const h = b * b - c;
  if (h < 0) return null;
  const s = Math.sqrt(h);
  const from = Math.max(0, -b - s);
  const to = -b + s;
  if (to <= 0) return null;
  const inside = (t: number) => {
    probe.copy(o).addScaledVector(d, t);
    return Math.hypot(probe.x, probe.z) < radiusOf(probe.y) + 0.01;
  };
  const steps = 72;
  let last = from;
  for (let k = 0; k <= steps; k++) {
    const t = from + ((to - from) * k) / steps;
    if (inside(t)) {
      let lo = last;
      let hi = t;
      for (let n = 0; n < 10; n++) {
        const m = (lo + hi) / 2;
        if (inside(m)) hi = m;
        else lo = m;
      }
      out.copy(o).addScaledVector(d, hi);
      return hi;
    }
    last = t;
  }
  return null;
}
