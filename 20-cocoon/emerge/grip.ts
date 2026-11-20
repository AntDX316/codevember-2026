import * as THREE from "three/webgpu";
import { wall, type Where } from "./clash";
import { lidHalfAngle, pupaAxis, shellSurface, splitAt, WALL } from "./pupa";
import { shapeOf } from "./shell-shape";
import type { Species } from "./species";

// The butterfly's feet on its chrysalis as it climbs out and hangs. Each walking leg, once its hip is out of the shell,
// holds a real point of the shell as it is drawn (the inside or the outside of a flap, its rim, the outside of the
// abdomen), and keeps it while the body moves on; when the hold falls out of comfortable reach, or stands badly, it
// lets go and steps to a better one, the legs going in diagonal pairs so that at least two always hold. All in the
// chrysalis' own space, so the feet stay put on the shell as it swings.

// A place a foot may hold: on the shell, with the way out from the surface there.
type Spot = { point: THREE.Vector3; normal: THREE.Vector3; piece: number; t: number; u: number; inside: boolean };
export type Foot = {
  // Where it holds (or is stepping to), where it stepped from, and how far through the step (1: planted).
  to: THREE.Vector3;
  toNormal: THREE.Vector3;
  from: THREE.Vector3;
  fromNormal: THREE.Vector3;
  step: number;
  held: boolean;
  // Where on the shell its hold is (along, round, and on which face), so that it rides the flap if the flap moves.
  on: { t: number; u: number; inside: boolean };
  // Counts its holds: a new number each time it takes a new one.
  count: number;
  // Out of the shell and reaching: 0 folded, 1 free, eased.
  free: number;
  freeV: { v: number };
  since: number;
  // Where the foot is now, with the way out of the surface, and how far it is lifted.
  at: THREE.Vector3;
  normal: THREE.Vector3;
  lift: number;
  reached: boolean;
};

// Hips in the body's space, in forewing lengths (rig.ts): middle and hind pairs, the right ones.
export const HIPS = [
  [0.034, 0.012, -0.056],
  [0.034, -0.058, -0.052]
];
// Which way each pair likes to reach, in the body's space: out, along (toward the head for the middle pair), and down.
const LIKES = [
  [0.72, 0.42, -0.55],
  [0.7, -0.5, -0.5]
];
// How long a step takes (the rig swings the foot over and feels for its hold in a little less), and how far a leg
// reaches from its hip, in forewing lengths at the standard build (the rig's own figure).
const STEP = 0.5;
export const REACH = 0.37 * 0.94;
// A leg reaches out once its hip is this far down the shell: before the body starts to shove, so that its legs are
// already through the opening and pulling when it does.
const FREE = 0.66;
const HIND = 0;
// A species may be let out later than that, should its shell ask for it.
const LATER: Record<string, number> = {};

const v = new THREE.Vector3();
const w = new THREE.Vector3();
const hip = new THREE.Vector3();
const far = new THREE.Vector3();
const far2 = new THREE.Vector3();
const folded = new THREE.Vector3();
const carried = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
const like = new THREE.Vector3();
const where: Where = { piece: 0, t: 0, u: 0, depth: 0 };
const at = new THREE.Vector3();
const dir = new THREE.Vector3();

const ease = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

export class Grip {
  feet: Foot[] = Array.from({ length: 6 }, () => ({
    to: new THREE.Vector3(),
    toNormal: new THREE.Vector3(0, 0, 1),
    from: new THREE.Vector3(),
    fromNormal: new THREE.Vector3(0, 0, 1),
    step: 1,
    held: false,
    on: { t: 0, u: 0, inside: false },
    count: 0,
    free: 0,
    freeV: { v: 0 },
    since: 0,
    at: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 0, 1),
    lift: 0,
    reached: false
  }));
  private needs = [0, 0, 0, 0, 0, 0];
  private walled = [false, false, false, false, false, false];
  // Holds a leg was seen to reach through the shell for, as drawn: not taken by that leg again.
  private banned: string[][] = [[], [], [], [], [], []];
  private fouled = [false, false, false, false, false, false];
  // How often running, and where the body was: after three such holds the leg stays drawn in until the body has moved.
  private fouls = [0, 0, 0, 0, 0, 0];
  private shifted: Spot = { point: new THREE.Vector3(), normal: new THREE.Vector3(), piece: 0, t: 0, u: 0, inside: false };
  // The hold a foot had before a small change of grip: gone back to, should the new one turn out badly.
  private before = Array.from({ length: 6 }, () => ({ live: false, to: new THREE.Vector3(), normal: new THREE.Vector3(), t: 0, u: 0, inside: false }));
  private rest = Array.from({ length: 6 }, () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }));
  // The rig's own word on a hold (pod space), if the scene gives it: within the leg's true reach, and not behind a wing.
  ok: ((k: number, point: THREE.Vector3) => boolean) | null = null;
  // Its build's girth against the standard: holds are kept to the belly side of the wing roots.
  girth = 1;
  // While its wing pads are still in the slit: holds only ahead of the hip, so that a leg swings out in front of the
  // pad beside it and not back across it.
  forward = false;
  // Asked for: the flaps' lower rim may be held too, from below, the foot hooked over its edge (to hang at arm's length).
  rim = false;
  // The scene's own chance (seeded), for what is left to it.
  random: () => number = Math.random;
  private inverse = new THREE.Quaternion();
  private spots: Spot[] = [];
  private spotsFor = "";
  private order: number[] = [];
  private scores: number[] = [];

  reset() {
    for (const foot of this.feet) {
      foot.step = 1;
      foot.held = false;
      foot.free = 0;
      foot.freeV.v = 0;
      foot.since = 0;
      foot.lift = 0;
      foot.reached = false;
      foot.count = 0;
    }
    for (let k = 0; k < 6; k++) {
      this.banned[k].length = 0;
      this.fouled[k] = false;
      this.before[k].live = false;
      this.walled[k] = false;
      this.fouls[k] = 0;
    }
  }

  // The leg as drawn passes through the shell to the hold it has: that hold is not for it, and it steps to another.
  foul(k: number) {
    const foot = this.feet[k];
    if (!foot.held || foot.step < 1) return;
    this.banned[k].push(`${foot.on.t.toFixed(3)}:${foot.on.u.toFixed(3)}:${foot.on.inside}`);
    const was = this.before[k];
    if (was.live) {
      // (A change of grip that did not serve: back to the hold it stood well on.)
      was.live = false;
      foot.to.copy(was.to);
      foot.toNormal.copy(was.normal);
      foot.on.t = was.t;
      foot.on.u = was.u;
      foot.on.inside = was.inside;
      foot.step = 0;
      foot.count++;
      return;
    }
    this.fouled[k] = true;
    this.fouls[k]++;
  }

  // A small change of grip for a leg that stands well enough: to a hold close by the one it has, if there is one.
  shift(sp: Species, pivots: THREE.Object3D[], k: number, body: THREE.Object3D, size: number, leg: number) {
    const foot = this.feet[k];
    for (let o = 2; o < 6; o++) if (this.feet[o].held && this.feet[o].step < 1) return false;
    if (!foot.held) return false;
    this.survey(sp, pivots);
    const pair = (k >> 1) - 1;
    const side = k % 2 === 0 ? 1 : -1;
    hip.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(size).applyQuaternion(body.quaternion).add(body.position);
    const reach = REACH * leg * size;
    // A place a little way off along the surface from the hold it has (not one of the surveyed ones: nearer than
    // those lie, so the leg hardly changes its line), a few tries in different directions.
    let best: Spot | null = null;
    const sh = shapeOf(sp);
    this.inverse.copy(body.quaternion).invert();
    for (let tries = 0; tries < 4 && !best; tries++) {
      const turn = this.random() * Math.PI * 2;
      const far = (0.03 + 0.03 * this.random()) * size;
      const t = foot.on.t + (Math.cos(turn) * far) / sp.pupa;
      const u = foot.on.u + (Math.sin(turn) * far) / (0.2 * sp.pupa);
      // (By the same rules as any hold: on its own piece, off the torn edges and the rim.)
      if (foot.on.t > splitAt(sh, foot.on.u)) {
        if (t < splitAt(sh, u) + 0.03 || t > 0.94 || Math.abs(Math.abs(u) - lidHalfAngle(t)) < 0.32 || Math.abs(u) < lidHalfAngle(t) || u > 0 !== foot.on.u > 0) continue;
      } else if (t > splitAt(sh, u) - 0.03 || Math.abs(u) < 1.0) continue;
      shellSurface(sp, t, u, pivots, carried);
      if (!Number.isFinite(carried.normal.x) || carried.normal.lengthSq() < 0.5) continue;
      const spot = this.shifted;
      spot.point.copy(carried.point);
      spot.normal.copy(carried.normal);
      spot.t = t;
      spot.u = u;
      spot.inside = foot.on.inside;
      if (spot.inside) {
        spot.point.addScaledVector(carried.normal, -WALL * sp.pupa);
        spot.normal.negate();
      }
      const move = spot.point.distanceTo(foot.to);
      if (move < 0.015 * size || move > 0.085 * size * leg) continue;
      const d = spot.point.distanceTo(hip) / reach;
      if (d > 0.9 || d < 0.3) continue;
      v.copy(spot.point).sub(hip).normalize();
      if (-spot.normal.dot(v) < 0.04) continue;
      let crowded = false;
      for (let o = 2; o < 6; o++) if (o !== k && this.feet[o].held && this.feet[o].to.distanceTo(spot.point) < reach * 0.25) crowded = true;
      w.copy(spot.point).sub(body.position).applyQuaternion(this.inverse).divideScalar(body.scale.x);
      if (w.z > 0.02 * this.girth || w.x * side < -0.04) continue;
      if (crowded || !this.clearTo(sp, pivots, spot.point, 0.008) || (this.ok && !this.ok(k, spot.point))) continue;
      best = spot;
    }
    if (!best) return false;
    const was = this.before[k];
    was.live = true;
    was.to.copy(foot.to);
    was.normal.copy(foot.toNormal);
    was.t = foot.on.t;
    was.u = foot.on.u;
    was.inside = foot.on.inside;
    foot.to.copy(best.point);
    foot.toNormal.copy(best.normal);
    foot.on.t = best.t;
    foot.on.u = best.u;
    foot.on.inside = best.inside;
    foot.step = 0;
    foot.count++;
    foot.since = 0;
    return true;
  }

  // How many places a foot might hold with the pieces open as they are.
  count(sp: Species, pivots: THREE.Object3D[]) {
    this.survey(sp, pivots);
    return this.spots.length;
  }

  // Every place a foot might hold, with the pieces open as they are: found once for each opening.
  private survey(sp: Species, pivots: THREE.Object3D[]) {
    const key = `${sp.label}:${pivots[1].rotation.x.toFixed(3)}:${pivots[2].rotation.z.toFixed(3)}:${this.rim}`;
    if (key === this.spotsFor) return false;
    this.spotsFor = key;
    const sh = shapeOf(sp);
    const wall = WALL * sp.pupa;
    const spots: Spot[] = [];
    const out = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    const add = (t: number, u: number, piece: number, inside: boolean) => {
      shellSurface(sp, t, u, pivots, out);
      if (!Number.isFinite(out.normal.x) || out.normal.lengthSq() < 0.5) return;
      const spot = { point: out.point.clone(), normal: out.normal.clone(), piece, t, u, inside };
      if (inside) {
        // The inner face of a flap: through the wall, and facing the other way.
        spot.point.addScaledVector(out.normal, -wall);
        spot.normal.negate();
      }
      spots.push(spot);
    };
    for (let j = 0; j < 24; j++) {
      const u = -Math.PI + ((j + 0.5) / 24) * Math.PI * 2;
      const split = splitAt(sh, u);
      for (let i = 0; i < 12; i++) {
        // The flaps, both faces, down to the rim.
        const t = split + 0.03 + (0.992 - split - 0.03) * (i / 11);
        const lid = Math.abs(u) < lidHalfAngle(t);
        // Not right on a torn edge.
        // Nor near enough to one for the toes to lie over it (a tarsus is long).
        if (Math.abs(Math.abs(u) - lidHalfAngle(t)) < 0.32 || t > 0.94) continue;
        // (Not the lid: it is folded back out of the way.)
        if (lid) continue;
        const piece = u > 0 ? 2 : 3;
        add(t, u, piece, false);
        add(t, u, piece, true);
      }
      // The rim itself, held from below: the way out of it is on along the flap, off its edge.
      if (this.rim && Math.abs(Math.abs(u) - lidHalfAngle(0.985)) >= 0.32 && Math.abs(u) >= lidHalfAngle(0.985)) {
        shellSurface(sp, 0.93, u, pivots, out);
        v.copy(out.point);
        shellSurface(sp, 0.985, u, pivots, out);
        if (Number.isFinite(out.normal.x) && out.normal.lengthSq() > 0.5) {
          const off = out.point.clone().sub(v);
          if (off.lengthSq() > 1e-8) spots.push({ point: out.point.clone().addScaledVector(out.normal, -wall * 0.5), normal: off.normalize(), piece: u > 0 ? 2 : 3, t: 0.985, u, inside: false });
        }
      }
      // The abdomen's outside, its lower half.
      // (Not under the lid's hinge on the front: a foot there lies across the lid's root.)
      if (Math.abs(u) > 1.0) for (let i = 0; i < 4; i++) add(split - 0.03 - 0.07 * i, u, 0, false);
    }
    this.spots = spots;
    return true;
  }

  // Whether the straight line from the hip to a hold keeps clear of every wall (short of the hold itself).
  private clearTo(sp: Species, pivots: THREE.Object3D[], point: THREE.Vector3, margin: number) {
    for (let s = 1; s <= 12; s++) {
      v.lerpVectors(hip, point, s / 13);
      const hit = wall(sp, pivots, v, where);
      // (Less margin close to the hold, which is itself on a wall; but never through one.)
      if (hit && Math.abs(hit.depth) < WALL * sp.pupa + margin * Math.min(1, (13 - s) / 5)) return false;
    }
    return true;
  }

  // The best hold for a leg from where its hip now is: within easy reach, facing it, the way the leg likes to reach,
  // not on top of another foot, and with a clear line to it.
  private choose(sp: Species, pivots: THREE.Object3D[], k: number, body: THREE.Object3D, reach: number, ahead: THREE.Vector3 | null, from: THREE.Vector3 | null, first = false) {
    const pair = (k >> 1) - 1;
    const side = k % 2 === 0 ? 1 : -1;
    like.set(LIKES[pair][0] * side, LIKES[pair][1], LIKES[pair][2]).normalize().applyQuaternion(body.quaternion);
    const spots = this.spots;
    const { order, scores } = this;
    this.inverse.copy(body.quaternion).invert();
    order.length = 0;
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i];
      v.copy(spot.point).sub(hip);
      const d = v.length();
      scores[i] = -Infinity;
      if (d > reach * 0.9 || d < reach * 0.3) continue;
      // (On the belly side of the wing roots and not across the body, or the leg would be drawn through a wing.)
      w.copy(spot.point).sub(body.position).applyQuaternion(this.inverse).divideScalar(body.scale.x);
      if (w.z > 0.02 * this.girth || w.x * side < -0.04) continue;
      if (this.forward && pair === 1 && w.y < HIPS[pair][1] - 0.01) continue;
      if (this.banned[k].length && this.banned[k].includes(`${spot.t.toFixed(3)}:${spot.u.toFixed(3)}:${spot.inside}`)) continue;
      v.divideScalar(d);
      const facing = -spot.normal.dot(v);
      if (facing < 0.04) continue;
      let score = 1.3 * v.dot(like) + 0.5 * facing - 1.1 * Math.abs(d / reach - 0.62);
      // Each foot its own place.
      for (let o = 2; o < 6; o++) {
        if (o === k || !this.feet[o].held) continue;
        const near = this.feet[o].to.distanceTo(spot.point);
        if (near < reach * 0.3) score -= 1.5 * (1 - near / (reach * 0.3));
      }
      // Where the body is going, if that is known: a hold its hip will still reach from there, so that taking it lets
      // the body move on.
      if (ahead) score -= 2.2 * Math.max(0, spot.point.distanceTo(ahead) / reach - 0.5);
      scores[i] = score;
      order.push(i);
    }
    order.sort((a, b) => scores[b] - scores[a]);
    // The first whose line from the hip does not pass through a wall.
    for (let n = 0; n < Math.min(order.length, 14); n++) {
      const spot = spots[order[n]];
      let clear = true;
      for (let s = 1; s <= 5 && clear; s++) {
        v.lerpVectors(hip, spot.point, s / 7);
        const hit = wall(sp, pivots, v, where);
        if (hit && Math.abs(hit.depth) < WALL * sp.pupa + 0.02) clear = false;
      }
      // Nor may the foot's own way there, from where it stands now, pass through one: it steps round, never through.
      // (A first hold is come to from where the leg lay folded, by way of a point just off the hold: the rig's own way.)
      if (first && from) {
        far2.copy(spot.point).addScaledVector(spot.normal, 0.05 * body.scale.x);
        for (let s = 1; s <= 7 && clear; s++) {
          v.lerpVectors(from, far2, s / 7);
          const hit = wall(sp, pivots, v, where);
          if (hit && Math.abs(hit.depth) < WALL * sp.pupa + 0.008) clear = false;
        }
      }
      for (let s = 1; s <= 4 && clear && from && !first; s++) {
        v.lerpVectors(from, spot.point, s / 5);
        const hit = wall(sp, pivots, v, where);
        if (hit && Math.abs(hit.depth) < WALL * sp.pupa + 0.006) clear = false;
      }
      // Nor the leg itself as it swings over: from the hip to places along the foot's way, no wall between.
      for (let s = 1; s <= 3 && clear && from && !first; s++) {
        far2.lerpVectors(from, spot.point, s / 4);
        for (let n = 2; n <= 6 && clear; n++) {
          v.lerpVectors(hip, far2, n / 8);
          const hit = wall(sp, pivots, v, where);
          if (hit && Math.abs(hit.depth) < WALL * sp.pupa + 0.004) clear = false;
        }
      }
      // (By the same measure a hold is later given up for, or it would be taken and given up in turn for ever.)
      if (clear && !this.clearTo(sp, pivots, spot.point, 0.008)) clear = false;
      if (clear && this.ok && !this.ok(k, spot.point)) clear = false;
      if (clear) return spot;
    }
    return null;
  }

  // Whether leg k could take a hold at all with the body where it is (for planning a way before it is walked).
  couldHold(sp: Species, pivots: THREE.Object3D[], k: number, body: THREE.Object3D, size: number, leg: number) {
    this.survey(sp, pivots);
    const pair = (k >> 1) - 1;
    const side = k % 2 === 0 ? 1 : -1;
    hip.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(size).applyQuaternion(body.quaternion).add(body.position);
    return this.choose(sp, pivots, k, body, REACH * leg * size, null, null) !== null;
  }

  // One frame: `body` is the butterfly's group in the chrysalis' space as it really is (matrix up to date), `goal`
  // where the body is making for (it follows its feet, and may be short of that), `size` its forewing length as drawn
  // (scene units), `leg` its build's leg length against the standard. One leg steps at a time, and only while every
  // other leg that is out holds: so that from the first hold on it always stands on at least all but one. The leg
  // that steps is the one most in need: with no hold yet, or whose hold the hip cannot keep (now, or from where the
  // body is going), or which a wall has come between. Leaves each foot's hold for the rig; returns how many hold.
  update(dt: number, sp: Species, pivots: THREE.Object3D[], body: THREE.Object3D, size: number, leg: number, goal: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null, sizeThen = size) {
    const moved = this.survey(sp, pivots);
    // The flaps have moved: every hold is carried with the piece it is on.
    if (moved)
      for (let k = 2; k < 6; k++) {
        const foot = this.feet[k];
        if (!foot.held) continue;
        shellSurface(sp, foot.on.t, foot.on.u, pivots, carried);
        foot.to.copy(carried.point);
        foot.toNormal.copy(carried.normal);
        if (foot.on.inside) {
          foot.to.addScaledVector(carried.normal, -WALL * sp.pupa);
          foot.toNormal.negate();
        }
      }
    const reach = REACH * leg * size;
    let stepping = false;
    for (let k = 2; k < 6; k++) {
      const foot = this.feet[k];
      if (foot.held && foot.step < 1) {
        foot.step = Math.min(1, foot.step + dt / STEP);
        if (foot.step < 1) stepping = true;
      }
    }
    const needs = this.needs;
    needs[2] = needs[3] = needs[4] = needs[5] = 0;
    for (let k = 2; k < 6; k++) {
      const foot = this.feet[k];
      const pair = (k >> 1) - 1;
      const side = k % 2 === 0 ? 1 : -1;
      hip.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(size).applyQuaternion(body.quaternion).add(body.position);
      // Out of the shell once the hip is far enough down its way out.
      let t = Math.min(1.5, Math.max(0, -hip.y / sp.pupa));
      for (let i = 0; i < 4; i++) {
        const inside = Math.min(1, Math.max(0, t));
        pupaAxis(sp, inside, at, dir);
        at.addScaledVector(dir, (t - inside) * sp.pupa);
        t += ((hip.y - at.y) * dir.y + (hip.z - at.z) * dir.z) / sp.pupa;
      }
      const out = foot.held || t > (LATER[sp.label] ?? FREE) + (pair === 1 ? HIND : 0) ? 1 : 0;
      foot.free = Math.min(1, Math.max(0, springStep(foot.free, foot.freeV, out, 7, dt)));
      foot.since += dt;
      if (!out || stepping) continue;
      // How badly it needs a new hold: over 1, it does.
      let need = 3 - k * 0.05;
      if (!foot.held && this.fouls[k] >= 3) {
        if (this.fouls[k] === 3) {
          this.rest[k].position.copy(body.position);
          this.rest[k].quaternion.copy(body.quaternion);
          this.fouls[k] = 4;
        }
        if (body.position.distanceTo(this.rest[k].position) < 0.05 * size && body.quaternion.angleTo(this.rest[k].quaternion) < 0.12) continue;
        this.fouls[k] = 0;
      }
      if (foot.held) {
        const d = foot.to.distanceTo(hip) / reach;
        v.copy(foot.to).sub(hip).normalize();
        const facing = -foot.toNormal.dot(v);
        need = Math.max(d / 0.84, 0.3 / Math.max(d, 0.01));
        if (goal) {
          w.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(sizeThen).applyQuaternion(goal.quaternion).add(goal.position);
          need = Math.max(need, foot.to.distanceTo(w) / reach / 0.9);
        }
        this.walled[k] = !this.clearTo(sp, pivots, foot.to, 0.008);
        if (facing < 0.02 || this.walled[k] || this.fouled[k]) need = Math.max(need, 2);
      }
      needs[k] = need;
    }
    // The leg most in need steps, if there is a hold for it; if there is none, the next most in need (a leg with
    // nowhere to go must not keep the others from stepping).
    for (let turn = 0; turn < 4 && !stepping; turn++) {
      let k = -1;
      let most = 1;
      for (let n = 2; n < 6; n++)
        if (needs[n] > most) {
          most = needs[n];
          k = n;
        }
      if (k < 0) break;
      needs[k] = 0;
      const foot = this.feet[k];
      const pair = (k >> 1) - 1;
      const side = k % 2 === 0 ? 1 : -1;
      hip.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(size).applyQuaternion(body.quaternion).add(body.position);
      let ahead: THREE.Vector3 | null = null;
      if (goal) ahead = far.set(HIPS[pair][0] * side, HIPS[pair][1], HIPS[pair][2]).multiplyScalar(sizeThen).applyQuaternion(goal.quaternion).add(goal.position);
      // (Where an unheld leg lies folded under the chest: the rig's own place for it.)
      if (!foot.held) folded.set(side * 0.03, pair === 0 ? 0.06 : -0.03, -0.088).multiplyScalar(size).applyQuaternion(body.quaternion).add(body.position);
      let spot = this.fouled[k] && this.fouls[k] >= 3 ? null : this.choose(sp, pivots, k, body, reach, ahead, foot.held ? foot.to : folded, !foot.held);
      // A foot that only stands far out steps for a hold that is nearer by something, not for one as far: or it
      // would go on stepping from one to another for ever.
      if (spot && foot.held && most < 2) {
        const now = Math.max(foot.to.distanceTo(hip), ahead ? foot.to.distanceTo(ahead) : 0);
        const then = Math.max(spot.point.distanceTo(hip), ahead ? spot.point.distanceTo(ahead) : 0);
        if (then > now - 0.06 * reach) spot = null;
      }
      // (Only for a hold that is better than the one it has.)
      if (spot && !(foot.held && spot.point.distanceTo(foot.to) < 0.02 * size)) {
        foot.to.copy(spot.point);
        foot.toNormal.copy(spot.normal);
        foot.on.t = spot.t;
        foot.on.u = spot.u;
        foot.on.inside = spot.inside;
        foot.step = 0;
        foot.count++;
        foot.held = true;
        foot.since = 0;
        this.fouled[k] = false;
        this.before[k].live = false;
        stepping = true;
      } else if (!spot && foot.held && (this.walled[k] || this.fouled[k] || foot.to.distanceTo(hip) > reach * 0.98)) {
        // Nothing better to hold, and a wall has come between it and the hold it has, or the hold is out of its
        // reach: it lets go and draws the leg in, rather than reach through the shell or be drawn short of its hold.
        foot.held = false;
        this.walled[k] = false;
        this.fouled[k] = false;
      }
    }
    let planted = 0;
    for (let k = 2; k < 6; k++) {
      const foot = this.feet[k];
      foot.reached = foot.held && foot.step >= 1;
      if (foot.reached) planted++;
    }
    return planted;
  }
}

// A critically damped spring, stepped exactly.
function springStep(x: number, state: { v: number }, to: number, omega: number, dt: number) {
  const d = x - to;
  const temp = (state.v + omega * d) * dt;
  const e = Math.exp(-omega * dt);
  state.v = (state.v - omega * temp) * e;
  return to + (d + temp) * e;
}
