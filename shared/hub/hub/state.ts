"use client";

import { useSyncExternalStore } from "react";

// Which the hub shows, the page or the world, and whether it is on its way between them. The toggle asks; the scene moves.
export type HubView = "2d" | "3d";
type HubState = { view: HubView; moving: boolean };

const listeners = new Set<() => void>();
let state: HubState = { view: "2d", moving: false };
const set = (patch: Partial<HubState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const hubState = () => state;
export const requestView = (view: HubView) => {
  if (!state.moving && state.view !== view) set({ view });
};
export const setMoving = (moving: boolean) => {
  if (state.moving !== moving) set({ moving });
};
// Straight to a view, with no move between: for coming back from a day.
export const resetView = (view: HubView) => set({ view, moving: false });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const SERVER: HubState = { view: "2d", moving: false };
export const useHubState = () => useSyncExternalStore(subscribe, () => state, () => SERVER);

// Where the visitor was when they left for a day, so that coming back puts them there again: how far down the page, and
// in the world, which portal they went through and where the month was laid out.
// `arriving` is set when coming back by the calendar button, which ends with the portal filling the screen.
export type Memory = { view: HubView; scroll: number; from?: string; anchor?: number; arriving?: boolean };
const KEY = "cv-hub";

export function remember(memory: Memory) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Private windows can refuse storage. Coming back then starts at the top of the page.
  }
}

export function recall(): Memory | null {
  try {
    const text = sessionStorage.getItem(KEY);
    return text ? (JSON.parse(text) as Memory) : null;
  } catch {
    return null;
  }
}

// The portal under the pointer in the world, for the tooltip over it. Which day changes rarely and goes through React; where
// it is on screen changes every frame and is written straight onto the tooltip's element.
const tipListeners = new Set<() => void>();
let tipDay: number | null = null;
let tipElement: HTMLElement | null = null;
export const setTipDay = (day: number | null) => {
  if (tipDay === day) return;
  tipDay = day;
  tipListeners.forEach((listener) => listener());
};
export const setTipElement = (element: HTMLElement | null) => {
  tipElement = element;
};
// The way between page and calendar: on the page it sits on the top right corner of the cards, wherever the page has
// scrolled them to, its own bottom right corner at the point given; off the page (null), back where the stylesheet has it.
let actionsElement: HTMLElement | null = null;
export const setActionsElement = (element: HTMLElement | null) => {
  actionsElement = element;
};
export const placeActions = (x: number | null, y = 0) => {
  if (!actionsElement) return;
  // Kept whole inside the window, however far off it the corner has gone.
  if (x !== null) x = Math.min(window.innerWidth - 16, Math.max(actionsElement.offsetWidth + 16, x));
  const transform = x === null ? "" : `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-100%, -100%)`;
  if (actionsElement.style.transform !== transform) actionsElement.style.transform = transform;
};
export const placeTip = (x: number, y: number) => {
  if (tipElement) tipElement.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
};
const subscribeTip = (listener: () => void) => {
  tipListeners.add(listener);
  return () => tipListeners.delete(listener);
};
export const useTipDay = () => useSyncExternalStore(subscribeTip, () => tipDay, () => null);
