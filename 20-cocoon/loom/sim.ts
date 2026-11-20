import * as THREE from "three/webgpu";

// The frame: two small brass rings at the ends and a wide one round the waist. Every string runs from the top ring down
// through an eyelet in the waist ring to the bottom ring, so each is two straight spans that ring on their own. Straight
// lines between turned rings are what make string art curve: twist an end ring against the waist and its half rounds
// over into a cocoon's shoulder, then pinches, then crosses itself in a point.
export const TOP_Y = 1.1;
export const BOTTOM_Y = -1.1;
export const END_RADIUS = 0.44;
export const WAIST_RADIUS = 0.88;
export const RING_TUBE = [0.034, 0.026, 0.034];
const RADII = [END_RADIUS, WAIST_RADIUS, END_RADIUS];
const HEIGHTS = [TOP_Y, 0, BOTTOM_Y];
// At rest the end rings are turned about as far as rounds each half over without a neck: a cocoon.
const REST = [1.05, 0, -1.05];
// How far an end ring may turn against the waist before the strings, crossing at the middle, push it back.
const LIMIT = Math.PI * 0.98;
const STRETCH = 0.3;

// Vibration is a few standing-wave modes per span, in two directions across it. Each mode is kept as a complex number
// that turns and shrinks every frame, which is exact at any frame rate however fast the mode.
export const MODES = 4;

export type ScaleName = "pentatonic" | "wholeTone" | "hirajoshi" | "lydian";
const SCALES: Record<ScaleName, number[]> = {
  pentatonic: [0, 2, 4, 7, 9],
  wholeTone: [0, 2, 4, 6, 8, 10],
  hirajoshi: [0, 2, 3, 7, 8],
  lydian: [0, 2, 4, 6, 7, 9, 11]
};
// The pluck sound rings at 330 Hz at pitch 1. The lower spans start on G3, the upper an octave over them, in G to sit with
// the shimmer bed.
const ROOT = 196 / 330;

type Ring = {
  angle: number;
  velocity: number;
  held: boolean;
  target: number;
  lift: number;
  liftVelocity: number;
  liftTarget: number;
};

export type Pluck = { pitch: number; gain: number; pan: number; size: number };

export class Loom {
  readonly count: number;
  readonly spans: number;
  rings: Ring[] = RADII.map((_, i) => ({ angle: REST[i], velocity: 0, held: false, target: REST[i], lift: 0, liftVelocity: 0, liftTarget: 0 }));
  homing = false;
  // Span ends, both directions across each, and the modes: per span and mode, u then w, each a real and imaginary part.
  ends: Float32Array;
  axes: Float32Array;
  modes: Float32Array;
  flash: Float32Array;
  glow: Float32Array;
  pitch: Float32Array;
  hue: Float32Array;
  restLength: Float32Array;
  private side: Float32Array;
  private sideKnown = false;
  // The total ring of every string, for the floor's glow and the shimmer bed.
  energy = 0;
  // Turning since the last creak, and how fast.
  creak = { turned: 0, speed: 0 };

  constructor(count: number, scale: ScaleName) {
    this.count = count;
    this.spans = count * 2;
    this.ends = new Float32Array(this.spans * 6);
    this.axes = new Float32Array(this.spans * 6);
    this.modes = new Float32Array(this.spans * MODES * 4);
    this.flash = new Float32Array(this.spans);
    this.glow = new Float32Array(this.spans);
    this.pitch = new Float32Array(this.spans);
    this.hue = new Float32Array(this.spans);
    this.restLength = new Float32Array(this.spans);
    this.side = new Float32Array(this.spans);
    this.tune(scale);
    this.place();
    for (let i = 0; i < this.spans; i++) this.restLength[i] = this.length(i);
  }

  // Each string's note by where it stands round the rings: rising one way round to the far side and falling back, so
  // there is no seam where the top note meets the bottom one. The upper span sounds an octave over the lower.
  tune(scale: ScaleName) {
    const steps = SCALES[scale] ?? SCALES.pentatonic;
    const degrees = steps.length * 2 + 1;
    for (let i = 0; i < this.count; i++) {
      const f = i / this.count;
      const climb = 1 - Math.abs(2 * f - 1);
      const k = Math.round(climb * (degrees - 1));
      const semis = steps[k % steps.length] + 12 * Math.floor(k / steps.length);
      const low = ROOT * Math.pow(2, semis / 12);
      this.pitch[i * 2] = low * 2;
      this.pitch[i * 2 + 1] = low;
      this.hue[i * 2] = this.hue[i * 2 + 1] = k / (degrees - 1);
    }
  }

  radius(ring: number) {
    return RADII[ring];
  }

  height(ring: number) {
    return HEIGHTS[ring] + this.rings[ring].lift;
  }

  private length(span: number) {
    const e = this.ends;
    const o = span * 6;
    return Math.hypot(e[o + 3] - e[o], e[o + 4] - e[o + 1], e[o + 5] - e[o + 2]);
  }

  // Where every span runs now, and the two directions across it that it swings in: one round the cocoon, one out from it.
  private place() {
    const e = this.ends;
    const a = this.axes;
    for (let i = 0; i < this.count; i++) {
      const base = (i / this.count) * Math.PI * 2;
      for (let half = 0; half < 2; half++) {
        const from = half;
        const to = half + 1;
        const span = i * 2 + half;
        const o = span * 6;
        const af = base + this.rings[from].angle;
        const at = base + this.rings[to].angle;
        e[o] = RADII[from] * Math.cos(af);
        e[o + 1] = this.height(from);
        e[o + 2] = RADII[from] * Math.sin(af);
        e[o + 3] = RADII[to] * Math.cos(at);
        e[o + 4] = this.height(to);
        e[o + 5] = RADII[to] * Math.sin(at);
        let dx = e[o + 3] - e[o];
        let dy = e[o + 4] - e[o + 1];
        let dz = e[o + 5] - e[o + 2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
        // Outward from the axis at the span's middle; where it crosses the axis, any level direction will do.
        let rx = e[o] + e[o + 3];
        let rz = e[o + 2] + e[o + 5];
        const rl = Math.hypot(rx, rz);
        if (rl < 1e-4) {
          rx = Math.cos(base);
          rz = Math.sin(base);
        } else {
          rx /= rl;
          rz /= rl;
        }
        // u = dir x out, w = u x dir.
        let ux = dy * rz;
        let uy = dz * rx - dx * rz;
        let uz = -dy * rx;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul;
        uy /= ul;
        uz /= ul;
        a[o] = ux;
        a[o + 1] = uy;
        a[o + 2] = uz;
        a[o + 3] = uy * dz - uz * dy;
        a[o + 4] = uz * dx - ux * dz;
        a[o + 5] = ux * dy - uy * dx;
      }
    }
  }

  grab(ring: number) {
    const r = this.rings[ring];
    r.held = true;
    r.target = r.angle;
    r.liftTarget = r.lift;
    this.homing = false;
  }

  // The held ring is led by the hand, but past the limit it gives only a quarter as much, so it can be wound a little
  // too far and springs back when let go.
  turn(ring: number, by: number, lift: number) {
    const r = this.rings[ring];
    r.target += by;
    const twist = ring === 1 ? 0 : r.target - this.rings[1].angle;
    if (ring !== 1 && Math.abs(twist) > LIMIT) {
      const over = Math.abs(twist) - LIMIT;
      r.target -= Math.sign(twist) * Math.min(over, Math.abs(by)) * 0.75;
    }
    const wanted = r.liftTarget + lift;
    r.liftTarget = Math.abs(wanted) > STRETCH ? Math.sign(wanted) * (STRETCH + (Math.abs(wanted) - STRETCH) * 0.2) : wanted;
  }

  release(ring: number) {
    const r = this.rings[ring];
    r.held = false;
    r.velocity = THREE.MathUtils.clamp(r.velocity, -14, 14);
  }

  reset() {
    this.homing = true;
    this.rings.forEach((r) => (r.held = false));
  }

  update(dt: number) {
    const rings = this.rings;
    const before = rings[0].angle - rings[1].angle;
    const beforeLow = rings[2].angle - rings[1].angle;
    const spin = Math.round(rings[1].angle / (Math.PI * 2)) * Math.PI * 2;
    // Turning: inertia and friction, the strings' push past the limit, and the wind home after a reset.
    const torque = [0, 0, 0];
    for (const end of [0, 2]) {
      const twist = rings[end].angle - rings[1].angle;
      const over = Math.abs(twist) - LIMIT;
      if (over > 0) {
        const push = -Math.sign(twist) * over * 60 - (rings[end].velocity - rings[1].velocity) * 4;
        torque[end] += push;
        torque[1] -= push;
      }
    }
    let settled = true;
    rings.forEach((r, i) => {
      if (this.homing) {
        const off = r.angle - (REST[i] + spin);
        torque[i] += -off * 16 - r.velocity * 2.6;
        if (Math.abs(off) > 0.004 || Math.abs(r.velocity) > 0.01) settled = false;
      }
      if (r.held) {
        const next = r.angle + (r.target - r.angle) * (1 - Math.exp(-dt * 28));
        const v = (next - r.angle) / Math.max(dt, 1e-4);
        r.velocity += (v - r.velocity) * (1 - Math.exp(-dt * 14));
        r.angle = next;
        const nextLift = r.lift + (r.liftTarget - r.lift) * (1 - Math.exp(-dt * 24));
        r.liftVelocity = (nextLift - r.lift) / Math.max(dt, 1e-4);
        r.lift = nextLift;
      } else {
        r.velocity += torque[i] * dt;
        r.velocity *= Math.exp(-dt * (this.homing ? 0 : 0.85));
        r.angle += r.velocity * dt;
        // Stretched or squashed, the strings draw a ring back where it sat, with a little bounce.
        r.liftVelocity += (-r.lift * 70 - r.liftVelocity * 6) * dt;
        r.lift += r.liftVelocity * dt;
      }
    });
    if (this.homing && settled) this.homing = false;

    const turned = Math.abs(rings[0].angle - rings[1].angle - before) + Math.abs(rings[2].angle - rings[1].angle - beforeLow);
    this.creak.turned += turned;
    this.creak.speed = turned / Math.max(dt, 1e-4);

    this.place();
    this.ring(dt);
  }

  // How far the upper span of a string is twisted against the waist, from 0 (straight) to 1 (crossed through the axis).
  twist() {
    return Math.max(Math.abs(this.rings[0].angle - this.rings[1].angle), Math.abs(this.rings[2].angle - this.rings[1].angle)) / Math.PI;
  }

  private ring(dt: number) {
    const m = this.modes;
    let total = 0;
    for (let s = 0; s < this.spans; s++) {
      // Tighter strings swing faster: shown slowed right down, a few times a second, so the wave can be seen.
      const stretch = this.length(s) / this.restLength[s];
      const f1 = 2.4 * Math.pow(this.pitch[s], 0.55) * Math.sqrt(stretch);
      let sum = 0;
      for (let n = 1; n <= MODES; n++) {
        const k = (s * MODES + (n - 1)) * 4;
        if (m[k] === 0 && m[k + 1] === 0 && m[k + 2] === 0 && m[k + 3] === 0) continue;
        const w = Math.PI * 2 * f1 * n * (1 + 0.004 * n * n);
        const decay = Math.exp(-dt * (0.45 + 0.45 * (n - 1)));
        const c = Math.cos(w * dt) * decay;
        const si = Math.sin(w * dt) * decay;
        for (let j = 0; j < 4; j += 2) {
          const re = m[k + j];
          const im = m[k + j + 1];
          m[k + j] = re * c - im * si;
          m[k + j + 1] = re * si + im * c;
        }
        const e2 = m[k] * m[k] + m[k + 1] * m[k + 1] + m[k + 2] * m[k + 2] + m[k + 3] * m[k + 3];
        // Let a mode go once it is far below what can be seen.
        if (e2 < 1e-10) m[k] = m[k + 1] = m[k + 2] = m[k + 3] = 0;
        sum += e2 * n * n;
      }
      this.flash[s] *= Math.exp(-dt * 5);
      const g = Math.min(2, Math.sqrt(sum) / 0.03);
      this.glow[s] = g * 0.8 + this.flash[s] * 0.7;
      total += g;
    }
    this.energy = total;
  }

  // Sets a span ringing as a finger lets go of it at `along` (0 to 1), pulled `amount` units in the world direction given.
  pluck(span: number, along: number, amount: number, dx: number, dy: number, dz: number) {
    const s0 = THREE.MathUtils.clamp(along, 0.08, 0.92);
    const a = this.axes;
    const o = span * 6;
    const du = dx * a[o] + dy * a[o + 1] + dz * a[o + 2];
    const dw = dx * a[o + 3] + dy * a[o + 4] + dz * a[o + 5];
    const dl = Math.hypot(du, dw) || 1;
    const m = this.modes;
    for (let n = 1; n <= MODES; n++) {
      // A string drawn aside at one point is a triangle; these are that triangle's modes.
      const c = (2 * amount * Math.sin(n * Math.PI * s0)) / (n * n * Math.PI * Math.PI * s0 * (1 - s0));
      const k = (span * MODES + (n - 1)) * 4;
      m[k] += (c * du) / dl;
      m[k + 2] += (c * dw) / dl;
    }
    this.flash[span] = 1;
  }

  // Which spans the pointer passed over since the last frame. A ray crosses a span's line exactly where the side of it
  // the ray passes on flips, so this keeps that side for every span and looks for the flip.
  sweep(origin: THREE.Vector3, dir: THREE.Vector3, moved: boolean, found: (span: number, along: number, depth: number) => void) {
    const e = this.ends;
    for (let s = 0; s < this.spans; s++) {
      const o = s * 6;
      const ex = e[o + 3] - e[o];
      const ey = e[o + 4] - e[o + 1];
      const ez = e[o + 5] - e[o + 2];
      const wx = e[o] - origin.x;
      const wy = e[o + 1] - origin.y;
      const wz = e[o + 2] - origin.z;
      // (dir x e) . w
      const side = (dir.y * ez - dir.z * ey) * wx + (dir.z * ex - dir.x * ez) * wy + (dir.x * ey - dir.y * ex) * wz;
      const was = this.side[s];
      this.side[s] = side;
      if (!moved || !this.sideKnown || was * side >= 0) continue;
      // The nearest points of the two lines: along the span, and along the ray.
      const a = ex * ex + ey * ey + ez * ez;
      const b = ex * dir.x + ey * dir.y + ez * dir.z;
      const d = ex * wx + ey * wy + ez * wz;
      const f = dir.x * wx + dir.y * wy + dir.z * wz;
      const den = a - b * b;
      if (den < 1e-8) continue;
      const along = (b * f - d) / den;
      const depth = (a * f - b * d) / den;
      if (along < 0.02 || along > 0.98 || depth <= 0) continue;
      found(s, along, depth);
    }
    this.sideKnown = true;
  }

  forgetSides() {
    this.sideKnown = false;
  }
}
