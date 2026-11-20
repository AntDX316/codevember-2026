import * as THREE from "three/webgpu";
import { ABDOMEN, JOINT } from "./body";
import { BUILD } from "./look";
import { pupaAxis } from "./pupa";
import type { Species } from "./species";

// The way out of the chrysalis, so made that nothing passes through its wall, and so that its feet can hold the shell
// the whole way. The butterfly lies along a line through the shell: down its own centreline, then turning out through
// the slit in its front. It is placed by its tail: the tip of its abdomen rides on that line, pointing along it, and
// the body is curled (its abdomen bent under, as a real one's is) by whatever puts its thorax on the line too. It
// starts small enough to lie inside whole, and grows to its size while its tail stays where it was: stretching out of
// the shell, not sliding. Then its thorax is carried to where it will hang, close under the open end, its abdomen
// curling behind it and its tail drawn only as far along as that needs; there its feet hold the shell while the rest
// of the abdomen comes out as it straightens.
// All in the chrysalis' space, in the plane of its middle (x = 0): y up, z toward its ventral side.

// How far the abdomen may stray from the way while it is inside, as a fraction of the chrysalis' length, and the
// length of shell over which its curl comes on as the last of it leaves.
const STRAY = 0.03;
const EASE_IN = 0.62;
// Where the tail lies before it follows, and how far up the shell the top of the head starts, along the centreline.
const TAIL_AT = 0.14;
const SMALL = 0.6;
// And how much of the room it has lengthwise it takes up: less than all, so that its folded legs clear the walls.
const SNUG = 0.8;
const HEAD_AT = 0.87;

export type Way = { position: THREE.Vector3; turn: THREE.Quaternion; scale: number; tuck: number; tail: number; pitch: number };
export const makeWay = (): Way => ({ position: new THREE.Vector3(), turn: new THREE.Quaternion(), scale: 1, tuck: 0, tail: TAIL_AT, pitch: 0 });

const at = new THREE.Vector3();
const dir = new THREE.Vector3();
const basis = new THREE.Matrix4();
const X = new THREE.Vector3(1, 0, 0);
const head = new THREE.Vector3();
const back = new THREE.Vector3();

// The way it goes: down the shell's own centreline, then turning out toward the ventral side, through the slit the
// sides part to leave when the lid lifts (a chrysalis splits down its front, and stays shut behind and at its tip).
// `at` is how far down the shell the turn begins, `turn` how far it turns (radians), `over` the length it turns in;
// all along the centreline, as fractions of the chrysalis' length. May be tried from the console (index.tsx: tune).
const USUAL = { at: 0.66, turn: 0.9, over: 0.28, curl: 1.1 };
// Each species' own, where its shell asks for it (the glasswing's is already bent double toward its front).
const OWN: Record<string, Partial<typeof USUAL>> = {};
// Values tried from the console, over both.
export const TRY: Partial<typeof USUAL> = {};
const EXIT = { ...USUAL };
function exitOf(sp: Species) {
  const own = OWN[sp.label];
  EXIT.at = TRY.at ?? own?.at ?? USUAL.at;
  EXIT.turn = TRY.turn ?? own?.turn ?? USUAL.turn;
  EXIT.over = TRY.over ?? own?.over ?? USUAL.over;
  EXIT.curl = TRY.curl ?? own?.curl ?? USUAL.curl;
  return EXIT;
}
const N = 240;
const REACH = 2.6;
type Path = { key: string; y: Float32Array; z: Float32Array; angle: Float32Array };
const paths = new Map<string, Path>();
function pathOf(sp: Species) {
  exitOf(sp);
  const key = `${EXIT.at}:${EXIT.turn}:${EXIT.over}`;
  let path = paths.get(sp.label);
  if (path && path.key === key) return path;
  path = { key, y: new Float32Array(N + 1), z: new Float32Array(N + 1), angle: new Float32Array(N + 1) };
  const step = (REACH - EXIT.at) / N;
  pupaAxis(sp, EXIT.at, at, dir);
  let y = at.y;
  let z = at.z;
  for (let i = 0; i <= N; i++) {
    const t = EXIT.at + i * step;
    pupaAxis(sp, Math.min(1, t), at, dir);
    const k = Math.min(1, Math.max(0, (t - EXIT.at) / EXIT.over));
    const angle = Math.atan2(dir.z, -dir.y) + EXIT.turn * k * k * (3 - 2 * k);
    if (i > 0) {
      const mid = (angle + path.angle[i - 1]) / 2;
      y -= Math.cos(mid) * step * sp.pupa;
      z += Math.sin(mid) * step * sp.pupa;
    }
    path.y[i] = y;
    path.z[i] = z;
    path.angle[i] = angle;
  }
  paths.set(sp.label, path);
  return path;
}

// The way at t: leaves its point in `at` and its direction in `dir`, and returns its angle from straight down (toward
// the ventral side).
function axis(sp: Species, t: number) {
  if (t <= EXIT.at) {
    const inside = Math.max(0, t);
    pupaAxis(sp, inside, at, dir);
    at.addScaledVector(dir, (t - inside) * sp.pupa);
    return Math.atan2(dir.z, -dir.y);
  }
  const path = pathOf(sp);
  const x = Math.min(N - 1e-4, ((t - EXIT.at) / (REACH - EXIT.at)) * N);
  const i = Math.floor(x);
  const f = x - i;
  const angle = path.angle[i] + (path.angle[i + 1] - path.angle[i]) * f;
  at.set(0, path.y[i] + (path.y[i + 1] - path.y[i]) * f, path.z[i] + (path.z[i + 1] - path.z[i]) * f);
  dir.set(0, -Math.cos(angle), Math.sin(angle));
  return angle;
}

// How long the abdomen is, and the whole tail from the body's origin, in forewing lengths.
export function tailLength(sp: Species, swell: number) {
  const long = (BUILD[sp.column] ?? BUILD[1]).long;
  return ABDOMEN * long * (1 + swell * 0.18);
}

const spot = { y: 0, z: 0, pitch: 0 };
// The body's origin and pitch (0 head down, pi head up, turning toward the ventral side), given where the tip of its
// tail is on the centreline, how far its abdomen is curled, and its size (forewing length times scale, scene units).
function fromTail(sp: Species, tail: number, curl: number, size: number, length: number, extra = 0) {
  const angle = axis(sp, tail);
  const tipY = at.y;
  const tipZ = at.z;
  // The tip in the body's own space (body.ts: each point of the abdomen turned about the joint by its share of the curl).
  const l = length * size;
  const by = JOINT * size - l * Math.cos(curl);
  const bz = -l * Math.sin(curl);
  // Which way the tail points there, tailward.
  const ty = -Math.cos(curl) + curl * Math.sin(curl);
  const tz = -Math.sin(curl) - curl * Math.cos(curl);
  // Turned so that it points back up the centreline.
  const pitch = angle + Math.PI + Math.atan2(tz, ty) + extra;
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  // Body (y, z) to the chrysalis': head (-cos, sin), back (-sin, -cos).
  spot.y = tipY - (-by * c - bz * s);
  spot.z = tipZ - (by * s - bz * c);
  spot.pitch = pitch;
  return spot;
}

// How far a point stands off the centreline, toward the ventral side.
function off(sp: Species, y: number, z: number) {
  let t = Math.min(2.2, Math.max(-0.2, -y / sp.pupa));
  let angle = 0;
  for (let i = 0; i < 8; i++) {
    angle = axis(sp, t);
    t = Math.min(REACH - 0.05, Math.max(-0.2, t + ((y - at.y) * dir.y + (z - at.z) * dir.z) / sp.pupa));
  }
  angle = axis(sp, t);
  return (y - at.y) * Math.sin(angle) + (z - at.z) * Math.cos(angle);
}

// The curl that lays the thorax on the centreline.
function curlFor(sp: Species, tail: number, size: number, length: number) {
  let lo = -0.5;
  let hi = 1.9;
  const f = (curl: number) => {
    const p = fromTail(sp, tail, curl, size, length);
    return off(sp, p.y, p.z);
  };
  let flo = f(lo);
  const fhi = f(hi);
  if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? 0 : 0;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm * flo <= 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => x * x * (3 - 2 * x);

// How small it must be to lie inside whole, its tail and the top of its head where they start.
export function smallest(sp: Species, swell: number) {
  const tail = tailLength(sp, swell) - JOINT;
  // (And no bigger than its wing pads can be and still pass between the shell's sides.)
  return Math.min(SMALL, (SNUG * (HEAD_AT - TAIL_AT) * sp.pupa) / ((tail + 0.215) * sp.wing));
}

// Where the tail and the curl must end for the thorax to come to a given place (in the middle plane): found once for
// each species and place by trying them all. The thorax is brought there while the tail is still well inside, so that
// its feet can take the shell there and keep it while the rest of the abdomen is drawn out.
type End = { key: string; tail: number; curl: number; y: number; z: number };
const ends = new Map<string, End>();
export function endFor(sp: Species, y: number, z: number, swell: number) {
  exitOf(sp);
  const key = `${y.toFixed(3)}:${z.toFixed(3)}:${swell.toFixed(2)}:${EXIT.at}:${EXIT.turn}`;
  let end = ends.get(sp.label);
  if (end && end.key === key) return end;
  end = { key, tail: 0.4, curl: 1, y, z };
  const length = tailLength(sp, swell);
  let least = Infinity;
  for (let i = 0; i <= 40; i++) {
    const tail = 0.24 + (EXIT.at - 0.02 - 0.24) * (i / 40);
    for (let j = 0; j <= 60; j++) {
      const curl = 0.1 + 2.2 * (j / 60);
      const p = fromTail(sp, tail, curl, sp.wing, length);
      // As near the place as may be, and of those the one that leaves the tail deepest and curls least.
      const d = Math.hypot(p.y - y, p.z - z) + 0.02 * curl + 0.03 * tail;
      if (d < least) {
        least = d;
        end.tail = tail;
        end.curl = curl;
        end.y = p.y;
        end.z = p.z;
      }
    }
  }
  ends.set(sp.label, end);
  return end;
}

// The body on its way out: `grown` 0 to 1 is its stretching out of the shell to full size with its tail where it lay;
// `drawn` 0 to 1 then carries its thorax to where it will hang (the place `end` was found for), its abdomen curling
// under it and its tail following only as far as that needs. The rest of the abdomen comes out as it straightens to
// hang, which is the scene's to do.
export function wayOut(sp: Species, grown: number, drawn: number, swell: number, out: Way, end: { tail: number; curl: number } | null = null, state: { x: number; v: number } | null = null, dt = 0) {
  exitOf(sp);
  const length = tailLength(sp, swell);
  const least = smallest(sp, swell);
  const scale = least + (1 - least) * grown;
  const size = sp.wing * scale;
  // Where its tail lies before it follows: with the top of its head where it starts (small, that leaves the tail well
  // down the shell), and never higher than the shell has room for.
  const start = Math.max(TAIL_AT, HEAD_AT - ((length - JOINT + 0.215) * sp.wing * least) / sp.pupa);
  let tail: number;
  let curl: number;
  if (end) {
    const k = drawn * drawn * drawn * (drawn * (drawn * 6 - 15) + 10);
    tail = start + (Math.max(start, end.tail) - start) * k;
    // Lying along the way, and curled by its share of what the end asks.
    const lie = curlFor(sp, tail, size, length);
    curl = lie + (end.curl - lie) * k;
  } else {
    // Without a place to make for, the tail is drawn right out along the way and a little beyond, the body curling
    // forward only as what is still inside allows (the part of the abdomen in the shell may bow only so far), on a
    // spring, so that however suddenly that bound opens the body only ever eases.
    const k = drawn < 0.5 ? 4 * drawn * drawn * drawn : 1 - (-2 * drawn + 2) ** 3 / 2;
    const clear = EXIT.at + EXIT.over + 0.12;
    tail = start + (clear + 0.16 - start) * k;
    const lie = curlFor(sp, tail, size, length);
    const inside = Math.max(0, clear - tail) * sp.pupa;
    const l = length * size;
    const most = inside < 1e-4 ? 9 : (2 * l * STRAY * sp.pupa) / (inside * inside);
    const near = Math.min(1, Math.max(0, 1 - inside / (EASE_IN * sp.pupa)));
    const want = Math.min(EXIT.curl * near * near * near * (near * (near * 6 - 15) + 10), most);
    let more = want;
    if (state) {
      const omega = 5;
      const d = state.x - want;
      const temp = (state.v + omega * d) * dt;
      const e = Math.exp(-omega * dt);
      state.v = (state.v - omega * temp) * e;
      more = Math.max(0, Math.min(want + (d + temp) * e, most));
      state.x = more;
    }
    curl = lie + more;
  }
  const p = fromTail(sp, tail, curl, size, length);
  out.scale = scale;
  out.tuck = curl;
  out.tail = tail;
  out.pitch = p.pitch;
  out.position.set(0, p.y, p.z);
  head.set(0, -Math.cos(p.pitch), Math.sin(p.pitch));
  back.set(0, -Math.sin(p.pitch), -Math.cos(p.pitch));
  out.turn.setFromRotationMatrix(basis.makeBasis(X, head, back));
  return out;
}
