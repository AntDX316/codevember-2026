// What the hub is drawn with. At `worldAmount` 0 every material gives exactly the page's colours: no lighting, no tone
// mapping, sRGB out. As it rises to 1 the page becomes a place: a polished floor under a night sky, a ring of portals with
// light spilling from each, motes drifting in the air, and the distance fading into the dark.

import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import {
  abs,
  atan,
  cameraPosition,
  cos,
  distance,
  exp,
  float,
  floor as floorOf,
  fract,
  fwidth,
  hash,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  mod,
  mx_noise_float,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";

export const BG = new THREE.Color("#08090c");
const INK = new THREE.Color("#f2efe9");
const ACCENT = new THREE.Color("#ffb48a");

// How far the page has become a world, 0 to 1, for every material at once.
export const worldAmount = uniform(0);

// The ring of portals: its middle on the floor, its radius, how many stand round it, and the angle of the first, measured
// from straight ahead (-z) towards +x.
export const RING = { radius: 13, count: 30 };
export const ringCentre = uniform(new THREE.Vector3());
export const ringStart = uniform(0);

// Each portal's light, for the floor: its colour in rgb and how bright in a. One texel a day.
export const portalLight = new THREE.DataTexture(new Float32Array(32 * 4), 32, 1, THREE.RGBAFormat, THREE.FloatType);
portalLight.magFilter = THREE.NearestFilter;
portalLight.minFilter = THREE.NearestFilter;

// A colour as the page writes it, in sRGB, for mixing the way a browser does.
const css = (colour: THREE.Color): Node<"vec3"> => {
  const { r, g, b } = colour.clone().convertLinearToSRGB();
  return vec3(r, g, b);
};
const linear = (colour: THREE.Color): Node<"vec3"> => vec3(colour.r, colour.g, colour.b);

// Between sRGB and linear light, typed as the colours they are.
const toLinear = (colour: Node<"vec3">) => sRGBTransferEOTF(colour) as unknown as Node<"vec3">;
const toCss = (colour: Node<"vec3">) => sRGBTransferOETF(colour) as unknown as Node<"vec3">;

// The far distance fades into the background, but only once the page is a world.
function fog(colour: Node<"vec3">, near = 14, far = 70) {
  const amount = smoothstep(near, far, distance(positionWorld, cameraPosition)).mul(worldAmount);
  return mix(colour, linear(BG), amount);
}

const flat = (material: THREE.MeshBasicNodeMaterial) => {
  material.transparent = true;
  material.toneMapped = false;
  material.side = THREE.DoubleSide;
  return material;
};

// A card: .cv-card's 10px rounded corners and 1px border, its poster cropped to cover and zoomed on hover, the gradient up
// from the bottom, and its words over the top. In the world it is a portal: a window onto the place itself, set back
// behind the frame so that it shifts as you move. Opening, under the pointer or walked up to, it brightens, sinks a little
// deeper, and light gathers round the inside of its frame.
export function cardMaterial(words: THREE.Texture, poster: THREE.Texture | null, open: boolean, today: boolean, tintColour: THREE.Color) {
  const u = {
    size: uniform(new THREE.Vector2(150, 187.5)),
    // Where the eye is in the card's own frame, in metres, and the card's size in metres: for the depth behind a portal.
    eye: uniform(new THREE.Vector3(0, 0, 10)),
    metres: uniform(new THREE.Vector2(1.5, 1.875)),
    lift: uniform(0),
    zoom: uniform(0),
    opacity: uniform(1),
    // How far open the portal is, and how far its picture is set back (none while arriving from its day, so that it
    // matches the day's last frame).
    open: uniform(0),
    depth: uniform(1)
  };
  const wordsNode = texture(words);
  const material = flat(new THREE.MeshBasicNodeMaterial());
  const world = worldAmount;

  const radius = float(10);
  const p = uv().mul(u.size);
  const half = u.size.mul(0.5);
  const q = abs(p.sub(half)).sub(half).add(radius);
  const edge = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(radius);
  // Its edges smoothed over a pixel of the screen, as the browser smooths a box's.
  const soft = max(fwidth(edge), 0.0001);
  const inside = float(0.5).sub(edge.div(soft)).clamp(0, 1);

  // Mixed in sRGB, as the browser mixes the page, and only then taken back to linear for the renderer.
  const bg = css(BG);
  const tint = css(tintColour);
  // How far in from the frame, in CSS pixels of the card: for the shadow the frame casts in, and the light round it.
  const inward = edge.negate();

  let colour: Node<"vec3"> = bg;
  if (poster) {
    const image = poster.image as { width: number; height: number };
    const imageAspect = float(image.width / image.height);
    const aspect = u.size.x.div(u.size.y);
    const cover = vec2(min(aspect.div(imageAspect), 1), min(imageAspect.div(aspect), 1));
    // The point on a picture set back `depth` behind the card that the eye sees through this point of the card.
    const setBack = world.mul(u.depth).mul(u.open.mul(0.35).add(1));
    const depth = setBack.mul(0.55);
    const eye = u.eye;
    const onCard = uv().sub(0.5).mul(u.metres);
    const ez = max(eye.z, 0.05);
    const behind = eye.xy.add(onCard.sub(eye.xy).mul(ez.add(depth).div(ez)));
    const seen = behind.div(u.metres);
    // Further in, the picture is a little larger than its window, so that looking in at a slant seldom reaches its edge,
    // and only by a sliver, under the frame's shadow.
    const scale = u.zoom.mul(0.04).add(1).add(setBack.mul(0.22));
    const clear = toCss(texture(poster, seen.mul(cover).div(scale).add(0.5)).rgb);

    // In the world, a little dim at rest and full bright open, with the frame's shadow falling in round the edge.
    const lit = open ? u.open.mul(0.22).add(0.78) : float(0.55);
    const shadow = float(1).sub(exp(inward.div(u.size.y.mul(0.06)).negate()).mul(0.55));
    colour = mix(clear, clear.mul(lit).mul(shadow), world);
    // linear-gradient(to top, rgba(8, 9, 12, 0.72), transparent 45%), softer in the world.
    const shade = float(1).sub(min(uv().y.div(0.45), 1)).mul(0.72).mul(float(1).sub(world.mul(0.5)));
    colour = mix(colour, bg, shade);
    // Opening: light gathering round the inside of the frame, in the portal's colour.
    const rim = exp(inward.div(u.size.y.mul(0.05)).negate()).mul(u.open).mul(world);
    colour = colour.add(mix(tint, css(ACCENT), 0.4).mul(rim).mul(0.9));
  } else colour = mix(bg, mix(bg, tint.mul(0.5), 0.25), world);

  colour = mix(colour, wordsNode.rgb, wordsNode.a.mul(float(1).sub(u.open.mul(world).mul(0.85))));

  // The border: .cv-line on a closed card, .cv-faint on an open one, .cv-dim under the pointer, the accent today. As a
  // portal it widens into a frame lit in the portal's colour, brighter as it opens.
  const ink = css(INK);
  const accent = css(ACCENT);
  const width = world.mul(5).add(1);
  const ring = float(0.5).add(edge.add(width).div(soft)).clamp(0, 1);
  const borderAlpha = today ? float(1) : open ? mix(float(0.22), float(0.62), u.lift) : float(0.12);
  const pageBorder = mix(bg, today ? accent : ink, borderAlpha);
  const frame = mix(mix(ink, tint, 0.55).mul(open ? 0.55 : 0.25), mix(tint, accent, 0.3), u.open.mul(0.9));
  colour = mix(colour, mix(pageBorder, frame, world), ring);

  material.colorNode = vec4(fog(toLinear(colour)), 1);
  material.opacityNode = inside.mul(u.opacity);
  return { material, uniforms: u };
}

export type CardUniforms = ReturnType<typeof cardMaterial>["uniforms"];

// Page text: ink at an opacity, from a texture of the words. The GPU blends in linear light, which changes how thick light
// text looks; the browser blends in sRGB. So the coverage is bent to give, over what is behind the words, the colour the
// browser would: the page's own dark, or `over`, the colour (in linear light) of the sky seen along a direction.
export function textMaterial(words: THREE.Texture, over?: (d: Node<"vec3">) => Node<"vec3">) {
  const opacity = uniform(1);
  const wordsNode = texture(words);
  const material = flat(new THREE.MeshBasicNodeMaterial());
  const ink = wordsNode.rgb;
  const coverage = wordsNode.a.mul(opacity);
  const bg = over ? toCss(over(normalize(positionWorld.sub(cameraPosition)) as unknown as Node<"vec3">)) : css(BG);
  const wanted = toLinear(mix(bg, ink, coverage)).g;
  const under = toLinear(bg).g;
  const lit = toLinear(ink);
  material.colorNode = vec4(fog(lit), 1);
  material.opacityNode = wanted.sub(under).div(max(lit.g.sub(under), 0.001)).clamp(0, 1);
  return { material, opacity };
}

// The floor the page lies on. Flat, it is the page's background. As a world it is polished dark stone, engraved like a
// dial: rings round the portals and a tick between each pair, a pool of each portal's light before it, and the portals
// themselves, mirrored, under a glaze that reflects more the lower you look across it.
export function floorMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  material.transparent = true;
  const rel = positionWorld.xz.sub(ringCentre.xz);
  const out = length(rel);
  const angle = atan(rel.x, rel.y.negate());
  const step = (Math.PI * 2) / RING.count;
  const slots = angle.sub(ringStart).div(step);
  const R = float(RING.radius);
  const thin = (d: Node<"float">, w: number) => float(1).sub(smoothstep(0, max(fwidth(d), 0.0001).mul(1.2).add(w), abs(d)));

  // The engraving: three rings, a tick between each pair of portals in the outer band, faint spokes inside.
  const between = fract(slots).sub(0.5).mul(out).mul(step);
  const band = smoothstep(R.add(0.25), R.add(0.4), out).mul(float(1).sub(smoothstep(R.add(1.4), R.add(1.55), out)));
  const inner = smoothstep(5.4, 6, out).mul(float(1).sub(smoothstep(R.sub(1.8), R.sub(1.5), out)));
  const lines = thin(out.sub(R.add(0.9)), 0.01)
    .add(thin(out.sub(R.sub(1.6)), 0.006))
    .add(thin(out.sub(5.2), 0.01))
    .add(thin(between, 0.008).mul(band))
    .add(thin(between, 0.004).mul(inner).mul(0.35))
    .min(1);
  // A slow wave of light round the inner ring.
  const sweep = sin(angle.mul(3).sub(time.mul(0.25))).mul(0.5).add(0.5).pow(6);
  const glowRing = exp(out.sub(5.2).div(0.25).pow(2).negate()).mul(sweep);

  // Each portal's pool of light, laid on the floor before it, and a line of it along its foot.
  const index = mod(floorOf(slots.add(0.5)), RING.count);
  const light = texture(portalLight, vec2(index.add(0.5).div(32), 0.5));
  const facing = index.mul(step).add(ringStart);
  const spot = vec2(sin(facing), cos(facing).negate()).mul(R.sub(1.1));
  const pool = exp(distance(rel, spot).div(1.6).pow(2).negate()).mul(light.a);
  const foot = exp(out.sub(R).div(0.12).pow(2).negate()).mul(exp(fract(slots.add(0.5)).sub(0.5).div(0.16).pow(2).negate())).mul(light.a);

  const stone = vec3(0.004, 0.0045, 0.006);
  const lit = stone
    .add(linear(INK).mul(lines).mul(0.028))
    .add(linear(ACCENT).mul(glowRing).mul(0.05))
    .add(light.rgb.mul(pool.mul(0.3).add(foot.mul(0.45))));
  const colour = mix(linear(BG), lit, worldAmount);

  // Looking across the floor it reflects more, looking down at it less.
  const view = normalize(cameraPosition.sub(positionWorld));
  const glaze = float(1).sub(abs(view.y)).pow(3).mul(0.55).add(0.18);
  material.colorNode = vec4(fog(colour, 18, 80), 1);
  material.opacityNode = float(1).sub(glaze.mul(worldAmount));
  return material;
}

// The sky, round everything, once the page is a world: night with a warm glow low down, hills against it, stars, and
// slow curtains of aurora. Below the hills, the dark the floor's reflections lie on.
export function skyMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  material.side = THREE.BackSide;
  material.depthWrite = false;
  const dir = normalize(positionWorld.sub(cameraPosition));
  const angle = atan(dir.x, dir.z.negate());
  const up = dir.y;

  const zenith = vec3(0.0015, 0.0018, 0.004);
  const horizon = vec3(0.022, 0.013, 0.016);
  let sky: Node<"vec3"> = mix(horizon, zenith, smoothstep(-0.02, 0.45, up));
  sky = sky.add(linear(ACCENT).mul(exp(up.div(0.06).pow(2).negate()).mul(0.035)));

  // Stars: one chance in a cell of the sky, twinkling, gone towards the hills.
  const cells = vec2(angle.mul(90), up.mul(140));
  const cell = floorOf(cells);
  const seed = hash(cell.x.add(cell.y.mul(317)));
  const offset = vec2(hash(cell.x.mul(7).add(cell.y)), hash(cell.y.mul(13).add(cell.x)));
  const toStar = length(fract(cells).sub(offset.mul(0.6).add(0.2)));
  const twinkle = sin(time.mul(seed.mul(3).add(1)).add(seed.mul(40))).mul(0.35).add(0.65);
  const star = smoothstep(0.985, 1, seed).mul(exp(toStar.div(0.07).pow(2).negate())).mul(twinkle).mul(smoothstep(0.06, 0.25, up));
  sky = sky.add(vec3(0.9, 0.92, 1).mul(star).mul(0.8));

  // Aurora: two wavering curtains, green into violet, drifting.
  const curtain = (height: number, speed: number, low: THREE.Color, high: THREE.Color) => {
    const centre = float(height).add(sin(angle.mul(2).add(time.mul(speed))).mul(0.05)).add(sin(angle.mul(5.3).sub(time.mul(speed * 1.7))).mul(0.025));
    const sheet = exp(up.sub(centre).div(0.07).pow(2).negate());
    const rays = mx_noise_float(vec3(angle.mul(14), up.mul(3), time.mul(0.08))).mul(0.5).add(0.5);
    const tint = mix(linear(low), linear(high), smoothstep(centre.sub(0.05), centre.add(0.1), up));
    return tint.mul(sheet.mul(rays).mul(0.06));
  };
  sky = sky.add(curtain(0.3, 0.05, new THREE.Color("#2fe0a0"), new THREE.Color("#7a4cff")));
  sky = sky.add(curtain(0.42, -0.035, new THREE.Color("#3fb8ff"), new THREE.Color("#ff6ad5")).mul(0.6));

  // Hills round the horizon, darker than the sky behind them.
  const ridge = mx_noise_float(vec3(angle.mul(1.6), 0, 3)).mul(0.035).add(mx_noise_float(vec3(angle.mul(6), 1, 7)).mul(0.012)).add(0.03);
  const hills = smoothstep(ridge.add(0.002), ridge.sub(0.002), up);
  sky = mix(sky, vec3(0.0025, 0.0024, 0.0032), hills);

  material.colorNode = vec4(mix(linear(BG), sky, worldAmount), 1);
  return material;
}

// Motes drifting in the air round the ring, warm and a few cool, each a soft dot of light that twinkles.
export function motes(count: number) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = Math.random() * Math.PI * 2;
    seeds[i * 4 + 1] = Math.sqrt(Math.random()) * (RING.radius + 8);
    seeds[i * 4 + 2] = 0.2 + Math.random() * Math.random() * 7;
    seeds[i * 4 + 3] = Math.random();
  }
  const seed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(seeds, 4)) as unknown as Node<"vec4">;
  const material = new THREE.SpriteNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  const angle = seed.x.add(time.mul(seed.w.sub(0.5).mul(0.06)));
  const height = seed.z.add(sin(time.mul(0.4).add(seed.w.mul(30))).mul(0.35));
  material.positionNode = vec3(sin(angle).mul(seed.y), height, cos(angle).mul(seed.y).negate()).add(ringCentre);
  material.scaleNode = seed.w.mul(0.04).add(0.03);
  const glow = exp(length(uv().sub(0.5)).div(0.18).pow(2).negate());
  const twinkle = sin(time.mul(seed.w.mul(2).add(0.7)).add(seed.w.mul(50))).mul(0.5).add(0.5);
  material.colorNode = vec4(mix(linear(ACCENT), vec3(0.35, 0.75, 1), smoothstep(0.75, 0.8, seed.w)).mul(1.4), 1);
  material.opacityNode = glow.mul(twinkle.mul(0.7).add(0.3)).mul(worldAmount);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// A sheet held just in front of the eye, for diving into a portal: the page's background, at `amount`.
export function veilMaterial() {
  const amount = uniform(0);
  const material = flat(new THREE.MeshBasicNodeMaterial());
  material.depthTest = false;
  material.depthWrite = false;
  material.colorNode = vec4(BG.r, BG.g, BG.b, 1);
  material.opacityNode = amount;
  return { material, amount };
}
