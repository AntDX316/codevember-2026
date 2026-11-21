import * as THREE from "three/webgpu";
import { abs, color, dot, exp, float, length, min, mix, normalize, positionGeometry, normalGeometry, pow, select, sign, smoothstep, sqrt, uniform, uniformArray, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The set: a clear acrylic block floating over a dark floor, lit from above like a product shot. Everything here is
// shaded by hand from the same few functions (the room, the floor, the soft boxes), so the block's reflections and what
// is seen through it agree with what is drawn around it, and no scene light is needed.

export const HALF = new THREE.Vector3(0.6, 0.6, 0.6);
export const IOR = 1.49;
export const CENTRE = new THREE.Vector3(0, 0.92, 0);
export const FLOOR = 0;

// The key: a big soft box overhead on the left, which the floor's pool, the shaft and the figure's glints come from.
export const KEY_AT = new THREE.Vector3(-1.9, 4.6, 1.7);
// The way its light travels, at the block.
export const KEY_DIR = CENTRE.clone().sub(KEY_AT).normalize();

// Shared state, set each frame by the scene: the block's frame, the eye in the block's own space, the figures still
// hot (centre in the world and heat, four at most), and the glow colour.
export const u = {
  toWorld: uniform(new THREE.Matrix4()),
  toLocal: uniform(new THREE.Matrix4()),
  eye: uniform(new THREE.Vector3()),
  // The eye mirrored in the floor, in the block's space: what the floor's reflection is seen from.
  eyeMirror: uniform(new THREE.Vector3()),
  keyLocal: uniform(new THREE.Vector3(0, 1, 0)),
  hot: uniformArray(
    Array.from({ length: 4 }, () => new THREE.Vector4(0, -10, 0, 0)),
    "vec4"
  ),
  hotColour: uniform(new THREE.Color("#8fc4ff")),
  frozenColour: uniform(new THREE.Color("#e4ecf6")),
  // The light the figure gives back in the dark, like a block on a lit stand: the glow colour, faint.
  under: uniform(0.0),
  clock: uniform(0),
  // The narrowest a fracture is drawn, in pixels: wider where the low tier's edge smoothing (FXAA) would break hair-thin
  // lines into dashes.
  minWidth: uniform(1.5),
  // The point of a strike or a charge building, in the world, and how bright it is.
  spark: uniform(new THREE.Vector4(0, -10, 0, 0))
};

const toWorldPoint = (p: any) => u.toWorld.mul(vec4(p, 1)).xyz as any;
const toWorldDir = (d: any) => u.toWorld.mul(vec4(d, 0)).xyz as any;

// The soft boxes the block reflects: big and warm overhead on the left (the key), a tall cool strip behind on the
// right for the rim, a dim strip on the left, and a long low bar high behind.
type Box = { at: THREE.Vector3; size: [number, number]; colour: string; power: number };
const BOXES: Box[] = [
  { at: KEY_AT, size: [1.5, 0.95], colour: "#fff1e2", power: 2.4 },
  // A broad dim scrim overhead, so the top face carries a soft gradient.
  { at: new THREE.Vector3(0.6, 5.5, -1.2), size: [3.2, 2.4], colour: "#e8eefa", power: 0.9 },
  { at: new THREE.Vector3(3.3, 1.7, -2.4), size: [0.32, 2.0], colour: "#dfe8ff", power: 3.2 },
  { at: new THREE.Vector3(-3.4, 1.3, -0.6), size: [0.26, 1.6], colour: "#cfdcff", power: 0.45 },
  { at: new THREE.Vector3(0.8, 3.2, -4.4), size: [2.4, 0.22], colour: "#fff6ee", power: 1.4 },
  // A tall strip out front on the left, which the front face shows as a soft band of light, as in a product shot.
  { at: new THREE.Vector3(-3.6, 1.6, 4.4), size: [0.32, 2.4], colour: "#eef2fa", power: 7 },
  // A big dim card behind the camera, for a soft sheen across the front faces.
  { at: new THREE.Vector3(1.4, 2.6, 6.5), size: [2.6, 1.6], colour: "#e9eef8", power: 0.35 }
];
const boxFrames = BOXES.map((box) => {
  const n = CENTRE.clone().sub(box.at).normalize();
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(n, side).normalize();
  return { ...box, n, side, up };
});

const v3 = (v: THREE.Vector3) => vec3(v.x, v.y, v.z) as any;

// Light from the soft boxes along a ray, each a rectangle that glows brightest in its middle and softens at its rim.
function boxes(o: any, d: any) {
  let sum: any = vec3(0);
  for (const b of boxFrames) {
    const n = v3(b.n);
    const facing = dot(d, n) as any;
    const t = dot(v3(b.at).sub(o), n).div(min(facing, float(-1e-4))) as any;
    const p = o.add(d.mul(t)).sub(v3(b.at)) as any;
    const a = abs(dot(p, v3(b.side))).div(b.size[0]) as any;
    const c = abs(dot(p, v3(b.up))).div(b.size[1]) as any;
    const mask = float(1)
      .sub(smoothstep(0.55, 1, a))
      .mul(float(1).sub(smoothstep(0.55, 1, c)))
      .mul(smoothstep(0, 0.02, t))
      .mul(smoothstep(0, 0.05, facing.negate())) as any;
    const falloff = float(1).sub(a.mul(a).mul(0.25)).sub(c.mul(c).mul(0.25)) as any;
    sum = sum.add(color(b.colour).mul(mask.mul(falloff).mul(b.power)));
  }
  return sum;
}

// The room behind: near black, a faint cool sweep lit behind the block, darker overhead.
export function room(d: any) {
  const base = mix(color("#030405"), color("#06070a"), smoothstep(-0.2, 0.6, d.y)) as any;
  // A broad soft glow on the far wall behind the block, wider than tall, so the block has something to bend.
  const toward = normalize(vec3(-0.05, 0.06, -1)) as any;
  const off = d.sub(toward.mul(dot(d, toward))) as any;
  const spread = off.x.mul(off.x).mul(2.2).add(off.y.mul(off.y).mul(6)) as any;
  const sweep = exp(spread.mul(-4)).mul(smoothstep(0, 0.5, dot(d, toward))) as any;
  return base.add(color("#2b3446").mul(sweep)) as any;
}

// The pool of key light on the floor, and the glow of hot figures over it.
export function floorLight(p: any) {
  const pool = CENTRE.clone().addScaledVector(KEY_DIR, (FLOOR - CENTRE.y) / KEY_DIR.y);
  const off = p.xz.sub(vec3(pool.x, 0, pool.z).xz) as any;
  const r2 = dot(off, off) as any;
  const keyLight = exp(r2.mul(-0.55))
    .mul(1.6)
    .add(exp(r2.mul(-0.1)).mul(0.18)) as any;
  return keyLight;
}

export function hotGlow(p: any) {
  let glow: any = float(0);
  for (let i = 0; i < 4; i++) {
    const h = u.hot.element(i) as any;
    const d = p.sub(h.xyz) as any;
    glow = glow.add(h.w.div(dot(d, d).mul(14).add(0.3)));
  }
  return u.hotColour.mul(glow) as any;
}

// What the floor looks like from anywhere, without the block's own light and shadow on it.
export const FLOOR_ALBEDO = "#1a1b1e";
export function floorSeen(p: any, lite = false) {
  const fade = smoothstep(2.5, 8, length(p.xz)) as any;
  let lit: any = color(FLOOR_ALBEDO).mul(floorLight(p).add(0.02));
  if (!lite) lit = lit.add(hotGlow(p).mul(0.25));
  return mix(lit, color("#030405"), fade) as any;
}

// Everything a ray from o along d meets past the block: the soft boxes, the floor, or the room.
export function env(o: any, d: any, boxGain = 1, lite = false) {
  const t = float(FLOOR)
    .sub(o.y)
    .div(min(d.y, float(-1e-4))) as any;
  const onFloor = smoothstep(0, -0.02, d.y) as any;
  const ground = floorSeen(o.add(d.mul(t)), lite) as any;
  const seen = mix(room(d), ground, onFloor) as any;
  return (boxGain > 0 ? seen.add(boxes(o, d).mul(boxGain)) : seen) as any;
}

const F0 = Math.pow((IOR - 1) / (IOR + 1), 2);
const schlick = (cos: any) => float(F0).add(float(1 - F0).mul(pow(float(1).sub(cos.clamp(0, 1)), 5))) as any;

// The block. A ray enters at the face (bent at a fine bevel near the edges, so they catch the soft boxes), and inside
// it is followed through three meetings with the faces, each splitting it into what leaves (bent out) and what reflects
// back in, all of it when past the critical angle. What leaves sees the room, the floor and the soft boxes.
// `lite` (phones): two meetings inside rather than three, and the soft boxes only in the face's own reflection.
// `mirrored`: the block's reflection in the floor, shaded as seen from the mirrored eye.
export function blockMaterial(lite = false, mirrored = false) {
  const m = new THREE.MeshBasicNodeMaterial();
  const P = positionGeometry as any;
  const N0 = normalGeometry as any;
  const H = v3(HALF);
  const E = mirrored ? u.eyeMirror : u.eye;
  const V = normalize(P.sub(E)) as any;

  // The bevel: within a few millimetres of an edge the surface turns over toward the side face.
  const near = H.sub(abs(P)) as any;
  const bevel = 0.02;
  const roll = vec3(1)
    .sub(abs(N0))
    .mul(float(1).sub(smoothstep(0, bevel, near))) as any;
  const N = normalize(N0.add(sign(P).mul(roll).mul(0.9))) as any;

  const cosI = dot(V, N).negate().max(0.02) as any;
  const F = schlick(cosI);
  const R = V.sub(N.mul(dot(V, N).mul(2))) as any;
  const worldP = toWorldPoint(P);
  // The reflection in the floor is a darker copy: the floor gives back only part, and the soft boxes barely.
  let colour: any = env(worldP, normalize(toWorldDir(R)), mirrored ? 0.25 : 1, mirrored).mul(F);

  // In: Snell's law at the face.
  const eta = 1 / IOR;
  const k = float(1).sub(float(eta * eta).mul(float(1).sub(cosI.mul(cosI)))) as any;
  let d: any = normalize(V.mul(eta).add(N.mul(cosI.mul(eta).sub(sqrt(k.max(0))))));
  let p: any = P;
  let w: any = float(1).sub(F);
  let travelled: any = float(0);
  for (let bounce = 0; bounce < (lite ? 2 : 3); bounce++) {
    const safe = vec3(select(abs(d.x).lessThan(1e-4), float(1e-4), d.x), select(abs(d.y).lessThan(1e-4), float(1e-4), d.y), select(abs(d.z).lessThan(1e-4), float(1e-4), d.z)) as any;
    const far = sign(safe).mul(H).sub(p).div(safe) as any;
    const t = min(far.x, min(far.y, far.z)).max(0) as any;
    const onX = far.x.lessThanEqual(min(far.y, far.z));
    const onY = far.y.lessThanEqual(far.z).and(onX.not());
    const axis = select(onX, vec3(1, 0, 0), select(onY, vec3(0, 1, 0), vec3(0, 0, 1))) as any;
    const n = axis.mul(sign(safe)) as any;
    const q = p.add(d.mul(t)) as any;
    travelled = travelled.add(t);
    const cosE = dot(d, n).max(0) as any;
    const kOut = float(1).sub(float(IOR * IOR).mul(float(1).sub(cosE.mul(cosE)))) as any;
    const through = kOut.greaterThan(0);
    const out = normalize(d.mul(IOR).add(n.mul(sqrt(kOut.max(0)).sub(cosE.mul(IOR))))) as any;
    const Fe = select(through, schlick(sqrt(kOut.max(0))), float(1)) as any;
    // Acrylic is very slightly blue-green over a long path.
    const tint = exp(vec3(0.05, 0.025, 0.02).mul(travelled).negate()) as any;
    // Seen through the block the soft boxes are magnified into great panels; keep them to a gleam.
    colour = colour.add(
      env(toWorldPoint(q), normalize(toWorldDir(out)), lite ? 0 : 0.07, lite)
        .mul(w.mul(float(1).sub(Fe)))
        .mul(tint)
    );
    w = w.mul(Fe);
    d = d.sub(n.mul(cosE.mul(2)));
    p = q;
  }

  // Light from a figure still hot, carried round inside the block and out at its edges.
  const edge = float(1).sub(smoothstep(0, 0.05, min(min(near.x.max(abs(N0.x)), near.y.max(abs(N0.y))), near.z.max(abs(N0.z))))) as any;
  const glow = hotGlow(worldP).mul(0.22).mul(edge.mul(2.6).add(0.15)) as any;
  // Light piped along inside the block leaks out at its bevelled edges, the top ones (nearest the key) most.
  const rim = float(1).sub(smoothstep(0, bevel * 0.7, min(min(near.x.max(abs(N0.x)), near.y.max(abs(N0.y))), near.z.max(abs(N0.z))))) as any;
  const topness = smoothstep(-0.2, 0.6, P.y.div(H.y)) as any;
  const glance = float(1).sub(cosI).mul(0.6).add(0.4) as any;
  const piped = color("#f3f1ec").mul(rim.mul(topness.mul(topness).mul(0.5).add(0.025)).mul(glance)) as any;
  const stand = (u.hotColour as any).mul(u.under.mul(edge).mul(0.035)).add(piped) as any;
  m.colorNode = vec4(colour.add(glow).add(stand), 1) as any;
  return m;
}
