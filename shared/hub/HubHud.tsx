"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { days, daySlug, promptDayFor } from "@/shared/days";
import { sound, useSoundOn } from "@/shared/engine/sound";
import { requestView, setTipElement, useHubState, useTipDay } from "./hub/state";

// Over the hub: the way between page and world, a word on walking once there, and for screen readers and keyboards, the
// calendar as plain links, since what is on screen is drawn.
export function HubHud() {
  const { view, moving } = useHubState();
  const soundOn = useSoundOn();
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia("(pointer: coarse)").matches), []);

  return (
    <div className="cv-hub-hud">
      <div className="cv-hub-actions">
        {view === "3d" ? (
          <button type="button" className="cv-pill" aria-pressed={soundOn} onClick={() => sound.toggle()}>
            {soundOn ? "Sound on" : "Sound off"}
          </button>
        ) : null}
        <button type="button" className="cv-pill" disabled={moving} onClick={() => requestView(view === "2d" ? "3d" : "2d")}>
          {view === "2d" ? "Explore projects in 3D" : "Explore projects in 2D"}
        </button>
      </div>
      <p className={`cv-hub-hint ${view === "3d" && !moving ? "cv-hub-hint-on" : ""}`} aria-hidden={view !== "3d"}>
        {touch ? "Drag to look · tap a portal to walk in" : "WASD to walk · Shift to run · drag to look · walk into a portal"}
      </p>
      <PortalTip touch={touch} go="walk in" />
      <nav className="cv-hub-links" aria-label="Codevember days">
        <h1>Codevember</h1>
        <ol>
          {days.filter((day) => day.live).map((day) => (
            <li key={day.day}>
              <Link href={`/${daySlug(day)}/`} prefetch={false}>
                Day {day.day}: {day.word}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

// Over the portal under the pointer: its day, its word, and its blurb. Placed by the hub each frame, just above the frame.
export function PortalTip({ touch, go }: { touch: boolean; go: string }) {
  const number = useTipDay();
  // The last day stays written in it while it fades away.
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    if (number) setLast(number);
  }, [number]);
  const day = days.find((item) => item.day === (number ?? last));
  const open = day ? day.live : false;
  const today = day ? promptDayFor(new Date()) === day.day : false;

  return (
    <div ref={setTipElement} className={`cv-hub-tip ${number ? "cv-hub-tip-on" : ""}`} aria-hidden="true">
      {day ? (
        <div className="cv-hub-tip-card">
          <p className="cv-hub-tip-mark">
            {String(day.day).padStart(2, "0")} · November {day.day}
            {today ? <span className="cv-hub-tip-today">Today</span> : null}
          </p>
          <p className="cv-hub-tip-word">{day.word}</p>
          {open && day.blurb ? <p className="cv-hub-tip-blurb">{day.blurb}</p> : null}
          <p className="cv-hub-tip-go">{open ? `${touch ? "Tap" : "Click"} to ${go}` : `Opens November ${day.day}`}</p>
        </div>
      ) : null}
    </div>
  );
}

