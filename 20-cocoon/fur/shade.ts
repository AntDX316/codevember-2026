/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  texture,
  time,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec3
} from "three/tsl";
import { WOBBLE_RANGE } from "./field";

// Hair is lit along its length, not across a surface. Each fibre is a thin cylinder, so what matters is the angle
// between the light and the fibre (Kajiya and Kay): light catches a band across the fur wherever the fibres run square
// to the half-way direction. Real hair shows two such bands (Marschner): a white one off the outer cuticle, nudged
// toward the tips, and a broader one in the fibre's own colour that has been through it once and back, nudged toward
// the roots. A light from behind comes through the thin tips and lights the outline.

export type Fibre = { root: string; body: string; tip: string; shine: string; gloss: number };

export const FIBRES: Record<string, Fibre> = {
  // Mohair: cream with a warm, soft lustre, darker at the roots where the light never reaches.
  mohair: { root: "#3a2a1c", body: "#c4a982", tip: "#ecdfc4", shine: "#fff1dc", gloss: 1 },
  // Sable: deep brown, glossy, with tawny ends.
  sable: { root: "#140b06", body: "#5e3820", tip: "#c38f5e", shine: "#ffe2c2", gloss: 1.35 },
  // Silver fox: black at the root, a white band through the middle and dark tips again.
  silver: { root: "#0c0c10", body: "#d8d9de", tip: "#33343a", shine: "#f2f6ff", gloss: 1.15 },
  // Dyed coral: soft pink-orange, deeper toward the skin, nearly peach at the tips.
  coral: { root: "#4a1614", body: "#d0685a", tip: "#f2b9a2", shine: "#fff0e8", gloss: 0.9 }
};

// Everything the shaders share, held as uniforms so the scene can ease them without rebuilding anything.
export function furUniforms() {
  return {
    length: uniform(0.16),
    root: uniform(new THREE.Color()),
    body: uniform(new THREE.Color()),
    tip: uniform(new THREE.Color()),
    shine: uniform(new THREE.Color()),
    gloss: uniform(1),
    // Lights ride with the camera, so the fur is lit as in a studio from wherever it is seen: a warm key high on the
    // left, a cool fill low on the right, and a rim behind.
    key: uniform(new THREE.Vector3(0, 1, 0)),
    fill: uniform(new THREE.Vector3(1, 0, 0)),
    rim: uniform(new THREE.Vector3(0, 0, -1)),
    // Where the hand is on the fur, and how hard it presses, 0 when it is away.
    hand: uniform(new THREE.Vector3(0, 0, 0)),
    press: uniform(0),
    // The slow rise and fall of the cocoon.
    breath: uniform(0)
  };
}
export type FurUniforms = ReturnType<typeof furUniforms>;

// One warm key does the work; the far side is left to fall away into shadow, with only a breath of cool fill.
const KEY = vec3(2.3, 1.95, 1.55);
const FILL = vec3(0.05, 0.065, 0.09);
const RIM = vec3(1.2, 1.0, 0.8);

// The colour of a fibre along its length: root to tip.
function fibreColour(u: FurUniforms, h: any) {
  return mix(mix(u.root, u.body, smoothstep(0.0, 0.6, h)), u.tip, smoothstep(0.6, 1.0, h)) as any;
}

// One light on a fibre. T runs along the fibre, N is the skin's normal under it, h is how far up the fibre this is,
// shade how much of the light gets down that far into the nap.
function hairLight(L: any, power: any, T: any, N: any, V: any, h: any, colour: any, shine: any, gloss: any, shade: any) {
  const TL = dot(T, L) as any;
  // A cylinder's diffuse, held to the egg's own turn toward the light, so the coat has a lit side and a dark side.
  const across = sqrt(max(float(1).sub(TL.mul(TL)), 0)) as any;
  const NL = dot(N, L) as any;
  const diffuse = across.mul(max(NL.mul(0.5).add(0.5), 0)).mul(0.8) as any;
  // The egg shades its own far side; tips reach a little way past the edge of the shadow and catch the light.
  const facing = smoothstep(-0.12, 0.5, NL.add(h.mul(0.12))) as any;
  const H = normalize(L.add(V)) as any;
  const band = (shift: number, exponent: any) => {
    const Ts = normalize(T.add(N.mul(shift))) as any;
    const th = dot(Ts, H) as any;
    const sinTH = sqrt(max(float(1).sub(th.mul(th)), 0)) as any;
    return pow(sinTH, exponent).mul(smoothstep(-1, 0, th)) as any;
  };
  // Satin rather than glass: a narrow pale band and a broad one in the fibre's own colour.
  const primary = band(-0.08, gloss.mul(90)).mul(0.22).mul(gloss) as any;
  const secondary = band(0.16, gloss.mul(14)).mul(0.5) as any;
  const spec = shine.mul(primary).add(colour.mul(secondary)) as any;
  return power.mul(colour.mul(diffuse).add(spec).mul(shade)).mul(facing) as any;
}

// How the fur's outline glows with a light behind it: a fine line through the thin tips, only where the light can
// reach them past the egg, and only right at the edge.
function backlight(L: any, power: any, N: any, V: any, h: any, colour: any) {
  const through = pow(max(dot(V, L.negate()), 0), 2.0) as any;
  const reached = smoothstep(-0.2, 0.4, dot(N, L)) as any;
  const edge = pow(float(1).sub(abs(dot(N, V))), 4.0) as any;
  const thin = pow(h, 2.2) as any;
  const glow = colour.mul(colour).mul(0.9).add(colour.mul(0.25)) as any;
  return power.mul(glow).mul(through.mul(0.6).add(0.4)).mul(reached).mul(edge).mul(thin) as any;
}

function ambient(N: any, colour: any, shade: any) {
  const sky = mix(vec3(0.004, 0.0035, 0.003), vec3(0.03, 0.028, 0.026), N.y.mul(0.5).add(0.5)) as any;
  return colour.mul(sky).mul(shade) as any;
}

// Velvet's trick: looking down the nap you see the pale cut tips, looking against it the darker sides of the fibres.
// So the fur lightens or darkens with which way it lies relative to the eye, which is what makes a brushed stroke show.
function napLook(way: any, V: any) {
  return mix(float(0.4), float(1.3), smoothstep(-0.6, 0.6, dot(way, V))) as any;
}

// A shared base: black, matte, so that what shows is only the hair lighting laid on as emission. It keeps a proper
// normal for the render passes that read one.
function base() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  m.colorNode = vec3(0, 0, 0) as any;
  return m;
}

// The strands: a ribbon of a few segments per strand, turned to face the eye, bent from its root toward the way the
// fur lies there, thrown about by the springs and the breeze and parted where the hand is.
// `width` is half a strand's width at the root.
export function strandMaterial(u: FurUniforms, leanTexture: THREE.Texture, wobbleTexture: THREE.Texture, width: number) {
  const m = base();
  m.side = THREE.DoubleSide;
  const root = attribute("aRoot", "vec4") as any;
  const facing = attribute("aFacing", "vec4") as any;
  const place = attribute("aPlace", "vec4") as any;
  const N = normalize(facing.xyz) as any;
  const at = root.xyz.mul(u.breath.mul(0.012).add(1)) as any;

  // Which way the fur lies here, with a strand's own stray from it, kept to the skin.
  const nap = (texture(leanTexture, place.xy) as any).level(0).rgb.mul(2).sub(1) as any;
  const a = normalize(cross(N, vec3(0.31, 0.27, 0.91)).add(vec3(0.0003, 0.0002, 0.0001))) as any;
  const b = cross(N, a) as any;
  const angle = place.z.mul(6.2832) as any;
  const stray = a.mul(cos(angle)).add(b.mul(sin(angle))).mul(place.w.mul(0.22).add(0.14)) as any;
  const lean = nap.add(stray) as any;
  const flat = lean.sub(N.mul(dot(lean, N))) as any;
  // Breathing in lifts the fur a little.
  const lie = min(length(flat), 0.95).mul(u.breath.mul(-0.04).add(1)) as any;
  const way = normalize(flat.add(N.mul(0.0001))) as any;

  // A strand leaves the skin fairly upright and curves over toward the way it lies.
  const leave = normalize(N.add(way.mul(lie.mul(0.9)))) as any;
  const reach = normalize(N.mul(float(1).sub(lie).mul(0.85).add(0.06)).add(way.mul(lie.add(0.05)))) as any;
  const y = positionGeometry.y as any;
  const spine = leave.mul(y).add(reach.sub(leave).mul(y.mul(y).mul(0.5))) as any;

  // Thrown by the springs, stirred by a breeze that drifts over the egg, and pushed aside around the hand.
  const ring = (texture(wobbleTexture, place.xy) as any).level(0).rgb.mul(2).sub(1).mul(WOBBLE_RANGE) as any;
  const drift = time.mul(0.6) as any;
  const breeze = vec3(
    sin(drift.add(at.y.mul(3.1)).add(at.z.mul(2.3))).add(sin(drift.mul(2.3).add(at.x.mul(7.0)))).mul(0.5),
    sin(drift.mul(0.8).add(at.x.mul(2.7))).mul(0.3),
    cos(drift.mul(0.9).add(at.y.mul(2.6)).add(at.x.mul(1.7))).add(sin(drift.mul(2.1).add(at.z.mul(6.0)))).mul(0.5)
  ).mul(0.045) as any;
  const fromHand = at.sub(u.hand) as any;
  const handFlat = fromHand.sub(N.mul(dot(fromHand, N))) as any;
  const near = smoothstep(0.16, 0.0, length(fromHand)).mul(u.press) as any;
  const part = normalize(handFlat.add(way.mul(0.001))).mul(near.mul(0.75)) as any;
  const thrown = ring.add(breeze).add(part) as any;

  const tall = u.length.mul(place.w.mul(0.45).add(0.78)).mul(root.w.mul(0.2).add(0.9)) as any;
  const offset = spine.add(thrown.mul(y.mul(y))).mul(tall) as any;
  // Nothing goes into the skin: whatever is pushed under it is lifted back out, with a little standing room.
  const above = dot(offset, N) as any;
  const lifted = offset.add(N.mul(max(tall.mul(y).mul(0.1).sub(above), 0))) as any;
  const centre = at.add(lifted) as any;
  const T = normalize(leave.add(reach.sub(leave).mul(y)).add(thrown.mul(y.mul(2))).add(N.mul(0.0001))) as any;

  // Turned to the eye, tapering to a point, and never thinner than about a pixel, so distant fur stays soft.
  const toEye = cameraPosition.sub(centre) as any;
  const side = normalize(cross(T, toEye).add(a.mul(0.00001))) as any;
  const taper = float(1).sub(pow(y, 1.4).mul(0.88)) as any;
  const wide = max(float(width).mul(place.z.mul(0.5).add(0.75)), length(toEye).mul(0.00022)).mul(taper) as any;
  m.positionNode = centre.add(side.mul(positionGeometry.x.mul(wide))) as any;

  const vT = varying(T) as any;
  const vN = varying(N) as any;
  const vH = varying(y) as any;
  const vWay = varying(way) as any;
  // Each strand a shade of its own, and the coat gathered into faint locks, so it reads as fibres, not felt.
  const lock = sin(place.x.mul(6.2832 * 19).add(sin(place.y.mul(53)).mul(1.7))).mul(sin(place.y.mul(71).add(place.x.mul(6.2832 * 7)))) as any;
  const vTone = varying(place.w.mul(0.4).add(0.72).mul(lock.mul(0.12).add(1))) as any;
  m.normalNode = transformNormalToView(normalize(vN.add(vT.mul(0.4)))) as any;

  const Tn = normalize(vT) as any;
  const Nn = normalize(vN) as any;
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const colour = fibreColour(u, vH).mul(vTone) as any;
  // Light reaches the roots only through everything above them: deep in the nap it is nearly black.
  const shade = mix(float(0.06), float(1), pow(vH, 1.2)).mul(napLook(vWay, V)) as any;
  const lit = hairLight(u.key, KEY, Tn, Nn, V, vH, colour, u.shine, u.gloss, shade)
    .add(hairLight(u.fill, FILL, Tn, Nn, V, vH, colour, u.shine, u.gloss, shade))
    .add(backlight(u.rim, RIM, Nn, V, vH, fibreColour(u, vH.mul(0.5).add(0.5))))
    .add(ambient(Nn, colour, shade)) as any;
  m.emissiveNode = lit;
  return m;
}

// The skin between the strands: the undercoat, seen deep down, lit the same way with fibres lying as the nap says, so
// brushing shows on it too as a change of sheen.
export function skinMaterial(u: FurUniforms, leanTexture: THREE.Texture) {
  const m = base();
  const N = normalize(attribute("normal", "vec3")) as any;
  m.positionNode = (positionGeometry as any).mul(u.breath.mul(0.012).add(1)) as any;
  const vN = varying(N) as any;
  const Nn = normalize(vN) as any;
  const nap = (texture(leanTexture, uv()) as any).rgb.mul(2).sub(1) as any;
  const flat = nap.sub(Nn.mul(dot(nap, Nn))) as any;
  const way = normalize(flat.add(Nn.mul(0.0001))) as any;
  const T = normalize(flat.add(Nn.mul(0.35))) as any;
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const h = float(0.15) as any;
  const colour = fibreColour(u, h) as any;
  const shade = napLook(way, V).mul(0.2) as any;
  m.emissiveNode = hairLight(u.key, KEY, T, Nn, V, h, colour, u.shine, u.gloss, shade)
    .add(hairLight(u.fill, FILL, T, Nn, V, h, colour, u.shine, u.gloss, shade))
    .add(ambient(Nn, colour, shade)) as any;
  return m;
}
