import * as THREE from "three/webgpu";
import { Fn, abs, atan, positionWorld, varying, cos, dot, float, floor, fract, max, mix, mx_noise_float, normalize, pow, sin, smoothstep, texture, uniform, vec3 } from "three/tsl";
import type { Look } from "./looks";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The forest floor's shape, the fallen log across it, the light everything shares, and the clock it all keeps, so the
// processor and the shaders agree to the millimetre and the second.

// Seconds since the scene began, set each frame; births and pulses are told in it.
export const clock = uniform(0);
// How wide one pixel is at a metre from the eye, set each frame, so the finest things never thin below a pixel.
export const pixel = uniform(0.001);

// Shared light, eased toward the chosen style so a change of style glides.
export const light = {
  glow: uniform(new THREE.Color()),
  cap: uniform(new THREE.Color()),
  thread: uniform(new THREE.Color()),
  moon: uniform(new THREE.Color()),
  moonPower: uniform(0.5),
  toMoon: uniform(new THREE.Vector3(0, 1, 0)),
  zenith: uniform(new THREE.Color()),
  horizon: uniform(new THREE.Color()),
  far: [0, 1, 2].map(() => uniform(new THREE.Color())),
  // The clusters' colours: four from the style, then four neons the giants deep in the woods glow with, the same in
  // every style.
  palette: [0, 1, 2, 3, 4, 5, 6, 7].map(() => uniform(new THREE.Color()))
};
export const NEON = ["#b45cff", "#ff4fc8", "#4f7cff", "#38e8ff"];
const wanted = {
  glow: new THREE.Color(),
  cap: new THREE.Color(),
  thread: new THREE.Color(),
  moon: new THREE.Color(),
  moonPower: 0.5,
  toMoon: new THREE.Vector3(),
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),
  far: [0, 1, 2].map(() => new THREE.Color()),
  palette: [...[0, 1, 2, 3].map(() => new THREE.Color()), ...NEON.map((c) => new THREE.Color(c))]
};
export function aim(look: Look, now: boolean) {
  wanted.glow.set(look.glow);
  wanted.cap.set(look.cap);
  wanted.thread.set(look.thread);
  wanted.moon.set(look.moon);
  wanted.moonPower = look.moonPower;
  wanted.toMoon.set(...look.toMoon).normalize();
  wanted.zenith.set(look.zenith);
  wanted.horizon.set(look.horizon);
  look.far.forEach((c, i) => wanted.far[i].set(c));
  look.palette.forEach((c, i) => wanted.palette[i].set(c));
  if (now) ease(1);
}
export function ease(k: number) {
  light.glow.value.lerp(wanted.glow, k);
  light.cap.value.lerp(wanted.cap, k);
  light.thread.value.lerp(wanted.thread, k);
  light.moon.value.lerp(wanted.moon, k);
  light.moonPower.value += (wanted.moonPower - light.moonPower.value) * k;
  light.toMoon.value.lerp(wanted.toMoon, k).normalize();
  light.zenith.value.lerp(wanted.zenith, k);
  light.horizon.value.lerp(wanted.horizon, k);
  light.far.forEach((f, i) => f.value.lerp(wanted.far[i], k));
  light.palette.forEach((f, i) => f.value.lerp(wanted.palette[i], k));
}
// One of the eight colours, by an index given as a node.
export const paletteAt = (index: any): any => light.palette.slice(1).reduce((c: any, p, i) => index.greaterThan(i + 0.5).select(p, c), light.palette[0]);

// The last few taps on the floor, for the flash of veins that spreads from each: where, and when.
export const TAPS = 6;
export const taps = [0, 1, 2, 3, 4, 5].map(() => uniform(new THREE.Vector4(0, 0, -100, 0)));
let nextTap = 0;
export function tapAt(x: number, z: number, now: number) {
  taps[nextTap].value.set(x, z, now, 1);
  nextTap = (nextTap + 1) % TAPS;
}

// The giant mushrooms deep in the woods, glowing neon: where each stands, how big it is, and its colour, so the floor
// and the trees round them can take their light.
// All the way round, in two rings: the near ring bright, up to a couple of metres tall; and further out, giants bigger
// still and dimmer in the mist.
type Giant = { x: number; z: number; stem: number; cap: number; hue: number };
function ring(count: number, from: number, to: number, stem: [number, number], seed: number) {
  let s = seed;
  const random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const out: Giant[] = [];
  for (let k = 0; k < count; k++) {
    const a = ((k + random() * 0.6) / count) * Math.PI * 2;
    const r = from + random() * (to - from);
    const tall = stem[0] + random() ** 1.5 * (stem[1] - stem[0]);
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, stem: tall, cap: tall * (0.42 + random() * 0.14), hue: 4 + Math.floor(random() * 4) });
    // Some stand with a smaller one at their foot.
    if (random() < 0.45) out.push({ x: Math.cos(a + 0.06) * (r - 0.5), z: Math.sin(a + 0.06) * (r - 0.5), stem: tall * 0.5, cap: tall * 0.26, hue: 4 + Math.floor(random() * 4) });
  }
  return out;
}
export const GIANTS: Giant[] = ring(10, 4, 8.5, [0.8, 2.4], 7);
export const FAR_GIANTS: Giant[] = ring(12, 13, 21, [3, 6.5], 29);
export const giantLights = [...GIANTS]
  .sort((a, b) => b.stem - a.stem)
  .slice(0, 10)
  .map((g) => uniform(new THREE.Vector4(g.x, g.z, g.stem, g.hue)));
// The light of the ten biggest near giants falling on a point: soft pools round each, in its colour.
// The same, worked out at the vertices and carried across: the giants' light changes over metres, so per pixel it is
// wasted work.
export const giantLight = (): any => varying(giantLightAt(positionWorld));

export function giantLightAt(p: any): any {
  return giantLights.reduce((sum: any, g: any) => {
    const d = p.xz.sub(g.xy).length() as any;
    const pool = g.z.mul(0.45).div(d.mul(d).add(0.8)) as any;
    return sum.add(paletteAt(g.w).mul(pool));
  }, vec3(0));
}

// The floor: low swells and hollows under the litter, in metres.
export function groundAt(x: number, z: number) {
  return 0.035 * Math.sin(x * 1.9 + 0.7) * Math.sin(z * 1.6 - 0.4) + 0.012 * Math.sin(x * 4.3 - z * 3.7 + 1.1) + 0.006 * Math.sin(x * 7.7 + z * 6.1);
}
export function groundNode(p: any): any {
  return sin(p.x.mul(1.9).add(0.7))
    .mul(sin(p.y.mul(1.6).sub(0.4)))
    .mul(0.035)
    .add(sin(p.x.mul(4.3).sub(p.y.mul(3.7)).add(1.1)).mul(0.012))
    .add(sin(p.x.mul(7.7).add(p.y.mul(6.1))).mul(0.006));
}

// The fallen log: lying across the back of the floor, a little askew and kinked where it broke, half sunk in the
// litter, thicker toward its root end, swelling at its knots.
export const LOG = { radius: 0.105, from: -2.4, to: 2.4 };
export const KNOTS = [-1.05, -0.32, 0.46, 1.3];
export const logZ = (x: number) => -0.95 - 0.06 * x + 0.04 * Math.sin(x * 1.3 + 0.4) + 0.05 * Math.tanh((x - 0.2) * 5);
export const logY = (x: number) => 0.035 + 0.012 * Math.sin(x * 0.8 + 0.3) + 0.012 * Math.tanh((x - 0.2) * 5);
export const logRadius = (x: number) => {
  let r = LOG.radius * (1.12 - 0.1 * x) * (1 + 0.06 * Math.sin(x * 2.3) + 0.03 * Math.sin(x * 7.1));
  for (const k of KNOTS) r *= 1 + 0.32 * Math.exp(-(((x - k) / 0.06) ** 2));
  return r;
};

// Smaller fallen logs lying about the floor, each a scan (see public/assets/16-spore/CREDITS.txt). Their tops are
// measured from the scans in slices along them: how high, where across, and how wide, in the scan's own metres; so a
// tap lands on the wood and nothing grows inside it.
type Profile = { length: number; top: number[]; middle: number[]; half: number[] };
const TRUNK: Profile = {
  length: 3.051,
  top: [0.29, 0.269, 0.252, 0.266, 0.283, 0.251, 0.234, 0.229, 0.226, 0.215, 0.213, 0.21, 0.212, 0.213, 0.196, 0.202, 0.201, 0.208, 0.215, 0.223, 0.231, 0.242, 0.255, 0.252],
  middle: [0.004, 0.006, -0.023, -0.018, -0.013, -0.006, -0.002, 0.001, 0.004, 0.007, 0.01, 0.021, 0.029, 0.031, 0.031, 0.029, 0.022, 0.017, 0.011, 0.02, 0.031, 0.032, 0.034, 0.035],
  half: [0.035, 0.071, 0.115, 0.121, 0.121, 0.121, 0.12, 0.117, 0.113, 0.113, 0.112, 0.111, 0.108, 0.108, 0.107, 0.106, 0.104, 0.102, 0.1, 0.105, 0.098, 0.094, 0.091, 0.092]
};
const STUMPED: Profile = {
  length: 4.051,
  top: [0.97, 0.923, 0.9, 0.833, 0.77, 0.705, 0.637, 0.7, 0.767, 0.824, 0.881, 1.055, 1.044, 0.939, 0.943, 0.948, 0.978, 0.972, 0.981, 0.995, 1.025, 1.051, 1.053, 0.974],
  middle: [0.276, 0.338, 0.295, 0.188, 0.044, -0.12, -0.081, -0.094, -0.153, -0.178, -0.172, -0.156, -0.162, -0.123, -0.102, -0.08, -0.069, -0.056, -0.056, -0.04, -0.045, -0.076, -0.068, -0.024],
  half: [0.13, 0.19, 0.208, 0.23, 0.3, 0.408, 0.327, 0.251, 0.19, 0.175, 0.172, 0.218, 0.213, 0.183, 0.19, 0.196, 0.203, 0.196, 0.208, 0.21, 0.215, 0.24, 0.241, 0.21]
};
export type FallenLog = { scan: "dead_tree_trunk" | "dead_tree_trunk_02"; x: number; z: number; yaw: number; scale: number; y: number; pitch: number; profile: Profile };
const fallen = (scan: FallenLog["scan"], x: number, z: number, yaw: number, scale: number): FallenLog => {
  const profile = scan === "dead_tree_trunk" ? TRUNK : STUMPED;
  // Settled into the litter: tipped to lie along the ground between its ends, and sunk a little.
  const reach = (profile.length * scale) / 2;
  const [ax, az] = [Math.cos(yaw) * reach, -Math.sin(yaw) * reach];
  const [g0, g1, gm] = [groundAt(x - ax, z - az), groundAt(x + ax, z + az), groundAt(x, z)];
  return { scan, x, z, yaw, scale, profile, pitch: Math.atan2(g1 - g0, 2 * reach), y: (g0 + g1 + gm) / 3 - 0.012 * scale - 0.006 };
};
export const FALLEN: FallenLog[] = [
  fallen("dead_tree_trunk", 1.5, 0.3, 1.15, 0.55),
  fallen("dead_tree_trunk", -1.55, -0.1, 2.6, 0.38),
  fallen("dead_tree_trunk_02", -1.85, 0.75, 0.35, 0.22),
  // A second big fallen tree across the near side of the floor, at its own angle: a different scan from the far log.
  fallen("dead_tree_trunk", 0.25, 1.4, -0.32, 1.25),
  fallen("dead_tree_trunk", 1.45, -1.75, 0.15, 0.45)
];
function fallenTop(log: FallenLog, x: number, z: number) {
  const [dx, dz] = [x - log.x, z - log.z];
  const [c, s] = [Math.cos(log.yaw), Math.sin(log.yaw)];
  const along = (dx * c - dz * s) / log.scale;
  const across = (dx * s + dz * c) / log.scale;
  const p = log.profile;
  const k = (along / p.length + 0.5) * p.top.length;
  if (k < 0 || k >= p.top.length) return -Infinity;
  const i = Math.floor(k);
  const d = (across - p.middle[i]) / p.half[i];
  if (Math.abs(d) >= 1) return -Infinity;
  return log.y + Math.tan(log.pitch) * along * log.scale + log.scale * p.top[i] * Math.sqrt(1 - d * d);
}

// The top of whatever is there, floor or log, and whether it is a log.
export function surfaceAt(x: number, z: number) {
  let y = groundAt(x, z);
  let onLog = false;
  const d = Math.abs(z - logZ(x));
  const r = logRadius(x);
  if (x > LOG.from && x < LOG.to && d < r) {
    const top = logY(x) + Math.sqrt(r * r - d * d);
    if (top > y) [y, onLog] = [top, true];
  }
  for (const log of FALLEN) {
    const top = fallenTop(log, x, z);
    if (top > y) [y, onLog] = [top, true];
  }
  return { y, onLog };
}

// Where a ray first meets the floor or the log, stepping along it; null if it leaves the floor first.
export function hitFloor(ray: THREE.Ray, reach = 2.6) {
  const p = new THREE.Vector3();
  for (let t = 0.02; t < 12; t += 0.003 + t * 0.006) {
    ray.at(t, p);
    if (Math.abs(p.x) > reach || Math.abs(p.z) > reach) {
      if (p.y < 0) return null;
      continue;
    }
    const s = surfaceAt(p.x, p.z);
    if (p.y < s.y) return { point: new THREE.Vector3(p.x, s.y, p.z), onLog: s.onLog, distance: t };
  }
  return null;
}

// The light the blooms throw on what is round them, gathered on the processor each frame into a coarse grid over the
// floor: red, green and blue, the mushrooms' own light in their colours; alpha, the threads'. Everything on the floor reads it, so a bloom lights the
// litter and the log near it, fading with distance.
export const GRID = 96;
export const SPAN = 4.4;
export const glowData = new Uint16Array(GRID * GRID * 4);
export const glowTexture = new THREE.DataTexture(glowData, GRID, GRID, THREE.RGBAFormat, THREE.HalfFloatType);
glowTexture.magFilter = THREE.LinearFilter;
glowTexture.minFilter = THREE.LinearFilter;
glowTexture.wrapS = glowTexture.wrapT = THREE.ClampToEdgeWrapping;
glowTexture.needsUpdate = true;
const glowFloat = new Float32Array(GRID * GRID * 4);
export const glowGrid = {
  clear() {
    glowFloat.fill(0);
  },
  // A soft pool of light round a point: strength at its middle, falling off over about `radius` metres.
  splat(x: number, z: number, radius: number, colour: THREE.Color, mushroom: number, thread: number) {
    const cell = SPAN / GRID;
    const cx = (x + SPAN / 2) / cell - 0.5;
    const cz = (z + SPAN / 2) / cell - 0.5;
    const reach = Math.ceil((radius * 2.2) / cell);
    const inv = 1 / (radius * radius);
    for (let j = Math.max(0, Math.floor(cz - reach)); j <= Math.min(GRID - 1, Math.ceil(cz + reach)); j++)
      for (let i = Math.max(0, Math.floor(cx - reach)); i <= Math.min(GRID - 1, Math.ceil(cx + reach)); i++) {
        const dx = (i - cx) * cell;
        const dz = (j - cz) * cell;
        const f = Math.exp(-(dx * dx + dz * dz) * inv);
        if (f < 0.01) continue;
        const k = (j * GRID + i) * 4;
        glowFloat[k] += colour.r * mushroom * f;
        glowFloat[k + 1] += colour.g * mushroom * f;
        glowFloat[k + 2] += colour.b * mushroom * f;
        glowFloat[k + 3] += thread * f;
      }
  },
  upload() {
    for (let k = 0; k < GRID * GRID * 4; k++) glowData[k] = THREE.DataUtils.toHalfFloat(Math.min(glowFloat[k], 60000));
    glowTexture.needsUpdate = true;
  }
};
// The bloom light falling on a point of the floor, log or a mushroom, by its place across the floor.
export function glowAt(p: any): any {
  const g = texture(glowTexture, p.xz.div(SPAN).add(0.5)) as any;
  return g.rgb.add(light.thread.mul(g.a));
}

// What lies in a direction from the floor: the night overhead, the moon's glow through the canopy, a mist between the
// trunks low down, and the dark trunks themselves standing all round, with far blooms glowing faintly among them.
export const environment = Fn(([direction]: [any]) => {
  const d = normalize(direction) as any;
  const up = smoothstep(-0.1, 0.9, d.y) as any;
  let rgb: any = mix(light.horizon, light.zenith, up);
  const toward = max(dot(d, light.toMoon), 0) as any;
  rgb = rgb.add(light.moon.mul(pow(toward, 6).mul(0.08).add(pow(toward, 60).mul(0.25))).mul(light.moonPower));
  // A mist lying low among the trees, catching the moon.
  const low = smoothstep(0.35, -0.02, d.y).mul(smoothstep(-0.25, 0.02, d.y)) as any;
  const drift = mx_noise_float(vec3(d.x.mul(3), d.y.mul(8), d.z.mul(3)))
    .mul(0.5)
    .add(0.5) as any;
  rgb = rgb.add(light.moon.mul(low.mul(drift).mul(0.05).mul(light.moonPower)));
  // Far blooms: patches of faint colour low down between the trunks.
  const angle = atan(d.z, d.x) as any;
  const patch = smoothstep(
    0.55,
    0.9,
    mx_noise_float(vec3(angle.mul(2.5), d.y.mul(6), 3.7))
      .mul(0.5)
      .add(0.5)
  ) as any;
  const farTint = mix(light.far[0], light.far[1], smoothstep(-0.3, 0.3, sin(angle.mul(3.1).add(1.7)))) as any;
  rgb = rgb.add(
    farTint.mul(
      patch
        .mul(smoothstep(0.25, -0.05, d.y))
        .mul(smoothstep(-0.2, 0.0, d.y))
        .mul(0.07)
    )
  );
  // Trunks all round in three depths: the far ones pale in the mist, the near ones dark and wide, each rounded, its
  // moonward edge just catching the light.
  const hash = (x: any) => fract(sin(x.mul(127.1)).mul(43758.5453)) as any;
  const moonSide = atan(light.toMoon.z, light.toMoon.x) as any;
  [
    { many: 34, wide: 0.22, mist: 0.75 },
    { many: 17, wide: 0.28, mist: 0.5 }
  ].forEach(({ many, wide, mist }, layer) => {
    const u = angle.mul(many / (2 * Math.PI)).add(layer * 0.37) as any;
    const cell = floor(u) as any;
    const there = hash(cell.add(layer * 11)).lessThan(0.7) as any;
    const centre = hash(cell.add(3.1 + layer))
      .mul(0.5)
      .add(0.25) as any;
    const half = hash(cell.add(7.7 + layer))
      .mul(wide * 0.5)
      .add(wide * 0.35) as any;
    const across = fract(u).sub(centre).div(half) as any;
    const inside = smoothstep(1, 0.9, abs(across))
      .mul(there.select(float(1), float(0)))
      .mul(smoothstep(-0.3, -0.05, d.y)) as any;
    const round = cos(across.mul(Math.PI / 2)).max(0) as any;
    const edge = smoothstep(0.4, 0.95, across.mul(sin(moonSide.sub(angle)).sign().negate()))
      .mul(0.04)
      .mul(light.moonPower) as any;
    const tone = mix(light.zenith.mul(0.25), light.horizon.mul(1.1), mist).mul(round.mul(0.4).add(0.6)).add(light.moon.mul(edge)) as any;
    rgb = mix(rgb, tone, inside);
  });
  return max(rgb, vec3(0));
});

// What shows in the puddles: the reflection is drawn from under the floor with only what glows and the woods behind,
// all of it on this layer as well as the usual one.
export const REFLECTED = 1;

// How spores go up when let go: 0 a plume of smoke, 1 a sparkle, 2 a low mist, 3 a swirl, 4 a mushroom cloud, 5 a
// puffball, 6 a smoke ring.
export const sporeCloud = uniform(0);

// A phone, by its touch screen and size: it keeps the lighter textures whatever the tier.
export const phoneLike = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches && Math.min(window.innerWidth, window.innerHeight) < 600;

// The mycelium's look, chosen in the panel: 0 glowing threads, 1 roots, 2 a fine web, 3 a soft glow, 4 pulses. For
// each: how many threads leave a cluster, how long they run, how wide they are drawn, how often they fork, how fast
// they grow (metres a second), and how wide the shader draws them against that.
export const veinStyle = uniform(0);
export const VEINS = [
  { label: "Glow threads", count: [9, 15], length: [0.06, 0.3], width: 0.00022, forks: 3, speed: 0.06, drawn: 3.4 },
  { label: "Roots", count: [4, 7], length: [0.15, 0.45], width: 0.0005, forks: 2, speed: 0.04, drawn: 2.6 },
  { label: "Web", count: [16, 26], length: [0.05, 0.22], width: 0.00014, forks: 4, speed: 0.1, drawn: 0.9 },
  { label: "Soft glow", count: [7, 11], length: [0.08, 0.3], width: 0.00022, forks: 2, speed: 0.08, drawn: 6 },
  { label: "Pulse", count: [9, 15], length: [0.06, 0.3], width: 0.00022, forks: 3, speed: 0.09, drawn: 1.2 }
];
