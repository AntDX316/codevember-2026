/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  abs,
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  fwidth,
  min,
  fract,
  instancedDynamicBufferAttribute,
  int,
  max,
  mix,
  mx_noise_float,
  normalGeometry,
  normalize,
  normalView,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  time,
  transformNormalToView,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { A0, A1, C0, C1, K0, K1, LAYERS, WAVE } from "./shape";

const hash = (x: any): any => fract(sin(x.mul(127.1).add(0.3)).mul(43758.5453));

export type Palette = { label: string; layers: string[]; accent: string; sheen: string; glow: string; pearl: string; film: number; metal: number; swatch: string[] };

// Each palette is a pale, nearly neutral body for every shell (nacre's colour is almost all in its thin film), a faint
// tint for the flame figure, the sheen and the glow, the pearl itself, the film's base thickness in nanometres, which
// sets which colours it throws, and how much of the light comes back as tinted reflection rather than diffuse colour.
export const PALETTES: Record<string, Palette> = {
  abalone: {
    label: "Abalone",
    layers: ["#c9d0cf", "#c6cbd2", "#cdcbd4", "#c4cfca", "#cecbd3", "#c5cdd1", "#cbd1cc"],
    accent: "#9fb8c0",
    sheen: "#d8eaf0",
    glow: "#cfeaff",
    pearl: "#e9ecec",
    film: 430,
    metal: 0.45,
    swatch: ["#cfd8d6", "#8fb4b8"]
  },
  pearl: {
    label: "Pearl white",
    layers: ["#e2ddd6", "#dfd9d3", "#e4ded6", "#ddd8d4", "#e3dcd5", "#dfdad5", "#e5e0d9"],
    accent: "#d9cfc6",
    sheen: "#fff4ea",
    glow: "#fff0e0",
    pearl: "#f3eee8",
    film: 330,
    metal: 0.3,
    swatch: ["#efe9e1", "#dcd0cc"]
  },
  tahitian: {
    label: "Black Tahitian",
    layers: ["#55585c", "#53525a", "#4f5655", "#59525c", "#50555b", "#555a56", "#58525d"],
    accent: "#3c4a48",
    sheen: "#9fb6b0",
    glow: "#a8f0d8",
    pearl: "#3e4248",
    film: 520,
    metal: 0.7,
    swatch: ["#2f3d3c", "#5a4a6a"]
  },
  rose: {
    label: "Rose",
    layers: ["#e2cfcc", "#dfc9ca", "#e4d3cf", "#ddc7cb", "#e3cecd", "#dfcbc7", "#e5d4d2"],
    accent: "#d8b0b8",
    sheen: "#ffe4ea",
    glow: "#ffd7e2",
    pearl: "#f1dfdc",
    film: 290,
    metal: 0.35,
    swatch: ["#f0dcd8", "#d8a8b4"]
  }
};

const linear = (hex: string) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};

// Everything the palette and the settings feed the shaders, shared by the shells and the pearl.
export function createLook() {
  return {
    layers: uniformArray(
      Array.from({ length: LAYERS }, () => new THREE.Vector3(1, 1, 1)),
      "vec3"
    ),
    accent: uniform(new THREE.Vector3()),
    sheen: uniform(new THREE.Vector3()),
    glow: uniform(new THREE.Vector3()),
    pearl: uniform(new THREE.Vector3()),
    film: uniform(400),
    metal: uniform(0.4),
    strength: uniform(0.85),
    // How brightly the pearl shines out, 0 while it is covered.
    shine: uniform(0),
    // A brief flare when the pearl is touched.
    flare: uniform(0)
  };
}
export type NacreLook = ReturnType<typeof createLook>;

export function applyPalette(look: NacreLook, palette: Palette) {
  const layers = look.layers.array as THREE.Vector3[];
  palette.layers.forEach((hex, i) => layers[i].copy(linear(hex)));
  look.accent.value.copy(linear(palette.accent));
  look.sheen.value.copy(linear(palette.sheen));
  look.glow.value.copy(linear(palette.glow));
  look.pearl.value.copy(linear(palette.pearl));
  look.film.value = palette.film;
  look.metal.value = palette.metal;
}

export type BrickBuffers = { patch: THREE.InstancedBufferAttribute; curl: THREE.InstancedBufferAttribute; place: THREE.InstancedBufferAttribute; turn: THREE.InstancedBufferAttribute };

// Every brick of every shell, as one instanced mesh of thin boxes. Per brick:
//   patch: its middle angle round, half its width in angle, and the two row seams it lies between;
//   curl:  where the fold is across it, how far over the lifted part has rolled, which way it peels, and its shell
//          (whole part) with how much it glows as it grows (fraction);
//   place: how far it has moved from where it grew, and its size (0 when gone);
//   turn:  how it has turned about its own middle, as a quaternion.
// The box is laid exactly on its patch of its shell, then rolled up from one edge like a sheet coming off a pad, and
// that shape is carried about as a rigid piece once it is free.
export function shellMaterial(buffers: BrickBuffers, look: NacreLook) {
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.2,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.14,
    sheen: 1,
    sheenRoughness: 0.5,
    iridescence: 1,
    iridescenceIOR: 1.55
  });
  const patch = instancedDynamicBufferAttribute(buffers.patch, "vec4") as any;
  const curl = instancedDynamicBufferAttribute(buffers.curl, "vec4") as any;
  const place = instancedDynamicBufferAttribute(buffers.place, "vec4") as any;
  const turn = instancedDynamicBufferAttribute(buffers.turn, "vec4") as any;

  const layer = floor(curl.w) as any;
  const glow = fract(curl.w).div(0.9) as any;
  const t = layer.div(LAYERS - 1) as any;
  const a = mix(float(A0), float(A1), t) as any;
  const c = mix(float(C0), float(C1), t) as any;
  const k = mix(float(K0), float(K1), t) as any;

  const g = positionGeometry as any;
  const s = g.x.add(0.5) as any;
  const v = g.y.add(0.5) as any;
  // Each brick reaches a hair past its seams, so neighbours whose edges are cut differently never leave a crack.
  const phi = patch.x.add(s.sub(0.5).mul(2.03).mul(patch.y)) as any;
  const vOver = v.sub(0.5).mul(1.03).add(0.5) as any;
  const seamAt = (base: any, at: any) => {
    const p = base.mul(13.7).add(layer.mul(3.1)) as any;
    const wave = sin(at.mul(3).add(p)).mul(0.6).add(sin(at.mul(7).add(p.mul(2.1))).mul(0.4)) as any;
    return base.add(sin(base).mul(WAVE).mul(wave)) as any;
  };
  const theta = mix(seamAt(patch.z, phi), seamAt(patch.w, phi), vOver) as any;
  const thetaMid = mix(seamAt(patch.z, patch.x), seamAt(patch.w, patch.x), 0.5) as any;
  const shell = (th: any, ph: any) => {
    const st = sin(th) as any;
    const ct = cos(th) as any;
    const pinch = float(1).sub(k.mul(ct).mul(ct)) as any;
    const r = a.mul(st).mul(pinch) as any;
    const dr = a.mul(ct).mul(pinch.add(k.mul(2).mul(st).mul(st))) as any;
    const nry = normalize(vec2(c.mul(st), dr)) as any;
    return { p: vec3(r.mul(cos(ph)), c.mul(ct), r.mul(sin(ph))) as any, n: vec3(nry.x.mul(cos(ph)), nry.y, nry.x.mul(sin(ph))) as any };
  };
  const here = shell(theta, phi);
  const mid = shell(thetaMid, patch.x);
  const n0 = mid.n;
  const e = vec3(sin(patch.x).negate(), 0, cos(patch.x)) as any;
  const u = cross(n0, e) as any;
  const inFrame = (w: any) => vec3(dot(w, e), dot(w, u), dot(w, n0)) as any;
  const toObject = (w: any) => e.mul(w.x).add(u.mul(w.y)).add(n0.mul(w.z)) as any;
  const rotate = (w: any) => {
    const twice = cross(turn.xyz, w).mul(2) as any;
    return w.add(twice.mul(turn.w)).add(cross(turn.xyz, twice)) as any;
  };
  const surfaceNormal = inFrame(here.n);
  const local = inFrame(here.p.sub(mid.p)).add(surfaceNormal.mul(g.z)) as any;

  // The roll: past the fold the brick wraps round a cylinder, then carries on straight, curling outwards.
  const axis = vec2(cos(curl.z), sin(curl.z)) as any;
  const side = vec2(axis.y.negate(), axis.x) as any;
  const along = dot(local.xy, axis) as any;
  const across = dot(local.xy, side) as any;
  const fold = curl.x as any;
  const lift = curl.y as any;
  const seed = hash(patch.x.mul(7.31).add(patch.z.mul(13.17)).add(layer.mul(1.73))) as any;
  // Each brick its own curl, tighter on the smaller shells.
  const radius = seed.mul(0.05).add(0.04).mul(a.div(A0).mul(0.5).add(0.5)) as any;
  const past = along.sub(fold) as any;
  const roll = clamp(past.div(radius), 0, lift) as any;
  const straight = max(past.sub(lift.mul(radius)), 0) as any;
  const lifted = past.greaterThan(0);
  const curledAlong = select(lifted, fold.add(sin(roll).mul(radius)).add(straight.mul(cos(lift))), along) as any;
  const curledUp = select(lifted, radius.mul(float(1).sub(cos(roll))).add(straight.mul(sin(lift))), float(0)) as any;
  const at = curledAlong.sub(sin(roll).mul(local.z)) as any;
  const up = curledUp.add(cos(roll).mul(local.z)) as any;
  const curled = vec3(axis.mul(at).add(side.mul(across)), up) as any;
  material.positionNode = mid.p.add(place.xyz).add(rotate(toObject(curled)).mul(place.w));

  // The box's faces follow the shell, then turn with the roll and with the piece.
  const box = normalGeometry as any;
  const faceNormal = select(box.z.greaterThan(0.5), surfaceNormal, select(box.z.lessThan(-0.5), surfaceNormal.negate(), box)) as any;
  const na = dot(faceNormal.xy, axis) as any;
  const turned = vec3(axis.mul(na.mul(cos(roll)).sub(faceNormal.z.mul(sin(roll)))).add(side.mul(dot(faceNormal.xy, side))), na.mul(sin(roll)).add(faceNormal.z.mul(cos(roll)))) as any;
  const viewNormal = normalize(varying(transformNormalToView(rotate(toObject(turned))))) as any;
  material.normalNode = viewNormal;
  material.clearcoatNormalNode = viewNormal;

  // What the surface looks like is worked out from where on the shell each point grew, so it travels with the piece.
  const vTheta = varying(theta) as any;
  const vPhi = varying(phi) as any;
  const vFace = varying(box.z) as any;
  const vLayer = varying(layer) as any;
  const vGlow = varying(glow) as any;
  const vSeed = varying(seed) as any;
  const dir = vec3(sin(vTheta).mul(cos(vPhi)), cos(vTheta), sin(vTheta).mul(sin(vPhi))) as any;
  // The flame figure: long soft swirls running round the shell, which shift the film's colours over large areas.
  const flame = mx_noise_float(dir.mul(vec3(1.3, 3.2, 1.3)).add(vec3(vLayer.mul(1.7), vLayer.mul(0.9), 0))) as any;
  const drift = mx_noise_float(dir.mul(0.9).add(vec3(0, 0, vLayer.mul(2.3)))) as any;
  // Growth lines: very fine ridges laid down one after another round the shell, wandering with the flame. They fade to
  // their average before they get finer than a pixel, so they never shimmer.
  const growth = vTheta.mul(float(260).sub(vLayer.mul(18))).add(flame.mul(6)).add(sin(vPhi.mul(5).add(vTheta.mul(7))).mul(0.8)) as any;
  const ridge = pow(sin(growth).mul(0.5).add(0.5), 6) as any;
  const fine = mix(ridge, float(0.2), smoothstep(0.25, 1.2, fwidth(growth))) as any;

  // The film: light reflected from the top and bottom of each thin platelet interferes, so each wavelength comes back
  // strong or weak with the path difference, which grows with the thickness and shrinks as the surface turns away.
  const facing = abs(dot(viewNormal, positionViewDirection)) as any;
  const thickness = look.film.add(flame.mul(110)).add(drift.mul(60)).add(fine.mul(14)).add(vLayer.mul(24)) as any;
  const cosInside = sqrt(float(1).sub(float(1).sub(facing.mul(facing)).div(1.45 * 1.45))) as any;
  const path = thickness.mul(2 * 1.45).mul(cosInside) as any;
  const wave = vec3(path.div(640), path.div(545), path.div(455)).mul(Math.PI * 2) as any;
  const interference = float(0.5).sub(cos(wave).mul(0.5)) as any;
  const film = mix(vec3(dot(interference, vec3(0.2126, 0.7152, 0.0722))), interference, 0.6) as any;

  const base = look.layers.element(int(vLayer)) as any;
  const tint = mix(base, look.accent, smoothstep(-0.2, 0.6, flame).mul(0.18)) as any;
  // The joints between bricks: barely there, until a brick lifts.
  const square = varying(vec2(s, v)) as any;
  const toEdge = min(min(square.x, float(1).sub(square.x)), min(square.y, float(1).sub(square.y))) as any;
  const joint = float(1).sub(smoothstep(0, fwidth(toEdge).mul(1.2), toEdge)) as any;
  const amount = look.strength.mul(0.62) as any;
  const pearly = tint.mul(mix(vec3(1, 1, 1), film.mul(1.1).add(0.2), amount)) as any;
  const body = pearly.mul(fine.mul(0.035).add(0.98)).mul(vSeed.sub(0.5).mul(0.03).add(1)).mul(float(1).sub(joint.mul(0.05))) as any;
  const front = vFace.greaterThan(0.5);
  const back = vFace.lessThan(-0.5);
  const face = abs(vFace).greaterThan(0.5);
  // The inside of a shell is the smoother side, its film the more vivid; its cut edge is chalky, like broken shell.
  const inner = tint.mul(mix(vec3(1, 1, 1), film.mul(1.35).add(0.08), amount.mul(1.15))) as any;
  const edge = mix(vec3(0.78, 0.76, 0.73), base, 0.3) as any;
  material.colorNode = select(front, body, select(back, inner, edge));
  material.metalnessNode = select(face, look.metal, float(0));
  material.roughnessNode = select(front, float(0.3).sub(fine.mul(0.06)), select(back, float(0.2), float(0.65)));
  material.iridescenceNode = look.strength.mul(select(face, float(0.45), float(0.05)));
  material.iridescenceThicknessNode = thickness;
  material.sheenNode = look.sheen.mul(0.18);
  // A brick still growing glows faintly, the shell being laid down.
  material.emissiveNode = look.glow.mul(vGlow.mul(1.2));
  return material;
}

// The pearl: flawless, with a slow orient drifting over it, and a glow that wells up once it is uncovered.
export function pearlMaterial(look: NacreLook) {
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.07,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    sheen: 1,
    sheenRoughness: 0.35,
    iridescence: 1,
    iridescenceIOR: 1.45
  });
  const dir = normalize(positionLocal) as any;
  material.colorNode = look.pearl;
  material.iridescenceNode = look.strength.mul(0.65);
  material.iridescenceThicknessNode = float(320)
    .add(mx_noise_float(dir.mul(1.8).add(vec3(time.mul(0.05), time.mul(0.03), 0))).mul(170))
    .add(look.film.sub(380).mul(0.5));
  material.sheenNode = look.sheen.mul(0.4);
  const rim = float(1).sub(abs(dot(normalView, positionViewDirection))) as any;
  material.emissiveNode = look.glow.mul(look.shine.mul(pow(rim, 2).mul(1.1).add(0.22)).add(look.flare.mul(0.9)));
  return material;
}
