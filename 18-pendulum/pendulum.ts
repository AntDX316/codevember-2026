import * as THREE from "three/webgpu";

// The swing and the paint that falls from it, worked out on the processor.
//
// The can hangs from a rope tied to a beam overhead: a spherical pendulum, the rope's end kept on a sphere round the
// pivot each step, so a push sideways makes an ellipse that turns slowly about itself and shrinks as the air slows it, the
// way a real one draws a spirograph. Paint runs from a hole in the can's base by Torricelli's law, faster the fuller the
// can, falling as a stream of small parcels each carrying its share of the flow; a parcel keeps the can's speed as it
// leaves and falls freely, so the stream curves behind a swinging can, thins as it stretches and lands where the paint
// really would.

// The canvas, and the pivot hanging over its middle.
export const CANVAS = 1.4;
// It stands on a turntable, its face about four inches (10 cm) up, so it can turn and has an edge to drip from.
export const FACE = 0.124;
// The stretcher's depth, and how high the turntable stands under it.
export const STRETCHER = 0.022;
export const STAND = FACE - STRETCHER;
export const PIVOT = new THREE.Vector3(0, 2.75, 0);
// The rope, from the pivot to the can's bail; the can below it, and the hole in its base.
export const ROPE = 2.06;
export const CAN = { radius: 0.085, height: 0.19, bail: 0.04 };

// What hangs: a paint can with one hole in the middle of its base, or a wide plastic bucket with three or five holes
// round its base, which flings out as many streams when it spins. Each hole is the size of the can's. Or the three-hole
// bucket with one long thin slot across its base instead, like the outline of a pencil, slot metres long: it pours a
// sheet, share times a round hole's flow, falling as a flat ribbon and laying a band as wide as the slot, turned as
// the bucket is.
export type VesselName = "can" | "three" | "five" | "slot";
export type Vessel = { top: number; bottom: number; height: number; bail: number; holes: number; ring: number; slot?: number; share?: number };
export const VESSELS: Record<VesselName, Vessel> = {
  can: { top: CAN.radius, bottom: CAN.radius, height: CAN.height, bail: CAN.bail, holes: 1, ring: 0 },
  three: { top: 0.15, bottom: 0.13, height: 0.24, bail: 0.08, holes: 3, ring: 0.085 },
  five: { top: 0.19, bottom: 0.165, height: 0.305, bail: 0.1, holes: 5, ring: 0.108 },
  slot: { top: 0.15, bottom: 0.13, height: 0.24, bail: 0.08, holes: 1, ring: 0, slot: 0.12, share: 4 }
};
// The five-hole bucket is the three-hole one made bigger, every measure by the same amount.
export const BIGGER = VESSELS.five.top / VESSELS.three.top;

// The swing is done once it would only go on drawing smaller and smaller rings on top of each other: when it reaches
// no further out than this, the paint stops before it builds a heap in the middle.
const DONE = 0.14;
const G = 9.81;
const STEP = 1 / 240;

// axis: for the slot, half the sheet's width along it, the way the slot lay when the paint left it (else zero).
export type Parcel = { p: THREE.Vector3; v: THREE.Vector3; volume: number; born: number; alive: boolean; stream: number; axis: THREE.Vector3 };
export type Landing = { x: number; z: number; volume: number; vx: number; vz: number; ax: number; az: number; floor: boolean };

// How far round the canvas the floor's paint is simulated, a square this wide.
export const FLOOR = 5;

export class Pendulum {
  // The rope's end (the can's bail), and its speed.
  end = new THREE.Vector3(0, PIVOT.y - ROPE, 0);
  velocity = new THREE.Vector3();
  held = false;
  // How full the can is, 0 to 1, and how freely paint runs: the hole's size as an area in square metres.
  level = 1;
  hole = 2.2e-5;
  vessel: Vessel = VESSELS.can;
  // How far the vessel has turned about the rope, and how fast it turns (radians a second).
  turn = 0;
  spin = 0;
  // The canvas on its turntable: how far round it has gone, and how fast it turns (radians a second).
  canvasTurn = 0;
  canvasSpin = 0;
  // Stopped pouring because the swing has died down; a new throw starts it again.
  finished = false;
  // Waiting for its first toss: it sways gently with a thumb over the hole, and nothing pours until it is thrown.
  waiting = true;
  // Paused by the visitor: a thumb over the hole while it goes on swinging.
  paused = false;
  // Where the hand is drawing the can to while it is held.
  target = new THREE.Vector3();
  // How quickly the air slows the swing, per second.
  drag = 0.035;
  // The stream: parcels in flight, oldest first, in a ring.
  parcels: Parcel[] = [];
  landings: Landing[] = [];
  time = 0;
  private carry = 0;
  private sinceParcel = 0;
  // How the can was moving while held, for the throw when let go.
  private trail: { t: number; p: THREE.Vector3 }[] = [];
  // Where each stream's last parcel came down, and which parcel it was, for the way the line runs on from there.
  private last: { x: number; z: number; born: number; floor: boolean }[] = [];

  constructor(capacity = 2600) {
    for (let i = 0; i < capacity; i++) this.parcels.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), volume: 0, born: 0, alive: false, stream: 0, axis: new THREE.Vector3() });
  }

  // From the rope's end down to the base.
  get drop() {
    return this.vessel.bail + this.vessel.height;
  }

  // The middle of the base: straight on down the rope's line from its end.
  nozzle(out: THREE.Vector3) {
    return out.subVectors(this.end, PIVOT).normalize().multiplyScalar(this.drop).add(this.end);
  }

  // The vessel's own axes as it hangs and turns: y up the rope, x and z across its base.
  frame(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) {
    y.subVectors(PIVOT, this.end).normalize();
    const e1 = scratch.g.crossVectors(y, Z).normalize();
    const e2 = scratch.h.crossVectors(y, e1);
    x.copy(e1).multiplyScalar(Math.cos(this.turn)).addScaledVector(e2, Math.sin(this.turn));
    z.crossVectors(x, y);
  }

  // Hole k in the base, in the world.
  holeAt(k: number, out: THREE.Vector3) {
    const { x, y, z } = axes;
    this.frame(x, y, z);
    const a = (k / this.vessel.holes) * Math.PI * 2;
    return this.nozzle(out).addScaledVector(x, Math.cos(a) * this.vessel.ring).addScaledVector(z, Math.sin(a) * this.vessel.ring);
  }

  // How far out the swing would reach now, from where it is and how fast it goes, as for a simple pendulum.
  get reach() {
    const x = this.end.x - PIVOT.x;
    const z = this.end.z - PIVOT.z;
    const v2 = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    return Math.sqrt(x * x + z * z + (v2 * ROPE) / G);
  }

  // Held: the can goes where the hand puts it, on the rope's sphere, never more than about 55 degrees out.
  hold(toward: THREE.Vector3) {
    const d = scratch.a.subVectors(toward, PIVOT);
    if (d.y > -0.2) d.y = -0.2;
    d.normalize();
    const most = Math.cos(THREE.MathUtils.degToRad(55));
    if (-d.y < most) {
      const flat = Math.hypot(d.x, d.z) || 1;
      const s = Math.sqrt(1 - most * most) / flat;
      d.set(d.x * s, -most, d.z * s);
    }
    // Only where the hand wants it: the can eases there each step (below), so it never jumps.
    this.target.copy(PIVOT).addScaledVector(d, ROPE);
  }

  // Let go: off with whatever speed the hand was giving it, tangent to the sphere, held to a sensible most.
  release() {
    this.held = false;
    this.finished = false;
    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    if (first && last && last.t > first.t) {
      this.velocity.subVectors(last.p, first.p).divideScalar(last.t - first.t);
      const radial = scratch.a.subVectors(this.end, PIVOT).normalize();
      this.velocity.addScaledVector(radial, -this.velocity.dot(radial));
      const speed = this.velocity.length();
      if (speed > 3.2) this.velocity.multiplyScalar(3.2 / speed);
    }
    this.trail.length = 0;
    // Only a real toss starts the paint: let go with barely a swing and it goes back to waiting.
    this.waiting = this.reach < DONE;
    return !this.waiting;
  }

  // Back to waiting: a small, slow sway, a little out of round so it reads as alive, kept going without losing height.
  // Paint still falling is gone too, so none lands on a fresh canvas.
  rest() {
    for (const parcel of this.parcels) parcel.alive = false;
    this.last.length = 0;
    this.waiting = true;
    this.finished = false;
    this.held = false;
    const out = scratch.a.set(0.07, 0, 0);
    out.y = -Math.sqrt(ROPE * ROPE - out.x * out.x);
    this.end.copy(PIVOT).add(out);
    this.velocity.set(0, 0, 0.07 * Math.sqrt(G / ROPE) * 0.55);
  }

  grab() {
    this.held = true;
    this.trail.length = 0;
    this.target.copy(this.end);
  }

  // One step of the swing, as a free spherical pendulum: gravity and the air's drag, then back onto the sphere, the
  // speed along the rope taken away.
  private swing(dt: number, end = this.end, velocity = this.velocity) {
    velocity.y -= G * dt;
    if (!this.waiting) velocity.multiplyScalar(1 - this.drag * dt);
    end.addScaledVector(velocity, dt);
    const r = scratch.b.subVectors(end, PIVOT);
    r.multiplyScalar(ROPE / r.length());
    end.copy(PIVOT).add(r);
    r.normalize();
    velocity.addScaledVector(r, -velocity.dot(r));
  }

  // Where the hole will pass over the canvas in the next few seconds, if let go now with this throw: for the aim line.
  predict(seconds: number, every: number, out: THREE.Vector3[]) {
    const end = scratch.c.copy(this.end);
    const velocity = scratch.d.set(0, 0, 0);
    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    if (first && last && last.t > first.t) velocity.subVectors(last.p, first.p).divideScalar(last.t - first.t);
    let n = 0;
    const steps = Math.round(seconds / STEP);
    for (let k = 0; k < steps && n < out.length; k++) {
      this.swing(STEP, end, velocity);
      if (k % every === 0) {
        out[n++].subVectors(end, PIVOT).normalize().multiplyScalar(this.drop).add(end);
      }
    }
    return n;
  }

  // On by a frame, in fixed steps. Paint runs only while the can hangs free: held, a thumb is over the hole.
  update(delta: number) {
    this.landings.length = 0;
    this.carry = Math.min(this.carry + delta, STEP * 12);
    const nozzle = scratch.e;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      this.time += STEP;
      if (!this.held) this.swing(STEP);
      else {
        // Held: drawn smoothly after the hand, back onto the rope's sphere, its path kept for the throw.
        this.end.lerp(this.target, 1 - Math.exp(-STEP * 14));
        this.end.sub(PIVOT).setLength(ROPE).add(PIVOT);
        this.velocity.set(0, 0, 0);
        this.trail.push({ t: this.time, p: this.end.clone() });
        while (this.trail.length > 2 && this.time - this.trail[0].t > 0.12) this.trail.shift();
      }
      this.turn += this.spin * STEP;
      this.canvasTurn += this.canvasSpin * STEP;
      if (!this.held && !this.waiting && !this.finished && this.reach < DONE) this.finished = true;
      // Torricelli: the paint leaves as fast as it would fall the depth of paint in the vessel.
      const vessel = this.vessel;
      const depth = this.level * vessel.height * 0.85;
      const out = Math.sqrt(2 * G * Math.max(depth, 0));
      const flow = this.held || this.waiting || this.finished || this.paused || this.level <= 0 ? 0 : this.hole * out * (vessel.share ?? 1);
      this.sinceParcel += STEP;
      // A parcel from every hole every step while it runs, carrying the paint that left in that time.
      if (flow > 0 && this.sinceParcel >= STEP) {
        this.sinceParcel = 0;
        const along = scratch.f.subVectors(PIVOT, this.end).normalize().negate();
        const wide = (vessel.top + vessel.bottom) / 2;
        for (let k = 0; k < vessel.holes; k++) {
          const parcel = this.free();
          if (!parcel) break;
          this.holeAt(k, nozzle);
          // The vessel's own speed at the hole, as it swings and turns, and the paint's speed out of it.
          parcel.p.copy(nozzle);
          const off = scratch.a.copy(nozzle).sub(this.nozzle(scratch.b));
          parcel.v.copy(this.velocity).addScaledVector(along, out * 0.6).add(scratch.b.crossVectors(along, off).multiplyScalar(-this.spin));
          parcel.volume = flow * STEP;
          parcel.born = this.time;
          parcel.alive = true;
          parcel.stream = k;
          parcel.axis.set(0, 0, 0);
          if (vessel.slot) {
            this.frame(parcel.axis, scratch.a, scratch.b);
            parcel.axis.multiplyScalar(vessel.slot / 2);
          }
          this.level = Math.max(0, this.level - parcel.volume / (Math.PI * wide * wide * vessel.height * 0.85));
        }
      }
      // The parcels fall freely, and land on the canvas (or the floor round it).
      for (const parcel of this.parcels) {
        if (!parcel.alive) continue;
        parcel.v.y -= G * STEP;
        parcel.p.addScaledVector(parcel.v, STEP);
        // Over the canvas it lands on the canvas; past its edge it falls on to the floor.
        // The canvas may be turning on its turntable: where the parcel comes down on it, and how fast it moves across
        // it, in the canvas's own turning frame.
        const local = scratch.c.copy(parcel.p).applyAxisAngle(Y, -this.canvasTurn);
        const onCanvas = Math.abs(local.x) < CANVAS / 2 + 0.01 && Math.abs(local.z) < CANVAS / 2 + 0.01;
        const height = onCanvas ? FACE : 0;
        if (parcel.p.y <= height) {
          parcel.alive = false;
          // A step ends with the parcel a little under the surface. It is put back to where it went through, and the
          // canvas to where it had turned to by then: left where the step ended, each would lie up to a step's flight
          // too far along its own way, a little less each time and then a whole step again, and where the line curves
          // that shows as small steps sideways and a jump back.
          const past = parcel.v.y < 0 ? THREE.MathUtils.clamp((parcel.p.y - height) / parcel.v.y, 0, STEP) : 0;
          const at = scratch.c.copy(parcel.p).addScaledVector(parcel.v, -past);
          const floor = !onCanvas;
          if (floor && !(Math.abs(at.x) < FLOOR / 2 && Math.abs(at.z) < FLOOR / 2)) continue;
          const turned = this.canvasTurn - this.canvasSpin * past;
          const moving = scratch.d.set(parcel.v.x, 0, parcel.v.z);
          const axis = scratch.e.copy(parcel.axis).setY(0);
          if (onCanvas) {
            // On the canvas: where it comes down, and how fast it moves across it, in the canvas's own turning frame.
            moving.set(parcel.v.x - this.canvasSpin * at.z, 0, parcel.v.z + this.canvasSpin * at.x).applyAxisAngle(Y, -turned);
            axis.applyAxisAngle(Y, -turned);
            at.applyAxisAngle(Y, -turned);
          }
          // The paint is drawn out along the line it is laying: from the stream's parcel before to this one, a step
          // apart as they left. Its own flight points off to one side of that wherever the swing curves. Only the first
          // of a stream, or one after a break, has nothing to go by but its flight.
          const before = this.last[parcel.stream];
          if (before && before.floor === floor && Math.abs(parcel.born - before.born) < STEP * 1.5) moving.set((at.x - before.x) / STEP, 0, (at.z - before.z) / STEP);
          this.last[parcel.stream] = { x: at.x, z: at.z, born: parcel.born, floor };
          this.landings.push({ x: at.x, z: at.z, volume: parcel.volume, vx: moving.x, vz: moving.z, ax: axis.x, az: axis.z, floor });
        }
      }
    }
  }

  // A parcel not in flight, looked for from where the last one was found, so a long ring is not searched from the start.
  private cursor = 0;
  private free() {
    const n = this.parcels.length;
    for (let i = 0; i < n; i++) {
      const parcel = this.parcels[(this.cursor + i) % n];
      if (!parcel.alive) {
        this.cursor = (this.cursor + i + 1) % n;
        return parcel;
      }
    }
    return undefined;
  }

  // Speed of the can, for the sound and the aim.
  get speed() {
    return this.velocity.length();
  }
}

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), g: new THREE.Vector3(), h: new THREE.Vector3() };
const axes = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
