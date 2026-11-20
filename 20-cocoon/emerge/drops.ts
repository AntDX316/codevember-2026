import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, color, cos, cross, dot, exp, float, fract, inverseSqrt, max, min, mix, normalize, positionGeometry, positionWorld, pow, reflect, sin, smoothstep, step, texture, time, uniform, varying, vec3, vec4 } from "three/tsl";
import { sky } from "../../14-tension/backdrop";
import { skyAt } from "./sky";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Dew over the whole set, after Tension's web at dawn: every drop a small lens sat on (or hanging from) whatever is
// under it. Through it the garden shows turned over, tinted by the bark, moss or leaf it sits on; its rim mirrors the
// sky; where it lines up with the light a small warm spot burns in it; its foot is dark where it meets the surface.
// A few of the hanging ones swell, let go, fall, and gather again. All of them tremble when the branch is knocked.
// One mesh for a whole list of drops, placed and animated on the GPU: nothing moves on the CPU.

// What a drop sits on, for its tint.
export const ON = { bark: 0, moss: 1, leaf: 2, silk: 3 } as const;

export type Drop = {
  // Where its foot is, and the way out of the surface there (straight down for a hanging drop's own axis).
  at: THREE.Vector3;
  up: THREE.Vector3;
  r: number;
  // How it is drawn out along `up`: under one a flattened bead sat on the surface, over one a drop hanging by its weight.
  flat: number;
  on: number;
  // Seconds between falls, for a hanging drop that drips; none for one that stays.
  period?: number;
  // On bark that is pushed in and out by its scan in the shader: the scan's uv there and how far its heights push, so
  // the drop rides the bark as drawn.
  bark?: [u: number, v: number, push: number];
};

// How hard the branch has been knocked, 0 to 1, and where: set it and let it die away (the twig does).
export const dewShake = uniform(0);
const dewAt = uniform(new THREE.Vector3());
// 1 when the knock was at a place (drops near it tremble most), 0 when the whole branch was knocked.
const dewNear = uniform(0);
// Knock the branch (a butterfly landing, a step beside a drop): the drops on it tremble and settle, those near `at`
// the most.
export const shakeDew = (amount = 1, at?: THREE.Vector3) => {
  dewShake.value = Math.min(1, Math.max(dewShake.value, amount));
  if (at) dewAt.value.copy(at);
  dewNear.value = at ? 1 : 0;
};

// How fast a drop that has let go falls (scene units a second, a second): a little slower than true at this scale,
// so that the eye can follow it; and how far below it is followed.
const FALL = 22;
const FALLEN = 2.6;

export function makeDrops(all: Drop[], options: { detail?: number; height?: THREE.Texture; mid?: number } = {}) {
  // Fine beads are a few pixels across: they are drawn with a quarter of the triangles the larger drops get, and no
  // eye can tell. One material for both.
  const detail = options.detail ?? 2;
  const fine = all.filter((d) => d.r < 0.009);
  const large = all.filter((d) => d.r >= 0.009);
  const material = dropMaterial(options);
  const small = dropMesh(fine, Math.max(1, detail - 1), material);
  const big = dropMesh(large, detail, material);
  const mesh = new THREE.Group();
  mesh.add(small.mesh, big.mesh);
  return { mesh, geometry: small.geometry, geometry2: big.geometry, material };
}

function dropMesh(list: Drop[], detail: number, material: THREE.Material) {
  const ball = new THREE.IcosahedronGeometry(1, detail);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", ball.getAttribute("position"));
  geometry.setIndex(ball.getIndex());
  // Each drop that drips has a twin: the one that has just let go, falling.
  const twins = list.map((d, i) => [d, i] as const).filter(([d]) => (d.period ?? 0) > 0);
  const count = list.length + twins.length;
  const n = Math.max(1, count);
  const at = new Float32Array(n * 4);
  const up = new Float32Array(n * 4);
  const life = new Float32Array(n * 4);
  const bark = new Float32Array(n * 4);
  const put = (d: Drop, i: number, k: number, twin: number) => {
    at.set([d.at.x, d.at.y, d.at.z, d.r], k * 4);
    up.set([d.up.x, d.up.y, d.up.z, d.flat], k * 4);
    life.set([d.on, d.period ?? 0, (i * 0.6180339) % 1, twin], k * 4);
    if (d.bark) bark.set([d.bark[0], d.bark[1], d.bark[2], 1], k * 4);
  };
  list.forEach((d, i) => put(d, i, i, 0));
  twins.forEach(([d, i], k) => put(d, i, list.length + k, 1));
  geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(at, 4));
  geometry.setAttribute("aUp", new THREE.InstancedBufferAttribute(up, 4));
  geometry.setAttribute("aLife", new THREE.InstancedBufferAttribute(life, 4));
  geometry.setAttribute("aBark", new THREE.InstancedBufferAttribute(bark, 4));
  geometry.instanceCount = count;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = count > 0;
  return { mesh, geometry };
}

function dropMaterial(options: { height?: THREE.Texture; mid?: number }) {
  const material = new THREE.MeshBasicNodeMaterial();
  const a = attribute("aAt", "vec4") as any;
  const u = attribute("aUp", "vec4") as any;
  const l = attribute("aLife", "vec4") as any;
  const b = attribute("aBark", "vec4") as any;
  const axis = normalize(u.xyz) as any;
  const side = normalize(cross(axis, vec3(0.31, 0.2, 0.93))) as any;
  const other = cross(side, axis) as any;
  const flat = u.w as any;
  const hanging = step(1, flat) as any;
  // Dripping: water runs down to it and it swells, sometimes faster and sometimes slower as the supply comes and goes;
  // it necks, lets go, and what is left behind gathers again. Its twin is the drop that let go, falling: faster and
  // faster, drawn out by its speed, and gone once well below.
  const drips = step(0.5, l.y) as any;
  const twin = l.w as any;
  const flow = time.add(sin(time.mul(0.11).add(l.z.mul(40))).mul(5)) as any;
  const cycle = fract(flow.div(max(l.y, 1)).add(l.z)) as any;
  const gathered = mix(float(1), pow(cycle.mul(0.94).add(0.06), 1 / 3).mul(1.1), drips) as any;
  const neck = smoothstep(0.9, 1, cycle).mul(drips).mul(twin.oneMinus()) as any;
  const since = cycle.mul(l.y) as any;
  const fell = since.mul(since).mul(FALL / 2) as any;
  const stretch = min(since.mul(FALL * 0.07), 1.6) as any;
  const grown = mix(gathered, float(1.1).mul(step(fell, FALLEN)), twin) as any;
  const shape = mix(flat.mul(neck.mul(0.5).add(1)), stretch.add(1.05), twin) as any;
  // Drawn out, it is narrower: about as much water whatever its shape.
  const narrow = mix(neck.mul(-0.18).add(1), inverseSqrt(stretch.div(1.05).add(1)), twin) as any;
  const r = a.w.mul(grown) as any;
  const drop = vec3(0, -1, 0).mul(fell.add(r.mul(0.9))).mul(twin) as any;
  // Knocked, it trembles: a hanging drop swings from its foot, slower; a sitting bead quivers on its own. Those near
  // where the branch was knocked the most.
  const near = mix(float(1), exp(a.xyz.sub(dewAt).dot(a.xyz.sub(dewAt)).div(-0.45)).mul(0.85).add(0.15), dewNear) as any;
  const shake = dewShake.mul(near).mul(twin.oneMinus()) as any;
  const swing = sin(time.mul(mix(float(27), float(12), hanging)).add(l.z.mul(90))).mul(shake) as any;
  const p = positionGeometry as any;
  const squash = swing.mul(0.16).add(1).mul(narrow) as any;
  const sway = swing.mul(r).mul(mix(float(0.3), float(1).sub(p.y).mul(0.45), hanging)) as any;
  const way = side.mul(cos(l.z.mul(31))).add(other.mul(sin(l.z.mul(31)))) as any;
  // Riding the bark where the bark is pushed about by its scan.
  const pushed = options.height ? (texture(options.height, b.xy) as any).r.sub(options.mid ?? 0.75).mul(b.z).mul(b.w) : float(0);
  // A sitting bead is sunk a little into what it sits on; a hanging one hangs wholly below its foot.
  const lift = mix(shape.mul(0.55), shape.mul(-0.82), hanging) as any;
  // (A hanging drop's own axis is straight up; the bark under it faces down.)
  const foot = a.xyz.add(axis.mul(pushed).mul(hanging.mul(-2).add(1))).add(drop).add(way.mul(sway)) as any;
  material.positionNode = foot.add(side.mul(p.x.mul(r).mul(squash))).add(other.mul(p.z.mul(r).mul(squash))).add(axis.mul(p.y.mul(shape).add(lift).mul(r))) as any;
  const normal = (varying as any)(normalize(side.mul(p.x).add(other.mul(p.z)).add(axis.mul(p.y.div(shape)))), "vDropN") as any;
  // How near its foot this part of it is: 1 at the foot.
  const low = (varying as any)(mix(p.y.negate(), p.y, hanging), "vDropFoot") as any;
  const on = (varying as any)(l.x, "vDropOn") as any;
  const hangs = (varying as any)(hanging, "vDropHangs") as any;
  const falls = (varying as any)(twin, "vDropFalls") as any;

  material.colorNode = Fn(() => {
    const N = normalize(normal) as any;
    const I = normalize(positionWorld.sub(cameraPosition)) as any;
    const L = sky.toLight as any;
    const bent = normalize(I.sub(N.mul(1.2))) as any;
    const facing = max(dot(I.negate(), N), 0) as any;
    // Through it: mostly what it sits on, magnified and a little brighter, and the garden beyond, upside down.
    const under = mix(mix(color("#4a3423"), color("#4f6d22"), step(0.5, on)), mix(color("#3f7d2c"), color("#d9d5c6"), step(2.5, on)), step(1.5, on)) as any;
    const ground = under.mul(sky.light.mul(sky.power).mul(0.3).add(sky.horizon.mul(0.6))) as any;
    // A drop hanging in the air shows almost only the garden beyond it, gathered and brightened as a lens gathers it:
    // it is never darker than what is behind it.
    const seen = mix((skyAt(bent) as any).mul(mix(float(1.05), float(1.5), hangs)), ground.mul(1.25), mix(float(0.5), float(0.12), hangs)) as any;
    const mirrored = skyAt(reflect(I, N)) as any;
    const fresnel = pow(facing.oneMinus(), 4) as any;
    let rgb: any = mix(seen, mirrored, fresnel.mul(0.7).add(0.04));
    // The dark ring inside its rim, and its dark foot where it meets the surface.
    rgb = rgb.mul(smoothstep(0.05, 0.4, facing).mul(mix(float(0.7), float(0.4), hangs)).add(mix(float(0.3), float(0.6), hangs)));
    rgb = rgb.mul(mix(smoothstep(0.95, 0.35, low).mul(0.6).add(0.4), float(1), hangs));
    // The light gathered to a spot inside it, the backlight along its rim, the open sky as a small window: all warm,
    // none of them white.
    const warm = mix(sky.light, color("#ffc27a"), 0.35).mul(sky.power) as any;
    // (A falling drop is drawn out, so its spots are drawn out with it: wider and brighter, a glint as it goes.)
    const focus = pow(max(dot(bent, L), 0), mix(float(220), float(60), falls)).mul(mix(float(1.1), float(1.8), falls)) as any;
    const glance = pow(max(dot(reflect(I, N), L), 0), mix(float(420), float(90), falls)).mul(mix(float(1.6), float(2.4), falls)) as any;
    const window = pow(max(dot(reflect(I, N), normalize(vec3(1.5, 2, 6))), 0), 140).mul(0.8) as any;
    rgb = rgb.add(warm.mul(focus.add(glance))).add(sky.horizon.mul(window));
    // Falling, it is all lens and no foot: bright through, with the light running down its length.
    rgb = mix(rgb, rgb.mul(1.35).add(warm.mul(pow(facing, 2).mul(0.22))), falls);
    return vec4(rgb.min(vec3(0.95, 0.86, 0.7)).add(vec3(1, 1, 1).mul(sky.flash.mul(0.4))), 1);
  })() as any;

  return material;
}

// A small seeded scatter of sizes: mostly fine mist beads, some middling, a very few fat.
export function dropSize(random: () => number, scale = 1) {
  const k = random();
  return (k < 0.66 ? 0.003 + random() * 0.004 : k < 0.96 ? 0.007 + random() * 0.008 : 0.016 + random() * 0.009) * scale;
}

// In development: `__dew.shake()` from the console, to see the tremble.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") (globalThis as Record<string, unknown>).__dew = { shake: shakeDew, dewShake };
