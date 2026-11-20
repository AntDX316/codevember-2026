// The cocoon as one unbroken thread. It is kept in the spindle's own frame, so a strand once laid turns with the
// spindle for free, as a ring of points: when the cocoon is full, new silk takes the slots of the oldest, innermost
// turns, which nothing can see any more, and the winding never has to stop. Beyond the last point laid hangs a loose
// end of free particles in the air: winding reels it in, pulling it peels the thread back off.

export type Pattern = "eight" | "helix" | "chaotic";

// The egg the silk is laid on, in units: half its width, and how far it reaches up and down. The first turn lies at
// `inner` of these, clear of the pupa, and the cocoon thickens out to the whole of them as it fills.
export const SHAPE = { width: 0.6, top: 1.0, bottom: 0.88, inner: 0.72 };
// The length of thread between laid points, and between the loose end's particles.
export const STEP = 0.028;
// Where, around the spindle, the thread comes on: a little right of the front.
const FEED = Math.PI / 2 - 0.4;
// How long the loose end is at rest, and the most it can be pulled out to, in particles.
const REST_TAIL = 44;
export const MAX_TAIL = 170;
const HIGHEST = 1.36;

// The spindle's turn applied to a point in its frame, the same way three turns an object about y.
export function toWorld(theta: number, x: number, z: number, out: { x: number; z: number }) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out.x = c * x + s * z;
  out.z = -s * x + c * z;
}

function toSpindle(theta: number, x: number, z: number, out: { x: number; z: number }) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out.x = c * x - s * z;
  out.z = s * x + c * z;
}

// Where the guide leads the thread, as a latitude up the egg and a sway either side of the feed, for how far the
// spindle has turned in all. Every pattern turns at a rate that is no fraction of a whole turn, so each pass lands
// beside the last rather than on it.
function guide(pattern: Pattern, phi: number): [number, number] {
  if (pattern === "helix") {
    // Pole to pole and back over twenty-odd turns, in neat bands, as on a bobbin.
    const sweep = (2 / Math.PI) * Math.asin(Math.sin(phi * 0.021));
    return [HIGHEST * 0.98 * sweep, 0.05 * Math.sin(phi * 3.1)];
  }
  if (pattern === "chaotic") {
    const lat = 1.2 * Math.sin(phi * 0.31 + 1.7 * Math.sin(phi * 0.047)) * (0.78 + 0.22 * Math.sin(phi * 0.13));
    const sway = 0.85 * Math.sin(phi * 0.41 + 2.1 * Math.sin(phi * 0.029)) + 0.22 * Math.sin(phi * 1.7);
    return [Math.max(-HIGHEST, Math.min(HIGHEST, lat)), sway];
  }
  // A figure of eight traced by the guide, so the thread climbs and falls across the egg at a steady slant, crossing
  // its own earlier passes into diamonds.
  const psi = phi * 0.231;
  return [1.28 * Math.sin(psi), 0.6 * Math.sin(2 * psi)];
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export class Spool {
  readonly cap: number;
  // Points in the spindle's frame, and how far along the thread each lies.
  readonly points: Float32Array;
  readonly arc: Float32Array;
  readonly born: Float32Array;
  // One drawn length per slot, from that point to the next: start and its arc; end and its width; when it was laid.
  readonly from: Float32Array;
  readonly to: Float32Array;
  readonly birth: Float32Array;
  head = -1;
  count = 0;
  // Slots ever written, which is how many lengths there are to draw.
  used = 0;
  dirtyFrom = Infinity;
  dirtyTo = -1;

  theta = 0;
  omega = 0;
  phi = 0;
  clock = 0;
  pattern: Pattern = "eight";
  private previous: Pattern = "eight";
  private blendFrom = -1e9;

  // The loose end, in the world: where each particle is and was a step ago.
  readonly tail = new Float32Array(MAX_TAIL * 3);
  readonly last = new Float32Array(MAX_TAIL * 3);
  tailCount = REST_TAIL;
  held = -1;
  readonly hand = { x: 0, y: 0, z: 0 };
  // Lengths laid and peeled since last asked, for the sound.
  laid = 0;
  peeled = 0;
  // How far peeling has turned the spindle since last asked.
  pullTurn = 0;

  private scratch = { x: 0, z: 0 };
  private candidate = new Float32Array(3);

  constructor(cap: number) {
    this.cap = cap;
    this.points = new Float32Array(cap * 3);
    this.arc = new Float32Array(cap);
    this.born = new Float32Array(cap);
    this.from = new Float32Array(cap * 4);
    this.to = new Float32Array(cap * 4);
    this.birth = new Float32Array(cap);
  }

  // How far out the next turn lies, as a share of the full egg.
  shell() {
    return SHAPE.inner + (1 - SHAPE.inner) * Math.pow(Math.min(1, this.count / this.cap), 0.85);
  }

  // Half widths of the egg at a latitude: blunter at the top, a touch pointed below.
  static radii(lat: number) {
    const sin = Math.sin(lat);
    return [SHAPE.width * (1 + 0.06 * sin), sin > 0 ? SHAPE.top : SHAPE.bottom];
  }

  setPattern(pattern: Pattern) {
    if (pattern === this.pattern) return;
    this.previous = this.pattern;
    this.pattern = pattern;
    this.blendFrom = this.phi;
  }

  // Where the guide would put the thread now, in the spindle's frame.
  private aim(phi: number, theta: number, out: Float32Array) {
    let [lat, sway] = guide(this.pattern, phi);
    // A new pattern takes over across a turn or so, rather than flinging a strand across the egg.
    const t = Math.min(1, (phi - this.blendFrom) / 8);
    if (t < 1) {
      const [lat0, sway0] = guide(this.previous, phi);
      const e = t * t * (3 - 2 * t);
      lat = lat0 + (lat - lat0) * e;
      sway = sway0 + (sway - sway0) * e;
    }
    // The thread rises and dips a little as it goes, over and under what is already there.
    const s = this.shell() + 0.011 * Math.sin(phi * 5.3) * Math.sin(phi * 1.37 + 0.6);
    const azimuth = FEED + sway + theta;
    const [w, h] = Spool.radii(lat);
    const ring = s * w * Math.cos(lat);
    out[0] = ring * Math.cos(azimuth);
    out[1] = s * h * Math.sin(lat);
    out[2] = ring * Math.sin(azimuth);
  }

  private mark(slot: number) {
    if (slot < this.dirtyFrom) this.dirtyFrom = slot;
    if (slot > this.dirtyTo) this.dirtyTo = slot;
  }

  // A length from point a to point b, or none, drawn in slot j.
  private length(j: number, a: number, b: number) {
    const p = this.points;
    const f = j * 4;
    this.from[f] = p[a * 3];
    this.from[f + 1] = p[a * 3 + 1];
    this.from[f + 2] = p[a * 3 + 2];
    this.from[f + 3] = this.arc[a];
    if (b < 0) {
      this.to[f] = p[a * 3];
      this.to[f + 1] = p[a * 3 + 1];
      this.to[f + 2] = p[a * 3 + 2];
      this.to[f + 3] = 0;
    } else {
      this.to[f] = p[b * 3];
      this.to[f + 1] = p[b * 3 + 1];
      this.to[f + 2] = p[b * 3 + 2];
      // Each length a little finer or fuller than the next, as real silk is.
      this.to[f + 3] = 0.7 + 0.6 * hash(j);
    }
    this.birth[j] = this.born[b < 0 ? a : b];
    this.mark(j);
  }

  private lay(x: number, y: number, z: number) {
    const k = (this.head + 1) % this.cap;
    const p = this.points;
    p[k * 3] = x;
    p[k * 3 + 1] = y;
    p[k * 3 + 2] = z;
    if (this.head >= 0) {
      const h = this.head * 3;
      const gap = Math.hypot(x - p[h], y - p[h + 1], z - p[h + 2]);
      this.arc[k] = (this.arc[this.head] + gap) % 2048;
    } else {
      this.arc[k] = 0;
    }
    this.born[k] = this.clock;
    if (this.head >= 0) this.length(this.head, this.head, k);
    // The newest point has nothing after it, and the one it overwrote (if any) is no longer the start of anything.
    this.length(k, k, -1);
    this.head = k;
    this.count = Math.min(this.cap, this.count + 1);
    this.used = Math.max(this.used, k + 1);
    this.laid++;
    // Winding takes in the loose end, down to its resting length.
    if (this.tailCount > REST_TAIL) this.remove(1);
  }

  // Takes the last point laid back off the cocoon. False if there is nothing left to take.
  private unlay() {
    if (this.count <= 1) return false;
    const previous = (this.head - 1 + this.cap) % this.cap;
    this.length(previous, previous, -1);
    this.head = previous;
    this.count--;
    this.peeled++;
    return true;
  }

  // Where the thread leaves the cocoon, in the world.
  anchor(out: Float32Array) {
    if (this.head < 0) {
      this.aim(this.phi, this.theta, out);
    } else {
      const h = this.head * 3;
      out[0] = this.points[h];
      out[1] = this.points[h + 1];
      out[2] = this.points[h + 2];
    }
    toWorld(this.theta, out[0], out[2], this.scratch);
    out[0] = this.scratch.x;
    out[2] = this.scratch.z;
  }

  // Turns the spindle by an angle, laying thread whenever the guide has drawn a full step from the last point.
  turn(angle: number, lay: boolean) {
    const steps = Math.min(400, Math.max(1, Math.ceil(Math.abs(angle) / ((STEP * 0.4) / SHAPE.top))));
    const c = this.candidate;
    for (let i = 0; i < steps; i++) {
      this.theta += angle / steps;
      if (!lay) continue;
      this.phi += Math.abs(angle) / steps;
      this.aim(this.phi, this.theta, c);
      if (this.head < 0) {
        this.lay(c[0], c[1], c[2]);
        continue;
      }
      const h = this.head * 3;
      const p = this.points;
      if (Math.hypot(c[0] - p[h], c[1] - p[h + 1], c[2] - p[h + 2]) >= STEP) this.lay(c[0], c[1], c[2]);
    }
    // Kept small, so the angle never loses precision however long it spins: a whole number of turns changes nothing.
    if (Math.abs(this.theta) > 1000) {
      this.theta -= Math.sign(this.theta) * Math.round(Math.abs(this.theta) / (Math.PI * 2)) * Math.PI * 2;
    }
  }

  // Winds silk on without showing it, for a cocoon already under way when the scene opens.
  prewind(points: number) {
    this.clock = -100;
    while (this.count < points) this.turn(0.05, true);
    this.clock = 0;
    this.resetTail();
  }

  clear() {
    this.head = -1;
    this.count = 0;
    this.used = 0;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    this.held = -1;
    this.tailCount = REST_TAIL;
    this.resetTail();
  }

  // The loose end hangs out and down from where it leaves the cocoon.
  resetTail() {
    const a = this.candidate;
    this.anchor(a);
    const out = Math.hypot(a[0], a[2]) || 1;
    for (let i = 0; i < this.tailCount; i++) {
      const f = i * STEP;
      const k = i * 3;
      this.tail[k] = a[0] + (a[0] / out) * f * 0.6;
      this.tail[k + 1] = a[1] - f * 0.8;
      this.tail[k + 2] = a[2] + (a[2] / out) * f * 0.6;
    }
    this.last.set(this.tail);
  }

  private remove(index: number) {
    if (this.tailCount <= 2 || index <= 0 || index >= this.tailCount) return;
    this.tail.copyWithin(index * 3, (index + 1) * 3, this.tailCount * 3);
    this.last.copyWithin(index * 3, (index + 1) * 3, this.tailCount * 3);
    this.tailCount--;
    if (this.held > index) this.held--;
    else if (this.held === index) this.held = -1;
  }

  // A new particle next to the cocoon, at a point the thread has just come away from.
  private insert(x: number, y: number, z: number) {
    if (this.tailCount >= MAX_TAIL) {
      // Pulled out as far as it goes: let a length near the far end go, so pulling never stops.
      this.remove(Math.max(1, this.held === this.tailCount - 1 ? this.tailCount - 2 : this.tailCount - 1));
    }
    this.tail.copyWithin(6, 3, this.tailCount * 3);
    this.last.copyWithin(6, 3, this.tailCount * 3);
    this.tail[3] = this.last[3] = x;
    this.tail[4] = this.last[4] = y;
    this.tail[5] = this.last[5] = z;
    this.tailCount++;
    if (this.held >= 1) this.held++;
  }

  // The loose end through one small step: drifting, kept to its lengths, kept outside the cocoon, and if it is held
  // and pulled taut, peeling thread off the cocoon, which turns the spindle.
  step(dt: number, time: number) {
    const t = this.tail;
    const l = this.last;
    const n = this.tailCount;
    const a = this.candidate;
    this.anchor(a);
    t[0] = l[0] = a[0];
    t[1] = l[1] = a[1];
    t[2] = l[2] = a[2];
    const dt2 = dt * dt;
    for (let i = 1; i < n; i++) {
      const k = i * 3;
      const x = t[k];
      const y = t[k + 1];
      const z = t[k + 2];
      // Silk hardly falls: a breath of air that changes along the thread moves it more than its weight.
      const fx = 0.55 * Math.sin(time * 0.53 + i * 0.19 + y * 1.3) + 0.25 * Math.sin(time * 1.31 + i * 0.07);
      const fy = -0.3 + 0.4 * Math.sin(time * 0.41 + i * 0.13 + x * 0.9);
      const fz = 0.5 * Math.cos(time * 0.37 + i * 0.11 + y * 1.1);
      // Pulled gently back toward the cocoon if it has drifted far.
      const far = Math.hypot(x, y, z);
      const back = far > 3 ? (far - 3) * 1.5 : 0;
      const damping = 0.975;
      t[k] = x + (x - l[k]) * damping + (fx - (back * x) / far) * dt2;
      t[k + 1] = y + (y - l[k + 1]) * damping + (fy - (back * y) / far) * dt2;
      t[k + 2] = z + (z - l[k + 2]) * damping + (fz - (back * z) / far) * dt2;
      l[k] = x;
      l[k + 1] = y;
      l[k + 2] = z;
    }
    const pin = () => {
      if (this.held < 1) return;
      const k = this.held * 3;
      t[k] = this.hand.x;
      t[k + 1] = this.hand.y;
      t[k + 2] = this.hand.z;
    };
    pin();

    // Peel first, while the pull is still felt as a stretch at the cocoon.
    if (this.held >= 1) {
      let peels = 0;
      while (peels < 10 && this.count > 1) {
        const dx = t[3] - t[0];
        const dy = t[4] - t[1];
        const dz = t[5] - t[2];
        const d = Math.hypot(dx, dy, dz);
        // Measured over the whole run from the cocoon to the hand too, so that a straight pull peels at once.
        const k = this.held * 3;
        const reach = Math.hypot(t[k] - t[0], t[k + 1] - t[1], t[k + 2] - t[2]);
        if (d < STEP * 1.45 && reach < this.held * STEP * 1.04) break;
        // The pull turns the spindle, by as much of the length peeled as runs round it rather than out from it.
        const dir = d > 1e-6 ? 1 / d : 0;
        const tx = t[2];
        const tz = -t[0];
        const r = Math.max(0.2, Math.hypot(tx, tz));
        this.pullTurn += ((dx * tx + dz * tz) * dir * STEP) / (r * r);
        const ax = t[0];
        const ay = t[1];
        const az = t[2];
        if (!this.unlay()) break;
        this.anchor(a);
        t[0] = l[0] = a[0];
        t[1] = l[1] = a[1];
        t[2] = l[2] = a[2];
        this.insert(ax, ay, az);
        peels++;
      }
    }

    const m = this.tailCount;
    for (let pass = 0; pass < 14; pass++) {
      for (let i = 1; i < m; i++) {
        const j = (i - 1) * 3;
        const k = i * 3;
        const dx = t[k] - t[j];
        const dy = t[k + 1] - t[j + 1];
        const dz = t[k + 2] - t[j + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const e = (d - STEP) / d;
        // The cocoon end is fixed, and so is a held particle; the others share each correction.
        const fixedJ = i - 1 === 0 || i - 1 === this.held;
        const fixedK = i === this.held;
        const wj = fixedJ ? 0 : fixedK ? 1 : 0.5;
        const wk = fixedK ? 0 : fixedJ ? 1 : 0.5;
        t[j] += dx * e * wj;
        t[j + 1] += dy * e * wj;
        t[j + 2] += dz * e * wj;
        t[k] -= dx * e * wk;
        t[k + 1] -= dy * e * wk;
        t[k + 2] -= dz * e * wk;
      }
      pin();
    }

    // Never through the cocoon: anything inside its outer skin is put back on it.
    const s = this.shell() + 0.02;
    for (let i = 2; i < m; i++) {
      const k = i * 3;
      const [w, h] = Spool.radii(t[k + 1] > 0 ? 1 : -1);
      const ex = t[k] / (w * s);
      const ey = t[k + 1] / (h * s);
      const ez = t[k + 2] / (w * s);
      const e = Math.hypot(ex, ey, ez);
      if (e < 1 && e > 1e-4) {
        t[k] /= e;
        t[k + 1] /= e;
        t[k + 2] /= e;
      }
    }
  }

  // The loose end's particles in the spindle's frame, for drawing with the cocoon.
  tailInSpindle(out: Float32Array) {
    for (let i = 0; i < this.tailCount; i++) {
      const k = i * 3;
      toSpindle(this.theta, this.tail[k], this.tail[k + 2], this.scratch);
      out[k] = this.scratch.x;
      out[k + 1] = this.tail[k + 1];
      out[k + 2] = this.scratch.z;
    }
  }
}
