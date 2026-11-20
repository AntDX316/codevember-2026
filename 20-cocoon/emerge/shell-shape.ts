import * as THREE from "three/webgpu";
import type { Species } from "./species";

// The shape of each species' chrysalis, after macro photographs of the real ones (scratch: emerge/shell/ref).
// A chrysalis is a tube round a centreline: t runs 0 at the cremaster to 1 at the head, u round it with 0 on the ventral
// side (the face, the sheaths, where the wing cases meet) and pi on the back. The centreline may bend (the glasswing's
// is hunched nearly double), and it is turned so the whole hangs plumb, its weight under the silk pad.
//
//   Blue Morpho   a smooth pointed teardrop, widest a third of the way down, closing fast onto the stalk above and
//                 drawn out below to a point with two tiny horns; faint creases, a milky wing case.
//   Monarch       a short ringed dome over a ridge a quarter of the way down (the ridge carries the black and gold
//                 band, round the back only), then a smooth near-cylinder, blunt and round at the head.
//   Glasswing     squat and hunched: a ringed cone under the stalk, bent sharply into a short pointed thorax.
//   Paper Kite    long and plump, clearly segmented behind, a waist, then a round knob of a head.

export type ShellKey = "morpho" | "monarch" | "glasswing" | "paperkite";

export type Shape = {
  key: ShellKey;
  // Row in the texture of markings.
  tile: number;
  // Half-width as a fraction of the length, at points down it.
  profile: [number, number][];
  // Squash from side to side.
  side: number;
  // The centreline turns by `angle` toward the ventral side between t0 and t1.
  bend: [t0: number, t1: number, angle: number];
  // More (or less) depth on the back and the front, by t.
  dorsal: (t: number) => number;
  ventral: (t: number) => number;
  // Creases between abdominal segments, how deep they are and how far each segment swells between them.
  grooves: number[];
  crease: number;
  scallop: number;
  // Where the abdomen (which stays whole) ends and the pieces that open begin.
  split: number;
  // Two horns at the head.
  horn: number;
  // A ridge round the back.
  ridge: [t: number, height: number] | null;
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, w: number) => Math.exp(-((x / w) ** 2));

export const SHAPES: Record<ShellKey, Shape> = {
  morpho: {
    key: "morpho",
    tile: 0,
    profile: [
      [0, 0.03],
      [0.04, 0.078],
      [0.1, 0.132],
      [0.2, 0.214],
      [0.3, 0.248],
      [0.38, 0.256],
      [0.5, 0.245],
      [0.6, 0.222],
      [0.7, 0.186],
      [0.8, 0.137],
      [0.9, 0.08],
      [0.96, 0.042],
      [1, 0.016]
    ],
    side: 0.95,
    bend: [0.2, 0.9, 0.1],
    dorsal: (t) => 0.1 * gauss(t - 0.5, 0.2),
    ventral: (t) => 0.05 * gauss(t - 0.62, 0.2),
    grooves: [0.07, 0.115, 0.165, 0.22, 0.28, 0.345, 0.41],
    crease: 0.0016,
    scallop: 0.0012,
    split: 0.45,
    horn: 1,
    ridge: null
  },
  monarch: {
    key: "monarch",
    tile: 1,
    profile: [
      [0, 0.03],
      [0.05, 0.092],
      [0.15, 0.166],
      [0.24, 0.206],
      [0.28, 0.214],
      [0.34, 0.211],
      [0.45, 0.213],
      [0.6, 0.211],
      [0.75, 0.205],
      [0.85, 0.193],
      [0.92, 0.163],
      [0.97, 0.104],
      [1, 0.02]
    ],
    side: 0.96,
    bend: [0.3, 0.9, 0.06],
    dorsal: (t) => 0.05 * gauss(t - 0.55, 0.2),
    ventral: (t) => 0.04 * gauss(t - 0.7, 0.2),
    grooves: [0.05, 0.085, 0.12, 0.155, 0.19, 0.225, 0.335, 0.405],
    crease: 0.0013,
    scallop: 0.0006,
    split: 0.42,
    horn: 0,
    ridge: [0.272, 0.016]
  },
  glasswing: {
    key: "glasswing",
    tile: 2,
    profile: [
      [0, 0.03],
      [0.06, 0.1],
      [0.2, 0.215],
      [0.34, 0.285],
      [0.46, 0.3],
      [0.6, 0.262],
      [0.75, 0.19],
      [0.88, 0.108],
      [0.96, 0.05],
      [1, 0.014]
    ],
    side: 0.86,
    bend: [0.28, 0.62, 0.95],
    dorsal: (t) => 0.2 * gauss(t - 0.44, 0.14),
    ventral: (t) => -0.12 * gauss(t - 0.5, 0.2),
    grooves: [0.06, 0.1, 0.14, 0.185, 0.235, 0.29, 0.35],
    crease: 0.002,
    scallop: 0.0014,
    split: 0.47,
    horn: 0.5,
    ridge: null
  },
  paperkite: {
    key: "paperkite",
    tile: 3,
    profile: [
      [0, 0.03],
      [0.05, 0.08],
      [0.15, 0.152],
      [0.3, 0.193],
      [0.42, 0.208],
      [0.55, 0.203],
      [0.68, 0.18],
      [0.78, 0.153],
      [0.88, 0.154],
      [0.95, 0.114],
      [1, 0.024]
    ],
    side: 0.94,
    bend: [0.25, 0.9, 0.16],
    dorsal: (t) => 0.12 * gauss(t - 0.42, 0.18) - 0.3 * gauss(t - 0.775, 0.045),
    ventral: (t) => 0.07 * gauss(t - 0.6, 0.25),
    grooves: [0.06, 0.11, 0.165, 0.225, 0.29, 0.36, 0.435, 0.51, 0.585],
    crease: 0.0034,
    scallop: 0.0032,
    split: 0.46,
    horn: 0,
    ridge: null
  }
};

export function shapeOf(sp: Species): Shape {
  const label = sp.label.toLowerCase();
  if (label.includes("monarch")) return SHAPES.monarch;
  if (label.includes("glass")) return SHAPES.glasswing;
  if (label.includes("morpho")) return SHAPES.morpho;
  return SHAPES.paperkite;
}

// A smooth curve through the profile's points.
function profile(sh: Shape, t: number) {
  const p = sh.profile;
  let k = 0;
  while (k < p.length - 2 && t > p[k + 1][0]) k++;
  const a = p[Math.max(0, k - 1)];
  const b = p[k];
  const c = p[k + 1];
  const d = p[Math.min(p.length - 1, k + 2)];
  const x = Math.min(1, Math.max(0, (t - b[0]) / (c[0] - b[0])));
  // Hermite, with slopes from the neighbours.
  const mb = ((c[1] - a[1]) / (c[0] - a[0] || 1)) * (c[0] - b[0]);
  const mc = ((d[1] - b[1]) / (d[0] - b[0] || 1)) * (c[0] - b[0]);
  const x2 = x * x;
  const x3 = x2 * x;
  return (2 * x3 - 3 * x2 + 1) * b[1] + (x3 - 2 * x2 + x) * mb + (-2 * x3 + 3 * x2) * c[1] + (x3 - x2) * mc;
}

// The centreline, in the chrysalis' own space (the top of the body at the origin, hanging down -y, ventral +z), per unit
// of length: where it is at t, and its angle from straight down.
type Spine = { y: Float32Array; z: Float32Array; angle: Float32Array };
const SPINE_N = 256;
const spines = new Map<ShellKey, Spine>();
function spineOf(sh: Shape): Spine {
  let spine = spines.get(sh.key);
  if (spine) return spine;
  const build = (lean: number) => {
    const y = new Float32Array(SPINE_N + 1);
    const z = new Float32Array(SPINE_N + 1);
    const angle = new Float32Array(SPINE_N + 1);
    for (let i = 0; i <= SPINE_N; i++) {
      const t = i / SPINE_N;
      angle[i] = lean + sh.bend[2] * smooth(sh.bend[0], sh.bend[1], t);
      if (i > 0) {
        const mid = (angle[i] + angle[i - 1]) / 2;
        y[i] = y[i - 1] - Math.cos(mid) / SPINE_N;
        z[i] = z[i - 1] + Math.sin(mid) / SPINE_N;
      }
    }
    return { y, z, angle };
  };
  // Hung so its weight lies under the pad.
  const straight = build(0);
  let my = 0;
  let mz = 0;
  for (let i = 0; i <= SPINE_N; i++) {
    const w = profile(sh, i / SPINE_N) ** 2;
    my += straight.y[i] * w;
    mz += straight.z[i] * w;
  }
  spine = build(-Math.atan2(mz, -my));
  spines.set(sh.key, spine);
  return spine;
}
const scratchAxis = { y: 0, z: 0, angle: 0 };
function axisAt(sh: Shape, t: number, out = scratchAxis) {
  const s = spineOf(sh);
  const x = Math.min(1, Math.max(0, t)) * SPINE_N;
  const i = Math.min(SPINE_N - 1, Math.floor(x));
  const f = x - i;
  out.y = s.y[i] + (s.y[i + 1] - s.y[i]) * f;
  out.z = s.z[i] + (s.z[i + 1] - s.z[i]) * f;
  out.angle = s.angle[i] + (s.angle[i + 1] - s.angle[i]) * f;
  return out;
}

// The centreline's point and direction at t, in scene units: for whoever needs to line something up with the shell.
export function pupaAxis(sp: Species, t: number, point = new THREE.Vector3(), direction = new THREE.Vector3()) {
  const a = axisAt(shapeOf(sp), t);
  point.set(0, a.y * sp.pupa, a.z * sp.pupa);
  direction.set(0, -Math.cos(a.angle), Math.sin(a.angle));
  return { point, direction };
}

// Where the wing case lies, as (t, |u|) of its root, apex and tornus.
export const CASE = { root: [0.84, 2.0], apex: [0.47, 0.42], tornus: [0.5, 1.72] };

// How far inside the wing case (t, |u|) lies: positive inside, by a triangle through root, apex and tornus.
export function caseInside(t: number, au: number) {
  const P = [t, au * 0.16];
  const pts = [CASE.root, CASE.apex, CASE.tornus].map(([a, b]) => [a, b * 0.16]);
  let m = Infinity;
  for (let i = 0; i < 3; i++) {
    const A = pts[i];
    const B = pts[(i + 1) % 3];
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const len = Math.hypot(ex, ey);
    const side = ((P[0] - A[0]) * ey - (P[1] - A[1]) * ex) / len;
    m = Math.min(m, side);
  }
  return m;
}

const info = { groove: 0, inside: 0, radius: 0, ay: 0, az: 0 };

// A point of the surface. Leaves in `info` how deep it lies in a crease, how far inside the wing case, the local
// half-width and the centreline's point.
export function surface(sh: Shape, L: number, t: number, u: number, out: THREE.Vector3) {
  const au = Math.abs(u);
  const ventral = Math.cos(u);
  const back = Math.max(0, -ventral);
  const front = Math.max(0, ventral);
  const base = profile(sh, t);
  let r = base * (1 + sh.dorsal(t) * back ** 1.5 + sh.ventral(t) * front ** 1.5);
  let d = 0;
  let groove = 0;
  const inside = caseInside(t, au);
  const onCase = smooth(-0.01, 0.02, inside);
  // Creases between the abdominal segments: fine lines, each segment swelling a little between them, strongest on the
  // back and gone under the wing cases.
  const round = (0.45 + 0.55 * smooth(-0.2, 0.7, -ventral)) * (1 - onCase);
  const g = sh.grooves;
  for (let k = 0; k < g.length; k++) {
    const crease = gauss(t - g[k], 0.0045);
    d -= sh.crease * crease * round;
    groove = Math.max(groove, crease * round);
    if (k > 0 && t > g[k - 1] && t < g[k]) d += sh.scallop * Math.sin((Math.PI * (t - g[k - 1])) / (g[k] - g[k - 1])) ** 2 * round;
  }
  // Spiracles: a small oval pit low on each side of every segment.
  for (let k = 1; k < g.length; k++) d -= 0.0016 * gauss(t - (g[k] + g[k - 1]) / 2, 0.006) * gauss(au - 1.85, 0.045) * (1 - onCase);
  // The wing cases: a shade proud, with a fine line round them.
  d += 0.003 * smooth(-0.03, 0.09, inside);
  // Down the ventral midline, the sheaths: the proboscis in the middle, legs either side, antennae along the wing
  // cases, each ending at its own length. Barely raised.
  if (au < 0.6) {
    const sheath = (centre: number, end: number, width: number, height: number) => height * gauss(au - centre, width) * smooth(end - 0.02, end + 0.04, t) * (1 - smooth(0.93, 0.98, t));
    d += sheath(0, 0.5, 0.05, 0.003) + sheath(0.11, 0.62, 0.035, 0.0024) + sheath(0.2, 0.72, 0.035, 0.002) + sheath(0.32, 0.47, 0.03, 0.002);
    groove = Math.max(groove, gauss(au - 0.06, 0.012) * smooth(0.5, 0.55, t) * 0.3, gauss(au - 0.16, 0.012) * smooth(0.62, 0.66, t) * 0.3);
  }
  // Eye caps, either side of the face.
  d += 0.008 * gauss(t - 0.925, 0.03) * gauss(au - 0.6, 0.22) * (sh.key === "morpho" ? 0.3 : 1);
  // The line down the back that it splits along.
  d += 0.002 * gauss(Math.PI - au, 0.04) * gauss(t - 0.65, 0.14);
  // A ridge round the back, falling away sharply below it (the monarch's, which carries the gold).
  if (sh.ridge) {
    const [rt, rh] = sh.ridge;
    const across = smooth(1.0, 1.5, au);
    d += rh * (t < rt ? gauss(t - rt, 0.03) : gauss(t - rt, 0.011)) * across;
    // Above it, a straight-sided cone on the back rather than a dome.
    d -= 0.012 * gauss(t - rt * 0.55, rt * 0.3) * across;
  }
  const a = axisAt(sh, t);
  let along = 0;
  if (sh.horn > 0) {
    // The head end forked into two short points.
    const fork = smooth(0.9, 1, t) * Math.abs(Math.sin(u)) ** 6;
    along = 0.028 * sh.horn * fork;
    r += 0.008 * sh.horn * smooth(0.95, 1, t) * Math.abs(Math.sin(u)) ** 6;
  }
  const ends = t <= 0 || t >= 1 ? 0 : 1;
  const rad = Math.max(0, r + d * smooth(0, 0.03, t) * smooth(1, 0.97, t)) * L * ends;
  const cos = Math.cos(a.angle);
  const sin = Math.sin(a.angle);
  // Across: x; toward the ventral side: (0, sin, cos); along: (0, -cos, sin).
  const v = Math.cos(u) * rad;
  out.set(Math.sin(u) * rad * sh.side, a.y * L + sin * v - cos * along * L, a.z * L + cos * v + sin * along * L);
  info.groove = groove;
  info.inside = inside;
  info.radius = base * L;
  info.ay = a.y * L;
  info.az = a.z * L;
  return info;
}

const ZERO = new THREE.Vector3();
// The same surface, looked up: every point of each species' shell worked out once on a grid (per unit of length) and
// read off between its points afterwards. The exact `surface` walks the profile, every crease and the wing case for
// each point; the probes and holds ask for thousands of points a frame while the butterfly climbs out, which is what
// made the emergence stutter. Out by under a thousandth of the length (it smooths the finest creases), which no foot
// or probe can feel. The mesh itself is still built from the exact one.
const FAST_T = 192;
const FAST_U = 128;
const grids = new Map<ShellKey, Float32Array>();
function gridOf(sh: Shape) {
  let grid = grids.get(sh.key);
  if (grid) return grid;
  grid = new Float32Array((FAST_T + 1) * (FAST_U + 1) * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i <= FAST_T; i++)
    for (let j = 0; j <= FAST_U; j++) {
      // Not quite to the very ends, where the exact surface closes to a point.
      surface(sh, 1, Math.min(0.9995, Math.max(0.0005, i / FAST_T)), -Math.PI + (j / FAST_U) * Math.PI * 2, p);
      grid.set([p.x, p.y, p.z], (i * (FAST_U + 1) + j) * 3);
    }
  grids.set(sh.key, grid);
  return grid;
}
// Work every species' grid out now (at load), so that none is worked out in the middle of an emergence.
export function warmShell(species: Species[]) {
  for (const sp of species) gridOf(shapeOf(sp));
}
export function surfaceFast(sh: Shape, L: number, t: number, u: number, out: THREE.Vector3) {
  const grid = gridOf(sh);
  const x = Math.min(1, Math.max(0, t)) * FAST_T;
  let y = ((u + Math.PI) / (Math.PI * 2)) % 1;
  if (y < 0) y += 1;
  y *= FAST_U;
  const i = Math.min(FAST_T - 1, Math.floor(x));
  const j = Math.min(FAST_U - 1, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const a = (i * (FAST_U + 1) + j) * 3;
  const b = a + 3;
  const c = a + (FAST_U + 1) * 3;
  const d = c + 3;
  const w00 = (1 - fx) * (1 - fy) * L;
  const w01 = (1 - fx) * fy * L;
  const w10 = fx * (1 - fy) * L;
  const w11 = fx * fy * L;
  return out.set(grid[a] * w00 + grid[b] * w01 + grid[c] * w10 + grid[d] * w11, grid[a + 1] * w00 + grid[b + 1] * w01 + grid[c + 1] * w10 + grid[d + 1] * w11, grid[a + 2] * w00 + grid[b + 2] * w01 + grid[c + 2] * w10 + grid[d + 2] * w11);
}

export type Piece = { geometry: THREE.BufferGeometry; pivot: THREE.Vector3 };

// The line the shell tears round, where the abdomen ends and the pieces that open begin: the hinge of every one of
// them. It wanders a little.
export const splitAt = (sh: Shape, u: number) => sh.split + 0.006 * Math.sin(u * 5 + 0.7) + 0.004 * Math.sin(u * 13 + 2) + 0.02 * Math.cos(u);

// HOW THE PIECES OPEN. Nothing swings off as a rigid body: each piece stays joined to the abdomen along the tear line
// and bends away from it, and a point's share of the bending is nothing at the tear line, so the hinge edge never
// leaves the abdomen's rim at any angle.
//   The lid turns outward about the line across the ventral side, each point about the spot of the tear line above
//   it: most of the turn in the first eighth of the length, a slow curl after.
//   The sides open as a split chrysalis does, not as a bell: their ventral edges (where the lid tore away) draw apart
//   ROUND the body, toward the flanks (a turn about the centreline, partWeight), and curl outward a little
//   (bendWeight); the flanks barely move and the back stays shut.
// The angles are read off the pivots the scene turns: the lid's is -rotation.x, the sides' are |rotation.z|.
// The sides' shares of their angle: how far they curl outward at the ventral edge, on the flank and at the back, and
// how far the ventral edge is carried round.
export const BEND = { edge: 0.62, flank: 0.45, back: 0.25, part: 0.9 };
export function bendWeight(sh: Shape, t: number, u: number, piece: number) {
  if (piece < 1) return 0;
  const s = t - splitAt(sh, u);
  if (s <= 0) return 0;
  if (piece === 1) return 0.75 * smooth(0, 0.12, s) + 0.25 * smooth(0, 0.5, s);
  const au = Math.abs(u);
  return (0.45 * smooth(0, 0.12, s) + 0.55 * smooth(0.05, 0.6, s)) * (BEND.back + (BEND.flank - BEND.back) * smooth(2.7, 1.7, au) + (BEND.edge - BEND.flank) * smooth(1.8, 0.7, au));
}
// How much of a side's angle a point is carried round the body by, away from the ventral midline.
export function partWeight(sh: Shape, t: number, u: number, piece: number) {
  if (piece < 2) return 0;
  const s = t - splitAt(sh, u);
  if (s <= 0) return 0;
  return smooth(0, 0.16, s) * BEND.part * smooth(2.5, 0.8, Math.abs(u));
}
// The line the sides part round: the centreline where the shell tears.
export function partLine(sp: Species, point: THREE.Vector3, direction: THREE.Vector3) {
  pupaAxis(sp, shapeOf(sp).split, point, direction);
}
// The same, without the falling off toward the back: where the cuticle is creased by the bending.
const creaseAt = (sh: Shape, t: number, u: number) => {
  const s = t - splitAt(sh, u);
  return s <= 0 ? 0 : smooth(0, 0.03, s) * smooth(0.16, 0.06, s);
};

// The hinge under u: its point on the tear line and the line it turns about (turning by a positive angle about it
// carries what hangs below outward).
export function hingeAt(sh: Shape, L: number, u: number, point: THREE.Vector3, axis: THREE.Vector3, piece = 2) {
  const t = splitAt(sh, u);
  surfaceFast(sh, L, t, u, point);
  // The lid turns as one, about the line across its middle.
  if (piece === 1) {
    axis.set(-1, 0, 0);
    return point;
  }
  const a = axisAt(sh, t);
  const cos = Math.cos(a.angle);
  const sin = Math.sin(a.angle);
  // Down the centreline, and out from it.
  const dy = -cos;
  const dz = sin;
  let ox = point.x;
  let oy = point.y - a.y * L;
  let oz = point.z - a.z * L;
  const along = oy * dy + oz * dz;
  oy -= along * dy;
  oz -= along * dz;
  const len = Math.hypot(ox, oy, oz) || 1;
  ox /= len;
  oy /= len;
  oz /= len;
  // down x out.
  axis.set(dy * oz - dz * oy, dz * ox, -dy * ox);
  return point;
}

// The angles the pieces are open by, as the scene has set them on the pivots: [0, lid, right side, left side].
export function openAngles(pivots: THREE.Object3D[], out: number[] = [0, 0, 0, 0]) {
  out[0] = 0;
  out[1] = Math.max(0, -pivots[1].rotation.x);
  out[2] = Math.max(0, pivots[2].rotation.z);
  out[3] = Math.max(0, -pivots[3].rotation.z);
  return out;
}

const hingeP = new THREE.Vector3();
const hingeA = new THREE.Vector3();
const turned = new THREE.Vector3();
function turn(v: THREE.Vector3, about: THREE.Vector3, axis: THREE.Vector3, angle: number) {
  turned.copy(v).sub(about).applyAxisAngle(axis, angle);
  return v.copy(turned).add(about);
}

// A point of the shell at (t, u), given in its rest place, carried to where it is drawn with the pieces open as the
// pivots say; a direction (its normal) turned with it if given.
export function posePoint(sp: Species, pivots: THREE.Object3D[], t: number, u: number, point: THREE.Vector3, normal?: THREE.Vector3) {
  const sh = shapeOf(sp);
  const piece = pieceAt(sh, t, u);
  const open = openAngles(pivots, scratchAngles)[piece];
  if (open === 0) return point;
  const angle = open * bendWeight(sh, t, u, piece);
  hingeAt(sh, sp.pupa, u, hingeP, hingeA, piece);
  turn(point, hingeP, hingeA, angle);
  if (normal) normal.applyAxisAngle(hingeA, angle);
  const round = -Math.sign(u) * open * partWeight(sh, t, u, piece);
  if (round !== 0) {
    partLine(sp, hingeP, hingeA);
    turn(point, hingeP, hingeA, round);
    if (normal) normal.applyAxisAngle(hingeA, round);
  }
  return point;
}
const scratchAngles = [0, 0, 0, 0];

// A point anywhere near piece `piece` (not only on the surface), given in its rest place, carried to where the piece's
// bending takes it: the same turning as posePoint, with the shares of the spot of the shell nearest it.
const poseAngles = { bent: 0, round: 0, u: 0 };
function poseNear(sp: Species, sh: Shape, open: number, piece: number, rest: THREE.Vector3, out: THREE.Vector3) {
  shellProbe(sp, rest, scratchProbe);
  let u = scratchProbe.u;
  // Kept on this piece's own stretch of the hinge.
  if (piece === 1) u = Math.max(-0.9, Math.min(0.9, u));
  else if (piece === 2) u = Math.max(0.3, u < -1 ? Math.PI : u);
  else u = Math.min(-0.3, u > 1 ? -Math.PI : u);
  const t = Math.max(scratchProbe.t, 0);
  poseAngles.bent = open * bendWeight(sh, t, u, piece);
  poseAngles.round = -Math.sign(u) * open * partWeight(sh, t, u, piece);
  poseAngles.u = u;
  out.copy(rest);
  hingeAt(sh, sp.pupa, u, hingeP, hingeA, piece);
  turn(out, hingeP, hingeA, poseAngles.bent);
  if (poseAngles.round !== 0) {
    partLine(sp, hingeP, hingeA);
    turn(out, hingeP, hingeA, poseAngles.round);
  }
  return out;
}

// The other way: a point in the pod's space carried back to where it would be were piece `piece` shut (its rest place),
// so that it can be looked up on the closed shell. Solved by stepping: a guess is carried forward, and what it misses
// by is turned back and taken off the guess, until it lands on the point (to a ten-thousandth, in a dozen steps at
// the widest angles).
export function unposePoint(sp: Species, pivots: THREE.Object3D[], piece: number, point: THREE.Vector3, out = new THREE.Vector3()) {
  out.copy(point);
  const open = openAngles(pivots, scratchAngles)[piece];
  if (piece < 1 || open === 0) return out;
  const sh = shapeOf(sp);
  // First guess: turned back as the middle of the piece is.
  const u0 = piece === 1 ? 0 : piece === 2 ? 1.1 : -1.1;
  if (piece > 1) {
    partLine(sp, hingeP, hingeA);
    turn(out, hingeP, hingeA, Math.sign(u0) * open * 0.6);
  }
  hingeAt(sh, sp.pupa, u0, hingeP, hingeA, piece);
  turn(out, hingeP, hingeA, -open * (piece === 1 ? 0.9 : 0.3));
  for (let i = 0; i < 14; i++) {
    poseNear(sp, sh, open, piece, out, missed);
    missed.subVectors(point, missed);
    const far = missed.lengthSq();
    if (far < 1e-10) break;
    // Turned back by the turning there.
    if (poseAngles.round !== 0) {
      partLine(sp, hingeP, hingeA);
      missed.applyAxisAngle(hingeA, -poseAngles.round);
    }
    hingeAt(sh, sp.pupa, poseAngles.u, hingeP, hingeA, piece);
    missed.applyAxisAngle(hingeA, -poseAngles.bent);
    out.addScaledVector(missed, 0.85);
  }
  return out;
}
const missed = new THREE.Vector3();

// A point on the outside of the shell at (t, u) as it is drawn now, with the way out from it: for feet to hold. With
// no pivots, the closed shell.
export function shellSurface(sp: Species, t: number, u: number, pivots: THREE.Object3D[] | null, out: { point: THREE.Vector3; normal: THREE.Vector3 }) {
  pupaPoint(sp, t, u, out.point, out.normal);
  if (!pivots) return out;
  posePoint(sp, pivots, t, u, out.point, out.normal);
  // The true way out of the bent surface, from its neighbours as they are drawn (a bend that tightens along the piece
  // tilts it): kept on the side the turned normal points to.
  const sh = shapeOf(sp);
  const piece = pieceAt(sh, t, u);
  if (piece < 1 || openAngles(pivots, scratchAngles)[piece] === 0) return out;
  const e = 0.004;
  const at = (dt: number, du: number, v: THREE.Vector3) => {
    const tt = Math.min(0.999, Math.max(0.001, t + dt));
    surfaceFast(sh, sp.pupa, tt, u + du, v);
    // As this piece is turned, whichever side of a tear the neighbour falls.
    const open = scratchAngles[piece];
    hingeAt(sh, sp.pupa, u + du, hingeP, hingeA, piece);
    turn(v, hingeP, hingeA, open * bendWeight(sh, tt, u + du, piece));
    const round = -Math.sign(u) * open * partWeight(sh, tt, u + du, piece);
    if (round !== 0) {
      partLine(sp, hingeP, hingeA);
      turn(v, hingeP, hingeA, round);
    }
    return v;
  };
  openAngles(pivots, scratchAngles);
  at(e, 0, surfA).sub(at(-e, 0, surfB));
  at(0, 0.02, surfC).sub(at(0, -0.02, surfB));
  surfA.cross(surfC);
  if (surfA.lengthSq() > 1e-20) {
    surfA.normalize();
    if (surfA.dot(out.normal) < 0) surfA.negate();
    out.normal.copy(surfA);
  }
  return out;
}
const surfA = new THREE.Vector3();
const surfB = new THREE.Vector3();
const surfC = new THREE.Vector3();

// Which of the four pieces (t, u) belongs to: the abdomen, which stays whole; the face plate, which swings open like a
// lid; and the two sides with half the back each. Along the true lines of weakness, a little ragged.
export function pieceAt(sh: Shape, t: number, u: number, i = 0, j = 0) {
  // The tears wander, but smoothly: a torn edge, not a sawn one.
  void i;
  void j;
  const ragged = 0.02 * Math.sin(t * 41 + 1.3) + 0.011 * Math.sin(t * 97);
  if (t < splitAt(sh, u)) return 0;
  if (Math.abs(u) < lidHalfAngle(t) + ragged) return 1;
  return u > 0 ? 2 : 3;
}

// Half the angle the face plate (the lid) spans round the ventral midline, by t: wide enough for the thorax to pass.
export const lidHalfAngle = (t: number) => 0.5 + 0.28 * smooth(0.78, 0.96, t);

// The wall's thickness as a fraction of the length.
export const WALL = 0.0022;

// The hollow inside, at t: the centreline's point and direction, and the clear half-widths from it (scene units, the
// wall already taken off) to the side, toward the ventral side (the lid) and toward the back.
export function cavity(sp: Species, t: number) {
  const sh = shapeOf(sp);
  const L = sp.pupa;
  const { point, direction } = pupaAxis(sp, t);
  const p = scratchC;
  const reach = (u: number) => {
    surface(sh, L, t, u, p);
    return Math.max(0, Math.hypot(p.x, p.y - point.y, p.z - point.z) - WALL * L);
  };
  return { point, direction, side: reach(Math.PI / 2), front: reach(0), back: reach(Math.PI) };
}

export type Probe = { t: number; u: number; d: number; piece: number };

// Where a point (in the chrysalis' own space, the pod's) lies against the closed shell: its t along the centreline, its
// u round it, and d, how far outside the outer surface it is (negative inside; the wall is WALL * length thick, so the
// hollow is d < -WALL * length). Good to about a hundredth of the length; past either end d is the distance to the tip.
export function shellProbe(sp: Species, point: THREE.Vector3, out: Probe = { t: 0, u: 0, d: 0, piece: 0 }) {
  const sh = shapeOf(sp);
  const L = sp.pupa;
  const spine = spineOf(sh);
  // The section whose plane the point lies in: where (p - C) . T changes sign, nearest the point.
  let best = -1;
  let bestD = Infinity;
  let before = 0;
  for (let i = 0; i <= SPINE_N; i += 4) {
    const cy = spine.y[i] * L;
    const cz = spine.z[i] * L;
    const s = -(point.y - cy) * Math.cos(spine.angle[i]) + (point.z - cz) * Math.sin(spine.angle[i]);
    if (i > 0 && before >= 0 && s < 0) {
      const f = before / (before - s);
      const t = (i - 4 + f * 4) / SPINE_N;
      const a = axisAt(sh, t);
      const dist = Math.hypot(point.x, point.y - a.y * L, point.z - a.z * L);
      if (dist < bestD) {
        bestD = dist;
        best = t;
      }
    }
    before = s;
  }
  if (best < 0) {
    // Above the top or below the head.
    const top = Math.hypot(point.x, point.y, point.z);
    const end = Math.hypot(point.x, point.y - spine.y[SPINE_N] * L, point.z - spine.z[SPINE_N] * L);
    out.t = top < end ? 0 : 1;
    out.u = 0;
    out.d = Math.min(top, end);
    out.piece = top < end ? 0 : 1;
    return out;
  }
  const a = axisAt(sh, best);
  const ay = a.y * L;
  const az = a.z * L;
  const sin = Math.sin(a.angle);
  const cos = Math.cos(a.angle);
  const v = (point.y - ay) * sin + (point.z - az) * cos;
  const u = Math.atan2(point.x / sh.side, v);
  surfaceFast(sh, L, best, u, scratchB);
  const sv = (scratchB.y - ay) * sin + (scratchB.z - az) * cos;
  out.t = best;
  out.u = u;
  out.d = Math.hypot(point.x / sh.side, v) - Math.hypot(scratchB.x / sh.side, sv);
  out.piece = pieceAt(sh, best, u);
  return out;
}

// The same against the pieces as they are now posed (pivots as usePupa gives them, each carrying its own rotation):
// the wall nearest the point among the pieces actually there. `piece` is -1 if the point faces only gaps (it is in the
// opening, or clear of the shell altogether); then d is not meaningful.
export function pieceProbe(sp: Species, point: THREE.Vector3, pivots: THREE.Object3D[], out: Probe = { t: 0, u: 0, d: 0, piece: -1 }) {
  let found = false;
  const probe = scratchProbe;
  for (let k = 0; k < 4; k++) {
    unposePoint(sp, pivots, k, point, scratchP);
    shellProbe(sp, scratchP, probe);
    if (probe.piece !== k || probe.t <= 0 || probe.t >= 1) continue;
    if (!found || Math.abs(probe.d) < Math.abs(out.d)) {
      out.t = probe.t;
      out.u = probe.u;
      out.d = probe.d;
      out.piece = k;
      found = true;
    }
  }
  if (!found) out.piece = -1;
  return out;
}
const scratchProbe: Probe = { t: 0, u: 0, d: 0, piece: 0 };
const scratchP = new THREE.Vector3();

// The rim of the opening as the pieces are now posed, in the pod's space: n points down each side piece's ventral edge
// (where the lid tore away), right side then left, from the split to the head; and n round the abdomen's lower edge,
// which never moves.
export function rimPoints(sp: Species, pivots: THREE.Object3D[], n = 12) {
  const sh = shapeOf(sp);
  const sides: THREE.Vector3[][] = [[], []];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) {
      const t = sh.split + 0.03 + ((1 - sh.split - 0.04) * i) / (n - 1);
      const u = (k === 0 ? 1 : -1) * (lidHalfAngle(t) + 0.04);
      const p = new THREE.Vector3();
      surfaceFast(sh, sp.pupa, t, u, p);
      sides[k].push(posePoint(sp, pivots, t, u, p));
    }
  }
  const abdomen: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector3();
    const u = -Math.PI + (i / n) * Math.PI * 2;
    surfaceFast(sh, sp.pupa, splitAt(sh, u), u, p);
    abdomen.push(p);
  }
  return { right: sides[0], left: sides[1], abdomen };
}

// The length of the stalk above the body, to the silk pad.
export const STALK = 0.035;

// The chrysalis' four pieces, each a paper-thin shell with an inside and edges where it breaks. Triangles are ordered
// inside first, then edges, then outside, so that once the shell is see-through the far wall is drawn before the near.
export function buildPupa(sp: Species, fine = 1) {
  const sh = shapeOf(sp);
  const L = sp.pupa;
  const T = Math.round(190 * fine);
  const U = Math.round(152 * fine);
  const thick = WALL * L;
  const P: THREE.Vector3[] = [];
  const G: number[] = [];
  const I: number[] = [];
  const R: number[] = [];
  const A: number[] = [];
  const tu: number[] = [];
  for (let i = 0; i <= T; i++) {
    const t = i / T;
    for (let j = 0; j <= U; j++) {
      const u = -Math.PI + (j / U) * Math.PI * 2;
      const p = new THREE.Vector3();
      const s = surface(sh, L, t, u, p);
      G.push(s.groove);
      I.push(s.inside);
      R.push(s.radius);
      A.push(0, s.ay, s.az);
      P.push(p);
      tu.push(t, u);
    }
  }
  const at = (i: number, j: number) => i * (U + 1) + j;
  const N: THREE.Vector3[] = P.map(() => new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const radial = new THREE.Vector3();
  for (let i = 0; i <= T; i++) {
    const ax = axisAt(sh, i / T);
    const along = new THREE.Vector3(0, -Math.cos(ax.angle), Math.sin(ax.angle));
    for (let j = 0; j <= U; j++) {
      const n = N[at(i, j)];
      if (i === 0 || i === T) {
        n.copy(along).multiplyScalar(i === 0 ? -1 : 1);
        continue;
      }
      const jl = j === 0 ? U - 1 : j - 1;
      const jr = j === U ? 1 : j + 1;
      a.subVectors(P[at(i + 1, j)], P[at(i - 1, j)]);
      b.subVectors(P[at(i, jr)], P[at(i, jl)]);
      n.crossVectors(b, a);
      const g = at(i, j);
      radial.set(P[g].x, P[g].y - A[g * 3 + 1], P[g].z - A[g * 3 + 2]);
      if (n.lengthSq() < 1e-20) n.copy(radial.lengthSq() > 1e-12 ? radial : along);
      n.normalize();
      if (n.dot(radial) < 0 && radial.lengthSq() > 1e-12) n.negate();
    }
  }
  // The hinge under each column.
  const HP: THREE.Vector3[] = [];
  const HA: THREE.Vector3[] = [];
  for (let j = 0; j <= U; j++) {
    HP.push(new THREE.Vector3());
    HA.push(new THREE.Vector3());
    hingeAt(sh, L, -Math.PI + (j / U) * Math.PI * 2, HP[j], HA[j]);
  }
  // Which pieces each cell belongs to, as a set of bits: every piece that owns any corner of it. Along a tear the
  // cells are made twice, once for each side, and each side is cut back to the true line of the tear in the shader
  // (pupa.tsx, the same formula as pieceAt), so a torn edge is a clean curve and never a staircase of cells.
  const owner: number[] = [];
  for (let i = 0; i <= T; i++) for (let j = 0; j <= U; j++) owner.push(pieceAt(sh, i / T, -Math.PI + (j / U) * Math.PI * 2));
  const piece: number[] = [];
  for (let i = 0; i < T; i++)
    for (let j = 0; j < U; j++) {
      let bits = 1 << pieceAt(sh, (i + 0.5) / T, -Math.PI + ((j + 0.5) / U) * Math.PI * 2);
      for (const g of [at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1)]) bits |= 1 << owner[g];
      piece.push(bits);
    }
  const pleatOf = (t: number) => sh.grooves.reduce((s, g) => s + smooth(g - 0.008, g + 0.008, t), 0);
  // The hinges: the face plate's top edge, the sides' top edges.
  const pivots = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  surface(sh, L, sh.split + 0.02, 0, pivots[1]);
  surface(sh, L, sh.split, Math.PI / 2, pivots[2]);
  surface(sh, L, sh.split, -Math.PI / 2, pivots[3]);
  const pieces: Piece[] = [];
  for (let p = 0; p < 4; p++) {
    const pos: number[] = [];
    const nor: number[] = [];
    const rest: number[] = [];
    const axis: number[] = [];
    const ttu: number[] = [];
    const surf: number[] = [];
    const hinge: number[] = [];
    const hingeAxis: number[] = [];
    const inside: number[] = [];
    const edge: number[] = [];
    const outside: number[] = [];
    const outer = new Map<number, number>();
    const inner = new Map<number, number>();
    // Baked in the chrysalis' own space: the pivot is only the scene's handle.
    const pivot = ZERO;
    const vert = (g: number, isInner: boolean, k = isInner ? 1 : 0, normal?: THREE.Vector3) => {
      const v = P[g];
      const n = normal ?? N[g];
      const s = isInner ? -thick : 0;
      pos.push(v.x + N[g].x * s - pivot.x, v.y + N[g].y * s - pivot.y, v.z + N[g].z * s - pivot.z);
      const sign = isInner && !normal ? -1 : 1;
      nor.push(n.x * sign, n.y * sign, n.z * sign);
      rest.push(v.x, v.y, v.z);
      // Packed four to an attribute: a pipeline takes eight vertex buffers and no more.
      axis.push(A[g * 3 + 1], A[g * 3 + 2], bendWeight(sh, tu[g * 2], tu[g * 2 + 1], p), creaseAt(sh, tu[g * 2], tu[g * 2 + 1]));
      ttu.push(tu[g * 2], tu[g * 2 + 1], k, p + 0.9 * partWeight(sh, tu[g * 2], tu[g * 2 + 1], p));
      surf.push(G[g], I[g], pleatOf(tu[g * 2]), R[g]);
      // The hinge it bends about, in the piece's own space, and how much of the piece's angle it takes.
      const column = g % (U + 1);
      hinge.push(HP[column].x, HP[column].y, HP[column].z);
      if (p === 1) hingeAxis.push(-1, 0, 0);
      else hingeAxis.push(HA[column].x, HA[column].y, HA[column].z);
      return pos.length / 3 - 1;
    };
    const get = (g: number, isInner: boolean) => {
      const m = isInner ? inner : outer;
      let v = m.get(g);
      if (v === undefined) {
        v = vert(g, isInner);
        m.set(g, v);
      }
      return v;
    };
    for (let i = 0; i < T; i++)
      for (let j = 0; j < U; j++) {
        if (!(piece[i * U + j] & (1 << p))) continue;
        const g00 = at(i, j);
        const g01 = at(i, j + 1);
        const g10 = at(i + 1, j);
        const g11 = at(i + 1, j + 1);
        const o = [get(g00, false), get(g01, false), get(g10, false), get(g11, false)];
        outside.push(o[0], o[2], o[1], o[1], o[2], o[3]);
        const n = [get(g00, true), get(g01, true), get(g10, true), get(g11, true)];
        inside.push(n[0], n[1], n[2], n[1], n[3], n[2]);
        // Edges where a neighbour belongs to another piece.
        const edges: [number, number, number, number][] = [
          [i - 1, j, g00, g01],
          [i + 1, j, g10, g11],
          [i, j - 1, g00, g10],
          [i, j + 1, g01, g11]
        ];
        for (const [ni, nj0, ga, gb] of edges) {
          if (ni < 0 || ni >= T) continue;
          const nj = (nj0 + U) % U;
          if (piece[ni * U + nj] & (1 << p)) continue;
          // Facing out of the cell, across the break.
          const mid = new THREE.Vector3().addVectors(P[ga], P[gb]).multiplyScalar(0.5);
          const centre = new THREE.Vector3().add(P[g00]).add(P[g01]).add(P[g10]).add(P[g11]).multiplyScalar(0.25);
          const out = mid.sub(centre);
          if (out.lengthSq() < 1e-20) continue;
          out.normalize();
          const r0 = vert(ga, false, 0.5, out);
          const r1 = vert(gb, false, 0.5, out);
          const r2 = vert(ga, true, 0.5, out);
          const r3 = vert(gb, true, 0.5, out);
          const e1 = new THREE.Vector3().subVectors(P[gb], P[ga]);
          const e2 = new THREE.Vector3().copy(N[ga]).negate();
          const face = new THREE.Vector3().crossVectors(e1, e2);
          if (face.dot(out) > 0) edge.push(r0, r2, r1, r1, r2, r3);
          else edge.push(r0, r1, r2, r1, r3, r2);
        }
      }
    if (p === 0) {
      // The cremaster: a short stalk from the top of the abdomen to the hooks set in the silk, a little knobbly, flaring
      // into the body below and into a button of hooks above.
      const rings: [number, number][] = [
        [-0.012 * L, 0.03 * L],
        [0.003, 0.0125],
        [STALK * 0.3, 0.0088],
        [STALK * 0.62, 0.0072],
        [STALK * 0.86, 0.0086],
        [STALK * 0.97, 0.0125],
        [STALK * 1.04, 0.0105],
        [STALK * 1.08, 0.0]
      ];
      const sides = 14;
      const first = pos.length / 3;
      for (let i = 0; i < rings.length; i++)
        for (let j = 0; j <= sides; j++) {
          const ang = (j / sides) * Math.PI * 2;
          const [y, r0] = rings[i];
          const r = r0 * (1 + 0.12 * Math.sin(ang * 3 + i * 1.7));
          const before = rings[Math.max(0, i - 1)];
          const after = rings[Math.min(rings.length - 1, i + 1)];
          const slope = (after[1] - before[1]) / (after[0] - before[0] || 1);
          const n = new THREE.Vector3(Math.sin(ang), -slope, Math.cos(ang)).normalize();
          pos.push(Math.sin(ang) * r, y, Math.cos(ang) * r);
          nor.push(n.x, n.y, n.z);
          rest.push(Math.sin(ang) * r, y, Math.cos(ang) * r);
          axis.push(y, 0, 0, 0);
          ttu.push(-Math.max(0.001, y / STALK), ang - Math.PI, 2, 0);
          surf.push(0, -1, 0, 0.01);
          hinge.push(0, 0, 0);
          hingeAxis.push(1, 0, 0);
        }
      for (let i = 0; i < rings.length - 1; i++)
        for (let j = 0; j < sides; j++) {
          const v0 = first + i * (sides + 1) + j;
          const v1 = v0 + sides + 1;
          outside.push(v0, v0 + 1, v1, v0 + 1, v1 + 1, v1);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geometry.setAttribute("aRest", new THREE.Float32BufferAttribute(rest, 3));
    geometry.setAttribute("aHinge", new THREE.Float32BufferAttribute(hinge, 3));
    geometry.setAttribute("aHingeAxis", new THREE.Float32BufferAttribute(hingeAxis, 3));
    // aAxis: the centreline's (y, z), then the share of the piece's angle and the creasing. aTU: t, u, kind, and the
    // piece with, as its fraction, nine tenths of the share it is carried round by.
    geometry.setAttribute("aAxis", new THREE.Float32BufferAttribute(axis, 4));
    geometry.setAttribute("aTU", new THREE.Float32BufferAttribute(ttu, 4));
    geometry.setAttribute("aSurf", new THREE.Float32BufferAttribute(surf, 4));
    geometry.setIndex([...inside, ...edge, ...outside]);
    geometry.computeBoundingSphere();
    pieces.push({ geometry, pivot: pivots[p].clone() });
  }
  return pieces;
}

// A point on the outside of the chrysalis, for taps and feet, and optionally the way out from it.
export function pupaPoint(sp: Species, t: number, u: number, out = new THREE.Vector3(), normal?: THREE.Vector3) {
  const sh = shapeOf(sp);
  surfaceFast(sh, sp.pupa, t, u, out);
  if (normal) {
    const e = 0.006;
    const a = scratchA;
    surfaceFast(sh, sp.pupa, Math.min(0.999, t + e), u, a);
    surfaceFast(sh, sp.pupa, Math.max(0.001, t - e), u, scratchB);
    a.sub(scratchB);
    surfaceFast(sh, sp.pupa, t, u + 0.02, scratchB);
    surfaceFast(sh, sp.pupa, t, u - 0.02, scratchC);
    scratchB.sub(scratchC);
    normal.crossVectors(scratchB, a);
    const ax = axisAt(sh, t);
    scratchC.set(out.x, out.y - ax.y * sp.pupa, out.z - ax.z * sp.pupa);
    if (normal.lengthSq() < 1e-20) normal.copy(scratchC);
    normal.normalize();
    if (normal.dot(scratchC) < 0) normal.negate();
  }
  return out;
}
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();

// The affine from forewing space to the chrysalis' (t, |u|), inverted, for the wing pattern on the case.
export function caseMap(apex: [number, number]) {
  // Wing points: root (0,0), apex, tornus.
  const W = [
    [0, 0],
    [apex[0], apex[1]],
    [apex[0] * 0.92, -0.02]
  ];
  const C = [CASE.root, CASE.apex, CASE.tornus];
  // Solve (t, au) -> (x, y) directly: x = a t + b au + c.
  const M = new THREE.Matrix3().set(C[0][0], C[0][1], 1, C[1][0], C[1][1], 1, C[2][0], C[2][1], 1).invert();
  const solve = (k: number) => new THREE.Vector3(W[0][k], W[1][k], W[2][k]).applyMatrix3(M);
  return { x: solve(0), y: solve(1) };
}

// The markings, painted once into one texture, a row to a species: u across (wrapping at the back), t down.
// R metal (gold, silver), G black pigment, B height (beads stand proud), A pale marks.
export const MARK_W = 1024;
export const MARK_H = 512;

export function markTexture() {
  const W = MARK_W;
  const H = MARK_H;
  const data = new Uint8Array(W * H * 4 * 4);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // An oval mark at (t, u), rt long and ru (radians) wide, turned, with a wobbly outline.
  const stamp = (tile: number, t: number, u: number, rt: number, ru: number, channels: number[], strength = 1, opts: { turn?: number; wobble?: number; soft?: number; dome?: boolean } = {}) => {
    // Marks are painted as soft cones half again as wide as the mark, and cut at half height in the shader, so that
    // their outlines stay crisp and round however close the eye comes. A fainter mark is a smaller one.
    const { turn = 0, wobble = 0, dome = false } = opts;
    const cx = (u / (Math.PI * 2) + 0.5) * W;
    const cy = t * H;
    const grow = dome ? 1 : 1.6 * Math.sqrt(strength);
    const rx = Math.max(dome ? 1 : 2.4, (ru / (Math.PI * 2)) * W * grow);
    const ry = Math.max(dome ? 1 : 2.4, rt * H * grow);
    const reach = Math.ceil(Math.max(rx, ry) * 1.3) + 1;
    const phase = random() * 6.28;
    const lobes = 2 + Math.floor(random() * 3);
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(H - 1, Math.ceil(cy + reach)); y++)
      for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const ex = (dx * c + dy * s) / rx;
        const ey = (-dx * s + dy * c) / ry;
        let rr = Math.hypot(ex, ey);
        if (wobble) rr /= 1 + wobble * Math.sin(lobes * Math.atan2(ey, ex) + phase);
        if (rr >= 1) continue;
        const v = dome ? Math.sqrt(1 - rr * rr) * strength : 1 - rr;
        const o = ((tile * H + y) * W + (((x % W) + W) % W)) * 4;
        for (const ch of channels) data[o + ch] = Math.max(data[o + ch], Math.round(v * 255));
      }
  };
  const both = (fn: (side: number) => void) => {
    fn(1);
    fn(-1);
  };

  // Blue Morpho: a few cream dots along the edge of the wing case and the back, faint spiracles.
  {
    const sh = SHAPES.morpho;
    both((s) => {
      stamp(0, 0.3, s * 2.05, 0.008, 0.045, [3], 0.9, { wobble: 0.15 });
      stamp(0, 0.43, s * 2.3, 0.007, 0.04, [3], 0.85, { wobble: 0.15 });
      stamp(0, 0.52, s * 2.42, 0.005, 0.03, [3], 0.7, { wobble: 0.15 });
      stamp(0, 0.6, s * 2.9, 0.005, 0.03, [3], 0.5);
      for (let k = 1; k < sh.grooves.length; k++) stamp(0, (sh.grooves[k] + sh.grooves[k - 1]) / 2, s * 1.85, 0.004, 0.024, [3], 0.45);
    });
  }

  // Monarch: the band round the back on its ridge (a black line, a row of raised gold beads over it), and the gold dots.
  {
    const band = SHAPES.monarch.ridge![0];
    const beads = 46;
    for (let k = 0; k < beads; k++) {
      const u = 1.28 + ((k + 0.5) / beads) * (Math.PI * 2 - 2.56);
      const uu = u > Math.PI ? u - Math.PI * 2 : u;
      const size = 0.7 + random() * 0.5;
      // Black underneath, in dashes with small gaps.
      if (random() > 0.12) stamp(1, band + 0.0085 + (random() - 0.5) * 0.002, uu, 0.0052, 0.05 + random() * 0.02, [1], 1, { soft: 0.4 });
      stamp(1, band - 0.0015 + (random() - 0.5) * 0.0015, uu, 0.0058 * size, 0.036 * size, [0], 1, { soft: 0.3 });
      stamp(1, band - 0.0015, uu, 0.0058 * size, 0.036 * size, [2], 1, { dome: true });
    }
    // A fine gold line joining the beads.
    for (let k = 0; k < 400; k++) {
      const u = 1.25 + (k / 400) * (Math.PI * 2 - 2.5);
      stamp(1, band - 0.0015, u > Math.PI ? u - Math.PI * 2 : u, 0.0026, 0.012, [0], 0.9);
    }
    const dots: [number, number, number][] = [
      [0.925, 0.52, 1],
      [0.885, 1.12, 0.8],
      [0.72, 1.45, 0.9],
      [0.6, 2.25, 1],
      [0.56, 2.86, 0.8],
      [0.34, 2.6, 0.6]
    ];
    both((s) => {
      for (const [t, u, k] of dots) {
        stamp(1, t, s * u, 0.0085 * k, 0.045 * k, [0], 1, { soft: 0.25, wobble: 0.08 });
        stamp(1, t, s * u, 0.0085 * k, 0.045 * k, [2], 0.8, { dome: true });
      }
      // Black flecks at the very top, round the stalk.
      stamp(1, 0.022, s * 2.4, 0.007, 0.25, [1], 0.9, { wobble: 0.2 });
      stamp(1, 0.03, s * 0.9, 0.005, 0.2, [1], 0.8, { wobble: 0.2 });
    });
  }

  // Glasswing: mirror bars side by side on the hump of the back, a long mirror stripe down each side along the wing
  // case, a few small mirror spots, fine dark dots and a dark line under the stripe.
  {
    both((s) => {
      const bars: [number, number, number, number][] = [
        [0.2, 0.37, 0.15, 0.03],
        [0.19, 0.4, 0.5, 0.034],
        [0.2, 0.42, 0.86, 0.034],
        [0.23, 0.42, 1.2, 0.028]
      ];
      for (const [t0, t1, off, width] of bars)
        for (let k = 0; k <= 60; k++) {
          const f = k / 60;
          const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, f * 0.9 + 0.05))) ** 0.5;
          stamp(2, t0 + (t1 - t0) * f, s * (Math.PI - off), 0.006, width * taper, [0], 1, { soft: 0.25 });
        }
      for (let k = 0; k <= 160; k++) {
        const f = k / 160;
        const t = 0.47 + f * 0.43;
        const u = 1.72 - f * 0.55 + Math.sin(f * Math.PI) * 0.1;
        const taper = Math.sin(Math.PI * Math.min(1, f * 0.94 + 0.03)) ** 0.4;
        stamp(2, t, s * u, 0.0075 * taper, 0.03 * taper, [0], 1, { soft: 0.2 });
        stamp(2, t + 0.012, s * (u - 0.28), 0.0028, 0.012, [1], 0.75 * taper);
      }
      stamp(2, 0.93, s * 0.62, 0.012, 0.09, [0], 1, { soft: 0.25, wobble: 0.1 });
      stamp(2, 0.66, s * 2.5, 0.008, 0.04, [0], 1, { soft: 0.25 });
      stamp(2, 0.56, s * 2.8, 0.007, 0.035, [0], 0.9, { soft: 0.25 });
      stamp(2, 0.975, s * 1.5, 0.012, 0.3, [0], 0.9, { soft: 0.3 });
      for (const [t, u] of [
        [0.52, 1.95],
        [0.6, 1.2],
        [0.75, 0.95],
        [0.44, 2.6],
        [0.82, 1.7]
      ])
        stamp(2, t, s * u, 0.0045, 0.022, [1], 0.95, { wobble: 0.2 });
    });
    // A dark tip to the head.
    for (let k = 0; k < 12; k++) stamp(2, 0.996, -Math.PI + (k / 12) * Math.PI * 2, 0.004, 0.5, [1], 0.5);
  }

  // Paper Kite: black spots in rows round every abdominal segment, no two alike; small ones scattered along the veins
  // of the wing case; bold marks on the head.
  {
    const sh = SHAPES.paperkite;
    const g = [0.02, ...sh.grooves, 0.66];
    for (let k = 0; k < g.length - 1; k++) {
      const t0 = g[k];
      const t1 = g[k + 1];
      for (let row = 0; row < 2; row++) {
        const count = 11 + Math.floor(random() * 5);
        const start = random() * 6.28;
        for (let n = 0; n < count; n++) {
          const u = -Math.PI + ((start + (n / count) * Math.PI * 2 + (random() - 0.5) * 0.3) % (Math.PI * 2));
          const t = t0 + (t1 - t0) * (0.28 + row * 0.44 + (random() - 0.5) * 0.2);
          const inside = caseInside(t, Math.abs(u));
          if (inside > -0.004 || t < 0.03 || (Math.abs(u) < 0.5 && t > 0.44)) continue;
          if (random() < 0.12) continue;
          const size = (0.6 + random() ** 2 * 1.0) * (t < 0.1 ? 0.6 : 1);
          stamp(3, t, u, 0.0105 * size, 0.062 * size * (0.8 + random() * 0.6), [1], 1, { turn: (random() - 0.5) * 1.2, wobble: 0.1 + random() * 0.22, soft: 0.22 });
        }
      }
    }
    both((s) => {
      // On the wing case: small, sparse, strung along the veins and the edge.
      for (let n = 0; n < 30; n++) {
        const f = random();
        const t = 0.47 + f * 0.36;
        const u = 0.45 + random() * 1.5;
        if (caseInside(t, u) < 0.004) continue;
        const size = 0.35 + random() * 0.6;
        stamp(3, t, s * u, 0.011 * size, 0.045 * size, [1], 1, { turn: random() * 3, wobble: 0.25, soft: 0.25 });
      }
      // The head: eyes as bold commas, marks round the knob.
      stamp(3, 0.9, s * 0.75, 0.022, 0.16, [1], 1, { turn: s * 0.6, wobble: 0.25, soft: 0.2 });
      stamp(3, 0.955, s * 0.4, 0.012, 0.2, [1], 1, { wobble: 0.2, soft: 0.2 });
      stamp(3, 0.86, s * 1.7, 0.012, 0.09, [1], 1, { wobble: 0.25, soft: 0.2 });
      stamp(3, 0.9, s * 2.5, 0.014, 0.12, [1], 1, { wobble: 0.25, soft: 0.2 });
      stamp(3, 0.83, s * 2.75, 0.009, 0.07, [1], 1, { wobble: 0.2, soft: 0.2 });
      stamp(3, 0.72, s * 2.2, 0.008, 0.05, [1], 1, { wobble: 0.2, soft: 0.2 });
      stamp(3, 0.7, s * 2.85, 0.01, 0.06, [1], 1, { wobble: 0.2, soft: 0.2 });
    });
  }

  const texture = new THREE.DataTexture(data, W, H * 4, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// Where dew sits on a chrysalis: many small beads and a few big, more of them low down, and one drop hanging from the
// very tip. Each as (t, u, radius in scene units).
export function dewPoints(sp: Species, count: number) {
  let seed = 31 + Math.round(sp.pupa * 1000);
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out: [number, number, number][] = [];
  for (let n = 0; n < count; n++) {
    const t = 0.04 + 0.94 * random() ** 0.8;
    const u = (random() - 0.5) * Math.PI * 2;
    const r = (0.003 + 0.012 * random() ** 4) * (sp.pupa / 0.6) ** 0.5;
    out.push([t, u, r]);
  }
  return out;
}
