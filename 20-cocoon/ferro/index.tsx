"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { normalize, positionWorld } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { Variant } from "../kit";
import { Atmosphere } from "./atmosphere";
import { Droplet } from "./droplet";
import { lightOptions, roomColour, useStudio, type Studio } from "./studio";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The studio itself, seen dimly behind the fluid: the same strips it reflects, so the reflections have somewhere to come from.
function Room({ studio }: { studio: Studio }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    m.colorNode = roomColour(studio, normalize(positionWorld)) as any;
    return m;
  }, [studio]);
  useDispose(material);
  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[40, 64, 32]} />
    </mesh>
  );
}

function Scene() {
  const studio = useStudio(useSetting<string>("ferroLight"));
  const { tier } = useQuality();
  return (
    <>
      <Room studio={studio} />
      <Droplet studio={studio} />
      <Atmosphere studio={studio} tier={tier} />
    </>
  );
}

const ferro: Variant = {
  Scene,
  settings: {
    ferroField: { type: "range", label: "Field strength", min: 0, max: 1.6, step: 0.01, value: 1, reset: 1 },
    ferroDensity: { type: "range", label: "Spike density", min: 0, max: 1, step: 0.01, value: 0.35, reset: 0.35 },
    ferroLight: { type: "choice", label: "Studio light", value: "silver", options: lightOptions },
    ferroSlam: { type: "action", label: "Magnet slam" }
  },
  view: { position: [0.6, 0.45, 6.1], target: [0, 0, 0], fov: 36 },
  look: { background: "#050506", exposure: 1, bloom: 0.25, bloomThreshold: 1, ao: 0.55, aoRadius: 0.12, vignette: 0.42, grain: 0.016 },
  hint: "Bring the pointer close and the spikes reach for it. Press and pull to draw out a tendril; let go and it melts back.",
  notes:
    "A cocoon of ferrofluid hanging in a studio of strip lights. An unseen magnet circles it, raising a crown of Rosensweig spikes that crawls slowly round; the pointer is a second magnet.",
  overview: [
    {
      title: "Surface",
      points: [
        "A dense sphere mesh displaced in TSL into an egg, a crown of spikes, a tendril, squash-and-stretch wobble and travelling ripples.",
        "Spikes sit on a spherical Fibonacci lattice, near-hexagonal like real Rosensweig peaks, found per point with Keinert's inverse mapping.",
        "Every pixel evaluates the surface three times for an exact normal, so reflections stay sharp right up the spikes."
      ]
    },
    {
      title: "Field",
      points: [
        "The lattice's pole follows the field, carried round without twisting, so the crown crawls as the magnet circles.",
        "Height, lean, tendril and wobble are underdamped springs on the CPU: everything arrives and leaves with a little jelly."
      ]
    },
    {
      title: "Light",
      points: [
        "Nothing is lit: the fluid is black, and its whole look is a Fresnel reflection of a procedural HDR studio of strips and softboxes.",
        "Reflections aimed back into the body or down between spikes are darkened, standing in for the fluid reflecting itself."
      ]
    }
  ]
};

export default ferro;
