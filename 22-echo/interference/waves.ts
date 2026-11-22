import * as THREE from "three/webgpu";
import { clamp, cos, dot, exp, float, fract, length, max, mod, select, sin, smoothstep, step, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Sound in the mist travels slowly enough to watch: a metre a second. A beacon sounds while it is held (at least one
// ping's length for a tap), then pings on its own every PERIOD seconds, PINGS times, and falls quiet.
export const SPEED = 1;
export const PERIOD = 3;
export const PING = 1.3;
export const PINGS = 6;
// Beacons sounding at once; a slot holds a beacon until its last waves have left the mist.
export const SOUNDING = 4;
export const SLOTS = 6;
// The mist: a soft ball of this radius about the middle.
export const MIST = 3.4;
// How long a surface stays lit after a wave has passed it.
const AFTERGLOW = 0.9;
// Far beyond any time on the clock: a beacon still held has not let go, and a free slot has not begun.
export const NEVER = 1e5;

// Each slot's state as the shaders read it, all set each frame by the processor:
//   at:    where it is, and how loud (0 when the slot is free)
//   times: when it began, when it was let go, when it stops, and its angular frequency
//   echo:  the point of the form its sound first meets, and how long the sound takes to get there
//   face:  that surface's outward normal, and how strongly it sends sound back
export const beacons = Array.from({ length: SLOTS }, () => ({
  at: uniform(new THREE.Vector4(0, 0, 0, 0)),
  times: uniform(new THREE.Vector4(NEVER, NEVER, NEVER, 18)),
  echo: uniform(new THREE.Vector4(0, 0, 0, 0)),
  face: uniform(new THREE.Vector4(0, 1, 0, 0))
}));
export const clock = uniform(0);

// How strongly a beacon was sounding at emission time te: a smooth swell over the hold, and a soft-shouldered packet
// each period after; and how long since it last sounded, for the glow a wave leaves behind it.
export function emission(te: any, times: any) {
  const t0 = times.x as any;
  const let_ = times.y as any;
  const end = times.z as any;
  const hold = smoothstep(t0, t0.add(0.1), te).mul(float(1).sub(smoothstep(let_.sub(0.12), let_, te))) as any;
  const w = te.sub(let_).add(PING) as any;
  const x = mod(max(w, 0), PERIOD) as any;
  const bell = sin(clamp(x.div(PING), 0, 1).mul(Math.PI)) as any;
  const ping = step(PERIOD, w).mul(bell.mul(bell)) as any;
  const alive = float(1).sub(step(end, te)) as any;
  const strength = hold.add(ping).mul(alive) as any;
  let since = select(w.greaterThanEqual(PERIOD), max(x.sub(PING), 0), max(te.sub(let_), 0)) as any;
  since = select(te.greaterThan(end), te.sub(end), since) as any;
  since = since.add(max(t0.sub(te), 0).mul(100)) as any;
  return { strength, glow: exp(since.div(-AFTERGLOW)) as any };
}

// The sound field at a point: the signed pressure of every beacon's waves and of their echoes off the form, summed, so
// crests meeting crests add and crests meeting troughs cancel; and the afterglow of every wave that has passed.
// Echoes leave the point each beacon's sound first met, sent back over the hemisphere that surface faces.
// Also the crests drawn as lines of a fixed width (in metres) however strong they are: each wave's distance to its
// nearest crest, as a narrow bell, for sharp shells in the mist and sharp contours on the form.
function crestLine(te: any, omega: any, width: number) {
  const cycles = te.mul(omega).div(Math.PI * 2) as any;
  const off = fract(cycles.add(0.5)).sub(0.5).mul(Math.PI * 2 * SPEED).div(omega).div(width) as any;
  return exp(off.mul(off).negate()) as any;
}

export function soundField(p: any, withEcho = true, width = 0.03) {
  let s = float(0) as any;
  let g = float(0) as any;
  let l = float(0) as any;
  for (const b of beacons) {
    const at = b.at as any;
    const times = b.times as any;
    const r = length(p.sub(at.xyz)) as any;
    const te = clock.sub(r.div(SPEED)) as any;
    const fall = at.w.div(r.mul(0.3).add(1)) as any;
    const direct = emission(te, times);
    s = s.add(direct.strength.mul(cos(times.w.mul(te))).mul(fall));
    g = g.add(direct.glow.mul(fall));
    l = l.add(crestLine(te, times.w, width).mul(direct.strength).mul(fall).mul(smoothstep(0.04, 0.3, r)));
    if (!withEcho) continue;
    const echo = b.echo as any;
    const face = b.face as any;
    const away = p.sub(echo.xyz) as any;
    const r2 = length(away) as any;
    const te2 = clock.sub(echo.w).sub(r2.div(SPEED)) as any;
    const facing = smoothstep(-0.15, 0.55, dot(away.div(r2.max(1e-4)), face.xyz)) as any;
    const back = at.w.mul(face.w).mul(facing).div(r2.add(echo.w.mul(SPEED)).mul(0.3).add(1)) as any;
    const returned = emission(te2, times);
    s = s.add(returned.strength.mul(cos(times.w.mul(te2))).mul(back));
    g = g.add(returned.glow.mul(back).mul(0.6));
    l = l.add(crestLine(te2, times.w, width).mul(returned.strength).mul(back));
  }
  return { s, g, l };
}

// The mist's soft edge, 1 inside, fading to nothing at its rim.
export function mistEdge(p: any) {
  return float(1).sub(smoothstep(MIST * 0.55, MIST, length(p))) as any;
}
