import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { abs, attribute, float, fract, fwidth, length, mix, positionGeometry, select, smoothstep } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A generic high-end two-fan graphics card, built once from boxes and extruded outlines: a matte graphite shroud with
// two rounded-square openings, a bright brushed-silver frame round its edge that crosses in an X between the fans and
// borders each opening, fin slats behind the fans, a black backplate, a black vented bracket at one end and gold fingers
// along the bottom. Each part carries its own colour, metalness and roughness as vertex attributes, so the whole card is
// one draw; the two fans are a second geometry, so they can spin. No names, no logos.
// Hundreds fly at once, so it is kept lean (about 600 triangles a card, 300 a fan): the fin stack is one block striped
// with slats by the material, the hub's lathe rings are drawn on a flat disc, and curves have only a few segments.

// The card's length, height and thickness; the bracket is at -x, the fans face +z, the fingers are along -y.
export const CARD = { length: 0.36, height: 0.156, thick: 0.048 };
// The fans' centres along the card, their openings' half-size and corner radius, and the fans' radius.
export const FANS = [-0.085, 0.085];
const OPEN = 0.063;
const OPEN_ROUND = 0.024;
export const FAN_R = 0.058;
// The fans sit this far forward, inside the shroud's openings.
export const FAN_Z = CARD.thick / 2 - 0.0085;

// The last number picks a pattern the material draws on the part: 1 the fin slats, 2 the hub's turned rings.
type Finish = [r: number, g: number, b: number, metal: number, rough: number, pattern?: number];
const GRAPHITE: Finish = [0.085, 0.09, 0.098, 0.55, 0.55];
const SILVER: Finish = [0.9, 0.91, 0.93, 0.85, 0.34];
const BLACK: Finish = [0.03, 0.03, 0.035, 0.4, 0.5];
const MATTE_BLACK: Finish = [0.012, 0.012, 0.014, 0.1, 0.7];
const FINS: Finish = [0.36, 0.37, 0.4, 1, 0.4, 1];
const PCB: Finish = [0.02, 0.07, 0.045, 0, 0.5];
const GOLD: Finish = [1, 0.74, 0.32, 1, 0.22];
const HUB: Finish = [0.8, 0.81, 0.84, 0.9, 0.3, 2];
const BLADE: Finish = [0.075, 0.078, 0.085, 0.3, 0.55];
// The fin stack's slats: how many along the card, and the share of each pitch that is metal rather than the dark gap.
const FIN_COUNT = 64;
const FIN_FILL = 0.35;
// The hub's rings, this far apart.
const RING = 0.0045;

// A geometry made non-indexed and painted with one finish, ready to merge.
function paint(geometry: THREE.BufferGeometry, [r, g, b, metal, rough, pattern = 0]: Finish) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  flat.deleteAttribute("uv");
  if (!flat.getAttribute("normal")) flat.computeVertexNormals();
  const n = flat.getAttribute("position").count;
  const colour = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colour.set([r, g, b], i * 3);
    pbr.set([metal, rough, pattern], i * 3);
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colour, 3));
  flat.setAttribute("aPbr", new THREE.BufferAttribute(pbr, 3));
  return flat;
}

// A box from its lower and upper corners.
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, finish: Finish) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return paint(g, finish);
}

// A rounded rectangle as a closed outline, centred at (cx, cy) with half-sizes hx, hy.
function rounded<T extends THREE.Path>(into: T, cx: number, cy: number, hx: number, hy: number, r: number) {
  into.moveTo(cx - hx + r, cy - hy);
  into.lineTo(cx + hx - r, cy - hy);
  into.absarc(cx + hx - r, cy - hy + r, r, -Math.PI / 2, 0, false);
  into.lineTo(cx + hx, cy + hy - r);
  into.absarc(cx + hx - r, cy + hy - r, r, 0, Math.PI / 2, false);
  into.lineTo(cx - hx + r, cy + hy);
  into.absarc(cx - hx + r, cy + hy - r, r, Math.PI / 2, Math.PI, false);
  into.lineTo(cx - hx, cy - hy + r);
  into.absarc(cx - hx + r, cy - hy + r, r, Math.PI, Math.PI * 1.5, false);
  return into;
}

// An outline in the card's face, extruded from z0 forward by `depth`. Each rounded corner gets twice `curve` segments.
function slab(shape: THREE.Shape, z0: number, depth: number, finish: Finish, curve = 2) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: curve });
  g.translate(0, 0, z0);
  return paint(g, finish);
}
const polygon = (points: [number, number][]) => new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
// A band round a rounded rectangle, `width` wide inward.
function band(cx: number, cy: number, hx: number, hy: number, r: number, width: number) {
  const shape = rounded(new THREE.Shape(), cx, cy, hx, hy, r);
  shape.holes.push(rounded(new THREE.Path(), cx, cy, hx - width, hy - width, Math.max(0.002, r - width)));
  return shape;
}

export function cardGeometry() {
  const { length: L, height: H, thick: T } = CARD;
  const x0 = -L / 2;
  const x1 = L / 2;
  const y0 = -H / 2;
  const y1 = H / 2;
  const z0 = -T / 2;
  const z1 = T / 2;
  const parts: THREE.BufferGeometry[] = [];

  // The backplate, with a slightly raised plate on it, and the board just in front of it.
  parts.push(box(x0 + 0.003, y0, z0, x1, y1, z0 + 0.004, BLACK));
  parts.push(box(x0 + 0.05, y0 + 0.02, z0 - 0.0012, x1 - 0.03, y1 - 0.02, z0 + 0.001, BLACK));
  parts.push(box(x0 + 0.003, y0 - 0.002, z0 + 0.004, x1 - 0.004, y1, z0 + 0.006, PCB));

  // The heatsink: a stack of thin fins showing along the top and bottom edges and through the openings, where they are
  // fine slats behind the blades. One block, its slats drawn by the material.
  parts.push(box(x0 + 0.01, y0 + 0.003, z0 + 0.006, x1 - 0.01, y1 - 0.003, z1 - 0.013, FINS));

  // The fingers' tab on the board, and the gold fingers on it either side of the key notch.
  const fx0 = x0 + 0.04;
  const fx1 = fx0 + 0.16;
  parts.push(box(fx0, y0 - 0.017, z0 + 0.004, fx1, y0, z0 + 0.006, PCB));
  parts.push(box(fx0 + 0.004, y0 - 0.0155, z0 + 0.0033, fx0 + 0.034, y0 - 0.004, z0 + 0.0067, GOLD));
  parts.push(box(fx0 + 0.04, y0 - 0.0155, z0 + 0.0033, fx1 - 0.004, y0 - 0.004, z0 + 0.0067, GOLD));

  // The shroud: a graphite plate with its corners softened and two rounded-square openings.
  const sz = z1 - 0.013;
  const shroud = rounded(new THREE.Shape(), 0.002, 0, L / 2 - 0.004, H / 2, 0.012);
  for (const x of FANS) shroud.holes.push(rounded(new THREE.Path(), x, 0, OPEN, OPEN, OPEN_ROUND));
  parts.push(slab(shroud, sz, 0.0095, GRAPHITE, 3));

  // The brushed-silver frame laid on it: round the edge, round each opening, and an X crossing between the two.
  const fz = z1 - 0.0045;
  parts.push(slab(band(0.002, 0, L / 2 - 0.004, H / 2, 0.012, 0.0055), fz, 0.0035, SILVER));
  for (const x of FANS) parts.push(slab(band(x, 0, OPEN + 0.006, OPEN + 0.006, OPEN_ROUND + 0.006, 0.0062), fz, 0.0035, SILVER, 3));
  const gap = FANS[1] - OPEN - 0.004;
  const w = 0.0055;
  for (const s of [1, -1]) {
    parts.push(
      slab(
        polygon([
          [-gap - w, -s * (H / 2 - 0.004)],
          [-gap + w, -s * (H / 2 - 0.004)],
          [gap + w, s * (H / 2 - 0.004)],
          [gap - w, s * (H / 2 - 0.004)]
        ]),
        fz + 0.0004,
        0.0035,
        SILVER
      )
    );
  }
  // And a small silver bar at the far end, the frame's tail.
  parts.push(slab(polygon([[x1 - 0.022, -0.03], [x1 - 0.012, -0.03], [x1 - 0.012, 0.03], [x1 - 0.022, 0.03]]), fz, 0.0035, SILVER));

  // The power socket on top.
  parts.push(box(0.07, y1, z0 + 0.01, 0.11, y1 + 0.009, z0 + 0.026, MATTE_BLACK));

  // The bracket: a black plate across the end, cut with vent slots, its top folded over, a tab below.
  const bracket = polygon([
    [z0 - 0.002, y0 - 0.03],
    [z1 + 0.002, y0 - 0.03],
    [z1 + 0.002, y1 + 0.006],
    [z0 - 0.002, y1 + 0.006]
  ]);
  for (let i = 0; i < 6; i++) {
    const y = y0 + 0.02 + i * 0.022;
    const cz = (z0 + z1) / 2 + 0.006;
    bracket.holes.push(new THREE.Path([new THREE.Vector2(cz - 0.011, y - 0.0032), new THREE.Vector2(cz + 0.011, y - 0.0032), new THREE.Vector2(cz + 0.011, y + 0.0032), new THREE.Vector2(cz - 0.011, y + 0.0032)]));
  }
  const plate = new THREE.ExtrudeGeometry(bracket, { depth: 0.003, bevelEnabled: false });
  // Its outline is drawn in (z, y); turned so it stands across the card's end, 3 mm thick along x.
  plate.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  plate.translate(x0, 0, 0);
  parts.push(paint(plate, BLACK));
  parts.push(box(x0 - 0.019, y1 + 0.003, z0 - 0.002, x0 - 0.003, y1 + 0.006, z1 + 0.002, BLACK));

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  merged.computeBoundingSphere();
  return merged;
}

// A stick of memory, the size of the card's lengthwise scale: a green board with the key notch a little off centre,
// a row of gold contacts along the bottom (drawn as pins by the slat pattern), black memory chips down both sides with
// a register chip between them on the front, and a plain white label on the back. No names, no logos.
export const RAM = { length: 0.2, height: 0.047, thick: 0.0024 };
const RAM_GREEN: Finish = [0.05, 0.3, 0.1, 0, 0.42];
const RAM_GOLD: Finish = [1, 0.74, 0.32, 1, 0.22, 1];
const CHIP: Finish = [0.022, 0.022, 0.026, 0.1, 0.38];
const LABEL: Finish = [0.86, 0.87, 0.86, 0, 0.6];
export function ramGeometry() {
  const { length: L, height: H, thick: T } = RAM;
  const x0 = -L / 2;
  const x1 = L / 2;
  const y0 = -H / 2;
  const y1 = H / 2;
  const t = T / 2;
  const parts: THREE.BufferGeometry[] = [];
  // The board above the contacts, then the contact strip either side of the notch.
  const strip = y0 + 0.0075;
  const notch = x0 + L * 0.56;
  parts.push(box(x0, strip, -t, x1, y1, t, RAM_GREEN));
  parts.push(box(x0 + 0.002, y0, -t, notch - 0.002, strip, t, RAM_GREEN));
  parts.push(box(notch + 0.002, y0, -t, x1 - 0.002, strip, t, RAM_GREEN));
  for (const [a, b] of [
    [x0 + 0.004, notch - 0.003],
    [notch + 0.003, x1 - 0.004]
  ])
    parts.push(box(a, y0 + 0.0008, -t - 0.0002, b, strip - 0.0012, t + 0.0002, RAM_GOLD));
  // The chips: four each side of the middle on the front, with the register between; seven across the back beside the
  // label.
  const cw = 0.0165;
  const ch = 0.0115;
  const cy = 0.004;
  const pitch = 0.0205;
  const chip = (x: number, side: number) => parts.push(box(x - cw / 2, cy - ch / 2, side > 0 ? t : -t - 0.0011, x + cw / 2, cy + ch / 2, side > 0 ? t + 0.0011 : -t, CHIP));
  for (let k = 0; k < 8; k++) chip((k - 3.5) * pitch + (k < 4 ? -0.018 : 0.018), 1);
  for (let k = 0; k < 7; k++) chip(-0.038 + k * pitch, -1);
  parts.push(box(-0.009, cy - 0.005, t, 0.009, cy + 0.005, t + 0.0009, CHIP));
  // The label, on the back where two chips would be.
  parts.push(box(x0 + 0.008, y1 - 0.02, -t - 0.0003, x0 + 0.05, y1 - 0.007, -t, LABEL));
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  merged.computeBoundingSphere();
  return merged;
}

// One fan, about its own middle and facing +z: seven broad, smoothly swept blades round a large flat brushed hub,
// turned in rings like a lathe's cuts.
export function fanGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const blades = 7;
  const inner = 0.022;
  const outer = FAN_R;
  for (let k = 0; k < blades; k++) {
    const pts: THREE.Vector2[] = [];
    const steps = 5;
    // Leading edge out from the root, round the tip, trailing edge back in: wide and swept.
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const r = inner + (outer - inner) * f;
      const a = f * 0.62 + Math.sin(f * Math.PI) * 0.1;
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    for (let s = 1; s < 3; s++) {
      const a = 0.62 + (s / 3) * 0.7;
      const r = outer - Math.sin((s / 3) * Math.PI) * 0.0015;
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    for (let s = steps; s >= 0; s--) {
      const f = s / steps;
      const r = inner + (outer - inner) * f;
      const a = 0.5 + f * 0.62 + Math.sin(f * Math.PI) * 0.08 + f * 0.2;
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.0013, bevelEnabled: false });
    g.translate(0, 0, -0.00065);
    // Pitched about its own radial line, as a fan's blades are.
    const mid = 0.85;
    g.applyMatrix4(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(Math.cos(mid), Math.sin(mid), 0), 0.32));
    g.rotateZ((k / blades) * Math.PI * 2);
    parts.push(paint(g, BLADE));
  }
  // The hub: a dark drum, a flat brushed disc on it with the rings drawn on, and a small cap in the middle.
  const drum = new THREE.CylinderGeometry(inner + 0.001, inner + 0.001, 0.006, 16, 1, true);
  drum.rotateX(Math.PI / 2);
  drum.translate(0, 0, -0.0015);
  parts.push(paint(drum, BLACK));
  const disc = new THREE.CylinderGeometry(0.0225, 0.0225, 0.0008, 24);
  disc.rotateX(Math.PI / 2);
  disc.translate(0, 0, 0.0019);
  parts.push(paint(disc, HUB));
  const cap = new THREE.CylinderGeometry(0.0095, 0.0095, 0.001, 12, 1);
  cap.rotateX(Math.PI / 2);
  cap.translate(0, 0, 0.0026);
  parts.push(paint(cap, HUB));

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  merged.translate(0, 0, FAN_Z);
  merged.computeBoundingSphere();
  return merged;
}

// The one material for cards and fans: each part's finish from its vertices, and the patterns drawn on top. Patterns
// finer than a pixel fade to their average, so far-off cards never shimmer.
export function cardMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const pbr = attribute("aPbr", "vec3") as any;
  const p = positionGeometry as any;
  // Slats: a fraction FIN_FILL of each pitch is lit metal, the rest the dark core seen between them.
  const across = p.x.add(CARD.length / 2 - 0.01).div((CARD.length - 0.02) / FIN_COUNT) as any;
  const blur = fwidth(across).max(1e-4) as any;
  const edge = abs(fract(across).sub(0.5)).mul(2) as any;
  const slat = mix(smoothstep(float(FIN_FILL).sub(blur), float(FIN_FILL).add(blur), edge).oneMinus(), float(FIN_FILL), smoothstep(0.35, 0.8, blur)) as any;
  // Rings: a thin dark groove every RING out from the middle.
  const out = length(p.xy).div(RING) as any;
  const blurR = fwidth(out).max(1e-4) as any;
  const nearest = abs(fract(out).sub(0.5)).mul(2).oneMinus() as any;
  const groove = mix(smoothstep(float(0.12).sub(blurR), float(0.12).add(blurR), nearest).oneMinus(), float(0.12), smoothstep(0.35, 0.8, blurR)) as any;
  const kind = pbr.z as any;
  const shade = select(kind.greaterThan(1.5), groove.mul(-0.6).add(1), select(kind.greaterThan(0.5), mix(float(0.04), float(1), slat), float(1))) as any;
  m.colorNode = (attribute("color", "vec3") as any).mul(shade);
  m.metalnessNode = pbr.x;
  m.roughnessNode = select(kind.greaterThan(0.5).and(kind.lessThan(1.5)), mix(float(0.75), pbr.y, slat), pbr.y);
  return m;
}
