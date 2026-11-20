import * as THREE from "three/webgpu";

// The egg the fluid rests as, and how far a pulled tendril may reach. Shared by the shader and the picking here.
export const RX = 0.74;
export const RY = 1;
export const TAPER = 0.07;
// How wide a tendril's foot is: the spread of its weight, in 1 - cos(angle) from where it is pulled.
export const FOOT = 0.03;
export const RIPPLES = 4;
const REACH = 1.45;

const LIGHT_SPRING = { stiff: 38, damp: 4.5 };

// The point of the resting egg in direction `s`, which is a unit vector of the sphere it is stretched from.
export function eggPoint(s: THREE.Vector3, out: THREE.Vector3) {
  const rx = RX * (1 - s.y * TAPER);
  return out.set(s.x * rx, s.y * RY, s.z * rx);
}

export function eggNormal(s: THREE.Vector3, out: THREE.Vector3) {
  const rx = RX * (1 - s.y * TAPER);
  return out.set(s.x / rx, s.y / RY, s.z / rx).normalize();
}

type Events = {
  sizzle: (strength: number, pan: number) => void;
};

const up = new THREE.Vector3();
const turn = new THREE.Quaternion();
const goalDir = new THREE.Vector3();
const scaledO = new THREE.Vector3();
const scaledD = new THREE.Vector3();
const offset = new THREE.Vector3();
const normal = new THREE.Vector3();
const aim = new THREE.Vector3();

// Everything that moves, worked out on the CPU: a handful of springs, which the shader turns into a few hundred thousand
// points of surface. Springs are underdamped on purpose, so that every change arrives with a little jelly in it.
export class Ferro {
  time = 0;
  // The invisible magnet, swinging slowly to and fro on the eye's side of the egg, so the crown is mostly in view.
  magnet = Math.PI / 2;
  // Where the eye is, round the egg, followed lazily so that orbiting carries the magnet along without a jump.
  eyeAngle = Math.PI / 2;
  magnetDir = new THREE.Vector3(0, 0, 1);
  // Where the field comes from, and the lattice frame it carries: spikes ride on this frame, so turning it is what makes
  // them crawl.
  fieldDir = new THREE.Vector3(0.3, 0.1, 1).normalize();
  axis = this.fieldDir.clone();
  t1 = new THREE.Vector3();
  t2 = new THREE.Vector3();
  // Spike height, which starts at nothing so that the first thing seen is the crown rising.
  level = 0;
  levelSpeed = 0;
  reach = -0.2;
  lean = 0.12;
  count = 600;
  // How much the pointer is felt, from 0 to a little over 1 while held.
  presence = 0;
  pointerDir = new THREE.Vector3(0, 0, 1);
  hoverPoint = new THREE.Vector3(0, 0, 2);
  proximity = 0;
  // The tendril: where it leaves the egg, the egg point there, its tip, and how far out along it the fluid is.
  anchorDir = new THREE.Vector3(0, 0, 1);
  anchor = new THREE.Vector3(0, 0, RX);
  tip = new THREE.Vector3(0, 0, RX);
  tipSpeed = new THREE.Vector3();
  goal = new THREE.Vector3(0, 0, RX);
  pulled = 0;
  pulledSpeed = 0;
  grabbing = false;
  // Quiet after a release, so it melts all the way back before the pointer is felt again.
  calm = 0;
  wobble = 0;
  wobbleSpeed = 0;
  wobbleAxis = new THREE.Vector3(0, 1, 0);
  slam = 0;
  ripples = Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, 0, -100));
  nextRipple = 0;
  lastSizzle = 0;

  constructor(private events: Events) {
    this.t1.set(1, 0, 0).sub(this.axis.clone().multiplyScalar(this.axis.x)).normalize();
    this.t2.crossVectors(this.axis, this.t1);
  }

  // The pointer, as a ray, or null when it is off the canvas.
  point(ray: THREE.Ray | null) {
    if (!ray) {
      this.proximity = 0;
      return;
    }
    // Into the egg's own space, where it is a unit sphere.
    scaledO.set(ray.origin.x / RX, ray.origin.y / RY, ray.origin.z / RX);
    scaledD.set(ray.direction.x / RX, ray.direction.y / RY, ray.direction.z / RX);
    const dd = scaledD.dot(scaledD);
    const along = Math.max(0, -scaledO.dot(scaledD) / dd);
    offset.copy(scaledO).addScaledVector(scaledD, along);
    const miss = offset.length();
    if (miss < 1) {
      const into = along - Math.sqrt((1 - miss * miss) / dd);
      offset.copy(scaledO).addScaledVector(scaledD, into);
    }
    if (offset.lengthSq() < 1e-8) return;
    this.pointerDir.copy(offset).normalize();
    this.hoverPoint.copy(ray.origin).addScaledVector(ray.direction, along);
    this.proximity = THREE.MathUtils.smoothstep(2.3 - miss, 0, 1.3);
  }

  // Distance along the ray to the egg, a little fattened for its spikes.
  pick(ray: THREE.Ray) {
    const grow = 1.1;
    scaledO.set(ray.origin.x / (RX * grow), ray.origin.y / (RY * grow), ray.origin.z / (RX * grow));
    scaledD.set(ray.direction.x / (RX * grow), ray.direction.y / (RY * grow), ray.direction.z / (RX * grow));
    const a = scaledD.dot(scaledD);
    const b = scaledO.dot(scaledD);
    const c = scaledO.dot(scaledO) - 1;
    const h = b * b - a * c;
    if (h < 0) return null;
    const t = (-b - Math.sqrt(h)) / a;
    return t > 0 ? t : null;
  }

  grab(point: THREE.Vector3) {
    this.grabbing = true;
    this.anchorDir.set(point.x / RX, point.y / RY, point.z / RX).normalize();
    eggPoint(this.anchorDir, this.anchor);
    this.goal.copy(point);
    // A tendril left over from the last pull would jump; the new one grows from where the pointer landed.
    if (Math.abs(this.pulled) < 0.2) {
      this.tip.copy(this.anchor);
      this.tipSpeed.set(0, 0, 0);
    }
  }

  drag(point: THREE.Vector3) {
    this.goal.copy(point);
  }

  // Lets go: the tendril springs back, the egg squashes along it and a ripple runs out from its foot. Returns how far it was pulled.
  release() {
    this.grabbing = false;
    const stretch = this.tip.distanceTo(this.anchor) * Math.max(0, this.pulled);
    this.calm = 1.6;
    this.wobbleAxis.copy(this.anchorDir);
    this.wobbleSpeed -= 0.75 * stretch;
    this.levelSpeed -= 1.5;
    this.ripple(this.anchorDir, 0.012 + 0.016 * Math.min(stretch, 1.4));
    return stretch;
  }

  // Every spike stands up at once, harder than the field can hold, and then sags back.
  slamDown() {
    this.slam = 1;
    this.levelSpeed += 7;
    this.wobbleAxis.copy(this.fieldDir);
    this.wobbleSpeed += 0.55;
    this.ripple(this.fieldDir, 0.022);
    this.ripple(goalDir.copy(this.fieldDir).negate(), 0.014);
  }

  ripple(dir: THREE.Vector3, amount: number) {
    const slot = this.ripples[this.nextRipple++ % RIPPLES];
    slot.set(dir.x * amount, dir.y * amount, dir.z * amount, this.time);
  }

  update(rawDelta: number, field: number, density: number, most: number, eye: number) {
    const delta = Math.min(rawDelta, 1 / 20);
    this.time += delta;
    this.calm = Math.max(0, this.calm - delta);
    this.slam *= Math.exp(-delta * 1.3);

    // The magnet sweeps about 50 degrees either side of a three-quarter view, once every half minute, bobbing a little.
    const eyeGap = Math.atan2(Math.sin(eye - this.eyeAngle), Math.cos(eye - this.eyeAngle));
    this.eyeAngle += eyeGap * (1 - Math.exp(-delta * 0.8));
    this.magnet = this.eyeAngle - 0.35 + Math.sin(this.time * 0.21) * 0.85;
    this.magnetDir.set(Math.cos(this.magnet), 0.22 + Math.sin(this.time * 0.13) * 0.35, Math.sin(this.magnet)).normalize();

    // How much the pointer is felt: fully while held, by nearness while it hovers, and not at all just after a release.
    const want = this.grabbing ? 1.25 : this.calm > 0 ? 0 : this.proximity;
    this.presence += (want - this.presence) * (1 - Math.exp(-delta * (want > this.presence ? 3.2 : 1.8)));
    const felt = Math.min(1, this.presence);

    // The tendril. While held, its foot slides over the egg towards the pointer, the way the fluid creeps to a magnet.
    if (this.grabbing) {
      goalDir.set(this.goal.x / RX, this.goal.y / RY, this.goal.z / RX);
      if (goalDir.lengthSq() > 1e-6) this.anchorDir.lerp(goalDir.normalize(), 1 - Math.exp(-delta * 2.2)).normalize();
    } else if (this.calm <= 0 && this.proximity > 0.01) {
      this.anchorDir.lerp(this.pointerDir, 1 - Math.exp(-delta * 4)).normalize();
      this.goal.copy(this.hoverPoint);
    }
    eggPoint(this.anchorDir, this.anchor);
    eggNormal(this.anchorDir, normal);
    offset.subVectors(this.goal, this.anchor);
    // Never into the egg, and further out it gives less and less, as if the fluid were running out.
    const inward = offset.dot(normal);
    if (inward < 0) offset.addScaledVector(normal, -inward * 0.9);
    const length = offset.length();
    if (length > REACH * 0.7) offset.multiplyScalar((REACH * 0.7 + (REACH * 0.3) * Math.tanh((length - REACH * 0.7) / (REACH * 0.3))) / length);
    aim.copy(this.anchor).add(offset);
    // Gripped, it follows firmly; let go, it bounces back past the egg and out again before it settles.
    const pull = this.grabbing ? 1 : this.calm > 0 ? 0 : 0.22 * this.proximity;
    const stiff = this.grabbing ? 50 : 72;
    const damp = this.grabbing ? 9 : 3.2;
    for (let step = 0; step < 2; step++) {
      const h = delta / 2;
      this.tipSpeed.addScaledVector(offset.subVectors(aim, this.tip), 140 * h).multiplyScalar(Math.exp(-17 * h));
      this.tip.addScaledVector(this.tipSpeed, h);
      this.pulledSpeed += ((pull - this.pulled) * stiff - this.pulledSpeed * damp) * h;
      this.pulled += this.pulledSpeed * h;
    }

    // Spike height: the magnet's crown at rest, more under the pointer, more still while pulled, a lot while slammed.
    const heightGoal = this.calm > 0 ? field * 0.1 : field * (0.75 + 0.5 * felt + (this.grabbing ? 0.3 : 0)) + this.slam * (0.5 + field * 0.6);
    let rising = 0;
    for (let step = 0; step < 2; step++) {
      const h = delta / 2;
      this.levelSpeed += ((heightGoal - this.level) * LIGHT_SPRING.stiff - this.levelSpeed * LIGHT_SPRING.damp) * h;
      this.level = Math.max(-0.14, this.level + this.levelSpeed * h);
      rising = Math.max(rising, this.levelSpeed);
    }
    this.wobbleSpeed += (-this.wobble * 46 - this.wobbleSpeed * 1.7) * delta;
    this.wobble += this.wobbleSpeed * delta;

    // The crown gathers under the pointer, and spikes lean in towards it.
    this.reach += (THREE.MathUtils.lerp(-0.2, 0.3, felt) - this.reach) * (1 - Math.exp(-delta * 2.5));
    this.lean += (0.1 + 0.42 * felt - this.lean) * (1 - Math.exp(-delta * 3));
    this.count += (THREE.MathUtils.lerp(240, most, density * density * 0.4 + density * 0.6) - this.count) * (1 - Math.exp(-delta * 2.5));

    // Where the field comes from: the magnet, swung round towards the pointer as it is felt.
    goalDir.copy(this.magnetDir).multiplyScalar(Math.max(0, 1 - felt));
    if (this.grabbing) {
      up.set(this.tip.x / RX, this.tip.y / RY, this.tip.z / RX);
      if (up.lengthSq() > 1e-6) goalDir.addScaledVector(up.normalize(), 2.4 * this.presence);
    } else goalDir.addScaledVector(this.pointerDir, 2.2 * felt);
    if (goalDir.lengthSq() < 1e-6) goalDir.copy(this.fieldDir);
    goalDir.normalize();
    // Straight across would pass through nothing; go round instead.
    if (goalDir.dot(this.fieldDir) < -0.95) goalDir.add(up.set(-this.fieldDir.z, 0.3, this.fieldDir.x)).normalize();
    this.fieldDir.lerp(goalDir, 1 - Math.exp(-delta * (1.2 + 2.4 * felt))).normalize();

    // Carries the lattice frame round with the field without twisting it, then turns it slowly about the field, so that
    // even with nothing touched the crown is always creeping.
    turn.setFromUnitVectors(this.axis, this.fieldDir);
    this.t1.applyQuaternion(turn);
    this.axis.copy(this.fieldDir);
    turn.setFromAxisAngle(this.axis, delta * 0.06);
    this.t1.applyQuaternion(turn);
    this.t1.addScaledVector(this.axis, -this.t1.dot(this.axis)).normalize();
    this.t2.crossVectors(this.axis, this.t1);

    if (rising > 0.35 && this.time - this.lastSizzle > 0.24) {
      this.lastSizzle = this.time;
      this.events.sizzle(Math.min(1, rising / 5), this.fieldDir.x);
    }
  }
}
