"use client";

// The air of this scene, in place of Tension's <Air>: see Motes in dust.tsx. One instance serves every weather (it
// follows the sky's uniforms), so mount it once, outside the per-weather groups. It draws in the overlay pass: the day
// must ask for `passes.overlay`.
export { Motes, makeMotes } from "./dust";
