import type { DayDefinition } from "../shared/engine/types";
import mirror from "./mirror";

// Loose takes on Echo, each its own world, picked with ?v= in the address (development only). Loaded by a pattern
// rather than by name, so a version still being built never stops the others compiling.
const VERSIONS = ["mirror", "rain", "whale", "ultrasound", "interference", "dust", "isoline", "ripple", "cymatic", "pressure", "afterimage", "motes", "shed", "murmur", "bubble", "nebula", "pop", "sonar", "gum"];

// The version that goes out: Mirror, with the day's technical overview.
const day: DayDefinition = {
  ...mirror,
  overview: [
    {
      title: "Mirrors",
      points: [
        "Every pixel traces its ray off the smoked-glass walls and polished floor up to ten times, so each copy is a true reflection",
        "Each reflection sees the bubble as it was a beat earlier, so the burst runs out through the copies like the sound's echoes"
      ]
    },
    {
      title: "Bubble",
      points: [
        "The letters are a distance field of melted round strokes, marched exactly in every reflection, rippled by a gusting breeze",
        "Its colours are real thin-film interference over a drained, swirling film; the tear thins it to black ahead of the rim",
        "Rays far from the film step by a cheap baked distance less a safe bound, and work the full rippled one only close in"
      ]
    },
    {
      title: "The toss and the burst",
      points: [
        "Over the bubble a graphics card is held up, with a dotted arc to the point under the pointer; a tap lobs it along that arc",
        "The burst is procedural confetti: two-fan cards and sticks of memory built from boxes and extrusions, one draw each, weightless on a drifting current",
        "Only live pieces are drawn, and the droplet spray is tested only where a ray passes each reflection's bounding sphere"
      ]
    },
    {
      title: "Air",
      points: ["A low mist on the floor, summed exactly along each ray leg, so every reflection carries it off into the haze", "Smoke stirs in the softbox's light column, and dust drifts on the same breeze as the film"]
    }
  ],
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only Mirror.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "mirror") return (await import(`./${version}/index.tsx`)) as { default: DayDefinition };
  }
  return { default: day };
}
