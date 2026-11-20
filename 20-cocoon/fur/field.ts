import * as THREE from "three/webgpu";
import { eggFrame, eggPoint } from "./egg";

// The nap of the fur, kept over the egg's (u, v) as two small pictures the strands read. The first is which way the
// fur lies at each spot, as a direction in the world whose length is how flat it lies: brushing against the grain
// passes it through zero, so the strands stand up on end mid-stroke, as velvet does. The second is a springy offset
// for the tips, set going by a passing hand and left to ring down.

export const FIELD_W = 128;
export const FIELD_H = 64;
// The most a tip is ever thrown, in strand lengths, which is what the second picture's full range stands for.
export const WOBBLE_RANGE = 0.8;

const LIE = 0.84;
const STIFF = 85;
const DAMP = 5.5;

export class FurField {
  readonly lean = new Float32Array(FIELD_W * FIELD_H * 3);
  readonly combed = new Float32Array(FIELD_W * FIELD_H * 3);
  readonly wobble = new Float32Array(FIELD_W * FIELD_H * 3);
  readonly speed = new Float32Array(FIELD_W * FIELD_H * 3);
  // Each spot's place on the skin and its outward normal.
  readonly spot = new Float32Array(FIELD_W * FIELD_H * 3);
  readonly normal = new Float32Array(FIELD_W * FIELD_H * 3);
  readonly v = new Float32Array(FIELD_W * FIELD_H);
  readonly leanTexture: THREE.DataTexture;
  readonly wobbleTexture: THREE.DataTexture;
  private leanBytes = new Uint8Array(FIELD_W * FIELD_H * 4);
  private wobbleBytes = new Uint8Array(FIELD_W * FIELD_H * 4);
  private leanDirty = true;
  private ringing = true;
  // The comb's edge as it sweeps from the top of the egg to the bottom, or past the end when it is not combing.
  private comb = 2;

  constructor() {
    const point = new THREE.Vector3();
    const n = new THREE.Vector3();
    const along = new THREE.Vector3();
    const down = new THREE.Vector3();
    const lean = new THREE.Vector3();
    for (let j = 0; j < FIELD_H; j++) {
      for (let i = 0; i < FIELD_W; i++) {
        const k = j * FIELD_W + i;
        const u = (i + 0.5) / FIELD_W;
        const v = (j + 0.5) / FIELD_H;
        eggPoint(u, v, point);
        eggFrame(u, v, n, along, down);
        this.spot.set([point.x, point.y, point.z], k * 3);
        this.normal.set([n.x, n.y, n.z], k * 3);
        this.v[k] = v;
        // Combed: every strand lies straight down the egg from the crown, where it parts in a whorl.
        this.combed.set([down.x * LIE, down.y * LIE, down.z * LIE], k * 3);
        // As grown: down the egg still, but swirled in slow waves with a cowlick or two, so the first stroke has
        // something to tidy.
        const p = u * Math.PI * 2;
        const swirl = Math.sin(p * 3 + v * 9) * 0.55 + Math.sin(v * 17 - p * 2 + 1.3) * 0.35 + Math.sin(p * 7 - v * 5) * 0.18;
        lean.copy(down).addScaledVector(along, swirl).normalize().multiplyScalar(LIE);
        this.lean.set([lean.x, lean.y, lean.z], k * 3);
      }
    }
    const make = (bytes: Uint8Array) => {
      const texture = new THREE.DataTexture(bytes, FIELD_W, FIELD_H, THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    };
    this.leanTexture = make(this.leanBytes);
    this.wobbleTexture = make(this.wobbleBytes);
    this.upload();
  }

  // Lays everything straight, in a sweep from the crown down that takes a second and a half.
  combAll() {
    this.comb = -0.1;
  }

  get combing() {
    return this.comb <= 1.1;
  }

  // One stretch of a stroke, from one point at the fur's tips to the next. `strength` is how firmly: a pressed hand
  // lays the fur down where it goes, a hovering one only ruffles the tips. Returns how much fur it moved.
  stroke(from: THREE.Vector3, to: THREE.Vector3, reach: number, strength: number, dt: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-5) return 0;
    const steps = Math.min(10, Math.ceil(length / (reach * 0.35)));
    const lay = 1 - Math.exp(-(length / steps) * 22 * strength);
    const kick = Math.min(6, length / Math.max(dt, 1 / 240)) * 0.8 * Math.min(1, strength + 0.4);
    let moved = 0;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const cx = from.x + dx * f;
      const cy = from.y + dy * f;
      const cz = from.z + dz * f;
      for (let k = 0; k < FIELD_W * FIELD_H; k++) {
        const o = k * 3;
        const ox = this.spot[o] - cx;
        const oy = this.spot[o + 1] - cy;
        const oz = this.spot[o + 2] - cz;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 > reach * reach) continue;
        const near = 1 - Math.sqrt(d2) / reach;
        const fall = near * near * (3 - 2 * near);
        // The stroke as it runs along the skin here.
        const nx = this.normal[o];
        const ny = this.normal[o + 1];
        const nz = this.normal[o + 2];
        const into = dx * nx + dy * ny + dz * nz;
        const tx = dx - nx * into;
        const ty = dy - ny * into;
        const tz = dz - nz * into;
        const tl = Math.hypot(tx, ty, tz);
        if (tl < 1e-6) continue;
        const w = lay * fall;
        const target = LIE / tl;
        this.lean[o] += (tx * target - this.lean[o]) * w;
        this.lean[o + 1] += (ty * target - this.lean[o + 1]) * w;
        this.lean[o + 2] += (tz * target - this.lean[o + 2]) * w;
        const push = (kick * fall) / (tl * steps);
        this.speed[o] += tx * push;
        this.speed[o + 1] += ty * push;
        this.speed[o + 2] += tz * push;
        moved += w;
      }
    }
    this.leanDirty = true;
    this.ringing = true;
    return moved;
  }

  // Moves the comb on, settles how flat the fur lies, rings the springs down, and sends whatever changed to the GPU.
  update(dt: number) {
    const count = FIELD_W * FIELD_H;
    if (this.comb <= 1.1) {
      const was = this.comb;
      this.comb += dt / 1.5;
      for (let k = 0; k < count; k++) {
        const v = this.v[k];
        if (v > this.comb + 0.02) continue;
        const o = k * 3;
        // The teeth pass each row once, pulling it hard toward straight, and flick the tips as they go.
        const crossed = v > was - 0.06 && v <= this.comb + 0.02;
        const pull = crossed ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 5);
        for (let c = 0; c < 3; c++) {
          this.lean[o + c] += (this.combed[o + c] - this.lean[o + c]) * pull;
          if (crossed) this.speed[o + c] += this.combed[o + c] * dt * 22;
        }
      }
      this.leanDirty = true;
      this.ringing = true;
    }

    // Fur stood on end slowly settles back to lying flat, whichever way it was last sent.
    const settle = 1 - Math.exp(-dt * 0.35);
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      const l = Math.hypot(this.lean[o], this.lean[o + 1], this.lean[o + 2]);
      if (l < 0.04 || Math.abs(l - LIE) < 0.02) continue;
      const scale = 1 + (LIE / l - 1) * settle;
      this.lean[o] *= scale;
      this.lean[o + 1] *= scale;
      this.lean[o + 2] *= scale;
      this.leanDirty = true;
    }

    if (this.ringing) {
      const h = Math.min(dt, 1 / 30);
      let energy = 0;
      for (let i = 0; i < count * 3; i++) {
        let s = this.speed[i] + (-STIFF * this.wobble[i] - DAMP * this.speed[i]) * h;
        s = Math.max(-8, Math.min(8, s));
        this.speed[i] = s;
        this.wobble[i] = Math.max(-WOBBLE_RANGE, Math.min(WOBBLE_RANGE, this.wobble[i] + s * h));
        energy += Math.abs(this.wobble[i]) + Math.abs(s) * 0.05;
      }
      if (energy < 0.05) {
        this.wobble.fill(0);
        this.speed.fill(0);
        this.ringing = false;
      }
      this.writeWobble();
    }
    if (this.leanDirty) this.writeLean();
  }

  private writeLean() {
    for (let k = 0; k < FIELD_W * FIELD_H; k++) {
      for (let c = 0; c < 3; c++) this.leanBytes[k * 4 + c] = Math.round(Math.max(0, Math.min(1, this.lean[k * 3 + c] * 0.5 + 0.5)) * 255);
      this.leanBytes[k * 4 + 3] = 255;
    }
    this.leanTexture.needsUpdate = true;
    this.leanDirty = false;
  }

  private writeWobble() {
    for (let k = 0; k < FIELD_W * FIELD_H; k++) {
      for (let c = 0; c < 3; c++) this.wobbleBytes[k * 4 + c] = Math.round(Math.max(0, Math.min(1, (this.wobble[k * 3 + c] / WOBBLE_RANGE) * 0.5 + 0.5)) * 255);
      this.wobbleBytes[k * 4 + 3] = 255;
    }
    this.wobbleTexture.needsUpdate = true;
  }

  private upload() {
    this.writeLean();
    this.writeWobble();
  }

  dispose() {
    this.leanTexture.dispose();
    this.wobbleTexture.dispose();
  }
}
