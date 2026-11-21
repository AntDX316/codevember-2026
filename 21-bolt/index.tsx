import type { DayDefinition } from "../shared/engine/types";
import plasma from "./plasma";

// Loose takes on Bolt, each its own world, picked with ?v= in the address (development only). Loaded by a pattern
// rather than by name, so a version still being built never stops the others compiling.
const VERSIONS = ["plasma", "lichtenberg", "wingnut", "storm", "ladder", "fulgurite", "silk"];

// The version that goes out: Plasma, with the day's technical overview.
const day: DayDefinition = {
  ...plasma,
  overview: [
    {
      title: "Filaments",
      points: [
        "Up to 26 filaments, each a rope of three strands twisting round a wandering arc, laid out on the CPU each frame as camera-facing strips.",
        "White-hot cores clip to white under bloom; each fades into a wide halo of gas, and frays into forked twigs that fizz where it meets the glass."
      ]
    },
    {
      title: "Touch",
      points: [
        "A touch locks the nearest filament to it; held longer, others crawl over, then wind round it into one bundle as their energy goes to it.",
        "Every finger is its own contact, up to five; the glass under each warms to a glow that fades slowly after letting go."
      ]
    },
    {
      title: "IRL Hands",
      points: [
        "MediaPipe's hand landmarker tracks your hands from the camera in a worker, on this device, 30 times a second.",
        "Each straight fingertip within reach is smoothed with a One Euro filter, then cast through the camera onto the glass.",
        "A low-poly hand mesh is posed rigidly from the landmarks and glows where it touches; pinch to turn the view, two hands to zoom."
      ]
    },
    {
      title: "Glass and air",
      points: [
        "Added light only: a thin-shell Fresnel reflection, tip splashes, fingerprints that catch the light, and the gas glow along each view ray.",
        "The filaments are drawn again into a small target each frame, so the thick rim shows them bent; air scattering is a closed-form 1/r² line integral."
      ]
    }
  ],
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only Plasma.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "plasma") return (await import(`./${version}/index.tsx`)) as { default: DayDefinition };
  }
  return { default: day };
}
