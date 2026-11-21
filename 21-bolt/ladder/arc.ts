import * as THREE from "three/webgpu";
import { alongRod, rodLine, rootAt, THROAT_Y, TIP_Y } from "./rods";

// The arc as a physical string of points. It strikes across the throat, where the rods are closest; the air it heats
// rises and carries it up, its feet sliding up the rods behind it; convection wobbles it; and it stretches into a loop
// until it is longer than the voltage can hold, when it snaps and strikes again at the bottom.
export const POINTS = 44;
const STEP = 1 / 240;

export type ArcEvent = "strike" | "snap";

// A cheap, smooth, divergence-ish field of the air's stirring, carried upward with the plume.
function stir(x: number, y: number, z: number, t: number, out: THREE.Vector3) {
  const yy = y - t * 0.55;
  out.set(
    Math.sin(yy * 17.0 + Math.sin(z * 11.0 + t * 1.7) * 1.3 + t * 2.1) + 0.25 * Math.sin(yy * 41.0 - x * 23.0 + t * 5.3),
    0.5 * Math.sin(x * 19.0 + t * 1.3 + Math.sin(yy * 9.0)) + 0.35 * Math.sin(z * 29.0 - t * 3.9),
    Math.sin(yy * 13.0 + Math.sin(x * 15.0 - t * 1.1) * 1.4 - t * 1.6) + 0.25 * Math.sin(yy * 37.0 + z * 21.0 - t * 4.7)
  );
  return out;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const f = new THREE.Vector3();
const q = new THREE.Vector3();

export class Arc {
  p = Array.from({ length: POINTS }, () => new THREE.Vector3());
  v = Array.from({ length: POINTS }, () => new THREE.Vector3());
  // The arc as it was when it last snapped, rising and fading as hot air for a moment.
  ghost = Array.from({ length: POINTS }, () => new THREE.Vector3());
  ghostAge = 10;
  // Where each foot is up its rod, 0 at the throat and 1 at the tip.
  feet = [0, 0];
  on = false;
  // Seconds since it struck, or since it went out.
  age = 0;
  dark = 0;
  // When the next strike comes, in seconds of darkness.
  wait = 0.1;
  length = 0;
  // A bright flash as it strikes, dying away.
  flash = 0;
  // How hard it is driven, 0 to 1; 0 is switched off.
  voltage = 0.7;
  // Each rod's tip outward from the throat, in metres: left, right.
  spread = [0.13, 0.13];
  // A hand in the air: where it is, whether it is there, and which point of the arc it has caught (or -1).
  probe = new THREE.Vector3();
  probing = false;
  caught = -1;
  // The point of the arc nearest the hand, and how far it is.
  nearest = 0;
  nearestDistance = Infinity;
  // How stretched it is toward breaking, 0 to 1.
  strain = 0;
  time = 0;
  heat = 0;
  events: ArcEvent[] = [];
  private scratch = Array.from({ length: POINTS }, () => new THREE.Vector3());
  private cumulative = new Float32Array(POINTS);

  // The longest the arc can be before it goes out, at this voltage.
  limit() {
    return 0.2 + this.voltage * 0.56;
  }

  strike() {
    this.on = true;
    this.age = 0;
    this.flash = 1;
    this.caught = -1;
    // Each foot strikes a little way up from the very throat.
    this.feet[0] = Math.random() * 0.012;
    this.feet[1] = Math.random() * 0.012;
    rootAt(-1, this.spread[0], this.feet[0], a);
    rootAt(1, this.spread[1], this.feet[1], b);
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      this.p[i].lerpVectors(a, b, t);
      // A kink or two, as a fresh spark is never straight.
      this.p[i].y += Math.sin(t * Math.PI) * (Math.random() - 0.3) * 0.004;
      this.p[i].z += Math.sin(t * Math.PI) * (Math.random() - 0.5) * 0.004;
      this.v[i].set(0, 0.05, 0);
    }
    this.events.push("strike");
  }

  snap() {
    if (!this.on) return;
    this.on = false;
    this.dark = 0;
    this.caught = -1;
    for (let i = 0; i < POINTS; i++) this.ghost[i].copy(this.p[i]);
    this.ghostAge = 0;
    // The throat clears and strikes again almost at once; slower at a low voltage.
    this.wait = 0.035 + Math.random() * 0.09 + (1 - this.voltage) * 0.12;
    this.events.push("snap");
  }

  // Settle it into its rhythm before it is seen, so the first frame is mid-climb rather than a cold start.
  warm(seconds: number) {
    for (let t = 0; t < seconds; t += STEP) this.update(STEP);
    this.events.length = 0;
  }

  update(delta: number) {
    const steps = Math.max(1, Math.ceil(delta / STEP - 1e-6));
    const h = delta / steps;
    for (let k = 0; k < steps; k++) this.step(h);
    this.resample();
    this.measure();
  }

  private step(h: number) {
    this.time += h;
    this.flash *= Math.exp(-h * 14);
    this.ghostAge += h;
    // The ghost: the arc's hot air, rising.
    if (this.ghostAge < 1) for (const g of this.ghost) g.y += h * 0.35;
    if (!this.on) {
      this.dark += h;
      if (this.voltage > 0.02 && this.dark > this.wait) this.strike();
      return;
    }
    if (this.voltage <= 0.02) {
      this.snap();
      return;
    }
    this.age += h;
    const n = POINTS;
    const { p, v } = this;

    // The air heats as the arc burns, so it rises slowly at first, then quicker; a higher voltage burns hotter.
    this.heat = (0.35 + 0.65 * THREE.MathUtils.smoothstep(this.age, 0, 0.45)) * (0.7 + this.voltage * 0.5);

    // The feet: each follows the arc beside it up its rod, quickly upward and only slowly back down, hopping now and then.
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const next = p[s === 0 ? 1 : n - 2];
      const spread = this.spread[s];
      const length = rodLine(side, spread, a, b, f);
      const want = THREE.MathUtils.clamp(alongRod(side, spread, next), 0, 1);
      const up = (1.4 * h) / length;
      const down = (0.25 * h) / length;
      // The hot column also drags each foot up of its own accord.
      const drift = (0.16 * this.heat * h) / length;
      let foot = this.feet[s] + THREE.MathUtils.clamp(want - this.feet[s], -down, up) + drift;
      // A rare hop upward, as a foot jumps to fresh copper.
      if (Math.random() < h * 3) foot += (Math.random() * 0.012) / length;
      this.feet[s] = THREE.MathUtils.clamp(foot, 0, 1);
    }
    rootAt(-1, this.spread[0], this.feet[0], p[0]);
    rootAt(1, this.spread[1], this.feet[1], p[n - 1]);

    const buoyancy = 3.3 * this.heat;
    const drag = 4.2;
    const fade = Math.exp(-h * drag);
    const time = this.time;
    for (let i = 1; i < n - 1; i++) {
      const pi = p[i];
      // Turbulence grows as the plume rises above the throat.
      const above = THREE.MathUtils.clamp((pi.y - THROAT_Y) / 0.4, 0, 1.4);
      stir(pi.x, pi.y, pi.z, time, f);
      const swirl = 1.3 + above * 2.2;
      a.set(f.x * swirl, buoyancy + f.y * swirl * 0.6, f.z * swirl * 0.45);
      // The hand pulls the arc toward itself, strongly near and gently further off.
      if (this.probing) {
        q.subVectors(this.probe, pi);
        const d = q.length();
        const pull = 140 * Math.exp(-(d * d) / (0.11 * 0.11)) + 6;
        a.addScaledVector(q, pull);
      }
      // The arc's own magnetic field and the plume keep it mostly in the plane between the rods: a gentle pull back toward
      // the line between its feet, sideways and out of the plane, never up or down.
      const t = i / (n - 1);
      const lineX = p[0].x + (p[n - 1].x - p[0].x) * t;
      const lineZ = p[0].z + (p[n - 1].z - p[0].z) * t;
      a.x += (lineX - pi.x) * 42;
      a.z += (lineZ - pi.z) * 40;
      v[i].multiplyScalar(fade).addScaledVector(a, h);
      pi.addScaledVector(v[i], h);
    }

    // A caught point rides the hand.
    if (this.caught > 0 && this.caught < n - 1) {
      p[this.caught].lerp(this.probe, 1 - Math.exp(-h * 40));
      v[this.caught].set(0, 0, 0);
    }

    // The channel stays smooth at its own scale: each point eases toward the middle of its neighbours.
    const smooth = 0.42;
    const tmp = this.scratch;
    for (let i = 1; i < n - 1; i++) tmp[i].copy(p[i - 1]).add(p[i + 1]).multiplyScalar(0.5).sub(p[i]);
    for (let i = 1; i < n - 1; i++) if (i !== this.caught) p[i].addScaledVector(tmp[i], smooth);
  }

  // Keep the points evenly spaced along the arc, so stretching never bunches them.
  private resample() {
    if (!this.on) return;
    const { p, cumulative: c, scratch: tmp } = this;
    const n = POINTS;
    c[0] = 0;
    for (let i = 1; i < n; i++) c[i] = c[i - 1] + p[i].distanceTo(p[i - 1]);
    const total = c[n - 1];
    this.length = total;
    if (total < 1e-5) return;
    let j = 1;
    for (let i = 0; i < n; i++) {
      const want = (i / (n - 1)) * total;
      while (j < n - 1 && c[j] < want) j++;
      const span = c[j] - c[j - 1];
      const t = span > 1e-9 ? (want - c[j - 1]) / span : 0;
      tmp[i].lerpVectors(p[j - 1], p[j], THREE.MathUtils.clamp(t, 0, 1));
    }
    for (let i = 1; i < n - 1; i++) p[i].copy(tmp[i]);
    if (this.caught > 0) {
      // Keep hold of the point nearest the hand after the shuffle.
      let best = this.caught;
      let bestD = Infinity;
      for (let i = 1; i < n - 1; i++) {
        const d = p[i].distanceToSquared(this.probe);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      this.caught = best;
    }
  }

  private measure() {
    if (!this.on) {
      this.nearestDistance = Infinity;
      this.strain = 0;
      return;
    }
    const { p } = this;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < POINTS; i++) {
      const d = p[i].distanceToSquared(this.probe);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.nearest = best;
    this.nearestDistance = Math.sqrt(bestD);
    // A hand close enough catches the arc there, and holds it.
    if (!this.probing) this.caught = -1;
    else if (this.caught < 0 && this.nearestDistance < 0.024 && best > 1 && best < POINTS - 2) this.caught = best;
    // A held arc stretches further before it lets go.
    const limit = this.limit() * (this.caught > 0 ? 1.3 : 1);
    this.strain = this.length / limit;
    // It goes when it is too long, a little early or late each time, or once both feet have run off the tips and it has
    // risen well clear of them.
    const top = Math.max(p[0].y, p[POINTS - 1].y);
    let crest = 0;
    for (let i = 0; i < POINTS; i++) crest = Math.max(crest, p[i].y);
    const wobble = 0.93 + 0.14 * Math.sin(this.time * 7.3 + this.age * 3.1);
    if (this.strain > wobble || (top > TIP_Y - 0.01 && crest > TIP_Y + 0.28)) this.snap();
  }
}
