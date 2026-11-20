import * as THREE from "three/webgpu";
import { shellSurface } from "./pupa";
import { pieceAt, shapeOf } from "./shell-shape";
import type { Species } from "./species";

// Whether anything of the butterfly is in the wall of its chrysalis: a test on the CPU against the shell as it is drawn.
// The shell is sampled all over, each piece where the opening has carried it (SHELL's own forward rule, so nothing is
// guessed backwards), and kept in a grid of cells; a point is then measured against the nearest sample of wall: how
// far off its surface it stands, inside or outside, or nothing if no wall is near (the opening). A sample of the
// butterfly within its own thickness of the wall, or two joined samples on opposite sides of it, is a clash.

// Half the wall and a hair of clearance, as a fraction of the chrysalis' length.
const WALL = 0.0035;
const ROWS = 76;
const ROUND = 128;
const CELL = 0.02;

export type Where = { piece: number; t: number; u: number; depth: number };

type Cloud = { key: string; at: Float32Array; out: Float32Array; piece: Uint8Array; t: Float32Array; u: Float32Array; cells: Map<number, number[]>; reach: number; row: number; widest: number };
let cloud: Cloud | null = null;
// One being made a few rows a frame ahead of need (prepareWall), set in place of `cloud` once whole.
let pending: Cloud | null = null;
const cellOf = (x: number, y: number, z: number) => (Math.floor(x / CELL) + 512) * 1048576 + (Math.floor(y / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512);
const keyOf = (sp: Species, pivots: THREE.Object3D[]) => `${sp.label}:${pivots[1].rotation.x.toFixed(4)}:${pivots[2].rotation.z.toFixed(4)}:${pivots[3].rotation.z.toFixed(4)}`;
function begin(key: string): Cloud {
  const n = ROWS * ROUND;
  return { key, at: new Float32Array(n * 3), out: new Float32Array(n * 3), piece: new Uint8Array(n), t: new Float32Array(n), u: new Float32Array(n), cells: new Map(), reach: 0, row: 0, widest: 0 };
}
// Its rows up to `upTo`, in order; then, once all are in, which piece each sample is of.
function fill(made: Cloud, sp: Species, pivots: THREE.Object3D[], upTo: number) {
  const hold = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
  for (; made.row < Math.min(ROWS, upTo); made.row++) {
    const i = made.row;
    const t = 0.012 + 0.982 * (i / (ROWS - 1));
    for (let j = 0; j < ROUND; j++) {
      const u = -Math.PI + ((j + 0.5) / ROUND) * Math.PI * 2;
      const k = i * ROUND + j;
      shellSurface(sp, t, u, pivots, hold);
      const ok = Number.isFinite(hold.point.x) && hold.normal.lengthSq() > 0.5;
      made.at[k * 3] = ok ? hold.point.x : 1e6;
      made.at[k * 3 + 1] = ok ? hold.point.y : 1e6;
      made.at[k * 3 + 2] = ok ? hold.point.z : 1e6;
      made.out[k * 3] = hold.normal.x;
      made.out[k * 3 + 1] = hold.normal.y;
      made.out[k * 3 + 2] = hold.normal.z;
      made.t[k] = t;
      made.u[k] = u;
      if (!ok) continue;
      // How far apart neighbours round the shell are, at its widest: a point further than that across the surface
      // from every sample is off an edge.
      if (j > 0) made.widest = Math.max(made.widest, Math.hypot(made.at[k * 3] - made.at[k * 3 - 3], made.at[k * 3 + 1] - made.at[k * 3 - 2], made.at[k * 3 + 2] - made.at[k * 3 - 1]));
      const cell = cellOf(hold.point.x, hold.point.y, hold.point.z);
      const list = made.cells.get(cell);
      if (list) list.push(k);
      else made.cells.set(cell, [k]);
    }
  }
  if (made.row < ROWS) return false;
  // Which piece each sample is of: the lid (1) and the two sides (2, 3) are below the tear line; SHELL's own rule.
  for (let k = 0; k < ROWS * ROUND; k++) made.piece[k] = pieceAt(shapeOf(sp), made.t[k], made.u[k]);
  made.reach = Math.min(0.02, Math.max(0.008, made.widest * 0.75));
  return true;
}

function cloudOf(sp: Species, pivots: THREE.Object3D[]) {
  const key = keyOf(sp, pivots);
  if (cloud && cloud.key === key) return cloud;
  const made = pending && pending.key === key ? pending : begin(key);
  if (made === pending) pending = null;
  fill(made, sp, pivots, ROWS);
  cloud = made;
  return made;
}

// The wall as the pivots are set now, made `rows` rows at a time (of 76) over as many calls as it takes, so that the one
// the emergence will ask for can be ready before it does without any frame carrying the whole of it. The same samples
// in the same order as made at once. True once it is ready.
export function prepareWall(sp: Species, pivots: THREE.Object3D[], rows = 6) {
  const key = keyOf(sp, pivots);
  if (cloud && cloud.key === key) return true;
  if (!pending || pending.key !== key) pending = begin(key);
  if (!fill(pending, sp, pivots, pending.row + rows)) return false;
  cloud = pending;
  pending = null;
  return true;
}

// The wall nearest a point (in the chrysalis' space), as drawn now: null if there is none within reach of it (it faces
// only the opening, or is well away). depth is positive inside the shell, negative outside it.
export function wall(sp: Species, pivots: THREE.Object3D[], point: THREE.Vector3, out: Where, far = 0.04): Where | null {
  const c = cloudOf(sp, pivots);
  const span = Math.ceil(far / CELL);
  let best = -1;
  let least = far * far;
  const cx = Math.floor(point.x / CELL);
  const cy = Math.floor(point.y / CELL);
  const cz = Math.floor(point.z / CELL);
  for (let dx = -span; dx <= span; dx++)
    for (let dy = -span; dy <= span; dy++)
      for (let dz = -span; dz <= span; dz++) {
        const list = c.cells.get((cx + dx + 512) * 1048576 + (cy + dy + 512) * 1024 + (cz + dz + 512));
        if (!list) continue;
        for (const k of list) {
          const x = point.x - c.at[k * 3];
          const y = point.y - c.at[k * 3 + 1];
          const z = point.z - c.at[k * 3 + 2];
          const d = x * x + y * y + z * z;
          if (d < least) {
            least = d;
            best = k;
          }
        }
      }
  if (best < 0) return null;
  const x = point.x - c.at[best * 3];
  const y = point.y - c.at[best * 3 + 1];
  const z = point.z - c.at[best * 3 + 2];
  const off = x * c.out[best * 3] + y * c.out[best * 3 + 1] + z * c.out[best * 3 + 2];
  // Across the surface from the nearest sample by more than the samples lie apart: past an edge, no wall here.
  if (Math.sqrt(Math.max(0, least - off * off)) > c.reach) return null;
  out.piece = c.piece[best];
  out.t = c.t[best];
  out.u = c.u[best];
  out.depth = -off;
  return out;
}

// The same, asked of one piece (kept for whoever asks piece by piece).
export function against(sp: Species, pivots: THREE.Object3D[], piece: number, point: THREE.Vector3, out: Where): Where | null {
  const found = wall(sp, pivots, point, out);
  return found && found.piece === piece ? found : null;
}

export type Probe = { count: number; points: Float32Array; radius: Float32Array; chain: Int16Array };
export type Clash = { chain: number; index: number; piece: number; t: number; u: number; depth: number; radius: number; kind: "wall" | "through" | "press" };

const NAMES: [number, string][] = [
  [0, "spine"],
  [1, "eye"],
  [3, "leg"],
  [9, "antenna"],
  [11, "proboscis"],
  [13, "palp"],
  [15, "skull"],
  [16, "fur"],
  [20, "wing"]
];
export const chainName = (chain: number) => {
  let name = "";
  for (const [from, label] of NAMES) if (chain >= from) name = label;
  return chain >= 20 ? `wing${Math.floor((chain - 20) / 20)}` : name;
};

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const p = new THREE.Vector3();
const where: Where = { piece: 0, t: 0, u: 0, depth: 0 };

// Every clash of a probed butterfly with the shell. `toPod` carries the probe's world points into the chrysalis' space.
// A foot rests on the shell, so the tarsus (the last three samples of a leg) may touch it; it may not pass through.
export function clashes(sp: Species, pivots: THREE.Object3D[], probe: Probe, toPod: THREE.Matrix4, scale: number, out: Clash[] = [], head = 0, furry = true, lo = -1, hi = Infinity, soft = false) {
  const thick = WALL * sp.pupa;
  const steps = 4;
  let first = 0;
  for (let i = 0; i < probe.count; i++) {
    const chain = probe.chain[i];
    if (i > 0 && probe.chain[i - 1] !== chain) first = i;
    // (Its hair lies flat while it is still packed in the shell: then only what is under it is tested.)
    if (chain < 0 || chain < lo || chain > hi || (chain === 16 && !furry)) continue;
    const palp = (chain === 13 || chain === 14) && !furry ? 0.011 * sp.wing : Infinity;
    // (Asked for, the head is held that much further off than it measures: its hair and the palps' reach past them.)
    const more = (j: number) => (!head ? 0 : (chain === 0 && j - first < 3) || chain === 15 || chain === 16 || chain === 1 || chain === 2 || chain === 13 || chain === 14 ? head : chain >= 9 && chain <= 12 ? head * 0.3 : 0);
    const joined = i + 1 < probe.count && probe.chain[i + 1] === chain;
    const leg = chain >= 3 && chain <= 8;
    const foot = leg && !(i + 3 < probe.count && probe.chain[i + 3] === chain);
    a.fromArray(probe.points, i * 3).applyMatrix4(toPod);
    if (joined) b.fromArray(probe.points, (i + 1) * 3).applyMatrix4(toPod);
    const ra = Math.min(palp, probe.radius[i] * scale) + more(i);
    const rb = joined ? Math.min(palp, probe.radius[i + 1] * scale) + more(i + 1) : ra;
    let last = 0;
    let lastPiece = -1;
    for (let s = 0; s <= (joined ? steps : 0); s++) {
      const k = s / steps;
      if (joined) p.lerpVectors(a, b, k);
      else p.copy(a);
      const r = ra + (rb - ra) * k;
      const w = wall(sp, pivots, p, where, Math.max(0.04, r + thick + 0.01));
      if (!w) {
        lastPiece = -1;
        continue;
      }
      const touching = Math.abs(w.depth) < r + thick && !foot;
      // (Asked for: a wing pad still packed may press on the flaps it squeezes out between, but the wall may not cut it.
      // Pressing is told apart, not passed over.)
      const pressed = soft && chain >= 20 && touching && Math.abs(w.depth) >= thick + 0.25 * r;
      // Through: one sample well on one side of a piece and the next well on the other.
      const through = lastPiece === w.piece && last * w.depth < 0 && Math.abs(last) > thick * 0.4 && Math.abs(w.depth) > thick * 0.4;
      last = w.depth;
      lastPiece = w.piece;
      // (The joined pair's far end is tested as the next sample's start.)
      if (s === steps && !through) continue;
      if (touching || through) out.push({ chain, index: i, piece: w.piece, t: w.t, u: w.u, depth: w.depth, radius: r, kind: through && !touching ? "through" : pressed ? "press" : "wall" });
    }
  }
  return out;
}
