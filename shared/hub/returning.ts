import { useSyncExternalStore } from "react";
import { sound } from "@/shared/engine/sound";

// Going back from a day to the hub, in three beats. "settling": the day is put back as its poster shows it and the camera
// eases to where the poster was taken from. "crossing": its last frame is held over the screen while the hub comes up
// behind it, standing at that day's portal. "arrived": the held frame fades, and the hub steps back from the portal.
type ReturnPhase = "idle" | "settling" | "crossing" | "arrived";
// `posing`: in development, posed for a poster and held there, going nowhere.
type ReturnState = { phase: ReturnPhase; frame: HTMLCanvasElement | null; ready: boolean; posing: boolean };

const listeners = new Set<() => void>();
let state: ReturnState = { phase: "idle", frame: null, ready: false, posing: false };
const set = (patch: Partial<ReturnState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const returnState = () => state;
// Whether a day is up and able to make the move back. If not, the calendar button just goes.
export const setReturnReady = (ready: boolean) => set({ ready });
export const requestReturn = (posing = false) => {
  if (state.phase !== "idle" || !state.ready) return false;
  set({ phase: "settling", posing });
  return true;
};
export const holdFrame = (frame: HTMLCanvasElement) => set({ phase: "crossing", frame });
export const arrived = () => {
  if (state.phase === "crossing") set({ phase: "arrived" });
};
export const finishReturn = () => set({ phase: "idle", frame: null, posing: false });
// A move back cut short before its frame was taken, by leaving the day some other way: the day's HUD is shown again.
export const cancelReturn = () => {
  if (state.phase !== "settling") return;
  document.documentElement.classList.remove("cv-hub-leaving");
  sound.unfadeMusic();
  set({ phase: "idle", posing: false });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const SERVER: ReturnState = { phase: "idle", frame: null, ready: false, posing: false };
export const useReturnState = () => useSyncExternalStore(subscribe, () => state, () => SERVER);
