"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useSetting } from "../../shared/engine/settings";
import { useDispose } from "../../shared/engine/dispose";
import { useQuality } from "../../shared/engine/quality";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import { Backdrop, focus, type Variant } from "../kit";
import { PALETTES, applyPalette, createLook, pearlMaterial } from "./material";
import { PEARL } from "./shape";
import { Motes } from "./motes";
import { Shells } from "./shells";

// A dark studio, so the thin bright colours of the film read: near black, a breath warmer overhead.
const TOP = "#1c1a1c";
const HORIZON = "#0d0c0e";
const BOTTOM = "#050506";
// The key comes from high on the left; everything else falls away into shadow.
const KEY: [number, number, number] = [-4.2, 3.6, 2.6];
const MOTES = { low: 320, medium: 600, high: 1000 };

// Soft boxes for the nacre to reflect, all to one side: a big warm one beside the key, a cooler strip rim from behind on
// the other side, a faint wash overhead. The rest of the room is dark, which is what lets the lustre show.
const BOXES = [
  { position: [-5.5, 3.2, 3.2] as [number, number, number], scale: [0.2, 4.5, 4] as [number, number, number], color: "#fff1e4", intensity: 3.4 },
  { position: [5.5, 1.5, -4.5] as [number, number, number], scale: [0.2, 5, 1.2] as [number, number, number], color: "#dce6ff", intensity: 2.2 },
  { position: [0, 7, 0] as [number, number, number], scale: [5, 0.2, 5] as [number, number, number], color: "#ffe8ee", intensity: 0.7 },
  { position: [2, -1, 7] as [number, number, number], scale: [3, 1.5, 0.2] as [number, number, number], color: "#f0e6ff", intensity: 0.25 }
];

function Scene() {
  const palette = useSetting<string>("nacrePalette");
  const strength = useSetting<number>("nacreIridescence");
  const { tier } = useQuality();

  const look = useMemo(createLook, []);
  useEffect(() => applyPalette(look, PALETTES[palette] ?? PALETTES.abalone), [look, palette]);
  useEffect(() => {
    look.strength.value = strength;
  }, [look, strength]);

  const pearl = useMemo(() => pearlMaterial(look), [look]);
  // The pearl's own light, for the shells' insides and the pieces drifting round it once it is bare. Always there, only
  // dimmed, so the shaders never rebuild for a light coming and going.
  const light = useMemo(() => new THREE.PointLight("#fff4ea", 0, 3, 2), []);
  useDispose(pearl, light);

  useFrame(() => {
    focus.point.set(0, 0, 0.4);
    focus.blur = 0.8;
    light.color.setRGB(look.glow.value.x, look.glow.value.y, look.glow.value.z);
  });

  return (
    <>
      <Backdrop top={TOP} horizon={HORIZON} bottom={BOTTOM} />
      <StudioEnvironment ambient="#060607" intensity={1} boxes={BOXES} />
      <KeyLight position={KEY} target={[0, 0, 0]} color="#fff2e6" intensity={220} angle={0.42} penumbra={0.9} />
      <mesh material={pearl} castShadow receiveShadow>
        <sphereGeometry args={[PEARL, 64, 48]} />
      </mesh>
      <primitive object={light} />
      <Shells look={look} light={light} />
      <Motes count={MOTES[tier] ?? MOTES.high} light={KEY} />
    </>
  );
}

const nacre: Variant = {
  Scene,
  settings: {
    nacrePalette: {
      type: "choice",
      label: "Nacre",
      value: "abalone",
      options: Object.entries(PALETTES).map(([value, p]) => ({ value, label: p.label, swatch: p.swatch }))
    },
    nacreIridescence: { type: "range", label: "Iridescence", min: 0, max: 1, step: 0.01, value: 0.85, reset: 0.85 },
    nacreSound: {
      type: "choice",
      label: "Peel sound",
      value: "porcelain",
      options: [
        { value: "porcelain", label: "Porcelain" },
        { value: "silk", label: "Silk" }
      ]
    },
    nacreRegrow: { type: "action", label: "Regrow" }
  },
  view: { position: [0.9, 0.5, 5.7], target: [0, -0.1, 0], fov: 36 },
  look: { background: HORIZON, exposure: 1.05, bloom: 0.28, bloomThreshold: 0.95, ao: 0.6, aoRadius: 0.2, vignette: 0.42, grain: 0.014 },
  hint: "Swipe across the shell to tear it open, and keep going, layer after layer, down to the pearl.",
  notes:
    "Seven nested shells of mother-of-pearl around a pearl. Swipe across one and it tears along your stroke into petals that curl back and drift down; under it waits the next, a slightly different colour, until the pearl shines out. Then the shells grow back over it.",
  overview: [
    {
      title: "Nacre",
      points: [
        "Every shell is a physical node material with a thin film on it, its thickness wandering with fine growth lines and slow noise, so each layer throws its own colours.",
        "The shells are laid like real nacre, in bricks: rows round the cocoon, each row's joints offset and its seams gently wavy."
      ]
    },
    {
      title: "Peeling",
      points: [
        "Each brick is a thin box laid exactly on its patch of the shell in the vertex shader, then rolled up from the torn edge over a cylinder, with its normals turned to match.",
        "A swipe tears the bricks it passes, each rolling back from the tear on a spring; once enough of a shell is open the rest falls open from there like petals."
      ]
    },
    {
      title: "Drifting and regrowing",
      points: [
        "Free pieces drift like petals, held back by the air, slide off the cocoon and fade as they sink below it.",
        "Once the pearl is bare its light wells up, and after a while every shell grows back, innermost first, each laid down from the bottom up."
      ]
    },
    {
      title: "Optimisations",
      points: [
        "Every brick of every shell is one instanced draw; only the shell on top, the one under it and pieces still in the air are drawn.",
        "Per-brick fold, roll, place and turn go up in four small instance buffers each frame; nothing is rebuilt as shells come and go."
      ]
    }
  ]
};

export default nacre;
