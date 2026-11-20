import * as THREE from "three/webgpu";
import {
  Fn,
  atan,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  positionView,
  clamp,
  color,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  frontFacing,
  fwidth,
  max,
  mix,
  mod,
  modelWorldMatrix,
  mx_noise_float,
  normalize,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  transformNormalToView,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { sky } from "../../14-tension/backdrop";
import { live } from "./live";
import { skyAt } from "./sky";
import { look, relief, wingMap } from "./look";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The four wings as one mesh: each a fine grid over its tile of the atlas, cut to the real outline by the photograph's
// own alpha. Wing space: x out from the body, y toward the head, z out of the upper side, in forewing lengths. Each
// wing is bent in the vertex shader (spanwise lag, twist, chordwise camber), grown from a crumpled stub as it expands,
// and placed on the body by its own matrix. Up close the scales show: rows of tiny shingles, each with its own tilt.

const GRID = 96;

// 0 fore right, 1 fore left, 2 hind right, 3 hind left. Left wings are the right wings mirrored by their matrix, so
// their triangles are wound the other way to keep the upper side the front face.
export function wingGeometry(grid = GRID) {
  const uv: number[] = [];
  const which: number[] = [];
  const index: number[] = [];
  for (let w = 0; w < 4; w++) {
    const base = uv.length / 2;
    for (let j = 0; j <= grid; j++)
      for (let i = 0; i <= grid; i++) {
        uv.push(i / grid, j / grid);
        which.push(w);
      }
    const left = w % 2 === 1;
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) {
        const a = base + j * (grid + 1) + i;
        const b = a + 1;
        const c = a + grid + 1;
        const d = c + 1;
        // Tile v runs down (toward the tail), so this winding faces +z for a right wing.
        if (left) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array((uv.length / 2) * 3), 3));
  geometry.setAttribute("aUV", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("aWing", new THREE.Float32BufferAttribute(which, 1));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  return geometry;
}

// Where a wing point lies flat, before any growing or bending: from its tile coordinates.
function flat(tile: any, hind: any) {
  const frame = mix(look.fore, look.hind, hind) as any;
  return vec2(frame.x.add(tile.x.mul(frame.z)), frame.y.sub(tile.y.mul(frame.z))) as any;
}

// Where a wing point lies in wing space, with all its bending.
function shape(tile: any, hind: any) {
  const p0 = flat(tile, hind) as any;
  const r = p0.length() as any;
  // Expansion runs from the base to the tip: length first, then width.
  const e = clamp(live.expand.mul(1.5).sub(r.mul(0.5)), 0, 1) as any;
  // Packed in the chrysalis (live.pack 1) the stub is the size of the pupal wing case, and smooth rather than tissue.
  const along = mix(float(0.39).sub(live.pack.mul(0.18)), float(1), pow(e, 0.7)) as any;
  const across = mix(float(0.29), float(1), pow(e, 1.25)) as any;
  const dir = p0.div(max(r, 0.001)) as any;
  const side = vec2(dir.y.negate(), dir.x) as any;
  const radial = p0.dot(dir).mul(along) as any;
  const lateral = p0.dot(side).mul(across) as any;
  const flatP = dir.mul(radial).add(side.mul(lateral)) as any;
  // A hindwing's inner margin is a shallow gutter that cups the abdomen: with the wings shut over the back, the strip
  // nearest the body, behind the wing's root, bends down beside the abdomen and a little out from it. Eased in as the
  // wings close, so an open wing lies flat.
  const gutter = smoothstep(0.17, 0.0, p0.x).mul(smoothstep(-0.03, -0.3, p0.y)).mul(hind).mul(look.shut).mul(e) as any;
  const p = vec2(flatP.x.sub(gutter.mul(0.055)), flatP.y) as any;
  // Crumpled like wet tissue: pleats fanned out from the base, puckers across them, finer creases over both; all of it
  // flattening out from the base as the veins fill.
  const wrinkle = live.crumple.mul(e.oneMinus().mul(0.85).add(0.15)).mul(live.pack.mul(0.65).oneMinus()) as any;
  const fan = atan(p0.y, p0.x) as any;
  const pleat = sin(fan.mul(31).add(mx_noise_float(vec3(p0.mul(4), 2.3)).mul(3))).mul(r.mul(0.05).add(0.006)) as any;
  const pucker = mx_noise_float(vec3(p0.mul(6), 1.7))
    .mul(0.06)
    .add(mx_noise_float(vec3(p0.mul(17), 4.1)).mul(0.007))
    .add(sin(p0.x.mul(34).add(p0.y.mul(14))).mul(0.002)) as any;
  // The trailing hindwing sits under the forewing.
  const layer = mix(float(0.004), float(-0.004), hind) as any;
  const rr = p.length() as any;
  // Bend along the span (the tip lagging), twist (the trailing edge lagging further out), and camber across the chord.
  const chord = p.dot(vec2(0.62, -0.78)) as any;
  const z = live.bend
    .mul(rr.mul(rr))
    .add(live.twist.mul(rr).mul(chord))
    .add(live.camber.mul(chord.mul(chord)).mul(mix(float(1), float(0.6), hind)))
    // The membrane is faintly corrugated between its veins, like a fan.
    .add(sin(fan.mul(26)).mul(r).mul(0.003).mul(e))
    .add(pucker.add(pleat).mul(wrinkle))
    .add(layer)
    .add(gutter.mul(-0.012))
    // Fresh wings are limp: they droop at the tips and curl at the edges.
    .add(live.wet.mul(-0.05).mul(rr.mul(rr))) as any;
  return vec3(p.x, p.y, z);
}

// What both passes share: where the vertex goes, the wing's own frame there, and which tile of the atlas it shows.
function wingNodes() {
  const tile = attribute("aUV", "vec2") as any;
  const which = attribute("aWing", "float") as any;
  const hind = which.greaterThan(1.5).select(float(1), float(0)) as any;
  const pick = (k: number) => which.sub(k).abs().lessThan(0.5);
  const M = select(pick(0), live.wing[0], select(pick(1), live.wing[1], select(pick(2), live.wing[2], live.wing[3]))) as any;
  const eps = 0.01;
  const p = shape(tile, hind) as any;
  const px = shape(tile.add(vec2(eps, 0)), hind) as any;
  const py = shape(tile.add(vec2(0, eps)), hind) as any;
  const local = cross(px.sub(p), py.sub(p).negate()) as any;
  // (The mesh itself is not raised along the veins: at any density its facets showed as a saw-tooth along every vein
  // and border. The relief is all in the shading, which is smooth at every distance.)
  const position = M.mul(vec4(p, 1)).xyz as any;
  // Crumpled tissue is soft: it scatters light in its folds, so it is shaded by a normal most of the way back to the
  // flat wing's and its creases read as gentle shading, not as facets of foil.
  const creased = normalize(M.mul(vec4(local, 0)).xyz) as any;
  const smoothed = normalize(M.mul(vec4(float(0), float(0), float(1), float(0))).xyz) as any;
  const nObj = varying((normalize as any)((mix as any)(creased, smoothed, live.crumple.mul(0.62)))) as any;
  // The direction the scale rows run: out from the root.
  const tObj = varying(normalize(M.mul(vec4(p.x, p.y, 0, 0)).xyz)) as any;
  // Flat wing coordinates, for the scales: they are laid down before the wing ever unfolds.
  const at = varying(flat(tile, hind)) as any;
  const upper = frontFacing as any;
  const row = select(upper, float(0), float(1)) as any;
  const otherRow = select(upper, float(1), float(0)) as any;
  // Sampled a hair inside the tile, so the neighbouring tiles never bleed in along the card's edges; and the card's
  // own outer edges count as outside the wing whatever the filtering finds there.
  const inset = tile.clamp(0.004, 0.996) as any;
  const uvOf = (under: any) => vec2(under.add(inset.x).div(2), float(1).sub(hind.add(inset.y).div(2)));
  const card = smoothstep(1, 0.99, tile.x).mul(smoothstep(0, 0.01, tile.y)).mul(smoothstep(1, 0.99, tile.y)) as any;
  return { tile, hind, position, nObj, tObj, at, upper, card, uv: uvOf(row), uvBehind: uvOf(otherRow) };
}

const hash2 = (a: any, b: any) => fract(sin(a.mul(127.1).add(b.mul(311.7))).mul(43758.5453)) as any;

export function wingMaterial() {
  // (Little of the renderer's own specular: with the sun behind, its grazing sheen lays a grey film over the dark
  // scales. The shine that belongs there is added by hand below, region by region.)
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.7, metalness: 0, specularIntensity: 0.15 });
  m.alphaTest = 0.5;
  const W = wingNodes();
  const { hind, nObj, tObj, at, upper } = W;
  m.positionNode = W.position.mul(live.hidden.oneMinus()) as any;
  const tex = wingMap.sample(W.uv) as any;
  const behind = wingMap.sample(W.uvBehind) as any;
  const rgb = tex.rgb as any;
  // The fringe: the edge breaks up into fine hairs standing out from the margin (not on a glasswing, whose veins
  // would grow fur).
  const soft = wingMap.sample(W.uv).bias(float(2.6)).a as any;
  const fan = atan(at.y, at.x) as any;
  // (The fringe's hairs only where they are wider than a pixel: finer than that they are an even soft edge.)
  const hairy = clamp(float(1.4).sub(fwidth(fan.mul(1100)).mul(1.6)), 0, 1) as any;
  const hair = mix(float(0.5), hash2(floor(fan.mul(1100)), hind), hairy) as any;
  const margin = smoothstep(0.05, 0.5, soft).mul(smoothstep(0.98, 0.5, soft)) as any;
  // (No white bar is drawn: the glasswing's comes from its photograph, or not at all.)
  const bar = float(0) as any;
  m.opacityNode = mix(tex.a, soft.add(hair.sub(0.5).mul(0.3).mul(margin)), look.glass.oneMinus().mul(margin.greaterThan(0.02).select(float(1), float(0))))
    .max(bar)
    // Where a wing meets the body its card would end in a ruled line: there it frays into the hair of the wing base.
    // (No strands are drawn along the edge that meets the body: at any size they read as a comb. The edge is only
    // made gently uneven, a slow waver with a finer one on it, and the body's own coat does the rest.)
    .mul(step(sin(W.tile.y.mul(61)).mul(0.004).add(sin(W.tile.y.mul(173).add(1.3)).mul(0.0025)).add(0.008), W.tile.x))
    // At its very root a wing is narrow and sunk in the thorax's coat: the first few hundredths fade out under it.
    .mul(smoothstep(0.035, 0.075, at.length().add(hash2(floor(fan.mul(90)), hind.add(5)).mul(0.03))))
    .mul(W.card) as any;

  // Scales: rows across the wing, each scale a rounded shingle lying over the base of the one beyond it. At any point
  // two scales may be there, this row's and the tip of the row before; the one before lies on top wherever its
  // rounded end reaches. Each has its own length, tilt and shade, fine ridges along it, and a dark shadow line where its
  // free edge lies on the next. This is what stays sharp when the photograph has run out of pixels.
  const rr = at.length() as any;
  // (Wobbled by a cheap pair of sines, not noise: this runs for every pixel of a wing that fills the screen.)
  const rows = rr.mul(330).add(sin(at.x.mul(71).add(at.y.mul(23))).mul(sin(at.y.mul(59).sub(at.x.mul(17)))).mul(0.6)) as any;
  const row = floor(rows) as any;
  const fu = fract(rows) as any;
  const scaleIn = (r: any, y: any) => {
    const across = fan.mul(r.add(0.5)).mul(1.5).add(mod(r, 2).mul(0.5)).add(hash2(r, float(3.1)).mul(0.6)) as any;
    const x = fract(across).sub(0.5).mul(2) as any;
    const id = hash2(floor(across), r) as any;
    const tip = float(1.5).add(id.mul(0.22)).sub(x.mul(x).mul(0.62)) as any;
    return { x, y, id, tip };
  };
  const mine = scaleIn(row, fu);
  const over = scaleIn(row.sub(1), fu.add(1));
  const onTop = step(over.y, over.tip) as any;
  const sx = mix(mine.x, over.x, onTop) as any;
  const sy = mix(mine.y, over.y, onTop) as any;
  const tilt = mix(mine.id, over.id, onTop) as any;
  const toEdge = mix(mine.tip, over.tip, onTop).sub(sy) as any;
  const fv = sx;
  const fine = clamp(float(1.2).sub(fwidth(rows).mul(3.2)), 0, 1) as any;
  // (At middle distances the rows would read as a woven mesh: there they are faded to an even grain.)
  const close = fine.mul(fine) as any;
  // The shadow each free edge casts on the scale beneath, and the roundness of the scale across its width.
  const lip = smoothstep(0, 0.16, toEdge) as any;
  const body = float(1).sub(sx.mul(sx)).mul(lip) as any;
  const mellow = mix(float(0.5), tilt, body) as any;
  const ridges = sin(sx.mul(Math.PI * 6)).mul(0.07).mul(body) as any;
  const upScale = sy.div(1.7) as any;
  const shingle = upScale.mul(float(1).sub(sx.mul(sx).mul(0.4))).mul(lip).add(ridges).mul(close).add(mellow.mul(0.3)) as any;
  // Veins and pattern edges stand a little proud; a fresh wing is creased all over.
  const lum = dot(rgb, vec3(0.3, 0.55, 0.15)) as any;
  // What kind of scale is here, read from the photograph: black, white or coloured; and the veins, which are the dark
  // lines finer than their own neighbourhood.
  const around = wingMap.sample(W.uv).level(float(5)).rgb as any;
  // (A dark line in a lighter field: not the dark margin itself, where pale spots would make every dark scale a vein.)
  const lumAround = dot(around, vec3(0.3, 0.55, 0.15)) as any;
  // (Everything about relief is read from fixed, blurred levels of the photograph, never from its raw pixels: a field
  // that stays smooth however far the wing is magnified, so no ridge, shadow or rim can show the pixel grid.)
  const smoothLum = dot(wingMap.sample(W.uv).level(float(2.5)).rgb, vec3(0.3, 0.55, 0.15)) as any;
  const vein = smoothstep(0.03, 0.16, lumAround.sub(smoothLum)).mul(smoothstep(0.07, 0.2, lumAround)) as any;
  // Beside each vein the membrane dips to meet it: a soft band wider than the vein, shaded and holding back the light.
  const wider = wingMap.sample(W.uv).level(float(6.5)) as any;
  const band = clamp(smoothstep(0.015, 0.1, dot(wider.rgb, vec3(0.3, 0.55, 0.15)).sub(dot(around, vec3(0.3, 0.55, 0.15))).add(vein.mul(0.05))).sub(vein.mul(0.6)), 0, 1) as any;
  // Each cell between veins billows a little, so light breaks cell by cell.
  const billow = smoothstep(0.0, 0.14, dot(around, vec3(0.3, 0.55, 0.15)).sub(dot(wider.rgb, vec3(0.3, 0.55, 0.15))).add(0.05)) as any;
  // The leading edge of the forewing is a thick rolled rib.
  const costa = smoothstep(0.97, 0.55, wider.a).mul(smoothstep(0.3, 0.75, fan)).mul(hind.oneMinus()) as any;
  const chroma = max(rgb.r, max(rgb.g, rgb.b)).sub(rgb.r.min(rgb.g.min(rgb.b))) as any;
  const black = smoothstep(0.14, 0.04, smoothLum) as any;
  const white = smoothstep(0.5, 0.78, smoothLum).mul(smoothstep(0.35, 0.12, chroma)) as any;
  // Hair, not scales, at the wing's base: fuzzy and matte.
  const fuzz = smoothstep(0.26, 0.06, at.length()) as any;
  const glossHere = mix(mix(mix(look.gloss.x, look.gloss.z, white), look.gloss.y, black), look.gloss.w, vein.mul(fine.mul(0.6).add(0.1))).mul(fuzz.oneMinus()).mul(live.wet.oneMinus()) as any;
  const crease = sin(at.x.mul(190).add(at.y.mul(70))).mul(sin(at.y.mul(160).sub(at.x.mul(40)))).add(sin(at.x.mul(47).add(at.y.mul(83))).mul(1.6)).mul(live.crumple).mul(0.002) as any;
  const height = shingle.mul(0.0009).mul(fine).add(vein.mul(0.022).add(billow.mul(0.008)).add(costa.mul(0.02)).mul(fine.mul(0.8).add(0.2))).add(sin(fan.mul(26)).mul(at.length()).mul(0.0016)).add(crease).mul(look.scale) as any;
  const flatNormal = normalize(transformNormalToView(nObj)) as any;
  const faced = select(upper, flatNormal, flatNormal.negate()) as any;
  m.normalNode = relief(height, faced) as any;

  // Structural colour: where the photograph is Morpho blue, on the upper side.
  const blueness = clamp(rgb.b.sub(rgb.r.mul(1.15)).mul(3.2), 0, 1).mul(smoothstep(0.12, 0.3, rgb.b)) as any;
  const isMorpho = live.structure.sub(1).abs().lessThan(0.5).select(float(1), float(0)) as any;
  // (Only where the photograph is blue over a neighbourhood, not at one stray bluish speck in the dark margin.)
  const blueAround = clamp(around.b.sub(around.r.mul(1.15)).mul(3.2), 0, 1) as any;
  const mask = select(upper, blueness.mul(smoothstep(0.12, 0.4, blueAround)).mul(isMorpho), float(0)) as any;
  const grown = live.expand.mul(live.expand) as any;
  // Fresh from the chrysalis the wing is pale and soft, its colours milky under the damp.
  const shadeOf = mix(float(1), mellow.mul(0.2).add(0.9).mul(lip.mul(0.3).add(0.7)), fine) as any;
  // A crumpled pad is thick with folds: its valleys are dark and its ridges catch what light there is, so it reads
  // as soft bunched tissue and not as a flat picture of a wing.
  const folds = sin(at.x.mul(95).add(sin(at.y.mul(41)).mul(2.2))).mul(sin(at.y.mul(73).sub(at.x.mul(29)))).add(sin(fan.mul(31)).mul(0.7)) as any;
  const valley = smoothstep(0.5, -0.9, folds).mul(live.crumple) as any;
  const pigment = mix(mix(rgb, vec3(0.86, 0.84, 0.78), bar), rgb.mul(0.62).add(vec3(0.3, 0.27, 0.22)), live.wet.mul(0.55))
    .mul(shadeOf)
    .mul(valley.mul(0.55).oneMinus()) as any;
  // Under the structural layer, melanin: the scales' brown-black ground.
  // (On a Morpho's upper side, worn scales along the veins show pale in the photograph: toned down to dark vein.)
  const worn = select(upper, isMorpho.mul(vein).mul(mask.oneMinus()).mul(smoothstep(0.12, 0.3, blueAround)), float(0)) as any;
  m.colorNode = mix(mix(pigment, color("#1a120c"), worn.mul(0.85)), color("#0e0a08"), mask.mul(0.92).mul(live.wet.oneMinus())).mul(band.mul(0.36).oneMinus()).mul(costa.mul(0.45).oneMinus()) as any;
  // Wet from the chrysalis it has no shine at all: matte as damp tissue.
  m.roughnessNode = mix(mix(float(0.95), float(0.3), glossHere).max(mask.mul(0.6).oneMinus().mul(0.3)), float(1), live.wet) as any;
  m.emissiveNode = Fn(() => {
    const P = positionWorld as any;
    const V = normalize(cameraPosition.sub(P)) as any;
    const n0 = normalize(nObj) as any;
    // The object's world matrix is a rotation and a uniform scale, so object directions turn into world ones by it.
    const Nw = normalize((modelWorldMatrix as any).mul(vec4(select(upper, n0, n0.negate()) as any, 0)).xyz) as any;
    const L = sky.toLight as any;
    const sun = sky.light.mul(sky.power) as any;
    const NV = max(dot(Nw, V), 0) as any;
    const NL = max(dot(Nw, L), 0) as any;
    const H = normalize(L.add(V)) as any;
    const NH = max(dot(Nw, H), 0.05) as any;
    // Each scale's tilt breaks the sheen into glitter.
    const sparkle = mix(float(1), mellow.mul(1.1).add(0.45), fine.mul(0.85).add(0.1)) as any;
    // Sky above, garden below, and the fill from the front: what lights the side the sun is not on.
    const skyFill = mix(sky.horizon, sky.zenith, Nw.y.mul(0.5).add(0.5)) as any;
    const front = max(dot(Nw, normalize(vec3(0.23, 0.31, 0.92))), 0) as any;

    // Morpho blue: a stack of thin layers in every ridge of every scale. Face-on, electric blue; tilted, the path
    // through the layers shortens and it slides to violet, then goes dark. Bright across a wide fan of angles one way
    // (across the ridges), narrow the other.
    const tiltBy = clamp(float(1).sub(NV).add(tilt.sub(0.5).mul(0.3).mul(fine)), 0, 1) as any;
    const electric = mix(vec3(0.0, 0.2, 1.0), vec3(0.0, 0.4, 1.0), clamp(rgb.g.sub(rgb.b.mul(0.55)).mul(2.2), 0, 1)) as any;
    const hue = mix(mix(vec3(0.0, 0.5, 0.95), electric, smoothstep(0.0, 0.18, tiltBy)), vec3(0.2, 0.05, 0.8), smoothstep(0.3, 0.8, tiltBy)).mul(mix(float(1), lip.mul(0.55).add(0.45), fine)) as any;
    const T = normalize(modelWorldMatrix.mul(vec4(tObj, 0)).xyz) as any;
    const B = normalize(cross(Nw, T)) as any;
    const th = dot(T, H).div(0.2) as any;
    const bh = dot(B, H).div(0.9) as any;
    const lobe = exp(th.mul(th).add(bh.mul(bh)).div(NH.mul(NH)).negate()) as any;
    const R = Nw.mul(dot(V, Nw).mul(2)).sub(V) as any;
    const mirrored = skyAt(R).min(vec3(1.4, 1.4, 1.4)) as any;
    // (Its brightness follows the photograph only broadly: the fine grain of the blue is the scales' own.)
    const detail = clamp(mix(rgb.b, around.b, 0.75).mul(1.25).add(0.1), 0.25, 1.25) as any;
    const fade = smoothstep(0.02, 0.4, NV) as any;
    // The flash: the same narrow-one-way lobe for the light from the front, so a bright band crosses the blue as the
    // wing turns through it.
    const Hf = normalize(vec3(0.23, 0.31, 0.92).add(V)) as any;
    const NHf = max(dot(Nw, Hf), 0.05) as any;
    const tf = dot(T, Hf).div(0.16) as any;
    const bf = dot(B, Hf).div(0.75) as any;
    const flash = exp(tf.mul(tf).add(bf.mul(bf)).div(NHf.mul(NHf)).negate()).mul(front) as any;
    // The blue answers to how much light there is more than to what colour it is.
    const falls = skyFill.mul(0.55).add(sky.horizon.mul(front).mul(0.55)).add(sky.horizon.mul(flash).mul(3.2)).add(mirrored.mul(0.9)).add(sun.mul(lobe).mul(NL).mul(1.6)) as any;
    const white = dot(falls, vec3(0.3, 0.5, 0.2)) as any;
    const structural0 = hue
      .mul(mix(vec3(white, white, white), falls, 0.4).mul(1.25))
      .mul(detail)
      .mul(sparkle)
      .mul(fade)
      .mul(mask)
      .mul(grown)
      .mul(live.wet.oneMinus().pow(2)) as any;
    // However hard the flash, it stays blue: its brightness is capped below where the lens would bleach it to grey.
    const glare = dot(structural0, vec3(0.2, 0.5, 0.3)) as any;
    const structural = structural0.mul(float(1.15).div(max(glare, 1.15))) as any;

    // Pigment scales: a satin sheen along the rows, glittering scale by scale.
    const satin = sun.mul(pow(NH, 26)).mul(NL).mul(0.12).add(sky.horizon.mul(pow(max(dot(Nw, normalize(vec3(0.23, 0.31, 0.92).add(V))), 0), 18)).mul(0.07)) as any;
    // Shine by region: the garden mirrored in the glossier scales and along the raised veins, and a streak of
    // highlight lying across the scale rows that slides over the wing as it opens and closes. Pearly wings carry a
    // faint film of colour in it.
    const fres = pow(float(1).sub(NV), 5).mul(0.6).add(0.06) as any;
    const film = cos(vec3(0, 2.1, 4.2).add(NV.mul(6)).add(at.length().mul(4))).mul(0.5).add(0.5) as any;
    const pearly = mix(vec3(1, 1, 1), film.mul(0.9).add(0.35), look.pearl.mul(0.45)) as any;
    const narrow = mix(float(0.5), float(0.11), glossHere) as any;
    const streakOf = (h: any, nh: any) => exp(dot(T, h).div(narrow).pow(2).add(dot(B, h).div(0.8).pow(2)).div(nh.mul(nh)).negate()) as any;
    const streak = sun.mul(streakOf(H, NH)).mul(NL).mul(1.4).add(sky.horizon.mul(streakOf(Hf, NHf)).mul(front).mul(1.6)) as any;
    const shine = mirrored.mul(fres).mul(1.6).add(streak.mul(0.55)).mul(glossHere).mul(pearly).mul(sparkle).mul(mask.oneMinus()) as any;
    const sheen = satin.mul(black.mul(0.7).oneMinus()).mul(mask.oneMinus()).mul(sparkle).mul(live.wet.oneMinus()).mul(glossHere.mul(1.5).add(0.25)).add(shine) as any;
    // Light through the wing: a wing is a few microns of membrane and two coats of scales, and with the sun behind it
    // glows with both sides' colours at once. More so while it is still thin and wet.
    // (Through damp tissue the light is scattered every way, so the creases do not glitter: the glow is even.)
    const lit = mix(max(dot(Nw.negate(), L), 0), float(0.45), live.wet.mul(0.8)) as any;
    const forward = pow(max(dot(V, L.negate()), 0), 3).mul(0.6).add(0.55) as any;
    // (Structural blue is not a pigment: what comes through a Morpho's blue is the brown of its melanin.)
    const blueOf = (c: any) => clamp(c.b.sub(c.r.mul(1.15)).mul(3.2), 0, 1).mul(isMorpho) as any;
    const melanin = vec3(0.3, 0.15, 0.07) as any;
    const thin = mix(behind.rgb, melanin, blueOf(behind.rgb)).mul(mix(rgb, melanin, blueOf(rgb))).sqrt() as any;
    const through = thin.mul(sun).mul(lit).mul(forward).mul(live.through.mul(0.7).add(0.3).mul(live.wet.mul(0.45).oneMinus())).mul(0.9).mul(mask.mul(0.65).oneMinus())
      // A vein is thicker than the membrane: less light comes through its core, and the dip beside it is shaded too.
      // The scales lap one another: where two overlap less light comes through, row by row.
      .mul(mix(float(1), upScale.mul(0.3).add(0.82).mul(mellow.mul(0.16).add(0.92)).mul(lip.mul(0.25).add(0.75)), fine))
      // Black scales are packed with melanin: a dark margin or band lets almost nothing through, whatever is on its
      // other face.
      .mul(smoothstep(0.02, 0.16, lum).mul(0.82).add(0.18))
      // White scales scatter light back: little comes through them. And a glasswing's borders are dense and dark.
      .mul(white.mul(0.75).oneMinus())
      .mul(look.glass.mul(0.7).oneMinus())
      .mul(vein.mul(0.8).oneMinus())
      .mul(band.mul(0.45).oneMinus())
      .mul(costa.mul(0.7).oneMinus()) as any;
    // And along each rib's shoulder a thread of light: the sun grazing it from behind, the sky glancing off it from
    // the front, sliding along the vein as the wing turns.
    const Nv = relief(vein.mul(0.03).add(costa.mul(0.03)).mul(look.scale), normalize(transformNormalToView(select(upper, n0, n0.negate())))) as any;
    const Vv = normalize(positionView.negate()) as any;
    const Lv = normalize(cameraViewMatrix.mul(vec4(L, 0)).xyz) as any;
    const Fv = normalize(cameraViewMatrix.mul(vec4(0.23, 0.31, 0.92, 0)).xyz) as any;
    const shoulder = vein.mul(vein.oneMinus()).mul(4).add(costa.mul(costa.oneMinus()).mul(4)).min(1) as any;
    const grazing = pow(float(1).sub(max(dot(Nv, Vv), 0)), 3).mul(pow(max(dot(Vv, Lv.negate()), 0), 2)).mul(max(dot(Nv, Lv).add(0.3), 0)) as any;
    const glance = pow(max(dot(Nv, normalize(Fv.add(Vv))), 0), 50) as any;
    const along = pow(max(dot(Nv, normalize(Lv.add(Vv))), 0), 60) as any;
    const ribLight = sun.mul(grazing.mul(0.9).add(along.mul(0.8))).add(sky.horizon.mul(glance).mul(0.9))
      // (A thread on the lit shoulder, seen close; from farther off it would be a pale halo round every vein.)
      .mul(shoulder.mul(0.45).add(vein.mul(0.1)))
      .mul(close)
      .mul(live.wet.oneMinus()) as any;
    // The shaded side is never black: it sits in skylight.
    const fill = pigment.mul(skyFill.mul(0.4).add(sky.horizon.mul(front).mul(0.25))).mul(mask.mul(0.9).oneMinus()) as any;
    // The glasswing's white bar is thin white scales: it glows milk-white with the light behind it.
    const barGlow = vec3(0.9, 0.88, 0.82).mul(sun.mul(lit).mul(0.05).add(skyFill.mul(0.2))).mul(bar) as any;
    return structural.add(sheen).add(through).add(fill).add(ribLight).add(barGlow);
  })() as any;
  return m;
}

// The glasswing's panes: clear membrane with almost no reflection of its own (its surface is a lawn of nanopillars),
// so all that shows is a faint film of colour, the garden mirrored at grazing angles, and the sun when it lines up.
// Drawn additively over everything else; for other species it draws nothing.
export function glassMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const W = wingNodes();
  const { nObj, at, upper } = W;
  m.positionNode = W.position.mul(live.hidden.oneMinus()).mul(look.glass) as any;
  const tex = wingMap.sample(W.uv) as any;
  // Outside the wing's outline the card is not there at all: discarded, so it leaves no colour, no depth and nothing
  // in any other buffer the scene's lens reads.
  m.alphaTest = 0.5;
  m.opacityNode = smoothstep(0.06, 0.1, tex.a).mul(smoothstep(0.52, 0.5, tex.a)).mul(W.card).greaterThan(0.5).select(float(1), float(0)) as any;
  m.colorNode = Fn(() => {
    const a = tex.a as any;
    // The atlas marks a pane with a quarter alpha; between that and solid is the feathered edge of a vein or a bar.
    // (Alpha ramps from 0.25 in a pane up to 0.5 at the edge of a vein or border: the pane's sheen runs right up to it.)
    const pane = smoothstep(0.08, 0.2, a).mul(smoothstep(0.5, 0.47, a)) as any;
    const feather = smoothstep(0.44, 0.5, a).mul(0.35) as any;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const n0 = normalize(nObj) as any;
    // The membrane is never quite flat: it ripples between the veins.
    const ripple = vec3(sin(at.x.mul(31).add(at.y.mul(17))), sin(at.y.mul(29).sub(at.x.mul(13))), 0).mul(0.035) as any;
    const Nw = normalize((modelWorldMatrix as any).mul(vec4(select(upper, n0, n0.negate()).add(ripple) as any, 0)).xyz) as any;
    const NV = max(dot(Nw, V), 0) as any;
    const fres = pow(float(1).sub(NV), 3).mul(0.55).add(0.03) as any;
    const R = Nw.mul(dot(V, Nw).mul(2)).sub(V) as any;
    const sun = sky.light.mul(sky.power) as any;
    // A film a few hundred nanometres thick: its colour turns with the angle.
    const film = cos(vec3(0, 2.1, 4.2).add(NV.mul(7)).add(at.length().mul(5)))
      .mul(0.5)
      .add(0.5) as any;
    const tint = mix(vec3(1, 1, 1), film, 0.45) as any;
    const mirrored = skyAt(R).min(vec3(2.5, 2.5, 2.5)).mul(fres).mul(tint) as any;
    const glint = sun.mul(pow(max(dot(R, sky.toLight), 0), 500)).mul(0.6).add(sky.horizon.mul(pow(max(dot(R, normalize(vec3(0.23, 0.31, 0.92))), 0), 60)).mul(0.35)).mul(tint) as any;
    const veil = sky.horizon.mul(0.012).mul(tint) as any;
    const edge = tex.rgb.mul(mix(sky.horizon, sky.zenith, Nw.y.mul(0.5).add(0.5)).mul(0.6).add(sun.mul(0.1))).mul(feather) as any;
    return mirrored.add(glint).add(veil).mul(pane).add(edge);
  })() as any;
  return m;
}
