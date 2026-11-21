import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BOLT, type Body } from "./physics";

// Every part is built here once, at load: the bolt with a true helical thread, and three things that screw onto it.
// Each thing also carries its moments of inertia, measured from the same solid it is drawn from, which is all the
// tumbling depends on.

const TAU = Math.PI * 2;

// The ISO thread's height across one pitch, 1 at the crest and 0 at the root: a flat crest an eighth of the pitch wide,
// a root a quarter wide and straight 60° flanks, the corners a little rounded as a rolled thread's are.
function threadHeight(u: number) {
  const w = Math.abs(u - Math.round(u));
  const f = THREE.MathUtils.clamp((0.375 - w) / (0.375 - 0.0625), 0, 1);
  return THREE.MathUtils.lerp(f, f * f * (3 - 2 * f), 0.4);
}

// How far round a turn the thread is at a point: the same everywhere along the helix x = (u + φ/2π) p.
const threadPhase = (x: number, phi: number) => x / BOLT.pitch - phi / TAU;

// A surface of revolution whose radius F(x, φ) may change around as well as along, laid on a grid that follows the
// helix (each row is one line of the thread), so the thread's corners fall on rows and nothing aliases. Normals come
// from F's own slope, so there is no seam where the turn closes. `inward` faces it into the axis, for a nut's bore.
function helicalSurface(F: (x: number, phi: number) => number, x0: number, x1: number, perTurn: number, around: number, inward = false) {
  const p = BOLT.pitch;
  const t0 = Math.floor(x0 / p) - 1;
  const t1 = Math.ceil(x1 / p);
  const rows = (t1 - t0) * perTurn + 1;
  const cols = around + 1;
  const position = new Float32Array(rows * cols * 3);
  const normal = new Float32Array(rows * cols * 3);
  const h = 1e-4;
  for (let i = 0; i < rows; i++) {
    const t = t0 + i / perTurn;
    for (let j = 0; j < cols; j++) {
      const phi = (j / around) * TAU;
      const x = THREE.MathUtils.clamp((t + phi / TAU) * p, x0, x1);
      const r = F(x, phi);
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const k = (i * cols + j) * 3;
      position[k] = x;
      position[k + 1] = r * c;
      position[k + 2] = r * s;
      // The surface is |(y, z)| = F: its gradient is the radial direction, less F's slope round and along.
      const dx = (F(x + h, phi) - F(x - h, phi)) / (2 * h);
      const dphi = (F(x, phi + h) - F(x, phi - h)) / (2 * h) / Math.max(r, 1e-3);
      let nx = -dx;
      let ny = c + dphi * s;
      let nz = s - dphi * c;
      const len = Math.hypot(nx, ny, nz) || 1;
      const sign = inward ? -1 : 1;
      nx = (nx / len) * sign;
      ny = (ny / len) * sign;
      nz = (nz / len) * sign;
      normal[k] = nx;
      normal[k + 1] = ny;
      normal[k + 2] = nz;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (inward) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setIndex(index);
  return g;
}

// A plain lathe about x, from a profile of (x, r) points, sharp where the profile turns by more than 35° and smooth
// elsewhere.
function lathe(profile: [number, number][], around: number) {
  // Split at sharp corners, so each run gets its own normals.
  const runs: [number, number][][] = [[profile[0]]];
  for (let i = 1; i < profile.length; i++) {
    runs[runs.length - 1].push(profile[i]);
    if (i < profile.length - 1) {
      const a = [profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]];
      const b = [profile[i + 1][0] - profile[i][0], profile[i + 1][1] - profile[i][1]];
      const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]) || 1);
      if (cos < Math.cos((35 * Math.PI) / 180)) runs.push([profile[i]]);
    }
  }
  const parts = runs.map((run) => {
    const n = run.length;
    const position: number[] = [];
    const normal: number[] = [];
    const index: number[] = [];
    // The profile's normal at each point: its direction turned a quarter, (dx, dr) → (−dr, dx) in (x, r).
    const tangent = run.map((_, i) => {
      const a = run[Math.max(0, i - 1)];
      const b = run[Math.min(n - 1, i + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    });
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= around; j++) {
        const phi = (j / around) * TAU;
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        position.push(run[i][0], run[i][1] * c, run[i][1] * s);
        const nx = -tangent[i][1];
        const nr = tangent[i][0];
        normal.push(nx, nr * c, nr * s);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < around; j++) {
        const a = i * (around + 1) + j;
        const b = a + 1;
        const c = a + around + 1;
        const d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    g.setIndex(index);
    return g.toNonIndexed();
  });
  return mergeGeometries(parts);
}

// A hexagon of flat radius a, its corners turned off by cones top and bottom (the arcs on every bolt head and nut),
// as a grid of rings in (x, φ) whose radius is the least of the hexagon and the two cones. From x0 (the face with the
// bigger chamfer) to x1.
function hexRadius(a: number, phi: number) {
  const sector = Math.PI / 3;
  const off = phi - sector * Math.round(phi / sector);
  return a / Math.cos(off);
}
function hexPrism(a: number, x0: number, x1: number, chamfer0: number, chamfer1: number, around: number, rows: number) {
  const dir = Math.sign(x1 - x0);
  // Each chamfer is a cone at 30° to the face, starting at that fraction of the flat radius.
  const F = (x: number, phi: number) => Math.min(hexRadius(a, phi), a * chamfer0 + Math.abs(x - x0) * 1.732, a * chamfer1 + Math.abs(x1 - x) * 1.732);
  // Rows packed toward the faces, where the chamfers' arcs are.
  const xs: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const u = i / rows;
    const e = 0.5 - 0.5 * Math.cos(u * Math.PI);
    xs.push(x0 + (x1 - x0) * THREE.MathUtils.lerp(u, e, 0.55));
  }
  const cols = around + 1;
  const position = new Float32Array(xs.length * cols * 3);
  const normal = new Float32Array(xs.length * cols * 3);
  const h = 1e-4;
  xs.forEach((x, i) => {
    for (let j = 0; j < cols; j++) {
      const phi = (j / around) * TAU;
      const r = F(x, phi);
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const k = (i * cols + j) * 3;
      position.set([x, r * c, r * s], k);
      const dx = (F(x + h, phi) - F(x - h, phi)) / (2 * h);
      const dphi = (F(x, phi + h) - F(x, phi - h)) / (2 * h) / r;
      const n = new THREE.Vector3(-dx, c + dphi * s, s - dphi * c).normalize();
      normal.set([n.x, n.y, n.z], k);
    }
  });
  const index: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < around; j++) {
      const a0 = i * cols + j;
      const b = a0 + 1;
      const c = a0 + cols;
      const d = c + 1;
      if (dir > 0) index.push(a0, b, c, b, d, c);
      else index.push(a0, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setIndex(index);
  return g.toNonIndexed();
}

// A flat ring facing along ±x.
function ring(x: number, inner: number, outer: number, around: number, facing: 1 | -1) {
  const g = new THREE.RingGeometry(inner, outer, around, 1);
  // RingGeometry lies in xy facing +z: turn it to face ±x.
  g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2);
  g.translate(x, 0, 0);
  g.deleteAttribute("uv");
  return g.toNonIndexed();
}

// fill: the spacing of the points that measure each thing's inertia (finer costs more at load).
// Steps round a hexagon: a whole number for each of its six corners to land on one.
const hexAround = (detail: { around: number }) => Math.max(192, Math.round((detail.around * 2) / 12) * 12);

export type Detail = { perTurn: number; around: number; fill: number };

// The bolt: hex head with chamfered corners, a short plain shank with a fillet under the head, and the rolled thread
// running out into it, chamfered at the tip.
export function boltGeometry(detail: Detail) {
  const { radius: R, depth, pitch, headTop, headFace, threadStart, tip } = BOLT;
  const a = 0.3;
  const root = R - depth;
  const thread = (x: number, phi: number) => {
    let r = root + depth * threadHeight(threadPhase(x, phi));
    // The die's lead-in: the thread fades up into the plain shank over a turn and a half.
    const runout = R - THREE.MathUtils.clamp((x - threadStart) / (1.5 * pitch), 0, 1) * depth;
    r = Math.max(r, runout);
    // The fillet under the head.
    const f = THREE.MathUtils.clamp(1 - (x - headFace) / 0.04, 0, 1);
    if (f > 0) r = Math.max(r, R + 0.03 * f * f);
    // The tip's 45° chamfer, down to a little under the root.
    return Math.min(r, root - 0.012 + (tip - x));
  };
  const shaft = helicalSurface(thread, headFace, tip, detail.perTurn, detail.around).toNonIndexed();
  const head = hexPrism(a, headTop, headFace, 0.93, 0.985, hexAround(detail), 44);
  const top = ring(headTop, 0, a * 0.93, 96, -1);
  const under = ring(headFace, R + 0.03, a * 0.985, 96, 1);
  const end = ring(tip, 0, root - 0.012, 64, 1);
  return mergeGeometries([shaft, head, top, under, end]);
}

// What every nut has: a threaded bore from z0 to z1 along its own z. Built about x and turned so x goes to z.
function bore(z0: number, z1: number, detail: Detail) {
  const { radius: R, depth } = BOLT;
  const clearance = 0.006;
  const F = (x: number, phi: number) => R - depth + clearance + depth * threadHeight(threadPhase(x, phi));
  return helicalSurface(F, z0, z1, Math.max(8, Math.round(detail.perTurn * 0.6)), Math.round(detail.around * 0.75), true).toNonIndexed();
}

// x along the bolt → z along the nut, keeping the turn's sense: (x, y, z) → (y, z, x).
const TO_NUT = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));

// The wing nut's ear, in (x out, z up the thread): a rounded lobe rising well above the hub, as on a forged wing nut.
function earShape() {
  const s = new THREE.Shape();
  s.moveTo(0.2, -0.165);
  s.lineTo(0.36, -0.15);
  s.quadraticCurveTo(0.6, -0.1, 0.7, 0.12);
  s.quadraticCurveTo(0.79, 0.34, 0.71, 0.5);
  s.quadraticCurveTo(0.62, 0.64, 0.47, 0.6);
  s.quadraticCurveTo(0.35, 0.56, 0.31, 0.4);
  s.quadraticCurveTo(0.27, 0.24, 0.2, 0.18);
  s.lineTo(0.2, -0.165);
  return s;
}
const EAR_THICK = 0.062;

function ear(side: 1 | -1) {
  const g = new THREE.ExtrudeGeometry(earShape(), { depth: EAR_THICK, bevelEnabled: true, bevelThickness: 0.016, bevelSize: 0.016, bevelSegments: 5, curveSegments: 28 });
  // Shape in xy, thickness along z: centre the thickness, then stand it up so the shape's y runs up the thread (z).
  g.translate(0, 0, -EAR_THICK / 2);
  g.rotateX(Math.PI / 2);
  // Pressed wings are never quite flat: tilt the faces' normals as if each were dished a little about its middle, so
  // they sweep the light across them instead of lighting all at once. The dish's slope is linear in x and z, so it
  // interpolates exactly over the faces' few large triangles.
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  for (let i = 0; i < p.count; i++) {
    const ny = n.getY(i);
    if (Math.abs(ny) < 0.9) continue;
    const dx = (p.getX(i) - 0.48) * 0.9;
    const dz = (p.getZ(i) - 0.22) * 0.9;
    const v = new THREE.Vector3(n.getX(i) - Math.sign(ny) * dx * 0.5, ny, n.getZ(i) - Math.sign(ny) * dz * 0.5).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  if (side < 0) g.rotateZ(Math.PI);
  g.deleteAttribute("uv");
  return g;
}

// Profiles of the nuts' hubs, as (z, r) from bottom to top, the bore's edge first and last.
const WING_HUB: [number, number][] = [
  [-0.17, 0.168],
  [-0.17, 0.355],
  [-0.162, 0.37],
  [-0.15, 0.372],
  [-0.128, 0.36],
  [-0.1, 0.31],
  [-0.06, 0.29],
  [0.06, 0.275],
  [0.14, 0.255],
  [0.17, 0.235],
  [0.17, 0.168]
];

const T_HUB: [number, number][] = [
  [-0.3, 0.168],
  [-0.3, 0.235],
  [-0.29, 0.25],
  [0.1, 0.25],
  [0.13, 0.235],
  [0.2, 0.17],
  [0.27, 0.12],
  [0.3, 0.105],
  [0.3, 0.168]
];

function hub(profile: [number, number][], around: number) {
  return lathe(profile, around).applyMatrix4(TO_NUT);
}

// handles: points on it (in its own frame, centred) that a press near enough takes hold of, so a thin bar or the edge
// of a spinning wing is easy to catch.
export type Thing = { body: Body; parts: { geometry: THREE.BufferGeometry; finish: "main" | "bright" }[]; handles: THREE.Vector3[] };

// The inside of a solid, as a test on a point, for measuring its inertia.
type Inside = (x: number, y: number, z: number) => boolean;

function profileRadius(profile: [number, number][], z: number) {
  // The outer radius at a height, from the profile's outer run (between the first and last points).
  for (let i = 1; i < profile.length - 2; i++) {
    const [z0, r0] = profile[i];
    const [z1, r1] = profile[i + 1];
    if (z >= Math.min(z0, z1) && z <= Math.max(z0, z1) && z1 !== z0) return r0 + ((z - z0) / (z1 - z0)) * (r1 - r0);
  }
  return 0;
}

function inPolygon(points: THREE.Vector2[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Moments of inertia about the centre of mass, by filling the solid's box with a fine grid of points; and the centre's
// height up the thread. Overlapping parts count once, as they are one piece of metal.
function measure(inside: Inside, box: [number, number, number, number, number, number], step: number) {
  let m = 0;
  let sz = 0;
  let xx = 0;
  let yy = 0;
  let zz = 0;
  for (let x = box[0] + step / 2; x < box[1]; x += step) {
    for (let y = box[2] + step / 2; y < box[3]; y += step) {
      for (let z = box[4] + step / 2; z < box[5]; z += step) {
        if (!inside(x, y, z)) continue;
        m++;
        sz += z;
        xx += x * x;
        yy += y * y;
        zz += z * z;
      }
    }
  }
  const zc = sz / m;
  // About the centre: z² less the shift (parallel axes).
  const zzc = zz / m - zc * zc;
  const inertia = new THREE.Vector3(yy / m + zzc, xx / m + zzc, xx / m + yy / m);
  return { zc, inertia };
}

function finish(parts: { geometry: THREE.BufferGeometry; finish: "main" | "bright" }[], measured: { zc: number; inertia: THREE.Vector3 }, lo: number, hi: number, handles: [number, number, number][]): Thing {
  let reach = 0;
  const v = new THREE.Vector3();
  for (const part of parts) {
    part.geometry.translate(0, 0, -measured.zc);
    const p = part.geometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) reach = Math.max(reach, v.fromBufferAttribute(p, i).length());
    part.geometry.computeBoundingSphere();
  }
  return { body: { inertia: measured.inertia, hubLo: lo - measured.zc, hubHi: hi - measured.zc, reach }, parts, handles: handles.map(([x, y, z]) => new THREE.Vector3(x, y, z - measured.zc)) };
}

export function wingNut(detail: Detail): Thing {
  const points = earShape().getPoints(24);
  const inside: Inside = (x, y, z) => {
    const r = Math.hypot(x, y);
    if (z >= -0.17 && z <= 0.17 && r >= 0.185 && r <= profileRadius(WING_HUB, z)) return true;
    return Math.abs(y) <= EAR_THICK / 2 + 0.012 && inPolygon(points, Math.abs(x), z);
  };
  const measured = measure(inside, [-0.82, 0.82, -0.4, 0.4, -0.2, 0.68], detail.fill);
  const geometry = mergeGeometries([hub(WING_HUB, Math.round(detail.around * 0.75)), ear(1), ear(-1), boreAt(-0.17, 0.17, detail, measured.zc)]);
  return finish([{ geometry, finish: "main" }], measured, -0.17, 0.17, [
    [0.5, 0, 0.2],
    [-0.5, 0, 0.2],
    [0.62, 0, 0.42],
    [-0.62, 0, 0.42],
    [0.35, 0, -0.05],
    [-0.35, 0, -0.05]
  ]);
}

// The bore, threaded in phase with the bolt for a nut whose centre of mass is zc up its axis.
function boreAt(lo: number, hi: number, detail: Detail, zc: number) {
  // In the bolt's frame the nut's z maps to x = s + (z − zc), with s a whole number of turns' travel at θ = 0: so the
  // bore is cut along x from lo − zc to hi − zc, then carried to the nut's z and lifted by zc (the whole nut is then
  // lowered by zc to centre it).
  return bore(lo - zc, hi - zc, detail)
    .applyMatrix4(TO_NUT)
    .translate(0, 0, zc);
}

// A T-handle: a knurled barrel with a domed boss and a polished cross bar with ball ends, the bar long enough that
// the thread's axis is again the middle one of the three.
export function tHandle(detail: Detail): Thing {
  const BAR = { z: 0.33, r: 0.062, half: 0.86, ball: 0.092 };
  const inside: Inside = (x, y, z) => {
    const r = Math.hypot(x, y);
    if (z >= -0.3 && z <= 0.3 && r >= 0.185 && r <= profileRadius(T_HUB, z)) return true;
    if (z >= 0.1 && z <= 0.3 && r <= profileRadius(T_HUB, z)) return true;
    const ax = Math.abs(x);
    if (ax <= BAR.half && Math.hypot(y, z - BAR.z) <= BAR.r) return true;
    return Math.hypot(ax - BAR.half, y, z - BAR.z) <= BAR.ball;
  };
  const measured = measure(inside, [-1, 1, -0.4, 0.4, -0.32, 0.45], detail.fill);
  const bar = new THREE.CylinderGeometry(BAR.r, BAR.r, BAR.half * 2, Math.round(detail.around * 0.4), 1, true);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, 0, BAR.z);
  bar.deleteAttribute("uv");
  const balls = [-1, 1].map((side) => {
    const b = new THREE.SphereGeometry(BAR.ball, Math.round(detail.around * 0.4), Math.round(detail.around * 0.2));
    b.translate(side * BAR.half, 0, BAR.z);
    b.deleteAttribute("uv");
    return b.toNonIndexed();
  });
  const body = mergeGeometries([hub(T_HUB, Math.round(detail.around * 0.75)), boreAt(-0.3, 0.1, detail, measured.zc)]);
  const shine = mergeGeometries([bar.toNonIndexed(), ...balls]);
  return finish(
    [
      { geometry: body, finish: "main" },
      { geometry: shine, finish: "bright" }
    ],
    measured,
    -0.3,
    0.1,
    [-0.86, -0.55, -0.25, 0.25, 0.55, 0.86].map((x) => [x, 0, BAR.z] as [number, number, number])
  );
}

// A plain hex nut: spun about its thread it turns about its largest axis, so it only wobbles. The control.
export function hexNut(detail: Detail): Thing {
  const a = 0.3;
  const half = 0.16;
  const inside: Inside = (x, y, z) => {
    if (Math.abs(z) > half) return false;
    const r = Math.hypot(x, y);
    if (r < 0.185) return false;
    const phi = Math.atan2(y, x);
    return r <= Math.min(hexRadius(a, phi), a * 0.93 + (half - Math.abs(z)) * 1.732);
  };
  const measured = measure(inside, [-0.36, 0.36, -0.36, 0.36, -0.17, 0.17], detail.fill * 0.75);
  const sides = hexPrism(a, -half, half, 0.93, 0.93, hexAround(detail), 28).applyMatrix4(TO_NUT);
  const faces = [ring(-half, 0.168, a * 0.93, 96, -1), ring(half, 0.168, a * 0.93, 96, 1)].map((g) => g.applyMatrix4(TO_NUT));
  const geometry = mergeGeometries([sides, ...faces, boreAt(-half, half, detail, measured.zc)]);
  return finish([{ geometry, finish: "main" }], measured, -half, half, [
    [0, 0, 0],
    [0.25, 0, 0],
    [-0.25, 0, 0],
    [0, 0.25, 0],
    [0, -0.25, 0]
  ]);
}

