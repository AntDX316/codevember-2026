"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { useSetting, useSettingsStore } from "../shared/engine/settings";
import { sound, useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { Walk } from "../shared/engine/walk";
import Coins from "./coins";
import { game } from "./game";
import { Hedge, hedgesUp, VIEW } from "./hedge";
import { FOOTSTEPS, useAmbience } from "./sounds";
import { STYLES, type Style, useStyle } from "./styles";
import { Play } from "./play";
import { hedgeSolids, PERIOD } from "./walk";
import { STUDIES, type Study } from "./warp";
import { goTo } from "./view";
import type * as THREE from "three/webgpu";

// The sound of the world changing shape.
const SHIFT = "/assets/13-labyrinth/world-change.mp3";
// The bent worlds the maze moves between on its own, and how often.
const BENT: Study[] = ["ring", "fold", "twist"];
const BEND_EVERY = 13000;

function Scene() {
  useMusic("/codevember/music/the-ultimate-betrayal.mp3", 0.32);
  const walk = useSetting<boolean>("walk");
  const study = useSetting<Study>("study");
  // As soon as the hedges have all risen, the flat maze folds up into walls all round, unless another world has
  // been chosen already.
  const store = useSettingsStore();
  // For testing in development: put the eye somewhere from the console (in Fly).
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__view = (position: [number, number, number], target: [number, number, number]) => goTo(camera, { position, target });
  }, [camera]);
  const folded = useRef(false);
  // A sweep of sound with every change of world, and once at the start a second before the maze folds up.
  useEffect(() => sound.preload(SHIFT), []);
  const heard = useRef(study);
  const quietly = useRef(false);
  useEffect(() => {
    if (study === heard.current) return;
    heard.current = study;
    if (quietly.current) quietly.current = false;
    else sound.sample(SHIFT, 0.7);
  }, [study]);
  useFrame(() => {
    if (folded.current || hedgesUp.at === Infinity) return;
    folded.current = true;
    if (store.get("study") !== "flat") return;
    sound.sample(SHIFT, 0.7);
    window.setTimeout(() => {
      if (store.get("study") !== "flat") return;
      quietly.current = true;
      store.set("study", "fold");
    }, 1000);
  });
  // Then every thirteen seconds it bends into another of its shapes, ring, fold or twist, at random and never back to flat.
  // Any change, chosen or not, starts the thirteen seconds again, so a world picked by hand is held for a while too.
  const bentAt = useRef(0);
  useEffect(() => {
    bentAt.current = performance.now();
  }, [study]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (hedgesUp.at === Infinity || performance.now() - bentAt.current < BEND_EVERY) return;
      const now = store.get("study");
      const next = BENT.filter((s) => s !== now);
      store.set("study", next[Math.floor(Math.random() * next.length)]);
    }, 500);
    return () => window.clearInterval(timer);
  }, [store]);
  const style = useSetting<Style>("style");
  useAmbience(style);
  // Game mode: coins all about the maze to collect, and the count and its milestones over the scene.
  const playing = useSetting<boolean>("game");
  useEffect(() => game.setOn(playing), [playing]);
  // The game is played on foot: turning it on walks you down into the maze, and taking off to fly ends it.
  const was = useRef({ walk, playing });
  useEffect(() => {
    if (playing && !was.current.playing && !walk) store.set("walk", true);
    else if (!walk && was.current.walk && playing) store.set("game", false);
    was.current = { walk, playing };
  }, [walk, playing, store]);
  useEffect(() => () => game.setOn(false), []);
  return (
    <>
      <Hedge study={study} />
      <Walk on={walk} solids={hedgeSolids} steps={FOOTSTEPS[style]} fov={85} />
      <Styled />
      {/* Always there, hidden while not playing, so that starting a game builds nothing. */}
      <Coins playing={playing} />
    </>
  );
}

// After the hedge, so that its look goes on over the natural one.
function Styled() {
  useStyle(useSetting<Style>("style"));
  return null;
}

const labyrinth: DayDefinition = {
  camera: { position: VIEW.position, target: VIEW.target, fov: VIEW.fov ?? 40 },
  explore: true,
  // The maze repeats every period, so there is no edge to it: fly any way for as long as you like.
  extents: { centre: [0, 2, 0], radius: 60, floor: 0.6, endless: { period: PERIOD, ceiling: 60 } },
  // The low tier drops what grows on the hedges, so auto stops a step above it.
  autoFloor: "medium",
  // Every pixel carries leaves, gravel, mist and bounce light: drawn at one pixel per CSS pixel it holds 60 on a retina
  // screen, and the temporal filter keeps the edges clean.
  maxDpr: 1,
  passes: { bounce: true, halfBounce: true, haze: true, overlay: true, depthOfField: { range: 18, air: 0.5 } },
  // Black: the overlay pass clears to the background and is added over the frame, so any colour here would veil it.
  look: { background: "#000000", gi: 1, ao: 1, exposure: 1, bloom: 0.2, bloomThreshold: 0.85, vignette: 0.5, grain: 0.015 },
  settings: {
    // A visit starts on foot, playing, standing on top of a hedge.
    walk: { type: "toggle", label: "Walk", value: true, sides: ["Fly", "Walk"] },
    // The world bent around the eye: up into a ring overhead, folded up into walls all round, or twisted over like a
    // ribbon.
    study: { type: "choice", label: "World", value: "flat", options: STUDIES },
    // The same maze drawn in another manner: nothing in it moves any differently.
    style: { type: "choice", label: "Style", value: "natural", options: STYLES },
    game: { type: "toggle", label: "Game mode", value: true }
  },
  phonePills: ["walk", "study", "style", "game"],
  Overlay: Play,
  hint: "You start on top of a hedge: drag to look around, WASD to walk and collect the coins, Space to jump; on a phone, hold still to walk. Fly to see it from above.",
  notes: "A hedge maze without end that never stops rebuilding itself.",
  overview: [
    {
      title: "The maze",
      points: [
        "A perfect maze on a 40 by 40 torus tiles the ground; the camera wraps back one copy as it travels, so it never ends.",
        "It rewrites one loop at a time: removing a wall makes one loop, and restoring another wall on it keeps it perfect."
      ]
    },
    {
      title: "Hedges",
      points: [
        "Each wall is one instanced box with a TSL leaf material from noise; near hedges get cards of ivy, bramble and grass.",
        "Meshy rabbit cut from 30,524 to 300 triangles, colours baked in (4 kB); Meshy leaf cut to 24 triangles in six variants."
      ]
    },
    {
      title: "Bent worlds",
      points: [
        "Lighting, shadows and mist run on flat ground; only the last vertex step bends each point into ring, fold or twist.",
        "The bend changes at random every thirteen seconds, and motion vectors bend too so temporal anti-aliasing holds."
      ]
    },
    {
      title: "Light and play",
      points: [
        "Shadow maps, screen-space bounce light and occlusion, volumetric mist, depth of field and bloom.",
        "Walking collides with the hedges as they stand that frame; game mode lays coins on every path and hedge top."
      ]
    }
  ],
  Scene
};

export default labyrinth;
