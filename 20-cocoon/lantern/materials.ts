/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  abs,
  acos,
  atan,
  attribute,
  cameraPosition,
  clamp,
  color,
  cross,
  dot,
  exp,
  float,
  fract,
  int,
  ivec2,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  normalWorld,
  normalWorldGeometry,
  output,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { EMBER, HALF_HEIGHT, WIDTH } from "./layout";

// The light inside: where the ember is, how strong (flickering), its colour, and the paper's two colours, one seen by
// light coming through it and one by light falling on it.
export function createLight() {
  return {
    ember: uniform(EMBER.clone()),
    power: uniform(2),
    flame: uniform(new THREE.Color(1, 0.55, 0.25)),
    transmit: uniform(new THREE.Color(1, 0.85, 0.6)),
    reflect: uniform(new THREE.Color(0.8, 0.75, 0.65)),
    hover: uniform(-1),
    lift: uniform(0)
  };
}
export type Light = ReturnType<typeof createLight>;

// The two maps the light leaves by: which cell each direction out of the ember passes through (and whether a vein is in
// the way), and how open each cell is.
export function createMaps(map: { data: Uint8Array; width: number; height: number }) {
  const exits = new THREE.DataTexture(map.data, map.width, map.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  exits.wrapS = THREE.RepeatWrapping;
  exits.wrapT = THREE.ClampToEdgeWrapping;
  exits.magFilter = THREE.LinearFilter;
  exits.minFilter = THREE.LinearFilter;
  exits.generateMipmaps = false;
  exits.needsUpdate = true;
  const openData = new Uint8Array(256 * 4);
  const open = new THREE.DataTexture(openData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  open.magFilter = open.minFilter = THREE.NearestFilter;
  open.generateMipmaps = false;
  open.needsUpdate = true;
  return { exits, open, openData, width: map.width, height: map.height };
}
export type Maps = ReturnType<typeof createMaps>;

// How much of the ember's direct light gets out along a direction: through an open cell, past the veins. Returns
// (open light, clear of veins).
function leaving(maps: Maps, dir: any) {
  const u = atan(dir.z, dir.x).div(Math.PI * 2).add(0.5) as any;
  const v = acos(clamp(dir.y, -1, 1)).div(Math.PI) as any;
  const texel = ivec2(int(clamp(fract(u).mul(maps.width), 0, maps.width - 1)), int(clamp(v.mul(maps.height), 0, maps.height - 1)));
  const id = int(textureLoad(maps.exits, texel).r.mul(255).add(0.5)) as any;
  const open = textureLoad(maps.open, ivec2(id, int(0))).r as any;
  const clear = texture(maps.exits, vec2(u, v)).g as any;
  return { open: open.mul(clear), clear };
}

// Whether a point is inside the egg (1) or out (0), softly, by the same sum as layout's inside test.
function insideEgg(p: any) {
  const y = p.y.div(HALF_HEIGHT);
  const g = float(1).sub(y.mul(0.13)).mul(WIDTH);
  const q = vec3(p.x.div(g), y, p.z.div(g));
  return float(1).sub(smoothstep(0.92, 1.0, dot(q, q)));
}

// Paper lit from inside. Light on the far side of a panel from the eye comes through it, coloured by the dye and
// shadowed by every thick fibre, and brightest looking straight through toward the ember; light on the near side (the
// inside of a panel seen through an opening, or a panel swung out) falls on it as on any paper.
export function paperMaterial(light: Light, washi: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  const sheet = texture(washi, uv()).r as any;
  const ring = attribute("aRing", "float") as any;
  const cell = attribute("aCell", "float") as any;
  const toEmber = (light.ember as any).sub(positionWorld) as any;
  const d2 = max(dot(toEmber, toEmber), 0.04) as any;
  const L = toEmber.div(d2.sqrt()) as any;
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const N = normalWorldGeometry as any;
  const nl = dot(N, L) as any;
  const nv = dot(N, V) as any;
  const near = step(0, nl.mul(nv)) as any;
  const irradiance = (light.power as any).div(d2) as any;
  const hovered = float(1).sub(step(0.5, abs(cell.sub(light.hover)))) as any;
  // The panel's margin is pasted double over its rib, so it lets less through.
  const margin = smoothstep(0.84, 0.99, ring) as any;
  const thick = sheet.sub(0.5).mul(2) as any;
  const through = (light.flame as any)
    .mul(light.transmit)
    .mul(irradiance)
    .mul(abs(nl).mul(0.6).add(0.4))
    .mul(clamp(float(1).sub(thick.mul(0.9)), 0.35, 1.8))
    .mul(float(1).sub(margin.mul(0.5)))
    .mul(pow(max(dot(V.negate(), L), 0), 6).mul(1.4).add(0.5))
    .mul(0.55) as any;
  const onto = (light.flame as any).mul(light.reflect).mul(irradiance).mul(abs(nl)).mul(thick.mul(0.15).add(0.9)).mul(0.32) as any;
  m.colorNode = (light.reflect as any).mul(thick.mul(0.12).add(0.75));
  m.roughnessNode = float(0.85);
  m.emissiveNode = mix(through, onto, near).mul(hovered.mul(light.lift).mul(0.45).add(1));
  return m;
}

// The ribs: dark, waxy, translucent only at their edges where the light wraps round them, as a leaf's veins do.
export function veinMaterial(light: Light) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.48, metalness: 0 });
  m.colorNode = color("#2a170c");
  const toEmber = (light.ember as any).sub(positionWorld) as any;
  const d2 = max(dot(toEmber, toEmber), 0.04) as any;
  const L = toEmber.div(d2.sqrt()) as any;
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const N = normalWorld as any;
  const irradiance = (light.power as any).div(d2) as any;
  const rim = pow(float(1).sub(abs(dot(N, V))), 3) as any;
  const facing = max(dot(N, L), 0) as any;
  m.emissiveNode = (light.flame as any)
    .mul(irradiance)
    .mul(rim.mul(0.16).mul(light.transmit).add(facing.mul(0.07).mul(color("#c8763c")))) as any;
  return m;
}

// The ember: a lumpy coal whose hot spots crawl.
export function emberMaterial(light: Light) {
  const m = new THREE.MeshBasicNodeMaterial();
  const p = positionLocal.mul(22) as any;
  const crawl = mx_noise_float(p.add(vec3(time.mul(0.7), time.mul(1.3), time.mul(-0.5)))).mul(0.5).add(0.5) as any;
  const deep = mx_noise_float(p.mul(0.45).add(time.mul(0.3))).mul(0.5).add(0.5) as any;
  const heat = smoothstep(0.15, 0.85, crawl.mul(0.6).add(deep.mul(0.6))) as any;
  const core = mix(vec3(1, 0.18, 0.03), vec3(1, 0.85, 0.55), heat) as any;
  m.colorNode = core.mul((light.flame as any).add(0.35)).mul(heat.mul(9).add(1.2)).mul((light.power as any).mul(0.5));
  return m;
}

// The halo round the ember, seen only through an open cell.
export function haloMaterial(light: Light) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const r = uv().sub(0.5).mul(2).length() as any;
  m.colorNode = vec4((light.flame as any).mul(exp(r.mul(r).mul(-9)).mul(1.1).add(exp(r.mul(-5)).mul(0.25))).mul(light.power).mul(0.45).mul(float(1).sub(smoothstep(0.85, 1, r))), 1);
  return m;
}

// The light leaving an open cell, as a beam through dusty air: soft at its edges (where the eye looks along its
// walls), fading away from the lantern and into the floor.
export function shaftMaterial(light: Light, maps: Maps, floorY: number) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const cell = int(attribute("aCell", "float").add(0.5)) as any;
  const open = textureLoad(maps.open, ivec2(cell, int(0))).r as any;
  // A shut cell's beam folds away to a point, so the many beams that are dark cost nothing to draw.
  m.positionNode = positionLocal.mul(step(0.002, open));
  const fromEmber = positionWorld.sub(light.ember) as any;
  const d = length(fromEmber) as any;
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const face = pow(abs(dot(normalize(normalWorldGeometry), V)), 2.2) as any;
  const along = smoothstep(0.75, 1.1, d).mul(exp(d.mul(-0.75))) as any;
  const floorFade = smoothstep(floorY, floorY + 0.5, positionWorld.y) as any;
  const forward = pow(max(dot(normalize(fromEmber), V), 0), 3).mul(1.5).add(0.5) as any;
  m.colorNode = vec4((light.flame as any).mul(light.power).mul(open).mul(face).mul(along).mul(floorFade).mul(forward).mul(0.07), 1);
  return m;
}

// The floor under the lantern: the dyed glow of the paper in a soft pool, and wherever a cell is open, the ember's own
// light thrown out through it, framed by the shadows of the veins.
export function floorMaterial(light: Light, maps: Maps, background: string) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0 });
  const grain = mx_noise_float(positionWorld.xz.mul(2.2)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(9)).mul(0.25)) as any;
  const albedo = color("#2b2622").mul(grain.mul(0.25).add(1)) as any;
  m.colorNode = albedo;
  m.roughnessNode = grain.mul(0.15).add(0.68);
  const toEmber = (light.ember as any).sub(positionWorld) as any;
  const d2 = dot(toEmber, toEmber) as any;
  const dir = normalize(toEmber.negate()) as any;
  const L = normalize(toEmber) as any;
  const { open, clear } = leaving(maps, dir);
  const irradiance = (light.power as any).div(d2).mul(max(L.y, 0)) as any;
  const glow = (light.transmit as any).mul(mix(float(0.6), float(1), clear)).mul(0.1) as any;
  // Lit by the lantern through its own reflectance rather than the dark albedo, which is only for the faint room light.
  m.emissiveNode = (light.flame as any).mul(irradiance).mul(glow.add(open.mul(1.1))).mul(grain.mul(0.3).add(1)).mul(0.7);
  const far = length(positionWorld.xz) as any;
  m.outputNode = mix(output, vec4(color(background), 1), smoothstep(4, 13, far)) as any;
  return m;
}

// Dust adrift round the lantern: almost unseen in the dark, glinting where it drifts through a beam, and brightest
// looking along the beam toward the ember. Inside, it is all lit, seen through the openings.
export function dustMaterial(light: Light, maps: Maps, floorY: number) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const s = attribute("aSeed", "vec4") as any;
  const t = time as any;
  const angle = s.x.mul(Math.PI * 2).add(t.mul(s.w.sub(0.5).mul(0.03))) as any;
  const radius = s.y.sqrt().mul(3.4).add(0.05).add(sin(t.mul(0.12).add(s.z.mul(40))).mul(0.12)) as any;
  const span = 4.6;
  const rise = fract(s.z.add(t.mul(s.w.mul(0.006).add(0.003)))) as any;
  const y = rise.mul(span).add(floorY) as any;
  const centre = vec3(angle.cos().mul(radius), y, angle.sin().mul(radius)).add(vec3(sin(t.mul(0.21).add(s.w.mul(30))).mul(0.05), 0, sin(t.mul(0.17).add(s.x.mul(25))).mul(0.05))) as any;
  const toEye = normalize(cameraPosition.sub(centre)) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
  const up = cross(toEye, right) as any;
  const size = s.w.mul(s.w).mul(0.012).add(0.004) as any;
  m.positionNode = centre.add(right.mul(positionGeometry.x.mul(size.mul(2)))).add(up.mul(positionGeometry.y.mul(size.mul(2))));

  const fromEmber = centre.sub(light.ember) as any;
  const d2 = max(dot(fromEmber, fromEmber), 0.05) as any;
  const dir = normalize(fromEmber) as any;
  const { open } = leaving(maps, dir);
  const lit = mix(open, float(1), insideEgg(centre)) as any;
  const phase = pow(max(dot(toEye.negate(), dir.negate()), 0), 4).mul(2.2).add(0.25) as any;
  const r = uv().sub(0.5).length() as any;
  const dot2 = float(1).sub(smoothstep(0.15, 0.5, r)) as any;
  const ends = smoothstep(0, 0.08, rise).mul(float(1).sub(smoothstep(0.85, 1, rise))) as any;
  const twinkle = sin(t.mul(s.y.mul(2).add(0.5)).add(s.z.mul(60))).mul(0.3).add(0.7) as any;
  const glow = (light.flame as any).mul(light.power).div(d2).mul(lit).mul(phase).mul(0.6).add(vec3(0.004, 0.0035, 0.003)) as any;
  m.colorNode = vec4(glow.mul(dot2).mul(ends).mul(twinkle), 1);
  return m;
}
