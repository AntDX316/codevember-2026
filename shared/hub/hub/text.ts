// The page's text, drawn by the browser's own text engine into canvases at the screen's density, in the page's fonts, and
// handed to the GPU as textures. Drawn in full ink: a dimmed colour is the same ink at a lower opacity, set on the mesh.

import * as THREE from "three/webgpu";
import { baseline, blurbFont, LINE, markFont, titleFont, type CardLayout, type Fonts, type PageLayout } from "./layout";

const INK = "#f2efe9";
const ACCENT = "#ffb48a";
const GITHUB = new Path2D(
  "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3"
);

export const density = () => Math.min(globalThis.devicePixelRatio || 1, 2);
// A length of the page, in CSS pixels, on to the screen's own pixels.
export const snap = (x: number) => Math.round(x * density()) / density();
// A place on the page on a whole CSS pixel, where the browser paints a box whatever the screen's density; and so where the
// GPU lays one too, for the page as HTML (spaces/mirror.ts) to land on the very same pixels.
export const whole = (x: number) => Math.round(x);
// Where a texture drawn by `paint` lies on the page: from a corner on one of the screen's pixels, and as big as its pixels,
// one to each of the screen's, so that it is shown exactly as drawn, as sharp as the browser's own text.
export const texelRect = (texture: THREE.Texture, rect: { x: number; y: number }) => {
  const image = texture.image as HTMLCanvasElement;
  return { x: whole(rect.x), y: whole(rect.y), w: image.width / density(), h: image.height / density() };
};

// A canvas w by h CSS pixels, at the screen's density, drawn in ink unless told otherwise; rounded up to whole CSS pixels,
// never stretched, so that each of its pixels can be one of the screen's. A card's words, `fitted`, are stretched
// to it instead, as they are laid over the whole of the card.
function paint(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, fitted = false) {
  const scale = density();
  const canvas = document.createElement("canvas");
  // Whole CSS pixels across and down, too, so that the page as HTML shows it at its own size, unstretched.
  canvas.width = Math.max(1, Math.ceil(Math.ceil(w) * scale));
  canvas.height = Math.max(1, Math.ceil(Math.ceil(h) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas to draw text with.");
  if (fitted) ctx.scale(canvas.width / w, canvas.height / h);
  else ctx.scale(scale, scale);
  ctx.fillStyle = INK;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  // Read as written, in sRGB: the shaders mix it as the browser would before going to linear.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// The extra room drawn round the title, as fractions of its font size: its glyphs overhang a line height of 0.8.
export const TITLE_PAD = { x: 0.06, y: 0.35 };

export function titleTexture(layout: PageLayout, fonts: Fonts) {
  const { title } = layout;
  const padX = title.size * TITLE_PAD.x;
  const padY = title.size * TITLE_PAD.y;
  return paint(title.w + padX * 2, title.h + padY * 2, (ctx) => {
    ctx.font = titleFont(fonts, title.size);
    ctx.letterSpacing = `${-0.04 * title.size}px`;
    ctx.fillText("Codevember", padX, baseline(ctx, padY, title.h));
  });
}

export function blurbTexture(layout: PageLayout, fonts: Fonts) {
  const { blurb } = layout;
  return paint(blurb.w, blurb.h + 4, (ctx) => {
    ctx.font = blurbFont(fonts);
    blurb.lines.forEach((line, index) => ctx.fillText(line, 0, baseline(ctx, index * 13 * LINE, 13 * LINE)));
  });
}

export function markTexture(text: string, width: number, fonts: Fonts, icon = false) {
  return paint(width, 18, (ctx) => {
    ctx.font = markFont(fonts);
    ctx.letterSpacing = "0.96px";
    ctx.fillText(text, 0, baseline(ctx, 0, 18));
    if (!icon) return;
    ctx.save();
    ctx.translate(width - 14, 2);
    ctx.scale(14 / 24, 14 / 24);
    ctx.fill(GITHUB);
    ctx.restore();
  });
}

// What is written on a card: its number at the top, its word at the bottom, and Today in the corner.
export function cardTexture(card: CardLayout, fonts: Fonts, today: boolean) {
  const { w, h, open } = card;
  return paint(w, h, (ctx) => {
    // 1px of border, then 12 of padding.
    const inset = 13;
    ctx.font = `400 12px ${fonts.body}`;
    ctx.fillStyle = open ? INK : "rgba(242, 239, 233, 0.22)";
    ctx.fillText(String(card.day.day).padStart(2, "0"), inset, baseline(ctx, inset, 18));

    const size = w * 0.2;
    ctx.font = `800 ${size}px ${fonts.display}`;
    ctx.letterSpacing = `${-0.03 * size}px`;
    ctx.fillStyle = open ? INK : "rgba(242, 239, 233, 0.62)";
    ctx.fillText(card.day.word, inset, baseline(ctx, h - inset - size * 0.95, size * 0.95));

    if (!today) return;
    ctx.font = `400 11px ${fonts.body}`;
    ctx.letterSpacing = "0px";
    ctx.textAlign = "right";
    ctx.fillStyle = ACCENT;
    ctx.fillText("Today", w - inset, baseline(ctx, inset, 11 * LINE));
  }, true);
}
