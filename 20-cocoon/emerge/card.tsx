"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { SPECIES, type SpeciesName } from "./species";

// What is laid over the view in screen space: a card about the butterfly, which fades in as it comes out, and a small
// caption that rides beside it when it is waiting for a hand. The scene writes here; nothing here re-renders the scene.

type State = {
  species: SpeciesName;
  // The card has something to say (a butterfly is out), and whether it is open or folded down to its name.
  shown: boolean;
  open: boolean;
  // The caption beside the butterfly, or none.
  hint: string | null;
  // The making of the butterfly, as a bar of its stages: whether it shows, the count beside it (a day of so many, or
  // a clock) with its unit, which stage it is in and that stage said in full, and whether it is still a chrysalis.
  meter: boolean;
  count: string;
  unit: string;
  stage: number;
  saying: string;
  chrysalis: boolean;
};

let state: State = { species: "morpho", shown: false, open: false, hint: null, meter: false, count: "", unit: "", stage: 0, saying: "", chrysalis: true };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const set = (next: Partial<State>) => {
  let changed = false;
  for (const key of Object.keys(next) as (keyof State)[]) if (state[key] !== next[key]) changed = true;
  if (!changed) return;
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

// Where the caption goes on the screen (its top middle), in CSS pixels from the top left of the view: written every
// frame by the scene, beside the butterfly.
export const anchor = { x: 0, y: 0 };

// How far along the bar is, written every frame by the scene and drawn here without a render: 0 to STAGES.length.
export const meter = { p: 0 };

// The stages of its making, in order, each with a few strokes of a picture (24 by 24): only what really happens.
export const STAGES: { name: string; draw: string }[] = [
  // A bead of new chrysalis under its silk pad.
  { name: "Forms", draw: "M7 4h10M12 4v3M12 7c-2.6 3-3.4 5-3.4 6.6a3.4 3.4 0 0 0 6.8 0C15.4 12 14.6 10 12 7z" },
  // Its skin sets hard into the chrysalis' shape.
  { name: "Hardens", draw: "M7 3h10M12 3v2M12 5c-3.4 2-4.6 5.4-4.2 9 .4 3.4 2 6 4.2 7 2.2-1 3.8-3.6 4.2-7 .4-3.6-.8-7-4.2-9zM8.6 9.5h6.8M8 12.5h8" },
  // The butterfly is built inside: a wing laid down in the case.
  { name: "Wings form", draw: "M12 3c-3.4 2-4.6 5.6-4.2 9.4.4 3.4 2 6.2 4.2 7.6 2.2-1.4 3.8-4.2 4.2-7.6.4-3.8-.8-7.4-4.2-9.4zM12 8c2.4.8 3.4 2.8 3.2 5-1.4.6-2.6 1.8-3.2 3.6z" },
  // Its colours show through the shell.
  { name: "Colours", draw: "M12 3c-3.4 2-4.6 5.6-4.2 9.4.4 3.4 2 6.2 4.2 7.6 2.2-1.4 3.8-4.2 4.2-7.6.4-3.8-.8-7.4-4.2-9.4zM12 8c2.4.8 3.4 2.8 3.2 5-1.4.6-2.6 1.8-3.2 3.6zM13.4 10.6h.01M14 13h.01M12.9 12.2h.01" },
  // The shell goes clear.
  { name: "Clears", draw: "M12 3c-3.4 2-4.6 5.6-4.2 9.4.4 3.4 2 6.2 4.2 7.6M12 3c3.4 2 4.6 5.6 4.2 9.4-.4 3.4-2 6.2-4.2 7.6M12 7.5v8.5M10 9.5c-.8 1.6-.8 3.6 0 5.4M14 9.5c.8 1.6.8 3.6 0 5.4" },
  // It splits down the front.
  { name: "Splits", draw: "M12 3c-3.4 2-4.6 5.6-4.2 9.4.3 2.4 1.2 4.6 2.4 6.2M12 3c3.4 2 4.6 5.6 4.2 9.4-.3 2.4-1.2 4.6-2.4 6.2M12 9l-1.2 2.6 2.2 2.2-1.6 2.8 1 3.4" },
  // It climbs out, head and legs first.
  { name: "Climbs out", draw: "M12 2c-2.8 1.6-3.8 4.4-3.6 7.2M12 2c2.8 1.6 3.8 4.4 3.6 7.2M8.4 9.2l-1.6 3.4M15.6 9.2l1.6 3.4M12 9v9M12 18a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM10.4 12l-3 2.4M13.6 12l3 2.4M10.6 14.6l-2.4 2.6M13.4 14.6l2.4 2.6" },
  // Its wings fill.
  { name: "Wings fill", draw: "M12 5v13M12 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 8c-2.2-.4-4 .6-4.6 2.4-.4 1.4.2 2.8 1.4 3.4 1.2.4 2.4-.2 3.2-1.4M12 8c2.2-.4 4 .6 4.6 2.4.4 1.4-.2 2.8-1.4 3.4-1.2.4-2.4-.2-3.2-1.4" },
  // They dry, held out full.
  { name: "Wings dry", draw: "M12 5v14M12 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 7.5C8.6 5.6 5 7 4.4 10.4c-.5 3 1.4 5.2 4 5.4-.4 2.2.8 4 2.6 4.2.4 0 .8-.2 1-.6M12 7.5c3.4-1.9 7-.5 7.6 2.9.5 3-1.4 5.2-4 5.4.4 2.2-.8 4-2.6 4.2-.4 0-.8-.2-1-.6" },
  // And it flies.
  { name: "First flight", draw: "M12 10v8M12 10C9.4 5.4 5 3.6 2.6 5.6c-1.6 2.2.4 6.4 4.8 7.2 1.8.2 3.4-.4 4.6-2.8zM12 10c2.6-4.6 7-6.4 9.4-4.4 1.6 2.2-.4 6.4-4.8 7.2-1.8.2-3.4-.4-4.6-2.8zM11 9l-1.6-3.4M13 9l1.6-3.4" }
];

// When the card was last opened, so that it folds itself away after a while.
let openedAt = 0;
const LINGER = 26000;

export const card = {
  show(species: SpeciesName) {
    openedAt = performance.now();
    // (On a phone it comes folded to its tab: the screen is the butterfly's.)
    set({ species, shown: true, open: !window.matchMedia("(max-width: 600px)").matches });
  },
  hide() {
    set({ shown: false, open: false });
  },
  hint(text: string | null) {
    set({ hint: text });
  },
  // The bar: `progress` runs 0 to STAGES.length, each stage one unit (the whole part is the stage it is in).
  status(species: SpeciesName, progress: number, count: string, unit: string, saying: string, chrysalis: boolean) {
    meter.p = progress;
    set({ species, meter: true, count, unit, stage: Math.min(STAGES.length - 1, Math.floor(progress)), saying, chrysalis });
  },
  noStatus() {
    set({ meter: false });
  },
  get state() {
    return state;
  }
};

const CSS = `
.em-card { position: absolute; left: max(20px, env(safe-area-inset-left)); top: clamp(206px, 24vh, 260px); width: 268px; padding: 16px 18px 15px; border-radius: 14px; border: 1px solid var(--cv-line); background: var(--cv-glass); -webkit-backdrop-filter: blur(22px) saturate(1.3); backdrop-filter: blur(22px) saturate(1.3); color: var(--cv-ink); transition: opacity 0.9s ease, transform 0.9s var(--cv-ease); opacity: 0.004; transform: translateY(10px); pointer-events: none; will-change: opacity, transform; }
.em-card.em-on { opacity: 1; transform: none; pointer-events: auto; transition: opacity 1.4s ease, transform 1.4s var(--cv-ease); }
.em-card h2 { margin: 0; font-family: var(--font-display), Arial, sans-serif; font-weight: 800; font-size: 25px; line-height: 1; letter-spacing: -0.02em; color: var(--cv-ink); }
.em-card em { display: block; margin-top: 5px; font-size: 13px; color: var(--cv-dim); }
.em-card dl { margin: 13px 0 0; padding: 11px 0 0; border-top: 1px solid var(--cv-line); display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12px; line-height: 1.4; }
.em-card dt { color: var(--cv-dim); }
.em-card dd { margin: 0; }
.em-card ul { margin: 11px 0 0; padding: 11px 0 0; border-top: 1px solid var(--cv-line); list-style: none; display: grid; gap: 8px; font-size: 12px; line-height: 1.45; color: rgba(242, 239, 233, 0.86); }
.em-card li { padding-left: 12px; position: relative; }
.em-card li::before { content: ""; position: absolute; left: 0; top: 0.6em; width: 4px; height: 4px; border-radius: 50%; background: var(--cv-accent); }
.em-x { appearance: none; position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--cv-dim); font: inherit; font-size: 17px; line-height: 1; cursor: pointer; }
.em-x:hover { color: var(--cv-ink); background: var(--cv-line); }
.em-tab { appearance: none; position: absolute; left: max(20px, env(safe-area-inset-left)); top: clamp(206px, 24vh, 260px); min-height: 34px; padding: 0 14px 0 12px; border-radius: 999px; border: 1px solid var(--cv-line); background: var(--cv-glass); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); color: var(--cv-ink); font: inherit; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: opacity 0.6s ease, visibility 0s linear 0.6s; opacity: 0; visibility: hidden; pointer-events: none; }
.em-tab.em-on { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity 0.8s ease 0.5s, visibility 0s; }
.em-tab i { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--cv-faint); font-style: italic; font-size: 10px; display: grid; place-items: center; font-family: Georgia, serif; }
.em-meter { position: absolute; top: max(14px, env(safe-area-inset-top)); left: 376px; right: 480px; min-width: 520px; padding: 13px 18px 12px; border-radius: 16px; border: 1px solid var(--cv-line); background: var(--cv-glass); -webkit-backdrop-filter: blur(22px) saturate(1.3); backdrop-filter: blur(22px) saturate(1.3); color: var(--cv-ink); pointer-events: none; opacity: 0; transform: translateY(-8px); transition: opacity 0.9s ease, transform 0.9s var(--cv-ease); display: grid; grid-template-columns: auto 1fr; column-gap: 20px; align-items: center; }
.em-meter.em-on { opacity: 1; transform: none; }
.em-count { display: flex; flex-direction: column; gap: 3px; min-width: 104px; }
.em-count b { font-family: var(--font-display), Arial, sans-serif; font-weight: 800; font-size: 34px; line-height: 0.95; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.em-count small { font-size: 12px; color: var(--cv-dim); white-space: nowrap; }
.em-way { min-width: 0; }
.em-name { display: flex; align-items: baseline; gap: 9px; font-size: 13px; margin-bottom: 9px; white-space: nowrap; overflow: hidden; }
.em-name strong { font-weight: 600; }
.em-name em { color: var(--cv-dim); font-size: 12px; }
.em-name span { margin-left: auto; color: var(--cv-accent); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
.em-steps { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
.em-step { display: grid; justify-items: center; gap: 5px; color: var(--cv-faint); transition: color 0.6s ease; }
.em-step svg { width: 34px; height: 34px; fill: none; stroke: currentColor; stroke-width: 1.15; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.6s var(--cv-ease); }
.em-step u { text-decoration: none; font-size: 9.5px; line-height: 1.15; text-align: center; letter-spacing: 0.01em; white-space: nowrap; }
.em-step.em-done { color: var(--cv-dim); }
.em-step.em-now { color: var(--cv-ink); }
.em-step.em-now svg { transform: scale(1.15); stroke: var(--cv-accent); fill: rgba(255, 180, 138, 0.14); }
.em-track { position: relative; height: 5px; margin: 7px 0 0; border-radius: 3px; background: var(--cv-line); }
.em-track i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; clip-path: inset(0 100% 0 0 round 3px); background: linear-gradient(90deg, rgba(255, 180, 138, 0.55), var(--cv-accent)); }
.em-track s { position: absolute; top: -3px; width: 1px; height: 11px; background: var(--cv-faint); }
@media (max-width: 1700px) { .em-meter { right: 344px; min-width: 0; } }
@media (max-width: 1340px) { .em-step u { display: none; } }
@media (max-width: 1180px) { .em-meter { left: 20px; right: 300px; top: 196px; } .em-name em { display: none; } .em-card, .em-tab { top: 300px; } }
.em-hint { position: absolute; left: 0; top: 0; padding: 7px 13px; border-radius: 999px; border: 1px solid var(--cv-line); background: rgba(16, 17, 21, 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: rgba(242, 239, 233, 0.9); font-size: 12px; letter-spacing: 0.01em; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.7s ease; will-change: transform; }
.em-hint.em-on { opacity: 1; transition: opacity 1.2s ease; }
@media (max-width: 900px), (hover: none) {
  .em-card { top: calc(max(16px, env(safe-area-inset-top)) + 46px); left: max(14px, env(safe-area-inset-left)); width: min(232px, 60vw); padding: 12px 13px 11px; border-radius: 12px; }
  .em-card h2 { font-size: 19px; }
  .em-card em { font-size: 11.5px; margin-top: 3px; }
  .em-card dl { margin-top: 9px; padding-top: 8px; font-size: 11px; gap: 4px 9px; line-height: 1.35; }
  .em-card ul { margin-top: 8px; padding-top: 8px; font-size: 11px; gap: 6px; line-height: 1.38; }
  .em-card li:nth-child(n + 2) { display: none; }
  .em-tab { top: calc(max(16px, env(safe-area-inset-top)) + 46px); left: max(14px, env(safe-area-inset-left)); }
  .em-hint { font-size: 11.5px; padding: 6px 11px; }
  .em-meter { top: calc(max(16px, env(safe-area-inset-top)) + 46px); left: max(12px, env(safe-area-inset-left)); right: 138px; min-width: 0; padding: 9px 11px 9px; border-radius: 12px; column-gap: 11px; }
  .em-count { min-width: 0; }
  .em-count b { font-size: 22px; }
  .em-count small { font-size: 10.5px; }
  .em-name { font-size: 11.5px; margin-bottom: 6px; gap: 6px; }
  .em-name em, .em-name strong, .em-step svg, .em-step u { display: none; }
  .em-name span { margin-left: 0; }
  .em-name span { font-size: 11px; }
  .em-steps { display: none; }
  .em-track { margin-top: 0; }
  .em-card, .em-tab { top: calc(max(16px, env(safe-area-inset-top)) + 122px); }
}
@media (max-height: 820px) and (min-width: 901px) { .em-card li:nth-child(n + 3) { display: none; } }
@media (max-height: 700px) and (min-width: 901px) { .em-card ul { display: none; } }
@media (max-height: 520px) { .em-card ul { display: none; } .em-card, .em-tab { top: 70px; } }
`;

export function Overlay() {
  const now = useSyncExternalStore(subscribe, () => state, () => state);
  const info = SPECIES[now.species].info;
  const hint = useRef<HTMLDivElement>(null);
  // Kept while it fades, so the words do not vanish before the pill does.
  const lastHint = useRef("");
  if (now.hint) lastHint.current = now.hint;
  const fill = useRef<HTMLElement>(null);
  const shown = useRef(0);

  // Folds itself away after a while; opening it again starts the wait over.
  useEffect(() => {
    if (!now.open) return;
    const left = Math.max(1000, LINGER - (performance.now() - openedAt));
    const timer = window.setTimeout(() => set({ open: false }), left);
    return () => window.clearTimeout(timer);
  }, [now.open, now.species]);

  // The caption's width and the window's size, read only when the words or the window change.
  const size = useRef({ hint: 0, width: 1, height: 1, at: "", left: "" });
  useEffect(() => {
    const read = () => {
      size.current.hint = hint.current?.offsetWidth ?? 0;
      size.current.width = window.innerWidth;
      size.current.height = window.innerHeight;
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [now.hint]);

  // The caption follows the butterfly, below it and clear of its wings, kept on the screen.
  useEffect(() => {
    let frame = 0;
    const place = () => {
      // (Nothing is measured here: sizes are read when they change, below, so a frame never waits on a layout.)
      const el = hint.current;
      const w = size.current.hint;
      const x = Math.min(size.current.width - w - 12, Math.max(12, anchor.x - w / 2));
      const y = Math.min(size.current.height - 120, Math.max(70, anchor.y));
      const to = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (el && to !== size.current.at) el.style.transform = size.current.at = to;
      // The bar fills smoothly: eased toward where the scene says it is.
      shown.current += (meter.p - shown.current) * 0.12;
      const left = (100 - Math.min(100, (shown.current / STAGES.length) * 100)).toFixed(2);
      if (fill.current && left !== size.current.left) fill.current.style.clipPath = `inset(0 ${(size.current.left = left)}% 0 0 round 3px)`;
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <aside className={`em-card ${now.shown && now.open ? "em-on" : ""}`} aria-live="polite" aria-hidden={!(now.shown && now.open)}>
        <button className="em-x" type="button" aria-label="Close" onClick={() => set({ open: false })}>
          ×
        </button>
        <h2>{info.name}</h2>
        <em>{info.latin}</em>
        <dl>
          <dt>Lives</dt>
          <dd>{info.range}</dd>
          <dt>Wingspan</dt>
          <dd>{info.wingspan}</dd>
        </dl>
        <ul>
          {info.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </aside>
      <button
        className={`em-tab ${now.shown && !now.open ? "em-on" : ""}`}
        type="button"
        onClick={() => {
          openedAt = performance.now();
          set({ open: true });
        }}
      >
        <i>i</i>
        {info.name}
      </button>
      <div className={`em-meter ${now.meter ? "em-on" : ""}`} aria-hidden={!now.meter}>
        <div className="em-count">
          <b>{now.count}</b>
          <small>{now.unit}</small>
        </div>
        <div className="em-way">
          <div className="em-name">
            <strong>{now.chrysalis ? `${info.name} chrysalis` : info.name}</strong>
            <em>{info.latin}</em>
            <span>{now.saying}</span>
          </div>
          <div className="em-steps">
            {STAGES.map((stage, i) => (
              <div key={stage.name} className={`em-step ${i < now.stage ? "em-done" : i === now.stage ? "em-now" : ""}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={stage.draw} />
                </svg>
                <u>{stage.name}</u>
              </div>
            ))}
          </div>
          <div className="em-track">
            <i ref={fill} />
            {STAGES.slice(1).map((stage, i) => (
              <s key={stage.name} style={{ left: `${((i + 1) / STAGES.length) * 100}%` }} />
            ))}
          </div>
        </div>
      </div>
      <div ref={hint} className={`em-hint ${now.hint ? "em-on" : ""}`}>
        {lastHint.current}
      </div>
    </>
  );
}
