"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { days, daySlug } from "@/shared/days";
import { sound, useSoundOn } from "@/shared/engine/sound";
import { GithubIcon, REPO } from "@/shared/ui/github";
import { LINKEDIN_URL, LinkedInIcon, X_URL, XIcon } from "@/shared/ui/social";
import { PortalTip } from "../HubHud";
import { requestView, setActionsElement, useHubState } from "../hub/state";
import { SPACE } from "./list";
// import { chooseSound, hubSound, SOUND_KINDS, useSounds, type SoundKind } from "../sounds";
// import { CARD_MOVES, chooseMove, PACES, useMoves } from "./transitions";
import { useTransition } from "./transitions";

// Over the hub: Adam's name home at the top left; the way between the page and the 3D calendar, with where else Adam is
// beside it, over the cards' top right corner (drawn solid in the scene, in place, and kept here out of sight); sound, in the
// world, at the top right; a word on getting about; the tooltip over the day pointed at; and the month as
// plain links for screen readers and keyboards, since what is on screen is drawn.
export function SpaceHud() {
  const { view, moving } = useHubState();
  const soundOn = useSoundOn();
  const chosen = useTransition();
  // const moves = useMoves();
  // const sounds = useSounds();
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia("(pointer: coarse)").matches), []);
  const follow = chosen.kind === "page";

  return (
    <div className={`cv-hub-hud cv-space-hud ${view === "3d" ? "cv-space-hud-world" : ""} ${follow ? "cv-space-hud-follow" : ""}`}>
      <div className="cv-space-marks">
        {view === "3d" ? (
          <button type="button" className="cv-pill" aria-pressed={soundOn} onClick={() => sound.toggle()}>
            {soundOn ? "Sound on" : "Sound off"}
          </button>
        ) : null}
      </div>
      {/* In place, the scene draws these as solid buttons on the page; here they stay, out of sight, for keyboards and screen readers. */}
      <div className={`cv-hub-actions ${view === "2d" ? "cv-hub-actions-page" : ""} ${follow ? "cv-hub-actions-solid" : ""}`} ref={setActionsElement}>
        <nav className="cv-space-social" aria-label="Adam elsewhere">
          <a className="cv-mark" href={X_URL} target="_blank" rel="noreferrer">
            X
            <XIcon size={13} />
          </a>
          <a className="cv-mark" href={REPO} target="_blank" rel="noreferrer">
            Github
            <GithubIcon size={14} />
          </a>
          <a className="cv-mark" href={LINKEDIN_URL} target="_blank" rel="noreferrer">
            LinkedIn
            <LinkedInIcon size={14} />
          </a>
        </nav>
        <button type="button" className="cv-space-go" disabled={moving} onClick={() => requestView(view === "2d" ? "3d" : "2d")}>
          {view === "2d" ? "Explore projects in 3D" : "Back to 2D"}
          <span aria-hidden="true">→</span>
        </button>
      </div>
      {/* The Cards and Speed menus, for trying out how the cards become the calendar's tiles and how long it takes: Flip at
      Steady was chosen (transitions.ts). Kept here, out of use, to bring back in place of nothing on the page, at the top right.
      <div className="cv-space-settings">
        <label className="cv-pill cv-space-choice">
          <span className="cv-space-choice-label">Cards</span>
          <select value={moves.card} disabled={moving} onChange={(event) => chooseMove("card", event.target.value)}>
            {CARD_MOVES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="cv-pill cv-space-choice">
          <span className="cv-space-choice-label">Speed</span>
          <select value={moves.pace} disabled={moving} onChange={(event) => chooseMove("pace", event.target.value)}>
            {PACES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      */}
      {/* The Sounds panel, for trying the hub's sounds out: hover Bubble, press Pop and move Chord bloom were chosen
      (sounds.ts). Kept here, out of use, to bring back for trying others.
      <details className="cv-space-sounds">
        <summary className="cv-pill">Sounds</summary>
        {(Object.keys(SOUND_KINDS) as SoundKind[]).map((kind) => (
          <label key={kind} className="cv-pill cv-space-choice">
            <span className="cv-space-choice-label">{{ hover: "Hover", press: "2D/3D press", move: "2D/3D move" }[kind]}</span>
            <select
              value={sounds[kind]}
              onChange={(event) => {
                // Heard as soon as it is chosen.
                chooseSound(kind, event.target.value);
                hubSound(kind);
              }}
            >
              {SOUND_KINDS[kind].map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </details>
      */}
      <p className={`cv-hub-hint ${view === "3d" && !moving ? "cv-hub-hint-on" : ""}`} aria-hidden={view !== "3d"}>
        {touch ? SPACE.touchHint : SPACE.hint}
      </p>
      <PortalTip touch={touch} go="enter" />
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
