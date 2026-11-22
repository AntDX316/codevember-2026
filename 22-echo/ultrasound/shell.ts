import * as THREE from "three/webgpu";
import { abs, atan, exp, float, floor, length, log, max, min, mix, sin, smoothstep, vec2, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The hidden thing: a chambered nautilus, as a distance field that only the echoes ever sample. A tube grows along a
// logarithmic spiral, three times wider each turn, each whorl wrapping round the last; inside, curved walls (septa)
// close off the chambers it has outgrown, threaded by the siphuncle, and the soft animal fills the open body chamber
// with its tentacles drifting out of the mouth.

// Where the shell floats, and the turn that sets its mouth low on the right from the opening view.
export const SHELL_CENTRE = new THREE.Vector3(0, -0.22, 0);
export const SHELL_RADIUS = 1.02;
const SPIN = 0.55;
// The shell's flat side faces this way round the vertical, a three-quarter view from the camera, and the probe starts
// turned to match, so its first slice runs down the middle of the spiral.
export const FACING = 0.8;

const GROWTH = Math.log(3) / (2 * Math.PI);
const TURNS_END = 2 * Math.PI * 2.95;
const A = 0.6 * Math.exp(-GROWTH * TURNS_END);
// The tube's radius as a share of its distance from the centre: over a half, so each whorl overlaps the one inside it.
const TUBE = 0.56;
// The tube is narrower across (the shell's thickness) than out from the centre.
const FLAT = 0.7;
// Septa every so far round, stopping short of the body chamber: about the last third of a turn is open.
const SEPTUM_STEP = (2 * Math.PI) / 11;
const BODY = TURNS_END - 2.25;

// Material at a point (in world units): x hard shell, y soft animal, each from 0 (water) to 1, softened across `blur`.
export function shellMatter(world: any, clock: any, blur: any) {
  const off = world.sub(vec3(SHELL_CENTRE.x, SHELL_CENTRE.y, SHELL_CENTRE.z)) as any;
  const cf = Math.cos(FACING);
  const sf = Math.sin(FACING);
  const lp = vec3(off.x.mul(cf).sub(off.z.mul(sf)), off.y, off.x.mul(sf).add(off.z.mul(cf))) as any;
  // Turned in its own plane, so the mouth faces down and to the right.
  const c = Math.cos(SPIN);
  const s = Math.sin(SPIN);
  const p = vec3(lp.x.mul(c).sub(lp.y.mul(s)), lp.x.mul(s).add(lp.y.mul(c)), lp.z) as any;
  const rho = max(length(p.xy), float(1e-4)) as any;
  const phi = atan(p.y, p.x) as any;
  // Which turn of the spiral a point lies between, from how far out it is.
  const turns = log(rho.div(A)).div(GROWTH).sub(phi).div(2 * Math.PI) as any;
  const n0 = floor(turns).clamp(-1, 3) as any;

  let hard: any = float(1e3);
  let inside: any = float(1e3);
  let soft: any = float(1e3);
  for (let k = 0; k < 2; k++) {
    const theta = phi.add(n0.add(k).mul(2 * Math.PI)) as any;
    const r = exp(theta.mul(GROWTH)).mul(A) as any;
    const R = r.mul(TUBE) as any;
    const q = vec2(rho.sub(r), p.z.div(FLAT)) as any;
    const fromAxis = length(q) as any;
    // Faint growth ridges round the outside.
    const ridge = sin(theta.mul(48)).mul(R.mul(0.012)) as any;
    const tube = fromAxis.sub(R).add(ridge).mul(FLAT) as any;
    // The open mouth, and nothing before the first tiny whorl.
    const mouth = theta.sub(TURNS_END).mul(r) as any;
    const start = float(1.4).sub(theta).mul(r) as any;
    const cut = max(mouth, start) as any;
    const wall = max(abs(tube).sub(R.mul(0.035).add(0.006)), cut) as any;
    const room = max(tube, cut) as any;

    // The septa, each bowed back toward the centre in the middle, concave to the mouth.
    const k0 = floor(theta.div(SEPTUM_STEP).add(0.5)) as any;
    const along = theta.sub(k0.mul(SEPTUM_STEP)).mul(r) as any;
    const across = fromAxis.div(R).min(1) as any;
    const septum = abs(along.add(R.mul(0.42).mul(float(1).sub(across.mul(across)))))
      .sub(R.mul(0.02).add(0.004))
      .max(room)
      .max(k0.mul(SEPTUM_STEP).sub(BODY).mul(r)) as any;
    // The siphuncle: a thin tube through the middle of every septum, back to the first chamber.
    const siphuncle = length(q.sub(vec2(R.mul(-0.18), 0)))
      .sub(R.mul(0.06))
      .max(theta.sub(BODY + 0.2).mul(r))
      .max(cut) as any;
    hard = min(hard, min(wall, min(septum, siphuncle)));
    inside = min(inside, room);

    // The animal in the body chamber: a soft mass toward the back of it, its hood over the mouth.
    const body = fromAxis
      .sub(R.mul(0.8))
      .max(float(BODY + 0.25).sub(theta).mul(r))
      .max(theta.sub(TURNS_END - 0.12).mul(r)) as any;
    soft = min(soft, body);
  }

  // Tentacles: a sheaf drifting out of the mouth, each waving on its own.
  const mouthAngle = TURNS_END - 4 * Math.PI;
  const mr = 0.6;
  const mouthAt = vec3(Math.cos(mouthAngle) * mr, Math.sin(mouthAngle) * mr, 0) as any;
  const out = vec3(-Math.sin(mouthAngle), Math.cos(mouthAngle), 0) as any;
  const side = vec3(Math.cos(mouthAngle), Math.sin(mouthAngle), 0) as any;
  for (let i = 0; i < 7; i++) {
    const spread = (i - 3) / 3;
    const along = p.sub(mouthAt).dot(out) as any;
    const t = along.clamp(0, 0.75 + 0.18 * Math.cos(i * 2.1)) as any;
    const sway = sin(t.mul(5.5).sub(clock.mul(0.9 + i * 0.13)).add(i * 1.7)).mul(t).mul(0.16) as any;
    const curl = sin(clock.mul(0.31 + i * 0.05).add(i)).mul(t.mul(t)).mul(0.35) as any;
    const fan = side.mul(t.mul(0.9).add(1).mul(spread * 0.22).add(sway).add(curl)) as any;
    const lift = vec3(0, 0, t.mul(1.4).add(1).mul(spread * 0.1 + Math.sin(i * 3.3) * 0.07).add(sin(t.mul(4).sub(clock.mul(0.7)).add(i)).mul(t).mul(0.08))) as any;
    const centre = mouthAt.add(out.mul(t)).add(fan).add(lift) as any;
    const width = mix(float(0.045), float(0.012), t.div(0.9)) as any;
    soft = min(soft, length(p.sub(centre)).sub(width));
  }

  const hardness = float(1).sub(smoothstep(blur.negate(), blur, hard)) as any;
  const softness = float(1).sub(smoothstep(blur.negate(), blur, soft)).mul(float(1).sub(hardness)) as any;
  return { hard: hardness, soft: softness, inside, distance: min(hard, soft) } as any;
}

// Kept for anything outside the shaders that needs a cheap test: whether a point is anywhere near the shell.
export const nearShell = (point: THREE.Vector3) => point.distanceTo(SHELL_CENTRE) < SHELL_RADIUS;
