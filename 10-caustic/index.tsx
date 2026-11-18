"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import { orbitPoint } from "../shared/engine/controls";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { useSetting } from "../shared/engine/settings";
import { useBed, useMusic } from "../shared/engine/sound";
import { StudioEnvironment } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { COLOURWAYS, Glass, type GlassKind } from "./glass";
import { CausticPass, Sun } from "./light";
import { Backdrop, Floor } from "./set";
import { Compass, lightBearing } from "./compass";

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

// The sun's height is the study's; where it stands around the table is the compass's, read each frame.
function Aim({ aim, elevation }: { aim: { current: { elevation: number; azimuth: number } }; elevation: number }) {
  useFrame(() => {
    aim.current.elevation = elevation;
    aim.current.azimuth = lightBearing.get();
  });
  return null;
}

// A warm satin table in a pool of low sun, falling away into the dark.
function Scene() {
  const study = useSetting<string>("study");
  const colourway = useSetting<string>("colourway");
  useMusic("/codevember/music/born-to-rise.mp3", 0.2);
  useBed("hum", 0.05);
  // One sun for every study, so that changing study never adds or takes away a light, which would rebuild every shader
  // that is lit by it.
  const aim = useMemo(() => ({ current: { elevation: 30, azimuth: lightBearing.get() } }), []);
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
      <Aim aim={aim} elevation={study === "orbs" ? 36 : 30} />
      <Sun elevation={aim.current.elevation} azimuth={aim.current.azimuth} follow={aim} colour="#ffd6a3" power={6} reach={2.4} pool={1.7} />
      {/* Every study is built while the page loads, Suzanne too, and kept: the one chosen shows, and the rest wait out of
          sight, doing nothing, so changing study is only a change of which one shows. */}
      {STUDIES.map(({ value }) => (
        <Glass key={value} kind={value as GlassKind} colourway={colourway} active={value === study} />
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
  Overlay: () => <Compass />,
  notes: "Coloured glass on a table in low sun, its light bent and gathered into bright colours on the wood.",
  overview: [
    {
      title: "Rendering",
      points: [
        "R3F and three.js r187 on WebGPU, every surface a TSL node material; the glass is transmission with dispersion and thickness absorption.",
        "Every study is built out of sight during first load and kept, so choosing one only changes which is shown."
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
