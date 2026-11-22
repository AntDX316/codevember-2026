"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { lehmer } from "../../shared/engine/random";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Floor, floorHeight } from "./floor";
import { LINGER, PULSES, SPEED, echo } from "./pulses";
import { moan, ping } from "./voice";
import { Backdrop, Fronts, Shafts, Snow } from "./water";
import { Whale, swim, whaleState } from "./whale";

// A little variety in each call.
const jitter = lehmer(6203);

type Kind = "call" | "whale" | "echo";
type Pulse = { kind: Kind; at: THREE.Vector3; start: number; strength: number; colour: THREE.Color; bounces: THREE.Vector3[]; heardByWhale: boolean; heardHere: boolean };

const COLOURS: Record<Kind, THREE.Color> = {
  call: new THREE.Color(0.32, 0.82, 1.0),
  whale: new THREE.Color(1.0, 0.8, 0.55),
  echo: new THREE.Color(0.4, 0.85, 1.0)
};
// How far a front goes before its slot is free again.
const REACH = 260;

// Places on the reef wall and the far floor that throw a call back: the echoes the scene answers with.
function reflectors() {
  const points: THREE.Vector3[] = [];
  for (const z of [-10, -40, -70, -100]) {
    const x = 58 + z * 0.12 + Math.sin(z * 0.035) * 5 - 3;
    points.push(new THREE.Vector3(x, floorHeight(x, z) + 4, z));
  }
  for (const x of [-60, -20, 25]) points.push(new THREE.Vector3(x, floorHeight(x, -105) + 1, -105));
  return points;
}

const scratch = { ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), point: new THREE.Vector3() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const bounce = useMemo(reflectors, []);

  const state = useRef({
    clock: 0,
    slots: Array.from({ length: PULSES }, () => null) as (Pulse | null)[],
    liveAt: -1,
    lastTap: -100,
    lastWhale: -100,
    // A call the whale has heard, to answer a beat later.
    answerAt: -1,
    answers: 0,
    earned: false,
    down: { x: 0, y: 0, at: 0, moved: 0 }
  });

  const pan = (p: THREE.Vector3) => THREE.MathUtils.clamp(scratch.point.copy(p).project(camera).x * 0.8, -0.85, 0.85);

  const send = (kind: Kind, at: THREE.Vector3, strength: number) => {
    const s = state.current;
    // A free slot, or the one whose front has gone furthest.
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < PULSES; i++) {
      const p = s.slots[i];
      if (!p) {
        slot = i;
        break;
      }
      // Echoes give way first.
      const score = p.start - (p.kind === "echo" ? 100 : 0);
      if (score < oldest) {
        oldest = score;
        slot = i;
      }
    }
    // The two nearest places to throw it back, for a call or the whale's song; echoes do not echo again.
    const bounces = kind === "echo" ? [] : [...bounce].sort((a, b) => a.distanceTo(at) - b.distanceTo(at)).slice(0, 2);
    s.slots[slot] = { kind, at: at.clone(), start: s.clock, strength, colour: COLOURS[kind], bounces, heardByWhale: kind !== "call", heardHere: kind !== "echo" };
  };

  const whaleCall = () => {
    const s = state.current;
    s.lastWhale = s.clock;
    whaleState.effort = 1;
    send("whale", whaleState.head, 1.7);
    moan(0.34, pan(whaleState.head), jitter());
  };

  const call = (at: THREE.Vector3) => {
    const s = state.current;
    s.lastTap = s.clock;
    send("call", at, 1);
    // Higher the nearer the call, a little different each time.
    const d = camera.position.distanceTo(at);
    ping(0.3, THREE.MathUtils.clamp(1.15 - d / 150, 0.75, 1.15) * (0.97 + jitter() * 0.06), pan(at));
    dismissPrompt();
  };

  // A tap calls from where it lands on the floor, or out in the open water along it; a drag turns the view.
  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => {
      state.current.down = { x: e.clientX, y: e.clientY, at: performance.now(), moved: 0 };
    };
    const move = (e: PointerEvent) => {
      const d = state.current.down;
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y));
    };
    const up = (e: PointerEvent) => {
      const d = state.current.down;
      if (d.moved > 10 || performance.now() - d.at > 450) return;
      const rect = el.getBoundingClientRect();
      scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      const floor = scene.getObjectByName("floor");
      const hit = floor ? scratch.ray.intersectObject(floor, false)[0] : undefined;
      const at = hit && hit.distance < 160 ? hit.point.clone().addScaledVector(hit.face?.normal ?? new THREE.Vector3(0, 1, 0), 0.5) : scratch.ray.ray.at(38, new THREE.Vector3());
      call(at);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read the latest state through refs.
  }, [gl, camera, scene]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __whale: { state, call, whaleCall, camera, scene, whaleState, swim, THREE } });

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    s.clock += delta;
    echo.time.value = s.clock;
    echo.right.value.setFromMatrixColumn(camera.matrixWorld, 0);
    echo.up.value.setFromMatrixColumn(camera.matrixWorld, 1);

    // Once the scene is on show, the whale calls first, so the dark is seen to hold something; after that it answers
    // calls, and now and then, left alone, sings again.
    if (scenePhase.current === "live" && s.liveAt < 0) s.liveAt = s.clock;
    if (s.liveAt >= 0 && s.lastWhale === -100 && s.clock - s.liveAt > 1.4) whaleCall();
    if (s.answerAt > 0 && s.clock >= s.answerAt) {
      s.answerAt = -1;
      whaleCall();
      s.answers++;
      if (!s.earned && s.answers >= 2) {
        s.earned = true;
        followPrompt.earn("whale");
        shareResult.set("Called into the deep and a whale sang back");
      }
    }
    if (s.lastWhale > 0 && s.clock - s.lastWhale > 38 && s.clock - s.lastTap > 20) whaleCall();

    for (let i = 0; i < PULSES; i++) {
      const p = s.slots[i];
      const slot = echo.pulse.array[i] as THREE.Vector4;
      const tone = echo.tone.array[i] as THREE.Vector4;
      if (!p) {
        tone.w = 0;
        continue;
      }
      const radius = (s.clock - p.start) * SPEED;
      if (radius > REACH + SPEED * LINGER) {
        s.slots[i] = null;
        tone.w = 0;
        continue;
      }
      slot.set(p.at.x, p.at.y, p.at.z, p.start);
      tone.set(p.colour.r, p.colour.g, p.colour.b, p.strength);
      // The front reaching the wall throws an echo back.
      for (let k = p.bounces.length - 1; k >= 0; k--) {
        const b = p.bounces[k];
        if (radius >= b.distanceTo(p.at)) {
          p.bounces.splice(k, 1);
          send("echo", b, p.strength * 0.32);
        }
      }
      // A call reaching the whale: it answers a beat later, unless it has just sung.
      if (!p.heardByWhale && radius >= whaleState.head.distanceTo(p.at)) {
        p.heardByWhale = true;
        if (s.answerAt < 0 && s.clock - s.lastWhale > 4.5) s.answerAt = s.clock + 0.9;
      }
      // An echo is heard when its front comes back to the eye.
      if (!p.heardHere && radius >= camera.position.distanceTo(p.at)) {
        p.heardHere = true;
        ping(0.12 * Math.min(1, p.strength * 2.5), 0.92, pan(p.at), 1);
      }
    }
  });

  const low = startTier === "low";
  return (
    <>
      <Backdrop />
      <Floor cells={low ? 220 : startTier === "medium" ? 300 : 380} />
      <Whale detail={low ? 0.7 : 1} />
      <Fronts />
      <Shafts count={low ? 7 : 11} />
      <Snow count={low ? 3500 : startTier === "medium" ? 6000 : 9000} />
      <Snow near count={low ? 120 : 260} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0, -5, 8],
    target: [-2, -9, -50],
    fov: 50,
    limits: { turn: { left: 55, right: 55, up: 30, down: 22 }, move: { left: 4, right: 4, down: 3, up: 4, nearer: 10, further: 10 } },
    phone: { position: [-1, -4, 24], target: [-4, -7, -50], fov: 70 }
  },
  hover: true,
  extents: { centre: [0, -8, -20], radius: 70, floor: -19, color: "#020a12" },
  look: { background: "#000000", exposure: 1.0, bloom: 0.55, bloomThreshold: 0.35, gi: 0, ao: 0, haze: 0, vignette: 0.6, grain: 0.03 },
  passes: { bounce: false, haze: false, overlay: true, temporal: false, occlusion: false },
  maxDpr: 1.5,
  prompt: { title: "Tap to call into the dark", detail: "Listen for the answer", low: true },
  hint: "Tap anywhere to send a call out through the water; the whale answers, and the reef throws echoes back.",
  notes: "The deep ocean at night. A humpback drifts through the dark; every call rolls out as a slow wavefront and draws the world in light as it passes.",
  overview: [
    {
      title: "Sound as light",
      points: [
        "Each call is a sphere spreading at a slowed speed of sound; every surface it passes lights in contour and range lines that linger and fade.",
        "Up to eight fronts at once, shaded per pixel on the floor and whale, per vertex on the marine snow."
      ]
    },
    {
      title: "The deep",
      points: [
        "A 13 m humpback lofted from cross-sections: flat rostrum, throat grooves, knobbly flippers, flukes beating in a travelling wave.",
        "The reef wall and the far edge throw echoes back; you hear each when its front returns to you."
      ]
    }
  ],
  Scene
};

export default day;
