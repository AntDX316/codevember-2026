import * as THREE from "three/webgpu";
import { glowGrid, light, surfaceAt, VEINS, veinStyle } from "./world";

// The bloom as the processor keeps it: where each cluster of mushrooms stands, when each mushroom began to grow, the
// threads of mycelium spreading from each through the litter, and every spore in the air. The shaders work out the
// rest from the clock, so nothing here changes once written but the spores' ring and the light on the floor.

// Six kinds of mushroom: little bell caps on thread-thin stems in crowded troops; stouter ones with wide, dipped caps,
// fewer to a cluster; tall parasols with broad flat caps, one to three; tiny bonnets no bigger than a grain of rice, by
// the dozen; inkcaps, tall narrow bells never opening wide; and funnels, their caps turned up into cups. For each: how
// many to a cluster, how far they spread, their stem lengths and cap radii.
const KIND = [
  { count: [5, 13], spread: 0.045, stem: [0.035, 0.075], cap: [0.007, 0.013], lean: 0.25 },
  { count: [2, 5], spread: 0.07, stem: [0.04, 0.07], cap: [0.016, 0.026], lean: 0.12 },
  { count: [1, 3], spread: 0.08, stem: [0.07, 0.12], cap: [0.02, 0.034], lean: 0.1 },
  { count: [8, 20], spread: 0.03, stem: [0.008, 0.02], cap: [0.0025, 0.005], lean: 0.35 },
  { count: [3, 7], spread: 0.05, stem: [0.06, 0.11], cap: [0.009, 0.015], lean: 0.08 },
  { count: [2, 5], spread: 0.06, stem: [0.03, 0.06], cap: [0.016, 0.028], lean: 0.1 }
];
// Kind, colour and how brightly it glows share a number in the buffers: kind, plus KINDS times the colour, plus SHADES
// times its brightness (0 dim to 3 brilliant).
export const KINDS = 8;
export const SHADES = 64;
// From barely lit at all to brilliant. A shade past the last (PULSING added) glows in slow waves, on and off.
export const BRIGHTNESS = [0.05, 0.3, 0.7, 1.1, 1.9];
export const PULSING = 5;
// Each kind's chance on the open floor; on the log only bells, bonnets and inkcaps take.
const ON_FLOOR = [0.3, 0.12, 0.12, 0.2, 0.13, 0.13];
// How long a mushroom scrunches up before its spores go; how fast a tap's ring of light runs out (as the floor's).
export const SQUEEZE = 0.42;
export const WAVE_SPEED = 0.42;

// What the mushroom shader reads: per mushroom, four floats in each of three buffers.
export type Instances = {
  foot: Float32Array;
  shape: Float32Array;
  birth: Float32Array;
  mushrooms: number;
  mushroomsDirty: boolean;
  wobble?: Float32Array;
  wobbling?: boolean;
  // When each began to scrunch up before shooting its spores.
  squeeze?: Float32Array;
  squeezeDirty?: boolean;
};

export type Cluster = {
  hue: number;
  x: number;
  y: number;
  z: number;
  onLog: boolean;
  kind: number;
  // How big it came up, against an ordinary cluster; and how brightly it glows, 0 to 4, plus PULSING if in waves.
  scale: number;
  shade: number;
  birth: number;
  // Mushrooms of this cluster, as slots in the instance buffers, and how big each is, for the light they give.
  slots: number[];
  sizes: number[];
  nextPuff: number;
  sang: boolean;
};

const random = Math.random;
const WHITE = new THREE.Color(1, 1, 1);
const rand = (a: number, b: number) => a + random() * (b - a);

export class Bloom implements Instances {
  clusters: Cluster[] = [];
  // Mushrooms, four floats each in three buffers: where its foot is and which way is out from the cluster's middle;
  // its stem length, cap radius, lean, and kind plus four times its colour; when it began, how long it takes to grow, a
  // seed, and a turn on its lean.
  maxMushrooms: number;
  mushrooms = 0;
  foot: Float32Array;
  shape: Float32Array;
  birth: Float32Array;
  mushroomsDirty = false;
  // Each mushroom's lean from being brushed by the pointer, and how fast it is swinging, sprung back to upright.
  wobble: Float32Array;
  swing: Float32Array;
  wobbling = false;
  // Whether each has yet opened, for the little burst of spores it lets go then.
  opened: Uint8Array;
  // Threads: two vertices to each point (where, which way it runs; how far out along it, when it starts, which side and
  // how wide, a seed), six indices to each step between points.
  maxPoints: number;
  points = 0;
  indices = 0;
  threadAt: Float32Array;
  threadDir: Float32Array;
  threadInfo: Float32Array;
  threadIndex: Uint32Array;
  threadsDirty = false;
  // Spores, in a ring: where each starts and when; where it lands and how long it takes; its seed, size, rise and whether
  // it will grow.
  maxSpores: number;
  nextSpore = 0;
  sporeFrom: Float32Array;
  sporeTo: Float32Array;
  sporeInfo: Float32Array;
  sporesDirty = false;
  // Spores that will grow where they land, and when.
  landings: { at: number; x: number; z: number }[] = [];
  maxClusters: number;
  // Asked of the scene: play a sound as each new cluster first shows, and as a cluster shoots its spores.
  onBloom: (c: Cluster) => void = () => {};
  onPuff: (c: Cluster, at: number) => void = () => {};
  squeeze: Float32Array;
  squeezeDirty = false;
  // Rings of light running out through the floor from where it was tapped: where and when, and how far each had got.
  waves: { x: number; z: number; at: number; reach: number }[] = [];

  constructor(maxMushrooms: number, maxPoints: number, maxSpores: number, maxClusters: number) {
    this.maxMushrooms = maxMushrooms;
    this.maxPoints = maxPoints;
    this.maxSpores = maxSpores;
    this.maxClusters = maxClusters;
    this.foot = new Float32Array(maxMushrooms * 4);
    this.shape = new Float32Array(maxMushrooms * 4);
    this.birth = new Float32Array(maxMushrooms * 4);
    this.wobble = new Float32Array(maxMushrooms * 2);
    this.swing = new Float32Array(maxMushrooms * 2);
    this.opened = new Uint8Array(maxMushrooms);
    this.squeeze = new Float32Array(maxMushrooms).fill(-1000);
    this.threadAt = new Float32Array(maxPoints * 2 * 3);
    this.threadDir = new Float32Array(maxPoints * 2 * 3);
    this.threadInfo = new Float32Array(maxPoints * 2 * 4);
    this.threadIndex = new Uint32Array(maxPoints * 6);
    this.sporeFrom = new Float32Array(maxSpores * 4);
    this.sporeTo = new Float32Array(maxSpores * 4);
    this.sporeInfo = new Float32Array(maxSpores * 4);
    // Spores not yet used are long gone.
    for (let i = 0; i < maxSpores; i++) this.sporeFrom[i * 4 + 3] = -1000;
  }

  reset() {
    this.clusters = [];
    this.mushrooms = 0;
    this.wobble.fill(0);
    this.swing.fill(0);
    this.opened.fill(0);
    this.squeeze.fill(-1000);
    this.squeezeDirty = true;
    this.waves = [];
    this.points = 0;
    this.indices = 0;
    this.landings = [];
    for (let i = 0; i < this.maxSpores; i++) this.sporeFrom[i * 4 + 3] = -1000;
    this.mushroomsDirty = this.threadsDirty = this.sporesDirty = true;
  }

  // A cluster where a spore has landed: a troop of little bells, or a few stouter caps, each mushroom starting a
  // moment after the last, leaning out from the middle as a crowded troop does. Its threads spread from it.
  // `byHand`: planted where the floor was touched, which always finds room; a cluster sown by drifting spores leaves room
  // for those, stopping well short of the limits.
  plant(x: number, z: number, now: number, kindWanted?: number, byHand = false) {
    if (!byHand && (this.clusters.length >= this.maxClusters * 0.7 || this.mushrooms >= this.maxMushrooms * 0.65)) return null;
    // Not on top of another.
    for (const c of this.clusters) if (Math.hypot(c.x - x, c.z - z) < 0.07) return null;
    while (byHand && this.clusters.length > 1 && (this.clusters.length >= this.maxClusters || this.mushrooms > this.maxMushrooms - 40)) this.evictOldest();
    const s = surfaceAt(x, z);
    let kind = kindWanted ?? 0;
    if (kindWanted === undefined) {
      if (s.onLog) kind = [0, 3, 4][Math.floor(random() * 3)];
      else {
        let pick = random();
        kind = ON_FLOOR.findIndex((p) => (pick -= p) < 0);
        if (kind < 0) kind = 0;
      }
    }
    // Any of the eight colours: the style's own four, or the neons of the giants.
    const hue = random() < 0.55 ? Math.floor(random() * 4) : 4 + Math.floor(random() * 4);
    // Most glow faintly; a few are brilliant, and stand out across the floor.
    const tone = random();
    const level = tone < 0.22 ? 0 : tone < 0.47 ? 1 : tone < 0.77 ? 2 : tone < 0.93 ? 3 : 4;
    // Some, lit at all, glow in waves instead of steadily.
    const shade = level > 0 && random() < 0.3 ? level + PULSING : level;
    const cluster: Cluster = { hue, x, y: s.y, z, onLog: s.onLog, kind, scale: 1, shade, birth: now, slots: [], sizes: [], nextPuff: now + rand(9, 16), sang: false };
    const K = KIND[kind];
    // Every cluster its own: most small to middling, some big, and now and then one much bigger than the rest.
    const size = random();
    // And a tap, now and then, raises a giant of a cluster, twice the biggest of the rest.
    const scale = byHand && random() < 0.1 ? rand(6, 7) : size < 0.12 ? rand(2.2, 3.4) : size < 0.32 ? rand(1.4, 2) : rand(0.55, 1.3);
    cluster.scale = scale;
    const count = Math.max(1, Math.round(rand(K.count[0], K.count[1]) * Math.min(1.5, 0.6 + scale * 0.4)));
    for (let k = 0; k < count && this.mushrooms < this.maxMushrooms; k++) {
      const i = this.mushrooms++;
      const spread = K.spread * scale;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * spread * (k === 0 ? 0.2 : 1);
      const fx = x + Math.cos(a) * r;
      const fz = z + Math.sin(a) * r;
      const fy = surfaceAt(fx, fz).y - 0.002;
      // The middle ones tallest, the outer ones shorter and leaning out.
      const out = r / spread;
      const big = rand(0.75, 1.25) * (1 - out * 0.35);
      const stem = rand(K.stem[0], K.stem[1]) * big * scale;
      // And every head its own, some big for their stems.
      const cap = rand(K.cap[0], K.cap[1]) * big * scale * (random() < 0.2 ? rand(1.3, 1.6) : rand(0.8, 1.15));
      this.opened[i] = 0;
      this.wobble[i * 2] = this.wobble[i * 2 + 1] = this.swing[i * 2] = this.swing[i * 2 + 1] = 0;
      const lean = K.lean * out + rand(0, 0.12);
      this.foot.set([fx, fy, fz, a], i * 4);
      this.shape.set([stem, cap, lean, kind + hue * KINDS + shade * SHADES], i * 4);
      this.birth.set(
        [
          now + k * rand(0.1, 0.3) + rand(0, 0.3),
          (kind === 2 ? rand(6, 9) : kind === 1 || kind === 5 ? rand(5, 7.5) : rand(3.5, 5.5)) * Math.min(1.6, Math.sqrt(scale)),
          random() * 100,
          rand(-0.6, 0.6)
        ],
        i * 4
      );
      cluster.slots.push(i);
      cluster.sizes.push(Math.min(2.2, cap * 55));
    }
    // Tiny bonnets among any cluster of bigger ones: a few round the foot of the biggest, and more scattered between.
    if (kind !== 3 && cluster.slots.length) {
      const T = KIND[3];
      const [bx, , bz] = this.foot.subarray(cluster.slots[0] * 4, cluster.slots[0] * 4 + 3);
      const baseStem = this.shape[cluster.slots[0] * 4];
      const around = Math.round(rand(3, 6));
      const between = Math.round(rand(2, 6) * scale);
      for (let k = 0; k < around + between && this.mushrooms < this.maxMushrooms; k++) {
        const i = this.mushrooms++;
        const a = random() * Math.PI * 2;
        const r = k < around ? rand(0.006, 0.016) + baseStem * 0.05 : Math.sqrt(random()) * K.spread * scale * 1.1;
        const [cx, cz] = k < around ? [bx, bz] : [x, z];
        const fx = cx + Math.cos(a) * r;
        const fz = cz + Math.sin(a) * r;
        const fy = surfaceAt(fx, fz).y - 0.002;
        const tiny = rand(0.7, 1.3);
        this.opened[i] = 0;
        this.wobble[i * 2] = this.wobble[i * 2 + 1] = this.swing[i * 2] = this.swing[i * 2 + 1] = 0;
        this.foot.set([fx, fy, fz, a], i * 4);
        this.shape.set([rand(T.stem[0], T.stem[1]) * tiny, rand(T.cap[0], T.cap[1]) * tiny, T.lean * rand(0.3, 1), 3 + hue * KINDS + shade * SHADES], i * 4);
        // They come up after the big ones have started.
        this.birth.set([now + rand(1, 3.5), rand(3, 4.5), random() * 100, rand(-0.6, 0.6)], i * 4);
        cluster.slots.push(i);
        cluster.sizes.push(0.2);
      }
    }
    this.mushroomsDirty = true;
    this.clusters.push(cluster);
    if (!s.onLog) this.spreadThreads(cluster, now);
    return cluster;
  }

  // Mycelium: threads wandering out from the cluster through the litter, forking as they go, and a thicker strand
  // reaching to the nearest other cluster, so the blooms are joined underground.
  private spreadThreads(c: Cluster, now: number) {
    const start = now + 0.6;
    const V = VEINS[veinStyle.value as number] ?? VEINS[0];
    const roots = Math.round(rand(V.count[0], V.count[1]));
    for (let k = 0; k < roots; k++) this.walk(c.x, c.z, random() * Math.PI * 2, rand(V.length[0], V.length[1]), 0, start, V.width, 0, V.forks);
    let nearest: Cluster | null = null;
    let best = 0.95;
    for (const o of this.clusters)
      if (o !== c && !o.onLog) {
        const d = Math.hypot(o.x - c.x, o.z - c.z);
        if (d < best) {
          best = d;
          nearest = o;
        }
      }
    if (nearest) {
      // A strand toward it, wandering a little either side of the straight way.
      const pts: [number, number][] = [];
      const steps = Math.ceil(best / 0.012);
      const bend = rand(-0.12, 0.12);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const side = Math.sin(t * Math.PI) * bend + Math.sin(t * 17 + c.x * 9) * 0.008;
        const dx = (nearest.x - c.x) / best;
        const dz = (nearest.z - c.z) / best;
        pts.push([c.x + (nearest.x - c.x) * t - dz * side, c.z + (nearest.z - c.z) * t + dx * side]);
      }
      this.strip(pts, 0, start, 0.0004, 1);
    }
  }

  // One wandering thread: a step at a time, its turning itself drifting, so it bends in smooth, lazy curves rather
  // than zigzags; sometimes forking.
  private walk(x: number, z: number, heading: number, length: number, arc0: number, start: number, width: number, depth: number, forks: number) {
    const pts: [number, number][] = [[x, z]];
    const step = 0.008;
    let h = heading;
    let turn = rand(-0.08, 0.08);
    let px = x;
    let pz = z;
    for (let s = step; s < length; s += step) {
      turn = turn * 0.88 + rand(-0.05, 0.05);
      h += turn;
      px += Math.cos(h) * step;
      pz += Math.sin(h) * step;
      if (Math.abs(px) > 2.1 || Math.abs(pz) > 2.1 || surfaceAt(px, pz).onLog) break;
      pts.push([px, pz]);
      if (forks > 0 && depth < 3 && random() < 0.11)
        this.walk(px, pz, h + rand(0.5, 1.1) * (random() < 0.5 ? -1 : 1), (length - s) * rand(0.4, 0.8), arc0 + s, start, width * 0.75, depth + 1, forks - 1);
    }
    this.strip(pts, arc0, start, width, 0);
  }

  // Writes a thread as a strip of points, two vertices to each, ready for the shader to turn toward the eye; smoothed
  // first, so no corner is left sharp.
  private strip(raw: [number, number][], arc0: number, start: number, width: number, strand: number) {
    const pts = raw.map(([x, z], i): [number, number] => {
      if (i === 0 || i === raw.length - 1) return [x, z];
      const [ax, az] = raw[i - 1];
      const [bx, bz] = raw[i + 1];
      return [(ax + 2 * x + bx) / 4, (az + 2 * z + bz) / 4];
    });
    if (pts.length < 2 || this.points + pts.length > this.maxPoints) return;
    let arc = arc0;
    const seed = random() * 100;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const [nx, nz] = pts[Math.min(i + 1, pts.length - 1)];
      const [bx, bz] = pts[Math.max(i - 1, 0)];
      if (i > 0) arc += Math.hypot(x - bx, z - bz);
      const y = surfaceAt(x, z).y + 0.0035;
      const ny = surfaceAt(nx, nz).y + 0.0035;
      const by = surfaceAt(bx, bz).y + 0.0035;
      const dir = new THREE.Vector3(nx - bx, ny - by, nz - bz).normalize();
      // Thinning to a fine tip, never quite to nothing.
      const taper = Math.max(0.25, 1 - i / pts.length);
      for (const side of [-1, 1]) {
        const v = this.points * 2 + (side > 0 ? 1 : 0);
        this.threadAt.set([x, y, z], v * 3);
        this.threadDir.set([dir.x, dir.y, dir.z], v * 3);
        this.threadInfo.set([arc, start + strand * 0.4, side * width * taper, seed + strand * 1000], v * 4);
      }
      if (i > 0) {
        const a = (this.points - 1) * 2;
        const b = this.points * 2;
        this.threadIndex.set([a, a + 1, b, a + 1, b + 1, b], this.indices);
        this.indices += 6;
      }
      this.points++;
    }
    this.threadsDirty = true;
  }

  // A puff of spores from a point: they burst up and out in a little cloud and drift down, glowing, to land round
  // about. `seeds` of them grow where they land, if there is floor there.
  // `drift`: a cluster's own breath of spores, always a light sparkle whatever cloud is chosen for those let go by hand.
  puff(x: number, y: number, z: number, now: number, count: number, seeds: number, spread = 0.22, rise = 0.12, life = [2.4, 4.2], stream = 0.8, drift = false) {
    for (let k = 0; k < count; k++) {
      const i = this.nextSpore;
      this.nextSpore = (this.nextSpore + 1) % this.maxSpores;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * spread;
      const lx = x + Math.cos(a) * r;
      const lz = z + Math.sin(a) * r;
      const seeding = k < seeds;
      const ly = surfaceAt(lx, lz).y + 0.002;
      const time = rand(life[0], life[1]);
      // Let go over a moment, a stream rather than a shot, so they rise as a plume.
      const born = now + random() * stream;
      this.sporeFrom.set([x + rand(-0.008, 0.008), y + rand(0.004, 0.02), z + rand(-0.008, 0.008), born], i * 4);
      this.sporeTo.set([lx, ly, lz, time], i * 4);
      this.sporeInfo.set([random() * 100, seeding ? rand(1.3, 1.7) : rand(0.4, 1.3), rise * rand(0.6, 1.4), seeding ? 1 : drift ? 2 : 0], i * 4);
      if (seeding) this.landings.push({ at: born + time, x: lx, z: lz });
    }
    this.sporesDirty = true;
  }

  // A drift of spores breathed out by a grown cluster: they rise and wander off on the air, most fading as they go.
  breathe(c: Cluster, now: number) {
    const seeds = this.clusters.length < this.maxClusters && random() < 0.45 ? 1 : 0;
    // A jet from the caps: each grown mushroom of the cluster shoots a little stream up from under its cap, and the
    // cloud drifts off on the air.
    // Each first scrunches down, shivers, and springs up, and the spores go as it springs.
    for (const i of c.slots) {
      if (now - this.birth[i * 4] < this.birth[i * 4 + 1]) continue;
      const x = this.foot[i * 4];
      const z = this.foot[i * 4 + 2];
      const top = this.foot[i * 4 + 1] + this.shape[i * 4];
      const start = now + random() * 0.35;
      this.squeeze[i] = start;
      // All at once as the cap springs up, not trickling out after it.
      this.puff(x, top, z, start + SQUEEZE, Math.round(rand(8, 14)), 0, rand(0.2, 0.5), rand(0.12, 0.3), [5, 9], 0.12, true);
    }
    this.squeezeDirty = true;
    this.onPuff(c, now + SQUEEZE);
    const top = c.y + [0.06, 0.065, 0.13, 0.02, 0.1, 0.05][c.kind];
    if (seeds) {
      // One that comes down a little way off and starts a new cluster.
      const a = random() * Math.PI * 2;
      const r = rand(0.25, 0.6);
      const lx = c.x + Math.cos(a) * r;
      const lz = c.z + Math.sin(a) * r;
      if (Math.hypot(lx, lz) < 1.9) {
        const i = this.nextSpore;
        this.nextSpore = (this.nextSpore + 1) % this.maxSpores;
        const time = rand(4, 6);
        this.sporeFrom.set([c.x, top, c.z, now], i * 4);
        this.sporeTo.set([lx, surfaceAt(lx, lz).y + 0.002, lz, time], i * 4);
        this.sporeInfo.set([random() * 100, 1.6, 0.14, 1], i * 4);
        this.landings.push({ at: now + time, x: lx, z: lz });
      }
    }
  }

  // Each frame: plant where seeding spores have come down, let grown clusters breathe, and gather the light the blooms
  // throw on the floor.
  // Brushing past mushrooms: those near the pointer's ray are pushed the way it moves. Returns how many were struck,
  // and the biggest cap among them, for the sound.
  brush(origin: THREE.Vector3, dir: THREE.Vector3, push: THREE.Vector3) {
    let hit = 0;
    let biggest = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.mushrooms; i++) {
      const stem = this.shape[i * 4];
      const cap = this.shape[i * 4 + 1];
      p.set(this.foot[i * 4], this.foot[i * 4 + 1] + stem * 0.85, this.foot[i * 4 + 2]);
      const t = p.clone().sub(origin).dot(dir);
      if (t < 0) continue;
      const d = p.distanceTo(origin.clone().addScaledVector(dir, t));
      if (d > cap * 1.4 + 0.006) continue;
      // A lean, as a fraction of height, so small and tall bend alike.
      this.swing[i * 2] += (push.x * 40) / Math.max(stem, 0.01);
      this.swing[i * 2 + 1] += (push.z * 40) / Math.max(stem, 0.01);
      hit++;
      biggest = Math.max(biggest, cap);
    }
    if (hit) this.wobbling = true;
    return { hit, biggest };
  }

  // Makes room: the oldest cluster goes, and the mushrooms after it close up the gap in the buffers.
  private evictOldest() {
    const gone = this.clusters.shift();
    if (!gone) return;
    const dead = new Set(gone.slots);
    const moved = new Int32Array(this.mushrooms).fill(-1);
    let to = 0;
    for (let from = 0; from < this.mushrooms; from++) {
      if (dead.has(from)) continue;
      moved[from] = to;
      if (from !== to) {
        this.foot.copyWithin(to * 4, from * 4, from * 4 + 4);
        this.shape.copyWithin(to * 4, from * 4, from * 4 + 4);
        this.birth.copyWithin(to * 4, from * 4, from * 4 + 4);
        this.wobble.copyWithin(to * 2, from * 2, from * 2 + 2);
        this.swing.copyWithin(to * 2, from * 2, from * 2 + 2);
        this.opened[to] = this.opened[from];
        this.squeeze[to] = this.squeeze[from];
      }
      to++;
    }
    this.mushrooms = to;
    for (const c of this.clusters) c.slots = c.slots.map((i) => moved[i]);
    this.mushroomsDirty = this.squeezeDirty = this.wobbling = true;
  }

  // A ring of light set off by a tap.
  wave(x: number, z: number, now: number) {
    this.waves.push({ x, z, at: now, reach: 0 });
  }

  update(now: number) {
    if (this.landings.length) {
      const due = this.landings.filter((l) => l.at <= now);
      if (due.length) {
        this.landings = this.landings.filter((l) => l.at > now);
        for (const l of due) this.plant(l.x, l.z, now);
      }
    }
    // The brushed mushrooms swing back to upright on a spring.
    if (this.wobbling) {
      const dt = 1 / 60;
      let moving = false;
      for (let i = 0; i < this.mushrooms * 2; i++) {
        this.swing[i] += (-this.wobble[i] * 90 - this.swing[i] * 5) * dt;
        this.wobble[i] = Math.max(-0.6, Math.min(0.6, this.wobble[i] + this.swing[i] * dt));
        if (Math.abs(this.wobble[i]) > 1e-4 || Math.abs(this.swing[i]) > 1e-3) moving = true;
      }
      this.wobbling = moving;
    }
    // A ring of light running out from a tap sets each mushroom it reaches rocking, away from where it began, less the
    // further it has run.
    for (const w of this.waves) {
      const age = now - w.at;
      const front = age * WAVE_SPEED;
      const fade = Math.pow(0.25, age);
      if (fade > 0.02)
        for (let i = 0; i < this.mushrooms; i++) {
          const dx = this.foot[i * 4] - w.x;
          const dz = this.foot[i * 4 + 2] - w.z;
          const d = Math.hypot(dx, dz);
          if (d <= w.reach || d > front || d < 0.01) continue;
          const push = (fade * 1.4) / Math.max(this.shape[i * 4], 0.01);
          this.swing[i * 2] += (dx / d) * push;
          this.swing[i * 2 + 1] += (dz / d) * push;
          this.wobbling = true;
        }
      w.reach = front;
    }
    this.waves = this.waves.filter((w) => now - w.at < 3);
    // A mushroom opening lets go a little puff of spores from under its cap.
    for (let i = 0; i < this.mushrooms; i++) {
      if (this.opened[i] || now - this.birth[i * 4] < this.birth[i * 4 + 1] * 0.88) continue;
      this.opened[i] = 1;
      if (now - this.birth[i * 4] > this.birth[i * 4 + 1] * 1.5) continue;
      this.puff(this.foot[i * 4], this.foot[i * 4 + 1] + this.shape[i * 4], this.foot[i * 4 + 2], now, Math.round(4 + this.shape[i * 4 + 1] * 400), 0, 0.12, 0.06, [2, 4], 0.8, true);
    }
    glowGrid.clear();
    for (const c of this.clusters) {
      const age = now - c.birth;
      if (!c.sang && age > 0.4) {
        c.sang = true;
        this.onBloom(c);
      }
      if (age > 12 && now > c.nextPuff) {
        c.nextPuff = now + rand(8, 18);
        this.breathe(c, now);
      }
      let lit = 0;
      for (let k = 0; k < c.slots.length; k++) {
        const i = c.slots[k];
        const grown = THREE.MathUtils.clamp((now - this.birth[i * 4]) / this.birth[i * 4 + 1], 0, 1);
        lit += c.sizes[k] * grown * grown;
      }
      const flicker = 0.85 + 0.15 * Math.sin(now * 1.3 + c.x * 7);
      glowGrid.splat(
        c.x,
        c.z,
        c.kind === 2 ? 0.2 : c.kind === 3 ? 0.08 : 0.14 * Math.min(1.8, Math.sqrt(c.scale)),
        light.palette[c.hue].value as THREE.Color,
        lit * 0.12 * flicker * BRIGHTNESS[c.shade % PULSING],
        0
      );
      // The threads' light, spread wide and faint, growing in as they reach out.
      if (!c.onLog) glowGrid.splat(c.x, c.z, 0.32, WHITE, 0, THREE.MathUtils.clamp((age - 0.6) / 6, 0, 1) * 0.05);
    }
    glowGrid.upload();
  }
}

// The giants deep in the woods: a few huge glowing mushrooms in neon colours, grown long ago, in the same buffers the
// shader reads.
export function grove(giants: { x: number; z: number; stem: number; cap: number; hue: number }[], groundAt: (x: number, z: number) => number): Instances {
  const n = giants.length;
  const g: Instances = { foot: new Float32Array(n * 4), shape: new Float32Array(n * 4), birth: new Float32Array(n * 4), mushrooms: n, mushroomsDirty: true };
  giants.forEach((m, i) => {
    g.foot.set([m.x, groundAt(m.x, m.z) - 0.05, m.z, random() * Math.PI * 2], i * 4);
    g.shape.set([m.stem, m.cap, rand(0.05, 0.15), (m.stem > 1.2 ? 2 : 0) + m.hue * KINDS + 3 * SHADES], i * 4);
    g.birth.set([-100, 1, random() * 100, rand(-0.5, 0.5)], i * 4);
  });
  return g;
}
