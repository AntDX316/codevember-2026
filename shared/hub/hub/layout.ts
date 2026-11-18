// The calendar page, laid out as codevember.css lays out the Gallery, so that drawn on the GPU it lands on the same pixels.
// Everything here is in CSS pixels from the top left of the page.

import { days, daySlug, promptDayFor, type CodevemberDay } from "@/shared/days";
import { whole } from "./text";

export type Rect = { x: number; y: number; w: number; h: number };
export type Fonts = { display: string; body: string };

export type CardLayout = Rect & { day: CodevemberDay; slug: string; open: boolean; poster: boolean };

export type PageLayout = {
  width: number;
  height: number;
  // The height of the whole page, for scrolling.
  page: number;
  home: Rect;
  github: Rect;
  // The title's box, its font size, and where its baseline falls, as the browser sets it.
  title: Rect & { size: number; baseline: number };
  blurb: Rect & { lines: string[] };
  // The buttons over the cards' top right corner: where their row's bottom right corner is, and how much smaller than their
  // own size they are drawn, to fit a narrow window.
  actions: { right: number; bottom: number; scale: number };
  cards: CardLayout[];
  // How many days of the month are left, and where that is said: in the cells the last week leaves empty, or where it leaves
  // none, in a strip of its own under the cards.
  countdown: Rect & { left: number; strip: boolean };
};

// The buttons (spaces/buttons.tsx), in CSS pixels, as the HTML ones were: their height, the gap between them, the room either
// side of the pill's words and for its arrow, and how far above the plate round the cards they stand.
export const ACTIONS = { height: 46, gap: 10, padding: 22, arrow: 16, above: 12 };
// How far the plate comes out round the cards, in cards' widths (a card being a metre wide in the world).
// How much higher the title, the words under it and the buttons stand once out of the page, in CSS pixels: clear of the
// frame round the plate.
export const RAISE = 32;
export const PLATE_ROOM = 0.22;
export const goFonts = (fonts: Fonts) => ({ lead: `600 15px ${fonts.body}`, where: `800 18px ${fonts.body}` });
// The pill's words: where the view it goes to starts, after "Explore projects in"; how wide they are; and the pill's width.
export function goLabel(ctx: CanvasRenderingContext2D, fonts: Fonts) {
  const { lead, where } = goFonts(fonts);
  ctx.letterSpacing = "0px";
  ctx.font = lead;
  const at = ctx.measureText("Explore projects in").width + 5;
  ctx.font = where;
  const text = Math.ceil(at + Math.max(ctx.measureText("3D").width, ctx.measureText("2D").width)) + 2;
  return { at, text, w: ACTIONS.padding * 2 + text + 10 + ACTIONS.arrow };
}

const BLURB = "One word, one real-time 3D experience, every day of November 2026. WebGPU, shaders, light you can grab.";
export const LINE = 1.5;

// Where a line of text sits in its line box, as CSS places it: the font's own height centred on the line height.
export function baseline(ctx: CanvasRenderingContext2D, top: number, lineHeight: number) {
  const metrics = ctx.measureText("Hg");
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  return top + (lineHeight - (ascent + descent)) / 2 + ascent;
}

export const markFont = (fonts: Fonts) => `400 12px ${fonts.body}`;
export const titleFont = (fonts: Fonts, size: number) => `800 ${size}px ${fonts.display}`;
export const blurbFont = (fonts: Fonts) => `400 13px ${fonts.body}`;

const scratch = () => {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("No 2D canvas to measure text with.");
  return ctx;
};

function measure(ctx: CanvasRenderingContext2D, font: string, text: string, spacing = 0) {
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  return ctx.measureText(text).width;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// The widest the page goes, on a desktop; and the narrowest a card on it there, eight days to a row, and elsewhere.
const GALLERY = 1100;
const CARD = { desktop: 124, else: 150 };

export function layoutPage(width: number, height: number, fonts: Fonts): PageLayout {
  const ctx = scratch();
  // .cv-gallery: centred, 20 either side, 20 above, 60 below; at most GALLERY wide, so that on a big screen the page keeps to
  // the middle with room either side, rather than running out to the edges. .cv-gallery-head: 8 above, 44 below.
  const gallery = Math.min(width, GALLERY);
  const left = (width - gallery) / 2 + 20;
  const content = gallery - 40;
  let y = 20 + 8;

  // .cv-gallery-top: the two marks in a row, 12px at 1.5, spaced 0.08em.
  const homeWidth = measure(ctx, markFont(fonts), "Adam Chernick", 0.96);
  const githubWidth = measure(ctx, markFont(fonts), "Github", 0.96) + 8 + 14;
  const home = { x: left, y, w: homeWidth, h: 18 };
  const github = { x: left + content - githubWidth, y, w: githubWidth, h: 18 };
  y += 18;

  // h1: clamp(60px, 17vw, 250px) at a line height of 0.8, 56 above, 18 below, pulled 4 to the left; here, three quarters of
  // that, the title standing in type in front of the page, and sized to the page's width rather than the window's.
  const size = Math.min(250, Math.max(60, gallery * 0.17)) * 0.75;
  y += 56;
  const titleWidth = measure(ctx, titleFont(fonts, size), "Codevember", -0.04 * size);
  const title = { x: left - 4, y, w: titleWidth, h: size * 0.8, size, baseline: baseline(ctx, y, size * 0.8) };
  y += size * 0.8 + 18;

  // p: at most 54ch wide.
  const ch = measure(ctx, blurbFont(fonts), "0");
  const lines = wrap(ctx, BLURB, Math.min(content, 54 * ch));
  const blurb = { x: left, y, w: Math.min(content, 54 * ch), h: lines.length * 13 * LINE, lines };
  y += blurb.h;

  // .cv-grid: repeat(auto-fill, minmax(min(150px, 44vw), 1fr)) with a gap of 8, each card 4:5.
  // Each card on whole CSS pixels, as the browser paints a box: so that its words, drawn at its size, are drawn one to a
  // pixel, and the page as HTML (spaces/mirror.ts) lands on the same pixels as the GPU's.
  const least = Math.min(width >= GALLERY ? CARD.desktop : CARD.else, width * 0.44);
  const columns = Math.max(1, Math.floor((content + 8) / (least + 8)));
  const column = whole((content - (columns - 1) * 8) / columns);
  const row = whole(column * 1.25);

  // The buttons stand clear of the plate round the cards. Beside the words under the title where there is room, the cards
  // 44 below them; where there is not, on a row of their own under them, made smaller to fit if need be.
  const room = PLATE_ROOM * column + ACTIONS.above;
  const natural = 3 * (ACTIONS.height + ACTIONS.gap) + goLabel(ctx, fonts).w;
  const scale = Math.min(1, content / natural);
  let bottom: number;
  if (blurb.w + 32 + natural <= content) {
    y += 44;
    bottom = y - room;
  } else {
    bottom = y + 22 + ACTIONS.height * scale;
    y = bottom + room;
  }
  const actions = { right: left + content, bottom, scale };
  const cards = days.map((day, index) => ({
    x: whole(left + (index % columns) * (column + 8)),
    y: whole(y + Math.floor(index / columns) * (row + 8)),
    w: column,
    h: row,
    day,
    slug: daySlug(day),
    open: day.live,
    poster: day.live
  }));
  const rows = Math.ceil(days.length / columns);
  let page = y + rows * row + (rows - 1) * 8 + 60;

  const empty = rows * columns - days.length;
  const last = cards[cards.length - 1];
  // Before November, all of it; after, none.
  const now = new Date();
  const today = promptDayFor(now) ?? (now < new Date(2026, 10, 1) ? 0 : days.length);
  const remaining = Math.max(0, days.length - today);
  const countdown = empty
    ? { x: last.x + column + 8, y: last.y, w: empty * (column + 8) - 8, h: row, left: remaining, strip: false }
    : { x: left, y: page - 60 + 16, w: content, h: 64, left: remaining, strip: true };
  if (!empty) page += 80;

  return { width, height, page, home, github, title, blurb, actions, cards, countdown };
}
