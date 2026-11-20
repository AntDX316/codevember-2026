// A sheet of cloth wound once and a fifth round a soft egg, simulated on the CPU with position-based dynamics: Verlet
// steps, then a few passes of distance constraints (along the weave, across the diagonals, and two apart for bending),
// then collision with the body and the floor. Plain typed arrays and no allocation in the step, so it runs in a few
// milliseconds a frame at the finest grid.

// The body the cloth is wrapped round: an egg, a little fuller below than above, about two units tall.
export const BODY = { radius: 0.62, half: 0.92, taper: 0.11 };
export const FLOOR_Y = -1.55;

// How each fabric moves. bend is the stiffness of the two-apart constraints (crisp linen, soft chiffon); friction is how
// much of its sliding a particle keeps against the body each step (satin slips, velvet grips); air is a drag per step;
// weight scales gravity (chiffon floats down); gather is how much spare cloth the ends of the wrap hold in folds.
export type FabricPhysics = { bend: number; friction: number; air: number; weight: number; gather: number; compress: number };

export const PHYSICS: Record<string, FabricPhysics> = {
  satin: { bend: 0.3, friction: 0.04, air: 0.006, weight: 1, gather: 0.32, compress: 0.25 },
  velvet: { bend: 0.25, friction: 0.35, air: 0.01, weight: 1.15, gather: 0.24, compress: 0.4 },
  linen: { bend: 0.4, friction: 0.18, air: 0.008, weight: 0.9, gather: 0.3, compress: 0.5 },
  chiffon: { bend: 0.025, friction: 0.12, air: 0.03, weight: 0.45, gather: 0.36, compress: 0.2 }
};

// The wrap: once round and a fifth more, so the end laps over the start like a swaddling band; tilted so the lapped
// edge runs diagonally. Both ends are left a little open and gathered, narrower than the body's girth so it holds; any
// nearer the poles and the rows bunch so tight the solver fights itself.
const TURNS = 1.22;
const TILT = 0.9;
const POLE_TOP = 0.2 * Math.PI;
const POLE_BOTTOM = 0.86 * Math.PI;
const GAP = 0.035;
// How far each layer of the wrap stands off the one under it.
const LAYER = 0.032;

const GRAVITY = -9.8;
// How many soft folds run down the wrap.
const PLEATS = 5;

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  // Positions, in doubles for the solver's sake (it runs a good third faster on them); the scene copies them out.
  readonly pos: Float64Array;
  readonly prev: Float64Array;
  // Where each particle belongs when wrapped, on the unbreathing body: direction from the middle and stand-off.
  private readonly home: Float32Array;
  private readonly lift: Float32Array;
  // How firmly each particle is held along the body: the lapped end of the band is held loosely, so its edge drapes.
  private readonly grip: Float32Array;
  readonly normal: Float32Array;
  // Each constraint's two particles (as offsets into the position arrays), rest length, and stiffness when stretched and
  // when squashed. Bending (the two-apart family) takes the fabric's own stiffness, the rest are cloth-strong.
  private readonly cA: Int32Array;
  private readonly cB: Int32Array;
  private readonly cRest: Float64Array;
  private readonly cStretch: Float64Array;
  private readonly cSquash: Float64Array;
  private readonly cKind: Uint8Array;
  private readonly cCount: number;
  // Whether the grid's normals had to be turned round to face out, and so which way its triangles must wind.
  readonly flip: number;

  // Settings the scene steers every frame.
  physics: FabricPhysics = PHYSICS.satin;
  // The most spare cloth a fold holds, as a fraction of the length across it.
  pleat = 0.35;
  // Many small steps with one pass each hold cloth taut better, for the time, than few steps with many passes.
  substeps = 4;
  iterations = 1;
  // How hard the cloth is drawn to its place on the body, along the body's normal and across it, per step.
  pullNormal = 0.012;
  pullAcross = 0.002;
  // How far cloth may stand off its place on the body before the cinch draws it back in.
  loose = 0.09;
  // The body's size, for breathing; 0 lets the cloth pass through it entirely.
  breath = 1;
  solid = 1;

  // The pinch the hand holds: particles and how strongly each follows, with where each sits relative to the one taken.
  private held: number[] = [];
  private heldWeight: number[] = [];
  private heldOffset: number[] = [];
  heldTarget = [0, 0, 0];
  holding = false;
  // Corners carried by the unwrap, each with a target, or -1.
  pins: { index: number; x: number; y: number; z: number }[] = [];

  // Mean particle speed over the last frame, in units a second, for the sound.
  speed = 0;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    const n = (this.count = cols * rows);
    this.pos = new Float64Array(n * 3);
    this.prev = new Float64Array(n * 3);
    this.home = new Float32Array(n * 3);
    this.lift = new Float32Array(n);
    this.grip = new Float32Array(n);
    this.normal = new Float32Array(n * 3);

    // Home places: angle round the body from the column, height down it from the row.
    const thetaStart = 0.35 - (TURNS - 1) * Math.PI * 2 - 0.5 * TILT;
    for (let j = 0; j < rows; j++) {
      const v = j / (rows - 1);
      const phi = POLE_BOTTOM + (POLE_TOP - POLE_BOTTOM) * v;
      for (let i = 0; i < cols; i++) {
        const u = i / (cols - 1);
        const theta = thetaStart + u * TURNS * Math.PI * 2 + v * TILT;
        const k = j * cols + i;
        const s = Math.sin(phi);
        // Unit direction on a sphere, squashed onto the egg below.
        this.home[k * 3] = s * Math.sin(theta);
        this.home[k * 3 + 1] = Math.cos(phi);
        this.home[k * 3 + 2] = s * Math.cos(theta);
        this.lift[k] = GAP + u * TURNS * LAYER;
        const free = Math.min(1, Math.max(0, (u - 0.86) / 0.14));
        this.grip[k] = 1 - free * free * 0.9;
      }
    }
    for (let k = 0; k < n; k++) {
      this.homePoint(k, 1, this.pos, k * 3);
      this.prev[k * 3] = this.pos[k * 3];
      this.prev[k * 3 + 1] = this.pos[k * 3 + 1];
      this.prev[k * 3 + 2] = this.pos[k * 3 + 2];
    }

    // Constraints, with rest lengths taken from the wrapped shape plus a little slack, and more round the gathered ends,
    // where a flat sheet would hold far more cloth than the narrow body needs: that spare is what folds.
    const pairs: [number, number, number][] = [];
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i + 1 < cols) pairs.push([k, k + 1, 0]);
        if (j + 1 < rows) pairs.push([k, k + cols, 0]);
        if (i + 1 < cols && j + 1 < rows) {
          pairs.push([k, k + cols + 1, 0]);
          pairs.push([k + 1, k + cols, 0]);
        }
        if (i + 2 < cols) pairs.push([k, k + 2, 1]);
        if (j + 2 < rows) pairs.push([k, k + cols * 2, 1]);
      }
    this.cCount = pairs.length;
    this.cA = new Int32Array(pairs.length);
    this.cB = new Int32Array(pairs.length);
    this.cRest = new Float64Array(pairs.length);
    this.cStretch = new Float64Array(pairs.length);
    this.cSquash = new Float64Array(pairs.length);
    this.cKind = new Uint8Array(pairs.length);
    pairs.forEach(([a, b, kind], c) => {
      this.cA[c] = a * 3;
      this.cB[c] = b * 3;
      this.cKind[c] = kind;
    });
    this.setFabric(PHYSICS.satin);

    // Which way round the grid's triangles face, so normals point out of the wrap.
    this.computeNormals();
    const mid = Math.floor(rows / 2) * cols + Math.floor(cols / 3);
    const dot = this.normal[mid * 3] * this.pos[mid * 3] + this.normal[mid * 3 + 1] * this.pos[mid * 3 + 1] + this.normal[mid * 3 + 2] * this.pos[mid * 3 + 2];
    this.flip = dot < 0 ? -1 : 1;
    this.computeNormals();
  }

  // Rest lengths for a fabric's gather. They are measured on the wrap with its narrow ends widened part way back to the
  // girth of the middle, so the ends hold more cloth than the body needs there, as a flat sheet wound round an egg would.
  setFabric(physics: FabricPhysics) {
    this.physics = physics;
    for (let c = 0; c < this.cCount; c++) {
      const k = this.cKind[c] === 1 ? physics.bend : 1;
      this.cStretch[c] = 0.5 * k;
      this.cSquash[c] = 0.5 * k * physics.compress;
    }
    this.setGather(physics.gather);
  }

  private setGather(gather: number) {
    const ref = new Float32Array(this.count * 3);
    for (let k = 0; k < this.count; k++) {
      this.homePoint(k, 1, ref, k * 3);
      const h = Math.hypot(this.home[k * 3], this.home[k * 3 + 2]);
      if (h < 1e-4) continue;
      const r = Math.hypot(ref[k * 3], ref[k * 3 + 2]);
      const want = BODY.radius + this.lift[k];
      const widened = (r + Math.max(0, want - r) * gather) / r;
      ref[k * 3] *= widened;
      ref[k * 3 + 2] *= widened;
    }
    for (let c = 0; c < this.cCount; c++) {
      const a = this.cA[c];
      const b = this.cB[c];
      // Spare cloth in soft bands running down the wrap, more in some than others, which buckle out into folds.
      const ka = a / 3;
      const kb = b / 3;
      const across = ka % this.cols !== kb % this.cols;
      const u = ((ka % this.cols) + (kb % this.cols)) / 2 / (this.cols - 1);
      const v = (Math.floor(ka / this.cols) + Math.floor(kb / this.cols)) / 2 / (this.rows - 1);
      const band = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (u * PLEATS + v * 0.6) + 1.6 * Math.sin(v * 4.1 + u * 9.3));
      const pleat = across ? this.pleat * band * band * band : 0;
      this.cRest[c] = Math.hypot(ref[b] - ref[a], ref[b + 1] - ref[a + 1], ref[b + 2] - ref[a + 2]) * (1.02 + pleat);
    }
  }

  // A particle's place on the body, breathing by `scale`.
  private homePoint(k: number, scale: number, out: Float32Array | Float64Array | number[], o: number) {
    const hx = this.home[k * 3];
    const hy = this.home[k * 3 + 1];
    const hz = this.home[k * 3 + 2];
    const y = hy * BODY.half;
    const r = BODY.radius * (1 - BODY.taper * hy);
    const lift = this.lift[k];
    out[o] = (hx * r + hx * lift) * scale;
    out[o + 1] = (y + hy * lift) * scale;
    out[o + 2] = (hz * r + hz * lift) * scale;
  }

  // Takes hold of the particle nearest `index`, and a soft pinch of cloth round it.
  grab(index: number, reach: number) {
    this.held.length = this.heldWeight.length = this.heldOffset.length = 0;
    const p = this.pos;
    const gi = index % this.cols;
    const gj = Math.floor(index / this.cols);
    const span = Math.ceil(reach / 0.035) + 1;
    for (let j = Math.max(0, gj - span); j <= Math.min(this.rows - 1, gj + span); j++)
      for (let i = Math.max(0, gi - span); i <= Math.min(this.cols - 1, gi + span); i++) {
        const k = j * this.cols + i;
        const d = Math.hypot(p[k * 3] - p[index * 3], p[k * 3 + 1] - p[index * 3 + 1], p[k * 3 + 2] - p[index * 3 + 2]);
        if (d > reach) continue;
        const w = k === index ? 1 : Math.exp(-((d / (reach * 0.5)) ** 2)) * 0.55;
        this.held.push(k);
        this.heldWeight.push(w);
        this.heldOffset.push(p[k * 3] - p[index * 3], p[k * 3 + 1] - p[index * 3 + 1], p[k * 3 + 2] - p[index * 3 + 2]);
      }
    this.heldTarget[0] = p[index * 3];
    this.heldTarget[1] = p[index * 3 + 1];
    this.heldTarget[2] = p[index * 3 + 2];
    this.holding = true;
  }

  release() {
    this.holding = false;
    this.held.length = this.heldWeight.length = this.heldOffset.length = 0;
  }

  // The particle a ray passes nearest, in front of everything else it passes near; -1 if none.
  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number) {
    const p = this.pos;
    let best = -1;
    let bestT = Infinity;
    const r2 = radius * radius;
    for (let k = 0; k < this.count; k++) {
      const x = p[k * 3] - ox;
      const y = p[k * 3 + 1] - oy;
      const z = p[k * 3 + 2] - oz;
      const t = x * dx + y * dy + z * dz;
      if (t <= 0 || t >= bestT) continue;
      const ex = x - dx * t;
      const ey = y - dy * t;
      const ez = z - dz * t;
      if (ex * ex + ey * ey + ez * ez < r2) {
        best = k;
        bestT = t;
      }
    }
    return best;
  }

  index(i: number, j: number) {
    return j * this.cols + i;
  }

  step(delta: number) {
    const dt = Math.min(delta, 1 / 30) / this.substeps;
    const p = this.pos;
    const q = this.prev;
    let moved = 0;
    for (let s = 0; s < this.substeps; s++) {
      this.integrate(dt);
      this.pull();
      for (let it = 0; it < this.iterations; it++) {
        this.solve();
        this.hold();
      }
      this.collide();
    }
    // Speed sampled across the sheet.
    const stride = 7;
    let samples = 0;
    for (let k = 0; k < this.count; k += stride) {
      moved += Math.hypot(p[k * 3] - q[k * 3], p[k * 3 + 1] - q[k * 3 + 1], p[k * 3 + 2] - q[k * 3 + 2]);
      samples++;
    }
    this.speed = moved / samples / dt;
    this.computeNormals();
  }

  private integrate(dt: number) {
    const p = this.pos;
    const q = this.prev;
    const keep = 1 - this.physics.air;
    const g = GRAVITY * this.physics.weight * dt * dt;
    // No particle moves further than this in a step, whatever a hard tug asks: a guard against the solver ringing.
    const most = 0.04;
    for (let k = 0; k < this.count * 3; k += 3) {
      const x = p[k];
      const y = p[k + 1];
      const z = p[k + 2];
      let vx = (x - q[k]) * keep;
      let vy = (y - q[k + 1]) * keep + g;
      let vz = (z - q[k + 2]) * keep;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > most * most) {
        const m = most / Math.sqrt(v2);
        vx *= m;
        vy *= m;
        vz *= m;
      }
      p[k] += vx;
      p[k + 1] += vy;
      p[k + 2] += vz;
      q[k] = x;
      q[k + 1] = y;
      q[k + 2] = z;
    }
  }

  // The cinch: each particle drawn back toward its place on the body, firmly onto the surface and gently along it, so
  // the cloth can slide and stay a little where it was pushed.
  private pull() {
    const kn = this.pullNormal;
    const kt = this.pullAcross;
    if (kn <= 0 && kt <= 0) return;
    const p = this.pos;
    const h = this.home;
    const scale = this.breath;
    const target = scratch;
    const loose = this.loose;
    for (let k = 0; k < this.count; k++) {
      const o = k * 3;
      this.homePoint(k, scale, target, 0);
      const dx = target[0] - p[o];
      const dy = target[1] - p[o + 1];
      const dz = target[2] - p[o + 2];
      const nx = h[o];
      const ny = h[o + 1];
      const nz = h[o + 2];
      const dn = dx * nx + dy * ny + dz * nz;
      // Cloth standing off the body by less than `loose` is left be, so folds can rise out of the wrap; beyond it, drawn in.
      const w = this.grip[k];
      const dnOut = dn < 0 ? Math.min(0, dn + loose / w) : dn;
      const a = kt * w;
      const b = kn * w;
      p[o] += (dx - nx * dn) * a + nx * dnOut * b;
      p[o + 1] += (dy - ny * dn) * a + ny * dnOut * b;
      p[o + 2] += (dz - nz * dn) * a + nz * dnOut * b;
    }
  }

  private solve() {
    const p = this.pos;
    const A = this.cA;
    const B = this.cB;
    const R = this.cRest;
    const S = this.cStretch;
    const C = this.cSquash;
    for (let c = 0; c < this.cCount; c++) {
      const a = A[c];
      const b = B[c];
      const dx = p[b] - p[a];
      const dy = p[b + 1] - p[a + 1];
      const dz = p[b + 2] - p[a + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
      const rest = R[c];
      // Cloth resists stretching hard and squashing barely: it buckles instead, and that is the wrinkling.
      const f = ((len - rest) / len) * (len > rest ? S[c] : C[c]);
      p[a] += dx * f;
      p[a + 1] += dy * f;
      p[a + 2] += dz * f;
      p[b] -= dx * f;
      p[b + 1] -= dy * f;
      p[b + 2] -= dz * f;
    }
  }

  // The pinch in hand, and the unwrap's corners, carried where they are led.
  private hold() {
    const p = this.pos;
    if (this.holding) {
      const t = this.heldTarget;
      for (let n = 0; n < this.held.length; n++) {
        const o = this.held[n] * 3;
        const w = this.heldWeight[n];
        p[o] += (t[0] + this.heldOffset[n * 3] - p[o]) * w;
        p[o + 1] += (t[1] + this.heldOffset[n * 3 + 1] - p[o + 1]) * w;
        p[o + 2] += (t[2] + this.heldOffset[n * 3 + 2] - p[o + 2]) * w;
      }
    }
    for (const pin of this.pins) {
      const o = pin.index * 3;
      p[o] = pin.x;
      p[o + 1] = pin.y;
      p[o + 2] = pin.z;
    }
  }

  // Out of the body (each layer of the wrap kept its own stand-off, so the lapped end lies over the start rather than
  // through it) and off the floor, losing some sliding to friction each time.
  private collide() {
    const p = this.pos;
    const q = this.prev;
    const scale = this.breath * this.solid;
    const slip = 1 - this.physics.friction;
    const half = BODY.half * scale;
    for (let k = 0; k < this.count; k++) {
      const o = k * 3;
      const x = p[o];
      const y = p[o + 1];
      const z = p[o + 2];
      if (scale > 0.02) {
        const lift = this.lift[k] * scale - 0.01;
        const yn = Math.max(-1, Math.min(1, y / (half + lift)));
        const r = BODY.radius * (1 - BODY.taper * yn) * scale + lift;
        const ry = half + lift;
        const e = (x * x + z * z) / (r * r) + (y * y) / (ry * ry);
        if (e < 1 && e > 1e-6) {
          const m = 1 / Math.sqrt(e);
          const px = x * m;
          const py = y * m;
          const pz = z * m;
          // The surface normal there, for taking out the velocity into the body and some along it.
          let nx = px / (r * r);
          let ny = py / (ry * ry);
          let nz = pz / (r * r);
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          let vx = x - q[o];
          let vy = y - q[o + 1];
          let vz = z - q[o + 2];
          const vn = vx * nx + vy * ny + vz * nz;
          vx -= nx * vn;
          vy -= ny * vn;
          vz -= nz * vn;
          p[o] = px;
          p[o + 1] = py;
          p[o + 2] = pz;
          q[o] = px - vx * slip;
          q[o + 1] = py - vy * slip;
          q[o + 2] = pz - vz * slip;
        }
      }
      const floor = FLOOR_Y + 0.012 + this.lift[k] * 0.3;
      if (p[o + 1] < floor) {
        p[o + 1] = floor;
        // The floor holds cloth that lands on it.
        q[o] = p[o] - (p[o] - q[o]) * 0.4;
        q[o + 1] = floor;
        q[o + 2] = p[o + 2] - (p[o + 2] - q[o + 2]) * 0.4;
      }
    }
  }

  // Smooth normals straight from the grid, by differences either side, pointing out of the wrap.
  computeNormals() {
    const p = this.pos;
    const nrm = this.normal;
    const cols = this.cols;
    const rows = this.rows;
    const f = (this.flip as number | undefined) ?? 1;
    for (let j = 0; j < rows; j++) {
      const j0 = j > 0 ? j - 1 : j;
      const j1 = j < rows - 1 ? j + 1 : j;
      for (let i = 0; i < cols; i++) {
        const i0 = i > 0 ? i - 1 : i;
        const i1 = i < cols - 1 ? i + 1 : i;
        const a = (j * cols + i0) * 3;
        const b = (j * cols + i1) * 3;
        const c = (j0 * cols + i) * 3;
        const d = (j1 * cols + i) * 3;
        const ux = p[b] - p[a];
        const uy = p[b + 1] - p[a + 1];
        const uz = p[b + 2] - p[a + 2];
        const vx = p[d] - p[c];
        const vy = p[d + 1] - p[c + 1];
        const vz = p[d + 2] - p[c + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const o = (j * cols + i) * 3;
        if (l < 1e-12) {
          nx = 0;
          ny = 1;
          nz = 0;
        } else {
          nx = (nx / l) * f;
          ny = (ny / l) * f;
          nz = (nz / l) * f;
        }
        nrm[o] = nx;
        nrm[o + 1] = ny;
        nrm[o + 2] = nz;
      }
    }
  }
}

const scratch = [0, 0, 0];
