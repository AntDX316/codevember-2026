import * as THREE from "three/webgpu";

// The bolt, in the rig's own frame: its axis is +x, the head on the left and the threaded tip on the right. Units are
// arbitrary (the bolt is a little over two long); time is real.
export const BOLT = {
  // Thread: major radius, pitch (one turn moves a nut this far), depth of the V.
  radius: 0.2,
  pitch: 0.06,
  depth: 0.034,
  // The head's top face, its underside, where the thread starts and the tip's end face.
  headTop: -1.38,
  headFace: -1.12,
  threadStart: -0.55,
  tip: 1.0
};

// A thing that screws onto the bolt and then flies free: its principal moments of inertia about its centre of mass
// (x along the wings, z down the thread), where its hub runs along the thread from its centre, and how far it reaches.
export type Body = { inertia: THREE.Vector3; hubLo: number; hubHi: number; reach: number };

// Where it sits on the thread at the start, and where it waits in the air once off. The nut starts four turns from the
// end of the thread, so a good flick carries it off in about a second.
const START_TURNS = 4;

const scratch = {
  m: new THREE.Matrix3(),
  q: new THREE.Quaternion(),
  w: new THREE.Vector3(),
  k: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
  t: new THREE.Quaternion(),
  t2: new THREE.Quaternion(),
  v: new THREE.Vector3(),
  a: new THREE.Vector3()
};

// The nut's frame turned so its z runs along the bolt (+x): its x goes to +y and its y to +z, so a turn about its own
// axis is a turn about the bolt's, and an angle round it reads the same in both.
export const ALIGN = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));

export type Mode = "thread" | "free" | "return";

// One spinning thing, on the bolt or off it.
//
// On the thread it has one freedom: its turn θ, which carries it along by the pitch (right-hand thread, so turning it
// anticlockwise seen from the tip unscrews it toward the tip). Off the thread it is a free rigid body: its angular
// momentum L, in the rig's frame, never changes, and its turning is ω = R I⁻¹ Rᵀ L, stepped with RK4 on the
// quaternion 480 times a second. Spun about its middle axis of inertia (the thread's, for a wing nut), the tiny wobble it
// leaves the thread with grows until it turns right over, and back, again and again: the Dzhanibekov effect.
export class Spinner {
  body: Body;
  mode: Mode = "thread";
  // On the thread.
  theta = 0;
  omega = 0;
  s = 0;
  sStart = 0;
  sRelease = 0;
  sHead = 0;
  // Free.
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  momentum = new THREE.Vector3();
  home = new THREE.Vector3();
  held = false;
  // While held: the spin the hand drives about the thing's own axis.
  handSpin = 0;
  // Events this step, for sound and the share moment.
  hitHead = 0;
  leftThread = false;
  flipped = false;
  flips = 0;
  private flipSide = 1;
  // Flying back onto the bolt: from where, and how far through.
  private back = { t: 0, from: new THREE.Vector3(), fromQ: new THREE.Quaternion(), spinTurns: 0 };
  private random: () => number;

  constructor(body: Body, random: () => number) {
    this.body = body;
    this.random = random;
    this.measure();
    this.toStart();
  }

  // The thread's limits for this body: it stops against the head, and comes off once its hub clears the tip.
  private measure() {
    const { hubLo } = this.body;
    this.sRelease = BOLT.tip - hubLo + 0.01;
    // Started a whole number of turns from where the nut's own thread lines up with the bolt's (s = 0).
    this.sStart = Math.round((this.sRelease - START_TURNS * BOLT.pitch) / BOLT.pitch) * BOLT.pitch;
    this.sHead = BOLT.headFace - hubLo;
    // Clear of the bolt's tip by its whole reach, so it can tumble there without touching it.
    this.home.set(BOLT.tip + this.body.reach * 0.85 + BOLT.radius + 0.12, 0.22, -0.1);
  }

  setBody(body: Body) {
    this.body = body;
    this.measure();
    if (this.mode === "thread") this.s = THREE.MathUtils.clamp(this.s, this.sHead, this.sRelease);
  }

  toStart() {
    this.mode = "thread";
    this.s = this.sStart;
    this.theta = (this.s / BOLT.pitch) * Math.PI * 2;
    this.omega = 0;
    this.velocity.set(0, 0, 0);
    this.momentum.set(0, 0, 0);
    this.placeOnThread();
  }

  // Back onto the bolt: it glides to the tip, lines up, and screws itself back on to where it started.
  goBack() {
    if (this.mode === "thread") {
      this.toStart();
      return;
    }
    this.mode = "return";
    this.held = false;
    this.back.t = 0;
    this.back.from.copy(this.position);
    this.back.fromQ.copy(this.quaternion);
    this.momentum.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
  }

  // The thread pose for the current turn.
  private placeOnThread() {
    this.position.set(this.s, 0, 0);
    scratch.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.theta);
    this.quaternion.copy(ALIGN).multiply(scratch.q);
  }

  // ω in the rig's frame from L and the pose.
  angular(q: THREE.Quaternion, L: THREE.Vector3, out: THREE.Vector3) {
    const I = this.body.inertia;
    // Into the body, divide by each moment, and back out.
    scratch.t.copy(q).invert();
    out.copy(L).applyQuaternion(scratch.t);
    out.set(out.x / I.x, out.y / I.y, out.z / I.z);
    return out.applyQuaternion(q);
  }

  // L from a turning ω (rig frame) and the pose.
  momentumFor(q: THREE.Quaternion, omega: THREE.Vector3, out: THREE.Vector3) {
    const I = this.body.inertia;
    scratch.t.copy(q).invert();
    out.copy(omega).applyQuaternion(scratch.t);
    out.set(out.x * I.x, out.y * I.y, out.z * I.z);
    return out.applyQuaternion(q);
  }

  // The body's own axis (its thread) in the rig's frame.
  axis(out: THREE.Vector3) {
    return out.set(0, 0, 1).applyQuaternion(this.quaternion);
  }

  // Off the thread: whatever it was turning at, plus the little wobble the thread's clearance gives it as it lets go.
  private release() {
    this.mode = "free";
    this.leftThread = true;
    const along = (BOLT.pitch / (Math.PI * 2)) * this.omega;
    this.velocity.set(along + Math.sign(along) * 0.03, (this.random() - 0.5) * 0.02, (this.random() - 0.5) * 0.02);
    const w = scratch.w.set(this.omega, 0, 0);
    this.wobble(w, Math.abs(this.omega));
    this.momentumFor(this.quaternion, w, this.momentum);
    this.flipSide = this.axis(scratch.v).dot(this.momentum) >= 0 ? 1 : -1;
  }

  // A small turn about the two cross axes, a few percent of the spin, as a real hand or thread always leaves.
  private wobble(w: THREE.Vector3, spin: number) {
    const axis = this.axis(scratch.v);
    const a = this.random() * Math.PI * 2;
    scratch.a.set(Math.cos(a), Math.sin(a), Math.cos(a * 1.7 + 1));
    scratch.a.addScaledVector(axis, -scratch.a.dot(axis)).normalize();
    w.addScaledVector(scratch.a, spin * (0.012 + this.random() * 0.012));
  }

  // Taken hold of in the air: it stops tumbling in the hand and turns only about its own axis, as the hand drives it.
  grab() {
    this.held = true;
    if (this.mode === "free") {
      const w = this.angular(this.quaternion, this.momentum, scratch.w);
      this.handSpin = w.dot(this.axis(scratch.v));
    } else {
      this.handSpin = this.omega;
    }
  }

  letGo() {
    this.held = false;
    if (this.mode === "thread") this.omega = this.handSpin;
    if (this.mode !== "free") return;
    const axis = this.axis(scratch.v).clone();
    const w = scratch.w.copy(axis).multiplyScalar(this.handSpin);
    this.wobble(w, Math.abs(this.handSpin));
    this.momentumFor(this.quaternion, w, this.momentum);
    this.flipSide = this.axis(scratch.v).dot(this.momentum) >= 0 ? 1 : -1;
  }

  step(dt: number) {
    this.hitHead = 0;
    this.leftThread = false;
    this.flipped = false;
    if (this.mode === "thread") this.stepThread(dt);
    else if (this.mode === "free") this.stepFree(dt);
    else this.stepBack(dt);
  }

  private stepThread(dt: number) {
    if (this.held) {
      this.omega += (this.handSpin - this.omega) * (1 - Math.exp(-dt * 24));
    } else {
      // Weightless, the thread barely bears on the nut: it spins down only slowly.
      this.omega *= Math.exp(-dt * 0.05);
    }
    this.theta += this.omega * dt;
    this.s = (this.theta / (Math.PI * 2)) * BOLT.pitch;
    if (this.s < this.sHead) {
      // Run down against the head: it stops with a clink and kicks back a little.
      this.hitHead = Math.abs(this.omega);
      this.s = this.sHead;
      this.theta = (this.s / BOLT.pitch) * Math.PI * 2;
      this.omega = Math.abs(this.omega) * 0.25;
      if (this.held) this.handSpin = Math.max(this.handSpin, 0);
    }
    this.placeOnThread();
    if (this.s >= this.sRelease) this.release();
  }

  private stepFree(dt: number) {
    const q = this.quaternion;
    if (this.held) {
      // In the hand: held where it was caught, turning only about its own axis at the hand's pace.
      this.velocity.multiplyScalar(Math.exp(-dt * 8));
      this.position.addScaledVector(this.velocity, dt);
      const axis = this.axis(scratch.v);
      const w = this.angular(q, this.momentum, scratch.w);
      const along = w.dot(axis);
      const spin = along + (this.handSpin - along) * (1 - Math.exp(-dt * 24));
      w.copy(axis).multiplyScalar(spin);
      this.momentumFor(q, w, this.momentum);
      this.integrate(dt);
      return;
    }
    // Drawn gently back toward the spot it hovers at, through its centre: a pull there turns nothing, so the tumbling is
    // left exactly as it was.
    scratch.a.subVectors(this.home, this.position).multiplyScalar(1.1).addScaledVector(this.velocity, -1.9);
    this.velocity.addScaledVector(scratch.a, dt);
    // And never back into the bolt.
    const reach = this.body.reach * 0.85;
    const along = THREE.MathUtils.clamp(this.position.x, BOLT.headTop, BOLT.tip);
    scratch.a.set(this.position.x - along, this.position.y, this.position.z);
    const gap = scratch.a.length();
    if (gap < reach + BOLT.radius && gap > 1e-4) {
      // Inside its reach of the bolt: no further in, and a gentle push out (it leaves the thread this close, so no shove).
      const out = scratch.a.normalize();
      const inward = this.velocity.dot(out);
      if (inward < 0) this.velocity.addScaledVector(out, -inward);
      this.velocity.addScaledVector(out, (reach + BOLT.radius - gap) * 1.5 * dt);
    }
    this.position.addScaledVector(this.velocity, dt);
    this.integrate(dt);
    // A flip: its own axis swings from along L to against it. Counted halfway, with room either side so a wobble never
    // counts.
    const L = this.momentum.length();
    if (L > 1e-6) {
      const side = this.axis(scratch.v).dot(this.momentum) / L;
      if (this.flipSide > 0 && side < -0.2) {
        this.flipSide = -1;
        this.flipped = true;
        this.flips++;
      } else if (this.flipSide < 0 && side > 0.2) {
        this.flipSide = 1;
        this.flipped = true;
        this.flips++;
      }
    }
  }

  // RK4 on the quaternion, with L fixed.
  private integrate(dt: number) {
    const q = this.quaternion;
    const L = this.momentum;
    const k = scratch.k;
    const deriv = (from: THREE.Quaternion, out: THREE.Quaternion) => {
      const w = this.angular(from, L, scratch.w);
      // dq/dt = ½ (0, ω) q
      out.set(w.x, w.y, w.z, 0).multiply(from);
      out.set(out.x * 0.5, out.y * 0.5, out.z * 0.5, out.w * 0.5);
      return out;
    };
    const add = (a: THREE.Quaternion, b: THREE.Quaternion, h: number, out: THREE.Quaternion) => out.set(a.x + b.x * h, a.y + b.y * h, a.z + b.z * h, a.w + b.w * h);
    const tmp = scratch.t2;
    deriv(q, k[0]);
    deriv(add(q, k[0], dt / 2, tmp), k[1]);
    deriv(add(q, k[1], dt / 2, tmp), k[2]);
    deriv(add(q, k[2], dt, tmp), k[3]);
    q.set(
      q.x + (dt / 6) * (k[0].x + 2 * k[1].x + 2 * k[2].x + k[3].x),
      q.y + (dt / 6) * (k[0].y + 2 * k[1].y + 2 * k[2].y + k[3].y),
      q.z + (dt / 6) * (k[0].z + 2 * k[1].z + 2 * k[2].z + k[3].z),
      q.w + (dt / 6) * (k[0].w + 2 * k[1].w + 2 * k[2].w + k[3].w)
    ).normalize();
  }

  // Gliding back to the tip and lined up with the thread (0.9 s), then screwing itself on to the start (1.1 s).
  private stepBack(dt: number) {
    const b = this.back;
    b.t += dt;
    const entry = this.sRelease;
    if (b.t < 0.9) {
      const e = 1 - Math.pow(1 - b.t / 0.9, 3);
      this.position.lerpVectors(b.from, scratch.v.set(entry, 0, 0), e);
      // Lined up with the thread at the turn it will meet it on.
      this.theta = (entry / BOLT.pitch) * Math.PI * 2;
      scratch.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.theta);
      const target = scratch.t.copy(ALIGN).multiply(scratch.q);
      this.quaternion.slerpQuaternions(b.fromQ, target, e);
      return;
    }
    const u = Math.min(1, (b.t - 0.9) / 1.1);
    const e = 1 - Math.pow(1 - u, 2.4);
    const before = this.s;
    this.s = entry + (this.sStart - entry) * e;
    this.theta = (this.s / BOLT.pitch) * Math.PI * 2;
    this.omega = (((this.s - before) / BOLT.pitch) * Math.PI * 2) / Math.max(dt, 1e-4);
    this.placeOnThread();
    if (u >= 1) {
      this.mode = "thread";
      this.omega = 0;
    }
  }

  // How fast it turns now, in turns a second, about whatever axis.
  spinRate() {
    if (this.mode !== "free") return Math.abs(this.omega) / (Math.PI * 2);
    return this.angular(this.quaternion, this.momentum, scratch.w).length() / (Math.PI * 2);
  }
}
