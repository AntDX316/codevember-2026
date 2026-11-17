"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { orbitPoint } from "../shared/engine/controls";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { useSetting } from "../shared/engine/settings";
import { useQuality } from "../shared/engine/quality";
import { useMusic } from "../shared/engine/sound";
import { StudioEnvironment } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { COLOURWAYS, Glass, type GlassKind } from "./glass";
import { CausticPass } from "./light";
import { Backdrop, Floor } from "./set";
import { Compass } from "./compass";
import { SwitchingBar, switching } from "./switching";

// Studies of caustics: light bent by glass and gathered into bright colours where it lands.
const STUDIES = [
  { value: "marbles", label: "Marbles" },
  { value: "orbs", label: "Orbs" },
  { value: "blocks", label: "Blocks" },
  { value: "monkeys", label: "Suzanne" }
];

const BACKGROUND = "#0c0a09";

// Keeps the lens on whatever the camera is looking at, so the far table and the room fall softly out of focus.
function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (orbitPoint.current) focusDistance.value = Math.max(0.5, camera.position.distanceTo(orbitPoint.current));
    focusBlur.value = 1.1;
  });
  return null;
}

// A warm satin table in a pool of low sun, falling away into the dark.
function Scene() {
  const study = useSetting<string>("study");
  const colourway = useSetting<string>("colourway");
  // The study on the table. A new one is put out only once the loading bar has had a chance to show, as building it
  // stalls the page.
  const [shown, setShown] = useState(study);
  // Every other study is built too while the page first loads, out of sight behind the loader, so that its shaders are
  // ready and switching to it later is quick. Each is put away once it has drawn without stalling. Not Suzanne, whose
  // light needs maps of her drawn from the sun and is the heaviest to build: she is built when chosen. And not on a
  // phone at all: there several sets of glass and their light at once are more than it can hold.
  const { tier } = useQuality();
  const [warming, setWarming] = useState(() => (tier === "low" ? [] : STUDIES.map((s) => s.value).filter((value) => value !== study && value !== "monkeys")));
  const warmed = (value: string) => setWarming((list) => list.filter((item) => item !== value));
  useEffect(() => {
    if (study === shown) return;
    switching.start(STUDIES.find((s) => s.value === study)?.label ?? "the glass");
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(study));
    });
    return () => cancelAnimationFrame(frame);
  }, [study, shown]);
  useMusic("/codevember/music/born-to-rise.mp3", 0.2);
  return (
    <>
      <Backdrop top="#1c1714" horizon="#0b0908" bottom={BACKGROUND} />
      <Focus />
      {/* Soft boxes for the glass to catch: a warm one behind for rims, cool on the left, a little overhead. */}
      <StudioEnvironment
        ambient="#080706"
        intensity={0.6}
        boxes={[
          { position: [0, 7, 0], scale: [5, 0.2, 5], color: "#fff3e6", intensity: 0.7 },
          { position: [-7, 2.5, 2], scale: [0.2, 5, 2], color: "#bcd0ff", intensity: 1.8 },
          { position: [7, 2.5, -1], scale: [0.2, 5, 2], color: "#ffdcbd", intensity: 1.6 },
          { position: [0, 2.2, -8], scale: [9, 2.2, 0.2], color: "#ffc58a", intensity: 3.2 }
        ]}
      />
      <Floor albedo="#6a5a4c" background="#0b0908" grain={0.1} roughness={0.42} radius={6} />
      <CausticPass />
      <Glass key={shown} kind={shown as GlassKind} colourway={colourway} onReady={switching.done} />
      {warming.map((value) => (
        <Glass key={`warm-${value}`} kind={value as GlassKind} warming onReady={() => warmed(value)} />
      ))}
    </>
  );
}

const caustic: DayDefinition = {
  camera: { position: [0.58, 1.02, 1.93], target: [0.2, 0, -0.05], fov: 34 },
  phonePills: ["study"],
  extents: { centre: [0, 1, 0], radius: 20, floor: 0.05, color: "#ffe2b8" },
  passes: { haze: false, bounce: false, depthOfField: { range: 5 } },
  // Glowing light for the glass: the caustics bloom, and the edges of the room sink into shadow.
  look: { background: BACKGROUND, exposure: 1.2, bloom: 0.42, bloomThreshold: 0.75, gi: 3, ao: 1, aoRadius: 0.3, vignette: 0.58, grain: 0.012 },
  settings: {
    study: { type: "choice", label: "Study", value: "marbles", options: STUDIES },
    colourway: {
      type: "choice",
      label: "Colours",
      value: "mixed",
      options: Object.entries(COLOURWAYS).map(([value, swatch]) => ({ value, label: value[0].toUpperCase() + value.slice(1), swatch: swatch.slice(0, 3) }))
    }
  },
  hint: "Drag the glass about to push the pieces around, and turn the dial to move the sun.",
  Overlay: () => (
    <>
      <SwitchingBar />
      <Compass />
    </>
  ),
  notes: "Coloured glass on a table in low sun, its light bent and gathered into bright colours on the wood.",
  overview: [
    {
      title: "Rendering",
      points: [
        "R3F and three.js r187 on WebGPU, every surface a TSL node material; the glass is transmission with dispersion and thickness absorption.",
        "Every study is built out of sight during first load, so its shaders are compiled before it is chosen."
      ]
    },
    {
      title: "Caustics",
      points: [
        "Light is a mesh, after Evan Wallace: one ray per vertex traced in the vertex shader, brightness as triangle area before over after.",
        "Marbles, orbs and blocks are traced exactly by ray-sphere and ray-box, each colour band bending a little more to split edges into a spectrum.",
        "Suzanne is drawn from the sun into near and far normal-depth maps; each ray bends in, walks the far map, and bends out."
      ]
    },
    {
      title: "Table",
      points: [
        "All light is summed into one softened top-down map, recomputed only when a piece or the sun moves.",
        "Pieces roll on a pull to the centre, mass as size cubed; Suzannes rest as dropped in Rapier and collide as a few circles.",
        "The dial turns the sun, and colourways retint glass and light without rebuilding a shader."
      ]
    }
  ],
  Scene
};

export default caustic;
