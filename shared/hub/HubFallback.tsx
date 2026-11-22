"use client";

import { days, daySlug } from "@/shared/days";
import type { Failure } from "@/shared/engine/failure";

// The hub as a plain page, for when it cannot be drawn: the graphics device lost (a phone short of memory), or no 3D at
// all. Rather than an error screen, every day that is out, with its calendar poster as an ordinary picture, so the visit
// goes on. Each link loads its day as a new page (`data-cv-full`, which HubShell leaves to the browser), with a fresh
// graphics device and, after a loss, at the lowest quality (budget.ts).
export function HubFallback({ failure }: { failure: Failure }) {
  return (
    <div className="cv-hub-fallback" role="main">
      <header>
        <h1>Codevember</h1>
        <p>One word, one real-time 3D experience, every day of November 2026.</p>
        <p className="cv-hub-fallback-note">
          {failure.kind === "no-3d" ? failure.message : "The 3D calendar stopped, usually from running short of graphics memory, so here it is as a plain page."}{" "}
          <button type="button" className="cv-pill" onClick={() => window.location.reload()}>
            Try 3D again
          </button>
        </p>
      </header>
      <ol>
        {days.filter((day) => day.live).map((day) => (
          <li key={day.day}>
            <a href={`/${daySlug(day)}/`} data-cv-full="">
              {/* A plain img: this page must not depend on the image optimiser. */}
              <img src={`/${daySlug(day)}.jpg`} alt="" width={400} height={500} loading="lazy" decoding="async" />
              <span>
                <b>{String(day.day).padStart(2, "0")}</b> {day.word}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
