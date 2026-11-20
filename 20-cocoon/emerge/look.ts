import * as THREE from "three/webgpu";
import { Fn, cameraProjectionMatrix, dFdx, dFdy, dot, cross, float, normalize, positionView, screenSize, texture as textureNode, uniform, vec2 } from "three/tsl";
import type { Species } from "./species";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the butterfly's own shaders follow, beyond the scene's `live`: set by the rig when the species changes, so a
// change of species is only ever a change of these.
export const look = {
  // Where the hero's wing tiles lie (see WING_FRAMES).
  fore: uniform(new THREE.Vector3()),
  hind: uniform(new THREE.Vector3()),
  // Forewing length in scene units (the rig's scale), to turn pixels into body units.
  scale: uniform(1),
  // How stout and how long the body is, against the monarch's.
  girth: uniform(1),
  long: uniform(1),
  // Clear panes between the veins (the glasswing).
  glass: uniform(0),
  // Pale markings on the body: 0 none, 1 dots (monarch, glasswing), 2 streaks and a pale belly (paper kite).
  marks: uniform(0),
  // The ground colour's own cast: the species table's body and fur colours times this (a monarch and a paper kite are
  // true black, not brown), and how large the pale spots are against the monarch's.
  ink: uniform(new THREE.Color(1, 1, 1)),
  spot: uniform(1),
  mark: uniform(new THREE.Color("#f1eee6")),
  eye: uniform(new THREE.Color("#2a1f18")),
  // How shiny each kind of scale is, 0 velvet to 1 gloss: coloured scales, black scales, white scales, veins; and how
  // pearly (a faint film of colour in the shine).
  gloss: uniform(new THREE.Vector4(0.3, 0.3, 0.3, 0.6)),
  pearl: uniform(0),
  // How long the hair is, against the monarch's.
  shag: uniform(1),
  // Wings shut over the back (0 open … 1 shut): the hair between them is gathered in. And how sleeked down the coat
  // is (wet, packed in the chrysalis, or with the wings folded back along the body).
  shut: uniform(0),
  sleek: uniform(0),
  // The eye, in body space, for hair ribbons to turn to.
  view: uniform(new THREE.Vector3(0, 0, 1))
};

// (`long` scales the abdomen, 0.4 forewing lengths at 1: so 0.23 on the Morpho, 0.27 on the monarch, 0.36 on the
// slender glasswing, 0.23 on the paper kite; freshly out and full of fluid it is 18% longer. From life: a Morpho's
// body is about half its forewing length, of which head and thorax are 0.3.)
// Each species' build, by its column in the atlas: girth and length of the body, length of hair, and leg length, all
// against the monarch's (in forewing lengths, so a big-winged Morpho has the smaller body for its wings).
export const BUILD = [
  // Morpho: brown underside faintly satin, black margins velvet, white spots satin; the blue has its own flash.
  { girth: 0.84, long: 0.57, shag: 1.35, leg: 0.86, gloss: [0.22, 0.03, 0.45, 0.6], pearl: 0, ink: [0.8, 0.72, 0.68], spot: 1, marks: 3 },
  // Monarch: orange satin, black veins and borders glossier, white dots matte.
  { girth: 1, long: 0.68, shag: 0.6, leg: 1, gloss: [0.42, 0.6, 0.08, 0.8], pearl: 0, ink: [0.32, 0.33, 0.36], spot: 1.1, marks: undefined as number | undefined },
  // Glasswing: opaque borders matte; the panes are the glass pass.
  { girth: 0.8, long: 0.9, shag: 0.8, leg: 1.12, gloss: [0.12, 0.08, 0.3, 0.55], pearl: 0.3, ink: [0.7, 0.66, 0.64], spot: 0.9, marks: undefined as number | undefined },
  // Paper kite: silky, pearly white with glossy black veins.
  { girth: 0.74, long: 0.58, shag: 0.75, leg: 0.9, gloss: [0.62, 0.75, 0.62, 0.9], pearl: 1, ink: [0.3, 0.31, 0.34], spot: 1.3, marks: undefined as number | undefined }
];

// The hero's wings: a texture of its own for each species (four tiles, 2048 px each: forewing upper and under, hindwing
// upper and under), far finer than the shared atlas the distant butterflies use. Only the species on show and the one
// asked for next are kept; the rest are let go.
const WING_FILES = ["morpho", "monarch", "glasswing", "paperkite"];
// Where each tile lies in wing space (top-left corner and side, forewing lengths), as cut for these textures.
const WING_FRAMES = [
  { fore: [-0.0025, 0.7645, 0.7811], hind: [-0.0025, 0.0626, 0.7811] },
  { fore: [-0.0016, 0.7164, 0.8521], hind: [-0.0016, 0.1474, 0.8521] },
  { fore: [-0.0112, 0.7489, 0.9348], hind: [-0.0037, 0.3099, 0.9348] },
  { fore: [-0.0021, 0.7347, 0.9003], hind: [-0.0021, 0.1752, 0.9003] }
];
// Each is decoded and reduced to its whole mip chain off the main thread, then copied to a GPU texture of our own a
// strip at a time, a few megabytes a frame, smallest levels first: no frame ever carries the whole 64 MB upload, and
// the GPU never has to build the mips. Only when the last strip is in does a wing show it.
/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU's own types are not in this project's lib. */
type Gpu = any;
type Piece = { image: ImageBitmap; level: number; y: number };
type Decoded = { pieces: Piece[] | null; size: number; mips: number };
type WingSlot = { size: number; mips: number; levels: Piece[] | null; gpu: Gpu | null; texture: THREE.Texture | null; level: number; row: number; done: boolean; asked: boolean };
const slots: WingSlot[] = [0, 1, 2, 3].map(() => ({ size: 0, mips: 0, levels: null, gpu: null, texture: null, level: -1, row: 0, done: false, asked: false }));
// The fetching, decoding and reducing to mips all happen in a worker, so none of it (resizing a 4096² image is tens of
// milliseconds a level) lands on a frame; the finished bitmaps are handed over, not copied.
const WORKER = `
self.onmessage = async (e) => {
  const { id, url, top } = e.data;
  try {
    const blob = await (await fetch(url)).blob();
    const opts = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
    // (Bitmaps live on the GPU, so resizing and cutting them competes with the frame being drawn: a breath between
    // each piece of that work keeps any one frame from carrying much of it.)
    const breathe = () => new Promise((r) => setTimeout(r, 12));
    let full = await createImageBitmap(blob, { imageOrientation: "flipY", ...opts });
    // (A smaller top level where the full one would not be seen: low tier, phones.)
    if (top && top < full.width) {
      const less = await createImageBitmap(full, { resizeWidth: top, resizeHeight: top, resizeQuality: "high", ...opts });
      full.close();
      full = less;
    }
    const levels = [full];
    for (let size = levels[0].width >> 1; size >= 1; size >>= 1)
      { await breathe(); levels.push(await createImageBitmap(levels[levels.length - 1], { resizeWidth: size, resizeHeight: size, resizeQuality: "high", ...opts })); }
    // Each level goes over as strips of about 2 MB, each a bitmap of its own: the first copy out of a big bitmap makes
    // the browser move the whole of it to the GPU in one go, so no bitmap is ever big.
    const pieces = [];
    const size = levels[0].width;
    for (let level = levels.length - 1; level >= 0; level--) {
      const image = levels[level];
      const rows = Math.max(1, Math.floor(2e6 / (image.width * 4)));
      if (rows >= image.height) pieces.push({ image, level, y: 0 });
      else {
        for (let y = 0; y < image.height; y += rows) { await breathe(); pieces.push({ image: await createImageBitmap(image, 0, y, image.width, Math.min(rows, image.height - y), opts), level, y }); }
        image.close();
      }
    }
    self.postMessage({ id, pieces, size, mips: levels.length }, pieces.map((p) => p.image));
  } catch (error) {
    self.postMessage({ id, pieces: null });
  }
};`;
// The side of the largest level kept: 4096 as cut, or 2048 where set (before a species' wings are first asked for).
export const wingDetail = { top: 4096 };
let worker: Worker | null = null;
const waiting = new Map<number, (decoded: Decoded) => void>();
let asks = 0;
function decode(url: string) {
  return new Promise<Decoded>((resolve) => {
    if (!worker) {
      worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
      worker.onmessage = (e: MessageEvent<Decoded & { id: number }>) => {
        waiting.get(e.data.id)?.(e.data);
        waiting.delete(e.data.id);
      };
    }
    const id = ++asks;
    waiting.set(id, resolve);
    worker.postMessage({ id, url, top: wingDetail.top });
  });
}
function ask(column: number) {
  const slot = slots[column];
  if (slot.asked || typeof createImageBitmap === "undefined" || typeof Worker === "undefined") return;
  slot.asked = true;
  void decode(new URL(`/assets/20-cocoon/wings-${WING_FILES[column]}.webp`, location.href).href).then((levels) => {
    if (!levels.pieces) return;
    if (slot.asked && !slot.levels) {
      slot.levels = levels.pieces;
      slot.size = levels.size;
      slot.mips = levels.mips;
    } else levels.pieces.forEach((l) => l.image.close());
  });
}
function release(column: number) {
  const slot = slots[column];
  slot.gpu?.destroy();
  slot.texture?.dispose();
  slot.levels?.forEach((l) => l.image.close());
  Object.assign(slot, { size: 0, mips: 0, levels: null, gpu: null, texture: null, level: -1, row: 0, done: false, asked: false });
}
const blank = new THREE.Texture();
export const wingMap = textureNode(blank);
const wings = { now: -1, next: -1 };
// Bytes copied to the GPU in one frame, at most (a strip of the largest level is 4 MB).
const BUDGET = 3e6;
const spentPieces: ImageBitmap[] = [];
const stale: ImageBitmap[] = [];
// When the next species' wings may be copied: the scene says, so that it is done behind the loader or while nothing is
// on show but a chrysalis falling or growing, never mid-emergence. (The species on show is never held back.)
export const wingPace = { next: true };
// Called once a frame with the renderer: carries on whatever copying is under way. `all` finishes it at once (behind
// the loader, or when a species has to be shown before its wings were sent ahead).
// Dev: what the copying has cost on the main thread (ms): making the texture, the worst single frame of copying and
// which mip level that was, and the worst frame that made the three.js texture.
export const wingCost = { create: 0, copy: 0, level: -1, wrap: 0, frames: 0 };
export function wingUpload(renderer: unknown, all = false) {
  const device = (renderer as { backend?: { device?: Gpu } }).backend?.device;
  if (!device) return;
  // (Bitmaps copied on an earlier frame are let go now; never on the frame of the copy itself.)
  for (const image of stale.splice(0)) image.close();
  stale.push(...spentPieces.splice(0));
  let spent = 0;
  for (const column of [wings.now, wings.next]) {
    const slot = column >= 0 ? slots[column] : null;
    if (!slot || slot.done || !slot.levels) continue;
    if (column !== wings.now && !wingPace.next) continue;
    const levels = slot.levels;
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const levelWas = slot.level;
    if (!slot.gpu) {
      // (Making the texture is a frame's work of its own: nothing is copied on that frame.)
      spent = BUDGET;
      // (Usage: texture binding, copy destination, render attachment.)
      slot.gpu = device.createTexture({ size: [slot.size, slot.size], mipLevelCount: slot.mips, format: "rgba8unorm-srgb", usage: 0x04 | 0x02 | 0x10 });
      slot.level = 0;
      slot.row = 0;
      wingCost.create = Math.max(wingCost.create, performance.now() - t0);
    }
    const t1 = typeof performance !== "undefined" ? performance.now() : 0;
    // (slot.level counts the pieces copied so far.)
    while (slot.level < levels.length && (all || spent < BUDGET)) {
      const piece = levels[slot.level++];
      device.queue.copyExternalImageToTexture({ source: piece.image }, { texture: slot.gpu, mipLevel: piece.level, origin: [0, piece.y], colorSpace: "srgb", premultipliedAlpha: false }, [piece.image.width, piece.image.height]);
      spent += piece.image.width * piece.image.height * 4;
      spentPieces.push(piece.image);
    }
    if (spent > 0 && performance.now() - t1 > wingCost.copy) {
      wingCost.copy = performance.now() - t1;
      wingCost.level = levelWas;
    }
    wingCost.frames++;
    if (slot.level >= levels.length) {
      const texture = new THREE.ExternalTexture(slot.gpu as unknown as WebGLTexture);
      (texture as { image: unknown }).image = { width: slot.size, height: slot.size };
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 16;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.flipY = false;
      texture.needsUpdate = true;
      slot.texture = texture;
      slot.done = true;
      slot.levels = [];
    }
  }
  const mine = wings.now >= 0 ? slots[wings.now] : null;
  if (mine?.done && mine.texture && wingMap.value !== mine.texture) wingMap.value = mine.texture;
}
// True while the species on show is still waiting for its wings (they are drawn nowhere until then).
export const wingsWaiting = () => wings.now >= 0 && !slots[wings.now].done;
// Fetch and decode a species' wings ahead of showing it (while the next chrysalis grows or idles); the copying to
// the GPU then trickles in over the following frames.
export function preloadWings(sp: Species) {
  wings.next = sp.column;
  ask(sp.column);
  for (let c = 0; c < 4; c++) if (c !== wings.now && c !== wings.next && slots[c].asked) release(c);
}

export function setLook(sp: Species) {
  wings.now = sp.column;
  ask(sp.column);
  if (slots[sp.column].done && slots[sp.column].texture) wingMap.value = slots[sp.column].texture as THREE.Texture;
  const frames = WING_FRAMES[sp.column] ?? WING_FRAMES[0];
  look.fore.value.set(frames.fore[0], frames.fore[1], frames.fore[2]);
  look.hind.value.set(frames.hind[0], frames.hind[1], frames.hind[2]);
  const b = BUILD[sp.column] ?? BUILD[1];
  look.scale.value = sp.wing;
  look.girth.value = b.girth;
  look.long.value = b.long;
  look.shag.value = b.shag;
  look.gloss.value.set(b.gloss[0], b.gloss[1], b.gloss[2], b.gloss[3]);
  look.pearl.value = b.pearl;
  look.glass.value = sp.glass;
  look.marks.value = b.marks ?? sp.marks;
  look.ink.value.setRGB(b.ink[0], b.ink[1], b.ink[2]);
  look.spot.value = b.spot;
  look.mark.value.set(sp.mark);
  look.eye.value.set(sp.eye);
}

// The size of a pixel at a point in view space, in scene units.
export const pixelAt = Fn(([viewZ]: [any]) => (viewZ as any).abs().mul(2).div((cameraProjectionMatrix as any).element(1).element(1).mul(screenSize.y))) as any;

// A height field's relief, from its screen derivatives (Mikkelsen): the view normal bent by the slope of `height`
// (scene units).
export const relief = Fn(([height, normal]: [any, any]) => {
  const sx = dFdx(positionView) as any;
  const sy = dFdy(positionView) as any;
  const dh = vec2(dFdx(height), dFdy(height)) as any;
  const r1 = cross(sy, normal) as any;
  const r2 = cross(normal, sx) as any;
  const det = dot(sx, r1) as any;
  const grad = det.sign().mul(dh.x.mul(r1).add(dh.y.mul(r2))) as any;
  return normalize(det.abs().mul(normal).sub(grad).add(normal.mul(float(1e-9))));
}) as any;
