"use client";

import type { DayDefinition, Look } from "../shared/engine/types";
import emerge from "./emerge";
import { Focus, type Variant } from "./kit";

// Loose takes on Cocoon, each its own world, picked with ?v= in the address (draft only). Loaded by a pattern rather
// than by name, so a version still being built never stops the others compiling.
const VERSIONS = ["emerge", "silk", "chrysalis", "swaddle", "swarm", "lantern", "nacre", "ferro", "nebula", "loom", "fur"];

// Laid under every version's own look.
const LOOK: Partial<Look> = { background: "#07070a", exposure: 1, bloom: 0.3, bloomThreshold: 0.9, gi: 0, ao: 0.6, aoRadius: 0.35, vignette: 0.35, grain: 0.018, haze: 0 };

// A version as a whole day: its own view, look and settings, with the lens following its focus.
function define(variant: Variant): DayDefinition {
  const { view } = variant;
  const Chosen = variant.Scene;
  const Scene = () => (
    <>
      <Focus />
      <Chosen />
    </>
  );
  const fov = view.fov ?? 36;
  return {
    camera: {
      position: view.position,
      target: view.target,
      fov,
      // Further back on a phone held upright, so the whole cocoon fits across.
      phone: variant.phoneView
        ? { position: variant.phoneView.position, target: variant.phoneView.target, fov: variant.phoneView.fov ?? fov + 8 }
        : { position: [view.position[0] * 1.35, view.position[1] * 1.35, view.position[2] * 1.35], target: view.target, fov: fov + 8 }
    },
    hover: true,
    extents: { centre: [0, 0, 0], radius: 16, color: "#e8dcc8" },
    passes: { bounce: false, haze: false, depthOfField: { range: 3 }, ...variant.passes },
    look: { ...LOOK, ...variant.look },
    settings: variant.settings,
    hint: variant.hint,
    prompt: variant.prompt,
    notes: variant.notes,
    overview: variant.overview,
    Overlay: variant.Overlay,
    phonePills: variant.phonePills,
    autoFloor: variant.autoFloor,
    maxDpr: variant.maxDpr,
    Scene
  };
}

// The version that goes out: Emerge, with the day's technical overview.
const day: DayDefinition = {
  ...define(emerge),
  hint: "Click the chrysalis to start the transformation. Hover over the butterfly to send it up to the branch, and again to let it fly away.",
  overview: [
    {
      title: "Chrysalis",
      points: [
        "Moulded per species with its anatomy (wing cases, sheaths, eye caps, ringed segments, spiracles) and cut along its real lines of weakness into a lid and two sides, which bend open about their hinges in the vertex shader on a spring with a little overshoot.",
        "Whole, it is drawn opaque with its depth faked in the shading (light through it, absorbed by its thickness, shadowed by the folded butterfly); split, it is an alpha-blended, paper-thin film. The empty shell drops and the next species' grows from a bead under the silk pad."
      ]
    },
    {
      title: "Emergence",
      points: [
        "Stepped at a fixed 1/60 s from a seed per species, whatever the frame rate, so every visitor sees the same run: the climb out and the flip onto the shell follow a plan searched over a grid of poses against the shell as drawn, each foot holding a real point of the shell and stepping in diagonal pairs.",
        "A CPU test keeps it clean: the open shell sampled into a grid of cells, every probe of body, head and legs measured against it, and each leg segment against each wing's triangles, the wing pads parting only as far as the legs need."
      ]
    },
    {
      title: "Butterfly",
      points: [
        "Wings cut from museum photographs (upper and under sides), bent per vertex as they fill and dry; the Morpho's blue is a narrow, one-way multilayer lobe that slides to violet and then dark with angle, the Glasswing's panes a second see-through pass.",
        "Legs are two-bone chains of fixed length solved toward each foothold; on the branch it walks on four in diagonal pairs. Flight is a spring steered along a path, heaved by every wingbeat, in beats and glides at the species' own rhythm."
      ]
    },
    {
      title: "Garden",
      points: [
        "One function gives the branch's surface (taper, knots, moss and the heights of a scanned bark, Poly Haven), so the mesh, the hanging point and every foothold agree. Dew is one GPU-placed mesh of small lenses showing the garden upside down.",
        "Tension's sky is drawn once into a small panorama that every reflection looks up; motes, bokeh and light shafts are additive in the overlay pass, hidden by the scene's depth; far butterflies fly on the GPU."
      ]
    },
    {
      title: "Performance",
      points: [
        "Each species' 4096² wing photograph is decoded and reduced to mips in a worker, then copied to the GPU in 2 MB strips, behind the loader or while the old shell falls rather than as the case splits. The clash test's shell grid is built a few rows a frame before it is needed.",
        "Counts and detail scale by tier (dew, motes, far butterflies, bark and shell detail); phones start on Low with 2048² wings, at one pixel per CSS pixel."
      ]
    }
  ],
  notes: "A butterfly coming out of its chrysalis under a branch in Tension's garden: the case clears and splits, it climbs out, fills and dries its wings, flies up to walk the branch, and leaves; the next one's chrysalis grows.",
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only Emerge.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "emerge") {
      const chosen = (await import(`./${version}/index.tsx`)) as { default: Variant };
      return { default: define(chosen.default) };
    }
  }
  return { default: day };
}
