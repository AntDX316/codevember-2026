"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dayHref, type CodevemberDay } from "../days";
import { track } from "../engine/track";
import { LINKEDIN_URL, LinkedInIcon, REPO, SITE, X_HANDLE, XIcon } from "./social";

// Share the day: a post on X or LinkedIn already written, with the day's address, Adam to follow and the code; or just
// the link. A day with something to boast of (coins found, say) sets it with shareResult.set(), and the post leads with it.

let result: string | null = null;
const listeners = new Set<() => void>();
export const shareResult = {
  set(text: string | null) {
    result = text;
    listeners.forEach((listener) => listener());
  }
};
const useResult = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => result,
    () => null
  );

function posts(day: CodevemberDay, said: string | null) {
  const url = `${SITE}${dayHref(day)}`;
  const opening = said ?? `Just played with ${day.word}`;
  const x = `${opening}, a 3D experience by @${X_HANDLE} for #Codevember, day ${day.day} of 30. Follow him for a new one every day. It's open source: ${REPO}`;
  const linkedin = `${opening}, a 3D experience Adam Chernick built for #Codevember, day ${day.day} of 30.\n\nTry it in your browser: ${url}\n\nA new one every day; follow Adam for more: ${LINKEDIN_URL}\nIt's open source: ${REPO}`;
  return {
    url,
    text: x,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(x)}&url=${encodeURIComponent(url)}`,
    linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(linkedin)}`
  };
}

export function ShareButton({ day }: { day: CodevemberDay }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [native, setNative] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const said = useResult();
  const post = posts(day, said);

  useEffect(() => setNative(typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches), []);
  useEffect(() => shareResult.set(null), [day.day]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, { capture: true });
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away, { capture: true });
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const copy = async () => {
    track("share-copy");
    try {
      await navigator.clipboard.writeText(post.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard here; the address is in the bar anyway.
    }
  };

  return (
    <div className="cv-share" ref={root}>
      <button type="button" className="cv-pill cv-share-pill" aria-label="Share" aria-expanded={open} aria-haspopup="menu" onClick={() => (setOpen((value) => !value), !open && track("share-open"))}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M8 2v8M5 5l3-3 3 3M3 9v4h10V9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Share</span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="cv-share-menu"
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 460, damping: 32 }}
          >
            <a role="menuitem" href={post.x} target="_blank" rel="noreferrer" onClick={() => (track("share-x"), setOpen(false))}>
              <XIcon /> Post on X
            </a>
            <a role="menuitem" href={post.linkedin} target="_blank" rel="noreferrer" onClick={() => (track("share-linkedin"), setOpen(false))}>
              <LinkedInIcon /> Post on LinkedIn
            </a>
            <button type="button" role="menuitem" onClick={copy}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              {copied ? "Copied" : "Copy link"}
            </button>
            {native ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  track("share-native");
                  setOpen(false);
                  navigator.share({ title: `${day.word}, Codevember day ${day.day}`, text: post.text, url: post.url }).catch(() => {});
                }}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path d="M8 2v8M5 5l3-3 3 3M3 9v4h10V9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                More…
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
