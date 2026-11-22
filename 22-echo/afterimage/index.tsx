"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { active, clock, DUST_LIFE, LIFE, NEVER, SLOTS, slots, swell, voice } from "./blob";
import { Blob, Dust, Glow, lens, Motes, Shells } from "./render";
import { call, hold } from "./sound";

// A call repeats this many times, this far apart, each echo this much quieter to the ear and to the eye.
const REPEATS = 6;
const DELAY = 0.36;
const FALL_SOUND = 0.6;
const FALL_SEEN = 0.72;
// A press held this long becomes a sustained voice, which sheds a shell this often while it lasts.
const HOLD = 0.3;
const STREAM = 0.15;
// Presses within this distance of the middle speak to the blob; further out, a drag turns the view.
const REACH = 1.9;
// Notes of a minor pentatonic, from the low A up: each call picks one near the last, so a run of taps makes a phrase.
const SCALE = [146.83, 174.61, 196, 220, 261.63, 293.66, 349.23, 392];

type Pending = { at: number; shapeT: number; gain: number };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const state = useRef({
    now: 0,
    pending: [] as Pending[],
    held: false,
    heldAt: 0,
    sustained: false,
    nextStream: 0,
    stop: null as (() => void) | null,
    note: 3,
    pitch: 220,
    lastCall: NEVER,
    calls: 0,
    earned: false,
    glow: 0
  });

  useEffect(() => {
    const s = state.current;
    return () => s.stop?.();
  }, []);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __afterimage: state, __afterimageSlots: slots });

  // A shell leaves now, wearing the shape the blob had at shapeT.
  const emit = (shapeT: number, gain: number) => {
    const now = state.current.now;
    const list = slots.array as THREE.Vector4[];
    let pick = -1;
    let oldest = Infinity;
    for (let k = 0; k < SLOTS; k++) {
      const born = list[k].y;
      if (now - born > LIFE + DUST_LIFE + 0.1) {
        pick = k;
        break;
      }
      if (born < oldest) {
        oldest = born;
        pick = k;
      }
    }
    list[pick].set(shapeT, now, gain, Math.random() * 10);
    state.current.glow = Math.max(state.current.glow, gain);
  };

  // A call: the voice, then its echoes, each a shell of the shape the blob had as it spoke.
  const speak = (repeats: number) => {
    const s = state.current;
    s.note = THREE.MathUtils.clamp(s.note + Math.round((Math.random() - 0.5) * 4), 0, SCALE.length - 1);
    s.pitch = SCALE[s.note];
    call(s.pitch, repeats, DELAY, FALL_SOUND);
    for (let k = 0; k < repeats; k++) s.pending.push({ at: s.now + k * DELAY, shapeT: s.now, gain: Math.pow(FALL_SEEN, k) });
    s.lastCall = s.now;
    s.calls++;
  };

  useGrabbable({
    pick: (ray) => {
      const hit = new THREE.Vector3();
      const sphere = new THREE.Sphere(new THREE.Vector3(), REACH);
      return ray.intersectSphere(sphere, hit) ? { distance: ray.origin.distanceTo(hit), point: hit } : null;
    },
    grab: () => {
      const s = state.current;
      s.held = true;
      s.heldAt = s.now;
      s.sustained = false;
      dismissPrompt();
      speak(REPEATS);
    },
    drag: () => {},
    release: () => {
      const s = state.current;
      s.held = false;
      if (s.sustained) {
        s.stop?.();
        s.stop = null;
        s.sustained = false;
        // The held voice stops, and its echoes carry on after it.
        speak(4);
      }
    }
  });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state.current;
    s.now += dt;
    const now = s.now;
    clock.value = now;

    if (s.held && !s.sustained && now - s.heldAt > HOLD) {
      s.sustained = true;
      s.nextStream = now;
      s.stop = hold(s.pitch);
    }
    if (s.sustained && now >= s.nextStream) {
      s.nextStream = now + STREAM;
      s.pending.push({ at: now, shapeT: now, gain: 0.38 });
    }
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (now >= p.at) {
        emit(p.shapeT, p.gain);
        s.pending.splice(k, 1);
      }
    }

    const list = slots.array as THREE.Vector4[];
    let top = 0;
    for (let k = 0; k < SLOTS; k++) if (now - list[k].y < LIFE + DUST_LIFE) top = k + 1;
    active.top = top;

    // The blob lights from inside as it speaks, and swells a touch as each call leaves it.
    s.glow *= Math.exp(-dt * 3.2);
    voice.value = Math.max(s.glow, s.sustained ? 0.85 : 0);
    const since = now - s.lastCall;
    swell.value = since >= 0 ? 0.05 * Math.exp(-since * 6) * (1 - Math.exp(-since * 45)) + (s.sustained ? 0.02 : 0) : 0;

    lens.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    lens.focus.value = camera.position.length();

    if (!s.earned && s.calls >= 5) {
      s.earned = true;
      followPrompt.earn("afterimage");
      shareResult.set("Spoke to a blob in the dark and watched its echoes keep its old shapes");
    }
  });

  const low = startTier === "low";
  return (
    <>
      <Blob detail={low ? 36 : startTier === "medium" ? 64 : 90} />
      <Shells detail={low ? 20 : startTier === "medium" ? 30 : 40} />
      <Dust each={low ? 700 : startTier === "medium" ? 1300 : 2000} />
      <Motes count={low ? 600 : 1600} />
      <Glow />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.6, 0.5, 6.3],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 80, right: 80, up: 55, down: 55 }, move: 0.6 },
    phone: { position: [0.5, 0.45, 10.4], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 14, color: "#d8c3a8" },
  look: { background: "#030307", exposure: 1, bloom: 0.55, bloomThreshold: 0.75, gi: 0, ao: 0, vignette: 0.6, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  prompt: { title: "Tap the blob", detail: "Hold to sing; drag around it to turn", low: true },
  hint: "Tap the blob to call to it: it answers in echoes, ghost shells of its own shape that spread and fall to dust. Hold for a long note.",
  notes: "A churning blob in the dark whose every call leaves echoes: ghosts of the shape it had when it spoke, spreading and coming apart into dust.",
  overview: [
    { title: "Shape", points: ["The blob is a sphere pushed out by seven wandering soft lobes, a pure function of time, so an echo shell is the same mesh drawn at the moment it was spoken", "Normals come from the lobes' gradient, worked out exactly in the vertex shader"] },
    { title: "Echoes", points: ["32 shells in one instanced draw, each spreading, softening and dissolving through noise; their dust is placed wholly in the vertex shader from the same noise", "Each echo you see is one you hear: the voice repeats at the same delay, quieter and duller each time"] }
  ],
  Scene
};

export default day;
