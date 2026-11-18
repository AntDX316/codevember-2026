import * as THREE from "three/webgpu";
import {
  abs,
  atomicAdd,
  texture,
  atomicStore,
  dot,
  float,
  Fn,
  fract,
  If,
  instancedArray,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  pow,
  sign,
  sin,
  smoothstep,
  storage,
  time,
  uint,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A little desert on the GPU, a patch of dunes as a fine grid of columns, each holding a height of sand and a depth of
// water over it. Water runs by the virtual pipe method: every column keeps how fast water leaves it toward each of its
// four neighbours, sped up by the difference in surface height and never more than it holds. Sand slides where it lies
// steeper than it can stand, and damp sand stands much less steep, so banks slump into the pools. A hand drawn across
// the sand turns it to water where it passes; shallow water soon turns back to sand where it lies, deep pools slowly from
// their edges in, and dry sand drifts back over the years of a minute toward the dunes the wind made. Where water
// lingers the sand round it grows moist, grass takes hold, and palms sprout and grow at the places they would stand; the
// more water the hand has made, the further the moisture reaches, until the desert is an oasis.

// The patch is this wide, in metres of the world, and sits with its middle at the origin.
export const PATCH = 6;
// Sand may be dug down to this far below the lowest hollow.
const FLOOR = -0.05;

// The dunes the wind made: two sets of ridges crossing at an angle, here no taller than your hand.
const SCALE = 25;
const OFFSET = [41, 17];
export function homeAt(x: number, z: number) {
  const X = x * SCALE + OFFSET[0];
  const Z = z * SCALE + OFFSET[1];
  const u = 0.062 * X + 0.9 * Math.sin(0.021 * Z + 0.3) + 0.4 * Math.sin(0.013 * X);
  const v = 0.075 * Z + 0.08 * X + 1.2 * Math.sin(0.017 * X + 1.1);
  return (6.5 * Math.pow(Math.sin(u) * 0.5 + 0.5, 2.2) + 2.6 * Math.pow(Math.sin(v) * 0.5 + 0.5, 2)) / SCALE;
}
// The same as a shader node, for a point given as a vec2 of x and z.
export function homeNode(p: any): any {
  const X = p.x.mul(SCALE).add(OFFSET[0]) as any;
  const Z = p.y.mul(SCALE).add(OFFSET[1]) as any;
  const u = X.mul(0.062)
    .add(sin(Z.mul(0.021).add(0.3)).mul(0.9))
    .add(sin(X.mul(0.013)).mul(0.4)) as any;
  const v = Z.mul(0.075)
    .add(X.mul(0.08))
    .add(sin(X.mul(0.017).add(1.1)).mul(1.2)) as any;
  return pow(sin(u).mul(0.5).add(0.5), float(2.2))
    .mul(6.5)
    .add(pow(sin(v).mul(0.5).add(0.5), float(2)).mul(2.6))
    .div(SCALE);
}

// How shadows are found, the same for the patch and the dunes beyond it so they meet without a seam: the first step
// toward the sun, how much longer each step is than the last, how many, and how far above the sand the ray starts.
export const SHADOW = { start: 0.03, grow: 1.35, steps: 14, lift: 0.004 };

export function hash(n: any): any {
  return fract(sin(n.mul(12.9898).add(4.1414)).mul(43758.5453));
}

// The way the wind blows across the desert, as x and z.
export const WIND = [0.83, 0.55] as const;

// Fair-weather cloud on a layer high over the desert, drifting with the wind: how thick it is over a point on the ground
// plan. The sky draws it, and its shadows sweep across the sand.
export const CLOUD_HEIGHT = 60;
// The cloud is a tiling pattern made once, on the processor, and read from a texture: a fetch or two a pixel instead of
// layers of noise worked out for every pixel of sky and sand.
const CLOUD_TILE = 256;
const cloudTexture = (() => {
  const data = new Uint8Array(CLOUD_TILE * CLOUD_TILE * 4);
  const field = new Float32Array(CLOUD_TILE * CLOUD_TILE);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  let amplitude = 1;
  let total = 0;
  for (let cells = 4; cells <= 64; cells *= 2) {
    const lattice = Array.from({ length: cells * cells }, random);
    const at = (i: number, j: number) => lattice[((j + cells) % cells) * cells + ((i + cells) % cells)];
    const ease = (t: number) => t * t * (3 - 2 * t);
    for (let y = 0; y < CLOUD_TILE; y++)
      for (let x = 0; x < CLOUD_TILE; x++) {
        const u = (x / CLOUD_TILE) * cells;
        const v = (y / CLOUD_TILE) * cells;
        const i = Math.floor(u);
        const j = Math.floor(v);
        const a = ease(u - i);
        const b = ease(v - j);
        const top = at(i, j) * (1 - a) + at(i + 1, j) * a;
        const bottom = at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a;
        field[y * CLOUD_TILE + x] += (top * (1 - b) + bottom * b) * amplitude;
      }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let k = 0; k < field.length; k++) {
    const value = Math.round((field[k] / total) * 255);
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = value;
    data[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, CLOUD_TILE, CLOUD_TILE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
})();
// How thick the cloud is over a point; `sharp` reads the finest level, as a compute pass must.
export function cloudAt(xz: any, sharp = false): any {
  const uv = xz.mul(0.0045).sub(vec2(...WIND).mul(time.mul(0.003))) as any;
  const read = (q: any) => (sharp ? texture(cloudTexture, q).level(float(0)) : texture(cloudTexture, q)).x as any;
  const n = mix(read(uv), read(uv.mul(1.7).add(vec2(0.31, 0.57)).add(time.mul(0.0011))), 0.35) as any;
  return smoothstep(0.5, 0.68, n);
}

// The places a palm could stand, scattered over the patch and a little way past it, apart from each other.
const PALM_SITES = 520;
// How far past the patch's edge grass and palms may grow, carried on from the green at its edge, in metres.
export const BEYOND = 1.2;

// Three kinds of palm, each taking its own run of the sites: date palms, stiff and dense; slender palms that lean and
// curve, their long fronds drooping; and fan palms, straight, round leaves over a skirt of dead ones. For each: how
// tall it grows, smallest to largest, in metres; how far it leans, as a share of its height; how far its crown
// reaches out and how far below its middle its fronds hang, as shares of the crown; how thick its trunk is, as a share
// of its height; and how many fronds its shadow shows.
export const PALM_KINDS = [
  { from: 0, to: 110 },
  { from: 110, to: 180 },
  { from: 180, to: 245 },
  { from: 245, to: 330 },
  { from: 330, to: 400 },
  { from: 400, to: 455 },
  { from: 455, to: PALM_SITES }
] as const;
const TALL = [
  [0.45, 1.25],
  [0.6, 1.55],
  [0.55, 1.45],
  [0.8, 1.7],
  [0.02, 0.06],
  [0.1, 0.32],
  [0.03, 0.08]
];
const LEAN = [
  [0.04, 0.14],
  [0.25, 0.6],
  [0.02, 0.08],
  [0.3, 0.7],
  [0, 0.05],
  [0, 0.06],
  [0, 0.04]
];
const REACH = [0.5, 0.56, 0.36, 0.62, 0.5, 0.48, 0.42];
const HANG = [0.3, 0.55, 0.35, 0.6, 0.1, 0.25, 0.05];
const TRUNK = [0.05, 0.03, 0.045, 0.032, 0.04, 0.07, 0.03];
const FRONDS = [14, 12, 16, 12, 18, 24, 20];
// The least a crown is sized by, whatever the trunk: the bushes have hardly any trunk but a full spray of fronds.
const LEAST = [0, 0, 0, 0, 0.42, 0.5, 0.5];
// The kind of the palm at a site, from the run of sites it falls in.
export const kindAt = (id: any): any => PALM_KINDS.slice(1).reduce((k: any, run, n) => id.greaterThanEqual(run.from).select(float(n + 1), k), float(0));
// One value by a palm's kind, given as a number or, worked out on the GPU, a node.
const byKind = (kind: any, values: number[]): any =>
  typeof kind === "number" ? float(values[kind]) : values.slice(1).reduce((v: any, value, n) => kind.greaterThan(n + 0.5).select(float(value), v), float(values[0]));
// A palm's shape from its site (x, z, growth, seed) and kind: its size, how tall its trunk stands and how big its crown
// is as it grows, its turn about its trunk, and the middle of its trunk at a height up it (0 to 1), bending with its lean
// and the wind, from its foot.
// `extra` lengthens the trunk downward when the ground under a grown palm has been dug away, so its crown stays put.
export function palmShape(s: any, kind: any, extra: any = float(0)) {
  const growth = s.z as any;
  const seed = s.w.mul(97.3) as any;
  const size = mix(
    byKind(
      kind,
      TALL.map((t) => t[0])
    ),
    byKind(
      kind,
      TALL.map((t) => t[1])
    ),
    pow(hash(seed), float(1.4))
  ) as any;
  // A palm comes up as a thin green shoot, which thickens and browns into a trunk; then its fronds push out folded, as a
  // spear, and open.
  const height = size
    .mul(
      smoothstep(0, 0.3, growth)
        .mul(0.25)
        .add(smoothstep(0.3, 0.95, growth).mul(0.75))
    )
    .add(extra) as any;
  // The crown grows more slowly than the trunk, so the tallest palms stand on long bare trunks.
  const grand = pow(max(size, byKind(kind, LEAST).mul(hash(seed.add(3.3)).mul(0.6).add(0.7))), float(0.55)).mul(0.78) as any;
  const crown = grand.mul(smoothstep(0.3, 0.6, growth)) as any;
  const unfurl = smoothstep(0.35, 0.9, growth) as any;
  const woody = smoothstep(0.15, 0.6, growth) as any;
  const lean = hash(seed.add(1.7)).mul(Math.PI * 2) as any;
  const leaning = vec2(lean.cos(), lean.sin()).mul(
    mix(
      byKind(
        kind,
        LEAN.map((t) => t[0])
      ),
      byKind(
        kind,
        LEAN.map((t) => t[1])
      ),
      hash(seed.add(2.9))
    )
  ) as any;
  const sway = sin(time.mul(1.1).add(seed.mul(20)))
    .mul(0.5)
    .add(0.7)
    .mul(0.03) as any;
  const bow = leaning.add(vec2(...WIND).mul(sway)) as any;
  // Some trunks are crooked: they grow one way, then part way up turn and grow on another.
  const crooked = hash(seed.add(5.5)).lessThan(0.4).select(float(1), float(0)) as any;
  const kinkAt = hash(seed.add(6.1)).mul(0.4).add(0.25) as any;
  const kinkWay = hash(seed.add(6.7)).mul(Math.PI * 2) as any;
  const kink = vec2(kinkWay.cos(), kinkWay.sin())
    .mul(hash(seed.add(7.3)).mul(0.35).add(0.15))
    .mul(crooked) as any;
  const spine = (t: any) => {
    const beyond = max(t.sub(kinkAt), float(0)) as any;
    const out = bow.mul(t.mul(t)).add(kink.mul(beyond)).mul(height) as any;
    return vec3(out.x, t.mul(height), out.y);
  };
  const turn = hash(seed.add(4.1)).mul(Math.PI * 2) as any;
  // How thick the trunk is to the geometry's unit, thinner while young.
  // Sized by the crown rather than the height, so a tall palm's trunk stays slender under its crown.
  const thick = grand.mul(mix(float(0.18), float(1), smoothstep(0.05, 0.8, growth))) as any;
  return { growth, seed, size, height, crown, turn, spine, thick, unfurl, woody };
}
// How much of the ground a crown of fronds covers at an offset from under its middle: the fronds as spokes, broad near
// the middle and narrowing to their tips, with light through the gaps between their leaflets.
function crownCover(d: any, reach: any, fronds: any, turn: any): any {
  const out = length(d).div(max(reach, float(1e-4))) as any;
  const a = d.y.atan(d.x).sub(turn) as any;
  const spoke = abs(sin(a.mul(fronds).mul(0.5))) as any;
  const edge = mix(float(0.95), float(0.4), out) as any;
  const blade = smoothstep(edge.add(0.12), edge.sub(0.12), spoke) as any;
  const gaps = sin(out.mul(38).add(a.mul(3)))
    .mul(0.25)
    .add(0.75) as any;
  return max(blade.mul(gaps), smoothstep(0.3, 0.12, out)).mul(smoothstep(1, 0.8, out));
}
// How far a point is from a segment, all in the plane.
function toSegment(p: any, a: any, b: any): any {
  const ab = b.sub(a) as any;
  const t = dot(p.sub(a), ab)
    .div(max(dot(ab, ab), float(1e-6)))
    .clamp(0, 1) as any;
  return length(p.sub(a.add(ab.mul(t))));
}
// The palms' shade and where they stand, on a grid over the patch and past it: this wide, this many to a side.
const SPAN = PATCH + BEYOND * 2 + 1.6;
const SPAN_CELLS = 256;

export function createDesert(N: number, sprays: number) {
  const CELL = PATCH / N;
  const CELLS = N * N;
  // Per column: sand height, water depth, how damp the sand is (0 to 1), and how lately it was turned (0 to 1).
  const cells = instancedArray(CELLS, "vec4");
  const next = instancedArray(CELLS, "vec4");
  // How fast water leaves each column toward -x, +x, -z and +z.
  const flux = instancedArray(CELLS, "vec4");
  const home = instancedArray(CELLS, "float");
  // The light on each column: how much of the sun reaches it, and the sand's normal.
  const light = instancedArray(CELLS, "vec4");
  // The colour each column's sand shows, lit, worked out once a frame and shared by the sand and its grains.
  const tone = instancedArray(CELLS, "vec4");
  // Spray: grains flung up by the hand that turn to drops in the air, and grains the wind lifts off the crests. Where
  // each is (w: life left, 0 to 1), and how it moves (w: 1 turning to water, 0 blown sand).
  const sprayAt = instancedArray(sprays, "vec4");
  // Life: how moist the ground is (1 under water, falling away from it), how green it has grown (0 to 1), and the same
  // a step on, written apart so the moisture spreads evenly.
  const life = instancedArray(CELLS, "vec4");
  const lifeNext = instancedArray(CELLS, "vec4");
  // The palms: where each could stand (x, z), how far grown (0 to 1), and a seed of its own.
  const palms = instancedArray(PALM_SITES, "vec4");
  // Each palm as it stands this frame: the middle of its crown and how far its fronds reach (0 if it has not grown);
  // and the height of its foot, its trunk's radius, its turn and its kind.
  const crowns = instancedArray(PALM_SITES, "vec4");
  const roots = instancedArray(PALM_SITES, "float");
  const stems = instancedArray(PALM_SITES, "vec4");
  // Over the grid: how much sun the palms let through, the lowest and highest a palm stands over each point, and the
  // lowest its fronds hang there, below which it is trunk.
  const canopy = instancedArray(SPAN_CELLS * SPAN_CELLS, "vec4");
  const sprayVelocity = instancedArray(sprays, "vec4");

  const u = {
    // The hand: where it is (x, z), how wide, and whether it is down; and how fast it moves, metres a frame.
    hand: uniform(new THREE.Vector4(0, 0, 0.22, 0)),
    handVelocity: uniform(new THREE.Vector2()),
    // Rates, each per step (set from per-second rates by the scene): how much sand a column at the hand's middle turns
    // to water, in metres; how quickly water turns back to sand, shallow and deep; and how quickly dry sand drifts back
    // to the dunes, as a fraction of the way.
    melt: uniform(0.002),
    dryShallow: uniform(0.00005),
    dryDeep: uniform(0.00001),
    drift: uniform(0.00005),
    toSun: uniform(new THREE.Vector3(0.5, 0.4, -0.5)),
    wind: uniform(new THREE.Vector2(0.8, 0.3)),
    gust: uniform(0.4),
    frame: uniform(0),
    // How fully the desert has turned to an oasis (0 to 1); how much the moisture keeps from one column to the next, and
    // how quickly, per frame, green grows and withers and palms grow and die back.
    oasis: uniform(0),
    reach: uniform(0.9),
    grow: uniform(0.002),
    wither: uniform(0.0002),
    palmGrow: uniform(0.001),
    palmWither: uniform(0.0003),
    // How far, in metres, green carries out past the patch's edge.
    spread: uniform(0.2),
    // While drying back to the dunes, the part of the way taken each frame; 0 otherwise.
    recede: uniform(0)
  };

  // A column's index from its place on the grid, kept on it.
  const clampI = (i: any) => (max as any)((min as any)(i, int(N - 1)), int(0));
  const at = (i: any, j: any) => clampI(j).mul(N).add(clampI(i));
  const place = () => {
    const id = int(instanceIndex);
    return { id, i: id.mod(N), j: id.div(N) };
  };
  // The middle of a column in the world, and the column under a point.
  const centre = (i: any, j: any) =>
    vec2(
      float(i)
        .add(0.5)
        .mul(CELL)
        .sub(PATCH / 2),
      float(j)
        .add(0.5)
        .mul(CELL)
        .sub(PATCH / 2)
    );
  const columnOf = (p: any) => {
    const g = p.add(PATCH / 2).div(CELL) as any;
    return at(int(g.x), int(g.y));
  };

  // How green the ground is at a point: inside the patch, as grown; past its edge, the green of the nearest edge, fading
  // over a wavering distance, so an oasis at the edge spills out over the dunes beyond.
  const greenNear = (p: any) => {
    const edge = PATCH / 2 - CELL * 3;
    const q = p.clamp(-edge, edge) as any;
    const out = length(p.sub(q)) as any;
    const reach = u.spread.mul(
      sin(p.x.mul(7))
        .mul(sin(p.y.mul(5)))
        .mul(0.3)
        .add(0.85)
    ) as any;
    return life.element(columnOf(q)).y.mul(float(1).sub(smoothstep(0, reach, out)));
  };
  // Whether a point is on the patch.
  const onPatch = (p: any) => max(abs(p.x), abs(p.y)).lessThan(PATCH / 2 - CELL);

  // How strongly the surface pulls water from one column to the next, and how much of its speed it keeps.
  const PULL = 0.22;
  const KEEP = 0.992;
  const flow = Fn(() => {
    const { id, i, j } = place();
    const c = cells.element(id) as any;
    const surface = c.x.add(c.y) as any;
    const across = (n: any) => {
      const o = cells.element(n) as any;
      return surface.sub(o.x.add(o.y));
    };
    const f = flux.element(id) as any;
    const h = u.hand as any;
    const d = length(centre(i, j).sub(h.xy)) as any;
    // The hand pushes the water the way it moves.
    const push = vec2(u.handVelocity).mul(smoothstep(h.z, h.z.mul(0.3), d).mul(h.w).mul(c.y).mul(40)) as any;
    const out = max(
      vec4(
        f.x
          .mul(KEEP)
          .add(across(at(i.sub(1), j)).mul(PULL))
          .sub(push.x),
        f.y
          .mul(KEEP)
          .add(across(at(i.add(1), j)).mul(PULL))
          .add(push.x),
        f.z
          .mul(KEEP)
          .add(across(at(i, j.sub(1))).mul(PULL))
          .sub(push.y),
        f.w
          .mul(KEEP)
          .add(across(at(i, j.add(1))).mul(PULL))
          .add(push.y)
      ),
      vec4(0)
    ) as any;
    const total = out.x.add(out.y).add(out.z).add(out.w) as any;
    flux.element(id).assign(out.mul(min(float(1), c.y.div(max(total, float(1e-9))))));
  })().compute(CELLS);

  // How steep sand may lie, as the rise across one column: dry, and damp.
  const STAND_DRY = CELL * 0.7;
  const STAND_DAMP = CELL * 0.22;
  const NEIGHBOURS = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2]
  ];
  const update = Fn(() => {
    const { id, i, j } = place();
    const c = cells.element(id) as any;
    const f = flux.element(id) as any;
    const into = flux
      .element(at(i.sub(1), j))
      .y.add(flux.element(at(i.add(1), j)).x)
      .add(flux.element(at(i, j.sub(1))).w)
      .add(flux.element(at(i, j.add(1))).z) as any;
    const water = max(c.y.add(into).sub(f.x.add(f.y).add(f.z).add(f.w)), float(0)).toVar();
    const sand = c.x.toVar();

    // Sand slides from wherever it stands steeper than it can toward its neighbours, the same between each pair either
    // way, so none is made or lost.
    const slide = float(0).toVar();
    for (const [di, dj, reach] of NEIGHBOURS) {
      const o = cells.element(at(i.add(di), j.add(dj))) as any;
      const stand = mix(float(STAND_DRY), float(STAND_DAMP), max(c.z, o.z)).mul(reach) as any;
      const rise = o.x.sub(c.x) as any;
      slide.addAssign(
        sign(rise)
          .mul(max(abs(rise).sub(stand), float(0)))
          .mul(0.07)
      );
    }
    sand.addAssign(slide);

    // The hand turns sand to water.
    const h = u.hand as any;
    const d = length(centre(i, j).sub(h.xy)) as any;
    const touch = smoothstep(h.z, h.z.mul(0.25), d).mul(h.w) as any;
    const melted = min(max(sand.sub(FLOOR), float(0)), u.melt.mul(touch)) as any;
    // Sand packs looser than water, so what it melts to lies lower, and the hand leaves a channel that fills.
    sand.subAssign(melted);
    water.addAssign(melted.mul(0.55));

    // Water turns back to sand: quickly where it lies shallow, slowly where it is deep.
    const dried = min(water, mix(u.dryShallow, u.dryDeep, smoothstep(0.002, 0.03, water))) as any;
    water.subAssign(dried);
    sand.addAssign(dried.div(0.55));

    // Dry sand drifts back toward the dunes.
    const dry = float(1)
      .sub(smoothstep(0, 0.002, water))
      .mul(float(1).sub(c.z)) as any;
    const own = home.element(id) as any;
    sand.addAssign(own.sub(sand).mul(u.drift).mul(dry));

    const damp = max(c.z.mul(0.9993), smoothstep(0.0003, 0.003, water)) as any;
    const fresh = max(c.w.mul(0.96), touch.mul(smoothstep(0, 0.0005, melted))) as any;

    // The rim stays as the wind made it, and water runs off it.
    If(
      i
        .lessThan(2)
        .or(j.lessThan(2))
        .or(i.greaterThan(N - 3))
        .or(j.greaterThan(N - 3)),
      () => {
        sand.assign(own);
        water.assign(0);
      }
    );
    next.element(id).assign(vec4(sand, water, damp, fresh));
  })().compute(CELLS);

  const copy = Fn(() => {
    cells.element(instanceIndex).assign(next.element(instanceIndex));
  })().compute(CELLS);

  // Moisture spreads out from the water a column a frame, keeping a little less at each, and the green follows it: it
  // grows where the ground stays moist, though not under deep water, and withers slowly where it dries.
  const moisten = Fn(() => {
    const { id, i, j } = place();
    const c = cells.element(id) as any;
    const l = life.element(id) as any;
    const wet = smoothstep(0.001, 0.006, c.y) as any;
    const side = (a: number, b: number) => life.element(at(i.add(a), j.add(b))).x as any;
    const straight = max(max(side(-1, 0), side(1, 0)), max(side(0, -1), side(0, 1))).mul(u.reach) as any;
    const diagonal = max(max(side(-1, -1), side(1, -1)), max(side(-1, 1), side(1, 1))).mul(pow(u.reach, float(Math.SQRT2))) as any;
    const moist = max(wet, max(straight, diagonal)) as any;
    const target = smoothstep(0.12, 0.55, moist).mul(float(1).sub(smoothstep(0.006, 0.02, c.y))) as any;
    const green = l.y.add(target.greaterThan(l.y).select(target.sub(l.y).min(u.grow), target.sub(l.y).max(u.wither.negate()))) as any;
    lifeNext.element(id).assign(vec4(moist, green, 0, 0));
  })().compute(CELLS);
  const settle = Fn(() => {
    life.element(instanceIndex).assign(lifeNext.element(instanceIndex));
  })().compute(CELLS);

  // A palm grows where the ground round it has stayed green, and more of the places a palm could stand take one as the
  // oasis grows; it dies back where the ground dries, and faster where water drowns it.
  const sprout = Fn(() => {
    const s = palms.element(instanceIndex) as any;
    const k = columnOf(s.xy) as any;
    const green = greenNear(s.xy) as any;
    const water = onPatch(s.xy).select(cells.element(k).y, float(0)) as any;
    const willing = s.w.lessThan(u.oasis.mul(0.56).add(0.13)) as any;
    const thriving = green.greaterThan(0.6).and(water.lessThan(0.002)).and(willing) as any;
    const dying = green.lessThan(0.25).or(water.greaterThan(0.01)) as any;
    // A palm that has come up never goes back: only a seedling not yet out of the ground can wither away.
    const seedling = s.z.lessThan(0.02) as any;
    const growth = thriving.select(s.z.add(u.palmGrow), dying.and(seedling).select(s.z.sub(u.palmWither.mul(water.greaterThan(0.01).select(float(4), float(1)))), s.z)) as any;
    palms.element(instanceIndex).assign(vec4(s.xy, growth.clamp(0, 1), s.w));
  })().compute(PALM_SITES);

  // Drying back to the dunes in a moment, a part of the way each frame: the water draining away, the sand coming back to
  // where the wind laid it, the green and the palms dying back. Only for unwinding (engine/unwind); the day never asks.
  const recede = Fn(() => {
    const id = int(instanceIndex);
    const keep = float(1).sub(u.recede) as any;
    const c = cells.element(id) as any;
    cells.element(id).assign(vec4(mix(c.x, home.element(id), u.recede), c.y.mul(keep), c.z.mul(keep), c.w.mul(keep)));
    flux.element(id).assign((flux.element(id) as any).mul(keep));
    const l = life.element(id) as any;
    life.element(id).assign(vec4(l.x.mul(keep), l.y.mul(keep), l.z, l.w));
  })().compute(CELLS);
  const recedePalms = Fn(() => {
    const s = palms.element(instanceIndex) as any;
    palms.element(instanceIndex).assign(vec4(s.xy, max(s.z.sub(u.recede.mul(1.5)), float(0)), s.w));
  })().compute(PALM_SITES);

  // The palms that have come up, listed each frame, so the shade below loops over those alone, not every site.
  const grownCount = instancedArray(1, "uint") as any;
  const grownTally = grownCount.toAtomic() as any;
  const grownRead = storage(grownCount.value, "uint", 1) as any;
  const grownList = instancedArray(PALM_SITES, "uint") as any;
  const clearGrown = Fn(() => {
    atomicStore(grownTally.element(0), uint(0));
  })().compute(1);
  // Each palm as it stands, from its site, its kind and the sand under it.
  const frame = Fn(() => {
    const id = int(instanceIndex) as any;
    const s = palms.element(id) as any;
    const kind = kindAt(id);
    const base = onPatch(s.xy).select(cells.element(columnOf(s.xy)).x, homeNode(s.xy)) as any;
    // The highest the ground has stood under it since it came up: if the sand below is dug away or drowned, the trunk
    // reaches down to the new ground and the crown stays where it was.
    const root = s.z.lessThan(0.01).select(base, max(roots.element(id), base)) as any;
    roots.element(id).assign(root);
    const { growth, crown, spine, thick, turn } = palmShape(s, kind, root.sub(base));
    const top = spine(float(1)) as any;
    crowns.element(id).assign(vec4(s.x.add(top.x), base.add(top.y), s.y.add(top.z), growth.greaterThan(0.01).select(crown.mul(byKind(kind, REACH)), float(0))));
    stems.element(id).assign(vec4(base, thick.mul(byKind(kind, TRUNK)), turn, kind));
    If(growth.greaterThan(0.01), () => {
      const slot = (atomicAdd(grownTally.element(0), uint(1)) as any).toVar();
      grownList.element(slot).assign(uint(id));
    });
  })().compute(PALM_SITES);

  // The palms' shade on the grid: each crown's shadow round where the sun's ray through its middle meets the ground,
  // dappled between its fronds, and each trunk's from its foot to there; and, for what the water mirrors, how low and
  // how high any crown or trunk stands over each point.
  const shadeOfPalms = Fn(() => {
    const id = int(instanceIndex) as any;
    const p = vec2(float(id.mod(SPAN_CELLS)).add(0.5), float(id.div(SPAN_CELLS)).add(0.5))
      .mul(SPAN / SPAN_CELLS)
      .sub(SPAN / 2) as any;
    const through = float(1).toVar();
    const low = float(10).toVar();
    const high = float(-10).toVar();
    const fronds = float(10).toVar();
    const sun = u.toSun as any;
    const slant = vec2(sun.x, sun.z).div(max(sun.y, float(0.1))) as any;
    Loop({ start: int(0), end: int(grownRead.element(0)), type: "int", condition: "<" }, ({ i: k }: any) => {
      const i = int(grownList.element(k)) as any;
      const c = crowns.element(i) as any;
      If(c.w.greaterThan(0), () => {
        const st = stems.element(i) as any;
        const foot = palms.element(i).xy as any;
        const spokes = byKind(st.w, FRONDS) as any;
        const shadow = c.xz.sub(slant.mul(c.y.sub(st.x))) as any;
        // Only palms whose shadow or body comes near this point need the full reckoning.
        If(
          length(p.sub(shadow))
            .lessThan(c.w.mul(1.1))
            .or(length(p.sub(c.xz)).lessThan(c.w.mul(1.1)))
            .or(toSegment(p, foot, shadow).lessThan(st.y.mul(1.6))),
          () => {
            through.mulAssign(float(1).sub(crownCover(p.sub(shadow), c.w, spokes, st.z).mul(0.82)));
            through.mulAssign(float(1).sub(smoothstep(st.y.mul(1.5), st.y.mul(0.5), toSegment(p, foot, shadow)).mul(0.85)));
            const out = length(p.sub(c.xz)).div(c.w) as any;
            If(crownCover(p.sub(c.xz), c.w, spokes, st.z).greaterThan(0.35), () => {
              const hang = c.y.sub(c.w.mul(byKind(st.w, HANG)).mul(out.mul(out).add(0.15))) as any;
              low.assign(min(low, hang));
              fronds.assign(min(fronds, hang));
              high.assign(max(high, c.y.add(c.w.mul(0.15))));
            });
            If(toSegment(p, foot, c.xz).lessThan(st.y), () => {
              low.assign(min(low, st.x));
              high.assign(max(high, c.y));
            });
          }
        );
      });
    });
    canopy.element(id).assign(vec4(through, low, high, fronds));
  })().compute(SPAN_CELLS * SPAN_CELLS);
  // The palms' shade at a point, read between the grid's points round it; and how low and how high palms stand there,
  // and where their fronds begin, from the nearest (the highest below the lowest where none does).
  const toGrid = (p: any) =>
    p
      .add(SPAN / 2)
      .div(SPAN / SPAN_CELLS)
      .sub(0.5) as any;
  const clampG = (i: any) => (max as any)((min as any)(i, int(SPAN_CELLS - 1)), int(0));
  const readG = (i: any, j: any) => canopy.element(clampG(j).mul(SPAN_CELLS).add(clampG(i))) as any;
  const within = (p: any) => max(abs(p.x), abs(p.y)).lessThan(SPAN / 2 - SPAN / SPAN_CELLS) as any;
  const palmShade = (p: any) => {
    const g = toGrid(p);
    const b = g.floor() as any;
    const t = g.sub(b) as any;
    const i = int(b.x) as any;
    const j = int(b.y) as any;
    const x = mix(mix(readG(i, j).x, readG(i.add(1), j).x, t.x), mix(readG(i, j.add(1)).x, readG(i.add(1), j.add(1)).x, t.x), t.y) as any;
    // And a cloud's shadow, from the cloud the sun's ray through this point passes on its way down.
    const sun = u.toSun as any;
    const cloud = cloudAt(
      p.add(
        vec2(sun.x, sun.z)
          .div(max(sun.y, float(0.15)))
          .mul(CLOUD_HEIGHT)
      ),
      true
    ) as any;
    return within(p)
      .select(x, float(1))
      .mul(float(1).sub(cloud.mul(0.6)));
  };
  const palmsOver = (p: any) => {
    const g = toGrid(p).add(0.5) as any;
    return within(p).select(readG(int(g.x), int(g.y)).yzw, vec3(10, -10, 10));
  };

  // The light on the sand: the slope, and how much of the sun gets past the dunes between, found by stepping toward the
  // sun over the grid and keeping how near the ray comes to passing under the sand, for soft-edged shadows.
  const shade = Fn(() => {
    const { id, i, j } = place();
    const s = (a: number, b: number) => cells.element(at(i.add(a), j.add(b))).x as any;
    const normal = normalize(vec3(s(-1, 0).sub(s(1, 0)), CELL * 2, s(0, -1).sub(s(0, 1)))) as any;
    const sun = u.toSun as any;
    const flat = normalize(vec2(sun.x, sun.z).add(vec2(1e-5, 0))) as any;
    const climb = sun.y.div(max(length(vec2(sun.x, sun.z)), float(1e-3))) as any;
    const from = cells.element(id).x.add(SHADOW.lift) as any;
    const lit = float(1).toVar();
    const t = float(SHADOW.start).toVar();
    const p = centre(i, j) as any;
    Loop(SHADOW.steps, () => {
      const q = p.add(flat.mul(t)) as any;
      const inside = max(abs(q.x), abs(q.y)).lessThan(PATCH / 2 - CELL) as any;
      const ground = inside.select(cells.element(columnOf(q)).x, homeNode(q)) as any;
      const above = from.add(t.mul(climb)).sub(ground).div(t) as any;
      lit.assign(min(lit, smoothstep(-0.02, 0.06, above)));
      t.mulAssign(SHADOW.grow);
    });
    light.element(id).assign(vec4(lit.mul(palmShade(p)), normal));
  })().compute(CELLS);

  // The spray, once a frame.
  const spray = Fn(() => {
    const id = instanceIndex;
    const p = sprayAt.element(id) as any;
    const v = sprayVelocity.element(id) as any;
    const seed = float(id).add(u.frame.mul(0.618)) as any;
    const h = u.hand as any;
    If(p.w.lessThanEqual(0), () => {
      const r = hash(seed) as any;
      const angle = hash(seed.add(7.1)).mul(Math.PI * 2) as any;
      const out = pow(hash(seed.add(3.3)), float(0.5)) as any;
      // Flung up by the hand, more the faster it goes.
      const moving = length(u.handVelocity).mul(60) as any;
      If(r.lessThan(h.w.mul(min(moving.mul(0.03).add(0.004), float(0.05)))), () => {
        const q = h.xy.add(
          vec2(sin(angle), sin(angle.add(Math.PI / 2)))
            .mul(out)
            .mul(h.z.mul(0.7))
        ) as any;
        const c = cells.element(columnOf(q)) as any;
        p.assign(vec4(q.x, c.x.add(0.004), q.y, 1));
        const up = hash(seed.add(5.7)).mul(0.012).add(0.004) as any;
        const fling = vec2(u.handVelocity).mul(hash(seed.add(9.2)).mul(0.6).add(0.2)) as any;
        v.assign(vec4(fling.x.add(sin(angle).mul(0.002)), up, fling.y.add(sin(angle.add(Math.PI / 2)).mul(0.002)), 1));
      }).ElseIf(r.greaterThan(float(1).sub(u.gust.mul(0.0001))), () => {
        // Lifted off a crest by the wind.
        const q = vec2(hash(seed.add(1.7)), hash(seed.add(2.9)))
          .sub(0.5)
          .mul(PATCH * 0.94) as any;
        const c = cells.element(columnOf(q)) as any;
        If(
          c.y
            .lessThan(0.0005)
            .and(c.x.greaterThan(homeNode(q).mul(0.8)))
            .and(c.x.greaterThan(0.12)),
          () => {
            p.assign(vec4(q.x, c.x.add(0.002), q.y, 1));
            v.assign(vec4(vec2(u.wind).mul(0.006).x, hash(seed.add(4.4)).mul(0.003), vec2(u.wind).mul(0.006).y, 0));
          }
        );
      });
    }).Else(() => {
      const turning = v.w as any;
      const gravity = mix(float(0.00035), float(0.00055), turning) as any;
      const gusting = vec2(u.wind).mul(u.gust.mul(0.0004).mul(float(1).sub(turning))) as any;
      v.assign(vec4(v.x.mul(0.985).add(gusting.x), v.y.mul(0.985).sub(gravity), v.z.mul(0.985).add(gusting.y), turning));
      const q = p.xyz.add(v.xyz) as any;
      const c = cells.element(columnOf(q.xz)) as any;
      const life = p.w.sub(mix(float(0.004), float(0.012), turning)) as any;
      const outside = max(abs(q.x), abs(q.z)).greaterThan(PATCH / 2 - CELL * 2) as any;
      // Down on the sand or into the water, it is gone.
      p.assign(vec4(q, q.y.lessThan(c.x.add(c.y)).or(outside).select(float(0), life)));
    });
  })().compute(sprays);

  // Lays the dunes out afresh, dry.
  const reset = () => {
    const a = (cells.value as THREE.StorageInstancedBufferAttribute).array as Float32Array;
    const b = (home.value as THREE.StorageInstancedBufferAttribute).array as Float32Array;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = homeAt((i + 0.5) * CELL - PATCH / 2, (j + 0.5) * CELL - PATCH / 2);
        b[k] = h;
        a.set([h, 0, 0, 0], k * 4);
      }
    for (const buffer of [cells, home]) (buffer.value as THREE.StorageInstancedBufferAttribute).needsUpdate = true;
    // Palm sites, each kept a little way from the others, and back from the rim.
    const sites: number[][] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let tries = 0; sites.length < PALM_SITES && tries < 20000; tries++) {
      const x = (random() - 0.5) * (PATCH + BEYOND * 2 - 0.3);
      const z = (random() - 0.5) * (PATCH + BEYOND * 2 - 0.3);
      if (sites.every(([a, b]) => Math.hypot(a - x, b - z) > 0.24)) sites.push([x, z]);
    }
    while (sites.length < PALM_SITES) sites.push([0, 0]);
    const s = (palms.value as THREE.StorageInstancedBufferAttribute).array as Float32Array;
    sites.forEach(([x, z], k) => s.set([x, z, 0, random()], k * 4));
    (palms.value as THREE.StorageInstancedBufferAttribute).needsUpdate = true;
    for (const buffer of [flux, next, sprayAt, sprayVelocity, life, lifeNext]) {
      const attribute = buffer.value as THREE.StorageInstancedBufferAttribute;
      (attribute.array as Float32Array).fill(0);
      attribute.needsUpdate = true;
    }
  };
  reset();

  // Steps the desert on, then lights it, then runs whatever else is given, such as the passes that colour it.
  const step = (renderer: THREE.WebGPURenderer, steps: number, after: THREE.ComputeNode[] = []) => {
    const passes = [];
    if (u.recede.value > 0) passes.push(recede, recedePalms);
    for (let k = 0; k < steps; k++) passes.push(flow, update, copy);
    passes.push(moisten, settle, sprout, clearGrown, frame, shadeOfPalms, shade, spray, ...after);
    renderer.compute(passes);
    u.frame.value = (u.frame.value + 1) % 100000;
  };

  return {
    N,
    CELL,
    sprays,
    u,
    cells,
    light,
    tone,
    home,
    sprayAt,
    sprayVelocity,
    life,
    palms,
    roots,
    palmSites: PALM_SITES,
    palmShade,
    palmsOver,
    reset,
    step,
    columnOf,
    greenNear,
    onPatch,
    centre: (i: number, j: number) => [(i + 0.5) * CELL - PATCH / 2, (j + 0.5) * CELL - PATCH / 2]
  };
}

export type Desert = ReturnType<typeof createDesert>;

// Height of a cell's sand at a point in the world, read between the four columns round it, for drawing; or the same
// of another buffer kept a column at a time.
export function sandBetween(desert: Desert, p: any, buffer: any = desert.cells): any {
  const { N, CELL } = desert;
  const cells = buffer;
  const g = p
    .add(PATCH / 2)
    .div(CELL)
    .sub(0.5) as any;
  const base = g.floor() as any;
  const t = g.sub(base) as any;
  const clampI = (i: any) => (max as any)((min as any)(i, int(N - 1)), int(0));
  const read = (a: number, b: number) =>
    cells.element(
      clampI(int(base.y).add(b))
        .mul(N)
        .add(clampI(int(base.x).add(a)))
    ) as any;
  return mix(mix(read(0, 0), read(1, 0), t.x), mix(read(0, 1), read(1, 1), t.x), t.y);
}
