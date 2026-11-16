"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useSyncExternalStore } from "react";
import { promptDayFor } from "../days";
import { sound } from "../engine/sound";
import { track } from "../engine/track";
import { LINKEDIN_URL, LinkedInIcon, X_URL, XIcon } from "./social";

// A small toast offering to follow Adam, once a visit, when someone has properly played: when a day's own moment has come
// (the day calls followPrompt.earn() there; trying three different settings counts on every day), but never before
// 20 seconds of real play; and after 35 seconds of it anyway. It never takes the pointer from the scene or pauses
// anything, and its links open in a new tab, so the day carries on behind them.

const SEEN = "cv-follow-seen";
// Seconds of real play before it may show, however soon the day's moment came; and after which it shows regardless.
const SOONEST = 20;
const LATEST = 35;
// Different settings tried that count as playing properly.
const TRIED = 3;
// It lets itself out again after this long.
const STAYS = 30_000;

let shown = false;
let earned = "";
let played = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const seen = () => {
  try {
    return sessionStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
};

function show(why: string) {
  if (shown || seen()) return;
  try {
    sessionStorage.setItem(SEEN, "1");
  } catch {
    // Without storage it can only be kept to once a page.
  }
  shown = true;
  emit();
  track(`follow-shown-${why}`);
  // A soft two-note rise, like a message arriving.
  sound.play("ping", { gain: 0.07, pitch: 1.2 });
  window.setTimeout(() => sound.play("ping", { gain: 0.06, pitch: 1.5 }), 130);
}
// Shows it if it is time: the moment come and enough played, or played long enough.
function check() {
  if (earned && played >= SOONEST) show(earned);
  else if (played >= LATEST) show("time");
}

export const followPrompt = {
  // The day's own moment has come (`why` is counted with it); the toast follows once enough has been played.
  earn(why = "payoff") {
    if (!earned) earned = why;
    check();
  },
  hide() {
    if (!shown) return;
    shown = false;
    emit();
  }
};
export const useFollowPrompt = () => followPrompt;

function useShown() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
    () => false
  );
}

// Counts seconds of real play (the page visible and focused, and touched in the last few seconds), and the different
// settings tried, from the day's panel or its pills.
function usePlay(dayNumber: number) {
  useEffect(() => {
    played = 0;
    earned = "";
    // While developing, ?follow on the address forgets it has been seen, to watch it come as it would on a first visit.
    if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).has("follow")) {
      try {
        sessionStorage.removeItem(SEEN);
      } catch {
        // Nothing kept to clear.
      }
    }
    if (seen()) return;
    let last = 0;
    const tried = new Set<string>();
    const touched = () => (last = performance.now());
    const pressed = (event: Event) => {
      touched();
      const control = (event.target as Element | null)?.closest?.("#cv-panel button, #cv-panel input, .cv-phone-pills button");
      const label = control?.textContent?.trim() || control?.getAttribute("aria-label") || (control as HTMLInputElement | null)?.name;
      if (!control || !label || tried.has(label)) return;
      tried.add(label);
      if (tried.size >= TRIED) followPrompt.earn("settings");
    };
    window.addEventListener("pointerdown", pressed, { passive: true });
    window.addEventListener("pointermove", touched, { passive: true });
    window.addEventListener("wheel", touched, { passive: true });
    window.addEventListener("keydown", touched);
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus() && performance.now() - last < 6000) played += 1;
      check();
    }, 1000);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("pointerdown", pressed);
      window.removeEventListener("pointermove", touched);
      window.removeEventListener("wheel", touched);
      window.removeEventListener("keydown", touched);
    };
  }, [dayNumber]);
}

export function FollowCard({ dayNumber }: { dayNumber: number }) {
  const open = useShown();
  usePlay(dayNumber);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => followPrompt.hide(), STAYS);
    return () => window.clearTimeout(timer);
  }, [open]);
  // A new day starts clean.
  useEffect(() => () => followPrompt.hide(), [dayNumber]);

  const today = promptDayFor(new Date());
  const left = today ? 30 - today : 0;

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className="cv-follow"
          aria-label="Follow Adam"
          initial={{ opacity: 0, y: 44, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.25 } }}
          transition={{ type: "spring", stiffness: 260, damping: 20, mass: 0.9 }}
        >
          <i className="cv-follow-shine" aria-hidden="true" />
          <p className="cv-follow-text">
            <strong>Follow Adam for more</strong>
            <span>A new 3D experience every day{left > 0 ? `, ${left} to go` : ""}.</span>
          </p>
          <a className="cv-follow-link" href={X_URL} target="_blank" rel="noreferrer" aria-label="Follow Adam on X" onClick={() => track("follow-card-x")}>
            <XIcon size={15} />
          </a>
          <a className="cv-follow-link" href={LINKEDIN_URL} target="_blank" rel="noreferrer" aria-label="Follow Adam on LinkedIn" onClick={() => track("follow-card-linkedin")}>
            <LinkedInIcon size={15} />
          </a>
          <button type="button" className="cv-follow-close" aria-label="Close" onClick={() => (track("follow-closed"), followPrompt.hide())}>
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
