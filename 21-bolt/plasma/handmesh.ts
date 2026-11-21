// One continuous hand: a stylised low-poly hand modelled once, at load, round a hand at rest, then posed to the 21
// tracked landmarks every frame. Modelled as a box modeller would: a palm lofted from a wrist ring through the thumb's
// level to the knuckles, whose top edge is made of the fingers' own first rings, so the fingers grow straight out of it;
// a thumb drawn out of the palm's side the same way; each finger a run of six-sided rings closed by a blunt faceted cap.
// About 330 triangles, all wound outward. Each vertex is carried rigidly by up to three bones, without stretching.
import { BONES, TIPS } from "./hand-shape";

// A right hand at rest, open, palm toward +z, thumb toward +x, in palm lengths (wrist to the middle knuckle is 1).
const REST: [number, number, number][] = [
  [0, 0, 0],
  [0.25, 0.15, 0.06],
  [0.45, 0.36, 0.1],
  [0.6, 0.56, 0.12],
  [0.72, 0.74, 0.12],
  [0.3, 0.95, 0],
  [0.36, 1.38, 0],
  [0.4, 1.62, 0],
  [0.43, 1.83, 0],
  [0.08, 1, 0],
  [0.09, 1.48, 0],
  [0.1, 1.76, 0],
  [0.11, 1.98, 0],
  [-0.13, 0.95, 0],
  [-0.17, 1.4, 0],
  [-0.2, 1.65, 0],
  [-0.22, 1.85, 0],
  [-0.32, 0.86, 0],
  [-0.4, 1.18, 0],
  [-0.45, 1.38, 0],
  [-0.49, 1.55, 0]
];
// How thick each finger is at each landmark, in palm lengths: stout and stylised.
const THICK = [0.16, 0.13, 0.105, 0.09, 0.075, 0.095, 0.082, 0.072, 0.062, 0.097, 0.084, 0.074, 0.063, 0.092, 0.08, 0.07, 0.06, 0.082, 0.07, 0.062, 0.054].map((r, k) => (k > 0 ? r * 1.05 : r));

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

// Distance to a limb that tapers from one radius to the other.
function limb(p: number[], a: number[], b: number[], ra: number, rb: number) {
  const ba = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ba) / dot(ba, ba)));
  return len(sub(p, [a[0] + ba[0] * t, a[1] + ba[1] * t, a[2] + ba[2] * t])) - (ra + (rb - ra) * t);
}
export type HandTemplate = {
  // Rest positions (xyz), triangles, and for each vertex its three bones (indices into BONES) and weights; how much of
  // a fingertip it is and which finger (0 thumb to 4 little), for the touch glow.
  rest: Float32Array;
  index: Uint32Array;
  bones: Uint8Array;
  weights: Float32Array;
  tip: Float32Array;
  // How far up its finger, toward the tip, from 0 at the wrist to 1 at the tip: a touch's glow spreads down from the tip.
  reach: Float32Array;
  finger: Uint8Array;
  count: number;
  // Each bone's frame at rest, and its length.
  frames: Float32Array;
  // The landmarks at rest (xyz), which the skinning keeps the proportions of.
  points: Float32Array;
  // For each triangle, which of its edges are ridges (the faces either side meet at more than RIDGE): bit k is the edge
  // facing corner k. Only these, and the outline, glow.
  ridges: Uint8Array;
};

// The rest hand as a mesh, by surface nets on a grid of this spacing (palm lengths).
// The faces either side of an edge meeting at more than this make it a ridge, which glows.
const RIDGE = (25 * Math.PI) / 180;

// The fingers, from the thumb's side across: each one's landmarks, knuckle first.
const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
// Half the palm's thickness, and each finger's at its knuckle.
const PALM_T = 0.085;
const KNUCKLE_T = 0.075;

function buildHand(): HandTemplate {
  const rest: number[] = [];
  const add = (p: number[]) => {
    rest.push(p[0], p[1], p[2]);
    return rest.length / 3 - 1;
  };
  // Each face with what lies inside it, to wind it outward: the palm's middle (-1) or a finger's chain of landmarks.
  const quads: [number[], number[] | null][] = [];
  const tris: [number[], number[] | null][] = [];
  const at = (v: number) => [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]];

  // The knuckle edge: the fingers' first rings, side by side. Each is six-sided (outer side, front two, inner side, back
  // two, going round), and neighbours share the side vertex between them.
  const x = FINGERS.map((f) => REST[f[0]][0]);
  const bounds = [x[0] + 0.11, ...x.slice(1).map((v, i) => (v + x[i]) / 2), x[3] - 0.1];
  const knuckleY = (i: number) => REST[FINGERS[i][0]][1];
  const sideY = (b: number) => (b === 0 ? knuckleY(0) - 0.04 : b === 4 ? knuckleY(3) - 0.04 : (knuckleY(b - 1) + knuckleY(b)) / 2 - 0.03);
  const sides = bounds.map((bx, b) => add([bx, sideY(b), 0]));
  const rings: number[][] = FINGERS.map((_, i) => {
    const c = x[i];
    const y = knuckleY(i);
    const outer = bounds[i];
    const inner = bounds[i + 1];
    const f1 = add([c + (outer - c) * 0.45, y, KNUCKLE_T]);
    const f2 = add([c + (inner - c) * 0.45, y, KNUCKLE_T]);
    const b2 = add([c + (inner - c) * 0.45, y, -KNUCKLE_T]);
    const b1 = add([c + (outer - c) * 0.45, y, -KNUCKLE_T]);
    return [sides[i], f1, f2, sides[i + 1], b2, b1];
  });

  // The palm's top loop, round the knuckle edge: along the front from the thumb's side, back along the back. The side
  // vertices between fingers come round twice, once from the front and once from the back.
  const top: number[] = [sides[0]];
  const front: boolean[] = [false];
  for (let i = 0; i < 4; i++) {
    top.push(rings[i][1], rings[i][2], rings[i][3]);
    front.push(true, true, i === 3 ? false : true);
  }
  for (let i = 3; i >= 0; i--) {
    top.push(rings[i][4], rings[i][5]);
    front.push(false, false);
    if (i > 0) {
      top.push(rings[i][0]);
      front.push(false);
    }
  }
  // Marked: front (+1), back (-1) or the hand's outer edge (0), for the rings below.
  const facing = top.map((v, k) => (v === sides[0] || v === sides[4] ? 0 : front[k] ? 1 : -1));
  // The palm's rings below, column for column: through the thumb's level (with the thumb's pad bulging on the front, on
  // the thumb's side), and the wrist, narrower.
  const ring = (y: number, widen: number, pad: number) =>
    top.map((v, k) => {
      const p = at(v);
      const thumbSide = Math.max(0, p[0]) / bounds[0];
      return add([p[0] * widen + pad * thumbSide * 0.06, y, facing[k] * (PALM_T + (facing[k] > 0 ? pad * thumbSide * 0.06 : 0))]);
    });
  const mid = ring(0.42, 1.02, 1);
  const wrist = ring(-0.02, 0.72, 0);
  const n = top.length;

  // The thumb comes out of the palm's side, on the thumb's side, between the wrist and the thumb's level: the two faces
  // either side of the outer column there become its first ring.
  const thumbFirst = [wrist[n - 1], wrist[0], wrist[1], mid[1], mid[0], mid[n - 1]];
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    if (k === n - 1 || k === 0) continue;
    quads.push([[wrist[k], wrist[k1], mid[k1], mid[k]], null]);
  }
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    quads.push([[mid[k], mid[k1], top[k1], top[k]], null]);
  }
  // The wrist, closed by a fan.
  const wristCentre = add([0, -0.05, 0]);
  for (let k = 0; k < n; k++) tris.push([[wrist[(k + 1) % n], wrist[k], wristCentre], null]);

  // A finger (or the thumb) drawn out of its first ring: a six-sided ring at each joint, the last a little short of the
  // tip, then a blunt cap. Each ring keeps the first ring's shape, turned to face along the finger.
  const extrude = (first: number[], joints: number[], chain: number[]) => {
    const centre = first.map(at).reduce((s, p) => [s[0] + p[0] / first.length, s[1] + p[1] / first.length, s[2] + p[2] / first.length], [0, 0, 0]);
    const axis = sub(REST[joints[0]], centre);
    const al = len(axis);
    const d = axis.map((v) => v / al);
    // Each vertex of the first ring as an offset round the axis, and the ring's mean radius.
    const offsets = first.map((v) => {
      const o = sub(at(v), centre);
      const along = dot(o, d);
      return [o[0] - d[0] * along, o[1] - d[1] * along, o[2] - d[2] * along];
    });
    const mean = offsets.reduce((s, o) => s + len(o), 0) / offsets.length;
    let previous = first;
    const points = joints.map((j, i) => (i === joints.length - 1 ? REST[j].map((v, m) => REST[joints[i - 1]][m] + (v - REST[joints[i - 1]][m]) * 0.72) : REST[j]));
    points.forEach((p, i) => {
      const radius = (i === points.length - 1 ? THICK[joints[i]] * 0.95 : THICK[joints[i]]) / mean;
      const next = offsets.map((o) => add([p[0] + o[0] * radius, p[1] + o[1] * radius, p[2] + o[2] * radius]));
      for (let k = 0; k < 6; k++) quads.push([[previous[k], previous[(k + 1) % 6], next[(k + 1) % 6], next[k]], chain]);
      previous = next;
    });
    // The cap: a low pyramid to the tip, blunt.
    const tipAt = REST[joints[joints.length - 1]];
    const last = points[points.length - 1];
    const apex = add(last.map((v, m) => v + (tipAt[m] - v) * 0.85));
    for (let k = 0; k < 6; k++) tris.push([[previous[k], previous[(k + 1) % 6], apex], chain]);
  };
  rings.forEach((first, i) => extrude(first, FINGERS[i].slice(1), FINGERS[i]));
  extrude(thumbFirst, [2, 3, 4], [1, 2, 3, 4]);

  // Triangles, every one turned to face away from what is inside it: for the palm, its middle sheet (z = 0, within the
  // palm's width); for a finger, the nearest point on its own chain of landmarks.
  const index: number[] = [];
  const face = (a: number, b: number, c: number, chain: number[] | null) => {
    const [pa, pb, pc] = [at(a), at(b), at(c)];
    const e = sub(pb, pa);
    const f = sub(pc, pa);
    const normal = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    if (len(normal) < 1e-9) return;
    const m = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    let best = Infinity;
    let inside = [Math.min(0.25, Math.max(-0.3, m[0])), Math.min(0.85, Math.max(0, m[1])), 0];
    const cores: [number[], number[]][] = chain ? chain.slice(1).map((j, i) => [REST[chain[i]], REST[j]]) : [];
    for (const [s0, s1] of cores) {
      const ba = sub(s1, s0);
      const t = Math.min(1, Math.max(0, dot(sub(m, s0), ba) / (dot(ba, ba) || 1)));
      const q = [s0[0] + ba[0] * t, s0[1] + ba[1] * t, s0[2] + ba[2] * t];
      const dd = len(sub(m, q));
      if (dd < best) {
        best = dd;
        inside = q;
      }
    }
    if (dot(normal, sub(m, inside)) < 0) index.push(a, c, b);
    else index.push(a, b, c);
  };
  for (const [[a, b, c, d], chain] of quads) {
    face(a, b, c, chain);
    face(a, c, d, chain);
  }
  for (const [[a, b, c], chain] of tris) face(a, b, c, chain);
  orient(index, rest);

  const count = rest.length / 3;
  // Each vertex's three nearest bones, weighted so a joint bends smoothly.
  const bones = new Uint8Array(count * 3);
  const weights = new Float32Array(count * 3);
  const tip = new Float32Array(count);
  const reach = new Float32Array(count);
  const finger = new Uint8Array(count);
  const fingerOf = (b: number) => (b <= 4 ? 0 : b <= 8 ? 1 : b <= 12 ? 2 : b <= 16 ? 3 : 4);
  for (let v = 0; v < count; v++) {
    const p = [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]];
    const near = BONES.map(([a, b], i) => ({ i, d: Math.max(0, limb(p, REST[a], REST[b], 0, 0)) })).sort((x, y) => x.d - y.d);
    let total = 0;
    // Steep, so a vertex follows mostly its own bone and the palm stays with the palm.
    for (let s = 0; s < 3; s++) total += 1 / Math.pow(near[s].d + 0.02, 6);
    for (let s = 0; s < 3; s++) {
      bones[v * 3 + s] = near[s].i;
      weights[v * 3 + s] = 1 / Math.pow(near[s].d + 0.02, 6) / total;
    }
    const f = fingerOf(Math.max(...BONES[near[0].i]));
    finger[v] = f;
    tip[v] = Math.max(0, 1 - len(sub(p, REST[TIPS[f]])) / 0.22);
    reach[v] = Math.min(1, Math.max(0, 1 - len(sub(p, REST[TIPS[f]])) / (0.9 * len(REST[TIPS[f]]))));
  }
  const frames = new Float32Array(BONES.length * 13);
  const restFlat = Float32Array.from(REST.flat());
  boneFrames(restFlat, frames);

  const ix = Uint32Array.from(index);
  const restAt = Float32Array.from(rest);
  return { rest: restAt, index: ix, bones, weights, tip, reach, finger, count, frames, points: restFlat, ridges: ridgesOf(restAt, ix) };
}

// Both hands, built once, when first wanted (about 0.1 s, so it is asked for ahead, while the page is idle).
let built: { right: HandTemplate; left: HandTemplate } | null = null;
export function handTemplates() {
  if (!built) {
    const right = buildHand();
    built = { right, left: mirrored(right) };
  }
  return built;
}

// Winds every triangle the same way as its neighbours (walking across shared edges, so each edge runs opposite ways in
// its two triangles), then all of them outward, by the sign of the enclosed volume. The guesses from what lies inside
// set the starting winding; this makes it exact.
function orient(index: number[], at: number[]) {
  const triangles = index.length / 3;
  const byEdge = new Map<string, number[]>();
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k];
      const b = index[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      byEdge.set(key, [...(byEdge.get(key) ?? []), t]);
    }
  const runs = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (index[t * 3 + k] === a && index[t * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const done = new Uint8Array(triangles);
  for (let start = 0; start < triangles; start++) {
    if (done[start]) continue;
    done[start] = 1;
    const queue = [start];
    while (queue.length) {
      const t = queue.pop() as number;
      for (let k = 0; k < 3; k++) {
        const a = index[t * 3 + k];
        const b = index[t * 3 + ((k + 1) % 3)];
        for (const u of byEdge.get(a < b ? `${a},${b}` : `${b},${a}`) ?? []) {
          if (done[u]) continue;
          // A neighbour must run this edge the other way.
          if (runs(u, a, b)) [index[u * 3 + 1], index[u * 3 + 2]] = [index[u * 3 + 2], index[u * 3 + 1]];
          done[u] = 1;
          queue.push(u);
        }
      }
    }
  }
  let volume = 0;
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => [at[index[t * 3 + k] * 3], at[index[t * 3 + k] * 3 + 1], at[index[t * 3 + k] * 3 + 2]]);
    volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (volume < 0) for (let t = 0; t < triangles; t++) [index[t * 3 + 1], index[t * 3 + 2]] = [index[t * 3 + 2], index[t * 3 + 1]];
}

// Which edges are ridges: for each pair of triangles sharing an edge, whether their faces meet at more than RIDGE. An
// edge with only one triangle (none, in a closed hand) counts as a ridge.
function ridgesOf(at: Float32Array, index: Uint32Array) {
  const triangles = index.length / 3;
  const normals = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]].map((v) => [at[v * 3], at[v * 3 + 1], at[v * 3 + 2]]);
    const e = sub(b, a);
    const f = sub(c, a);
    const nrm = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    const l = len(nrm) || 1;
    normals.set(nrm.map((v) => v / l), t * 3);
  }
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + ((k + 1) % 3)];
      const b = index[t * 3 + ((k + 2) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key) ?? [];
      list.push(t * 3 + k);
      edges.set(key, list);
    }
  const out = new Uint8Array(triangles);
  for (const list of edges.values()) {
    let ridge = list.length !== 2;
    if (!ridge) {
      const [t0, t1] = list.map((e) => Math.floor(e / 3));
      const cos = normals[t0 * 3] * normals[t1 * 3] + normals[t0 * 3 + 1] * normals[t1 * 3 + 1] + normals[t0 * 3 + 2] * normals[t1 * 3 + 2];
      ridge = cos < Math.cos(RIDGE);
    }
    if (ridge) for (const e of list) out[Math.floor(e / 3)] |= 1 << e % 3;
  }
  return out;
}

// The left hand: the right one mirrored across x, its triangles turned so they still face out.
function mirrored(t: HandTemplate): HandTemplate {
  const rest = t.rest.slice();
  for (let v = 0; v < t.count; v++) rest[v * 3] *= -1;
  const index = t.index.slice();
  for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  const points = Float32Array.from(REST.flat());
  for (let k = 0; k < 21; k++) points[k * 3] *= -1;
  const frames = new Float32Array(t.frames.length);
  boneFrames(points, frames);
  return { ...t, rest, index, frames, points, ridges: ridgesOf(rest, index) };
}

// Each bone's frame from 21 landmark positions: its start (3), along it (3), across the palm (3), the third axis (3), and
// its length. Right-handed: along × across = third. The palm's facing, from the wrist to the index and little knuckles,
// keeps every frame turned with the hand.
export function boneFrames(p: Float32Array, out: Float32Array) {
  const e = [p[15] - p[0], p[16] - p[1], p[17] - p[2]];
  const f = [p[51] - p[0], p[52] - p[1], p[53] - p[2]];
  let palm = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
  const pl = len(palm) || 1;
  palm = palm.map((x) => x / pl);
  BONES.forEach(([a, b], i) => {
    const o = i * 13;
    const along = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const length = len(along) || 1e-5;
    const x = along.map((v) => v / length);
    // Across: the palm's facing with the part along the bone taken out (or any perpendicular, if they line up).
    let y = palm.map((v, k) => v - x[k] * dot(palm, x));
    if (len(y) < 1e-3) y = Math.abs(x[0]) < 0.9 ? [1 - x[0] * x[0], -x[0] * x[1], -x[0] * x[2]] : [-x[1] * x[0], 1 - x[1] * x[1], -x[1] * x[2]];
    const yl = len(y);
    y = y.map((v) => v / yl);
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    out.set([p[a * 3], p[a * 3 + 1], p[a * 3 + 2], ...x, ...y, ...z, length], o);
  });
}

// The palm's frame from landmarks: toward the middle knuckle, across, and out of the palm (right-handed), as 9 numbers.
function palmFrame(p: Float32Array, out: Float32Array) {
  let x = [p[27] - p[0], p[28] - p[1], p[29] - p[2]];
  const e = [p[15] - p[0], p[16] - p[1], p[17] - p[2]];
  const f = [p[51] - p[0], p[52] - p[1], p[53] - p[2]];
  let z = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
  const xl = len(x) || 1;
  x = x.map((v) => v / xl);
  z = z.map((v, k) => v - x[k] * dot(z, x));
  const zl = len(z) || 1;
  z = z.map((v) => v / zl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  out.set([...x, ...y, ...z]);
}

// The hand posed from the tracked landmarks without stretching it: the palm is carried whole (turned to the tracked
// palm), and each finger bone takes only its direction from the tracking, keeping its own length at rest. So the hand
// keeps its proportions however the tracking jitters or foreshortens, at one size for the whole hand.
export type Pose = { joints: Float32Array; frames: Float32Array; rest: Float32Array; now: Float32Array };
export const newPose = (): Pose => ({ joints: new Float32Array(63), frames: new Float32Array(BONES.length * 13), rest: new Float32Array(9), now: new Float32Array(9) });
const PALM_POINTS = [1, 5, 9, 13, 17];
const CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
export function pose(t: HandTemplate, w: Float32Array, size: number, out: Pose) {
  const r = t.points;
  const j = out.joints;
  palmFrame(r, out.rest);
  palmFrame(w, out.now);
  const R = out.rest;
  const N = out.now;
  j[0] = w[0];
  j[1] = w[1];
  j[2] = w[2];
  for (const k of PALM_POINTS) {
    const d = [r[k * 3] - r[0], r[k * 3 + 1] - r[1], r[k * 3 + 2] - r[2]];
    // Into the palm's own axes at rest, then out along the tracked palm's.
    const a = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
    const b = d[0] * R[3] + d[1] * R[4] + d[2] * R[5];
    const c = d[0] * R[6] + d[1] * R[7] + d[2] * R[8];
    for (let m = 0; m < 3; m++) j[k * 3 + m] = j[m] + (N[m] * a + N[3 + m] * b + N[6 + m] * c) * size;
  }
  for (const chain of CHAINS) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      const dir = [w[b * 3] - w[a * 3], w[b * 3 + 1] - w[a * 3 + 1], w[b * 3 + 2] - w[a * 3 + 2]];
      const dl = len(dir) || 1;
      const length = len([r[b * 3] - r[a * 3], r[b * 3 + 1] - r[a * 3 + 1], r[b * 3 + 2] - r[a * 3 + 2]]) * size;
      for (let m = 0; m < 3; m++) j[b * 3 + m] = j[a * 3 + m] + (dir[m] / dl) * length;
    }
  }
  boneFrames(j, out.frames);
}

// The posed hand into positions (xyz per vertex): each vertex carried rigidly with its bones, at the hand's one size.
export function skin(t: HandTemplate, now: Float32Array, size: number, out: Float32Array, offset: number) {
  const r = t.frames;
  for (let v = 0; v < t.count; v++) {
    const px = t.rest[v * 3];
    const py = t.rest[v * 3 + 1];
    const pz = t.rest[v * 3 + 2];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let s = 0; s < 3; s++) {
      const w = t.weights[v * 3 + s];
      if (w < 1e-4) continue;
      const o = t.bones[v * 3 + s] * 13;
      const dx = px - r[o];
      const dy = py - r[o + 1];
      const dz = pz - r[o + 2];
      const u = (dx * r[o + 3] + dy * r[o + 4] + dz * r[o + 5]) * size;
      const a = (dx * r[o + 6] + dy * r[o + 7] + dz * r[o + 8]) * size;
      const b = (dx * r[o + 9] + dy * r[o + 10] + dz * r[o + 11]) * size;
      x += w * (now[o] + now[o + 3] * u + now[o + 6] * a + now[o + 9] * b);
      y += w * (now[o + 1] + now[o + 4] * u + now[o + 7] * a + now[o + 10] * b);
      z += w * (now[o + 2] + now[o + 5] * u + now[o + 8] * a + now[o + 11] * b);
    }
    out[offset + v * 3] = x;
    out[offset + v * 3 + 1] = y;
    out[offset + v * 3 + 2] = z;
  }
}

// One hand's skinned vertices laid out triangle by triangle, each corner carrying its face's own normal (outward, by the
// template's winding) so the hand is flat-shaded, faceted; and each corner's glow, from its vertex.
export function facets(t: HandTemplate, at: Float32Array, glowAt: Float32Array, out: Float32Array, normal: Float32Array, glowOut: Float32Array, tipOut: Float32Array, baryOut: Float32Array, coolOut: Float32Array, cool: number, corner: number) {
  const ix = t.index;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3;
    const b = ix[i + 1] * 3;
    const c = ix[i + 2] * 3;
    const ex = at[b] - at[a];
    const ey = at[b + 1] - at[a + 1];
    const ez = at[b + 2] - at[a + 2];
    const fx = at[c] - at[a];
    const fy = at[c + 1] - at[a + 1];
    const fz = at[c + 2] - at[a + 2];
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) {
      const v = ix[i + k];
      const o = (corner + i + k) * 3;
      out[o] = at[v * 3];
      out[o + 1] = at[v * 3 + 1];
      out[o + 2] = at[v * 3 + 2];
      normal[o] = nx;
      normal[o + 1] = ny;
      normal[o + 2] = nz;
      glowOut[corner + i + k] = glowAt[v];
      tipOut[corner + i + k] = t.tip[v];
      coolOut[corner + i + k] = cool;
      // Barycentric corners; for each edge that is not a ridge, the corner facing it is lifted by 1 at every corner, so
      // that edge never reads as one.
      const ridges = t.ridges[i / 3];
      for (let m = 0; m < 3; m++) baryOut[o + m] = (m === k ? 1 : 0) + (ridges & (1 << m) ? 0 : 1);
    }
  }
}
