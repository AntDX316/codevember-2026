import { useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";

// The ways the page can become the calendar, to choose between. The page itself can become the calendar where it lies: the
// camera pulls back from it, every card grows a tile's depth behind it, the plate the month stands on comes out behind them,
// the title stands up in type, and the whole turns to be seen at an angle. Or the cards can leave the page for a calendar
// elsewhere, each flying to its day's tile: for those, how long the move takes, in what order the cards leave the page, how
// far apart, how the camera travels relative to the cards, and the path each card takes. All play backwards for the way
// back to the page.

export type CardPath = {
  // Where the card starts and ends, and the point on the page under the middle of the view, for paths that spread out
  // from it.
  from: THREE.Vector3;
  to: THREE.Vector3;
  centre: THREE.Vector3;
  // How far through its own flight, 0 to 1.
  own: number;
  index: number;
};

// The page, becoming the calendar where it lies.
export type InPlace = { kind: "page"; id: string; name: string; seconds: number };

export type Flight = {
  kind: "flight";
  id: string;
  name: string;
  // Seconds from page to calendar.
  seconds: number;
  // The share of the move over which cards set off, one after another.
  stagger: number;
  // Each card's turn to leave, 0 first to 1 last, from its column and row on the page and its day's place in the month.
  order: (column: number, row: number, index: number, count: number) => number;
  // How far the camera has got, 0 to 1, when the move as a whole has got to `morph`.
  camera: (morph: number) => number;
  // The camera's swing on the way: up, and to the side.
  rise: number;
  swing: number;
  // Where the card is, written into `out`; and how far it is turned about its own face, in radians.
  path: (out: THREE.Vector3, p: CardPath) => void;
  spin: (p: CardPath) => number;
};

const arc = (out: THREE.Vector3, p: CardPath, height: number) => out.lerpVectors(p.from, p.to, p.own).setY(out.y + Math.sin(p.own * Math.PI) * height);

export type Transition = InPlace | Flight;

export const TRANSITIONS: Transition[] = [
  { kind: "page", id: "page", name: "Page to 3D", seconds: 3.4 },
  {
    // Every card lifts off the page in the month's order and arcs up to its tile, the camera rising and swinging round.
    kind: "flight",
    id: "lift",
    name: "Lift off",
    seconds: 2.8,
    stagger: 0.35,
    order: (_column, _row, index, count) => index / count,
    camera: (morph) => morph,
    rise: 4,
    swing: 0,
    path: (out, p) => arc(out, p, 2.5),
    spin: () => 0
  }
];

// Which one is in use: the page becoming the calendar in place. The flight is kept, to be chosen here.
let chosen = TRANSITIONS[0];
const listeners = new Set<() => void>();
export const transition = () => chosen;
export const chooseTransition = (id: string) => {
  chosen = TRANSITIONS.find((item) => item.id === id) ?? chosen;
  listeners.forEach((listener) => listener());
};
export const useTransition = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => chosen,
    () => TRANSITIONS[0]
  );

// In place: how each card becomes its tile, to choose between while trying them out. A card's turn comes `order` (0 first,
// 1 last, from its column and row) of `spread` into the move, and lasts `length` of it; through its turn, 0 to 1, `card`
// says how the card on the page shows and `tile` how the tile it becomes does. Both start where the card lies, so that
// neither shows where the other leaves off.
export type CardPose = { alpha: number; scale: number; turnY: number };
export type TilePose = {
  shown: boolean;
  // How deep the tile has grown behind its face, 0 to 1, and how big it is.
  depth: number;
  scale: number;
  // Turned about its top edge (x) or its middle (y), in radians, and brought toward the eye, in metres.
  roll: number;
  turnY: number;
  lift: number;
};
export type CardMove = {
  id: string;
  name: string;
  order: (column: number, row: number, columns: number, rows: number) => number;
  spread: number;
  length: number;
  card: (own: number, out: CardPose) => void;
  tile: (own: number, out: TilePose) => void;
  // Where in its own turn each card makes a sound, if it does: one after another across the month.
  sound?: number;
};

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const smooth = (t: number) => t * t * (3 - 2 * t);
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3);
// Out past the end a little and back, as a spring would.
const outBack = (t: number, s = 1.4) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const diagonal = (column: number, row: number, columns: number, rows: number) => (column + row) / Math.max(1, columns + rows - 2);

export const CARD_MOVES: CardMove[] = [
  {
    // Each tile grows its depth out behind its card, in a wave from the top left, and the card gives way to its face.
    id: "grow",
    name: "Grow",
    order: diagonal,
    spread: 0.36,
    length: 0.42,
    card: (own, out) => Object.assign(out, { alpha: 1 - smooth(span(own, 0.15, 0.6)), scale: 1, turnY: 0 }),
    tile: (own, out) => Object.assign(out, { shown: own > 0, depth: outBack(smooth(own), 1.1), scale: 1, roll: 0, turnY: 0, lift: 0 })
  },
  {
    // Laid on like stickers: each tile rolls down onto its card from its top edge, as thin as a sticker, then fills out.
    id: "roll",
    name: "Sticker roll",
    order: diagonal,
    spread: 0.4,
    length: 0.42,
    card: (own, out) => Object.assign(out, { alpha: 1 - smooth(span(own, 0.45, 0.8)), scale: 1, turnY: 0 }),
    tile: (own, out) =>
      Object.assign(out, { shown: own > 0, depth: 0.05 + 0.95 * smooth(span(own, 0.65, 1)), scale: 1, roll: (-Math.PI / 2) * (1 - outCubic(span(own, 0, 0.7))), turnY: 0, lift: 0 })
  },
  {
    // All of them shrink back into the page a little together; their tiles are drawn there, small; then all snap up to
    // full size at once, with a spring.
    id: "snap",
    name: "Shrink & snap",
    order: diagonal,
    spread: 0.1,
    length: 0.62,
    card: (own, out) => Object.assign(out, { alpha: 1 - smooth(span(own, 0.25, 0.5)), scale: 1 - 0.16 * smooth(span(own, 0, 0.35)), turnY: 0 }),
    tile: (own, out) => {
      const small = 1 - 0.16 * smooth(span(own, 0, 0.35));
      Object.assign(out, { shown: own > 0, depth: smooth(span(own, 0.2, 0.55)), scale: own < 0.5 ? small : 0.84 + 0.16 * outBack(span(own, 0.5, 1), 1.8), roll: 0, turnY: 0, lift: 0 });
    }
  },
  {
    // Each card turns away on its middle, in a wave from the top left corner, and its tile turns round to face the eye in
    // its place.
    id: "flip",
    name: "Flip",
    // In the same wave as Grow, from the top left corner out to the bottom right.
    order: diagonal,
    spread: 0.38,
    length: 0.4,
    // A flick of air as each turns edge on.
    sound: 0.5,
    card: (own, out) => Object.assign(out, { alpha: own < 0.5 ? 1 : 0, scale: 1, turnY: (Math.PI / 2) * smooth(span(own, 0, 0.5)) }),
    tile: (own, out) => Object.assign(out, { shown: own > 0.5, depth: 1, scale: 1, roll: 0, turnY: (-Math.PI / 2) * (1 - outCubic(span(own, 0.5, 1))), lift: 0 })
  },
  {
    // Out from the middle of the month: each tile pops up off the page toward the eye, growing its depth, and settles back.
    id: "pop",
    name: "Pop out",
    order: (column, row, columns, rows) => Math.hypot(column - (columns - 1) / 2, (row - (rows - 1) / 2) * 1.2) / Math.hypot((columns - 1) / 2, ((rows - 1) / 2) * 1.2),
    spread: 0.34,
    length: 0.44,
    card: (own, out) => Object.assign(out, { alpha: 1 - smooth(span(own, 0, 0.25)), scale: 1, turnY: 0 }),
    tile: (own, out) => {
      const arc = Math.sin(Math.PI * smooth(own));
      Object.assign(out, { shown: own > 0, depth: smooth(span(own, 0, 0.6)), scale: 1 + 0.07 * arc, roll: 0, turnY: 0, lift: 0.45 * arc });
    }
  }
];

// How long the move takes, in seconds.
export const PACES = [
  { id: "3.4", name: "Brisk (3.4 s)", seconds: 3.4 },
  { id: "4.5", name: "Steady (4.5 s)", seconds: 4.5 },
  { id: "6", name: "Slow (6 s)", seconds: 6 }
];

// Which card move and pace are in use: Flip, at a steady pace. chooseMove, for trying others out, from the menus kept out
// of use in SpaceHud.
let moves = { card: "flip", pace: "4.5" };
const moveListeners = new Set<() => void>();
export const cardMove = () => CARD_MOVES.find((move) => move.id === moves.card) ?? CARD_MOVES[0];
export const movePace = () => (PACES.find((pace) => pace.id === moves.pace) ?? PACES[1]).seconds;
export const chooseMove = (kind: "card" | "pace", id: string) => {
  moves = { ...moves, [kind]: id };
  moveListeners.forEach((listener) => listener());
};
export const useMoves = () =>
  useSyncExternalStore(
    (listener) => {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    () => moves,
    () => moves
  );
