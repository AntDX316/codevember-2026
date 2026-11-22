"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, color, dot, exp, float, length, max, min, mix, normalView, normalize, positionLocal, positionViewDirection, pow, sin, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { useDispose } from "@/shared/engine/dispose";
import { lightHub } from "../budget";
import { loadPosters, releasePosters } from "../hub/pictures";
import { sound } from "@/shared/engine/sound";
import type { DayDefinition } from "@/shared/engine/types";
import TYPE from "./codevember-type.json";
import { CameraDrift, Lights, SPACE_LOOK, Sky, unfold, useSpace, useSpaceDays, type Palette, type SpaceDay } from "./kit";
import { LINKS, markGeometry, SolidButtons } from "./buttons";
import { Countdown, Floor, Motes } from "./setting";
import { cardMove, useTransition, type TilePose } from "./transitions";
import { onSheet, sheetOf, Unfold, usePageLayout, type Landing } from "./unfold";
import { PLATE_ROOM, RAISE, type PageLayout } from "../hub/layout";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The month as an actual calendar: each day a thick ceramic tile floating over a dark plate. Become in place from the page,
// the tiles stand where the page's cards are, under the page's title, now type; flown to from the page, November 2026 is
// laid out in weeks, Sunday first, under the weekdays, with links to where Adam is on its top right. An open day's tile is a portal: through its window the day's world lies well back, and shifts against
// the frame as the eye moves round it; a day still to come is frosted, with its numeral glowing softly through. Pointed at, a tile rises out of the grid on a spring, tips toward the
// pointer, catches a sweep of light, and sends a ripple out through its neighbours.

// Black above, through grey, to a pale grey below: the page's own dark, lit from beneath.
const PALETTE: Palette = {
  top: "#020203",
  horizon: "#3a3a3f",
  bottom: "#a3a3a8",
  glow: "#47474e",
  toLight: [0.35, 0.22, -1],
  blots: ["#3e3e44", "#2c2c31", "#46464d", "#35353a"],
  bokeh: ["#ffffff", "#f3efe8", "#d9dce4", "#e8e4dc"],
  spread: 2.6
};

// Held here, not written inline: a new array each render would rebuild the lights.
const BOKEH_SIZE: [number, number] = [0.04, 0.26];

// No glow, no darkened corners, no grain, no shading in the creases: the title, the buttons and the tiles stay as clean as
// on the page, and the page becomes the calendar with nothing switching on. Only the lens's blur comes in, slowly.
const LOOK = { ...SPACE_LOOK, bloom: 0, vignette: 0, grain: 0, ao: 0 };

// A tile, in metres: as tall as a poster is for its width, and a gap between tiles.
const TILE = { w: 1, h: 1.25, d: 0.3, radius: 0.08 };
const GAP = 0.14;
// November 1, 2026 is a Sunday, so day n sits in column (n - 1) % 7 of week floor((n - 1) / 7).
const FIRST_COLUMN = 0;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GRID = { w: 7 * TILE.w + 6 * GAP, h: 5 * TILE.h + 4 * GAP };
// The face of a tile: its front, inset from the rounding. A band across the top holds the date; the rest is the window.
const FACE = { w: TILE.w - 0.03, h: TILE.h - 0.03, corner: 0.065 };
const BAND = 0.27;
const MARGIN = 0.05;
const WINDOW = { w: FACE.w - MARGIN * 2, h: FACE.h - BAND - MARGIN, y: (MARGIN - BAND) / 2 };
// How far back through its window a day's world lies, and how much further when pointed at; and how much bigger than the
// window the poster is drawn there, so that looking in at an angle still finds picture rather than its edge.
const SET_BACK = 0.62;
const SET_BACK_HOVER = 0.28;
const BEYOND = 1.65;
// The most the view can slide in the window, in metres, however steeply it is looked into: short of the poster's edge.
const SLIDE = 0.3;
// Pointed at: how far the tile rises, how far it tips toward the pointer, and the spring it rises on.
const RISE = 0.45;
const TIP = 0.22;
const SPRING = { stiffness: 120, damping: 9.5 };
// The ripple through the grid: how high, how fast it travels in tiles a second, how quickly each bob dies away, and how
// far the neighbours sink back to give the risen tile room.
const RIPPLE = { height: 0.26, speed: 6, decay: 2.8, reach: 0.3 };
const MAKE_WAY = 0.07;
// Which way the month hangs, and its idle drift.
const HANG = { x: -0.08, y: -0.1 };
const REST = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(HANG.x, HANG.y, 0));
const INK = "#2a2758";
// The weekdays and the days past the month's end, pale on the dark plate.
const PALE = "#ece9f2";
const TODAY = new THREE.Color("#ffb85c");
// The colour a day still to come glows in, having no poster to take one from.
const UNOPENED = new THREE.Color("#8f7dff");

async function loadFonts() {
  const style = getComputedStyle(document.documentElement);
  const display = style.getPropertyValue("--font-display").trim() || "Arial, sans-serif";
  const body = style.getPropertyValue("--font-body").trim() || "Arial, sans-serif";
  // A font that will not load (blocked, or the connection dropped) is drawn in the fallback rather than ending the visit.
  await Promise.all([document.fonts.load(`800 100px ${display}`, "November 2026"), document.fonts.load(`500 20px ${body}`, "SUN MON")]).catch(() => {});
  return { display, body };
}
type Fonts = Awaited<ReturnType<typeof loadFonts>>;

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

// Only how much ink there is at each point, the drawing's alpha, in one channel: a quarter of the memory of the full colour
// picture (thirty tiles' words came to 79 MB on the GPU with their smaller copies), read the same. The canvas it was drawn
// on is let go at once rather than kept beside the texture. Upside down from the canvas, as the GPU reads a picture.
function inkTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const ink = new Uint8Array(width * height);
  if (ctx) {
    draw(ctx);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y++) {
      const from = y * width * 4;
      const to = (height - 1 - y) * width;
      for (let x = 0; x < width; x++) ink[to + x] = rgba[from + x * 4 + 3];
    }
  }
  canvas.width = canvas.height = 0;
  const map = new THREE.DataTexture(ink, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.needsUpdate = true;
  return map;
}

// What is written on a tile, as ink on a clear ground: the date across the top band, and for a day still to come, its
// numeral large in the middle, soft, as if seen through frosted glass. On a light hub (budget.ts) at 448 across rather than
// 640: a tile on a phone's screen is a few dozen pixels across.
function faceText(day: SpaceDay, fonts: Fonts) {
  const W = lightHub() ? 448 : 640;
  const H = Math.round((W * FACE.h) / FACE.w);
  const px = W / FACE.w;
  return inkTexture(W, H, (ctx) => {
    const band = BAND * px;
    const inset = MARGIN * px * 1.2;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.round(band * 0.72)}px ${fonts.display}`;
    ctx.letterSpacing = `${-Math.round(band * 0.02)}px`;
    ctx.fillText(String(day.number), inset, band * 0.56);
    const numeral = ctx.measureText(String(day.number)).width;
    // The word as large as fits beside the date.
    const room = W - inset * 2 - numeral - band * 0.25;
    let size = Math.round(band * 0.4);
    ctx.textAlign = "right";
    ctx.letterSpacing = `${Math.round(band * 0.02)}px`;
    ctx.font = `700 ${size}px ${fonts.body}`;
    const wide = ctx.measureText(day.day.word.toUpperCase()).width;
    if (wide > room) size = Math.floor((size * room) / wide);
    ctx.font = `700 ${size}px ${fonts.body}`;
    ctx.globalAlpha = 0.78;
    ctx.fillText(day.day.word.toUpperCase(), W - inset, band * 0.58);
    ctx.globalAlpha = 1;
    if (!(day.open && day.poster)) {
      ctx.textAlign = "center";
      ctx.letterSpacing = "0px";
      ctx.font = `800 ${Math.round(H * 0.42)}px ${fonts.display}`;
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = (40 * W) / 640;
      ctx.globalAlpha = 0.55;
      ctx.fillText(String(day.number), W / 2, H * 0.6);
    }
  });
}

// The weekdays over the columns, and the month over them.
function headerText(fonts: Fonts) {
  const W = 1600;
  const H = Math.round((W * 0.42) / GRID.w);
  return canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(H * 0.42)}px ${fonts.body}`;
    ctx.letterSpacing = `${Math.round(H * 0.08)}px`;
    WEEKDAYS.forEach((name, column) => ctx.fillText(name.toUpperCase(), ((column * (TILE.w + GAP) + TILE.w / 2) / GRID.w) * W, H / 2));
  });
}
// The name over the month, cut from the site's own display face (Darker Grotesque, ExtraBold, only the letters it needs) as
// real type with depth, so it stays crisp at any distance and catches the light along its sides. Set as the page sets it,
// 0.04 of its size tighter than the face's own spacing, and measured in its size: its depth, and as a flight, its size in
// metres and the room it leaves for the badges.
const TITLE = { depth: 0.09, size: 1.5, room: 2.7 };
const SPACED = new FontLoader().parse({
  ...TYPE,
  glyphs: Object.fromEntries(Object.entries(TYPE.glyphs).map(([letter, glyph]) => [letter, { ...glyph, ha: glyph.ha - 0.04 * TYPE.resolution }]))
} as any);
// Grown with a little overshoot, 0 to 1.
const overshoot = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2));
// Where Adam is, as badges on the slab's top right: each a small ceramic tile like the days, with the mark standing out of it.
const BADGE = { size: 0.62, depth: 0.16, mark: 0.36, gap: 0.16, rise: 0.3 };
// Pointed at, a badge plays its whole move, however briefly it was pointed at: out, a full turn, and back only once it is
// done and no longer pointed at. PLAY is how long the turn takes, in seconds.
const PLAY = 1.1;
type Badge = { link: (typeof LINKS)[number]; pivot: THREE.Object3D; body: THREE.Mesh; glow: { value: number }; rise: number; velocity: number; playAt: number };
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (t: number) => t * t * (3 - 2 * t);


// A rounded rectangle's signed distance, for clipping a face to its tile's rounded corners.
const roundRect = (p: any, half: any, radius: number) => {
  const q = abs(p).sub(half).add(radius) as any;
  return length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(radius) as any;
};

// `reveal`: how far the words on it have come up into place, 0 to 1, overshooting a little as a spring does.
// `warp`: how far the window has gone to ripples, as the eye flies into it, 0 to 1.
type FaceUniforms = { eye: { value: THREE.Vector3 }; hover: { value: number }; sweep: { value: number }; reveal: { value: number }; warp: { value: number } };

// A tile's face. On an open day it is a ceramic frame round a window, and through the window the day's world lies some way
// back: the eye's ray is followed in to a picture larger than the window, so that it slides against the frame as the eye
// moves, as a view through a real window does. The frame shades the near edge of the view in, and the window's glass
// catches a faint streak of light that moves the other way, which is what tells the eye where the surface is. A day to
// come is frosted all over. Over either: the engraved date, a sheen that sweeps across when the tile is pointed at, its
// edge glowing in the day's colour, and on today, a slow warm pulse.
function faceMaterial(day: SpaceDay, words: THREE.Texture, blank: THREE.Texture) {
  const u: FaceUniforms = { eye: uniform(new THREE.Vector3(0, 0, 10)), hover: uniform(0), sweep: uniform(-1), reveal: uniform(1), warp: uniform(0) };
  const material = new THREE.MeshBasicNodeMaterial({ alphaTest: 0.5 });
  // Uniforms rather than constants, so all thirty faces share one shader and one pipeline.
  const tint = uniform(new THREE.Color().copy(day.open ? day.tint : UNOPENED)) as any;
  const open = uniform(day.open && day.poster ? 1 : 0) as any;
  const today = uniform(day.today ? 1 : 0) as any;
  const poster = day.poster ?? blank;
  const windowSize = vec2(WINDOW.w, WINDOW.h);
  const half = windowSize.mul(0.5);
  // The poster, a portrait 4:5, as wide as the window times BEYOND.
  const shown = vec2(WINDOW.w, WINDOW.w / 0.8).mul(BEYOND);
  const local = uv().sub(0.5).mul(vec2(FACE.w, FACE.h)) as any;

  material.colorNode = Fn(() => {
    const p = uv() as any;
    const hover = u.hover as any;
    // The frame: a pearly ceramic, cooler at the top, with a hint of the day's colour.
    const frame = mix(color("#f3f0fb"), color("#dcd6f0"), p.y.oneMinus()).mul(mix(vec3(1), tint, 0.08)) as any;
    const rel = local.sub(vec2(0, WINDOW.y)) as any;
    const inWindow = abs(rel.x).lessThan(half.x).and(abs(rel.y).lessThan(half.y)).and(open.greaterThan(0.5)) as any;
    const toEye = normalize((u.eye as any).sub(vec3(local, 0))) as any;
    const depth = float(SET_BACK).add(hover.mul(SET_BACK_HOVER)) as any;
    // Easing off toward SLIDE as the angle steepens, so the picture never runs out.
    const slide = toEye.xy.div(max(toEye.z, 0.18)).mul(depth) as any;
    const hit = rel.sub(slide.div(length(slide).div(SLIDE).add(1))) as any;
    // A touch closer in while the tile is up, as if leaning in.
    let q = hit.div(shown.mul(float(1).sub(hover.mul(0.08)))).add(0.5) as any;
    // Flown into, the view goes to water: rings running out from its middle, and a slow sway across them, stronger the
    // nearer the eye comes; as the day's own last frame does on the way back from it (portal.ts).
    const warp = u.warp as any;
    const fromMiddle = q.sub(0.5) as any;
    const across = length(fromMiddle) as any;
    const ring = sin(across.mul(42).sub(time.mul(9))) as any;
    const sway = vec2(sin(q.y.mul(15).add(time.mul(3.1))), sin(q.x.mul(13).sub(time.mul(2.7)))) as any;
    q = q.add(fromMiddle.div(max(across, 0.001)).mul(ring.mul(0.026)).add(sway.mul(0.016)).mul(warp)).clamp(0.002, 0.998);
    let view: any = texture(poster, q).rgb.mul(hover.mul(0.14).add(1));
    // Past the poster's own edge, if the eye gets that far round, its colour deepens into the day's.
    const past = max(abs(q.x.sub(0.5)), abs(q.y.sub(0.5))).sub(0.46).max(0).mul(14).clamp(0, 1) as any;
    view = mix(view, tint.mul(0.25), past);
    // The frame's shadow on the view, deepest at the window's edge, and a little haze in the depth.
    const edge = min(half.x.sub(abs(rel.x)), half.y.sub(abs(rel.y))) as any;
    view = view.mul(smoothstep(float(0), float(0.11), edge).mul(0.5).add(0.5));
    view = mix(view, tint.mul(0.55).add(0.25), depth.mul(0.05));
    // The glass: a soft streak of reflected light that slides against the view as the eye moves.
    const streak = exp(pow(p.x.mul(0.8).add(p.y.mul(0.45)).sub(0.62).add(toEye.x.mul(0.5)).sub(toEye.y.mul(0.2)), 2).div(-0.006)) as any;
    view = view.add(vec3(1, 0.98, 0.95).mul(streak.mul(0.09)));
    let rgb: any = inWindow.select(view, frame);
    // A day to come: frosted, its own colour faint in it.
    rgb = mix(rgb, mix(color("#f1eefc"), color("#d6cdf5"), p.y.oneMinus().pow(1.5)), open.oneMinus());
    // The engraving: ink, with a lit lip on one side and a shadow on the other.
    const nudge = vec2(0.0025, -0.002);
    // Coming up from a little below as they appear.
    const at = p.add(vec2(0, (u.reveal as any).oneMinus().mul(0.05))) as any;
    const showing = (u.reveal as any).clamp(0, 1) as any;
    const ink = texture(words, at).r.mul(showing) as any;
    const lip = texture(words, at.add(nudge)).r.sub(texture(words, at.sub(nudge)).r).mul(showing) as any;
    const inkColour = open.greaterThan(0.5).select(color(INK), mix(color(INK), tint, 0.35)) as any;
    rgb = mix(rgb, inkColour, ink.mul(0.82)).add(lip.mul(0.12));
    // The sheen, a diagonal band of light run across once each time the tile is pointed at.
    const diagonal = p.x.add(p.y).mul(0.5) as any;
    const sheen = exp(pow(diagonal.sub(u.sweep), 2).div(-0.0035)) as any;
    rgb = rgb.add(vec3(1, 0.98, 0.94).mul(sheen.mul(0.45)));
    // The edge in the day's colour as it rises; today's in warm light, breathing.
    const fromEdge = min(min(p.x, p.x.oneMinus()).mul(FACE.w), min(p.y, p.y.oneMinus()).mul(FACE.h)) as any;
    const rim = exp(fromEdge.div(-0.022)) as any;
    const pulse = sin(time.mul(2.1)).mul(0.5).add(0.5) as any;
    rgb = rgb.add(tint.mul(rim.mul(hover.mul(2.2)))).add(color(TODAY).mul(rim.mul(today).mul(pulse.mul(1.1).add(0.4))));
    return vec4(rgb, 1);
  })() as any;
  material.opacityNode = roundRect(local, vec2(FACE.w / 2, FACE.h / 2), FACE.corner).lessThan(0).select(float(1), float(0)) as any;
  return { material, uniforms: u };
}

type Tile = {
  day: SpaceDay;
  column: number;
  row: number;
  home: THREE.Vector3;
  pivot: THREE.Object3D;
  face: THREE.Mesh;
  uniforms: FaceUniforms;
  rise: number;
  velocity: number;
  tipX: number;
  tipY: number;
  // When the sheen last set off across it.
  sweepAt: number;
  // Its words coming up into place once it has landed, on a spring.
  reveal: number;
  revealing: number;
};

// What is laid out one way or the other: the slab and what stands on it, and where the slab was built to stand for the month in
// weeks.
type Place = {
  slabBack: number;
  slabTop: number;
  slabSize: { w: number; h: number };
  lift: number;
  slabSpan: { value: THREE.Vector2 };
  box: THREE.Box3;
  header: THREE.Object3D;
  next: THREE.Object3D;
  badgeGroup: THREE.Object3D;
  slab: THREE.Mesh;
  frame: THREE.Mesh;
  fade: { value: number };
  slabZ: number;
  plateFront: number;
  titleScale: number;
  // In place: where the title stands on the page, and how much higher it stands once out of it, in metres.
  titleY: number;
  raise: number;
};

// The frame round the plate: a rounded band FRAME wide, standing a little proud of the plate's face, bevelled.
const FRAME = { band: 0.14, proud: 0.07 };
function rounded<T extends THREE.Path>(path: T, w: number, h: number, r: number) {
  path.moveTo(-w / 2 + r, -h / 2);
  path.lineTo(w / 2 - r, -h / 2);
  path.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  path.lineTo(w / 2, h / 2 - r);
  path.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  path.lineTo(-w / 2 + r, h / 2);
  path.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  path.lineTo(-w / 2, -h / 2 + r);
  path.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return path;
}
function frameGeometry(w: number, h: number) {
  const outer = rounded(new THREE.Shape(), w + FRAME.band * 2 - 0.04, h + FRAME.band * 2 - 0.04, 0.16);
  outer.holes.push(rounded(new THREE.Path(), w - 0.06, h - 0.06, 0.06));
  const depth = 0.12 + FRAME.proud;
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: depth - 0.04, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 12 });
  // From the plate's back to a little in front of its face.
  geometry.translate(0, 0, -0.06 + 0.02);
  return geometry;
}

// In place, each tile where its card is on the page, the plate under them all, and the title where the page has it, its face
// on the page's own; as a flight, the month in weeks over the slab, the title on the slab's top edge at its left and the
// badges at its right.
function arrange(built: { tiles: Tile[]; title: THREE.Mesh; badges: Badge[]; place: Place }, kind: "page" | "flight", layout: PageLayout) {
  const { tiles, title, badges, place } = built;
  const inPlace = kind === "page";
  place.header.visible = place.next.visible = place.badgeGroup.visible = !inPlace;
  place.slab.visible = true;
  place.slab.scale.set(1, 1, 1);
  let w: number;
  let h: number;
  let x = 0;
  let y: number;
  if (inPlace) {
    const sheet = sheetOf(layout, TILE.w);
    const columns = layout.cards.filter((card) => card.y === layout.cards[0].y).length;
    tiles.forEach((tile, i) => {
      const card = layout.cards[i];
      onSheet(sheet, card.x + card.w / 2, card.y + card.h / 2, tile.home, -TILE.d / 2);
      tile.column = i % columns;
      tile.row = Math.floor(i / columns);
    });
    const xs = tiles.map((tile) => tile.home.x);
    const ys = tiles.map((tile) => tile.home.y);
    // The plate takes in the strip saying how many days are left, where the cards leave no room for it.
    const { countdown } = layout;
    const under = countdown.strip ? (sheet.cy - countdown.y - countdown.h) * sheet.u : Infinity;
    const [left, right, bottom, top] = [Math.min(...xs) - TILE.w / 2, Math.max(...xs) + TILE.w / 2, Math.min(Math.min(...ys) - TILE.h / 2, under), Math.max(...ys) + TILE.h / 2];
    w = right - left + PLATE_ROOM * 2;
    h = top - bottom + PLATE_ROOM * 2;
    x = (left + right) / 2;
    y = (top + bottom) / 2;
    place.plateFront = -TILE.d - 0.07;
    place.titleScale = layout.title.size * sheet.u;
    onSheet(sheet, layout.title.x, layout.title.baseline, title.position);
    place.titleY = title.position.y;
    place.raise = RAISE * sheet.u;
  } else {
    tiles.forEach((tile) => {
      const index = tile.day.number - 1 + FIRST_COLUMN;
      tile.column = index % 7;
      tile.row = Math.floor(index / 7);
      tile.home.set(-GRID.w / 2 + TILE.w / 2 + tile.column * (TILE.w + GAP), GRID.h / 2 - TILE.h / 2 - tile.row * (TILE.h + GAP) + place.lift, 0);
    });
    ({ w, h } = place.slabSize);
    y = place.lift + 0.225;
    place.plateFront = place.slabBack;
    const { box } = place;
    const scale = (place.titleScale = Math.min(TITLE.size, (w - TITLE.room) / (box.max.x - box.min.x)));
    title.position.set(-w / 2 + 0.06 - box.min.x * scale, place.slabTop + 0.08 - box.min.y * scale, -TILE.d / 2 + (TITLE.depth * scale) / 2);
    const middle = place.slabTop + 0.08 + (box.max.y - box.min.y) * scale * 0.42;
    badges.forEach((badge, i) => badge.pivot.position.set(w / 2 - 0.1 - BADGE.size / 2 - (LINKS.length - 1 - i) * (BADGE.size + BADGE.gap), middle, -TILE.d / 2 + BADGE.depth / 2));
  }
  place.slabZ = place.plateFront - 0.06;
  place.slab.geometry.dispose();
  place.slab.geometry = new RoundedBoxGeometry(w, h, 0.12, 4, 0.06);
  place.frame.geometry.dispose();
  place.frame.geometry = frameGeometry(w, h);
  place.slabSpan.value.set(w, h);
  place.slab.position.set(x, y, place.slabZ);
  title.scale.setScalar(place.titleScale);
}

// Its look is the definition's, below; the page over it sets its own on top (unfold.tsx).
function Scene() {
  const days = useSpaceDays();
  const fonts = suspend(loadFonts, ["cv-space-calendar-fonts"]);
  const camera = useThree((state) => state.camera);
  // Going into a day, the posters' GPU copies are let go (pictures.ts).
  const posters = suspend(loadPosters, ["cv-hub-posters"]);
  useEffect(() => () => releasePosters(posters), [posters]);

  const built = useMemo(() => {
    const group = new THREE.Group();
    group.rotation.set(HANG.x, HANG.y, 0);
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.needsUpdate = true;
    const disposables: { dispose: () => void }[] = [blank];
    const faceGeometry = new THREE.PlaneGeometry(FACE.w, FACE.h);
    disposables.push(faceGeometry);
    // The grid is centred a little low, to leave room above for the weekdays and the month.
    const lift = -0.55;
    const tiles: Tile[] = days.map((day) => {
      const index = day.number - 1 + FIRST_COLUMN;
      const column = index % 7;
      const row = Math.floor(index / 7);
      const home = new THREE.Vector3(-GRID.w / 2 + TILE.w / 2 + column * (TILE.w + GAP), GRID.h / 2 - TILE.h / 2 - row * (TILE.h + GAP) + lift, 0);
      const words = faceText(day, fonts);
      const { material, uniforms } = faceMaterial(day, words, blank);
      const pivot = new THREE.Object3D();
      pivot.position.copy(home);
      const face = new THREE.Mesh(faceGeometry, material);
      face.position.z = TILE.d / 2 + 0.002;
      pivot.add(face);
      group.add(pivot);
      disposables.push(words, material);
      return { day, column, row, home, pivot, face, uniforms, rise: 0, velocity: 0, tipX: 0, tipY: 0, sweepAt: -10, reveal: 1, revealing: 0 };
    });

    // The tiles' bodies, all in one draw: pearly ceramic, glowing at the edges in each day's colour as it rises.
    const bodyGeometry = new RoundedBoxGeometry(TILE.w, TILE.h, TILE.d, 4, TILE.radius);
    const tint = new Float32Array(tiles.length * 3);
    tiles.forEach((tile, i) => (tile.day.open ? tile.day.tint : UNOPENED).toArray(tint, i * 3));
    bodyGeometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    const glow = new THREE.InstancedBufferAttribute(new Float32Array(tiles.length), 1);
    glow.setUsage(THREE.DynamicDrawUsage);
    bodyGeometry.setAttribute("aGlow", glow);
    const bodyMaterial = new THREE.MeshStandardNodeMaterial({ color: "#ebe7f6", roughness: 0.38, metalness: 0 });
    const fresnel = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5) as any;
    bodyMaterial.emissiveNode = (attribute("aTint", "vec3") as any).mul((attribute("aGlow", "float") as any).mul(fresnel).mul(1.6)) as any;
    const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, tiles.length);
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodies.frustumCulled = false;
    group.add(bodies);
    disposables.push(bodyGeometry, bodyMaterial);

    // The slab the month floats over, the weekdays included.
    const slabBack = -TILE.d / 2 - 0.2;
    const slabSize = { w: GRID.w + 0.5, h: GRID.h + 0.95 };
    // Cream, the title's own white warmed a little, a shade deeper to the bottom right away from the light, its rounded rim
    // catching the light; framed in tan. Its size is set as the month is laid out, below.
    // Faded in as it comes out of the page (in place), and so drawn as see-through, though it is solid once out.
    const fade = uniform(1);
    const slabMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0, transparent: true });
    slabMaterial.opacityNode = fade as any;
    const slabSpan = uniform(new THREE.Vector2(slabSize.w, slabSize.h));
    const across = positionLocal.x.div(slabSpan.x).sub(positionLocal.y.div(slabSpan.y)).add(0.5).clamp(0, 1) as any;
    slabMaterial.colorNode = mix(color("#f2ece2"), color("#d8cdbb"), across) as any;
    slabMaterial.emissiveNode = color("#fff3dc").mul(pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3).mul(0.22)) as any;
    const slab = new THREE.Mesh(new THREE.BufferGeometry(), slabMaterial);
    group.add(slab);
    const frameMaterial = new THREE.MeshStandardNodeMaterial({ color: "#c2a77f", roughness: 0.45, metalness: 0, transparent: true });
    frameMaterial.opacityNode = fade as any;
    frameMaterial.emissiveNode = color("#fff1d8").mul(pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3).mul(0.25)) as any;
    const frame = new THREE.Mesh(new THREE.BufferGeometry(), frameMaterial);
    slab.add(frame);
    disposables.push(slabMaterial, frameMaterial, { dispose: () => slab.geometry.dispose() }, { dispose: () => frame.geometry.dispose() });

    // Under each tile, on the slab: a soft contact shadow, deeper and wider as the tile rises, warmed by its colour.
    const shadowSize = { w: TILE.w + 0.9, h: TILE.h + 0.9 };
    const shadowGeometry = new THREE.PlaneGeometry(shadowSize.w, shadowSize.h);
    shadowGeometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    const lifted = new THREE.InstancedBufferAttribute(new Float32Array(tiles.length), 1);
    lifted.setUsage(THREE.DynamicDrawUsage);
    shadowGeometry.setAttribute("aRise", lifted);
    const shadowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    shadowMaterial.colorNode = Fn(() => {
      const r = attribute("aRise", "float") as any;
      const local = uv().sub(0.5).mul(vec2(shadowSize.w, shadowSize.h)) as any;
      const d = roundRect(local, vec2(TILE.w / 2 - 0.04, TILE.h / 2 - 0.04), 0.1).max(0) as any;
      const soft = exp(d.div(r.mul(0.22).add(0.05)).negate()) as any;
      const dark = soft.mul(r.mul(0.22).add(0.18)) as any;
      return vec4(mix(color("#3a2f6a"), attribute("aTint", "vec3") as any, r.mul(0.5)).mul(0.6), dark);
    })() as any;
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, tiles.length);
    shadows.frustumCulled = false;
    group.add(shadows);
    disposables.push(shadowGeometry, shadowMaterial);

    // Where the month runs out, the first days of December, pressed faintly into the slab.
    const spare = 7 - (tiles.length % 7);
    const nextMap = canvasTexture(1024, Math.round((1024 * TILE.h) / (spare * TILE.w + (spare - 1) * GAP)), (ctx) => {
      const px = ctx.canvas.width / (spare * TILE.w + (spare - 1) * GAP);
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.font = `800 ${Math.round(BAND * px * 0.5)}px ${fonts.display}`;
      ctx.textBaseline = "middle";
      for (let i = 0; i < spare; i++) {
        const x = i * (TILE.w + GAP) * px;
        ctx.beginPath();
        ctx.roundRect(x + 2, 2, TILE.w * px - 4, TILE.h * px - 4, TILE.radius * px);
        ctx.stroke();
        ctx.fillText(i === 0 ? "Dec 1" : String(i + 1), x + MARGIN * px * 1.2, BAND * px * 0.55);
      }
    });
    const nextWidth = spare * TILE.w + (spare - 1) * GAP;
    const nextGeometry = new THREE.PlaneGeometry(nextWidth, TILE.h);
    const nextMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    nextMaterial.colorNode = vec4(color(PALE), texture(nextMap).a.mul(0.32)) as any;
    const next = new THREE.Mesh(nextGeometry, nextMaterial);
    const last = tiles[tiles.length - 1].home;
    next.position.set(last.x + TILE.w / 2 + GAP + nextWidth / 2, last.y, slabBack + 0.006);
    group.add(next);
    disposables.push(nextMap, nextGeometry, nextMaterial);

    // The weekdays over the columns and the month over them, in ink.
    const textMaterial = (map: THREE.Texture, alpha: number) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      m.colorNode = vec4(color(PALE), texture(map).a.mul(alpha)) as any;
      return m;
    };
    const headerMap = headerText(fonts);
    const headerMaterial = textMaterial(headerMap, 0.55);
    const headerGeometry = new THREE.PlaneGeometry(GRID.w, 0.42);
    const header = new THREE.Mesh(headerGeometry, headerMaterial);
    header.position.set(0, GRID.h / 2 + lift + 0.32, slabBack + 0.01);
    group.add(header);
    disposables.push(headerMap, headerMaterial, headerGeometry);

    // The name, a unit high, on its baseline from where the pen starts, its face at the front and its depth behind.
    const slabTop = lift + 0.225 + slabSize.h / 2;
    const bevel = 0.008;
    const titleGeometry = new TextGeometry("Codevember", { font: SPACED, size: 1, depth: TITLE.depth - bevel * 2, curveSegments: 5, bevelEnabled: true, bevelThickness: bevel, bevelSize: 0.004, bevelSegments: 2 });
    titleGeometry.translate(0, 0, -TITLE.depth + bevel);
    titleGeometry.computeBoundingBox();
    const box = titleGeometry.boundingBox!;
    // Its face the page's own white, unlit, so that it is the same on the page and in the world and never glows; its sides a
    // warm grey, lit, so that it reads as cut type.
    const titleFace = new THREE.MeshBasicNodeMaterial({ color: "#f2efe9" });
    const titleSide = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0 });
    // Coming through the page's picture of it as the move begins (unfold.standing), rather than at a stroke.
    for (const material of [titleFace, titleSide]) {
      material.transparent = true;
      material.opacityNode = unfold.standingness as any;
    }
    // Unlit white while the type lies flat in the page, so that no edge of it shows there; lit grey as it stands out.
    titleSide.colorNode = color("#c4bdb2").mul(unfold.solidness) as any;
    titleSide.emissiveNode = mix(color("#f2efe9"), color("#fff3dc").mul(pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3).mul(0.3)), unfold.solidness) as any;
    const title = new THREE.Mesh(titleGeometry, [titleFace, titleSide]);
    group.add(title);
    disposables.push(titleGeometry, titleFace, titleSide);

    // The badges, at the slab's top right, sat level with the middle of the name's letters.
    const badgeGeometry = new RoundedBoxGeometry(BADGE.size, BADGE.size, BADGE.depth, 4, 0.12);
    const badgeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.36, metalness: 0 });
    // Each badge's own glow comes in through its material's uniform; one material per badge, three in all.
    const markMaterial = new THREE.MeshStandardNodeMaterial({ color: "#221e52", roughness: 0.3, metalness: 0 });
    disposables.push(badgeGeometry, badgeMaterial, markMaterial);
    const badgeGroup = new THREE.Group();
    group.add(badgeGroup);
    const badges: Badge[] = LINKS.map((link) => {
      const glow = uniform(0);
      const body = new THREE.Mesh(badgeGeometry, badgeMaterial.clone());
      const material = body.material as THREE.MeshStandardNodeMaterial;
      material.colorNode = mix(color("#f3f0fb"), color("#e2dcf4"), uv().y.oneMinus()) as any;
      const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5) as any;
      material.emissiveNode = color(link.glow).mul(rim.mul(glow.mul(1.8).add(0.1))) as any;
      const markGeom = markGeometry(link.d, BADGE.mark);
      const mark = new THREE.Mesh(markGeom, markMaterial);
      mark.position.z = BADGE.depth / 2 + 0.02;
      const pivot = new THREE.Object3D();
      pivot.add(body, mark);
      badgeGroup.add(pivot);
      disposables.push(material, markGeom);
      return { link, pivot, body, glow, rise: 0, velocity: 0, playAt: -10 };
    });

    // Light: a pale sky above, warm gold bounced from below, and the low sun off to the right.
    const hemisphere = new THREE.HemisphereLight("#e6e4ff", "#f3d2a6", 2.1);
    const sun = new THREE.DirectionalLight("#fff1d8", 2.4);
    sun.position.set(4, 5, 8);
    // Not in the group: the group is hidden on the page, and lights coming or going change every object's pipeline key, so
    // three would rebuild every pipeline in view, synchronously, at each switch between page and calendar.
    const lights = new THREE.Group();
    lights.add(hemisphere, sun);

    // Laid out one way or the other, below.
    const place = { slabBack, slabTop, slabSize, lift, slabSpan, box, header, next, badgeGroup, slab, frame, fade, slabZ: slabBack - 0.06, titleScale: 1, plateFront: slabBack, titleY: 0, raise: 0 };

    return { group, lights, tiles, bodies, glow, lifted, shadows, title, badges, place, disposables };
  }, [days, fonts]);
  useDispose(...built.disposables);

  // Where everything stands: in place, as the page lays it out; as a flight, the month in weeks, as it always was.
  const layout = usePageLayout();
  const kind = useTransition().kind;
  useMemo(() => arrange(built, kind, layout), [built, kind, layout]);

  // The pointer, for tipping the risen tile toward it.
  const pointer = useRef(new THREE.Vector2(0, 0));
  useEffect(() => {
    const onMove = (event: PointerEvent) => pointer.current.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const targets = useMemo(() => built.tiles.map((tile) => ({ day: tile.day, object: tile.face })), [built]);
  // Where each card from the page lands: square on the face of its tile, as the tile sits in the grid.
  const landing = useMemo<Landing>(() => {
    const at = new THREE.Vector3();
    return (number, position, quaternion, size) => {
      const tile = built.tiles[number - 1];
      if (number === 1) built.group.updateWorldMatrix(true, false);
      position.copy(built.group.localToWorld(at.set(tile.home.x, tile.home.y, TILE.d / 2 + 0.004)));
      built.group.getWorldQuaternion(quaternion);
      size.set(FACE.w, FACE.h);
    };
  }, [built]);

  const pointing = useSpace({
    targets: () => targets,
    anchor: (day, out) => {
      const tile = built.tiles[day.number - 1];
      tile.pivot.localToWorld(out.set(0, TILE.h / 2 + 0.04, TILE.d / 2));
    },
    centre: (day, out) => {
      const tile = built.tiles[day.number - 1];
      tile.pivot.localToWorld(out.set(0, WINDOW.y, TILE.d / 2));
      return 0.75;
    },
    // Square on to the month, not to the tile, which tips toward the pointer: the window filling the view at 1.
    close: (day, eye, nearness, position, quaternion) => {
      const tile = built.tiles[day.number - 1];
      built.group.updateWorldMatrix(true, true);
      tile.pivot.localToWorld(position.set(0, WINDOW.y, TILE.d / 2));
      built.group.getWorldQuaternion(quaternion);
      const half = Math.tan(THREE.MathUtils.degToRad(eye.fov / 2));
      const away = Math.min(WINDOW.h / 2 / half, WINDOW.w / 2 / (half * eye.aspect)) * nearness;
      position.add(scratch.out.set(0, 0, away).applyQuaternion(quaternion));
    }
  });

  // The badges: pointed at, one rises and turns to the pointer; pressed (not dragged), it opens where it points, in a new tab.
  const dom = useThree((state) => state.gl.domElement);
  const badgeHover = useRef<Badge | null>(null);
  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const bodies = built.badges.map((badge) => badge.body);
    let down: { x: number; y: number } | null = null;
    const pick = (event: PointerEvent) => {
      if (!unfold.inWorld || !built.place.badgeGroup.visible) return null;
      const bounds = dom.getBoundingClientRect();
      ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(bodies, false)[0];
      return hit ? built.badges.find((badge) => badge.body === hit.object) ?? null : null;
    };
    const point = (badge: Badge | null) => {
      if (badge === badgeHover.current) return;
      badgeHover.current = badge;
      dom.style.cursor = badge ? "pointer" : "grab";
      const now = performance.now() / 1000;
      if (badge && now - badge.playAt > PLAY) {
        badge.playAt = now;
        sound.play("ping", { gain: 0.12, pitch: 1.1, gap: 0.06 });
      }
    };
    const onDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && !down) point(pick(event));
    };
    const onUp = (event: PointerEvent) => {
      const from = down;
      down = null;
      if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 6) return;
      const badge = pick(event);
      if (!badge) return;
      sound.play("click", { gain: 0.25, pitch: 1.2 });
      window.open(badge.link.href, "_blank", "noopener");
    };
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [built, camera, dom]);

  const ripple = useRef({ column: 0, row: 0, at: -10, last: null as SpaceDay | null });
  const scratch = useMemo(
    () => ({
      screen: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      out: new THREE.Vector3(),
      matrix: new THREE.Matrix4(),
      euler: new THREE.Euler(),
      pose: { shown: false, depth: 0, scale: 1, roll: 0, turnY: 0, lift: 0 } as TilePose
    }),
    []
  );

  // The month hangs in the air, turning a little this way and that; in place, only as it leaves the page, which stands
  // square on. Before the page's own frame, which lays the page on it.
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const k = kind === "page" ? unfold.amount : 1;
    built.group.rotation.set((HANG.x + Math.sin(t * 0.21) * 0.025) * k, (HANG.y + Math.sin(t * 0.13 + 1) * 0.05) * k, Math.sin(t * 0.17) * 0.008 * k);
    built.group.position.y = Math.sin(t * 0.33) * 0.06 * k;
  }, -0.6);

  useFrame(({ clock }, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 30);
    const now = performance.now() / 1000;
    const t = clock.elapsedTime;
    const move = cardMove();
    const { group, tiles, bodies, glow, lifted, place } = built;
    const s = scratch;
    const inPlace = kind === "page";

    const hovered = pointing.current.entering?.day ?? pointing.current.hovered;
    const r = ripple.current;
    if (hovered !== r.last) {
      r.last = hovered;
      if (hovered) {
        const tile = tiles[hovered.number - 1];
        r.column = tile.column;
        r.row = tile.row;
        r.at = now;
        tile.sweepAt = now;
      }
    }
    const up = hovered ? tiles[hovered.number - 1] : null;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const singled = tile === up;
      // Rising on a spring that overshoots a little.
      const force = ((singled ? 1 : 0) - tile.rise) * SPRING.stiffness - tile.velocity * SPRING.damping;
      tile.velocity += force * delta;
      tile.rise += tile.velocity * delta;

      // The ripple: each tile bobs once, later the further it is from the one pointed at, and less.
      const distance = Math.hypot(tile.column - r.column, (tile.row - r.row) * 1.1);
      const since = now - r.at - distance / RIPPLE.speed;
      const bob = since > 0 && !singled ? Math.sin(since * 11) * Math.exp(-since * RIPPLE.decay) * RIPPLE.height * Math.exp(-distance * RIPPLE.reach) : 0;
      // Close neighbours sink back a little while one is up, so it stands clear of them.
      const way = up && !singled ? -MAKE_WAY * Math.max(0, 1 - distance / 2.2) * Math.min(1, Math.max(0, up.rise)) : 0;

      // Tipping toward the pointer, round its middle.
      let tipX = 0;
      let tipY = 0;
      if (singled) {
        s.screen.copy(tile.home);
        group.localToWorld(s.screen).project(camera);
        tipY = THREE.MathUtils.clamp((pointer.current.x - s.screen.x) * 3, -1, 1) * TIP;
        tipX = THREE.MathUtils.clamp(-(pointer.current.y - s.screen.y) * 3, -1, 1) * TIP;
      }
      const k = 1 - Math.exp(-delta * 9);
      tile.tipX += (tipX - tile.tipX) * k;
      tile.tipY += (tipY - tile.tipY) * k;

      const landed = unfold.landed[tile.day.number];
      const swell = 1 + Math.max(0, tile.rise) * 0.06;
      let grown: number;
      if (inPlace) {
        // As the chosen move has it (transitions.ts): its depth grown out behind its face, the face starting where the card
        // lies; sized, turned on its top edge or its middle, and brought toward the eye.
        move.tile(landed, s.pose);
        const { depth: deep, roll, turnY } = s.pose;
        grown = s.pose.shown ? s.pose.scale : 0;
        s.out.set(0, (-TILE.h / 2) * grown, tile.home.z * deep).applyEuler(s.euler.set(roll, turnY, 0));
        tile.pivot.position.set(tile.home.x, tile.home.y + (TILE.h / 2) * grown, 0).add(s.out);
        tile.pivot.position.z += tile.rise * RISE + bob + way + s.pose.lift;
        tile.pivot.rotation.set(tile.tipX + roll, tile.tipY + turnY, 0);
        tile.pivot.scale.set(swell * grown, swell * grown, Math.max(deep, 0.002) * swell * grown);
        grown *= place.slab.visible ? 1 : 0;
      } else {
        tile.pivot.rotation.set(tile.tipX, tile.tipY, 0);
        // Grown in behind its card as the card lands on it from the page, with a little overshoot.
        grown = overshoot(landed);
        tile.pivot.position.set(tile.home.x, tile.home.y, tile.rise * RISE + bob + way);
        tile.pivot.scale.setScalar(grown * swell);
      }
      tile.face.visible = inPlace ? s.pose.shown : landed > 0;
      // Its words, once it has landed: up into place on a spring; gone again as soon as it leaves.
      const wanted = landed >= 1 ? 1 : 0;
      tile.revealing += ((wanted - tile.reveal) * 90 - tile.revealing * 11) * delta;
      tile.reveal = wanted ? tile.reveal + tile.revealing * delta : Math.min(tile.reveal + tile.revealing * delta, landed);
      if (!wanted && tile.reveal < 0) tile.reveal = tile.revealing = 0;
      tile.uniforms.reveal.value = tile.reveal;
      tile.pivot.updateMatrix();
      bodies.setMatrixAt(i, tile.pivot.matrix);
      const rise = Math.max(0, tile.rise);
      // Lit as it rises, flashing as the ripple passes, and on today, breathing.
      glow.array[i] = rise + Math.abs(bob) * 4 + (tile.day.today ? 0.35 + 0.25 * Math.sin(t * 2.1) : 0);
      lifted.array[i] = Math.min(1.2, rise + Math.abs(bob) * 2);
      built.shadows.setMatrixAt(i, s.matrix.makeScale(grown, grown, 1).setPosition(tile.home.x, tile.home.y, place.plateFront + 0.004));

      const u = tile.uniforms;
      u.hover.value = Math.min(1, rise);
      u.sweep.value = -0.4 + (now - tile.sweepAt) * 2.2;
      // Rippling as the eye flies into it.
      const entering = pointing.current.entering;
      const into = entering?.day.number === tile.day.number ? Math.min(1, (now - entering.at) / 0.85) : 0;
      u.warp.value = into * into * (3 - 2 * into);
    }
    bodies.instanceMatrix.needsUpdate = true;
    built.shadows.instanceMatrix.needsUpdate = true;
    glow.needsUpdate = true;
    lifted.needsUpdate = true;

    // In place: the name stands up out of the page's own, its face where the page's was; the plate comes out behind the
    // cards, from just behind them to where it stands, growing out to its edges. As a flight: the name and the badges come
    // up with the month as the page unfolds into it, from the slab's top edge.
    const shown = inPlace ? 1 : THREE.MathUtils.smoothstep(unfold.amount, 0.45, 1);
    const scale = place.titleScale;
    if (inPlace) {
      built.title.scale.set(scale, scale, scale * Math.max(unfold.solid, 0.01));
      built.title.visible = unfold.amount > 0;
      // Up a little as it stands out, with the buttons, clear of the frame round the plate.
      built.title.position.y = place.titleY + place.raise * unfold.solid;
      // The plate extrudes back out of the page, fading in as it comes, and growing out to its edges.
      const plate = unfold.plate;
      const out = smoother(plate);
      place.slab.visible = plate > 0;
      place.slab.scale.set(0.94 + 0.06 * out, 0.94 + 0.06 * out, Math.max(out, 0.01));
      place.slab.position.z = THREE.MathUtils.lerp(-TILE.d * 0.5, place.slabZ, out);
      place.fade.value = smooth(Math.min(1, plate * 1.6));
    } else {
      place.fade.value = 1;
      built.title.scale.set(scale, scale * (0.2 + 0.8 * shown), scale * shown + 1e-3);
      built.title.visible = shown > 0.001;
    }
    for (const badge of built.badges) {
      const played = (now - badge.playAt) / PLAY;
      const playing = played < 1;
      const force = ((playing || badge === badgeHover.current ? 1 : 0) - badge.rise) * SPRING.stiffness - badge.velocity * SPRING.damping;
      badge.velocity += force * delta;
      badge.rise += badge.velocity * delta;
      badge.pivot.position.z = -TILE.d / 2 + BADGE.depth / 2 + badge.rise * BADGE.rise;
      badge.pivot.rotation.y = playing ? Math.PI * 2 * smoother(Math.max(0, played)) : 0;
      badge.pivot.scale.setScalar(shown * (1 + Math.max(0, badge.rise) * 0.12) + 1e-3);
      badge.glow.value = Math.max(0, badge.rise);
    }
  });

  // The far lights only off the page: in place, the world is there on the page too, for the title and the buttons.
  const bokeh = useRef<THREE.Group>(null);
  useFrame(() => {
    if (bokeh.current) bokeh.current.visible = kind === "flight" || unfold.amount > 0;
  });

  // A badge pointed at keeps the pointing hand, over the space's own cursor, which knows only days.
  useFrame(() => {
    if (badgeHover.current && dom.style.cursor !== "pointer") dom.style.cursor = "pointer";
  }, 0.92);

  // Where the eye is, as each face sees it, for looking into its window: once the camera has drifted for this frame.
  useFrame(() => {
    built.group.updateMatrixWorld(true);
    for (const tile of built.tiles) tile.uniforms.eye.value.copy(tile.face.worldToLocal(scratch.eye.copy(camera.position)));
  }, 0.6);

  return (
    <>
      <Sky palette={PALETTE} />
      <CameraDrift />
      <primitive object={built.lights} />
      <Unfold layout={layout} month={built.group} rest={REST} landing={landing} look={LOOK} palette={PALETTE}>
        <group ref={bokeh}>
          <Lights palette={PALETTE} count={220} inner={9} outer={60} size={BOKEH_SIZE} seed={11} />
        </group>
        {kind === "page" ? (
          <>
            <SolidButtons month={built.group} layout={layout} />
            <Countdown layout={layout} month={built.group} plate={built.place.plateFront} fonts={fonts} />
            <Floor layout={layout} />
            <Motes layout={layout} />
          </>
        ) : null}
        <primitive object={built.group} />
      </Unfold>
    </>
  );
}

const definition: DayDefinition = {
  camera: { position: [0.9, 1.95, 8.1], target: [0, 2.05, 0], fov: 40, phone: { position: [0, 0.2, 21], target: [0, 0.1, 0], fov: 46 } },
  look: LOOK,
  // As sharp as the page it becomes (HubStage.tsx), unmapped, with no shading in creases, and its edges smoothed within each
  // frame, and not at all on a dense screen: drawn the same way on the page and in the calendar, so that nothing about how it
  // is drawn changes as one becomes the other.
  maxDpr: 2,
  // The sky kept sharp by the lens: blurred, it would carry a soft copy of the page's words and buttons out round their edges.
  passes: { haze: false, bounce: false, depthOfField: { range: 11, sharpSky: true }, toneMapping: "none", temporal: false, occlusion: false },
  Scene
};

export default definition;
